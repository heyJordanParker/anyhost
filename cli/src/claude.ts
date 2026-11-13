import { readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentStatus } from '../../relay/protocol.ts'
import { stateFolder } from './device.ts'
import { killTerminal } from './hc.ts'

const EXIT_MS = 10_000

export type RunningSession = {
  readonly pid: number
  readonly sessionId: string
  readonly cwd: string
  readonly status?: string
}

export type OnRecordsChange = (heard: () => void) => () => void

type SessionRecord = { readonly pid?: number; readonly sessionId?: string; readonly cwd?: string; readonly status?: string; readonly procStart?: string }
export type RunProcess = { readonly id: number; readonly start: string }
export type Run = {
  readonly session: string
  readonly runner: { readonly process: RunProcess; readonly version: string; readonly startedAt: string }
  readonly terminal?: { readonly address: string; readonly machine: string }
  readonly claude: { readonly command: readonly string[]; readonly process?: RunProcess; readonly startedAt?: string }
}

export async function run(argv: readonly string[], options: { readonly cwd?: string; readonly env?: Record<string, string> } = {}): Promise<string> {
  const child = Bun.spawn([...argv], { ...options, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`${argv.join(' ')} exited with ${code}: ${error.trim() || output.trim()}`)
  return output
}

export async function loginShell(): Promise<string> {
  const shell =
    process.platform === 'darwin'
      ? /UserShell:\s*(\S+)/.exec(await run(['/usr/bin/dscl', '.', '-read', `/Users/${(await run(['/usr/bin/id', '-un'])).trim()}`, 'UserShell']))?.[1]
      : (await run(['getent', 'passwd', String(process.getuid?.() ?? '')])).trim().split(':')[6]
  if (shell === undefined || shell === '') throw new Error('the account database names no shell for this user')
  return shell
}

const SHELL_STARTUP = ['.zshenv', '.zprofile', '.zshrc', '.zlogin', '.bash_profile', '.bashrc', '.profile']
const TERMINAL_OWN = /^(TERM|TERM_PROGRAM|TERM_PROGRAM_VERSION|COLORTERM|SHLVL|PWD|OLDPWD|_|HC_.*)$/
const ENVIRONMENT_MARK = '\0anyhost-environment\0'
const ENVIRONMENT_MS = 20_000

const environmentFile = (): string => join(stateFolder(), 'environment.json')

export const startupChangedAt = (): number =>
  Math.max(0, ...SHELL_STARTUP.map((name) => {
    try {
      return statSync(join(homedir(), name)).mtimeMs
    } catch {
      return 0
    }
  }))

export async function saveLoginEnvironment(): Promise<Record<string, string>> {
  const child = Bun.spawn(['env', 'DISABLE_AUTO_UPDATE=true', await loginShell(), '-i', '-l', '-c', `printf '${ENVIRONMENT_MARK.replaceAll('\0', '\\000')}'; env -0`], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', cwd: homedir(), timeout: ENVIRONMENT_MS })
  const output = await new Response(child.stdout).text()
  if ((await child.exited) !== 0 || !output.includes(ENVIRONMENT_MARK)) throw new Error(`the login shell gave no environment within ${ENVIRONMENT_MS / 1000} s`)
  const pairs = output.slice(output.indexOf(ENVIRONMENT_MARK) + ENVIRONMENT_MARK.length).split('\0').filter((pair) => pair.includes('='))
  const environment = Object.fromEntries(pairs.map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)] as const).filter(([name]) => !TERMINAL_OWN.test(name)))
  mkdirSync(stateFolder(), { recursive: true })
  writeFileSync(environmentFile(), JSON.stringify({ changedAt: startupChangedAt(), environment }))
  return environment
}

