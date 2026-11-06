// Claude Code's background sessions on this machine. Claude Code's daemon runs each one in a terminal of its own, so the
// session outlives anyhost and every viewer, and `claude attach <id>` shows it in any terminal, `id` being the first 8
// characters of the session's id.
import type { Subprocess } from 'bun'

// A service gets the person's Claude Code in CLAUDE_CODE_EXECPATH, which cmod sets, and a command finds it on PATH.
const claude = (): string => process.env['CLAUDE_CODE_EXECPATH'] || 'claude'

// A login shell printed the environment in 135 ms on a Mac, and VS Code's getResolvedShellEnv, the Precedent, waits
// 10 s for slower startup files.
const SHELL_MS = 10_000
// The environment is in the pipe before the shell ends, so a read that has not ended this long after holds none.
const EXITED_MS = 500
// a startup file's failure is in the last lines of its errors
const ERRORS_KEPT = 4096
// what the shell itself sets for the program it runs, which says nothing of the person
const SHELL_OWN = ['PWD', 'OLDPWD', 'SHLVL', '_', 'BUN_BE_BUN']

// The environment the person's own terminal gives a program, and why it is this program's own instead, when it is.
export type PersonEnvironment = { readonly environment: Record<string, string>; readonly problem?: string }

// The shell the person's account names. Bun's os.userInfo() reads it from SHELL, which a service lacks, so it comes
// from the account database: Directory Services on macOS, getent elsewhere.
async function loginShell(): Promise<string> {
  const shell =
    process.platform === 'darwin'
      ? /UserShell:\s*(\S+)/.exec(await run(['/usr/bin/dscl', '.', '-read', `/Users/${(await run(['/usr/bin/id', '-un'])).trim()}`, 'UserShell']))?.[1]
      : (await run(['getent', 'passwd', String(process.getuid?.() ?? '')])).trim().split(':')[6]
  if (shell === undefined || shell === '') throw new Error('the account database names no shell for this user')
  return shell
}

// A session Claude Code runs here, as `claude agents --json` lists it, or a background session it ran, as `--all` adds
// it. Only a background session has `id`, and only a running one `pid`.
export type RunningSession = {
  readonly pid?: number
  readonly id?: string
  readonly sessionId: string
  readonly kind: 'background' | 'interactive'
  readonly cwd: string
  readonly status?: string
  readonly state?: string
}

// `claude attach` under a terminal of this program's. Bun's terminal gives its child no controlling terminal, so a
// resize signals nobody, and `resize` sends the child SIGWINCH itself (worker-spec W2). `exited` answers the signal
// that ended it, or null when it ended by itself.
export type AttachedTerminal = {
  write(bytes: Uint8Array): void
  resize(cols: number, rows: number): void
  readonly exited: Promise<Subprocess['signalCode']>
  close(): void
}

// Runs a program to its end and answers what it printed, or rejects with its exit code and its errors.
export async function run(argv: readonly string[], options: { readonly cwd?: string; readonly env?: Record<string, string> } = {}): Promise<string> {
  const child = Bun.spawn([...argv], { ...options, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`${argv.join(' ')} exited with ${code}: ${error.trim() || output.trim()}`)
  return output
}

export const runningSessions = async (): Promise<RunningSession[]> => JSON.parse(await run([claude(), 'agents', '--json'])) as RunningSession[]

// The running sessions and every background session Claude Code ran here and keeps, stopped, done or failed. `claude
// attach <id>` opens a stopped one again under its own id, where `claude --bg --resume` would start a copy of it.
export const keptSessions = async (): Promise<RunningSession[]> => JSON.parse(await run([claude(), 'agents', '--json', '--all'])) as RunningSession[]

const ownEnvironment = (): Record<string, string> => Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))

