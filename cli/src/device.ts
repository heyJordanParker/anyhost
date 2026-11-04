import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Roots } from './relocate.ts'
import type { Store } from './store.ts'

export type Device = { readonly id: string; readonly name: string; readonly os: string; readonly arch: string }
export type MachineRoots = Omit<Roots, 'checkout'>
// A record anyhost 0.1 wrote has no `claudeHome`: its Claude Code folder is `<home>/.claude`.
export type DeviceRecord = Omit<MachineRoots, 'claudeHome'> & { readonly claudeHome?: string; readonly name: string; readonly os: string; readonly arch: string; readonly ssh: string }

export const stateFolder = (): string => join(process.env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state'), 'anyhost')
const cmodProgram = (): string => join(process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), 'cmod', 'programs', 'cmod')

// Claude Code keeps its folder at `CLAUDE_CONFIG_DIR`, else `~/.claude`, and background output under `/tmp/claude-<uid>`,
// which macOS resolves to `/private/tmp`.
export const rootsHere = (home = homedir()): MachineRoots => ({
  home,
  claudeHome: resolve(process.env['CLAUDE_CONFIG_DIR'] || join(home, '.claude')),
  claudeTmp: join(realpathSync(process.env['CLAUDE_CODE_TMPDIR'] || '/tmp'), `claude-${process.getuid?.() ?? 0}`),
  codexHome: process.env['CODEX_HOME'] || join(home, '.codex'),
})

export function deviceFromEnvironment(): Device {
  const { ANYHOST_DEVICE_ID: id, ANYHOST_DEVICE_NAME: name, ANYHOST_DEVICE_OS: os, ANYHOST_DEVICE_ARCH: arch } = process.env
  if (!id || !name || !os || !arch) throw new Error('anyhost serve runs from the anyhost mod, which passes this machine as ANYHOST_DEVICE_ID, ANYHOST_DEVICE_NAME, ANYHOST_DEVICE_OS and ANYHOST_DEVICE_ARCH.')
  return { id, name, os, arch }
}

async function cmod(...args: string[]): Promise<string> {
  const program = (await Bun.file(cmodProgram()).exists()) ? cmodProgram() : Bun.which('cmod')
  if (program === null) throw new Error(`anyhost runs cmod ${args[0]}, and neither ${cmodProgram()} nor a cmod on PATH exists. Install cmod with npm install -g @cmodjs/cli.`)
  const child = Bun.spawn([program, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(error.trim() || `cmod ${args[0]} exited with ${code}.`)
  return output
}

export const cmodDevice = async (): Promise<Device> => JSON.parse(await cmod('device', '--json')) as Device

// The values the person set in /config. An option they never set is absent, and its default applies.
type PersonOptions = { readonly uploadEvery?: number; readonly checkouts?: string; readonly bucket?: string }
export const personOptions = async (): Promise<PersonOptions> => (JSON.parse(await cmod('options', 'anyhost', '--json')) as { person: PersonOptions }).person

export const QUIET_BEFORE_RENAME_MS = 10 * 60_000

export type Registration =
  | { readonly state: 'registered' }
  | { readonly state: 'waiting'; readonly seenAt: number; readonly message: string }
  | { readonly state: 'cloned'; readonly message: string }

export function cloneFixFor(os: string): string {
  return os === 'darwin'
    ? 'Give this virtual Mac its own hardware UUID in its virtualization app, then restart it.'
    : 'Give it its own machine id with sudo rm /etc/machine-id && sudo systemd-machine-id-setup, then restart it.'
}

const isoOf = (ms: number): string => new Date(ms).toISOString()

export async function register(store: Store, device: Device, roots: MachineRoots, now = Date.now(), earlier?: Registration): Promise<Registration> {
  const key = `devices/${device.id}.json`
  const record = JSON.stringify({ name: device.name, os: device.os, arch: device.arch, ssh: device.name, ...roots } satisfies DeviceRecord)
  if ((await store.put(key, record, { ifNoneMatch: '*' })) !== undefined) return { state: 'registered' }
  const taken = await store.get(key)
  if (taken === undefined) throw new Error(`R2 refused ${key} as taken, then answered that it does not exist.`)
  const owner = (JSON.parse(new TextDecoder().decode(taken.body)) as DeviceRecord).name
  if (owner !== device.name && now - taken.modifiedAt < QUIET_BEFORE_RENAME_MS) {
    if (earlier?.state === 'cloned' || (earlier?.state === 'waiting' && taken.modifiedAt > earlier.seenAt)) {
      return {
        state: 'cloned',
        message: `This machine, ${device.name}, has the id of ${owner}, which still runs anyhost and wrote at ${isoOf(taken.modifiedAt)}, as a machine cloned from it does, so anyhost captures nothing here. ${cloneFixFor(device.os)}`,
      }
    }
    return {
      state: 'waiting',
      seenAt: earlier?.state === 'waiting' ? earlier.seenAt : taken.modifiedAt,
      message: `${device.name} has the id registered as ${owner}, which ran anyhost at ${isoOf(taken.modifiedAt)}. A renamed machine's old name goes quiet, so anyhost takes the name ${device.name} at ${isoOf(taken.modifiedAt + QUIET_BEFORE_RENAME_MS)} by itself, and captures nothing until then.`,
    }
  }
  if ((await store.put(key, record, { ifMatch: taken.etag })) === undefined) throw new Error(`${key} changed while ${device.name} registered. anyhost registers it again on its next pass.`)
  return { state: 'registered' }
}

export async function devicesOf(store: Store): Promise<Map<string, DeviceRecord>> {
  const listed = await store.list('devices/')
  const records = await Promise.all(
    listed.map(async ({ key }) => {
      const stored = await store.get(key)
      return [key.slice('devices/'.length, -'.json'.length), stored === undefined ? undefined : (JSON.parse(new TextDecoder().decode(stored.body)) as DeviceRecord)] as const
    }),
  )
  return new Map(records.flatMap(([id, record]) => (record === undefined ? [] : [[id, record] as const])))
}
