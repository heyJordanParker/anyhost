import { expect, onTestFinished, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installHerdr } from '../src/herdr.ts'
import { startOf } from '../src/claude.ts'
import { resumeCommand, START_CLAUDE } from '../src/runner.ts'
import { temporaryFolder, until } from './memory.ts'

const CLI = join(import.meta.dir, '..', 'src', 'main.ts')
const SESSION = '11111111-2222-3333-4444-555555555555'
const killAfterTest = (child: Subprocess): void =>
  onTestFinished(async () => {
    child.kill('SIGKILL')
    await child.exited
  })

test("a resumed session carries the home folder's trust as Claude Code carries it into a copy it relaunches: its own pid and start", async () => {
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 120, rows: 24, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  const child = Bun.spawn(['perl', '-e', START_CLAUDE, '--', 'sh', '-c', 'echo "trust=$CLAUDE_CODE_RELAUNCH_HOME_TRUST;"; sleep 10'], { terminal, env: { ...process.env, ANYHOST_HOME_TRUST: '1' }, detached: true })
  killAfterTest(child)

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
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "claude $*"\n')
  chmodSync(join(bin, 'claude'), 0o755)
  const ran = Bun.spawnSync(programs.claude.run, { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } })
  expect(ran.stdout.toString()).toBe('claude --model opus\n')
  const linked = join(home, '.local', 'share', 'cmod', 'programs')
  mkdirSync(linked, { recursive: true })
  writeFileSync(join(linked, 'anyhost'), '#!/bin/sh\necho "anyhost $*"\n')
  chmodSync(join(linked, 'anyhost'), 0o755)
  expect(Bun.spawnSync(programs.claude.run, { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } }).stdout.toString()).toBe('anyhost run -- claude --model opus\n')
})

const fakeClaude = (folder: string): string => {
  const path = join(folder, 'claude')
  writeFileSync(
    path,
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
  chmodSync(path, 0o755)
  return path
}

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

test('anyhost run gives Claude Code the size its terminal resized to', async () => {
  const { env, claude } = machine()
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 70, rows: 31, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  const owned = `ioctl(STDIN, ${process.platform === 'darwin' ? '0x20007461' : '0x540E'}, 0) or die "$!"; exec { $ARGV[0] } @ARGV`
  killAfterTest(Bun.spawn(['perl', '-e', owned, '--', 'bun', CLI, 'run', '--', claude], { env, terminal, detached: true }))

  await until(() => shown.includes('started'), 'Claude Code starting')
  terminal.resize(200, 60)
  await until(() => shown.includes('size 60 200'), 'Claude Code hearing the new size')
  terminal.resize(120, 40)
  await until(() => shown.includes('size 40 120'), 'Claude Code hearing the next size')
  terminal.close()
}, 30_000)

test('anyhost run gives Claude Code the login environment the service saved, with no login shell of its own', async () => {
  const { env, claude } = machine()
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  killAfterTest(Bun.spawn(['bun', CLI, 'run', '--', claude], { env, terminal }))

  await until(() => shown.includes('started'), 'Claude Code starting')
  expect(shown).toContain('started  with the login environment')
  terminal.close()
}, 30_000)

test('anyhost run records which runner, version, terminal and Claude Code run the session, since when', async () => {
  const { env, claude, runs } = machine(undefined, { HC_TERMINAL_ID: 't9', PATH: `/nowhere:${process.env['PATH'] ?? ''}` })
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: () => undefined })
  const runner = Bun.spawn(['bun', CLI, 'run', '--', claude, '--model', 'opus'], { env, terminal })
  killAfterTest(runner)

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
  const runner = Bun.spawn(['bun', CLI, 'run', '--', claude], { env, terminal })
  killAfterTest(runner)
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

test('anyhost run never stops a session a screen shows, and stops it once that mark is older than 90 s', async () => {
  const { env, claude, records, folder } = machine(500)
  const bin = join(folder, 'bin')
  const shownAt = join(folder, 'shown-at')
  mkdirSync(bin)
  writeFileSync(shownAt, String(Date.now()))
  writeFileSync(
    join(bin, 'hc'),
    `#!/bin/bash
case "$1" in
  get) printf '{"state":"live","cwd":"/","labels":{"anyhost.shown.mac":"%s"}}' "$(cat "${shownAt}")" ;;
  events) sleep 1; echo '{"type":"labels","terminal":"t9"}'; sleep 600 ;;
esac
`,
  )
  chmodSync(join(bin, 'hc'), 0o755)
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: () => undefined })
  killAfterTest(Bun.spawn(['bun', CLI, 'run', '--', claude], { env: { ...env, PATH: `${bin}:${env.PATH}`, HC_TERMINAL_ID: 't9' }, terminal }))

  await until(() => records().length === 1, 'Claude Code writing its record')
  await Bun.sleep(2500)
  const whileShown = records().length
  writeFileSync(shownAt, String(Date.now() - 91_000))

  expect(whileShown).toBe(1)
  await until(() => records().length === 0, 'Claude Code ending once no screen shows it', 10_000)
  terminal.close()
}, 30_000)

test('anyhost run stops an idle session after the stop time: Claude Code ends, the runner exits and forgets its run, so its terminal closes', async () => {
  const { env, claude, records, runs } = machine(500)
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: () => undefined })
  const runner = Bun.spawn(['bun', CLI, 'run', '--', claude], { env, terminal })
  killAfterTest(runner)

  await until(() => existsSync(runs), 'the runner writing its run')
  await until(() => records().length === 0, 'Claude Code ending', 10_000)

  expect(await runner.exited).toBe(0)
  expect(existsSync(runs)).toBe(false)
  terminal.close()
}, 30_000)
