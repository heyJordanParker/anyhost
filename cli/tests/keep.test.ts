import { expect } from 'bun:test'
import { test } from './test.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../src/capture.ts'
import { followHolders } from '../src/claims.ts'
import { memoryRelay, until, welcomed } from './memory.ts'
import { claimOn, CLI, copiesOn, decoder, DESKTOP, isUploaded, keepsWriting, LAPTOP, postTo, roots, runningOn, runsOn, SESSION, spawnForTest, stepsOf, WORKER, workerOn } from './program.ts'

test('a move to a worker that took the claim and then goes offline waits, saying so in its line and in anyhost move, which Ctrl-C leaves running, and Keep it here takes the session back', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const silent = relay.connect(WORKER, roots('/home/worker'))
  silent.on('claimed', ({ session, device, wanted }) => {
    if (wanted === WORKER.id && device === '') for (const ran of silent.run([{ op: 'claim', session, take: true }])) ran.catch(() => undefined)
  })
  await welcomed(silent)
  const waiting = `${WORKER.name} took ${SESSION.slice(0, 8)} and restores it. Keep it here takes the session back.`

  const moving = spawnForTest(['bun', CLI, 'move', SESSION.slice(0, 8), WORKER.name], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  let printed = ''
  const reading = (async () => {
    for await (const chunk of moving.stdout) printed += decoder.decode(chunk)
  })()
  await until(async () => (await relay.claims()).get(SESSION) === WORKER.id, 'the worker taking the claim', 30_000)
  relay.disconnect(WORKER.id)
  await until(async () => (await claimOn(laptop.socket)).move?.line === waiting, 'the move saying the worker took the session', 30_000)
  expect((await claimOn(laptop.socket)).move).toEqual({ to: WORKER.name, step: 'moving', line: waiting })
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
  expect(await relay.wanted()).toEqual(new Map())
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
}, 90_000)

test("Keep it here after the worker ran the session and wrote to it, before it marked the move done, brings the session back, leaves the laptop taking the next prompt with no fork, and stops the worker's copy", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'appends'), `{"type":"permission-mode","permissionMode":"default","sessionId":"${SESSION}"}\n`))
  let release = (): void => undefined
  const done = new Promise<void>((resolve) => (release = resolve))
  relay.before = (op) => (op.op === 'want' && op.device === '' && op.if?.wanted === WORKER.id ? done : undefined)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await until(() => isUploaded(relay, SESSION, '"permission-mode"'), 'the worker uploading what its resume wrote', 30_000)
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  release()
  const { last } = await stepsOf(laptop.socket)
  await until(() => copiesOn(worker.folder).some((copy) => !copy.isRunning), 'the worker stopping its copy as the laptop took the session back', 30_000)

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `Kept ${SESSION.slice(0, 8)} here, so it does not move to ${WORKER.name}.` })
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`, { flag: 'a' })
  await until(() => isUploaded(relay, SESSION, 'And the hotel'), 'the next prompt uploading', 15_000)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.logged()).not.toContain('Another machine wrote byte')
  expect(laptop.claude.exitCode).toBeNull()
}, 90_000)

test("Keep it here before the worker takes the claim keeps the session with the laptop, starts no copy on the worker, and the laptop takes the next prompt", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  let release = (): void => undefined
  const held = new Promise<void>((resolve) => (release = resolve))
  relay.before = (op) => (op.op === 'forget' ? held : undefined)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await until(() => relay.requests.some((ops) => ops.some((op) => op.op === 'forget')), 'the laptop handing the session over', 30_000)
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  release()
  const { last } = await stepsOf(laptop.socket)

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `Kept ${SESSION.slice(0, 8)} here, so it does not move to ${WORKER.name}.` })
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect(await relay.wanted()).toEqual(new Map())
  expect(runsOn(worker.folder)).toEqual([])
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`, { flag: 'a' })
  await until(() => isUploaded(relay, SESSION, 'And the hotel'), 'the next prompt uploading', 15_000)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
}, 60_000)

test('Keep it here while the move waits for the turn to end keeps the session here, with its claim', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await workerOn(relay)
  laptop.status('busy')

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await stepsOf(laptop.socket, new Set(['waiting']))
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `Kept ${SESSION.slice(0, 8)} here, so it does not move to ${WORKER.name}.` })
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  await until(async () => (await relay.wanted()).size === 0, 'the laptop dropping the move')
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(400)
}, 60_000)

test("Keep it here that another process on the laptop's database hears first still drops the move once the program hears it", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await workerOn(relay)
  const kept = Promise.withResolvers<void>()
  const dropped = Promise.withResolvers<void>()
  let isKept = false
  followHolders(relay.connect(DESKTOP, roots('/home/desktop')), openDatabase(join(laptop.env['XDG_STATE_HOME'] ?? '', 'anyhost')), async (changes) => {
    for (const { session, device, wanted } of changes) {
      if (session !== SESSION) continue
      if (wanted === LAPTOP.id) {
        isKept = true
        kept.resolve()
      } else if (isKept && wanted === '' && device === LAPTOP.id) dropped.resolve()
    }
  })
  const hear = relay.withholdClaimed(LAPTOP.id)
  laptop.status('busy')

  expect((await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })).body['step']).toBe('waiting')
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  await kept.promise
  hear()
  await dropped.promise

  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect(await relay.wanted()).toEqual(new Map())
  expect(laptop.claude.exitCode).toBeNull()
}, 60_000)

test("Keep it here while a session that keeps writing uploads ends the move's drains, so the session's puts come at the program's uploadEvery from then on", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await workerOn(relay)
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
