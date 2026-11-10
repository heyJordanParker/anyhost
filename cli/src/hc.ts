import { homedir } from 'node:os'
import { join } from 'node:path'
import { loginShell, run } from './claude.ts'

export const SESSION_LABEL = 'anyhost.session'
const SPACE_LABEL = 'herdr.space'
// systemd stops every process of the service's cgroup as the service restarts, and herdr-core's server starts as a
// child of the first `hc` that finds none, so on Linux each `hc run` runs in a scope of its own inside this slice,
// wherever the user's systemd listens, as it does for each of its services in `XDG_RUNTIME_DIR`.
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

// The Herdr app's space that works in `cwd`, as a terminal there carries its label, so a session opens beside its
// project's other tabs, else a space of that folder's own, which the Herdr app makes and names after the folder.
async function spaceOf(cwd: string): Promise<string> {
  const { terminals } = JSON.parse(await run([hcHere(), 'ls', '--json'])) as { readonly terminals: readonly { readonly address: string; readonly cwd: string }[] }
  for (const { address } of terminals.filter((terminal) => terminal.cwd === cwd)) {
    const space = (await terminalAt(address))?.labels[SPACE_LABEL]
    if (space !== undefined && space !== '') return space
  }
  return `anyhost-${new Bun.CryptoHasher('sha256').update(cwd).digest('hex').slice(0, 12)}`
}

// Opens the session's runner in a terminal of herdr-core, which the Herdr app shows in the space and tab its labels name:
// the space of its folder and a tab of the session, unless `place` names the labels of the terminal it replaces. A
// resting runner starts Claude Code only once the terminal is opened or typed into.
export async function openTerminal(cwd: string, session: string, command: readonly string[], options: { readonly isResumed: boolean; readonly isResting?: boolean; readonly place?: Readonly<Record<string, string>> }): Promise<void> {
  const runner = [...self(), 'run', ...(options.isResumed ? ['--session', session] : []), ...(options.isResting === true ? ['--rest'] : []), '--', ...command]
  const placed = { [SPACE_LABEL]: options.place?.[SPACE_LABEL] ?? (await spaceOf(cwd)), 'herdr.tab': session.slice(0, 8), ...options.place, [SESSION_LABEL]: session }
  const labels = Object.entries(placed).flatMap(([key, value]) => ['--label', `${key}=${value}`])
  // kept, so a restart of the machine leaves a shell in its place that reopenStopped gives the session back
  await run(inScope([hcHere(), 'run', '--bg', '--keep', '--no-parent', '--cwd', cwd, ...labels, '--', await loginShell(), '-i', '-l', '-c', 'exec "$0" "$@"', ...runner]), { cwd })
}

// A terminal of herdr-core here: whether it still runs a program and the labels that place it.
export async function terminalAt(address: string): Promise<{ readonly isLive: boolean; readonly cwd: string; readonly labels: Readonly<Record<string, string>> } | undefined> {
  const found = await run([hcHere(), 'get', address, '--json']).catch(() => undefined)
  if (found === undefined) return undefined
  const { state, cwd, labels } = JSON.parse(found) as { readonly state: string; readonly cwd: string; readonly labels: Record<string, string> }
  return { isLive: state === 'live', cwd, labels }
}

// Every live terminal that carries the session's label, which herdr-core keeps on the shell it starts in a kept
// terminal whose program it lost, as after a reboot.
export async function labelledTerminals(session: string): Promise<string[]> {
  const { terminals } = JSON.parse(await run([hcHere(), 'ls', '--json', '--label', `${SESSION_LABEL}=${session}`])) as { readonly terminals: readonly { readonly address: string }[] }
  return terminals.map(({ address }) => address)
}

export const killTerminal = async (address: string): Promise<void> => void (await run([hcHere(), 'kill', address]))

// Pastes `text` and presses Enter, as herdr-core does once a person's unfinished draft is sent, and refuses while the
// program is blocked on a dialog.
export const sendTo = async (address: string, text: string): Promise<void> => void (await run([hcHere(), 'send', address, text]))

// Presses named keys, as `down enter` answers a permission prompt and `esc` stops a turn.
export const pressKeys = async (address: string, keys: readonly string[]): Promise<void> => void (await run([hcHere(), 'keys', address, ...keys]))

// The terminal's screen with `lines` lines of history above it, with no blank lines.
export const readTerminal = async (address: string, lines: number): Promise<string> =>
  (await run([hcHere(), 'read', address, ...(lines > 0 ? ['--lines', String(lines)] : [])])).split('\n').filter((line) => line.trim() !== '').join('\n')

// A machine herdr-core reaches from here: the name terminals there carry (`<name>/t7`) and how herdr-core dials it.
export type Reached = { readonly name: string; readonly target: string; readonly connected: boolean }

export async function machinesReached(): Promise<Reached[]> {
  const { machines } = JSON.parse(await run([hcHere(), 'machine', 'ls', '--json'])) as { readonly machines: readonly { readonly name: string; readonly target: string; readonly temporary: boolean; readonly state: string }[] }
  return machines.filter((machine) => !machine.temporary).map(({ name, target, state }) => ({ name, target, connected: state === 'connected' }))
}

// Dials the machine at `target`, as ssh reaches it, and keeps it, installing herdr-core there when it lacks it, as the
// Herdr app's Add a machine does, unless herdr-core reaches it at that target already, which it refuses to add twice.
// Answers the name herdr-core gave it.
export async function reachMachine(target: string, name?: string): Promise<string> {
  const known = (await machinesReached()).find((machine) => machine.target === target)
  if (known !== undefined) return known.name
  const added = JSON.parse(await run([hcHere(), 'machine', 'add', target, '--install', '--json', ...(name === undefined ? [] : ['--name', name])])) as { readonly name: string }
  return added.name
}

export const forgetMachine = async (name: string): Promise<void> => void (await run([hcHere(), 'machine', 'rm', name]))

// Runs `script` in the person's login shell on a machine herdr-core reaches, where cmod and npm are on its PATH, and
// answers what it printed. It gets herdr-core's longest run, 600 s, as a first `cmod install` there outlives its 60 s.
export const runOn = async (machine: string, script: string): Promise<string> =>
  await run([hcHere(), 'exec', '--on', machine, '--timeout', '600', 'sh', '-c', 'exec "${SHELL:-sh}" -i -l -c "$0"', script])

// The runner's own terminal, which herdr-core names in HC_TERMINAL_ID, gets the session's label, so a session the Herdr
// app started is found as one anyhost opened is.
export async function labelOwnTerminal(session: string): Promise<void> {
  const address = process.env['HC_TERMINAL_ID']
  if (address === undefined || address === '') return
  await run([hcHere(), 'label', address, `${SESSION_LABEL}=${session}`])
}
