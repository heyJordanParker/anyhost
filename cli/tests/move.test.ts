import { expect, onTestFinished, test } from 'bun:test'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decompress, hotKey } from '../src/capture.ts'
import { isPaused } from '../src/claude.ts'
import { memoryRelay, statusOn, until } from './memory.ts'
import { claimOn, decoder, keepsWriting, LAPTOP, postTo, roots, runningOn, runsOn, script, serveOn, SESSION, stepsOf, WORKER, workerOn } from './program.ts'

const OTHER = '99999999-2222-3333-4444-555555555555'

test("a move waits for the turn to end, pauses the laptop's Claude Code, uploads and seals the session, the worker restores it and runs it in a terminal of herdr-core with the same command, and only then the laptop ends its copy", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  let isPausedAsWorkerRan = false
  void until(() => runsOn(worker.folder).length > 0, 'the worker running the session', 60_000).then(() => (isPausedAsWorkerRan = isPaused(laptop.claude.pid)))
  laptop.status('busy')

  const asked = await postTo(laptop.socket, '/move', { session: SESSION.slice(0, 8), machine: WORKER.name })
  expect(asked.status).toBe(200)
  expect(asked.body).toMatchObject({ session: SESSION, to: WORKER.name })
  await Bun.sleep(500)
  const waiting = (await claimOn(laptop.socket)).move
  expect(waiting).toEqual({ to: WORKER.name, step: 'waiting', line: `Waiting for ${SESSION.slice(0, 8)} to finish its turn.` })
  laptop.status('idle')
  const { steps, last } = await stepsOf(laptop.socket, undefined, [waiting?.step ?? ''])

  expect(steps).toEqual(['waiting', 'uploading', 'moving', 'moved'])
  expect(last.line).toMatch(new RegExp(`^${WORKER.name} restored ${SESSION.slice(0, 8)} in \\d+\\.\\d s and runs it\\.$`))
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  expect((await relay.keys(`journals/${SESSION}/`)).every((key) => key.includes('/sealed/'))).toBe(true)
  const workerHome = worker.env['HOME'] ?? ''
  const workerCwd = join(workerHome, 'work')
  expect(readFileSync(join(workerCwd, 'notes.txt'), 'utf8')).toBe('the plan for the trip\n')
  expect(readFileSync(join(workerHome, '.claude', 'projects', workerCwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`), 'utf8')).toContain(`"cwd":"${workerCwd}"`)
  const [started, ...more] = runsOn(worker.folder)
  expect(more).toEqual([])
  expect(started).toMatchObject({ session: SESSION, command: 'claude' })
  expect(realpathSync(started?.cwd ?? '')).toBe(realpathSync(workerCwd))
  expect(isPausedAsWorkerRan).toBe(true)
  await laptop.claude.exited
  expect(laptop.claude.signalCode).toBe('SIGTERM')
  expect(await claimOn(laptop.socket)).toMatchObject({ machine: WORKER.name, move: { step: 'moved' } })
}, 60_000)

test('a move waits out the turn that starts as one ends, as a background command\'s note starts one, and stops the copy only once idle held for 2 s', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await workerOn(relay)
  laptop.status('busy')
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await stepsOf(laptop.socket, new Set(['waiting']))

  laptop.status('idle')
  await Bun.sleep(500)
  laptop.status('busy')
  await Bun.sleep(3000)
  const isRunning = laptop.claude.exitCode === null && laptop.claude.signalCode === null
  laptop.status('idle')
  const { last } = await stepsOf(laptop.socket)

  expect(isRunning).toBe(true)
  expect(last.step).toBe('moved')
  await laptop.claude.exited
  expect(laptop.claude.signalCode).toBe('SIGTERM')
}, 60_000)

test('a move of a session whose first frame R2 lost uploads its files whole again, and the worker restores every byte', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"Book the train"}}\n`, { flag: 'a' })
  await until(() => relay.puts.some(({ key, body }) => key.includes('/hot/') && decoder.decode(decompress(body)).includes('Book the train')), 'the second line uploading', 15_000)
  await relay.objects.delete(hotKey(SESSION, 0))
  const worker = await workerOn(relay)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  expect(await relay.keys(`journals/${SESSION}/hot/`)).toEqual([])
  const workerHome = worker.env['HOME'] ?? ''
  const workerCwd = join(workerHome, 'work')
  const restored = readFileSync(join(workerHome, '.claude', 'projects', workerCwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`), 'utf8')
  expect(restored).toBe(readFileSync(laptop.transcript, 'utf8').replaceAll(laptop.env['HOME'] ?? '', workerHome))
  expect(readFileSync(join(workerCwd, 'notes.txt'), 'utf8')).toBe('the plan for the trip\n')
}, 60_000)

test('a move to a machine that is offline keeps the session here, with its claim, running on in the Claude Code the move paused', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await relay.join(WORKER, roots('/home/worker'))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.line).toBe(`${WORKER.name} is offline, so the session keeps running here.`)
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(isPaused(laptop.claude.pid)).toBe(false)
  expect(laptop.claude.exitCode ?? laptop.claude.signalCode).toBeNull()
  expect(runsOn(laptop.folder)).toEqual([])
}, 60_000)

test('a move the worker cannot take takes the claim back, the paused Claude Code runs on, and the laptop captures the session again', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'fail'), 'Claude Code is not logged in.'))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.line).toStartWith(`${WORKER.name} could not take the session: `)
  expect(last.line).toContain('Claude Code is not logged in.')
  expect(last.line).toEndWith('. It keeps running here.')
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  await until(async () => (await claimOn(worker.socket)).machine === LAPTOP.name, 'the worker hearing it lost the session')
  expect(isPaused(laptop.claude.pid)).toBe(false)
  expect(laptop.claude.exitCode ?? laptop.claude.signalCode).toBeNull()
  expect(runsOn(laptop.folder)).toEqual([])
  const frames = relay.puts.filter(({ key }) => key.startsWith(`journals/${SESSION}/hot/`)).length
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`, { flag: 'a' })
  await until(() => relay.puts.filter(({ key }) => key.startsWith(`journals/${SESSION}/hot/`)).length > frames, 'the next line uploading', 15_000)
}, 60_000)

test('a move waiting for the turn to end goes on to uploading once the record says idle, though the watcher drops every change', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await relay.join(WORKER, roots('/home/worker'))
  laptop.child.kill('SIGTERM')
  await laptop.child.exited
  await serveOn({ ...laptop.env, ANYHOST_WATCHER_DROPS: '1' })
  await until(async () => (await statusOn(laptop.socket)).relay.state === 'connected', 'the laptop connecting again')
  await Bun.sleep(3000)
  laptop.status('busy')
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await stepsOf(laptop.socket, new Set(['waiting']))

  laptop.status('idle')
  const idleAt = Date.now()
  const { steps } = await stepsOf(laptop.socket, new Set(['uploading', 'failed']), ['waiting'])
  expect(steps).toEqual(['waiting', 'uploading'])
  expect(Date.now() - idleAt).toBeLessThan(5000)
}, 60_000)

test('a move of a session that gains a line every 50 ms after its turn ended reaches moved within 20 s, and the worker restores every line up to its last drain', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  const writer = keepsWriting(laptop)
  await Bun.sleep(500)
  const before = writer.written()

  const asked = Date.now()
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)
  const took = Date.now() - asked
  writer.stop()

  expect(last.step).toBe('moved')
  expect(took).toBeLessThan(20_000)
  const workerHome = worker.env['HOME'] ?? ''
  const workerCwd = join(workerHome, 'work')
  const restored = readFileSync(join(workerHome, '.claude', 'projects', workerCwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`), 'utf8').split('\n').filter((line) => line !== '')
  const written = readFileSync(laptop.transcript, 'utf8').replaceAll(laptop.env['HOME'] ?? '', workerHome).split('\n').filter((line) => line !== '')
  expect(restored.length).toBeGreaterThan(before)
  expect(restored).toEqual(written.slice(0, restored.length))
}, 60_000)

test('at uploadEvery 0 a move of a session that gains a line every 50 ms while its code waits reaches moved within 20 s, and the worker restores its code', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay, LAPTOP, { uploadEvery: 0 })
  const worker = await workerOn(relay)
  const code = crypto.getRandomValues(new Uint8Array(2 ** 19))
  writeFileSync(join(laptop.cwd, 'map.bin'), code)
  relay.delayMs = 100
  const writer = keepsWriting(laptop)
  await Bun.sleep(500)

  const asked = Date.now()
  const before = relay.requests.length
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await until(() => relay.requests.slice(before).some((ops) => ops.some((op) => op.op === 'list' && op.prefix === `journals/${SESSION}/`)), 'the seal listing the journal', 20_000)
  relay.delayMs = 0
  const { last } = await stepsOf(laptop.socket)
  const took = Date.now() - asked
  writer.stop()

  expect(last.step).toBe('moved')
  expect(took).toBeLessThan(20_000)
  expect(Buffer.from(readFileSync(join(worker.env['HOME'] ?? '', 'work', 'map.bin'))).equals(Buffer.from(code))).toBe(true)
}, 60_000)

test('a move of a session that keeps writing while its code cannot be read ends failed with the reason of the read it waited on', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await workerOn(relay)
  Bun.spawnSync(['git', 'init', '-q', laptop.cwd])
  writeFileSync(join(laptop.cwd, '.git', 'index'), 'not an index')
  script(join(laptop.folder, 'bin', 'git'), `#!/bin/bash\ncase " $* " in *" ls-files "*) sleep 2 ;; esac\nexec '${Bun.which('git') ?? 'git'}' "$@"\n`)
  const writer = keepsWriting(laptop)
  await Bun.sleep(500)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)
  writer.stop()

  expect(last.step).toBe('failed')
  expect(last.line).toStartWith(`anyhost could not move the session to ${WORKER.name}: anyhost could not read the code of ${SESSION.slice(0, 8)}: `)
  expect(last.line).toContain(': index file ')
  expect(last.line).toEndWith('. It keeps running here.')
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
}, 60_000)

