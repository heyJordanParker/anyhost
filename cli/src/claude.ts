import { readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
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
export type Run = { readonly pid: number; readonly procStart: string; readonly terminal?: string; readonly command: readonly string[] }

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

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function startOf(pid: number): string {
  if (process.platform === 'linux') {
    const stat = (() => {
      try {
        return readFileSync(`/proc/${pid}/stat`, 'utf8')
      } catch {
        return ''
      }
    })()
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? ''
  }
  const ps = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, TZ: 'UTC' }, stdout: 'pipe', stderr: 'ignore' })
  return ps.stdout.toString().trim()
}

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
  return run !== undefined && isProcess(run.pid, run.procStart) ? run : undefined
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
      return run === undefined || isProcess(run.pid, run.procStart) ? [] : [{ session, run }]
    })

const STATUS: Record<string, AgentStatus> ={ busy: 'working', shell: 'working', idle: 'idle', waiting: 'waiting' }

export async function statusOf(claudeHome: string, session: string): Promise<AgentStatus | undefined> {
  const record = (await recordedSessions(claudeHome)).find((entry) => entry.sessionId === session)
  if (record !== undefined) return STATUS[record.status ?? 'idle'] ?? 'working'
  return runOf(session) === undefined ? undefined : 'idle'
}

export function writeRun(session: string, run: Run): void {
  mkdirSync(runsFolder(), { recursive: true })
  writeFileSync(join(runsFolder(), `${session}.json`), JSON.stringify(run))
}

export const forgetRun = (session: string): void => rmSync(join(runsFolder(), `${session}.json`), { force: true })

export const commandOf = (session: string): readonly string[] => runOf(session)?.command ?? ['claude']

async function ends(pid: number): Promise<boolean> {
  for (const started = Date.now(); isAlive(pid); await Bun.sleep(50)) {
    if (Date.now() - started > EXIT_MS) return false
  }
  return true
}

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
  const record = (await recordedSessions(claudeHome)).find((entry) => entry.sessionId === session)
  const recorded = record !== undefined && isProcess(record.pid, recordAt(claudeHome, record.pid)?.procStart) ? record.pid : undefined
  const ran = runOf(session)
  if (ran?.terminal !== undefined) await killTerminal(ran.terminal).catch((error: unknown) => console.error(`anyhost could not close terminal ${ran.terminal} of ${session}: ${error instanceof Error ? error.message : String(error)}`))
  const pids = [ran?.pid, recorded].filter((pid): pid is number => pid !== undefined)
  signal(pids, 'SIGTERM')
  const stuck = (await Promise.all(pids.map(async (pid) => ((await ends(pid)) ? [] : [pid])))).flat()
  signal(stuck, 'SIGKILL')
  for (const pid of stuck) if (!(await ends(pid))) throw new Error(`Claude Code, pid ${pid}, still runs ${EXIT_MS / 1000} s after its SIGKILL.`)
  forgetRun(session)
}
