import { expect, onTestFinished, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { installHerdr } from '../src/herdr.ts'
import { startOf } from '../src/claude.ts'
import { forgetStopped, isTerminalReply, resumeCommand, START_CLAUDE } from '../src/runner.ts'
import { askProgram, serveSocket } from '../src/serve.ts'
import { until } from './memory.ts'
import { CLI, fakeHc, script, SESSION, spawnForTest, temporaryFolder } from './program.ts'

test("a resumed session carries the home folder's trust as Claude Code carries it into a copy it relaunches: its own pid and start", async () => {
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 120, rows: 24, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  const child = spawnForTest(['perl', '-e', START_CLAUDE, '--', 'sh', '-c', 'echo "trust=$CLAUDE_CODE_RELAUNCH_HOME_TRUST;"; sleep 10'], { terminal, env: { ...process.env, ANYHOST_HOME_TRUST: '1' } })

  await until(() => shown.includes(';'), 'the started program printing its environment')
  expect(shown).toContain(`trust=${child.pid}:${startOf(child.pid)};`)
})

test('a reopened session runs the command it started with, with every session flag of it replaced by --resume of the session', () => {
  expect(resumeCommand(['claude', '--model', 'opus', '--resume', 'old', '-c', '--fork-session', '--session-id=x', '--dangerously-skip-permissions'], 'new', {})).toEqual(['claude', '--model', 'opus', '--dangerously-skip-permissions', '--resume', 'new'])
  expect(resumeCommand(['claude', '-r', '--model', 'opus'], 'new', {})).toEqual(['claude', '--model', 'opus', '--resume', 'new'])
})

test('a reopened session drops the first message the Herdr app gave its command, which the conversation holds already', () => {
  expect(resumeCommand(['claude', '--model', 'haiku', 'fix'], 'new', { firstMessage: 'fix' })).toEqual(['claude', '--model', 'haiku', '--resume', 'new'])
  expect(resumeCommand(['claude', '--model', 'haiku'], 'new', { firstMessage: 'fix the login' })).toEqual(['claude', '--model', 'haiku', '--resume', 'new'])
})

test('a reopened session runs on the model and effort its last turn ran with', () => {
  expect(resumeCommand(['claude', '--model', 'opus', '--effort=high', '--verbose'], 'new', { model: 'claude-haiku-5-5', effort: 'medium' })).toEqual(['claude', '--verbose', '--model', 'claude-haiku-5-5', '--effort', 'medium', '--resume', 'new'])
})

test("the Herdr app's Claude Code runs under the runner where cmod links anyhost, once, and as it was once anyhost is gone", async () => {
  const home = temporaryFolder()
  const herdr = join(home, '.config', 'herdr-app')
  mkdirSync(herdr, { recursive: true })
  writeFileSync(join(herdr, 'programs.json'), JSON.stringify({ programs: { claude: { name: 'Claude', run: ['claude', '--model', 'opus'] } } }))

  await installHerdr(herdr)
  await installHerdr(herdr)

  const { programs } = JSON.parse(readFileSync(join(herdr, 'programs.json'), 'utf8')) as { programs: { claude: { name: string; run: string[] } } }
  expect(programs.claude.name).toBe('Claude')
  expect(programs.claude.run.slice(3)).toEqual(['anyhost', 'claude', '--model', 'opus'])
  expect(existsSync(join(herdr, 'mods', 'anyhost', 'main.js'))).toBe(true)
  const bin = join(home, 'bin')
  script(join(bin, 'claude'), '#!/bin/sh\necho "claude $*"\n')
  const ran = Bun.spawnSync(programs.claude.run, { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } })
  expect(ran.stdout.toString()).toBe('claude --model opus\n')
  script(join(home, '.local', 'share', 'cmod', 'programs', 'anyhost'), '#!/bin/sh\necho "anyhost $*"\n')
  expect(Bun.spawnSync(programs.claude.run, { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } }).stdout.toString()).toBe('anyhost run -- claude --model opus\n')
})

