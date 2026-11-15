import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryRelay, statusOn, until } from './memory.ts'
import { anyhostOn, CLI, decoder, LAPTOP, machineFor, runsOn, sentOn, serveOn, spawnForTest, startedOn, trust, trustedIn, tripOn, WORKER, workerOn } from './program.ts'

test('anyhost new starts a session on the worker in a terminal of herdr-core in its clone of the same repository, routed by start and started', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)
  trust(laptop, checkout)

  const { code, out } = await anyhostOn(laptop.env, ['new', WORKER.name, join(checkout, 'plans')])

  const [run, ...more] = runsOn(worker.folder)
  expect(more).toEqual([])
  expect(code).toBe(0)
  expect(out).toBe(`${WORKER.name} started ${run?.session.slice(0, 8)} in a terminal of herdr-core there.\n`)
  expect(run?.command).toBe(`claude --session-id ${run?.session}`)
  expect((await relay.claims()).get(run?.session ?? '')).toBe(WORKER.id)
  const workerCwd = join(worker.env['HOME'] ?? '', 'trip', 'plans')
  expect(readFileSync(join(workerCwd, 'route.md'), 'utf8')).toBe('Lisbon, then Porto\n')
  expect(realpathSync(run?.cwd ?? '')).toBe(realpathSync(workerCwd))
  expect(trustedIn(worker)).toEqual([realpathSync(join(worker.env['HOME'] ?? '', 'trip'))])
}, 60_000)

test('anyhost new to a worker whose program ends after it took the start ends with the reason once the relay counts it gone', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'hang'), '60'))
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)

  const started = spawnForTest(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  await until(() => startedOn(worker) !== '', 'the worker starting the session', 30_000)
  worker.child.kill('SIGKILL')
  const endedAt = Date.now()
  const [code, err] = await Promise.all([started.exited, new Response(started.stderr).text()])

  expect(Date.now() - endedAt).toBeLessThan(25_000)
  expect(code).toBe(1)
  expect(err.trim()).toBe(`${WORKER.name} went offline before it answered. anyhost list shows whether a session started there.`)
}, 60_000)

test("anyhost new whose command's own socket drops while the worker starts the session prints the session it started and exits 0", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'hang'), '3'))
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)

  const started = spawnForTest(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  await until(() => startedOn(worker) !== '', 'the worker starting the session', 30_000)
  const reconnect = relay.disconnect(LAPTOP.id, 1)
  await until(() => worker.logged().includes(`${WORKER.name} started ${startedOn(worker)}`), 'the worker answering', 30_000)
  await Bun.sleep(1000)
  reconnect()
  const [code, out] = await Promise.all([started.exited, new Response(started.stdout).text()])

  expect(out).toBe(`${WORKER.name} started ${startedOn(worker).slice(0, 8)} in a terminal of herdr-core there.\n`)
  expect(code).toBe(0)
}, 60_000)

test("anyhost new whose laptop sleeps as the worker's started goes prints the session once it wakes and exits 0, with one session started there", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)
  const held = relay.holdNext('started')

  const started = spawnForTest(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  const release = await held
  const wake = relay.silence(LAPTOP.id)
  release()
  await Bun.sleep(12_000)
  wake()
  const [code, out] = await Promise.all([started.exited, new Response(started.stdout).text()])

  expect(out).toBe(`${WORKER.name} started ${startedOn(worker).slice(0, 8)} in a terminal of herdr-core there.\n`)
  expect(code).toBe(0)
  expect(worker.logged()).toContain(`${LAPTOP.name} asked again for its answer`)
  expect(runsOn(worker.folder)).toHaveLength(1)
}, 90_000)

test("anyhost new while its program's relay is not connected says what it waits for, and starts the session once the relay connects", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)
  const reconnect = relay.disconnect(LAPTOP.id)
  await until(async () => (await statusOn(laptop.socket)).relay.state !== 'connected', 'the program reading its relay down')

  const started = spawnForTest(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  let printed = ''
  const reading = (async () => {
    for await (const chunk of started.stdout) printed += decoder.decode(chunk)
  })()
  await until(() => printed.includes('\n'), 'the line that says what anyhost new waits for', 30_000)
  const waiting = printed
  reconnect()
  const [code] = await Promise.all([started.exited, reading])

  expect(waiting).toStartWith(`Waiting for the relay at ${relay.url} to connect.`)
  expect(waiting).toEndWith(' Ctrl-C stops waiting.\n')
  expect(printed.slice(waiting.length)).toBe(`${WORKER.name} started ${startedOn(worker).slice(0, 8)} in a terminal of herdr-core there.\n`)
  expect(code).toBe(0)
}, 90_000)

test('anyhost new on this machine starts a session in a terminal of herdr-core here and types its first message into it', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const folder = join(laptop.env['HOME'] ?? '', 'trip')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(laptop.folder, 'unsettled'), '3')

  const { code, out } = await anyhostOn(laptop.env, ['new', LAPTOP.name, folder, 'You are the CTO. Watch every agent.'])

  const session = startedOn(laptop)
  expect(code).toBe(0)
  expect(out).toBe(`${LAPTOP.name} started ${session.slice(0, 8)} in a terminal of herdr-core there.\n`)
  expect(runsOn(laptop.folder)).toMatchObject([{ session, command: `claude --session-id ${session}` }])
  await until(() => sentOn(laptop.folder).length > 0, 'the first message going in')
  expect(sentOn(laptop.folder)).toEqual(['t0 You are the CTO. Watch every agent.'])
  expect((await relay.claims()).get(session)).toBe(LAPTOP.id)
}, 60_000)
