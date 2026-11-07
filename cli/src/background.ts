// Claude Code's background sessions on this machine. Claude Code's daemon runs each one in a terminal of its own, so the
// session outlives anyhost and every viewer, and `claude attach <id>` shows it in any terminal, `id` being the first 8
// characters of the session's id.
import type { Subprocess } from 'bun'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

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
// Claude Code runs one daemon per machine, which runs each background session as processes of its own, and the first
// `claude --bg` or `claude attach` that finds none starts it as `claude daemon run --origin transient`, in that
// client's cgroup. On Linux every Claude Code process this program starts runs in a scope of a new name inside this
// slice, so the daemon one of them starts, and every session it runs, lives in the slice too, outside the service's
// cgroup, which systemd stops as the service restarts (worker-spec W5). A stop of the slice ends every daemon, session
// and attach this program started. systemd nests the slice under `anyhost.slice`, for the dash in its name.
const CLAUDE_SLICE = 'anyhost-claude.slice'

// The environment the person's own terminal gives a program, and why it is this program's own instead, when it is.
type PersonEnvironment = { readonly environment: Record<string, string>; readonly problem?: string }

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

// A session Claude Code runs here, as its record in `sessions/` names it, or a background session it ran, as `claude
// agents --json --all` adds it. Only a background session has `id`, and only a running one `pid`.
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

// The running sessions and every background session Claude Code ran here and keeps, stopped, done or failed. `claude
// attach <id>` opens a stopped one again under its own id, where `claude --bg --resume` would start a copy of it.
export const keptSessions = async (): Promise<RunningSession[]> => JSON.parse(await run([claude(), 'agents', '--json', '--all'])) as RunningSession[]

// The sessions Claude Code runs here, from the record each one keeps in `sessions/<pid>.json` under its folder,
// `claudeHome`, while it runs: its `jobId` is the id `claude attach` takes, and a record whose process ended, or that
// Claude Code is writing, is none. A background session runs only while Claude Code's daemon does: the daemon's end
// ends its sessions, which take up to 2.1 s more to end and remove their records, and a `claude attach` that reached
// one of them first would start a new daemon, which starts it again.
type SessionRecord = { readonly pid?: number; readonly sessionId?: string; readonly jobId?: string; readonly cwd?: string; readonly status?: string; readonly kind?: string }
export async function recordedSessions(claudeHome: string): Promise<RunningSession[]> {
  const folder = join(claudeHome, 'sessions')
  const names = await readdir(folder).catch(() => [])
  const records = await Promise.all(names.filter((name) => /^\d+\.json$/.test(name)).map((name) => Bun.file(join(folder, name)).json().catch(() => undefined) as Promise<SessionRecord | undefined>))
  const hasDaemon = await isDaemonRunning(claudeHome)
  return records.flatMap((record) => {
    if (record?.pid === undefined || record.sessionId === undefined || !isAlive(record.pid)) return []
    if (record.kind === 'bg' && !hasDaemon) return []
    const job = record.jobId === undefined ? {} : { id: record.jobId }
    return [{ pid: record.pid, ...job, sessionId: record.sessionId, kind: record.kind === 'bg' ? 'background' : 'interactive', cwd: record.cwd ?? '', ...(record.status === undefined ? {} : { status: record.status }) } as const]
  })
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Whether Claude Code's daemon runs here, as Claude Code itself reads it: the lock `daemon.lock` in its folder names a
// process that lives and, where /proc holds the process, started when the lock says, since a pid is used again. The
// daemon removes its lock as it ends, and one killed leaves it.
async function isDaemonRunning(claudeHome: string): Promise<boolean> {
  const lock = (await Bun.file(join(claudeHome, 'daemon.lock')).json().catch(() => ({}))) as { readonly pid?: number; readonly procStart?: string }
  if (lock.pid === undefined || !isAlive(lock.pid)) return false
  // its start in clock ticks, the 22nd field of its stat, which counts from the state after its name in parentheses
  const stat = await Bun.file(`/proc/${lock.pid}/stat`).text().catch(() => undefined)
  return stat === undefined || stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === lock.procStart
}

// Calls `heard` at each change of Claude Code's records under its folder, until the function it answers is called.
export type OnRecordsChange = (heard: () => void) => () => void

// Answers the first time `found` finds what it looks for in the sessions Claude Code runs here, read again at each
// change of their records under `claudeHome`, or undefined once `limitMs` passed.
export function whenSessions<T>(claudeHome: string, found: (sessions: readonly RunningSession[]) => T | undefined, limitMs: number, onRecordsChange: OnRecordsChange): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    let isReading = false
    let isStale = false
    let isDone = false
    // a change during a read reads again once it ended
    const stopHearing = onRecordsChange(() => void read())
    const end = (): void => {
      isDone = true
      stopHearing()
      clearTimeout(limit)
    }
    const limit = Number.isFinite(limitMs)
      ? setTimeout(() => {
          end()
          resolve(undefined)
        }, limitMs)
      : undefined
    const read = async (): Promise<void> => {
      if (isDone) return
      if (isReading) {
        isStale = true
        return
      }
      isReading = true
      const value = await recordedSessions(claudeHome).then(found, (error: unknown) => {
        end()
        reject(error)
        return undefined
      })
      isReading = false
      if (isDone) return
      if (value !== undefined) {
        end()
        resolve(value)
        return
      }
      if (isStale) {
        isStale = false
        return void read()
      }
    }
    void read()
  })
}

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

