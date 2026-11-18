import { dlopen, FFIType } from 'bun:ffi'
import { readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
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

const CLAUDE_MARKERS = ['CLAUDECODE', 'CLAUDE_PID', 'AI_AGENT', 'CLAUDE_EFFORT', 'TRACEPARENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']

export const markersIn = (environment: string): readonly string[] => {
  const names = new Set(environment.split('\0').map((entry) => entry.slice(0, entry.indexOf('='))))
  return CLAUDE_MARKERS.filter((name) => names.has(name))
}

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

const SYS_PROC_INFO = 336
const PROC_INFO_CALL_PIDINFO = 2
const PROC_PIDLISTFDS = 1
const PROC_PIDTBSDINFO = 3
const PROC_PIDVNODEPATHINFO = 9
const PROC_PIDFDVNODEPATHINFO = 2
const PROX_FDTYPE_VNODE = 1
const BSD_INFO_BYTES = 136
const STATUS_AT = 4
const PARENT_AT = 16
const START_SECONDS_AT = 120
const SSTOP = 4
const FD_INFO_BYTES = 8
const FD_TYPE_AT = 4
const FD_PATH_INFO_BYTES = 1200
const FD_PATH_AT = 176
const FOLDERS_INFO_BYTES = 2352
const CURRENT_FOLDER_AT = 152
const PIDS_SPARE = 64
const CTL_KERN = 1
const KERN_PROCARGS2 = 49
const ARGUMENTS_BYTES = 1 << 20
const openLibSystem = () =>
  dlopen('/usr/lib/libSystem.B.dylib', {
    proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidfdinfo: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  })
let libSystem: ReturnType<typeof openLibSystem> | undefined
const decoder = new TextDecoder()

const untilNul = (bytes: Uint8Array): string => {
  const end = bytes.indexOf(0)
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end))
}

function infoOf(pid: number, flavor: number, bytes: number): Uint8Array | undefined {
  libSystem ??= openLibSystem()
  const info = new Uint8Array(bytes)
  return libSystem.symbols.proc_pidinfo(pid, flavor, 0, info, bytes) === bytes ? info : undefined
}

function bsdInfoOf(pid: number): DataView | undefined {
  const info = infoOf(pid, PROC_PIDTBSDINFO, BSD_INFO_BYTES)
  return info === undefined ? undefined : new DataView(info.buffer)
}

export function processes(): { readonly pid: number; readonly parent: number }[] {
  if (process.platform === 'linux')
    return namesIn('/proc')
      .filter((name) => /^\d+$/.test(name))
      .flatMap((name) => {
        const parent = procStat(Number(name))[1]
        return parent === undefined ? [] : [{ pid: Number(name), parent: Number(parent) }]
      })
  libSystem ??= openLibSystem()
  const pids = new Int32Array(libSystem.symbols.proc_listallpids(null, 0) + PIDS_SPARE)
  const count = libSystem.symbols.proc_listallpids(pids, pids.byteLength)
  return [...pids.subarray(0, Math.max(count, 0))].flatMap((pid) => {
    const parent = bsdInfoOf(pid)?.getUint32(PARENT_AT, true)
    return parent === undefined ? [] : [{ pid, parent }]
  })
}

export function openFilesOf(pid: number): string[] {
  if (process.platform === 'linux') {
    const folder = `/proc/${pid}/fd`
    return namesIn(folder).flatMap((fd) => {
      try {
        return [readlinkSync(join(folder, fd))]
      } catch {
        return []
      }
    })
  }
  libSystem ??= openLibSystem()
  const listedBytes = libSystem.symbols.proc_pidinfo(pid, PROC_PIDLISTFDS, 0, null, 0)
  if (listedBytes <= 0) return []
  const fds = new Uint8Array(listedBytes)
  const filled = libSystem.symbols.proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, listedBytes)
  const listed = new DataView(fds.buffer)
  const info = new Uint8Array(FD_PATH_INFO_BYTES)
  const paths: string[] = []
  for (let at = 0; at + FD_INFO_BYTES <= filled; at += FD_INFO_BYTES) {
    if (listed.getUint32(at + FD_TYPE_AT, true) !== PROX_FDTYPE_VNODE) continue
    if (libSystem.symbols.proc_pidfdinfo(pid, listed.getInt32(at, true),PROC_PIDFDVNODEPATHINFO, info, FD_PATH_INFO_BYTES) === FD_PATH_INFO_BYTES) paths.push(untilNul(info.subarray(FD_PATH_AT)))
  }
  return paths
}

export function currentFolderOf(pid: number): string {
  if (process.platform === 'linux') {
    try {
      return readlinkSync(`/proc/${pid}/cwd`)
    } catch {
      return ''
    }
  }
  const info = infoOf(pid, PROC_PIDVNODEPATHINFO, FOLDERS_INFO_BYTES)
  return info === undefined ? '' : untilNul(info.subarray(CURRENT_FOLDER_AT))
}

let argumentsBuffer: Uint8Array | undefined

export function commandOf(pid: number): string {
  if (process.platform === 'linux') {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim()
    } catch {
      return ''
    }
  }
  libSystem ??= openLibSystem()
  argumentsBuffer ??= new Uint8Array(ARGUMENTS_BYTES)
  const size = new BigUint64Array([BigInt(ARGUMENTS_BYTES)])
  if (libSystem.symbols.sysctl(new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]), 3, argumentsBuffer, size, null, 0) !== 0) return ''
  const count = new DataView(argumentsBuffer.buffer).getInt32(0, true)
  const [, ...strings] = decoder.decode(argumentsBuffer.subarray(4, Number(size[0]))).split('\0')
  const first = strings.findIndex((text) => text !== '')
  return first === -1 ? '' : strings.slice(first, first + count).join(' ')
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
  `  else { my $info = "\\0" x ${BSD_INFO_BYTES}; if (syscall(${SYS_PROC_INFO}, ${PROC_INFO_CALL_PIDINFO}, 0 + $$, ${PROC_PIDTBSDINFO}, 0, $info, ${BSD_INFO_BYTES}) == ${BSD_INFO_BYTES}) { my @at = gmtime unpack("Q<", substr($info, ${START_SECONDS_AT}, 8)); $start = sprintf("%s %s %2d %02d:%02d:%02d %d", (qw(${DAYS.join(' ')}))[$at[6]], (qw(${MONTHS.join(' ')}))[$at[4]], $at[3], $at[2], $at[1], $at[0], $at[5] + 1900) } }`,
  '  $ENV{CLAUDE_CODE_RELAUNCH_HOME_TRUST} = "$$:$start" if defined $start && $start ne "";',
  '}',
  'exec { $ARGV[0] } @ARGV or die "$ARGV[0]: $!\\n";',
].join(' ')

export const claudeStart = (argv: readonly string[], trustsHome: boolean): string[] => ['perl', '-e', CLAUDE_START, '--', environmentFile(), trustsHome ? '1' : '', ...argv]

export type Resumed = { readonly model?: string; readonly effort?: string }

export function resumedOf(tail: string): Resumed {
  const last = tail.split('\n').findLast((line) => line.startsWith('{') && line.includes('"type":"assistant"'))
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