// Claude Code's one daemon runs every background session with the environment of the program that started it first,
// and cmod gives a service a fixed PATH without the person's own folders. So the sessions this program starts get the
// environment the person's login shell sets up: the shell from the person's account runs interactive and login, its
// input empty, and prints its environment between two marks, as VS Code's getResolvedShellEnv reads it. Read once per
// start of the program. A shell that fails leaves this program's own environment, with the reason.
let resolved: Promise<PersonEnvironment> | undefined
export function personEnvironment(): Promise<PersonEnvironment> {
  resolved ??= (async (): Promise<PersonEnvironment> => {
    let shell = 'the login shell'
    const mark = crypto.randomUUID()
    // the program runs itself as bun, which prints the environment as JSON whatever the shell
    const script = `process.stdout.write(${JSON.stringify(mark)} + JSON.stringify(process.env) + ${JSON.stringify(mark)})`
    try {
      shell = await loginShell()
      const child = Bun.spawn([shell, '-i', '-l', '-c', `'${process.execPath}' -e '${script}'`], { env: { ...ownEnvironment(), BUN_BE_BUN: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      // A program a startup file leaves running, such as an agent, keeps the pipes open after the shell ends, so the
      // read stops at the second mark, and only the last of the errors is kept as they come.
      let errors = ''
      void (async () => {
        for await (const chunk of child.stderr) errors = (errors + new TextDecoder().decode(chunk)).slice(-ERRORS_KEPT)
      })()
      const printed = await Promise.race([
        between(child.stdout, mark),
        child.exited.then(() => Bun.sleep(EXITED_MS)).then(() => undefined),
        Bun.sleep(SHELL_MS).then(() => 'timeout' as const),
      ])
      if (printed === 'timeout') {
        // an interactive shell ignores SIGTERM
        child.kill('SIGKILL')
        throw new Error(`it printed no environment within ${SHELL_MS / 1000} s`)
      }
      if (printed === undefined) {
        // its output ends a moment before it does
        const code = await Promise.race([child.exited, Bun.sleep(EXITED_MS).then(() => 'running' as const)])
        if (code === 'running') child.kill('SIGKILL')
        // the last lines of its errors, as a startup file's failure ends them
        const said = errors.trim().split('\n').slice(-3).join(' ')
        const ended = code === 'running' ? 'it closed its output without printing the environment' : `it exited with ${code}`
        throw new Error(said === '' ? ended : `${ended}: ${said}`)
      }
      const environment = JSON.parse(printed) as Record<string, string>
      for (const name of SHELL_OWN) delete environment[name]
      return { environment: { ...ownEnvironment(), ...environment } }
    } catch (error) {
      const problem = `The sessions anyhost starts get its own environment, not your shell's, because ${shell} -i -l failed: ${error instanceof Error ? error.message : String(error)}`
      console.error(`${new Date().toISOString()} ${problem}`)
      return { environment: ownEnvironment(), problem }
    }
  })()
  return resolved
}

// What a stream printed between the first two marks, read as it comes, or undefined when it ended before the second.
async function between(stream: ReadableStream<Uint8Array>, mark: string): Promise<string | undefined> {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true })
    const parts = text.split(mark)
    if (parts.length > 2) return parts[1]
  }
  return undefined
}

// On Linux every Claude Code process this program starts runs in a systemd scope of its own, because systemd stops
// every process of a service's cgroup when the service restarts, and Claude Code's daemon, which the first background
// session or a `claude attach` that finds no daemon starts, would go with it (worker-spec W5). systemd-run runs the
// command itself in the scope, so its process is the command's. A scope `partOf` another stops when that one stops.
const inScope = (unit: string, command: readonly string[], partOf?: string): string[] =>
  process.platform === 'linux' && Bun.which('systemd-run') !== null
    ? ['systemd-run', '--user', '--scope', '--quiet', '--collect', ...(partOf === undefined ? [] : ['-p', `PartOf=${partOf}`]), '--unit', unit, ...command]
    : [...command]
const sessionScope = (id: string): string => `anyhost-claude-${id}.scope`

// Starts the session in Claude Code's background in `cwd`, the folder it continues in, or a new session there with no
// `session`, and answers the id `claude attach` takes. A scope of that name that is still there holds the daemon, which
// a bare start reaches. `claude --bg` picks a new session's id itself and ignores `--session-id`, so the id is the one
// it prints, and the scope gets a name of its own.
export async function startInBackground(session: string | undefined, cwd: string, env: Record<string, string>): Promise<string> {
  const command = session === undefined ? [claude(), '--bg'] : [claude(), '--bg', '--resume', session]
  const printed = await run(inScope(sessionScope((session ?? crypto.randomUUID()).slice(0, 8)), command), { cwd, env }).catch(async (error: unknown) => {
    if (!String(error).includes('already loaded')) throw error
    return await run(command, { cwd, env })
  })
  if (session !== undefined) return session.slice(0, 8)
  const id = /backgrounded · ([0-9a-f]{8})/.exec(printed)?.[1]
  if (id === undefined) throw new Error(`claude --bg printed no session id: ${printed.trim()}`)
  return id
}

// Stops a background session Claude Code runs here. Claude Code keeps its job, which `claude attach` starts again.
export async function stopInBackground(id: string, env: Record<string, string>): Promise<void> {
  await run([claude(), 'stop', id], { env })
}

// Each `claude attach` gets a scope of a new name, as the scope of an earlier one stays while a daemon it started runs,
// and its scope stops with the session's. A `claude attach` whose daemon went starts a new one within seconds, which
// starts again every session the last one ran, so the session's scope stopping takes it down at the same moment.
export function attachTerminal(id: string, cwd: string, env: Record<string, string>, { cols, rows }: { readonly cols: number; readonly rows: number }, onOutput: (bytes: Uint8Array) => void): AttachedTerminal {
  const terminal = new Bun.Terminal({ cols, rows, name: 'xterm-256color', data: (_terminal, bytes) => onOutput(bytes) })
  const command = inScope(`anyhost-attach-${id}-${crypto.randomUUID().slice(0, 8)}.scope`, [claude(), 'attach', id], sessionScope(id))
  // Claude Code draws truecolor for a terminal that says it takes it, as the viewer's does
  const child = Bun.spawn(command, { cwd, terminal, env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } })
  return {
    write: (bytes) => void terminal.write(bytes),
    resize(columns, lines) {
      terminal.resize(columns, lines)
      child.kill('SIGWINCH')
    },
    exited: child.exited.then(() => child.signalCode).finally(() => terminal.close()),
    close: () => child.kill(),
  }
}