// The command in a scope `anyhost-<name>-<random>.scope` inside CLAUDE_SLICE where systemd-run is, as on Linux. A fixed
// name stays taken while any process of the scope runs, as a daemon its client started, or while any unit names it,
// so each scope's name is new. systemd-run runs the command itself in the scope, so its process is the command's.
const inScope = (name: string, command: readonly string[]): string[] =>
  Bun.which('systemd-run') === null ? [...command] : ['systemd-run', '--user', '--scope', '--quiet', '--collect', '--slice', CLAUDE_SLICE, '--unit', `anyhost-${name}-${crypto.randomUUID().slice(0, 8)}.scope`, ...command]

// Starts the session in Claude Code's background in `cwd`, the folder it continues in, or a new session there with no
// `session`, and answers the id `claude attach` takes. `claude --bg` picks a new session's id itself and ignores
// `--session-id`, so the id is the one it prints. A `claude --bg` that finds no daemon starts it with `env`, which
// every session the daemon runs gets.
export async function startInBackground(session: string | undefined, cwd: string, env: Record<string, string>): Promise<string> {
  const printed = await run(inScope('bg', session === undefined ? [claude(), '--bg'] : [claude(), '--bg', '--resume', session]), { cwd, env })
  if (session !== undefined) return session.slice(0, 8)
  const id = /backgrounded · ([0-9a-f]{8})/.exec(printed)?.[1]
  if (id === undefined) throw new Error(`claude --bg printed no session id: ${printed.trim()}`)
  return id
}

// The id `claude attach` takes for a session this machine holds, and the folder it runs in. A background job Claude Code
// keeps of the session, running or stopped, opens with `claude attach`, which starts a stopped one again under its own
// id, as `claude --bg --resume` would start a copy under a new one. Any other session starts in Claude Code's background
// in `cwd`, the folder it continues in here. A session Claude Code runs in a terminal of its own shows only there.
// `machine` names this machine in the refusals.
export async function backgroundJobOf(session: string, cwd: string, env: Record<string, string>, machine: string): Promise<{ readonly id: string; readonly cwd: string }> {
  const kept = (await keptSessions()).find((entry) => entry.sessionId === session)
  if (kept?.kind === 'interactive') throw new Error(`${machine} runs the session ${session} in a terminal of its own, so only that terminal shows it.`)
  if (kept?.id !== undefined) return { id: kept.id, cwd: kept.cwd }
  if (cwd === '') throw new Error(`${machine} knows no folder of the session ${session}, so it cannot start it.`)
  return { id: await startInBackground(session, cwd, env), cwd }
}

// Stops a background session Claude Code runs here. Claude Code keeps its job, which `claude attach` starts again.
export async function stopInBackground(id: string, env: Record<string, string>): Promise<void> {
  await run([claude(), 'stop', id], { env })
}

// `claude attach` reaches Claude Code's daemon, which starts the job again when it is stopped. A `claude attach` whose
// daemon went starts a new one 163 ms to 4 s later on anyhost-d, which adopts every session whose process still runs,
// in the attach's scope inside CLAUDE_SLICE, so a stop of the slice ends it, its sessions and every attach at once.
export function attachTerminal(id: string, cwd: string, env: Record<string, string>, { cols, rows }: { readonly cols: number; readonly rows: number }, onOutput: (bytes: Uint8Array) => void): AttachedTerminal {
  const terminal = new Bun.Terminal({ cols, rows, name: 'xterm-256color', data: (_terminal, bytes) => onOutput(bytes) })
  const command = inScope(`attach-${id}`, [claude(), 'attach', id])
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
