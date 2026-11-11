import { homedir } from 'node:os'
import { join } from 'node:path'
import { loginShell, run } from './claude.ts'

export const SESSION_LABEL = 'anyhost.session'
const SPACE_LABEL = 'herdr.space'
const SESSIONS_SLICE = 'anyhost-sessions.slice'

export const hcPath = (): string | undefined => Bun.which('hc', { PATH: `${process.env['PATH'] ?? ''}:${join(homedir(), '.local', 'bin')}` }) ?? undefined

const hcHere = (): string => {
  const hc = hcPath()
  if (hc === undefined) throw new Error('herdr-core is not installed here, so anyhost has no terminal to run the session in. Install the Herdr app, or herdr-core with curl -fsSL https://releases.herdr.dev/core/install.sh | sh')
  return hc
}

const inScope = (command: readonly string[]): string[] =>
  Bun.which('systemd-run') === null || !process.env['XDG_RUNTIME_DIR'] ? [...command] :['systemd-run', '--user', '--scope', '--quiet', '--collect', '--slice', SESSIONS_SLICE, '--unit', `anyhost-hc-${crypto.randomUUID().slice(0, 8)}.scope`, ...command]

const self = (): string[] => (import.meta.dir.startsWith('/$bunfs/') ? [process.execPath] : [process.execPath, join(import.meta.dir, 'main.ts')])

async function spaceOf(cwd: string): Promise<string> {
  const { terminals } = JSON.parse(await run([hcHere(), 'ls', '--json'])) as { readonly terminals: readonly { readonly address: string; readonly cwd: string }[] }
  for (const { address } of terminals.filter((terminal) => terminal.cwd === cwd)) {
    const space = (await terminalAt(address))?.labels[SPACE_LABEL]
    if (space !== undefined && space !== '') return space
  }
  return `anyhost-${new Bun.CryptoHasher('sha256').update(cwd).digest('hex').slice(0, 12)}`
}

const UNATTENDED = ['env', 'DISABLE_AUTO_UPDATE=true']

export async function openTerminal(cwd: string, session: string, command: readonly string[], options: { readonly isResumed: boolean; readonly isResting?: boolean; readonly place?: Readonly<Record<string, string>> }): Promise<void> {
  const runner = [...self(), 'run', ...(options.isResumed ? ['--session', session] : []), ...(options.isResting === true ? ['--rest'] : []), '--', ...command]
  const placed = { [SPACE_LABEL]: options.place?.[SPACE_LABEL] ?? (await spaceOf(cwd)), 'herdr.tab': session.slice(0, 8), ...options.place, [SESSION_LABEL]: session }
  const labels = Object.entries(placed).flatMap(([key, value]) => ['--label', `${key}=${value}`])
  await run(inScope([hcHere(), 'run', '--bg', '--keep', '--no-parent', '--cwd', cwd, ...labels, '--', ...UNATTENDED, await loginShell(), '-i', '-l', '-c', 'exec "$0" "$@"', ...runner]), { cwd })
}

export async function terminalAt(address: string): Promise<{ readonly isLive: boolean; readonly cwd: string; readonly labels: Readonly<Record<string, string>> } | undefined> {
  const found = await run([hcHere(), 'get', address, '--json']).catch(() => undefined)
  if (found === undefined) return undefined
  const { state, cwd, labels } = JSON.parse(found) as { readonly state: string; readonly cwd: string; readonly labels: Record<string, string> }
  return { isLive: state === 'live', cwd, labels }
}

export async function labelledTerminals(session: string): Promise<string[]> {
  const { terminals } = JSON.parse(await run([hcHere(), 'ls', '--json', '--label', `${SESSION_LABEL}=${session}`])) as { readonly terminals: readonly { readonly address: string }[] }
  return terminals.map(({ address }) => address)
}

export const killTerminal = async (address: string): Promise<void> => void (await run([hcHere(), 'kill', address]))

export const SHOWN_LABEL = 'anyhost.shown.'
const SHOWN_MS = 90_000

export const isShown = (labels: Readonly<Record<string, string>>, now = Date.now()): boolean =>
  Object.entries(labels).some(([key, value]) => key.startsWith(SHOWN_LABEL) && now - Number(value) < SHOWN_MS)

export function followLabels(address: string, changed: () => void): () => void {
  const events = Bun.spawn([hcHere(), 'events', '--terminal', address, '--json'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of events.stdout) if (decoder.decode(chunk).includes('"labels"')) changed()
  })()
  return () => events.kill()
}

const STILL_STARTING = 'is still starting: its output has not settled'
const SETTLE_MS = 60_000

export async function sendTo(address: string, text: string): Promise<void> {
  for (const started = Date.now(); ; await Bun.sleep(100)) {
    try {
      return void (await run([hcHere(), 'send', address, text]))
    } catch (error) {
      if (!String(error).includes(STILL_STARTING) || Date.now() - started > SETTLE_MS) throw error
    }
  }
}

export const pressKeys = async (address: string, keys: readonly string[]): Promise<void> => void (await run([hcHere(), 'keys', address, ...keys]))

export const readTerminal = async (address: string, lines: number): Promise<string> =>
  (await run([hcHere(), 'read', address, ...(lines > 0 ? ['--lines', String(lines)] : [])])).split('\n').filter((line) => line.trim() !== '').join('\n')

export type Reached = { readonly name: string; readonly target: string; readonly connected: boolean }

export async function machinesReached(): Promise<Reached[]> {
  const { machines } = JSON.parse(await run([hcHere(), 'machine', 'ls', '--json'])) as { readonly machines: readonly { readonly name: string; readonly target: string; readonly temporary: boolean; readonly state: string }[] }
  return machines.filter((machine) => !machine.temporary).map(({ name, target, state }) => ({ name, target, connected: state === 'connected' }))
}

export async function reachMachine(target: string): Promise<string> {
  const known = (await machinesReached()).find((machine) => machine.target === target)
  if (known !== undefined) return known.name
  const added = JSON.parse(await run([hcHere(), 'machine', 'add', target, '--install', '--json'])) as { readonly name: string }
  return added.name
}

export const forgetMachine = async (name: string): Promise<void> => void (await run([hcHere(), 'machine', 'rm', name]))

export const runOn = async (machine: string, script: string): Promise<string> =>
  await run([hcHere(), 'exec', '--on', machine, '--timeout', '600', 'sh', '-c', 'exec "${SHELL:-sh}" -i -l -c "$0"', script])

export async function labelOwnTerminal(session: string): Promise<void> {
  const address = process.env['HC_TERMINAL_ID']
  if (address === undefined || address === '') return
  await run([hcHere(), 'label', address, `${SESSION_LABEL}=${session}`])
}
