import { dlopen, FFIType } from 'bun:ffi'
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentStatus } from '../../relay/protocol.ts'
import { stateFolder } from './device.ts'
import { hcPath, killTerminal, labelledTerminals } from './hc.ts'

const EXIT_MS = 10_000

export type RunningSession = {
  readonly pid: number
  readonly sessionId: string
  readonly cwd: string
  readonly status?: string
  readonly statusSince?: number
}

export type OnRecordsChange = (heard: () => void) => () => void

type SessionRecord = { readonly pid?: number; readonly sessionId?: string; readonly cwd?: string; readonly status?: string; readonly statusUpdatedAt?: number; readonly parkedJobId?: string; readonly procStart?: string }

const CLAUDE_MARKERS = ['CLAUDECODE', 'CLAUDE_PID', 'AI_AGENT', 'CLAUDE_EFFORT', 'TRACEPARENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']

export const forgetClaudeMarkers = (): void => {
  for (const name of CLAUDE_MARKERS) delete process.env[name]
}

export async function run(argv: readonly string[], options: { readonly cwd?: string; readonly env?: Record<string, string> } = {}): Promise<string> {
  const child = Bun.spawn([...argv], { env: process.env, ...options, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
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
  const child = Bun.spawn(['env', 'DISABLE_AUTO_UPDATE=true', await loginShell(), '-i', '-l', '-c', `printf '${ENVIRONMENT_MARK.replaceAll('\0', '\\000')}'; env -0`], { env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', cwd: homedir(), timeout: ENVIRONMENT_MS, detached: true })
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

const PROC_PIDTBSDINFO = 3
const BSD_INFO_BYTES = 136
const STATUS_AT = 4
const START_SECONDS_AT = 120
const SSTOP = 4
const openLibproc = () => dlopen('/usr/lib/libSystem.B.dylib', { proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 } })
let libproc: ReturnType<typeof openLibproc> | undefined

function bsdInfoOf(pid: number): DataView | undefined {
  libproc ??= openLibproc()
  const info = new Uint8Array(BSD_INFO_BYTES)
  return libproc.symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, BSD_INFO_BYTES) === BSD_INFO_BYTES ? new DataView(info.buffer) : undefined
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const twoDigits = (value: number): string => String(value).padStart(2, '0')

function asPsStart(seconds: number): string {
  const at = new Date(seconds * 1000)
  return `${DAYS[at.getUTCDay()]} ${MONTHS[at.getUTCMonth()]} ${String(at.getUTCDate()).padStart(2, ' ')} ${twoDigits(at.getUTCHours())}:${twoDigits(at.getUTCMinutes())}:${twoDigits(at.getUTCSeconds())} ${at.getUTCFullYear()}`
}

export function startOf(pid: number): string {
  if (process.platform === 'linux') return procStat(pid)[19] ?? ''
  const info = bsdInfoOf(pid)
  return info === undefined ? '' : asPsStart(Number(info.getBigUint64(START_SECONDS_AT, true)))
}

export const isPaused = (pid: number): boolean => (process.platform === 'linux' ? (procStat(pid)[0] ?? '').startsWith('T') : bsdInfoOf(pid)?.getUint32(STATUS_AT, true) === SSTOP)

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

const withCurrentStatus = (record: SessionRecord): SessionRecord => (record.parkedJobId === undefined ? record : { ...record, status: 'idle' })

export async function recordedSessions(claudeHome: string): Promise<RunningSession[]> {
  const folder = join(claudeHome, 'sessions')
  return namesIn(folder)
    .filter((name) => /^\d+\.json$/.test(name))
    .flatMap((name) => {
      const found = jsonOf(join(folder, name)) as SessionRecord | undefined
      if (found?.pid === undefined || found.sessionId === undefined || !isAlive(found.pid)) return []
      const record = withCurrentStatus(found)
      return [{ pid: found.pid, sessionId: found.sessionId, cwd: record.cwd ?? '', ...(record.status === undefined ? {} : { status: record.status }), ...(found.statusUpdatedAt === undefined ? {} : { statusSince: found.statusUpdatedAt }) } as const]
    })
}

export const recordAt = (claudeHome: string, pid: number): SessionRecord | undefined => {
  const record = jsonOf(join(claudeHome, 'sessions', `${pid}.json`)) as SessionRecord | undefined
  return record === undefined ? undefined : withCurrentStatus(record)
}

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

const STATUS: Record<string, AgentStatus> = { busy: 'working', shell: 'working', idle: 'idle', waiting: 'waiting' }
export const statusOfRecord = (status: string | undefined): AgentStatus => STATUS[status ?? 'idle'] ?? 'working'

const copiesOf = async (claudeHome: string, session: string): Promise<number[]> =>
  (await recordedSessions(claudeHome)).filter((entry) => entry.sessionId === session && isProcess(entry.pid, recordAt(claudeHome, entry.pid)?.procStart)).map(({ pid }) => pid)

export async function statusOf(claudeHome: string, session: string): Promise<AgentStatus | undefined> {
  const record = (await recordedSessions(claudeHome)).find((entry) => entry.sessionId === session)
  return record === undefined ? undefined : statusOfRecord(record.status)
}

const CLAUDE_START = [
  'my ($environment, $trustsHome) = splice(@ARGV, 0, 2);',
  'if (open(my $file, "<", $environment)) { local $/; require JSON::PP; my $saved = eval { JSON::PP::decode_json(<$file>) }; @ENV{keys %{$saved->{environment}}} = values %{$saved->{environment}} if ref $saved eq "HASH" && ref $saved->{environment} eq "HASH" }',
  `delete @ENV{qw(${CLAUDE_MARKERS.join(' ')})};`,
  'if ($trustsHome) {',
  '  my $start;',
  '  if ($^O eq "linux") { if (open(my $stat, "<", "/proc/$$/stat")) { my $line = <$stat>; $start = (split / /, substr($line, rindex($line, ")") + 2))[19] } }',
  '  else { local $ENV{TZ} = "UTC"; $start = `ps -o lstart= -p $$` }',
  '  $start =~ s/^\\s+|\\s+$//g if defined $start;',
  '  $ENV{CLAUDE_CODE_RELAUNCH_HOME_TRUST} = "$$:$start" if defined $start && $start ne "";',
  '}',
  'exec { $ARGV[0] } @ARGV or die "$ARGV[0]: $!\\n";',
].join('\n')

export const claudeStart = (argv: readonly string[], trustsHome: boolean): string[] => ['perl', '-e', CLAUDE_START, '--', environmentFile(), trustsHome ? '1' : '', ...argv]

export type Resumed = { readonly model?: string; readonly effort?: string }
const EDGE_BYTES = 1 << 20

export async function resumedOf(transcript: string): Promise<Resumed> {
  const file = Bun.file(transcript)
  const last = (await file.slice(Math.max(0, file.size - EDGE_BYTES)).text()).split('\n').findLast((line) => line.startsWith('{') && line.includes('"type":"assistant"'))
  const turn = last === undefined ? undefined : (JSON.parse(last) as { message?: { model?: string }; effort?: string })
  const model = turn?.message?.model?.startsWith('<') === false ? turn.message.model : undefined
  return { ...(model === undefined ? {} : { model }), ...(turn?.effort === undefined ? {} : { effort: turn.effort }) }
}

export const resumeArgv = (session: string, resumed: Resumed): string[] => [
  'claude',
  ...(resumed.model === undefined ? [] : ['--model', resumed.model]),
  ...(resumed.effort === undefined ? [] : ['--effort', resumed.effort]),
  '--resume',
  session,
]

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

async function ended(pids: readonly number[]): Promise<void> {
  signal(pids, 'SIGTERM')
  signal(pids, 'SIGCONT')
  const stuck = (await Promise.all(pids.map(async (pid) => ((await ends(pid)) ? [] : [pid])))).flat()
  signal(stuck, 'SIGKILL')
  for (const pid of stuck) if (!(await ends(pid))) throw new Error(`Claude Code, pid ${pid}, still runs ${EXIT_MS / 1000} s after its SIGKILL.`)
}

export async function stopCopy(claudeHome: string, session: string): Promise<void> {
  const copies = await copiesOf(claudeHome, session)
  const terminals = hcPath() === undefined ? [] : await labelledTerminals(session)
  for (const terminal of terminals) await killTerminal(terminal).catch((error: unknown) => console.error(`anyhost could not close terminal ${terminal} of ${session}: ${error instanceof Error ? error.message : String(error)}`))
  await ended(copies)
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