test("the Herdr app's sidebar shows the inbox over the projects, split by a divider the person drags, and the rest of its layout as the app ships it", async () => {
  const herdr = join(temporaryFolder(), 'herdr-app')
  mkdirSync(join(herdr, 'layouts'), { recursive: true })
  const lists = { id: 'sidebar-lists', type: 'column', children: [{ id: 'spaces', type: 'block', content: { mod: 'spaces' } }, { id: 'agents', type: 'block', content: { mod: 'agents' } }] }
  const tab = { id: 'main', type: 'block', min: 200, content: { tab: 'active' } }
  const main = { id: 'root', type: 'row', children: [{ id: 'sidebar', type: 'column', children: [{ id: 'brand', type: 'block' }, lists] }, { id: 'work', type: 'column', children: [{ id: 'tabs', type: 'block', size: { px: 30 }, content: { mod: 'tabs' } }, tab] }] }
  writeFileSync(join(herdr, 'layouts', 'main.json'), JSON.stringify(main))

  await installHerdr(herdr)

  const written = JSON.parse(readFileSync(join(herdr, 'layouts', 'anyhost.json'), 'utf8')) as { children: Record<string, unknown>[] & { children?: unknown[] }[] }
  expect(written.children[0]?.children?.[1]).toEqual({
    id: 'sidebar-lists',
    type: 'column',
    children: [
      { id: 'spaces', type: 'block', size: { weight: 1 }, min: 136, content: { mod: 'anyhost', props: { view: 'projects' } } },
      { id: 'agents', type: 'block', size: { weight: 2 }, min: 120, content: { mod: 'anyhost' } },
    ],
  })
  expect(written.children[1]).toEqual({
    id: 'work',
    type: 'column',
    children: [
      { id: 'tabs', type: 'block', size: { px: 30 }, content: { mod: 'anyhost', props: { view: 'tabs' } } },
      {
        id: 'views',
        type: 'stack',
        active: 'main',
        min: 200,
        children: [
          { id: 'main', type: 'block', content: { tab: 'active' } },
          { id: 'tiles', type: 'row', children: [] },
          { id: 'board', type: 'block', content: { mod: 'anyhost', props: { view: 'board' } } },
        ],
      },
    ],
  })
})

test("in the anyhost layout the person's picker key opens the palette, the tab and pane keys act on the workspace in its view, the pane keys' modifier with enter, m, =, -, comma and period promote, cycle the view, size the master and scroll, and every other key stays the person's", async () => {
  const herdr = join(temporaryFolder(), 'herdr-app')
  mkdirSync(herdr, { recursive: true })
  const global = {
    'cmd-p': 'mod.open:picker',
    'cmd-t': 'tab.new',
    'ctrl-shift-t': 'tab.new',
    'cmd-w': 'tab.close',
    'ctrl-tab': 'tab.next',
    'ctrl-shift-tab': 'tab.prev',
    'cmd-shift-enter': 'pane.zoom',
    'cmd-alt-left': 'pane.go:left',
    'cmd-alt-right': 'pane.go:right',
    'cmd-alt-up': 'pane.go:up',
    'cmd-alt-down': 'pane.go:down',
    'cmd-alt-shift-left': 'pane.swap:left',
    'cmd-alt-shift-right': 'pane.swap:right',
    'cmd-d': 'pane.split:right',
  }
  writeFileSync(join(herdr, 'keys.json'), JSON.stringify({ global, terminal: { 'cmd-c': 'terminal.copy' } }))

  await installHerdr(herdr)
  await installHerdr(herdr)

  expect(JSON.parse(readFileSync(join(herdr, 'keys.json'), 'utf8'))).toEqual({
    global,
    terminal: { 'cmd-c': 'terminal.copy' },
    'layout:anyhost': {
      'cmd-p': 'anyhost.palette',
      'cmd-w': 'anyhost.close',
      'cmd-shift-t': 'anyhost.reopen',
      'ctrl-shift-alt-t': 'anyhost.reopen',
      'ctrl-tab': 'anyhost.next',
      'ctrl-shift-tab': 'anyhost.prev',
      'cmd-shift-enter': 'anyhost.zoom',
      'cmd-alt-left': 'anyhost.go-left',
      'cmd-alt-right': 'anyhost.go-right',
      'cmd-alt-up': 'anyhost.go-up',
      'cmd-alt-down': 'anyhost.go-down',
      'cmd-alt-shift-left': 'anyhost.move-left',
      'cmd-alt-shift-right': 'anyhost.move-right',
      'cmd-alt-enter': 'anyhost.promote',
      'cmd-alt-m': 'anyhost.mode',
      'cmd-alt-=': 'anyhost.grow',
      'cmd-alt--': 'anyhost.shrink',
      'cmd-alt-,': 'anyhost.scroll-left',
      'cmd-alt-.': 'anyhost.scroll-right',
    },
  })
})

test('no keys file is written where the Herdr app has not made one, so it still installs its own', async () => {
  const herdr = join(temporaryFolder(), 'herdr-app')
  mkdirSync(herdr, { recursive: true })

  await installHerdr(herdr)

  expect(existsSync(join(herdr, 'keys.json'))).toBe(false)
})

