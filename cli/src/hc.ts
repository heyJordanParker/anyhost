import { homedir } from 'node:os'
import { join } from 'node:path'
import { loginShell, run } from './claude.ts'

const SPACE = 'anyhost'
export const SESSION_LABEL = 'anyhost.session'
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

export async function openTerminal(cwd: string, session: string, command: readonly string[], isResumed: boolean): Promise<void> {
  const runner = [...self(), 'run', ...(isResumed ? ['--session', session] : []), '--', ...command]
  const labels = ['--label', `herdr.space=${SPACE}`, '--label', `herdr.tab=${session.slice(0, 8)}`, '--label', `${SESSION_LABEL}=${session}`]
  await run(inScope([hcHere(), 'run', '--bg', '--no-parent', '--cwd', cwd, ...labels, '--', await loginShell(), '-i', '-l', '-c', 'exec "$0" "$@"', ...runner]), { cwd })
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

// The runner's own terminal, which herdr-core names in HC_TERMINAL_ID, gets the session's label, so a session the Herdr
// app started is found as one anyhost opened is.
export async function labelOwnTerminal(session: string): Promise<void> {
  const address = process.env['HC_TERMINAL_ID']
  if (address === undefined || address === '') return
  await run([hcHere(), 'label', address, `${SESSION_LABEL}=${session}`])
}
