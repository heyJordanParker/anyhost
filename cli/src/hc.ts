import { homedir } from 'node:os'
import { join } from 'node:path'
import { run } from './claude.ts'
import { rootsHere } from './device.ts'

export const SESSION_LABEL = 'anyhost.session'
export const SLEEP_LABEL = 'anyhost.sleep'
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

const hex12 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 12)

const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
const isUnder = (path: string, root: string): boolean => root !== '' && (path === root || path.startsWith(`${root}/`))

const isTemporary = (cwd: string, roots: { readonly home: string; readonly claudeTmp: string }): boolean => !isUnder(cwd, roots.home) && [...TEMP_ROOTS, roots.claudeTmp].some((root) => isUnder(cwd, root))

export const spaceOf = (cwd: string, checkout: string): string => (isTemporary(cwd, rootsHere()) ? 'anyhost-temporary' : checkout === '' ? 'anyhost-none' : `anyhost-w-${hex12(checkout)}`)

export async function openTerminal(cwd: string, session: string, argv: readonly string[], checkout: string): Promise<string> {
  const placed = { [SPACE_LABEL]: spaceOf(cwd, checkout), 'herdr.tab': session.slice(0, 8), [SESSION_LABEL]: session }
  const labels = Object.entries(placed).flatMap(([key, value]) => ['--label', `${key}=${value}`])
  const { address } = JSON.parse(await run(inScope([hcHere(), 'run', '--bg', '--json', '--no-parent', '--cwd', cwd, ...labels, '--', ...argv]), { cwd })) as { readonly address: string }
  return address
}

export async function terminalAt(address: string): Promise<{ readonly isLive: boolean; readonly cwd: string; readonly labels: Readonly<Record<string, string>> } | undefined> {
  const found = await run([hcHere(), 'get', address, '--json']).catch((error: unknown) => {
    if (error instanceof Error && error.message.includes('"kind":"not_found"')) return undefined
    throw error
  })
  if (found === undefined) return undefined
  const { state, cwd, labels } = JSON.parse(found) as { readonly state: string; readonly cwd: string; readonly labels: Record<string, string> }
  return { isLive: state === 'live', cwd, labels }
}

export async function labelledTerminals(session: string): Promise<string[]> {
  const { terminals } = JSON.parse(await run([hcHere(), 'ls', '--json', '--label', `${SESSION_LABEL}=${session}`])) as { readonly terminals: readonly { readonly address: string }[] }
  return terminals.map(({ address }) => address)
}

export const coreEnvironment = (): Promise<string> => run([hcHere(), 'exec', 'env', '-0'])

export const label = async (address: string, key: string, value: string): Promise<void> => void (await run([hcHere(), 'label', address, `${key}=${value}`]))

export async function killTerminal(address: string): Promise<void> {
  await label(address, SESSION_LABEL, '')
  await run([hcHere(), 'kill', address])
}

export const SHOWN_LABEL = 'anyhost.shown.'
export const SHOWN_MS = 90_000

export const isShown = (labels: Readonly<Record<string, string>>, now = Date.now()): boolean =>
  Object.entries(labels).some(([key, value]) => key.startsWith(SHOWN_LABEL) && now - Number(value) < SHOWN_MS)

const FOLLOW_FIRST_MS = 1000
const FOLLOW_MOST_MS = 30_000

export type Terminal = {
  readonly address: string
  readonly argv: readonly string[]
  readonly state: string
  readonly pid: number | null
  readonly labels: Readonly<Record<string, string>>
  readonly foreground: { readonly argv: readonly string[]; readonly pid: number } | null
  readonly reason: string | null
}
export type TerminalChange = { readonly type: string; readonly address: string }

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'nu', 'dash', 'ksh', 'mksh', 'tcsh', 'csh', 'elvish', 'xonsh', 'pwsh'])