const fakeClaude = (folder: string): string =>
  script(
    join(folder, 'claude'),
    `#!/bin/bash
record="$CLAUDE_CONFIG_DIR/sessions/$$.json"
printf '{"pid":%s,"sessionId":"${SESSION}","kind":"interactive","cwd":"%s","status":"idle"}' $$ "$PWD" > "$record"
trap 'rm -f "$record"; exit 0' TERM
trap 'echo "size $(stty size)"' WINCH
printf 'started %s with %s\\033]7501;state=idle:app=claude-code\\033\\\\\\n' "$*" "$ANYHOST_PROBE"
while IFS= read -r line; do echo "typed $line"; done <&0 &
reader=$!
while kill -0 $reader 2>/dev/null; do wait $reader; done
`,
  )

const machine = (stopMs?: number, extra: Record<string, string> = {}) => {
  const folder = realpathSync(temporaryFolder())
  const claudeHome = join(folder, '.claude')
  mkdirSync(join(claudeHome, 'sessions'), { recursive: true })
  const state = join(folder, 'state')
  mkdirSync(join(state, 'anyhost'), { recursive: true })
  writeFileSync(join(state, 'anyhost', 'environment.json'), JSON.stringify({ changedAt: 0, environment: { ANYHOST_PROBE: 'the login environment' } }))
  const env = { PATH: process.env['PATH'] ?? '', HOME: folder, CLAUDE_CONFIG_DIR: claudeHome, XDG_STATE_HOME: state, ...(stopMs === undefined ? {} : { ANYHOST_STOP_MS: String(stopMs) }), ...extra }
  const records = (): string[] => readdirSync(join(claudeHome, 'sessions'))
  return { folder, claudeHome, env, records, claude: fakeClaude(folder), runs: join(state, 'anyhost', 'runs', `${SESSION}.json`) }
}

test("a start keeps the run of a stopped runner while herdr-core cannot answer for its terminal, as after a reboot, and forgets it once herdr-core says the terminal is gone", async () => {
  const { folder, env, runs } = machine()
  script(join(folder, 'bin', 'hc'), fakeHc(folder))
  mkdirSync(join(runs, '..'), { recursive: true })
  writeFileSync(runs, JSON.stringify({ session: SESSION, runner: { process: { id: 999_999, start: 'gone' }, version: '', startedAt: '' }, terminal: { address: 't9', machine: '' }, claude: { command: ['claude'] } }))
  writeFileSync(join(folder, 'unanswered'), '')
  const before = { PATH: process.env['PATH'], XDG_STATE_HOME: process.env['XDG_STATE_HOME'] }
  process.env['PATH'] = `${join(folder, 'bin')}:${before.PATH ?? ''}`
  process.env['XDG_STATE_HOME'] = env.XDG_STATE_HOME
  onTestFinished(() => Object.assign(process.env, before))

  await forgetStopped()
  const kept = existsSync(runs)
  rmSync(join(folder, 'unanswered'))
  await forgetStopped()

  expect(kept).toBe(true)
  expect(existsSync(runs)).toBe(false)
})

test('a session resumed while the anyhost program does not answer continues in the folder its transcript last ran in, not where its terminal started', async () => {
  const { folder, claudeHome, env, claude, records } = machine()
  const app = join(folder, 'Developer', 'app')
  mkdirSync(app, { recursive: true })
  mkdirSync(join(claudeHome, 'projects', '-Developer-app'), { recursive: true })
  writeFileSync(join(claudeHome, 'projects', '-Developer-app', `${SESSION}.jsonl`), `${JSON.stringify({ type: 'user', cwd: app, sessionId: SESSION, message: { role: 'user', content: 'fix it' } })}\n`)
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: () => undefined })
  spawnForTest(['bun', CLI, 'run', '--session', SESSION, '--', claude], { env, terminal, cwd: folder })

  await until(() => records().length > 0, 'Claude Code starting')
  const [record] = records()
  expect((JSON.parse(readFileSync(join(claudeHome, 'sessions', record ?? ''), 'utf8')) as { cwd: string }).cwd).toBe(app)
  terminal.close()
}, 30_000)

test('anyhost run gives Claude Code the size its terminal resized to', async () => {
  const { env, claude } = machine()
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 70, rows: 31, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  const owned = `ioctl(STDIN, ${process.platform === 'darwin' ? '0x20007461' : '0x540E'}, 0) or die "$!"; exec { $ARGV[0] } @ARGV`
  spawnForTest(['perl', '-e', owned, '--', 'bun', CLI, 'run', '--', claude], { env, terminal })

  await until(() => shown.includes('started'), 'Claude Code starting')
  terminal.resize(200, 60)
  await until(() => shown.includes('size 60 200'), 'Claude Code hearing the new size')
  terminal.resize(120, 40)
  await until(() => shown.includes('size 40 120'), 'Claude Code hearing the next size')
  terminal.close()
}, 30_000)

