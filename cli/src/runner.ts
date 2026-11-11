import { existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import plugin from '../../.claude-plugin/plugin.json'
import { forgetRun, loginEnvironment, recordAt, startOf, stoppedRuns, writeRun, type RunProcess } from './claude.ts'
import { rootsHere } from './device.ts'
import { followLabels, isShown, killTerminal, labelOwnTerminal, SESSION_LABEL, terminalAt } from './hc.ts'

const STOP_MS = Number(process.env['ANYHOST_STOP_MS'] ?? 8 * 60 * 60_000)
const CHECK_MS = 30_000
const EXIT_MS = 10_000
const READY_MS = 3000
const TIOCSCTTY = process.platform === 'darwin' ? '0x20007461' : '0x540E'
const SESSION_FLAGS = new Set(['--continue', '-c', '--fork-session'])
const SESSION_VALUES = new Set(['--resume', '-r', '--session-id'])
const LEFT_BEHIND = ['CLAUDECODE', 'CLAUDE_PID', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']
const STATUS_REPORT = '\x1b]7501;'

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

export async function closeStopped(): Promise<void> {
  for (const { session, run } of stoppedRuns()) {
    forgetRun(session)
    const address = run.terminal?.address
    const kept = address === undefined ? undefined : await terminalAt(address)
    if (address !== undefined && kept?.isLive === true && kept.labels[SESSION_LABEL] === session) await killTerminal(address)
  }
}

export async function runSession(command: readonly string[], resumed?: string): Promise<number> {
  const login = await loginEnvironment().catch((error: unknown) => {
    console.error(`anyhost could not read your login environment, so Claude Code starts with this terminal's: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  })
  const env = Object.fromEntries(Object.entries({ ...process.env, ...login }).filter(([name]) => !LEFT_BEHIND.includes(name)))
  const { claudeHome } = rootsHere()
  const decoder = new TextDecoder()
  let session = resumed
  let usedAt = Date.now()
  let isReady = false
  let held: Uint8Array[] = []
  const transcript = session === undefined ? undefined : transcriptOf(claudeHome, session)
  const argv = session !== undefined && transcript !== undefined ? resumeCommand(command, session, await resumedOf(transcript)) : [...command]
  const size = (): { cols: number; rows: number } => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 })
  const ready = (): void => {
    if (isReady) return
    isReady = true
    for (const keys of held) terminal.write(keys)
    held = []
  }
  let readyAt: ReturnType<typeof setTimeout> | undefined
  const terminal = new Bun.Terminal({
    ...size(),
    name: process.env['TERM'] || 'xterm-256color',
    data: (_terminal, bytes) => {
      process.stdout.write(bytes)
      if (isReady) return
      if (decoder.decode(bytes).includes(STATUS_REPORT)) return ready()
      readyAt ??= setTimeout(ready, READY_MS)
    },
  })
  const child = Bun.spawn(['perl', '-e', `ioctl(STDIN, ${TIOCSCTTY}, 0) or die "anyhost could not give Claude Code its terminal: $!\\n"; exec { $ARGV[0] } @ARGV or die "$ARGV[0]: $!\\n"`, '--', ...argv], { terminal, env, detached: true })
  const startedAt = new Date().toISOString()

  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', (keys: Buffer) => {
    usedAt = Date.now()
    if (isReady) terminal.write(Uint8Array.from(keys))
    else held.push(Uint8Array.from(keys))
  })
  process.stdout.on('resize', () => {
    const { cols, rows } = size()
    terminal.resize(cols, rows)
  })
  let isSignalled = false
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
    process.on(signal, () => {
      isSignalled = true
      child.kill(signal)
    })
  }
  const runner: RunProcess = { id: process.pid, start: startOf(process.pid) }
  const address = process.env['HC_TERMINAL_ID']
  const own = (id: string): void => {
    writeRun(id, {
      session: id,
      runner: { process: runner, version: plugin.version, startedAt },
      ...(address ? { terminal: { address, machine: hostname() } } : {}),
      claude: { command, process: { id: child.pid, start: startOf(child.pid) }, startedAt },
    })
    void labelOwnTerminal(id).catch((error: unknown) => console.error(`anyhost could not label this terminal with ${id}: ${error instanceof Error ? error.message : String(error)}`))
  }
  const learn = (record: ReturnType<typeof recordAt>): void => {
    if (record?.sessionId === undefined || record.sessionId === session) return
    if (session !== undefined) forgetRun(session)
    session = record.sessionId
    own(session)
  }
  const learning = setInterval(() => {
    learn(recordAt(claudeHome, child.pid))
    if (session !== undefined) clearInterval(learning)
  }, 1000)
  let isOnScreen = false
  const readShown = async (): Promise<void> => {
    isOnScreen = address !== undefined && address !== '' && isShown((await terminalAt(address))?.labels ?? {})
    if (isOnScreen) usedAt = Date.now()
  }
  const stopFollowing = address === undefined || address === '' ? () => undefined : followLabels(address, () => void readShown())
  let isStopping = false
  const check = setInterval(() => {
    void readShown()
    if (isStopping) return
    const record = recordAt(claudeHome, child.pid)
    learn(record)
    if (isOnScreen || (record !== undefined && (record.status !== 'idle' || record.cwd === homedir()))) usedAt = Date.now()
    if (record?.status !== 'idle' || session === undefined || Date.now() - usedAt < STOP_MS) return
    isStopping = true
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), EXIT_MS).unref()
  }, Math.min(CHECK_MS, STOP_MS / 4))
  if (session !== undefined) own(session)
  const code = await child.exited
  terminal.close()
  clearTimeout(readyAt)
  stopFollowing()
  clearInterval(check)
  clearInterval(learning)
  if (session !== undefined && !isSignalled) forgetRun(session)
  return isStopping ? 0 : code
}
