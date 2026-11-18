import { expect, onTestFinished, spyOn, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeStart, commandOf, currentFolderOf, openFilesOf, processes, resumeArgv, resumedOf, startOf } from '../src/claude.ts'
import type { Status } from '../src/serve.ts'
import { familyOf, lastFolderOf, transcriptTailOf } from '../src/transcript.ts'
import { memoryRelay, until } from './memory.ts'
import { anyhostOn, coreEvent, coreSays, decoder, hookOn, LAPTOP, logOf, machineFor, OTHER_SESSION, runningOn, sentOn, serveOn, SESSION, sharedIn, spawnForTest, temporaryFolder, terminalIn } from './program.ts'

const SHELL = ['/bin/zsh', '-l']
const CLAUDE = ['claude']
const THIRD_SESSION = '33333333-4444-5555-6666-777777777777'
const FOURTH_SESSION = '44444444-5555-6666-7777-888888888888'

type Machine = Awaited<ReturnType<typeof machineFor>>

const claudeIn = (machine: Machine, address: string, session: string, status: string, statusUpdatedAt = Date.now() - 10_000): Subprocess => {
  const copy = spawnForTest(['sleep', '600'])
  writeFileSync(join(machine.env['CLAUDE_CONFIG_DIR'] ?? '', 'sessions', `${copy.pid}.json`), JSON.stringify({ pid: copy.pid, sessionId: session, procStart: startOf(copy.pid), kind: 'interactive', status, statusUpdatedAt }))
  mkdirSync(join(machine.folder, 'terminals'), { recursive: true })
  writeFileSync(join(machine.folder, 'terminals', address), `${session} ${copy.pid}\n`)
  return copy
}

const hasEnded = (copy: Subprocess): boolean => copy.exitCode !== null || copy.signalCode !== null

test("a program started from inside a Claude Code session runs herdr-core without that session's markers, so no terminal it reaches saves no transcript", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)

  await serveOn({ ...laptop.env, CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: OTHER_SESSION })
  await until(() => ['events', 'machine'].every((command) => logOf(laptop.folder, 'calls.log').some((line) => line.startsWith(command))), 'the program following herdr-core and reading its machines', 15_000)

  expect(logOf(laptop.folder, 'marked.log')).toEqual([])
}, 60_000)

test("a program started with a Claude Code session's markers keeps the Claude Code path cmod gives it, so it reads the person's options", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP, { uploadEvery: 0 })

  await serveOn({ ...laptop.env, CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: OTHER_SESSION })
  await until(async () => ((await (await fetch('http://localhost/status', { unix: laptop.socket })).json()) as Status).uploadEvery === 0, "the person's uploadEvery in /status", 15_000)
}, 60_000)

test("a herdr-core that gives its terminals a Claude Code session's markers shows in /status, and the line goes once a core without them follows", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const coreEnvironment = join(laptop.folder, 'core.env')
  const status = async (): Promise<Status> => (await (await fetch('http://localhost/status', { unix: laptop.socket })).json()) as Status
  writeFileSync(coreEnvironment, 'HOME=/home/laptop\0CLAUDE_CODE_CHILD_SESSION=1\0CLAUDECODE=1\0PATH=/usr/bin\0')

  await serveOn(laptop.env)
  coreSays(laptop.folder, { terminals: [] })
  await until(async () => (await status()).coreProblem !== undefined, 'the marked core in /status', 15_000)
  const marked = (await status()).coreProblem
  writeFileSync(coreEnvironment, 'HOME=/home/laptop\0PATH=/usr/bin\0')
  coreSays(laptop.folder, { terminals: [] })
  await until(async () => (await status()).coreProblem === undefined, 'the clean core in /status', 15_000)

  expect(marked).toContain('CLAUDECODE, CLAUDE_CODE_CHILD_SESSION')
}, 60_000)

test("the launcher starts Claude Code with the saved login environment, without a Claude Code session's markers, and with the home folder's trust as its own pid and start", async () => {
  const state = temporaryFolder()
  const before = process.env['XDG_STATE_HOME']
  process.env['XDG_STATE_HOME'] = state
  onTestFinished(() => {
    if (before === undefined) delete process.env['XDG_STATE_HOME']
    else process.env['XDG_STATE_HOME'] = before
  })
  mkdirSync(join(state, 'anyhost'))
  writeFileSync(join(state, 'anyhost', 'environment.json'), JSON.stringify({ changedAt: 0, environment: { ANYHOST_PROBE: 'login' } }))

  const child = spawnForTest(claudeStart(['sh', '-c', 'echo "$ANYHOST_PROBE ${CLAUDECODE:-unmarked} trust=$CLAUDE_CODE_RELAUNCH_HOME_TRUST;"; sleep 10'], true), { env: { ...process.env, CLAUDECODE: '1' } })
  const reader = child.stdout.getReader()
  let printed = ''
  while (!printed.includes(';')) printed += decoder.decode((await reader.read()).value)

  expect(printed).toBe(`login unmarked trust=${child.pid}:${startOf(child.pid)};\n`)
})