export const isKeptShell = (terminal: Terminal): boolean =>
  terminal.state === 'live' &&
  !terminal.argv.includes('-c') &&
  SHELLS.has((terminal.argv[0] ?? '').split('/').at(-1)?.replace(/^-/, '') ?? '') &&
  terminal.foreground?.pid === terminal.pid &&
  terminal.foreground.argv.join('\0') === terminal.argv.join('\0')

const terminalOf = (data: Record<string, unknown>): Terminal => ({
  address: String(data['address']),
  argv: (data['argv'] as string[] | undefined) ?? [],
  state: String(data['state'] ?? 'live'),
  pid: (data['pid'] as number | null | undefined) ?? null,
  labels: (data['labels'] as Record<string, string> | undefined) ?? {},
  foreground: (data['foreground'] as Terminal['foreground'] | undefined) ?? null,
  reason: (data['reason'] as string | null | undefined) ?? null,
})

function changed(terminals: Map<string, Terminal>, type: string, address: string, data: Record<string, unknown>): void {
  const before = terminals.get(address)
  if (type === 'created' || type === 'restarted') return void terminals.set(address, { ...terminalOf(data), foreground: null })
  if (type === 'removed') return void terminals.delete(address)
  if (before === undefined) return
  if (type === 'foreground') terminals.set(address, { ...before, foreground: { argv: (data['argv'] as string[] | undefined) ?? [], pid: Number(data['pid']) } })
  if (type === 'labels') terminals.set(address, { ...before, labels: (data['labels'] as Record<string, string> | undefined) ?? {} })
  if (type === 'lost') terminals.set(address, { ...before, foreground: null })
  if (type === 'finished') terminals.set(address, { ...before, state: 'finished', foreground: null, reason: (data['reason'] as string | null | undefined) ?? null })
}

type EventLine = {
  readonly terminals?: readonly Record<string, unknown>[]
  readonly method?: string
  readonly params?: { readonly type?: string; readonly terminal?: string; readonly data?: Record<string, unknown>; readonly terminals?: readonly Record<string, unknown>[] }
}

export function followTerminals(heard: (terminals: ReadonlyMap<string, Terminal>, change?: TerminalChange) => void): () => void {
  let isStopped = false
  let events: ReturnType<typeof Bun.spawn> | undefined
  const terminals = new Map<string, Terminal>()
  const heardLine = (line: string): void => {
    try {
      const read = JSON.parse(line) as EventLine
      const snapshot = read.terminals ?? read.params?.terminals
      if (snapshot !== undefined) {
        terminals.clear()
        for (const terminal of snapshot) terminals.set(String(terminal['address']), terminalOf(terminal))
        return heard(terminals)
      }
      if (read.method !== 'event' || read.params?.type === undefined || read.params.terminal === undefined) return
      changed(terminals, read.params.type, read.params.terminal, read.params.data ?? {})
      heard(terminals, { type: read.params.type, address: read.params.terminal })
    } catch (error) {
      console.error(`${new Date().toISOString()} anyhost could not follow herdr-core's line ${line.slice(0, 200)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  void (async () => {
    const decoder = new TextDecoder()
    for (let wait = FOLLOW_FIRST_MS; !isStopped; wait = Math.min(wait * 2, FOLLOW_MOST_MS)) {
      const hc = hcPath()
      if (hc !== undefined) {
        const following = Bun.spawn([hc, 'events', '--json'], { env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
        events = following
        let left = ''
        for await (const chunk of following.stdout) {
          wait = FOLLOW_FIRST_MS
          const lines = (left + decoder.decode(chunk, { stream: true })).split('\n')
          left = lines.pop() ?? ''
          for (const line of lines) if (line.trim() !== '') heardLine(line)
        }
      }
      if (isStopped) return
      await Bun.sleep(wait)
    }
  })()
  return () => {
    isStopped = true
    events?.kill()
  }
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

export const askToSleep = async (address: string): Promise<void> => await label(address, SLEEP_LABEL, String(Date.now()))

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