test('a terminal that gets its pane within its first second starts Claude Code at the pane size, so Claude Code never draws at the size herdr-core opened it with', async () => {
  const { env, claude } = machine()
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 120, rows: 40, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  const owned = `ioctl(STDIN, ${process.platform === 'darwin' ? '0x20007461' : '0x540E'}, 0) or die "$!"; exec { $ARGV[0] } @ARGV`
  spawnForTest(['perl', '-e', owned, '--', 'bun', CLI, 'run', '--', claude], { env, terminal })
  await Bun.sleep(300)
  terminal.resize(70, 31)

  await until(() => shown.includes('started'), 'Claude Code starting')
  await Bun.sleep(500)
  expect(shown).not.toContain('size ')
  terminal.close()
}, 30_000)

test("the runner passes the terminal's replies to Claude Code at once, as herdr-core's OSC 7501 probe reply, and holds only what a person or a tell types", () => {
  expect(isTerminalReply('\x1b]7501;herdr=1\x1b\\')).toBe(true)
  expect(isTerminalReply('\x1b]11;rgb:1e1e/1e1e/1e1e\x07')).toBe(true)
  expect(isTerminalReply('\x1b[?62;22c')).toBe(true)
  expect(isTerminalReply('\x1b[?1u')).toBe(true)
  expect(isTerminalReply('\x1b[12;40R')).toBe(true)
  expect(isTerminalReply('Book the train\r')).toBe(false)
  expect(isTerminalReply('\x1b[200~Book the train\x1b[201~')).toBe(false)
  expect(isTerminalReply('\x1b[A')).toBe(false)
  expect(isTerminalReply('\x1b')).toBe(false)
})

test('anyhost run gives Claude Code the login environment the service saved, with no login shell of its own', async () => {
  const { env, claude } = machine()
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  spawnForTest(['bun', CLI, 'run', '--', claude], { env, terminal })

  await until(() => shown.includes('started'), 'Claude Code starting')
  expect(shown).toContain('started  with the login environment')
  terminal.close()
}, 30_000)

test('anyhost run records which runner, version, terminal and Claude Code run the session, since when', async () => {
  const { env, claude, runs } = machine(undefined, { HC_TERMINAL_ID: 't9', PATH: `/nowhere:${process.env['PATH'] ?? ''}` })
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: () => undefined })
  const runner = spawnForTest(['bun', CLI, 'run', '--', claude, '--model', 'opus'], { env, terminal })
  await until(() => existsSync(runs), 'the runner writing its run')
  const written = JSON.parse(readFileSync(runs, 'utf8')) as Record<string, unknown>
  expect(written).toMatchObject({
    session: SESSION,
    runner: { process: { id: runner.pid, start: expect.any(String) }, version: expect.any(String), startedAt: expect.any(String) },
    terminal: { address: 't9', machine: expect.any(String) },
    claude: { command: [claude, '--model', 'opus'], process: { id: expect.any(Number), start: expect.any(String) }, startedAt: expect.any(String) },
  })
  terminal.close()
}, 30_000)

test('anyhost run counts a turn Claude Code starts on its own as use, and stops only the stop time after it ends', async () => {
  const { env, claude, records, claudeHome } = machine(2000)
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: () => undefined })
  spawnForTest(['bun', CLI, 'run', '--', claude], { env, terminal })
  await until(() => records().length === 1, 'Claude Code writing its record')
  const record = join(claudeHome, 'sessions', records()[0] ?? '')
  const status = (to: string): void => writeFileSync(record, readFileSync(record, 'utf8').replace(/"status":"\w+"/, `"status":"${to}"`))

  status('busy')
  await Bun.sleep(3000)
  status('idle')
  const idleAt = Date.now()
  await until(() => records().length === 0, 'Claude Code ending once its turn ended', 10_000)
  expect(Date.now() - idleAt).toBeGreaterThanOrEqual(1400)
  terminal.close()
}, 30_000)

test("anyhost run never puts a session to sleep while its record says busy after its turn ended, as while its background agents run, and stops one Claude Code handed to the background after the stop time", async () => {
  const runningWith = async (mark: (record: Record<string, unknown>) => Record<string, unknown>, waits: (records: () => string[]) => Promise<void>): Promise<number> => {
    const { env, claude, records, claudeHome } = machine(2000)
    const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: () => undefined })
    spawnForTest(['bun', CLI, 'run', '--', claude], { env, terminal })
    await until(() => records().length === 1, 'Claude Code writing its record')
    const path = join(claudeHome, 'sessions', records()[0] ?? '')
    const busy = { ...(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>), status: 'busy', statusUpdatedAt: Date.now() - 60_000 }
    writeFileSync(path, JSON.stringify(mark(busy)))
    await waits(records)
    terminal.close()
    return records().length
  }

  const [working, parked] = await Promise.all([
    runningWith((record) => record, () => Bun.sleep(3000)),
    runningWith((record) => ({ ...record, parkedJobId: 'a1b2c3d4' }), (records) => until(() => records().length === 0, 'Claude Code ending once its turn left', 10_000)),
  ])

  expect([working, parked]).toEqual([1, 0])
}, 30_000)

