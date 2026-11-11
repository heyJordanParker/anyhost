import { expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryRelay, until, welcomed } from './memory.ts'
import { claimOn, CLI, copiesOn, decoder, isUploaded, keepsWriting, killAfterTest, LAPTOP, postTo, roots, runningOn, runsOn, SESSION, stepsOf, WORKER, workerOn } from './program.ts'

test('a move to a worker that took the claim and then goes offline waits, saying so in its line and in anyhost move, which Ctrl-C leaves running, and Keep it here takes the session back', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const silent = relay.connect(WORKER, roots('/home/worker'))
  silent.on('move', ({ session }) => {
    for (const ran of silent.run([{ op: 'claim', session, take: true }])) ran.catch(() => undefined)
  })
  await welcomed(silent)
  const waiting = `${WORKER.name} took ${SESSION.slice(0, 8)} and does not answer. Keep it here takes the session back.`

  const moving = Bun.spawn(['bun', CLI, 'move', SESSION.slice(0, 8), WORKER.name], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  killAfterTest(moving)
  let printed = ''
  const reading = (async () => {
    for await (const chunk of moving.stdout) printed += decoder.decode(chunk)
  })()
  await until(async () => (await relay.claims()).get(SESSION) === WORKER.id, 'the worker taking the claim', 30_000)
  relay.disconnect(WORKER.id)
  await until(async () => (await claimOn(laptop.socket)).move?.line === waiting, 'the move saying the worker does not answer', 30_000)
  await Bun.sleep(12_000)
  expect((await claimOn(laptop.socket)).move).toEqual({ to: WORKER.name, step: 'moving', line: waiting })
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  await until(() => printed.includes(`${waiting}\n`), 'anyhost move printing the line')
  moving.kill('SIGINT')
  const [code] = await Promise.all([moving.exited, reading])
  expect(code).toBe(130)
  expect(printed.trimEnd().split('\n').at(-1)).toBe(`The move of ${SESSION.slice(0, 8)} to ${WORKER.name} goes on. Keep it here in the session takes the session back.`)
  expect((await claimOn(laptop.socket)).move?.step).toBe('moving')
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `${WORKER.name} did not answer, so the session keeps running here.` })
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
}, 90_000)

test("Keep it here after a moved the laptop never heard, from a worker that ran the session and wrote to it, leaves the laptop taking the next prompt and capturing it with no fork, and stops the worker's copy", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay, (folder) => {
    writeFileSync(join(folder, 'appends'), `{"type":"permission-mode","permissionMode":"default","sessionId":"${SESSION}"}\n`)
    writeFileSync(join(folder, 'unlisted'), '')
  })
  const held = relay.holdNext('moved')

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await until(() => isUploaded(relay, SESSION, '"permission-mode"'), 'the worker uploading what its resume wrote', 30_000)
  rmSync(join(worker.folder, 'unlisted'))
  const release = await held
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)
  await until(() => copiesOn(worker.folder).some((copy) => !copy.isRunning), 'the worker stopping its copy as the laptop took the session back')
  release()

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `${WORKER.name} did not answer, so the session keeps running here.` })
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`, { flag: 'a' })
  await until(() => isUploaded(relay, SESSION, 'And the hotel'), 'the next prompt uploading', 15_000)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.logged()).not.toContain('Another machine wrote byte')
  expect(laptop.claude.exitCode).toBeNull()
}, 90_000)

test("Keep it here before the worker's take lands keeps the session with the laptop once that take comes, starts no copy on the worker, and the laptop takes the next prompt", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  const held = relay.holdNext('move')

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const release = await held
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  release()
  const { last } = await stepsOf(laptop.socket)
  await until(() => worker.logged().includes(`could not take ${SESSION} from ${LAPTOP.name}`), 'the worker refusing the move', 30_000)

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `${WORKER.name} did not answer, so the session keeps running here.` })
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect(runsOn(worker.folder)).toEqual([])
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`, { flag: 'a' })
  await until(() => isUploaded(relay, SESSION, 'And the hotel'), 'the next prompt uploading', 15_000)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
}, 60_000)

test('Keep it here while the move waits for the turn to end keeps the session here, with its claim', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await relay.join(WORKER, roots('/home/worker'))
  laptop.status('busy')

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await stepsOf(laptop.socket, new Set(['waiting']))
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `Kept ${SESSION.slice(0, 8)} here, so it does not move to ${WORKER.name}.` })
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(400)
}, 60_000)

test("Keep it here while a session that keeps writing uploads ends the move's drains, so the session's puts come at the program's uploadEvery from then on", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await relay.join(WORKER, roots('/home/worker'))
  const writer = keepsWriting(laptop)
  relay.delayMs = 300

  const asked = await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  expect(asked.body['step']).toBe('uploading')
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)
  await Bun.sleep(1000)
  const frames = (): number => relay.puts.filter(({ key }) => key.startsWith(`journals/${SESSION}/hot/`)).length
  const kept = frames()
  await Bun.sleep(6000)
  const after = frames() - kept
  writer.stop()

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `Kept ${SESSION.slice(0, 8)} here, so it does not move to ${WORKER.name}.` })
  expect(after).toBeGreaterThan(0)
  expect(after).toBeLessThanOrEqual(2)
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
}, 60_000)
