import { afterEach, expect, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installHerdr } from '../src/herdr.ts'
import { resumeCommand } from '../src/runner.ts'
import { temporaryFolder, until } from './memory.ts'

const CLI = join(import.meta.dir, '..', 'src', 'main.ts')
const SESSION = '11111111-2222-3333-4444-555555555555'
const children: Subprocess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
    await child.exited
  }
})

test('a woken session runs the command it started with, with every session flag of it replaced by --resume of the session', () => {
  expect(resumeCommand(['claude', '--model', 'opus', '--resume', 'old', '-c', '--fork-session', '--session-id=x', '--dangerously-skip-permissions'], 'new', {})).toEqual(['claude', '--model', 'opus', '--dangerously-skip-permissions', '--resume', 'new'])
  expect(resumeCommand(['claude', '-r', '--model', 'opus'], 'new', {})).toEqual(['claude', '--model', 'opus', '--resume', 'new'])
})

// The suite missed it: the Herdr app gives a new tab's agent its first message as the last argument, which every wake
// sent the resumed session again.
test('a woken session drops the first message the Herdr app gave its command, which the conversation holds already', () => {
  expect(resumeCommand(['claude', '--model', 'haiku', 'fix'], 'new', { firstMessage: 'fix' })).toEqual(['claude', '--model', 'haiku', '--resume', 'new'])
  expect(resumeCommand(['claude', '--model', 'haiku'], 'new', { firstMessage: 'fix the login' })).toEqual(['claude', '--model', 'haiku', '--resume', 'new'])
})

// The suite missed it: --resume takes the default model and effort, so a session whose /model picked another came back
// on the default, and missed the cache its model held.
test('a woken session runs on the model and effort its last turn ran with', () => {
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

// A Claude Code that writes its record of SESSION, idle, as Claude Code writes one for each session it runs, prints how
// it started and its status report, echoes each line typed, prints its terminal's size at each SIGWINCH, and removes its
// record as it ends at SIGTERM. It reads the lines in a job of its own and waits for it again after each signal it traps,
// which ends a `wait` at once, and gives that job its own input, as bash gives a job `/dev/null` else.
const fakeClaude = (folder: string): string => {
  const path = join(folder, 'claude')
  writeFileSync(
    path,
    `#!/bin/bash
record="$CLAUDE_CONFIG_DIR/sessions/$$.json"
printf '{"pid":%s,"sessionId":"${SESSION}","kind":"interactive","status":"idle"}' $$ > "$record"
trap 'rm -f "$record"; exit 0' TERM
trap 'echo "size $(stty size)"' WINCH
printf 'started %s\\033]7501;state=idle:app=claude-code\\033\\\\\\n' "$*"
while IFS= read -r line; do echo "typed $line"; done <&0 &
reader=$!
while kill -0 $reader 2>/dev/null; do wait $reader; done
`,
  )
  chmodSync(path, 0o755)
  return path
}

// The suite missed it: Bun 1.4.4 refreshes the terminal's size only after every SIGWINCH listener ran, so the runner gave
// Claude Code the size before each resize, and Claude Code drew a garbled screen.
test('anyhost run gives Claude Code the size its terminal resized to', async () => {
  const folder = temporaryFolder()
  const claudeHome = join(folder, '.claude')
  mkdirSync(join(claudeHome, 'sessions'), { recursive: true })
  const claude = fakeClaude(folder)
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 70, rows: 31, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  const env = { PATH: process.env['PATH'] ?? '', HOME: folder, CLAUDE_CONFIG_DIR: claudeHome, XDG_STATE_HOME: join(folder, 'state') }
  // the runner owns its terminal, as in a terminal of herdr-core, so the kernel sends it SIGWINCH at a resize
  const owned = `ioctl(STDIN, ${process.platform === 'darwin' ? '0x20007461' : '0x540E'}, 0) or die "$!"; exec { $ARGV[0] } @ARGV`
  children.push(Bun.spawn(['perl', '-e', owned, '--', 'bun', CLI, 'run', '--', claude], { env, terminal, detached: true }))

  await until(() => shown.includes('started'), 'Claude Code starting')
  terminal.resize(200, 60)
  await until(() => shown.includes('size 60 200'), 'Claude Code hearing the new size')
  terminal.resize(120, 40)
  await until(() => shown.includes('size 40 120'), 'Claude Code hearing the next size')
  terminal.close()
}, 30_000)

// The suite missed it: every slept session had a transcript, while Claude Code refuses --resume of one that never got a
// message, so such a session never woke.
test('anyhost run wakes a session that never got a message with the command it started with, as Claude Code resumes only one with a transcript', async () => {
  const folder = temporaryFolder()
  const claudeHome = join(folder, '.claude')
  mkdirSync(join(claudeHome, 'sessions'), { recursive: true })
  const claude = fakeClaude(folder)
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  const env = { PATH: process.env['PATH'] ?? '', HOME: folder, CLAUDE_CONFIG_DIR: claudeHome, XDG_STATE_HOME: join(folder, 'state'), ANYHOST_SLEEP_MS: '500' }
  children.push(Bun.spawn(['bun', CLI, 'run', '--', claude, '--session-id', SESSION], { env, terminal }))

  await until(() => shown.includes(`started --session-id ${SESSION}`), 'Claude Code starting')
  await until(() => readdirSync(join(claudeHome, 'sessions')).length === 0, 'Claude Code ending', 10_000)
  const asleep = shown.length
  terminal.write('book the train\r')
  await until(() => shown.slice(asleep).includes(`started --session-id ${SESSION}`), 'Claude Code starting again')
  await until(() => shown.includes('typed book the train'), 'the key that woke it reaching it')
  terminal.close()
}, 30_000)

test('anyhost run asks for focus reports while Claude Code rests, and a focus wakes it before any key, with no focus report reaching it', async () => {
  const folder = temporaryFolder()
  const claudeHome = join(folder, '.claude')
  mkdirSync(join(claudeHome, 'sessions'), { recursive: true })
  mkdirSync(join(claudeHome, 'projects', '-work'), { recursive: true })
  writeFileSync(join(claudeHome, 'projects', '-work', `${SESSION}.jsonl`), '{"type":"user"}\n')
  const claude = fakeClaude(folder)
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  const env = { PATH: process.env['PATH'] ?? '', HOME: folder, CLAUDE_CONFIG_DIR: claudeHome, XDG_STATE_HOME: join(folder, 'state'), ANYHOST_SLEEP_MS: '500' }
  children.push(Bun.spawn(['bun', CLI, 'run', '--', claude], { env, terminal }))

  await until(() => shown.includes('started'), 'Claude Code starting')
  await until(() => readdirSync(join(claudeHome, 'sessions')).length === 0, 'Claude Code ending', 10_000)
  await until(() => shown.endsWith('\x1b[?1004h'), 'the runner asking for focus reports')
  const asleep = shown.length
  // a viewer focusing the terminal, as the Herdr app does when the session opens
  terminal.write('\x1b[I')
  await until(() => shown.slice(asleep).includes(`started --resume ${SESSION}`), 'Claude Code starting at the focus')
  expect(shown.slice(asleep)).toStartWith('\x1b[?1004l')
  terminal.write('book the train\r')
  await until(() => shown.includes('typed '), 'the key reaching Claude Code')
  expect(shown).toContain('typed book the train')
  terminal.close()
}, 30_000)

// The suite missed it: a /loop's next run is a turn no key starts, and Claude Code's record says idle between runs, so
// the runner ended the loop at the sleep time after the last key.
test('anyhost run counts a turn Claude Code starts on its own as a key, and sleeps only the sleep time after it ends', async () => {
  const folder = temporaryFolder()
  const claudeHome = join(folder, '.claude')
  mkdirSync(join(claudeHome, 'sessions'), { recursive: true })
  const claude = fakeClaude(folder)
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: () => undefined })
  const env = { PATH: process.env['PATH'] ?? '', HOME: folder, CLAUDE_CONFIG_DIR: claudeHome, XDG_STATE_HOME: join(folder, 'state'), ANYHOST_SLEEP_MS: '2000' }
  children.push(Bun.spawn(['bun', CLI, 'run', '--', claude], { env, terminal }))
  const records = (): string[] => readdirSync(join(claudeHome, 'sessions'))
  await until(() => records().length === 1, 'Claude Code writing its record')
  const record = join(claudeHome, 'sessions', records()[0] ?? '')
  const status = (to: string): void => writeFileSync(record, readFileSync(record, 'utf8').replace(/"status":"\w+"/, `"status":"${to}"`))

  status('busy')
  await Bun.sleep(3000)
  status('idle')
  const idleAt = Date.now()
  await until(() => records().length === 0, 'Claude Code ending once its turn ended', 10_000)
  // the runner checks every 500 ms, a quarter of the sleep time
  expect(Date.now() - idleAt).toBeGreaterThanOrEqual(1400)
  terminal.close()
}, 30_000)

