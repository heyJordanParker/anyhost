import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import plugin from '../../.claude-plugin/plugin.json'
import { Database } from 'bun:sqlite'
import { summaryTextOf } from './capture.ts'
import { copiesOutside, forgetRun, lastCommandOf, loginEnvironment, ownRun, recordAt, runTerminalOf, startOf, statusOf, stoppedRuns, type RunProcess } from './claude.ts'
import { rootsHere, stateFolder } from './device.ts'
import { followLabels, hcPath, isShown, labelOwnTerminal, SESSION_LABEL, SLEEP_LABEL, terminalAt, unlabelOwnTerminal, VIEW_LABEL } from './hc.ts'
import type { Placed } from './move.ts'
import { askProgram } from './serve.ts'
import { lastFolderOf, messagesOf, summarize, transcriptOf, UNSUMMARIZED } from './transcript.ts'

const STOP_MS = Number(process.env['ANYHOST_STOP_MS'] ?? 8 * 60 * 60_000)
const CHECK_MS = 30_000
const EXIT_MS = 10_000
const READY_MS = 3000
const FIRST_SIZE_MS = 1000
const TIOCSCTTY = process.platform === 'darwin' ? '0x20007461' : '0x540E'
const SESSION_FLAGS = new Set(['--continue', '-c', '--fork-session'])
const SESSION_VALUES = new Set(['--resume', '-r', '--session-id'])
export const START_CLAUDE = [
  `ioctl(STDIN, ${TIOCSCTTY}, 0) or die "anyhost could not give Claude Code its terminal: $!\\n";`,
  'if (delete $ENV{ANYHOST_HOME_TRUST}) {',
  '  my $start;',
  '  if ($^O eq "linux") { if (open(my $file, "<", "/proc/$$/stat")) { my $stat = <$file>; $start = (split / /, substr($stat, rindex($stat, ")") + 2))[19] } }',
  '  else { local $ENV{TZ} = "UTC"; $start = `ps -o lstart= -p $$` }',
  '  $start =~ s/^\\s+|\\s+$//g if defined $start;',
  '  $ENV{CLAUDE_CODE_RELAUNCH_HOME_TRUST} = "$$:$start" if defined $start && $start ne "";',
  '}',
  'exec { $ARGV[0] } @ARGV or die "$ARGV[0]: $!\\n";',
].join('\n')
const STATUS_REPORT = '\x1b]7501;'
const STATUS_CLEAR = '\x1b]7501;state=clear\x1b\\'

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

export async function forgetStopped(): Promise<void> {
  for (const { session, run } of stoppedRuns()) {
    const address = run.terminal?.address
    const kept = address === undefined || hcPath() === undefined ? undefined : await terminalAt(address).catch(() => 'unknown' as const)
    if (kept === 'unknown') continue
    if (kept?.isLive !== true || kept.labels[SESSION_LABEL] !== session) forgetRun(session)
  }
}