test('a program that restarts while a move paused its copy resumes that copy once the relay welcomes it, as this machine still holds the session, and leaves a copy the person suspended suspended', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const suspended = Bun.spawn(['sleep', '600'], { detached: true })
  onTestFinished(() => suspended.kill('SIGKILL'))
  writeFileSync(join(laptop.env['HOME'] ?? '', '.claude', 'sessions', `${suspended.pid}.json`), JSON.stringify({ pid: suspended.pid, sessionId: OTHER, kind: 'interactive', cwd: laptop.cwd, status: 'idle' }))
  suspended.kill('SIGSTOP')
  laptop.child.kill('SIGTERM')
  await laptop.child.exited
  const paused = join(laptop.env['XDG_STATE_HOME'] ?? '', 'anyhost', 'paused')
  mkdirSync(paused, { recursive: true })
  writeFileSync(join(paused, `${SESSION}.json`), JSON.stringify([laptop.claude.pid]))
  laptop.claude.kill('SIGSTOP')

  await serveOn(laptop.env)

  await until(() => !isPaused(laptop.claude.pid), 'the program resuming the paused copy', 15_000)
  expect(laptop.claude.exitCode ?? laptop.claude.signalCode).toBeNull()
  expect(isPaused(suspended.pid)).toBe(true)
}, 60_000)

test('a moved copy here that ignores its SIGTERM ends with SIGKILL 10 s later, and the move reaches moved, with no problem in /status', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay, LAPTOP, {}, ['bash', '-c', "trap '' TERM; while true; do sleep 1; done"])
  await workerOn(relay)

  const askedAt = Date.now()
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { steps } = await stepsOf(laptop.socket, new Set(['moving', 'failed']))
  const { last } = await stepsOf(laptop.socket, undefined, steps)

  expect(last.step).toBe('moved')
  expect(steps).toEqual(['uploading', 'moving'])
  expect(Date.now() - askedAt).toBeGreaterThan(9000)
  await laptop.claude.exited
  expect(laptop.claude.signalCode).toBe('SIGKILL')
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  const { problems } = await statusOn(laptop.socket)
  expect(problems.filter((problem) => problem.includes(`move ${SESSION}`))).toEqual([])
}, 60_000)
