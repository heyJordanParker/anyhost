import { expect, test } from 'bun:test'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openCapture, openDatabase } from '../src/capture.ts'
import { memoryRelay, noCode, statusOn, until, welcomed } from './memory.ts'
import { claimOn, DESKTOP, isUploaded, killMachine, LAPTOP, postTo, roots, runningOn, runsOn, serveOn, SESSION, spawnForTest, stepsOf, textOfFrame, WORKER, workerOn } from './program.ts'

test('a move whose session another machine takes while it waits ends failed within seconds, the program answering meanwhile, and leaves the session with that machine', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await workerOn(relay)
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await welcomed(desktop)
  laptop.status('busy')
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await stepsOf(laptop.socket, new Set(['waiting']))

  await desktop.run([{ op: 'claim', session: SESSION, take: true }])[0]
  await until(async () => (await claimOn(laptop.socket)).machine === DESKTOP.name, 'the laptop hearing it')
  writeFileSync(join(laptop.cwd, 'notes.txt'), 'the plan for the trip, by train\n')
  laptop.status('idle')
  const idleAt = Date.now()
  const { last } = await stepsOf(laptop.socket)

  expect(Date.now() - idleAt).toBeLessThan(10_000)
  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `${DESKTOP.name} took ${SESSION.slice(0, 8)} over during the move, so it continues there.` })
  const askedAt = Date.now()
  await statusOn(laptop.socket)
  expect(Date.now() - askedAt).toBeLessThan(2000)
  expect((await relay.claims()).get(SESSION)).toBe(DESKTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBe(DESKTOP.name)
}, 60_000)

test('a move whose laptop loses its socket as it hands the session over reaches moved once it connects again, and the worker runs the session once', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  let release = (): void => undefined
  const held = new Promise<void>((resolve) => (release = resolve))
  const handedOver = new Promise<void>((answered) => {
    relay.holdAnswer = (op) => {
      if (op.op !== 'forget') return undefined
      answered()
      return held
    }
  })

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await handedOver
  const reconnect = relay.disconnect(LAPTOP.id)
  await until(() => !relay.isConnected(LAPTOP.id), 'the laptop losing its socket')
  release()
  await until(async () => (await relay.claims()).get(SESSION) === WORKER.id, 'the worker taking the session', 30_000)
  reconnect()
  const { last } = await stepsOf(laptop.socket)

  expect(last).toMatchObject({ to: WORKER.name, step: 'moved' })
  expect(runsOn(worker.folder).filter((run) => run.session === SESSION)).toHaveLength(1)
  expect(await relay.wanted()).toEqual(new Map())
  await laptop.claude.exited
  expect(laptop.claude.signalCode).toBe('SIGTERM')
}, 90_000)