const DIM = '\x1b[2m'
const PLAIN = '\x1b[0m'
const CLEAR = '\x1b[2J\x1b[3J\x1b[H'
const TERMINAL_REPLY = /^(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[\?[\d;]*[cu]|\x1b\[\d+;\d+R|\x1bP[^\x1b]*\x1b\\)+$/

export const isTerminalReply = (text: string): boolean => TERMINAL_REPLY.test(text)

const VIEW_AGAIN_MS = 1000
const MIRROR_MS = 1500
const MIRROR_PLACES_MS = 5000
const KEY_NAMES: Readonly<Record<string, string>> = { '\r': 'enter', '\x1b': 'esc', '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\t': 'tab', '\x7f': 'backspace', '\x03': 'ctrl+c' }

async function lastScreen(claudeHome: string, session: string, note: string): Promise<string> {
  const transcript = transcriptOf(claudeHome, session)
  const text = transcript === undefined ? '' : await summaryTextOf(transcript)
  const [last] = messagesOf(text, 1).filter((message) => message.role === 'assistant')
  const summary = summarize(UNSUMMARIZED, text, 'claude')
  const title = (summary.title || summary.firstPrompt || session.slice(0, 8)).replace(/[\x00-\x1f\x7f]/g, ' ')
  const width = Math.max(20, (process.stdout.columns || 80) - 4)
  const lines = (last?.text ?? '').split('\n').flatMap((line) => line.match(new RegExp(`.{1,${width}}`, 'g')) ?? [''])
  const shown = lines.slice(-Math.max(1, (process.stdout.rows || 24) - 6))
  return `\x1b]2;${title}\x07${CLEAR}${DIM}${shown.map((line) => `  ${line}`).join('\r\n')}${PLAIN}\r\n\r\n  ${DIM}${note}${PLAIN}`
}

const asleepNote = (since: string): string => `asleep since ${new Date(since).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · type to continue`

function holderElsewhere(session: string): string {
  const path = join(stateFolder(), 'anyhost.db')
  if (!existsSync(path)) return ''
  const db = new Database(path, { readonly: true })
  db.run('pragma busy_timeout = 5000')
  try {
    return db.query<{ holder: string }, [string]>('select holder from journals where session = ?').get(session)?.holder ?? ''
  } finally {
    db.close()
  }
}

const ago = (at: string): string => {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000))
  return minutes < 60 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`
}

function keysIn(): { readonly next: () => Promise<string>; readonly stop: () => void } {
  const waiting: ((keys: string) => void)[] = []
  const typed: string[] = []
  const heard = (bytes: Buffer): void => {
    const keys = bytes.toString('utf8')
    const taker = waiting.shift()
    if (taker === undefined) typed.push(keys)
    else taker(keys)
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', heard)
  return {
    next: () => new Promise((resolve) => {
      const keys = typed.shift()
      if (keys === undefined) waiting.push(resolve)
      else resolve(keys)
    }),
    stop: () => void process.stdin.off('data', heard),
  }
}

async function viewOf(claudeHome: string, address: string, session: string): Promise<number> {
  const hc = hcPath()
  const own = process.env['HC_TERMINAL_ID']
  if (hc === undefined) return 1
  if (own) await Bun.spawn([hc, 'label', own, `${VIEW_LABEL}=${session}`], { env: process.env }).exited
  for (let at = address; ; ) {
    const code = await Bun.spawn([hc, 'attach', at], { env: process.env, stdio: ['inherit', 'inherit', 'inherit'] }).exited
    await Bun.sleep(VIEW_AGAIN_MS)
    const running = await runTerminalOf(claudeHome, session)
    if (!isAnotherTerminal(running)) return code
    at = running
  }
}

async function mirrorOf(session: string, machine: string): Promise<number | 'placed'> {
  let line = ''
  let screen = ''
  let status = ''
  let problem = ''
  let isOver = false
  const draw = (): void => {
    const rows = process.stdout.rows || 24
    const shown = screen.split('\n').slice(-(rows - 3))
    const note = problem || `on ${machine}, which the Herdr app does not reach · your keys go there through anyhost · /move ${hostname()} brings it here`
    process.stdout.write(`${CLEAR}${shown.join('\r\n')}\r\n\r\n${DIM}${note}${PLAIN}\r\n› ${line}`)
  }
  const tell = async (told: { readonly text?: string; readonly keys?: readonly string[] }): Promise<void> => {
    try {
      const answer = await askProgram<{ readonly screen: string; readonly status: string }>('/agents/tell', { session, lines: (process.stdout.rows || 24) - 3, text: told.text ?? '', keys: told.keys ?? [] })
      if (answer === undefined) throw new Error('the anyhost program here does not answer')
      ;({ screen, status } = answer)
      problem = ''
    } catch (error) {
      problem = `anyhost could not reach it: ${error instanceof Error ? error.message : String(error)}`
    }
    draw()
  }
  const input = keysIn()
  const resized = (): void => draw()
  process.stdout.on('resize', resized)
  let placedAt = Date.now()
  const polling = (async (): Promise<'placed' | undefined> => {
    while (!isOver) {
      await tell({})
      if (Date.now() - placedAt > MIRROR_PLACES_MS) {
        placedAt = Date.now()
        const placed = await askProgram<{ readonly cwd?: string }>('/agents/place', { session }).catch(() => undefined)
        if (placed?.cwd !== undefined) {
          process.chdir(placed.cwd)
          return 'placed'
        }
      }
      await Bun.sleep(MIRROR_MS)
    }
    return undefined
  })()
  const typing = (async (): Promise<number> => {
    for (;;) {
      const keys = await input.next()
      if (isOver) return 0
      const named = KEY_NAMES[keys]
      if (keys === '\r') {
        if (line === '') await tell({ keys: ['enter'] })
        else await tell({ text: line })
        line = ''
      } else if (keys === '\x7f' && line !== '') line = line.slice(0, -1)
      else if (named !== undefined) await tell({ keys: [named] })
      else if (status === 'waiting') await tell({ keys: [...keys] })
      else line += keys.replace(/[\x00-\x1f]/g, '')
      draw()
    }
  })()
  const ended = await Promise.race([polling.then((placed) => placed ?? 0), typing])
  isOver = true
  input.stop()
  process.stdout.off('resize', resized)
  return ended
}

const isAnotherTerminal = (running: string | undefined): running is string => running !== undefined && running !== (process.env['HC_TERMINAL_ID'] ?? '')

async function placeFirst(claudeHome: string, session: string, isAsked = false): Promise<number | 'run'> {
  const running = await runTerminalOf(claudeHome, session)
  if (isAnotherTerminal(running)) return await viewOf(claudeHome, running, session)
  const elsewhere = running === undefined ? await statusOf(claudeHome, session) : undefined
  if (elsewhere === 'working' || elsewhere === 'waiting' || (isAsked && elsewhere === 'idle')) {
    const input = keysIn()
    process.stdout.write(await lastScreen(claudeHome, session, elsewhere === 'idle' ? 'idle in another terminal here · Enter moves it here · any other key leaves it there' : `${elsewhere === 'working' ? 'working' : 'waiting for you'} in another terminal here · Enter moves it here once its turn ends · any other key leaves it there`))
    const keys = await input.next()
    input.stop()
    if (keys !== '\r') return 0
  }
  let take = false
  for (;;) {
    let isPlacing = true
    const drawElsewhere = async (): Promise<void> => {
      const status = running === undefined ? await statusOf(claudeHome, session) : undefined
      if (status === undefined) return
      const screen = await lastScreen(claudeHome, session, status === 'idle' ? 'moving here from another terminal' : `${status === 'working' ? 'working' : 'waiting for you'} in another terminal here · continues here once its turn ends`)
      if (isPlacing) process.stdout.write(screen)
    }
    const waiting = setInterval(() => void drawElsewhere(), 2000)
    await drawElsewhere()
    const placed = await askProgram<Placed>('/agents/place', { session, take }).then(
      (answer) => answer ?? (holderElsewhere(session) === '' ? ('none' as const) : { failed: `${holderElsewhere(session)} holds it, and the anyhost program here does not answer to take it` }),
      (error: unknown) => ({ failed: error instanceof Error ? error.message : String(error) }),
    )
    clearInterval(waiting)
    isPlacing = false
    if (placed === 'none') {
      const transcript = transcriptOf(claudeHome, session)
      const folder = transcript === undefined ? '' : await lastFolderOf(transcript)
      if (folder !== '' && existsSync(folder)) process.chdir(folder)
      return 'run'
    }
    if ('cwd' in placed) {
      process.chdir(placed.cwd)
      return 'run'
    }
    const input = keysIn()
    if ('failed' in placed) {
      process.stdout.write(await lastScreen(claudeHome, session, `anyhost could not open it: ${placed.failed} · press a key to close`))
      await input.next()
      input.stop()
      return 1
    }
    if (placed.connected) {
      input.stop()
      const mirrored = await mirrorOf(session, placed.heldBy)
      if (mirrored === 'placed') return 'run'
      return mirrored
    }
    const offline = placed.seenAt === '' ? `${placed.heldBy} holds it and is offline` : `${placed.heldBy} has been offline for ${ago(placed.seenAt)}`
    process.stdout.write(await lastScreen(claudeHome, session, `${offline} · Enter continues it here from its last backup`))
    const keys = await input.next()
    input.stop()
    if (keys !== '\r') return 0
    take = true
  }
}

export async function runSession(given: readonly string[], resumed?: string, asksToSleep = false): Promise<number> {
  const bornAt = Date.now()
  const { claudeHome } = rootsHere()
  const runsOutside = resumed !== undefined && asksToSleep && (await runTerminalOf(claudeHome, resumed)) === undefined && (await statusOf(claudeHome, resumed)) !== undefined
  const startsAsleep = asksToSleep && !runsOutside
  const runsNothing = async (code: number): Promise<number> => {
    await unlabelOwnTerminal().catch(() => undefined)
    return code
  }
  if (resumed !== undefined && startsAsleep) {
    const running = await runTerminalOf(claudeHome, resumed)
    if (isAnotherTerminal(running)) return await runsNothing(await viewOf(claudeHome, running, resumed))
  }
  if (resumed !== undefined && !startsAsleep) {
    const placed = await placeFirst(claudeHome, resumed, runsOutside)
    if (placed !== 'run') return await runsNothing(placed)
  }
  const command = given.length > 0 ? given : ((resumed === undefined ? undefined : lastCommandOf(resumed)) ?? ['claude'])
  const login = await loginEnvironment().catch((error: unknown) => {
    console.error(`anyhost could not read your login environment, so Claude Code starts with this terminal's: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  })
  const env = { ...process.env, ...login }
  const decoder = new TextDecoder()
  let session = resumed
  let usedAt = Date.now()
  let isReady = false
  let held: Uint8Array[] = []
  let terminal: Bun.Terminal | undefined
  let child: ReturnType<typeof Bun.spawn> | undefined
  let asleepSince: string | undefined
  let wake: (() => void) | undefined
  const size = (): { cols: number; rows: number } => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 })
  const ready = (): void => {
    if (isReady || terminal === undefined) return
    isReady = true
    for (const keys of held) terminal.write(keys)
    held = []
  }
  const drawAsleep = async (): Promise<void> => {
    if (session === undefined || asleepSince === undefined) return
    const screen = await lastScreen(claudeHome, session, asleepNote(asleepSince))
    if (asleepSince !== undefined && child === undefined) process.stdout.write(screen)
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', (keys: Buffer) => {
    if (isTerminalReply(decoder.decode(keys))) {
      terminal?.write(Uint8Array.from(keys))
      return
    }
    usedAt = Date.now()
    if (isReady && terminal !== undefined) terminal.write(Uint8Array.from(keys))
    else held.push(Uint8Array.from(keys))
    wake?.()
  })
  let isSized = false
  let onSized: (() => void) | undefined
  process.stdout.on('resize', () => {
    isSized = true
    onSized?.()
    const { cols, rows } = size()
    terminal?.resize(cols, rows)
    if (child === undefined) void drawAsleep()
  })
  let isSignalled = false
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
    process.on(signal, () => {
      isSignalled = true
      child?.kill(signal)
      wake?.()
    })
  }
  const runner: RunProcess = { id: process.pid, start: startOf(process.pid) }
  const address = process.env['HC_TERMINAL_ID']
  const startedAt = new Date().toISOString()
  const own = (id: string): void => {
    ownRun(id, { process: runner, version: plugin.version, startedAt }, { command, ...(child === undefined ? {} : { pid: child.pid, startedAt }) }, asleepSince)
    void labelOwnTerminal(id).catch((error: unknown) => console.error(`anyhost could not label this terminal with ${id}: ${error instanceof Error ? error.message : String(error)}`))
  }
  let isOnScreen = false
  let isNewlyShown = false
  let sleepAskedAt = 0
  let onSleepAsked: (() => void) | undefined
  const readShown = async (): Promise<void> => {
    const labels = address !== undefined && address !== '' ? ((await terminalAt(address).catch(() => undefined))?.labels ?? {}) : {}
    const asked = Number(labels[SLEEP_LABEL] ?? 0)
    if (asked > sleepAskedAt) {
      sleepAskedAt = asked
      onSleepAsked?.()
    }
    const was = isOnScreen
    isOnScreen = isShown(labels)
    if (!isOnScreen) return
    usedAt = Date.now()
    if (was || child !== undefined) return
    isNewlyShown = true
    wake?.()
  }
  const stopFollowing = address === undefined || address === '' ? () => undefined : followLabels(address, () => void readShown())
  void readShown()
  if (startsAsleep && session !== undefined) asleepSince = new Date().toISOString()

  for (;;) {
    const sleptSince = asleepSince
    if (asleepSince !== undefined && session !== undefined) {
      own(session)
      held = []
      await drawAsleep()
      for (;;) {
        await new Promise<void>((resolve) => {
          wake = resolve
          if (isSignalled || held.length > 0 || isNewlyShown) resolve()
        })
        wake = undefined
        isNewlyShown = false
        if (isSignalled) {
          stopFollowing()
          return 0
        }
        const typed = held
        const placed = await placeFirst(claudeHome, session)
        held = placed === 'run' ? typed : []
        if (placed === 'run') break
        await drawAsleep()
      }
      asleepSince = undefined
      process.stdout.write(CLEAR)
    }
    const sizeDue = bornAt + FIRST_SIZE_MS - Date.now()
    if (!isSized && sizeDue > 0) {
      await new Promise<void>((resolve) => {
        onSized = resolve
        setTimeout(resolve, sizeDue)
      })
      onSized = undefined
    }
    isReady = false
    let readyAt: ReturnType<typeof setTimeout> | undefined
    const transcript = session === undefined ? undefined : transcriptOf(claudeHome, session)
    const argv = session !== undefined && transcript !== undefined ? resumeCommand(command, session, await resumedOf(transcript)) : [...command]
    const [copy] = session === undefined ? [] : await copiesOutside(claudeHome, session, new Set([process.pid]))
    if (session !== undefined && copy !== undefined) {
      process.stdout.write(await lastScreen(claudeHome, session, `running in another terminal here (process ${copy}) · close it there, or open it here from the sidebar once it is idle`))
      held = []
      await new Promise<void>((resolve) => {
        wake = () => {
          if (isSignalled || held.length > 0) resolve()
        }
      })
      wake = undefined
      held = []
      isNewlyShown = false
      if (isSignalled || sleptSince === undefined) {
        stopFollowing()
        if (!isSignalled) await unlabelOwnTerminal().catch(() => undefined)
        return 0
      }
      asleepSince = sleptSince
      continue
    }
    const running = new Bun.Terminal({
      ...size(),
      name: process.env['TERM'] || 'xterm-256color',
      data: (_terminal, bytes) => {
        process.stdout.write(bytes)
        if (isReady) return
        if (decoder.decode(bytes).includes(STATUS_REPORT)) return ready()
        readyAt ??= setTimeout(ready, READY_MS)
      },
    })
    terminal = running
    const claude = Bun.spawn(['perl', '-e', START_CLAUDE, '--', ...argv], { terminal: running, env: transcript === undefined ? env : { ...env, ANYHOST_HOME_TRUST: '1' }, detached: true })
    child = claude
    usedAt = Date.now()
    isNewlyShown = false
    const learn = (record: ReturnType<typeof recordAt>): void => {
      if (record?.sessionId === undefined || record.sessionId === session) return
      if (session !== undefined) forgetRun(session)
      session = record.sessionId
      own(session)
    }
    const learning = setInterval(() => {
      learn(recordAt(claudeHome, claude.pid))
      if (session !== undefined) clearInterval(learning)
    }, 1000)
    let isStopping = false
    let isChecking = false
    const startedAt = Date.now()
    const sleep = (): void => {
      const record = recordAt(claudeHome, claude.pid)
      learn(record)
      if (isStopping || session === undefined || record?.status !== 'idle') return
      isStopping = true
      claude.kill('SIGTERM')
      setTimeout(() => claude.kill('SIGKILL'), EXIT_MS).unref()
    }
    onSleepAsked = () => {
      if (sleepAskedAt > startedAt) sleep()
    }
    const check = setInterval(() => {
      if (isStopping || isChecking) return
      isChecking = true
      void readShown()
        .then(() => {
          const record = recordAt(claudeHome, claude.pid)
          learn(record)
          if (isOnScreen || (record !== undefined && record.status !== 'idle')) usedAt = Date.now()
          if (Date.now() - usedAt >= STOP_MS || sleepAskedAt > startedAt) sleep()
        })
        .finally(() => (isChecking = false))
    }, Math.min(CHECK_MS, STOP_MS / 4))
    if (session !== undefined) own(session)
    const code = await claude.exited
    running.close()
    terminal = undefined
    child = undefined
    onSleepAsked = undefined
    clearTimeout(readyAt)
    clearInterval(check)
    clearInterval(learning)
    if (isStopping && !isSignalled && session !== undefined) {
      process.stdout.write(STATUS_CLEAR)
      asleepSince = new Date().toISOString()
      continue
    }
    stopFollowing()
    if (session !== undefined && !isSignalled) forgetRun(session)
    if (!isSignalled) await unlabelOwnTerminal().catch(() => undefined)
    return isStopping ? 0 : code
  }
}
