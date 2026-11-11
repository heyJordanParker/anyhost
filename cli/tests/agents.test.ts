import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryRelay, statusOn, until } from './memory.ts'
import { anyhostOn, CLI, copiesOn, decoder, killAfterTest, LAPTOP, logOf, machineFor, postTo, runningOn, runsOn, sentOn, serveOn, SESSION, startedOn, stepsOf, trust, trustedIn, tripOn, WORKER, workerOn } from './program.ts'

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

test('anyhost new to a worker whose program ends after it took the start ends with the reason within the check of its connection', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'hang'), '60'))
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)

  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  killAfterTest(started)
  await until(() => startedOn(worker) !== '', 'the worker starting the session', 30_000)
  worker.child.kill('SIGKILL')
  const endedAt = Date.now()
  const [code, err] = await Promise.all([started.exited, new Response(started.stderr).text()])

  expect(Date.now() - endedAt).toBeLessThan(25_000)
  expect(code).toBe(1)
  expect(err.trim()).toBe(`${WORKER.name} is offline or its program restarted before it answered. anyhost list shows whether a session started there.`)
}, 60_000)

test("anyhost new whose command's own socket drops while the worker starts the session prints the session it started and exits 0", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'hang'), '3'))
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)

  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  killAfterTest(started)
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

  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  killAfterTest(started)
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

  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  killAfterTest(started)
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

test('anyhost tell types into a session another machine runs and prints its screen, and with no text only reads it', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)
  await anyhostOn(laptop.env, ['new', WORKER.name, checkout])
  const session = startedOn(worker)

  const told = await anyhostOn(laptop.env, ['tell', session.slice(0, 8), 'Book the train'])
  const read = await anyhostOn(laptop.env, ['tell', session.slice(0, 8)])

  expect(told).toMatchObject({ code: 0, out: `screen of ${session}\nBook the train\n` })
  expect(read).toMatchObject({ code: 0, out: `screen of ${session}\nBook the train\n` })
  expect(sentOn(worker.folder)).toEqual(['t0 Book the train'])
  expect(sentOn(laptop.folder)).toEqual([])
}, 60_000)

test('anyhost tell to a session its machine holds in no live terminal opens one there that resumes it with its command, and types into it', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  expect((await stepsOf(laptop.socket)).last.step).toBe('moved')
  for (const { pid } of copiesOn(worker.folder)) process.kill(pid, 'SIGKILL')
  await until(() => copiesOn(worker.folder).every(({ isRunning }) => !isRunning), "the worker's copy ending")

  const read = await anyhostOn(laptop.env, ['tell', SESSION.slice(0, 8)])
  const told = await anyhostOn(laptop.env, ['tell', SESSION.slice(0, 8), 'And the hotel'])

  expect(read).toMatchObject({ code: 1, err: `${WORKER.name}: ${SESSION.slice(0, 8)} runs in no terminal of herdr-core on ${WORKER.name}. Tell it something to start it again.\n` })
  expect(told).toMatchObject({ code: 0, out: `screen of ${SESSION}\nAnd the hotel\n` })
  expect(runsOn(worker.folder).map(({ session, command }) => ({ session, command }))).toEqual([
    { session: SESSION, command: 'claude' },
    { session: SESSION, command: 'claude' },
  ])
  expect(sentOn(worker.folder)).toEqual(['t1 And the hotel'])
}, 90_000)

const CTO = 'c7000000-0000-4000-8000-000000000000'

test("GET /agents lists what a session another machine runs does now, and an agent's message to it names the agent and the machine that sent it, so the agent it reaches answers it, and keys answer a prompt", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  expect((await stepsOf(laptop.socket)).last.step).toBe('moved')

  const listed = (await (await fetch('http://localhost/agents', { unix: laptop.socket })).json()) as { agents: { id: string; status: string }[] }
  expect(listed.agents.find(({ id }) => id === SESSION)?.status).toBe('idle')
  const told = await postTo(laptop.socket, '/agents/tell', { session: SESSION.slice(0, 8), text: 'Book the train', sender: CTO })
  const pressed = await postTo(laptop.socket, '/agents/tell', { session: SESSION.slice(0, 8), keys: ['down', 'enter'] })

  const tagged = `<anyhost from="c7000000 on ${LAPTOP.name}" reach="tell_agent c7000000 when done or stuck">Book the train</anyhost>`
  expect(told).toEqual({ status: 200, body: { machine: WORKER.name, session: SESSION, status: 'working', screen: `screen of ${SESSION}\n${tagged}` } })
  expect(pressed).toMatchObject({ status: 200, body: { status: 'working' } })
  expect(sentOn(worker.folder)).toEqual([`t0 ${tagged}`])
  expect(logOf(worker.folder, 'keys.log')).toEqual(['t0 down enter'])
}, 90_000)

