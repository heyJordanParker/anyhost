import { expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { commandOf, isPaused, processes } from '../src/claude.ts'
import { memoryRelay, until } from './memory.ts'
import { childrenOf, claimOn, copiesOn, LAPTOP, postTo, runningOn, runsOn, serveOn, SESSION, spawnForTest, stepsOf, WORKER, workerOn } from './program.ts'

test("a move to a worker whose program restarts before its Claude Code ran the session runs it there at the program's next start, and reaches moved", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'hang'), '60'))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const isHanging = (): boolean => {
    const run = processes().find(({ pid }) => commandOf(pid).includes(`${worker.folder}/bin/hc run`))
    return run !== undefined && childrenOf(run.pid).some((child) => commandOf(child).split(' ')[0] === 'sleep')
  }
  await until(isHanging, "the worker's first herdr-core hanging", 30_000)
  worker.child.kill('SIGKILL')
  await worker.child.exited
  rmSync(join(worker.folder, 'hang'))
  const killedAt = Date.now()
  await serveOn(worker.env)
  await until(() => relay.isConnected(WORKER.id), 'the worker connecting again')
  const { last } = await stepsOf(laptop.socket)

  expect(Date.now() - killedAt).toBeLessThan(40_000)
  expect(last.step).toBe('moved')
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  expect(await relay.wanted()).toEqual(new Map())
  expect(runsOn(worker.folder).filter((run) => run.session === SESSION)).toHaveLength(2)
  await laptop.claude.exited
  expect(laptop.claude.signalCode).toBe('SIGTERM')
}, 90_000)

test('Keep it here while the worker that took the session is down takes it back, and the worker stops the copy it opened once it starts again and that turn ends', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'hang'), '60'))
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await until(() => runsOn(worker.folder).some((run) => run.session === SESSION), 'the worker starting the session', 30_000)
  worker.child.kill('SIGKILL')
  await worker.child.exited
  const job = spawnForTest(['sleep', '600'])
  const workerHome = worker.env['HOME'] ?? ''
  const record = (status: string): void =>
    writeFileSync(join(workerHome, '.claude', 'sessions', `${job.pid}.json`), JSON.stringify({ pid: job.pid, sessionId: SESSION, kind: 'interactive', cwd: join(workerHome, 'work'), status }))
  record('busy')
  const stops = (): string[] => (job.signalCode === 'SIGTERM' ? ['stopped'] : [])

  await until(async () => (await claimOn(laptop.socket)).move?.line.includes(' and restores it. ') === true, 'the move saying the worker took the session', 30_000)
  await until(() => !relay.isConnected(WORKER.id), "the worker's socket closing")
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)
  await serveOn(worker.env)
  await until(() => relay.isConnected(WORKER.id), 'the worker connecting again')
  await until(async () => (await claimOn(worker.socket)).machine === LAPTOP.name, 'the worker hearing it lost the session')
  await Bun.sleep(1000)
  const stopsInTurn = stops()
  record('idle')
  await until(() => stops().length > 0, 'the worker stopping the job once its turn ended')

  expect(last.line).toBe(`${WORKER.name} did not answer, so the session keeps running here.`)
  expect(stopsInTurn).toEqual([])
  expect(stops()).toHaveLength(1)
  expect(isPaused(laptop.claude.pid)).toBe(false)
}, 90_000)

test('a worker whose program restarts after its Claude Code ran the moved session, before it marked the move done, marks it done at its next start and never stops or restores the copy', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  let isHeld = false
  relay.before = (op) => (!isHeld && op.op === 'want' && op.device === '' && op.if?.wanted === WORKER.id ? ((isHeld = true), new Promise<void>(() => undefined)) : undefined)
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await until(() => isHeld, 'the worker marking the move done', 30_000)
  worker.child.kill('SIGKILL')
  await worker.child.exited
  const [copy] = copiesOn(worker.folder)
  const restarted = await serveOn(worker.env)
  const { last } = await stepsOf(laptop.socket)
  await laptop.claude.exited
  await Bun.sleep(2000)

  expect(last.step).toBe('moved')
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  expect(await relay.wanted()).toEqual(new Map())
  expect(restarted.logged()).not.toContain(`takes ${SESSION} over.`)
  expect(runsOn(worker.folder)).toHaveLength(1)
  expect(copiesOn(worker.folder)).toEqual([{ pid: copy?.pid ?? 0, isRunning: true }])
}, 90_000)

test("a move the worker cannot take while the laptop's program restarts brings the session back to the Claude Code the move paused", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay, (folder) => {
    writeFileSync(join(folder, 'hang'), '8')
    writeFileSync(join(folder, 'fail'), 'Claude Code is not logged in.')
  })

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await until(async () => (await relay.claims()).get(SESSION) === WORKER.id, 'the worker taking the claim', 30_000)
  laptop.child.kill('SIGKILL')
  await laptop.child.exited
  const restarted = await serveOn(laptop.env)
  await until(() => worker.logged().includes(`${WORKER.name} could not place ${SESSION} here`), 'the worker failing the move', 30_000)
  await until(async () => (await relay.claims()).get(SESSION) === LAPTOP.id, 'the laptop taking the session back', 30_000)
  await until(() => !isPaused(laptop.claude.pid), 'the laptop running its paused copy again', 30_000)

  await until(() => restarted.logged().includes('could not take the session: '), 'the laptop saying why the session stays')
  expect(laptop.claude.exitCode ?? laptop.claude.signalCode).toBeNull()
  expect(runsOn(laptop.folder)).toEqual([])
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  await until(async () => (await relay.wanted()).size === 0, 'the laptop dropping the move')
}, 90_000)