test("a frame the relay refuses with 409, as after a holder change that never reached the program, stops the session's copy here", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay, LAPTOP)
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await welcomed(desktop)
  relay.withholdClaimed(LAPTOP.id)
  expect(await desktop.runOne({ op: 'claim', session: SESSION, take: true })).toEqual({ status: 200, told: true })

  appendFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`)
  await until(() => laptop.claude.signalCode === 'SIGTERM', 'the program stopping the copy', 20_000)
  expect((await claimOn(laptop.socket)).machine).toBe(DESKTOP.name)
}, 60_000)

test("a session another machine took while the program was down stops its copy here at the program's next welcome", async () => {
  const relay = await memoryRelay()
  const worker = await workerOn(relay)
  const workerHome = worker.env['HOME'] ?? ''
  const job = spawnForTest(['sleep', '600'])
  writeFileSync(join(workerHome, '.claude', 'sessions', `${job.pid}.json`), JSON.stringify({ pid: job.pid, sessionId: SESSION, kind: 'interactive', cwd: join(workerHome, 'work'), status: 'idle' }))
  const claimer = relay.connect(WORKER, roots(workerHome))
  expect(await claimer.runOne({ op: 'claim', session: SESSION, take: false })).toEqual({ status: 200, told: true })
  claimer.close()
  killMachine(worker)
  await worker.child.exited
  await until(() => !relay.isConnected(WORKER.id), "the worker's socket closing")
  const laptop = relay.connect(LAPTOP, roots('/home/laptop'))
  expect(await laptop.runOne({ op: 'claim', session: SESSION, take: true })).toMatchObject({ status: 200, told: false })
  const command = openCapture(relay.connect(WORKER, roots(workerHome)), WORKER, roots(workerHome), { db: openDatabase(join(worker.env['XDG_STATE_HOME'] ?? '', 'anyhost')), code: noCode })
  await until(() => command.holders.known().get(SESSION) === LAPTOP.id, 'the command reading the new holder')
  command.relay.close()
  command.db.close()

  await serveOn(worker.env)
  await until(() => job.signalCode === 'SIGTERM', 'the program stopping the copy')
}, 60_000)

test('a holder change stops the copy of a session at a permission prompt, as its record says waiting', async () => {
  const relay = await memoryRelay()
  const worker = await workerOn(relay)
  const workerHome = worker.env['HOME'] ?? ''
  const job = spawnForTest(['sleep', '600'])
  writeFileSync(join(workerHome, '.claude', 'sessions', `${job.pid}.json`), JSON.stringify({ pid: job.pid, sessionId: SESSION, kind: 'interactive', cwd: join(workerHome, 'work'), status: 'waiting' }))
  const claimer = relay.connect(WORKER, roots(workerHome))
  expect(await claimer.runOne({ op: 'claim', session: SESSION, take: false })).toMatchObject({ status: 200, told: true })
  claimer.close()

  const laptop = relay.connect(LAPTOP, roots('/home/laptop'))
  expect(await laptop.runOne({ op: 'claim', session: SESSION, take: true })).toMatchObject({ status: 200 })
  await until(() => worker.logged().includes(`${LAPTOP.name} took ${SESSION} over, so ${WORKER.name} stopped its copy here.`), 'the program stopping the copy at its permission prompt')
  expect(job.signalCode).toBe('SIGTERM')
}, 60_000)

test('a laptop asleep from the hand-over of its move until after the worker reconnected and ran a prompt reaches moved once it wakes, and the worker keeps the session and its turn', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await stepsOf(laptop.socket, new Set(['moving']))
  const wake = relay.silence(LAPTOP.id)
  const asleepAt = Date.now()
  await until(async () => (await relay.claims()).get(SESSION) === WORKER.id && (await relay.wanted()).size === 0, 'the worker running the session', 30_000)
  const reconnect = relay.disconnect(WORKER.id)
  await until(() => !relay.isConnected(WORKER.id), 'the worker losing its socket')
  reconnect()
  await until(() => relay.isConnected(WORKER.id), 'the worker connecting again', 30_000)
  const workerCwd = join(worker.env['HOME'] ?? '', 'work')
  const workerTranscript = join(worker.env['HOME'] ?? '', '.claude', 'projects', workerCwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`)
  appendFileSync(workerTranscript, `{"type":"user","cwd":"${workerCwd}","sessionId":"${SESSION}","message":{"role":"user","content":"Book the hotel"}}\n`)
  await until(() => isUploaded(relay, SESSION, 'Book the hotel'), 'the worker uploading its turn', 30_000)
  const turnAt = relay.puts.findIndex(({ key, body }) => key.startsWith(`journals/${SESSION}/hot/`) && textOfFrame(body).includes('Book the hotel'))
  await Bun.sleep(Math.max(0, 12_000 - (Date.now() - asleepAt)))
  wake()
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  expect(runsOn(worker.folder).filter((run) => run.session === SESSION)).toHaveLength(1)
  const laptopFrames = relay.puts.slice(turnAt + 1).filter(({ key, body }) => key.startsWith(`journals/${SESSION}/`) && textOfFrame(body).includes(`"device":"${LAPTOP.id}"`))
  expect(laptopFrames).toEqual([])
  await laptop.claude.exited
  expect(laptop.claude.signalCode).toBe('SIGTERM')
}, 120_000)