export async function loginEnvironment(): Promise<Record<string, string>> {
  const saved = jsonOf(environmentFile()) as { readonly changedAt?: number; readonly environment?: Record<string, string> } | undefined
  if (saved?.environment !== undefined && saved.changedAt === startupChangedAt()) return saved.environment
  return await saveLoginEnvironment()
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function procStat(pid: number): string[] {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  } catch {
    return []
  }
}

const psOf = (pid: number, field: string): string => Bun.spawnSync(['ps', '-o', `${field}=`, '-p', String(pid)], { env: { ...process.env, TZ: 'UTC' }, stdout: 'pipe', stderr: 'ignore' }).stdout.toString().trim()

export const startOf = (pid: number): string => (process.platform === 'linux' ? (procStat(pid)[19] ?? '') : psOf(pid, 'lstart'))

export const isPaused = (pid: number): boolean => (process.platform === 'linux' ? (procStat(pid)[0] ?? '') : psOf(pid, 'stat')).startsWith('T')

const isProcess = (pid: number, procStart: string | undefined): boolean => isAlive(pid) && (procStart === undefined || startOf(pid) === procStart)

function jsonOf(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function namesIn(folder: string): string[] {
  try {
    return readdirSync(folder)
  } catch {
    return []
  }
}

export async function recordedSessions(claudeHome: string): Promise<RunningSession[]> {
  const folder = join(claudeHome, 'sessions')
  return namesIn(folder)
    .filter((name) => /^\d+\.json$/.test(name))
    .flatMap((name) => {
      const record = jsonOf(join(folder, name)) as SessionRecord | undefined
      if (record?.pid === undefined || record.sessionId === undefined || !isAlive(record.pid)) return []
      return [{ pid: record.pid, sessionId: record.sessionId, cwd: record.cwd ?? '', ...(record.status === undefined ? {} : { status: record.status }) } as const]
    })
}

export const recordAt = (claudeHome: string, pid: number): SessionRecord | undefined => jsonOf(join(claudeHome, 'sessions', `${pid}.json`)) as SessionRecord | undefined

export function whenSessions<T>(claudeHome: string, found: (sessions: readonly RunningSession[]) => T | undefined, limitMs: number, onRecordsChange: OnRecordsChange, signal?: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    let isReading = false
    let isStale = false
    let isDone = false
    const stopHearing = onRecordsChange(() => void read())
    const end = (): void => {
      isDone = true
      stopHearing()
      clearTimeout(limit)
      signal?.removeEventListener('abort', aborted)
    }
    const aborted = (): void => {
      end()
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', aborted, { once: true })
    const limit = Number.isFinite(limitMs)
      ? setTimeout(() => {
          end()
          resolve(undefined)
        }, limitMs)
      : undefined
    if (signal?.aborted === true) return aborted()
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

const runsFolder = (): string => join(stateFolder(), 'runs')

export const runOf = (session: string): Run | undefined => {
  const run = jsonOf(join(runsFolder(), `${session}.json`)) as Run | undefined
  return run?.runner !== undefined && isProcess(run.runner.process.id, run.runner.process.start) ? run : undefined
}

export const runSessions = (): string[] =>
  namesIn(runsFolder())
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((session) => runOf(session) !== undefined)

export const stoppedRuns = (): { readonly session: string; readonly run: Run }[] =>
  namesIn(runsFolder())
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const session = name.slice(0, -'.json'.length)
      const run = jsonOf(join(runsFolder(), name)) as Run | undefined
      return run?.runner === undefined || isProcess(run.runner.process.id, run.runner.process.start) ? [] : [{ session, run }]
    })

const STATUS: Record<string, AgentStatus> = { busy: 'working', shell: 'working', idle: 'idle', waiting: 'waiting' }
export const statusOfRecord = (status: string | undefined): AgentStatus => STATUS[status ?? 'idle'] ?? 'working'

const copiesOf = async (claudeHome: string, session: string): Promise<number[]> =>
  (await recordedSessions(claudeHome)).filter((entry) => entry.sessionId === session && isProcess(entry.pid, recordAt(claudeHome, entry.pid)?.procStart)).map(({ pid }) => pid)

export async function runTerminalOf(claudeHome: string, session: string): Promise<string | undefined> {
  const run = runOf(session)
  const address = run?.terminal?.address
  if (address === undefined) return undefined
  const own = new Set([run?.runner.process.id, run?.claude.process?.id])
  return (await copiesOf(claudeHome, session)).every((pid) => own.has(pid)) ? address : undefined
}

export async function statusOf(claudeHome: string, session: string): Promise<AgentStatus | undefined> {
  const record = (await recordedSessions(claudeHome)).find((entry) => entry.sessionId === session)
  if (record !== undefined) return statusOfRecord(record.status)
  return runOf(session) === undefined ? undefined : 'idle'
}

export function writeRun(session: string, run: Run): void {
  mkdirSync(runsFolder(), { recursive: true })
  writeFileSync(join(runsFolder(), `${session}.json`), JSON.stringify(run))
}

export const forgetRun = (session: string): void => rmSync(join(runsFolder(), `${session}.json`), { force: true })

export const commandOf = (session: string): readonly string[] => runOf(session)?.claude.command ?? ['claude']

async function becomes(isDone: () => boolean): Promise<boolean> {
  for (const started = Date.now(); !isDone(); await Bun.sleep(50)) {
    if (Date.now() - started > EXIT_MS) return false
  }
  return true
}

const ends = (pid: number): Promise<boolean> => becomes(() => !isAlive(pid))

const signal = (pids: readonly number[], name: NodeJS.Signals): void => {
  for (const pid of pids) {
    try {
      process.kill(pid, name)
    } catch {
      continue
    }
  }
}

export async function stopCopy(claudeHome: string, session: string): Promise<void> {
  const copies = await copiesOf(claudeHome, session)
  const ran = runOf(session)
  const terminal = ran?.terminal?.address
  if (terminal !== undefined) await killTerminal(terminal).catch((error: unknown) => console.error(`anyhost could not close terminal ${terminal} of ${session}: ${error instanceof Error ? error.message : String(error)}`))
  const pids = [...(ran === undefined ? [] : [ran.runner.process.id]), ...copies]
  signal(pids, 'SIGTERM')
  signal(pids, 'SIGCONT')
  const stuck = (await Promise.all(pids.map(async (pid) => ((await ends(pid)) ? [] : [pid])))).flat()
  signal(stuck, 'SIGKILL')
  for (const pid of stuck) if (!(await ends(pid))) throw new Error(`Claude Code, pid ${pid}, still runs ${EXIT_MS / 1000} s after its SIGKILL.`)
  forgetRun(session)
  rmSync(pausedFile(session), { force: true })
}

const pausedFolder = (): string => join(stateFolder(), 'paused')
const pausedFile = (session: string): string => join(pausedFolder(), `${session}.json`)

export const pausedSessions = (): string[] =>
  namesIn(pausedFolder())
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))

export async function pauseCopy(claudeHome: string, session: string): Promise<number> {
  const copies = await copiesOf(claudeHome, session)
  mkdirSync(pausedFolder(), { recursive: true })
  writeFileSync(pausedFile(session), JSON.stringify(copies))
  signal(copies, 'SIGSTOP')
  for (const pid of copies) if (!(await becomes(() => !isAlive(pid) || isPaused(pid)))) throw new Error(`Claude Code, pid ${pid}, still runs ${EXIT_MS / 1000} s after its SIGSTOP.`)
  return copies.length
}

export async function resumeCopy(claudeHome: string, session: string): Promise<number> {
  const paused = new Set((jsonOf(pausedFile(session)) as number[] | undefined) ?? [])
  const copies = await copiesOf(claudeHome, session)
  signal(copies.filter((pid) => paused.has(pid)), 'SIGCONT')
  rmSync(pausedFile(session), { force: true })
  return copies.length
}
