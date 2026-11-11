import type * as Protocol from '../../relay/protocol.ts'
import { run } from './claude.ts'
import { devicesOf, inviteMachine, type Device } from './device.ts'
import { forgetMachine, hcPath, machinesReached, reachMachine, runOn, type Reached } from './hc.ts'
import type { Relay } from './relay.ts'
import { sharedOf, updateShared } from './shared.ts'

const JOIN_MS = 300_000
const RETRY_MS = 3_600_000
const DEVICE_LINE = 'anyhost-device '

export type Candidate = { readonly target: string; readonly os: string; readonly online: boolean }

const tailscale = (): string | undefined => Bun.which('tailscale', { PATH: `${process.env['PATH'] ?? ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin` }) ?? undefined

export async function candidatesOf(): Promise<Candidate[]> {
  const program = tailscale()
  if (program === undefined) return []
  const status = JSON.parse(await run([program, 'status', '--json']).catch(() => '{}')) as { Peer?: Record<string, { DNSName: string; OS: string; Online: boolean }> }
  return Object.values(status.Peer ?? {})
    .filter(({ OS, DNSName }) => (OS === 'linux' || OS === 'macOS') && DNSName !== '')
    .map(({ DNSName, OS, Online }) => ({ target: nameOf(DNSName), os: OS, online: Online }))
}

const nameOf = (dnsName: string): string => dnsName.split('.')[0] ?? dnsName

export async function addMachine(relay: Relay, target: string): Promise<Protocol.Device> {
  const reached = await reachMachine(target)
  const { link, command } = await inviteMachine(relay)
  const printed = await runOn(
    reached,
    [
      'set -e',
      'export GIT_CONFIG_GLOBAL=/dev/null',
      'command -v cmod >/dev/null 2>&1 || npm install -g @cmodjs/cli >&2',
      `if cmod list 2>/dev/null | grep -q '^anyhost@'; then cmod update anyhost >&2; cmod option anyhost join '${link}' >&2; else ${command} >&2; (cd && claude -p --model haiku 'Reply with the single word ok.' >&2) || true; fi`,
      `printf '${DEVICE_LINE}%s\\n' "$(cmod device --json)"`,
    ].join('\n'),
  )
  const { id } = JSON.parse(new RegExp(`${DEVICE_LINE}(\\{.*\\})`).exec(printed)?.[1] ?? '{}') as { id?: string }
  if (id === undefined) throw new Error(`anyhost installed on ${target} but cmod there named no machine: ${printed.trim()}`)
  await updateShared(relay, (shared) => ({ ...shared, reach: { ...shared.reach, [id]: target } }))
  const deadline = Date.now() + JOIN_MS
  for (;;) {
    const device = (await devicesOf(relay)).get(id)
    if (device?.connected === true) return device
    if (Date.now() > deadline) throw new Error(`anyhost is installed on ${target}, and it has not joined your relay within ${JOIN_MS / 60_000} minutes. anyhost doctor on ${target} says why.`)
    await Bun.sleep(2000)
  }
}

export const reachedAt = (reached: readonly Reached[], target: string | undefined): Reached | undefined => (target === undefined ? undefined : reached.find((machine) => machine.target === target))

const failedAt = new Map<string, number>()
export async function keepHerdrReaching(relay: Relay, here: Device): Promise<void> {
  if (hcPath() === undefined) return
  const [devices, shared, reached] = await Promise.all([devicesOf(relay), sharedOf(relay), machinesReached()])
  if (shared.reach[here.id] === undefined) {
    const self = await selfTarget()
    if (self !== undefined) await updateShared(relay, (latest) => ({ ...latest, reach: { [here.id]: self, ...latest.reach } }))
  }
  for (const device of devices.values()) {
    const target = shared.reach[device.id]
    if (device.id === here.id || target === undefined) continue
    const known = reachedAt(reached, target)
    if (device.removedAt !== undefined) {
      if (known !== undefined) await forgetMachine(known.name)
      continue
    }
    if (known !== undefined || Date.now() - (failedAt.get(target) ?? 0) < RETRY_MS) continue
    await reachMachine(target).catch((error: unknown) => {
      failedAt.set(target, Date.now())
      console.error(`${new Date().toISOString()} herdr-core here could not reach ${device.name} at ${target}, and tries again in an hour: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

async function selfTarget(): Promise<string | undefined> {
  const program = tailscale()
  if (program === undefined) return undefined
  const status = JSON.parse(await run([program, 'status', '--json']).catch(() => '{}')) as { Self?: { DNSName?: string } }
  const dnsName = status.Self?.DNSName
  return dnsName === undefined || dnsName === '' ? undefined : `${process.env['USER'] ?? (await run(['id', '-un'])).trim()}@${nameOf(dnsName)}`
}