test('anyhost run never stops a session a screen shows, and stops it once that mark is older than 90 s', async () => {
  const { env, claude, records, folder } = machine(500)
  const bin = join(folder, 'bin')
  const shownAt = join(folder, 'shown-at')
  writeFileSync(shownAt, String(Date.now()))
  script(
    join(bin, 'hc'),
    `#!/bin/bash
case "$1" in
  get) sleep 1; printf '{"state":"live","cwd":"/","labels":{"anyhost.shown.mac":"%s"}}' "$(cat "${shownAt}")" ;;
  events) sleep 1; echo '{"type":"labels","terminal":"t9"}'; sleep 600 ;;
esac
`,
  )
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: () => undefined })
  spawnForTest(['bun', CLI, 'run', '--', claude], { env: { ...env, PATH: `${bin}:${env.PATH}`, HC_TERMINAL_ID: 't9' }, terminal })

  await until(() => records().length === 1, 'Claude Code writing its record')
  await Bun.sleep(2500)
  const whileShown = records().length
  writeFileSync(shownAt, String(Date.now() - 91_000))

  expect(whileShown).toBe(1)
  await until(() => records().length === 0, 'Claude Code ending once no screen shows it', 10_000)
  terminal.close()
}, 30_000)

test('a session working in another terminal here moves only at Enter, and any other key leaves it working there', async () => {
  const { env, claude, claudeHome, records } = machine()
  const other = spawnForTest(['sleep', '600'])
  writeFileSync(join(claudeHome, 'sessions', `${other.pid}.json`), JSON.stringify({ pid: other.pid, sessionId: SESSION, procStart: startOf(other.pid), status: 'busy', kind: 'interactive' }))
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 120, rows: 24, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  const runner = spawnForTest(['bun', CLI, 'run', '--session', SESSION, '--', claude], { env, terminal })
  await until(() => shown.includes('Enter moves it here once its turn ends'), 'the runner asking before it moves the session')
  terminal.write('q')

  expect(await runner.exited).toBe(0)
  expect(records()).toEqual([`${other.pid}.json`])
  terminal.close()
}, 30_000)

test("declining to move a session out of another terminal here takes the session label off the runner's terminal, so its pane closing archives nothing", async () => {
  const { env, claude, claudeHome, folder } = machine()
  const bin = join(folder, 'bin')
  const calls = join(folder, 'hc.log')
  script(join(bin, 'hc'), `#!/bin/sh\necho "$*" >> "${calls}"\n`)
  const other = spawnForTest(['sleep', '600'])
  writeFileSync(join(claudeHome, 'sessions', `${other.pid}.json`), JSON.stringify({ pid: other.pid, sessionId: SESSION, procStart: startOf(other.pid), status: 'busy', kind: 'interactive' }))
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 120, rows: 24, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  const runner = spawnForTest(['bun', CLI, 'run', '--session', SESSION, '--', claude], { env: { ...env, PATH: `${bin}:${env.PATH}`, HC_TERMINAL_ID: 't9' }, terminal })
  await until(() => shown.includes('any other key leaves it there'), 'the runner asking before it moves the session')
  terminal.write('q')

  expect(await runner.exited).toBe(0)
  expect(readFileSync(calls, 'utf8').split('\n').filter((line) => line.startsWith('label '))).toEqual(['label t9 anyhost.session='])
  terminal.close()
}, 30_000)

test('a session idle in another terminal here moves at once, and says it moves rather than that it works', async () => {
  const { env, claude, claudeHome } = machine()
  const other = spawnForTest(['sleep', '600'])
  writeFileSync(join(claudeHome, 'sessions', `${other.pid}.json`), JSON.stringify({ pid: other.pid, sessionId: SESSION, procStart: startOf(other.pid), status: 'idle', kind: 'interactive' }))
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 120, rows: 24, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  spawnForTest(['bun', CLI, 'run', '--session', SESSION, '--', claude], { env, terminal })

  await until(() => shown.includes('moving here from another terminal'), 'the runner saying it moves the session here')

  expect(shown).not.toContain('working in another terminal')
  terminal.close()
}, 30_000)