test('anyhost run ends an idle Claude Code after the sleep time, keeps its screen, and a key resumes the same session with the key typed into it', async () => {
  const folder = temporaryFolder()
  const claudeHome = join(folder, '.claude')
  mkdirSync(join(claudeHome, 'sessions'), { recursive: true })
  // the transcript Claude Code wrote at the session's first message
  mkdirSync(join(claudeHome, 'projects', '-work'), { recursive: true })
  writeFileSync(join(claudeHome, 'projects', '-work', `${SESSION}.jsonl`), '{"type":"user"}\n')
  const claude = fakeClaude(folder)
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_terminal, bytes) => void (shown += new TextDecoder().decode(bytes)) })
  const env = { PATH: process.env['PATH'] ?? '', HOME: folder, CLAUDE_CONFIG_DIR: claudeHome, XDG_STATE_HOME: join(folder, 'state'), ANYHOST_SLEEP_MS: '500' }
  const runner = Bun.spawn(['bun', CLI, 'run', '--', claude, '--model', 'opus'], { env, terminal })
  children.push(runner)
  const runs = join(folder, 'state', 'anyhost', 'runs', `${SESSION}.json`)

  await until(() => shown.includes('started --model opus'), 'Claude Code starting')
  await until(() => existsSync(runs), 'the runner writing its run')
  const written = JSON.parse(readFileSync(runs, 'utf8')) as Record<string, unknown>
  expect(written).toEqual({ pid: runner.pid, procStart: expect.any(String), command: [claude, '--model', 'opus'] })
  // the check after the sleep time ends Claude Code, whose record goes with it
  await until(() => readdirSync(join(claudeHome, 'sessions')).length === 0, 'Claude Code ending', 10_000)
  await until(() => shown.endsWith('\x1b[?1004h'), 'the runner asking for focus reports, the last thing it does going to sleep')
  const asleep = shown
  await Bun.sleep(1000)
  expect(shown).toBe(asleep)
  expect(runner.exitCode).toBeNull()

  terminal.write('book the train\r')
  await until(() => shown.includes(`started --model opus --resume ${SESSION}`), 'Claude Code resuming the session')
  await until(() => shown.includes('typed book the train'), 'the key that woke it reaching it')
  terminal.close()
}, 30_000)