test('a resumed session runs on the model and effort its last turn ran with, in the folder it last ran in, from one read of its transcript', async () => {
  const transcript = join(temporaryFolder(), `${SESSION}.jsonl`)
  writeFileSync(transcript, `{"type":"user","cwd":"/work/first","message":{"role":"user","content":"Plan the trip"}}\n{"type":"assistant","cwd":"/work/trip","message":{"model":"claude-haiku-5-5"},"effort":"medium"}\n`)

  const tail = await transcriptTailOf(transcript)

  expect(resumeArgv(SESSION, resumedOf(tail))).toEqual(['claude', '--model', 'claude-haiku-5-5', '--effort', 'medium', '--resume', SESSION])
  expect(lastFolderOf(tail)).toBe('/work/trip')
})

test('an idle session no screen shows is discarded after the stop time, while one that works, one a screen shows and the rest of its terminals stay, and Sleep discards an idle one at once', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const idle = claudeIn(laptop, 't0', SESSION, 'idle')
  const working = claudeIn(laptop, 't1', OTHER_SESSION, 'busy')
  const shown = claudeIn(laptop, 't2', THIRD_SESSION, 'idle')
  const backgrounded = claudeIn(laptop, 't3', FOURTH_SESSION, 'shell')
  const shownLabels = { 'anyhost.session': THIRD_SESSION, 'anyhost.shown.device-desktop': String(Date.now()) }
  coreSays(laptop.folder, {
    seq: 1,
    terminals: [terminalIn('t0', CLAUDE, { 'anyhost.session': SESSION }), terminalIn('t1', CLAUDE, { 'anyhost.session': OTHER_SESSION }), terminalIn('t2', CLAUDE, shownLabels), terminalIn('t3', CLAUDE, { 'anyhost.session': FOURTH_SESSION })],
  })

  await serveOn({ ...laptop.env, ANYHOST_STOP_MS: '2000' })
  await until(() => hasEnded(idle), 'the idle session ending', 15_000)
  await Bun.sleep(2000)
  const kept = [working, shown, backgrounded].map(hasEnded)
  coreSays(laptop.folder, coreEvent('labels', 't2', { labels: { ...shownLabels, 'anyhost.sleep': String(Date.now()) } }))

  expect(kept).toEqual([false, false, false])
  await until(() => hasEnded(shown), 'Sleep ending the shown session', 10_000)
  expect(logOf(laptop.folder, 'labels.log')).toContain('t0 anyhost.session=')
  expect(Object.keys((await sharedIn(relay)).archived ?? {})).toEqual([])
}, 60_000)

test('an idle session counts its stop time from the later of going idle and the last time a screen showed it, so one a screen showed 100 s ago and one that went idle 100 s ago stay', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const anHourAgo = Date.now() - 3_600_000
  const seen = claudeIn(laptop, 't0', OTHER_SESSION, 'idle', anHourAgo)
  const justIdle = claudeIn(laptop, 't1', THIRD_SESSION, 'idle', Date.now() - 100_000)
  const unseen = claudeIn(laptop, 't2', SESSION, 'idle', anHourAgo)
  coreSays(laptop.folder, {
    seq: 1,
    terminals: [
      terminalIn('t0', CLAUDE, { 'anyhost.session': OTHER_SESSION, 'anyhost.shown.device-desktop': String(Date.now() - 100_000) }),
      terminalIn('t1', CLAUDE, { 'anyhost.session': THIRD_SESSION, 'anyhost.shown.device-desktop': String(anHourAgo) }),
      terminalIn('t2', CLAUDE, { 'anyhost.session': SESSION }),
    ],
  })

  await serveOn({ ...laptop.env, ANYHOST_STOP_MS: '120000' })
  await until(() => hasEnded(unseen), 'the unseen idle session ending', 15_000)

  expect([hasEnded(seen), hasEnded(justIdle)]).toEqual([false, false])
}, 60_000)