test('Sleep stops an idle Claude Code at once and keeps its terminal, which stays asleep while the screen keeps showing it, and wakes at a key', async () => {
  const { env, claude, records, folder } = machine()
  const bin = join(folder, 'bin')
  const asked = join(folder, 'sleep-asked')
  writeFileSync(asked, '0')
  script(
    join(bin, 'hc'),
    `#!/bin/bash
case "$1" in
  get) printf '{"state":"live","cwd":"/","labels":{"anyhost.shown.mac":"%s","anyhost.sleep":"%s"}}' "$(($(date +%s) * 1000))" "$(cat "${asked}")" ;;
  events) while true; do sleep 0.3; echo '{"type":"labels","terminal":"t9"}'; done ;;
esac
`,
  )
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  const runner = spawnForTest(['bun', CLI, 'run', '--', claude], { env: { ...env, PATH: `${bin}:${env.PATH}`, HC_TERMINAL_ID: 't9' }, terminal })
  await until(() => records().length === 1, 'Claude Code writing its record')

  writeFileSync(asked, String(Date.now()))
  await until(() => records().length === 0, 'Claude Code stopping at Sleep')
  await Bun.sleep(1500)

  expect(records()).toEqual([])
  expect(runner.exitCode).toBeNull()
  expect(shown).toContain('\x1b]7501;state=clear\x1b\\')
  terminal.write('x')
  await until(() => records().length === 1, 'Claude Code starting again at a key')
  terminal.close()
}, 30_000)

test('a sleeping session starts Claude Code as soon as a screen shows its terminal, with no key typed, also after herdr-core restarted and ended the events it followed', async () => {
  const { env, claude, records, folder } = machine()
  const bin = join(folder, 'bin')
  script(
    join(bin, 'hc'),
    `#!/bin/bash
F='${folder}'
case "$1" in
  get) if [ -e "$F/shown" ]; then printf '{"state":"live","cwd":"/","labels":{"anyhost.shown.mac":"%s"}}' "$(($(date +%s) * 1000))"; else printf '{"state":"live","cwd":"/","labels":{}}'; fi ;;
  events) if [ -e "$F/restarted" ]; then sleep 600; else touch "$F/restarted"; exit 1; fi ;;
esac
`,
  )
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: () => undefined })
  spawnForTest(['bun', CLI, 'run', '--asleep', '--session', SESSION, '--', claude], { env: { ...env, PATH: `${bin}:${env.PATH}`, HC_TERMINAL_ID: 't9' }, terminal })
  await until(() => existsSync(join(folder, 'restarted')), "herdr-core's events ending")

  writeFileSync(join(folder, 'shown'), '')

  await until(() => records().length === 1, 'Claude Code starting for the screen that shows it', 10_000)
  terminal.close()
}, 30_000)

test('a session a terminal here runs already shows live in a second terminal, which attaches to the first and starts no second Claude Code', async () => {
  const { env, claude, records, folder, runs } = machine()
  const hcLog = join(folder, 'hc.log')
  script(join(folder, 'bin', 'hc'), `#!/bin/sh\necho "$*" >> '${hcLog}'\n[ "$1" = attach ] && exec sleep 600\nexit 0\n`)
  const first = spawnForTest(['sleep', '600'])
  mkdirSync(join(runs, '..'), { recursive: true })
  writeFileSync(runs, JSON.stringify({ session: SESSION, runner: { process: { id: first.pid, start: startOf(first.pid) }, version: '', startedAt: '' }, terminal: { address: 't1', machine: '' }, claude: { command: ['claude'] } }))
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: () => undefined })
  spawnForTest(['bun', CLI, 'run', '--session', SESSION, '--', claude], { env: { ...env, PATH: `${join(folder, 'bin')}:${env.PATH}`, HC_TERMINAL_ID: 't2' }, terminal })

  await until(() => existsSync(hcLog) && readFileSync(hcLog, 'utf8').includes('attach t1'), 'the second terminal attaching to the first')

  expect(readFileSync(hcLog, 'utf8').split('\n').filter((line) => line !== '')).toEqual([`label t2 anyhost.view=${SESSION}`, 'attach t1'])
  expect(records()).toEqual([])
  terminal.close()
}, 30_000)