test('a session Claude Code runs here outside herdr-core, as in tmux, comes into herdr-core once its turn ends, and the tell types there', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  laptop.status('busy')

  const told = postTo(laptop.socket, '/agents/tell', { session: SESSION, text: 'Book the train' })
  await Bun.sleep(1500)
  const whileBusy = { stopped: laptop.claude.signalCode, runs: runsOn(laptop.folder).length }
  laptop.status('idle')

  expect(whileBusy).toEqual({ stopped: null, runs: 0 })
  expect((await told).status).toBe(200)
  expect(laptop.claude.signalCode).toBe('SIGTERM')
  expect(runsOn(laptop.folder).map(({ session }) => session)).toEqual([SESSION])
  expect(sentOn(laptop.folder).join('\n')).toContain('Book the train')
}, 60_000)

test('an open continues a session here from R2 while the machine that ran it is gone, and answers its terminal', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  laptop.child.kill('SIGKILL')
  await until(() => !relay.isConnected(LAPTOP.id), 'the laptop going away', 60_000)

  const opened = await postTo(worker.socket, '/agents/open', { session: SESSION.slice(0, 8) })
  const again = await postTo(worker.socket, '/agents/open', { session: SESSION.slice(0, 8) })

  expect(opened.status).toBe(200)
  expect([opened.body['session'], opened.body['machine'], typeof opened.body['terminal']]).toEqual([SESSION, WORKER.name, 'string'])
  expect(again.body).toEqual(opened.body)
  expect(runsOn(worker.folder).map(({ session, command }) => ({ session, command }))).toEqual([{ session: SESSION, command: 'claude' }])
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
}, 90_000)

test('a delete stops the session and removes its files, every machine lists it as deleted, and opening it brings its conversation back', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const listed = async (): Promise<{ readonly deleted: boolean } | undefined> =>
    ((await (await fetch('http://localhost/agents', { unix: laptop.socket })).json()) as { agents: { id: string; deleted: boolean }[] }).agents.find(({ id }) => id === SESSION)

  const deleted = await postTo(laptop.socket, '/agents/delete', { session: SESSION.slice(0, 8) })
  const whileDeleted = { transcript: existsSync(laptop.transcript), stopped: laptop.claude.signalCode, listed: await listed() }
  const opened = await postTo(laptop.socket, '/agents/open', { session: SESSION.slice(0, 8) })

  expect(deleted).toEqual({ status: 200, body: { session: SESSION } })
  expect(whileDeleted).toMatchObject({ transcript: false, stopped: 'SIGTERM', listed: { deleted: true } })
  expect(opened.status).toBe(200)
  expect(readFileSync(laptop.transcript, 'utf8')).toContain('Plan the trip')
  expect(await listed()).toMatchObject({ deleted: false })
}, 60_000)

test('a visit and an archive reach every machine through the shared list, and an earlier version settled marks become archived ones', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await relay.objects.put('shared.json', new TextEncoder().encode(JSON.stringify({ settled: { [SESSION]: { settled: true, at: '2999-01-01T00:00:00.000Z' } }, settleAfterDays: 3 })))
  const worker = await workerOn(relay)
  const agentOn = async (socket: string): Promise<{ readonly archived: boolean; readonly visitedAt: string } | undefined> =>
    ((await (await fetch('http://localhost/agents', { unix: socket })).json()) as { agents: { id: string; archived: boolean; visitedAt: string }[] }).agents.find(({ id }) => id === SESSION)
  await until(async () => (await agentOn(worker.socket))?.archived === true, 'the settled mark becoming an archived one')

  const visited = await anyhostOn(laptop.env, ['visit', SESSION.slice(0, 8), '--at', '2026-11-11T16:00:00.000Z'])
  const restored = await anyhostOn(laptop.env, ['archive', SESSION.slice(0, 8), '--undo'])
  const shared = JSON.parse(decoder.decode((await relay.read('shared.json')) ?? new Uint8Array())) as Record<string, unknown>

  expect([visited.code, restored.code]).toEqual([0, 0])
  expect(await agentOn(worker.socket)).toMatchObject({ archived: false, visitedAt: '2026-11-11T16:00:00.000Z' })
  expect([shared['settled'], shared['settleAfterDays'], shared['archiveAfterDays']]).toEqual([undefined, undefined, 3])
}, 60_000)