test('an open or a message restarts an idle session\'s stop time, as T3 Code touches a session at each use, so one idle for an hour that an agent opened stays', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const anHourAgo = Date.now() - 3_600_000
  const opened = claudeIn(laptop, 't0', OTHER_SESSION, 'idle', anHourAgo)
  const unopened = claudeIn(laptop, 't1', SESSION, 'idle', anHourAgo)
  coreSays(laptop.folder, { seq: 1, terminals: [] })
  await serveOn({ ...laptop.env, ANYHOST_STOP_MS: '120000' })

  expect(await anyhostOn(laptop.env, ['open', OTHER_SESSION, '--json'])).toMatchObject({ code: 0 })
  coreSays(laptop.folder, coreEvent('created', 't0', terminalIn('t0', CLAUDE, { 'anyhost.session': OTHER_SESSION })))
  coreSays(laptop.folder, coreEvent('created', 't1', terminalIn('t1', CLAUDE, { 'anyhost.session': SESSION })))
  await until(() => hasEnded(unopened), 'the unopened idle session ending', 45_000)

  expect(hasEnded(opened)).toBe(false)
}, 90_000)

test("a 0.9.0 runner asleep, also one whose session runs elsewhere, is closed without archiving its session, and every other terminal, an awake runner too, stays", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const runnerOf = (session: string): string[] => ['anyhost', 'run', '--asleep', '--session', session]
  const runnerTerminal = (address: string, session: string, pid: number) => ({ ...terminalIn(address, ['sh', '-c', 'exec anyhost "$@"', ...runnerOf(session)], { 'anyhost.session': session }, runnerOf(session)), pid, foreground: { argv: runnerOf(session), pid } })
  claudeIn(laptop, 't9', FOURTH_SESSION, 'idle')
  const elsewhere = spawnForTest(['sleep', '600'])
  const awake = spawnForTest(['sh', '-c', 'sleep 600 & echo $!; wait'])
  const reader = awake.stdout.getReader()
  let printed = ''
  while (!printed.includes('\n')) printed += decoder.decode((await reader.read()).value)
  const awakeClaude = Number(printed.trim())
  writeFileSync(join(laptop.env['CLAUDE_CONFIG_DIR'] ?? '', 'sessions', `${awakeClaude}.json`), JSON.stringify({ pid: awakeClaude, sessionId: THIRD_SESSION, procStart: startOf(awakeClaude), kind: 'interactive', status: 'busy', statusUpdatedAt: Date.now() }))
  coreSays(laptop.folder, {
    seq: 1,
    terminals: [
      runnerTerminal('t1', OTHER_SESSION, 4000),
      terminalIn('t2', SHELL, {}),
      runnerTerminal('t3', THIRD_SESSION, awake.pid),
      runnerTerminal('t4', FOURTH_SESSION, elsewhere.pid),
    ],
  })

  await serveOn(laptop.env)
  await until(() => ['kill t1', 'kill t4'].every((call) => logOf(laptop.folder, 'calls.log').includes(call)), 'the program closing the leftovers', 15_000)
  await Bun.sleep(1500)

  expect(logOf(laptop.folder, 'calls.log').filter((line) => line.startsWith('kill')).sort()).toEqual(['kill t1', 'kill t4'])
  expect(logOf(laptop.folder, 'labels.log').sort()).toEqual(['t1 anyhost.session=', 't4 anyhost.session='])
  expect(Object.keys((await sharedIn(relay)).archived ?? {})).toEqual([])
}, 60_000)

test("after a herdr-core restart gives a session's kept terminal a shell, the session resumes in that same terminal, so its tab and split stay, once, and a kept shell of a session this machine cannot resume is closed", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  laptop.claude.kill('SIGKILL')
  await laptop.claude.exited
  coreSays(laptop.folder, { seq: 1, terminals: [terminalIn('t0', SHELL, { 'anyhost.session': SESSION }), terminalIn('t1', SHELL, { 'anyhost.session': OTHER_SESSION }), terminalIn('t2', SHELL, {})] })

  await until(() => logOf(laptop.folder, 'calls.log').includes('kill t1') && sentOn(laptop.folder).length > 0, 'the program resuming t0 and closing t1', 15_000)
  await Bun.sleep(2000)

  expect(sentOn(laptop.folder).map((line) => line.split(' ').slice(0, 2).concat(line.split(' ').slice(-2)).join(' '))).toEqual([`t0 exec --resume ${SESSION}`])
  expect(logOf(laptop.folder, 'calls.log').filter((line) => line.startsWith('kill'))).toEqual(['kill t1'])
  expect(Object.keys((await sharedIn(relay)).archived ?? {})).toEqual([])
}, 60_000)