test('a view attaches again when the session it shows comes back in another terminal here, as after herdr-core restarted, and ends once no terminal here runs it', async () => {
  const { env, claude, folder, runs } = machine()
  const hcLog = join(folder, 'hc.log')
  script(join(folder, 'bin', 'hc'), `#!/bin/sh\necho "$*" >> '${hcLog}'\n[ "$1" = attach ] && [ -e "${folder}/$2.ends" ] && exit 0\n[ "$1" = attach ] && exec sleep 600\nexit 0\n`)
  const runOn = (address: string): Subprocess => {
    const runner = spawnForTest(['sleep', '600'])
    writeFileSync(runs, JSON.stringify({ session: SESSION, runner: { process: { id: runner.pid, start: startOf(runner.pid) }, version: '', startedAt: '' }, terminal: { address, machine: '' }, claude: { command: ['claude'] } }))
    return runner
  }
  mkdirSync(join(runs, '..'), { recursive: true })
  const first = runOn('t1')
  writeFileSync(join(folder, 't1.ends'), '')
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: () => undefined })
  const view = spawnForTest(['bun', CLI, 'run', '--session', SESSION, '--', claude], { env: { ...env, PATH: `${join(folder, 'bin')}:${env.PATH}`, HC_TERMINAL_ID: 't2' }, terminal })
  await until(() => existsSync(hcLog) && readFileSync(hcLog, 'utf8').includes('attach t1'), 'the view attaching to t1')
  first.kill('SIGKILL')
  const second = runOn('t3')

  await until(() => readFileSync(hcLog, 'utf8').includes('attach t3'), 'the view attaching again to t3')
  second.kill('SIGKILL')
  Bun.spawnSync(['pkill', '-P', String(view.pid), '-f', 'sleep 600'])

  expect(await Promise.race([view.exited.then(() => 'ended'), Bun.sleep(10_000).then(() => 'still running')])).toBe('ended')
  terminal.close()
}, 30_000)

test("a tab that starts asleep for a session another terminal here runs, as a repaired or seeded tab does, attaches to that terminal and leaves its run as it was", async () => {
  const { env, claude, folder, runs } = machine()
  const hcLog = join(folder, 'hc.log')
  script(join(folder, 'bin', 'hc'), `#!/bin/sh\necho "$*" >> '${hcLog}'\n[ "$1" = attach ] && exec sleep 600\nexit 0\n`)
  const first = spawnForTest(['sleep', '600'])
  mkdirSync(join(runs, '..'), { recursive: true })
  const run = JSON.stringify({ session: SESSION, runner: { process: { id: first.pid, start: startOf(first.pid) }, version: '', startedAt: '' }, terminal: { address: 't1', machine: '' }, claude: { command: ['claude'] } })
  writeFileSync(runs, run)
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: () => undefined })
  spawnForTest(['bun', CLI, 'run', '--asleep', '--session', SESSION, '--', claude], { env: { ...env, PATH: `${join(folder, 'bin')}:${env.PATH}`, HC_TERMINAL_ID: 't2' }, terminal })

  await until(() => existsSync(hcLog) && readFileSync(hcLog, 'utf8').includes('attach t1'), 'the asleep tab attaching to the running terminal')

  expect(readFileSync(runs, 'utf8')).toBe(run)
  terminal.close()
}, 30_000)

test('a tab that starts asleep for a session Claude Code runs outside herdr-core here, as in tmux, claims no run of it and asks before it moves the session', async () => {
  const { env, claude, claudeHome, runs } = machine()
  const other = spawnForTest(['sleep', '600'])
  writeFileSync(join(claudeHome, 'sessions', `${other.pid}.json`), JSON.stringify({ pid: other.pid, sessionId: SESSION, procStart: startOf(other.pid), status: 'busy', kind: 'interactive' }))
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 120, rows: 24, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  spawnForTest(['bun', CLI, 'run', '--asleep', '--session', SESSION, '--', claude], { env, terminal })

  await until(() => shown.includes('Enter moves it here once its turn ends'), 'the asleep tab asking before it moves the session')

  expect(existsSync(runs)).toBe(false)
  terminal.close()
}, 30_000)

test('a sleeping session another machine holds now stays asleep at a key, and its terminal says where it continues', async () => {
  const { env, claude, records, claudeHome, folder } = machine()
  const transcript = join(claudeHome, 'projects', '-trip', `${SESSION}.jsonl`)
  mkdirSync(join(transcript, '..'), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"}}\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Booked the 9:15 train."}]}}\n`)
  const db = new Database(join(folder, 'state', 'anyhost', 'anyhost.db'))
  db.run('create table journals (session text primary key, holder text not null)')
  db.query('insert into journals values (?, ?)').run(SESSION, 'mac-studio')
  db.close()
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  spawnForTest(['bun', CLI, 'run', '--asleep', '--session', SESSION, '--', claude], { env, terminal })

  await until(() => shown.includes('type to continue'), 'the terminal showing the session asleep')
  terminal.write('x')
  await until(() => shown.includes('mac-studio holds it'), 'the terminal saying which machine holds the session')

  expect(records()).toEqual([])
  expect(shown).toContain('\x1b]2;Plan the trip\x07')
  terminal.close()
}, 30_000)

test('anyhost run puts an idle session to sleep after the stop time and keeps its terminal, which shows its last reply, and a key starts Claude Code again', async () => {
  const { env, claude, records, runs, claudeHome } = machine(500)
  const transcript = join(claudeHome, 'projects', '-trip', `${SESSION}.jsonl`)
  mkdirSync(join(transcript, '..'), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"}}\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Booked the 9:15 train."}]}}\n`)
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  const runner = spawnForTest(['bun', CLI, 'run', '--', claude], { env, terminal })
  const run = (): Record<string, unknown> => JSON.parse(readFileSync(runs, 'utf8')) as Record<string, unknown>

  await until(() => existsSync(runs), 'the runner writing its run')
  await until(() => records().length === 0 && run()['asleepSince'] !== undefined, 'the session going to sleep', 10_000)
  await until(() => shown.includes('type to continue'), 'the terminal showing the session asleep')

  expect(runner.exitCode).toBe(null)
  expect(shown).toContain('Booked the 9:15 train.')
  expect((run()['claude'] as Record<string, unknown>)['process']).toBeUndefined()
  terminal.write('x')
  await until(() => records().length === 1 && run()['asleepSince'] === undefined, 'a key starting Claude Code again', 10_000)
  terminal.close()
}, 30_000)

