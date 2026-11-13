import { expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryRelay, until } from './memory.ts'
import { claimOn, copiesOn, killAfterTest, LAPTOP, postTo, runningOn, runsOn, serveOn, SESSION, stepsOf, WORKER, workerOn } from './program.ts'

test('a move to a worker whose program restarts before its Claude Code ran the session runs again there at the laptop\'s next repeat, and reaches moved', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'hang'), '60'))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const isHanging = (): boolean => {
    const [first = ''] = Bun.spawnSync(['pgrep', '-f', `${worker.folder}/bin/hc run`]).stdout.toString().trim().split('\n')
    return first !== '' && Bun.spawnSync(['pgrep', '-P', first, '-x', 'sleep']).exitCode === 0
  }
  await until(isHanging, 'the worker\'s first herdr-core hanging', 30_000)
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
  expect(runsOn(worker.folder).filter((run) => run.session === SESSION)).toHaveLength(2)
  await laptop.claude.exited
  expect(laptop.claude.signalCode).toBe('SIGTERM')
}, 90_000)

test("a worker program restarted after it opened a terminal for a move stops that copy at the session's released, once its turn ends", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'hang'), '60'))
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await until(() => runsOn(worker.folder).some((run) => run.session === SESSION), 'the worker starting the session', 30_000)
  worker.child.kill('SIGKILL')
  await worker.child.exited
  const job = Bun.spawn(['sleep', '600'])
  killAfterTest(job)
  const workerHome = worker.env['HOME'] ?? ''
  const record = (status: string): void =>
    writeFileSync(join(workerHome, '.claude', 'sessions', `${job.pid}.json`), JSON.stringify({ pid: job.pid, sessionId: SESSION, kind: 'interactive', cwd: join(workerHome, 'work'), status }))
  record('busy')
  const stops = (): string[] => (job.signalCode === 'SIGTERM' ? ['stopped'] : [])

  await until(async () => (await claimOn(laptop.socket)).move?.line.includes(' does not answer. ') === true, 'the move saying the worker does not answer', 30_000)
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
}, 90_000)

test("a worker whose program restarts after it opened a terminal for a move, before the laptop heard moved, answers the laptop's repeat with moved and never stops or restores the copy", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  const held = relay.holdNext('moved')
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await held
  worker.child.kill('SIGKILL')
  await worker.child.exited
  const [copy] = copiesOn(worker.folder)
  const restarted = await serveOn(worker.env)
  const { last } = await stepsOf(laptop.socket)
  await laptop.claude.exited
  await Bun.sleep(2000)

  expect(last.step).toBe('moved')
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  expect(restarted.logged()).toContain(`${LAPTOP.name} asked again for its move of ${SESSION}`)
  expect(restarted.logged()).not.toContain(`moves ${SESSION} here.`)
  expect(runsOn(worker.folder)).toHaveLength(1)
  expect(copiesOn(worker.folder)).toEqual([{ pid: copy?.pid ?? 0, isRunning: true }])
}, 90_000)

test('a move the worker cannot take after the laptop program restarted takes the session back, and the laptop runs it', async () => {
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
  await until(() => worker.logged().includes(`could not take ${SESSION} from ${LAPTOP.name}`), 'the worker failing the move', 30_000)
  await until(async () => (await relay.claims()).get(SESSION) === LAPTOP.id, 'the laptop taking the session back', 30_000)
  const tookBack = `${WORKER.name} could not take ${SESSION} in a move this program forgot, so ${LAPTOP.name} took it back and runs it`
  await until(() => restarted.logged().includes(tookBack), 'the laptop running the session', 30_000)

  expect(runsOn(laptop.folder).some((run) => run.session === SESSION)).toBe(true)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
}, 90_000)