test("a Claude Code the Herdr app runs as its terminal's own program gets its session's label, a /clear moves the label to the new session, and a claude a person typed into a shell stays unlabelled", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const recorded = (copy: Subprocess, session: string): void =>
    writeFileSync(join(laptop.env['CLAUDE_CONFIG_DIR'] ?? '', 'sessions', `${copy.pid}.json`), JSON.stringify({ pid: copy.pid, sessionId: session, procStart: startOf(copy.pid), kind: 'interactive', status: 'idle', statusUpdatedAt: Date.now() }))
  const own = spawnForTest(['sleep', '600'])
  const typed = spawnForTest(['sleep', '600'])
  recorded(own, SESSION)
  recorded(typed, THIRD_SESSION)
  coreSays(laptop.folder, { seq: 1, terminals: [{ ...terminalIn('t0', CLAUDE, {}), pid: own.pid, foreground: { argv: CLAUDE, pid: own.pid } }, { ...terminalIn('t1', SHELL, {}), foreground: { argv: CLAUDE, pid: typed.pid } }] })

  await serveOn(laptop.env)
  await until(() => logOf(laptop.folder, 'labels.log').length > 0, 'the program labelling the Claude Code terminal', 15_000)
  coreSays(laptop.folder, coreEvent('labels', 't0', { labels: { 'anyhost.session': SESSION } }))
  recorded(own, OTHER_SESSION)
  await until(() => logOf(laptop.folder, 'labels.log').length > 1, 'the program moving the label at a /clear', 15_000)
  await Bun.sleep(1000)

  expect(logOf(laptop.folder, 'labels.log')).toEqual([`t0 anyhost.session=${SESSION}`, `t0 anyhost.session=${OTHER_SESSION}`])
}, 60_000)

test("closing a session's pane or quitting its agent archives the session once, and an agent that crashes, a terminal the program closes, a herdr-core stop and a computer shutdown archive nothing", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const STOPPED = '55555555-6666-7777-8888-999999999999'
  const SHUT_DOWN = '66666666-7777-8888-9999-000000000000'
  coreSays(laptop.folder, {
    seq: 1,
    terminals: [
      terminalIn('t0', CLAUDE, { 'anyhost.session': SESSION }),
      terminalIn('t1', CLAUDE, { 'anyhost.session': OTHER_SESSION }),
      terminalIn('t2', CLAUDE, { 'anyhost.session': THIRD_SESSION }),
      terminalIn('t3', CLAUDE, { 'anyhost.session': FOURTH_SESSION }),
      terminalIn('t4', CLAUDE, { 'anyhost.session': STOPPED }),
      terminalIn('t5', CLAUDE, { 'anyhost.session': SHUT_DOWN }),
    ],
  })
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')

  coreSays(
    laptop.folder,
    coreEvent('finished', 't3', { exit_code: 1, finished_ms: Date.now(), reason: 'exited', signal: null }),
    coreEvent('finished', 't4', { exit_code: 0, finished_ms: Date.now(), reason: 'server_stop', signal: null }),
    coreEvent('finished', 't5', { exit_code: 0, finished_ms: Date.now(), reason: 'host_shutdown', signal: null }),
    coreEvent('labels', 't2', { labels: { 'anyhost.session': '' } }),
    coreEvent('finished', 't2', { exit_code: 0, finished_ms: Date.now(), reason: 'killed', signal: null }),
    coreEvent('finished', 't1', { exit_code: 0, finished_ms: Date.now(), reason: 'exited', signal: null }),
    coreEvent('finished', 't0', { exit_code: 0, finished_ms: Date.now(), reason: 'killed', signal: null }),
  )
  await until(async () => (await sharedIn(relay)).archived?.[SESSION]?.archived === true && (await sharedIn(relay)).archived?.[OTHER_SESSION]?.archived === true, 'the closed and quit sessions archiving', 15_000)
  await Bun.sleep(2000)

  const archives = relay.puts.filter(({ key }) => key === 'shared.json').map(({ body }) => (JSON.parse(decoder.decode(body)) as { archived?: Record<string, { at: string }> }).archived?.[SESSION]?.at)
  expect(new Set(archives.filter((at) => at !== undefined)).size).toBe(1)
  expect((await sharedIn(relay)).archived?.[THIRD_SESSION]).toBeUndefined()
  expect((await sharedIn(relay)).archived?.[FOURTH_SESSION]).toBeUndefined()
  expect((await sharedIn(relay)).archived?.[STOPPED]).toBeUndefined()
  expect((await sharedIn(relay)).archived?.[SHUT_DOWN]).toBeUndefined()
}, 60_000)

