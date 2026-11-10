import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { forgetRun, recordAt, startOf, writeRun } from './claude.ts'
import { rootsHere } from './device.ts'
import { labelOwnTerminal } from './hc.ts'

const SLEEP_MS = Number(process.env['ANYHOST_SLEEP_MS'] ?? 15 * 60_000)
const CHECK_MS = 30_000
const EXIT_MS = 10_000
const READY_MS = 3000
const TIOCSCTTY = process.platform === 'darwin' ? '0x20007461' : '0x540E'
const SESSION_FLAGS = new Set(['--continue', '-c', '--fork-session'])
const SESSION_VALUES = new Set(['--resume', '-r', '--session-id'])
const LEFT_BEHIND = ['CLAUDECODE', 'CLAUDE_PID', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']
const STATUS_REPORT = '\x1b]7501;'

type Awake = { readonly child: Bun.Subprocess; readonly terminal: Bun.Terminal; isReady: boolean; held: Uint8Array[]; readyAt?: ReturnType<typeof setTimeout> }

// Claude Code resumes only a session that wrote its transcript, which it does at the first message.
const hasTranscript = (claudeHome: string, session: string): boolean => existsSync(join(claudeHome, 'projects')) && new Bun.Glob(`*/${session}.jsonl`).scanSync({ cwd: join(claudeHome, 'projects'), onlyFiles: true }).next().done !== true

export function withoutSession(command: readonly string[]): string[] {
  const kept: string[] = []
  for (let at = 0; at < command.length; at++) {
    const arg = command[at] ?? ''
    if (SESSION_FLAGS.has(arg) || /^--(resume|session-id)=/.test(arg)) continue
    if (SESSION_VALUES.has(arg)) {
      if (!(command[at + 1] ?? '-').startsWith('-')) at++
      continue
    }
    kept.push(arg)
  }
  return kept
}

export async function runSession(command: readonly string[], resumed?: string): Promise<number> {
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

  const wake = (): Awake => {
    const argv = session !== undefined && hasTranscript(claudeHome, session) ?[...withoutSession(command), '--resume', session] : [...command]
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
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', (keys: Buffer) => {
    usedAt = Date.now()
    const typed = Uint8Array.from(keys)
    if (awake !== undefined) return type(awake, typed)
    void (sleeping ?? Promise.resolve()).then(() => type((awake ??= wake()), typed))
  })
  process.on('SIGWINCH', () => {
    if (awake === undefined) return
    const { cols, rows } = size()
    awake.terminal.resize(cols, rows)
    awake.child.kill('SIGWINCH')
  })
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
    process.on(signal, () => {
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
  const check = setInterval(() => {
    if (awake === undefined || sleeping !== undefined) return
    const record = recordAt(claudeHome, awake.child.pid)
    if (record?.sessionId !== undefined && record.sessionId !== session) {
      if (session !== undefined) forgetRun(session)
      session = record.sessionId
      own(session)
    }
    // a turn Claude Code starts on its own, as a /loop's next run, counts as a key does
    if (record !== undefined && record.status !== 'idle') usedAt = Date.now()
    if (record?.status !== 'idle' || session === undefined || Date.now() - usedAt < SLEEP_MS) return
    sleeping = sleep(awake).finally(() => (sleeping = undefined))
  }, Math.min(CHECK_MS, SLEEP_MS / 4))
  if (session !== undefined) own(session)
  awake = wake()
  const code = await exited.promise
  clearInterval(check)
  if (session !== undefined) forgetRun(session)
  return code
}