test('the program counts as absent only while no socket file exists or nothing listens on it, and an answer lost on the way is an error', async () => {
  const state = temporaryFolder()
  const before = process.env['XDG_STATE_HOME']
  process.env['XDG_STATE_HOME'] = state
  onTestFinished(() => {
    if (before === undefined) delete process.env['XDG_STATE_HOME']
    else process.env['XDG_STATE_HOME'] = before
  })
  mkdirSync(join(state, 'anyhost'))

  const absent = await askProgram('/agents/place', { session: SESSION })
  const dropping = createServer((socket) => socket.destroy())
  await new Promise<void>((resolve) => dropping.listen(serveSocket(), resolve))
  onTestFinished(() => void dropping.close())

  expect(absent).toBeUndefined()
  await expect(askProgram('/agents/place', { session: SESSION })).rejects.toThrow(`The anyhost program at ${serveSocket()} gave no answer to /agents/place: ECONNRESET`)
})

const ANOTHER_TERMINAL = 'running in another terminal here (process'

const copyElsewhere = (claudeHome: string): Subprocess => {
  const other = spawnForTest(['sleep', '600'])
  writeFileSync(join(claudeHome, 'sessions', `${other.pid}.json`), JSON.stringify({ pid: other.pid, sessionId: SESSION, procStart: startOf(other.pid), status: 'idle', kind: 'interactive' }))
  return other
}

test('a runner whose program died during its place request, while Claude Code runs the session in another terminal here, starts no second copy and says where the session runs', async () => {
  const { env, claude, claudeHome, records } = machine()
  const other = copyElsewhere(claudeHome)
  const socket = join(env.XDG_STATE_HOME, 'anyhost', 'serve.sock')
  const program = spawnForTest(['bun', '-e', `Bun.serve({ unix: ${JSON.stringify(socket)}, fetch: () => new Response('{}') }); console.log('up')`], { stdout: 'pipe' })
  await program.stdout.getReader().read()
  program.kill('SIGKILL')
  await program.exited
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 160, rows: 24, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  const runner = spawnForTest(['bun', CLI, 'run', '--session', SESSION, '--', claude], { env, terminal })
  await until(() => shown.includes(ANOTHER_TERMINAL), 'the runner saying where the session runs')
  const whileShown = records()
  terminal.write('q')

  expect(existsSync(socket)).toBe(true)
  expect(shown).toContain(`${ANOTHER_TERMINAL} ${other.pid}) · close it there, or open it here from the sidebar once it is idle`)
  expect(whileShown).toEqual([`${other.pid}.json`])
  expect(await runner.exited).toBe(0)
  expect(records()).toEqual([`${other.pid}.json`])
  terminal.close()
}, 30_000)

test('a sleeping runner woken while Claude Code runs the session in another terminal here starts no second copy, and goes back to sleep at a key', async () => {
  const { env, claude, claudeHome, records } = machine()
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 160, rows: 24, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  const runner = spawnForTest(['bun', CLI, 'run', '--asleep', '--session', SESSION, '--', claude], { env, terminal })
  await until(() => shown.includes('type to continue'), 'the terminal showing the session asleep')
  const other = copyElsewhere(claudeHome)

  terminal.write('x')
  await until(() => shown.includes(ANOTHER_TERMINAL), 'the runner saying where the session runs')
  const whileShown = records()
  shown = ''
  terminal.write('q')
  await until(() => shown.includes('type to continue'), 'the terminal showing the session asleep again')

  expect(whileShown).toEqual([`${other.pid}.json`])
  expect(records()).toEqual([`${other.pid}.json`])
  expect(runner.exitCode).toBeNull()
  terminal.close()
}, 30_000)