test("quitting a session inside Claude Code archives it, as closing its tab does, and a session end that is no quit, as a /clear's, archives nothing", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)

  await hookOn(laptop.socket, 'ended', laptop.cwd, OTHER_SESSION)
  await hookOn(laptop.socket, 'quit', laptop.cwd)
  await until(async () => (await sharedIn(relay)).archived?.[SESSION]?.archived === true, 'the quit session archiving', 15_000)

  expect((await sharedIn(relay)).archived?.[OTHER_SESSION]).toBeUndefined()
}, 60_000)

test('a Codex started in a terminal is labelled with the session of the rollout it writes, so closing its tab archives it', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const rollout = join(temporaryFolder(), `rollout-2026-11-16T12-00-00-${THIRD_SESSION}.jsonl`)
  writeFileSync(rollout, '')
  const codex = spawnForTest(['perl', '-e', 'open(my $f, ">>", $ARGV[0]) or die; $f->autoflush(1); print $f "{}\\n"; sleep 600', rollout])
  coreSays(laptop.folder, { seq: 1, terminals: [terminalIn('t0', SHELL, {})] })
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  await until(() => Bun.file(rollout).size > 0, 'the stand-in holding its rollout open', 15_000)

  coreSays(laptop.folder, coreEvent('foreground', 't0', { pid: codex.pid, name: 'codex', argv: ['/opt/homebrew/bin/codex'], cwd: '/' }))
  await until(() => logOf(laptop.folder, 'labels.log').includes(`t0 anyhost.session=${THIRD_SESSION}`), 'the program labelling the Codex terminal', 15_000)
  coreSays(laptop.folder, coreEvent('labels', 't0', { labels: { 'anyhost.session': THIRD_SESSION } }), coreEvent('finished', 't0', { exit_code: 0, finished_ms: Date.now(), reason: 'killed', signal: null }))
  await until(async () => (await sharedIn(relay)).archived?.[THIRD_SESSION]?.archived === true, 'the closed Codex session archiving', 15_000)
}, 60_000)

test("a process's parent, the files it holds open, its command line and its current folder read from the system with no process started", async () => {
  const folder = realpathSync(temporaryFolder())
  const held = join(folder, 'held.jsonl')
  writeFileSync(held, '')
  const argv = ['perl', '-e', 'open(my $f, ">>", $ARGV[0]) or die; $f->autoflush(1); print $f "{}\\n"; sleep 600', held]
  const child = spawnForTest(argv, { cwd: folder })
  await until(() => Bun.file(held).size > 0, 'the child holding its file open')
  const spawns = [spyOn(Bun, 'spawn'), spyOn(Bun, 'spawnSync')]
  onTestFinished(() => {
    for (const spawn of spawns) spawn.mockRestore()
  })

  expect(processes()).toContainEqual({ pid: child.pid, parent: process.pid })
  expect(familyOf(process.pid)).toContain(child.pid)
  expect(openFilesOf(child.pid)).toContain(held)
  expect(commandOf(child.pid)).toBe(argv.join(' '))
  expect(currentFolderOf(child.pid)).toBe(folder)
  expect(spawns.map((spawn) => spawn.mock.calls.length)).toEqual([0, 0])
})

test('a terminal two windows show stays shown while either shows it, keeps the time a screen last showed it, and a session is marked read once', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  coreSays(laptop.folder, { seq: 1, terminals: [terminalIn('t0', CLAUDE, { 'anyhost.session': SESSION })] })
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const shownLabels = (): string[] => logOf(laptop.folder, 'labels.log').filter((line) => line.includes(`anyhost.shown.${LAPTOP.id}=`))

  const first = await anyhostOn(laptop.env, ['shown', 'window-a', 't0'])
  const second = await anyhostOn(laptop.env, ['shown', 'window-b', 't0'])
  await until(async () => (await sharedIn(relay)).visited?.[SESSION] !== undefined, 'the shown session marked read', 15_000)
  await anyhostOn(laptop.env, ['shown', 'window-a'])
  await Bun.sleep(1000)
  const whileOneShows = shownLabels()
  await anyhostOn(laptop.env, ['shown', 'window-b'])
  await Bun.sleep(1000)

  expect([first.code, second.code]).toEqual([0, 0])
  expect(whileOneShows).toEqual([expect.stringMatching(new RegExp(`^t0 anyhost\\.shown\\.${LAPTOP.id}=\\d+$`))])
  expect(shownLabels()).toEqual(whileOneShows)
  const visits = relay.puts.filter(({ key }) => key === 'shared.json').map(({ body }) => (JSON.parse(decoder.decode(body)) as { visited?: Record<string, string> }).visited?.[SESSION])
  expect(new Set(visits.filter((at) => at !== undefined)).size).toBe(1)
}, 60_000)
