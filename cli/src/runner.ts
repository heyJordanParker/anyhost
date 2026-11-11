import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { forgetRun, recordAt, startOf, stoppedRuns, writeRun } from './claude.ts'
import { rootsHere } from './device.ts'
import { followLabels, isShown, killTerminal, labelOwnTerminal, openTerminal, SESSION_LABEL, terminalAt } from './hc.ts'

const SLEEP_MS = Number(process.env['ANYHOST_SLEEP_MS'] ?? 15 * 60_000)
const CHECK_MS = 30_000
const EXIT_MS = 10_000
const READY_MS = 3000
const TIOCSCTTY = process.platform === 'darwin' ? '0x20007461' : '0x540E'
const SESSION_FLAGS = new Set(['--continue', '-c', '--fork-session'])
const SESSION_VALUES = new Set(['--resume', '-r', '--session-id'])
const LEFT_BEHIND = ['CLAUDECODE', 'CLAUDE_PID', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']
const STATUS_REPORT = '\x1b]7501;'
const FOCUS_REPORTS_ON = '\x1b[?1004h'
const FOCUSED = '\x1b[I'
const BLURRED = '\x1b[O'
const RESET = '\x1bc'

type Awake = { readonly child: Bun.Subprocess; readonly terminal: Bun.Terminal; isReady: boolean; held: Uint8Array[]; readyAt?: ReturnType<typeof setTimeout> }

const transcriptOf = (claudeHome: string, session: string): string | undefined => {
  if (!existsSync(join(claudeHome, 'projects'))) return undefined
  const found = new Bun.Glob(`*/${session}.jsonl`).scanSync({ cwd: join(claudeHome, 'projects'), onlyFiles: true }).next()
  return found.done === true ? undefined : join(claudeHome, 'projects', found.value)
}

export type Resumed = { readonly firstMessage?: string; readonly model?: string; readonly effort?: string }
const EDGE_BYTES = 1 << 20
async function resumedOf(transcript: string): Promise<Resumed> {
  const file = Bun.file(transcript)
  let firstMessage: string | undefined
  for (const line of (await file.slice(0, EDGE_BYTES).text()).split('\n')) {
    if (!line.includes('"type":"user"')) continue
    const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content
    if (typeof content === 'string') firstMessage = content
    break
  }
  const last = (await file.slice(Math.max(0, file.size - EDGE_BYTES)).text()).split('\n').findLast((line) => line.startsWith('{') && line.includes('"type":"assistant"'))
  const turn = last === undefined ? undefined : (JSON.parse(last) as { message?: { model?: string }; effort?: string })
  const model = turn?.message?.model?.startsWith('<') === false ? turn.message.model : undefined
  return { ...(firstMessage === undefined ? {} : { firstMessage }), ...(model === undefined ? {} : { model }), ...(turn?.effort === undefined ? {} : { effort: turn.effort }) }
}

export function resumeCommand(command: readonly string[], session: string, resumed: Resumed): string[] {
  if (command.length > 1 && resumed.firstMessage !== undefined && command.at(-1) === resumed.firstMessage) command = command.slice(0, -1)
  const replaced = new Set([...(resumed.model === undefined ? [] : ['--model']), ...(resumed.effort === undefined ? [] : ['--effort'])])
  const kept: string[] = []
  for (let at = 0; at < command.length; at++) {
    const arg = command[at] ?? ''
    if (SESSION_FLAGS.has(arg) || /^--(resume|session-id)=/.test(arg) || [...replaced].some((flag) => arg.startsWith(`${flag}=`))) continue
    if (replaced.has(arg)) {
      at++
      continue
    }
    if (SESSION_VALUES.has(arg)) {
      if (!(command[at + 1] ?? '-').startsWith('-')) at++
      continue
    }
    kept.push(arg)
  }
  return [...kept, ...(resumed.model === undefined ? [] : ['--model', resumed.model]), ...(resumed.effort === undefined ? [] : ['--effort', resumed.effort]), '--resume', session]
}

export async function reopenStopped(): Promise<void> {
  for (const { session, run } of stoppedRuns()) {
    forgetRun(session)
    const kept = run.terminal === undefined ? undefined : await terminalAt(run.terminal)
    if (run.terminal === undefined || kept === undefined || !kept.isLive || kept.labels[SESSION_LABEL] !== session) continue
    await killTerminal(run.terminal)
    await openTerminal(kept.cwd, session, run.command, { isResumed: true, isResting: true, place: kept.labels })
  }
}

export async function runSession(command: readonly string[], resumed?: string, isResting = false): Promise<number> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !LEFT_BEHIND.includes(name)))
  const { claudeHome } = rootsHere()
  const decoder = new TextDecoder()
  let session = resumed
  let awake: Awake | undefined
  let usedAt = Date.now()
  let sleeping: Promise<void> | undefined
  const exited = Promise.withResolvers<number>()
  const size = (): { cols: number; rows: number } => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 })

  const ready = (woken: Awake): void => {
    if (woken.isReady) return
    clearTimeout(woken.readyAt)
    woken.isReady = true
    for (const keys of woken.held) woken.terminal.write(keys)
    woken.held = []
  }
  const type = (woken: Awake, keys: Uint8Array): void => {
    if (woken.isReady) woken.terminal.write(keys)
    else woken.held.push(keys)
  }

  let resumable: Resumed | undefined
  const readResumable = async (): Promise<void> => {
    const transcript = session === undefined ? undefined : transcriptOf(claudeHome, session)
    resumable = transcript === undefined ? undefined : await resumedOf(transcript)
  }

  const wake = (): Awake => {
    process.stdout.write(RESET)
    const argv = session !== undefined && resumable !== undefined ? resumeCommand(command, session, resumable) : [...command]
    const terminal = new Bun.Terminal({
      ...size(),
      name: process.env['TERM'] || 'xterm-256color',
      data: (_terminal, bytes) => {
        if (awake !== woken) return
        process.stdout.write(bytes)
        if (woken.isReady) return
        if (decoder.decode(bytes).includes(STATUS_REPORT)) return ready(woken)
        woken.readyAt ??= setTimeout(() => ready(woken), READY_MS)
      },
    })
    const child = Bun.spawn(['perl', '-e', `ioctl(STDIN, ${TIOCSCTTY}, 0) or die "anyhost could not give Claude Code its terminal: $!\\n"; exec { $ARGV[0] } @ARGV or die "$ARGV[0]: $!\\n"`, '--', ...argv], { terminal, env, detached: true })
    const woken: Awake = { child, terminal, isReady: false, held: [] }
    void child.exited.then((code) => {
      terminal.close()
      if (awake === woken) exited.resolve(code)
    })
    usedAt = Date.now()
    return woken
  }

  const sleep = async (going: Awake): Promise<void> => {
    awake = undefined
    going.child.kill('SIGTERM')
    const timer = setTimeout(() => going.child.kill('SIGKILL'), EXIT_MS)
    await going.child.exited
    clearTimeout(timer)
    await readResumable()
    process.stdout.write(FOCUS_REPORTS_ON)
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', (keys: Buffer) => {
    usedAt = Date.now()
    if (awake !== undefined) return type(awake, Uint8Array.from(keys))
    const text = keys.toString('latin1')
    const typed = Buffer.from(text.replaceAll(FOCUSED, '').replaceAll(BLURRED, ''), 'latin1')
    if (typed.length === 0 && !text.includes(FOCUSED)) return
    void (sleeping ?? Promise.resolve()).then(() => {
      awake ??= wake()
      if (typed.length > 0) type(awake, Uint8Array.from(typed))
    })
  })
  process.stdout.on('resize', () => {
    if (awake === undefined) return
    const { cols, rows } = size()
    awake.terminal.resize(cols, rows)
  })
  let isSignalled = false
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
    process.on(signal, () => {
      isSignalled = true
      if (awake === undefined) return exited.resolve(0)
      awake.child.kill(signal)
    })
  }
  const procStart = startOf(process.pid)
  const terminal = process.env['HC_TERMINAL_ID']
  const own = (id: string): void => {
    writeRun(id, { pid: process.pid, procStart, ...(terminal ? { terminal } : {}), command })
    void labelOwnTerminal(id).catch((error: unknown) => console.error(`anyhost could not label this terminal with ${id}: ${error instanceof Error ? error.message : String(error)}`))
  }
  const learn = (record: ReturnType<typeof recordAt>): void => {
    if (record?.sessionId === undefined || record.sessionId === session) return
    if (session !== undefined) forgetRun(session)
    session = record.sessionId
    own(session)
  }
  const learning = setInterval(() => {
    if (awake !== undefined) learn(recordAt(claudeHome, awake.child.pid))
    if (session !== undefined) clearInterval(learning)
  }, 1000)
  let isOnScreen = false
  const readShown = async (): Promise<void> => {
    isOnScreen = terminal !== undefined && terminal !== '' && isShown((await terminalAt(terminal))?.labels ?? {})
    if (!isOnScreen) return
    usedAt = Date.now()
    if (awake === undefined) void (sleeping ?? Promise.resolve()).then(() => (awake ??= wake()))
  }
  const stopFollowing = terminal === undefined || terminal === '' ? () => undefined : followLabels(terminal, () => void readShown())
  const check = setInterval(() => {
    void readShown()
    if (awake === undefined || sleeping !== undefined) return
    if (isOnScreen) usedAt = Date.now()
    const record = recordAt(claudeHome, awake.child.pid)
    learn(record)
    if (record !== undefined && (record.status !== 'idle' || record.cwd === homedir())) usedAt = Date.now()
    if (record?.status !== 'idle' || session === undefined || Date.now() - usedAt < SLEEP_MS) return
    sleeping = sleep(awake).finally(() => (sleeping = undefined))
  }, Math.min(CHECK_MS, SLEEP_MS / 4))
  if (session !== undefined) own(session)
  await readResumable()
  if (isResting) process.stdout.write(FOCUS_REPORTS_ON)
  else awake = wake()
  const code = await exited.promise
  stopFollowing()
  clearInterval(check)
  clearInterval(learning)
  if (session !== undefined && !isSignalled) forgetRun(session)
  return code
}
