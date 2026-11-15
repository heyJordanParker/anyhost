import { expect, onTestFinished, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeStart, resumeArgv, resumedOf, startOf } from '../src/claude.ts'
import { memoryRelay, until } from './memory.ts'
import { anyhostOn, coreEvent, coreSays, decoder, LAPTOP, logOf, machineFor, OTHER_SESSION, serveOn, SESSION, sharedIn, spawnForTest, temporaryFolder, terminalIn } from './program.ts'

const SHELL = ['/bin/zsh', '-l']
const CLAUDE = ['claude']
const THIRD_SESSION = '33333333-4444-5555-6666-777777777777'
const FOURTH_SESSION = '44444444-5555-6666-7777-888888888888'

type Machine = Awaited<ReturnType<typeof machineFor>>

const claudeIn = (machine: Machine, address: string, session: string, status: string): Subprocess => {
  const copy = spawnForTest(['sleep', '600'])
  writeFileSync(join(machine.env['CLAUDE_CONFIG_DIR'] ?? '', 'sessions', `${copy.pid}.json`), JSON.stringify({ pid: copy.pid, sessionId: session, procStart: startOf(copy.pid), kind: 'interactive', status, statusUpdatedAt: Date.now() - 10_000 }))
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

test('a resumed session runs on the model and effort its last turn ran with', async () => {
  const transcript = join(temporaryFolder(), `${SESSION}.jsonl`)
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"}}\n{"type":"assistant","message":{"model":"claude-haiku-5-5"},"effort":"medium"}\n`)

  expect(resumeArgv(SESSION, await resumedOf(transcript))).toEqual(['claude', '--model', 'claude-haiku-5-5', '--effort', 'medium', '--resume', SESSION])
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

test("a 0.9.0 terminal that holds no Claude Code, a kept shell or an asleep runner, is closed without archiving its session, and every other terminal stays", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const asleep = ['anyhost', 'run', '--asleep', '--session', OTHER_SESSION]
  coreSays(laptop.folder, {
    seq: 1,
    terminals: [
      terminalIn('t0', SHELL, { 'anyhost.session': SESSION }),
      terminalIn('t1', ['sh', '-c', 'exec anyhost "$@"', ...asleep], { 'anyhost.session': OTHER_SESSION }, asleep),
      terminalIn('t2', SHELL, {}),
      terminalIn('t3', CLAUDE, { 'anyhost.session': THIRD_SESSION }),
    ],
  })

  await serveOn(laptop.env)
  await until(() => ['kill t0', 'kill t1'].every((call) => logOf(laptop.folder, 'calls.log').includes(call)), 'the program closing both leftovers', 15_000)
  await Bun.sleep(1500)

  expect(logOf(laptop.folder, 'calls.log').filter((line) => line.startsWith('kill'))).toEqual(['kill t0', 'kill t1'])
  expect(logOf(laptop.folder, 'labels.log')).toEqual(['t0 anyhost.session=', 't1 anyhost.session='])
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

test("closing a session's pane archives the session once, and a Claude Code that exits by itself or a terminal the program closes archives nothing", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  coreSays(laptop.folder, {
    seq: 1,
    terminals: [terminalIn('t0', CLAUDE, { 'anyhost.session': SESSION }), terminalIn('t1', CLAUDE, { 'anyhost.session': OTHER_SESSION }), terminalIn('t2', CLAUDE, { 'anyhost.session': THIRD_SESSION })],
  })
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')

  coreSays(
    laptop.folder,
    coreEvent('finished', 't1', { exit_code: 0, finished_ms: Date.now(), reason: 'exited', signal: null }),
    coreEvent('labels', 't2', { labels: { 'anyhost.session': '' } }),
    coreEvent('finished', 't2', { exit_code: 0, finished_ms: Date.now(), reason: 'killed', signal: null }),
    coreEvent('finished', 't0', { exit_code: 0, finished_ms: Date.now(), reason: 'killed', signal: null }),
  )
  await until(async () => (await sharedIn(relay)).archived?.[SESSION]?.archived === true, 'the closed session archiving', 15_000)
  await Bun.sleep(2000)

  const archives = relay.puts.filter(({ key }) => key === 'shared.json').map(({ body }) => (JSON.parse(decoder.decode(body)) as { archived?: Record<string, { at: string }> }).archived?.[SESSION]?.at)
  expect(new Set(archives.filter((at) => at !== undefined)).size).toBe(1)
  expect((await sharedIn(relay)).archived?.[OTHER_SESSION]).toBeUndefined()
  expect((await sharedIn(relay)).archived?.[THIRD_SESSION]).toBeUndefined()
}, 60_000)

test('a terminal two windows show stays shown while either shows it, and a session is marked read once', async () => {
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
  await until(() => shownLabels().length > whileOneShows.length, 'the label leaving the terminal no window shows')

  expect([first.code, second.code]).toEqual([0, 0])
  expect(whileOneShows).toEqual([expect.stringMatching(new RegExp(`^t0 anyhost\\.shown\\.${LAPTOP.id}=\\d+$`))])
  expect(shownLabels().at(-1)).toBe(`t0 anyhost.shown.${LAPTOP.id}=`)
  const visits = relay.puts.filter(({ key }) => key === 'shared.json').map(({ body }) => (JSON.parse(decoder.decode(body)) as { visited?: Record<string, string> }).visited?.[SESSION])
  expect(new Set(visits.filter((at) => at !== undefined)).size).toBe(1)
}, 60_000)
