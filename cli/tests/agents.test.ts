import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startOf } from '../src/claude.ts'
import { memoryRelay, statusOn, until } from './memory.ts'
import { anyhostOn, CLI, copiesOn, decoder, isUploaded, killAfterTest, LAPTOP, logOf, machineFor, postTo, runningOn, runsOn, sentOn, serveOn, SESSION, startedOn, stepsOf, trust, trustedIn, tripOn, WORKER, workerOn } from './program.ts'

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

  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  killAfterTest(started)
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

test('an agent started on another machine for an agent gets its first message from that agent and its machine, lists it as its parent, answers its last messages from there, and is deleted there', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)

  const started = await postTo(laptop.socket, '/new', { machine: WORKER.name, folder: checkout, prompt: 'Book the train', parent: CTO })
  const session = String(started.body['session'])
  await until(() => sentOn(worker.folder).length > 0, 'the first message going in')
  const cwd = runsOn(worker.folder)[0]?.cwd ?? ''
  const transcript = join(worker.env['HOME'] ?? '', '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)
  const line = (value: object): string => `${JSON.stringify({ sessionId: session, cwd, ...value })}\n`
  mkdirSync(join(transcript, '..'), { recursive: true })
  writeFileSync(
    transcript,
    line({ type: 'user', timestamp: '2026-11-12T10:00:00.000Z', message: { role: 'user', content: '<anyhost from="c7000000 on anyhost-b" reach="tell_agent c7000000 when done or stuck">Book the train</anyhost>' } }) +
      line({ type: 'assistant', timestamp: '2026-11-12T10:00:01.000Z', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Looking at the trains.' }] } }) +
      line({ type: 'assistant', timestamp: '2026-11-12T10:00:02.000Z', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1', name: 'Bash', input: {} }] } }) +
      line({ type: 'user', timestamp: '2026-11-12T10:00:03.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'the 9:15 is free' }] } }) +
      line({ type: 'assistant', timestamp: '2026-11-12T10:00:04.000Z', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'Booked the 9:15 train.' }] } }),
  )
  await until(() => isUploaded(relay, session, 'Booked the 9:15 train.'), 'the worker uploading the transcript')

  const read = await postTo(laptop.socket, '/agents/tell', { session: session.slice(0, 8), messages: 2 })
  const parentOf = async (): Promise<string | undefined> => ((await (await fetch('http://localhost/agents', { unix: laptop.socket })).json()) as { agents: { id: string; parent: string }[] }).agents.find(({ id }) => id === session)?.parent
  await until(async () => (await parentOf()) !== undefined, 'the laptop listing the session')
  const parent = await parentOf()
  const deleted = await postTo(laptop.socket, '/agents/delete', { session: session.slice(0, 8) })

  expect(sentOn(worker.folder)).toEqual(['t0 <anyhost from="c7000000 on anyhost-b" reach="tell_agent c7000000 when done or stuck">Book the train</anyhost>'])
  expect(read).toMatchObject({ status: 200, body: { machine: WORKER.name, messages: [{ role: 'assistant', at: '2026-11-12T10:00:01.000Z', text: 'Looking at the trains.' }, { role: 'assistant', at: '2026-11-12T10:00:04.000Z', text: 'Booked the 9:15 train.' }] } })
  expect(parent).toBe(CTO)
  expect(deleted).toEqual({ status: 200, body: { session } })
  expect(existsSync(transcript)).toBe(false)
  expect(copiesOn(worker.folder).filter(({ isRunning }) => isRunning)).toEqual([])
}, 90_000)

test('an agent that starts waiting at a permission prompt on another machine tells the agent that started it which keys answer it', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  const checkout = tripOn(laptop)
  const started = await postTo(laptop.socket, '/new', { machine: WORKER.name, folder: checkout, prompt: 'Book the train', parent: SESSION })
  const child = String(started.body['session'])
  await until(() => sentOn(worker.folder).length > 0, 'the first message going in')
  const records = join(worker.env['CLAUDE_CONFIG_DIR'] ?? '', 'sessions')
  const record = readdirSync(records).map((name) => join(records, name)).find((path) => readFileSync(path, 'utf8').includes(child)) ?? ''

  writeFileSync(record, readFileSync(record, 'utf8').replace(/"status":"[a-z]+"/, '"status":"waiting"'))
  await until(() => sentOn(laptop.folder).length > 0, 'the note reaching the agent that started it', 30_000)

  const id = child.slice(0, 8)
  expect(sentOn(laptop.folder)).toEqual([`t0 <anyhost from="${id} on ${WORKER.name}" reach="tell_agent ${id} when done or stuck">${id} waits at a permission prompt on ${WORKER.name}. read_agent ${id} shows it, and press_keys ${id} answers it.</anyhost>`])
}, 90_000)

test('an agent that starts waiting while its machine hears no change of Claude Code records still tells the agent that started it, at the next backup pass', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await machineFor(relay, WORKER)
  const served = await serveOn({ ...worker.env, ANYHOST_WATCHER_DROPS: '1' })
  await until(() => relay.isConnected(WORKER.id), 'the worker connecting')
  const started = await postTo(laptop.socket, '/new', { machine: WORKER.name, folder: tripOn(laptop), prompt: 'Book the train', parent: SESSION })
  const child = String(started.body['session'])
  await until(() => sentOn(worker.folder).length > 0, 'the first message going in', 30_000)
  const records = join(worker.env['CLAUDE_CONFIG_DIR'] ?? '', 'sessions')
  const record = readdirSync(records).map((name) => join(records, name)).find((path) => readFileSync(path, 'utf8').includes(child)) ?? ''

  writeFileSync(record, readFileSync(record, 'utf8').replace(/"status":"[a-z]+"/, '"status":"waiting"'))
  await until(() => sentOn(laptop.folder).length > 0, 'the note reaching the agent that started it', 90_000)

  expect(sentOn(laptop.folder)).toHaveLength(1)
  expect(served.logged()).not.toContain('could not tell')
}, 150_000)

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

test("a tell never types into a run's terminal while the session's live Claude Code is another copy, as an older runner's whose Claude Code sleeps: it stops both and continues the session in one new terminal", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const runner = Bun.spawn(['sleep', '600'])
  killAfterTest(runner)
  mkdirSync(join(laptop.folder, 'terminals'), { recursive: true })
  writeFileSync(join(laptop.folder, 'terminals', 'told-before'), `${SESSION} ${runner.pid}\n`)
  const runs = join(laptop.env['XDG_STATE_HOME'] ?? '', 'anyhost', 'runs')
  mkdirSync(runs, { recursive: true })
  writeFileSync(join(runs, `${SESSION}.json`), JSON.stringify({ session: SESSION, runner: { process: { id: runner.pid, start: startOf(runner.pid) }, version: '0.6.0', startedAt: '' }, terminal: { address: 'told-before', machine: '' }, claude: { command: ['claude'] } }))

  const told = await postTo(laptop.socket, '/agents/tell', { session: SESSION, text: 'Book the train' })

  expect(told.status).toBe(200)
  expect(sentOn(laptop.folder).filter((line) => line.startsWith('told-before '))).toEqual([])
  expect(sentOn(laptop.folder).join('\n')).toContain('Book the train')
  expect(laptop.claude.signalCode).toBe('SIGTERM')
  expect(runner.signalCode).not.toBeNull()
  expect(runsOn(laptop.folder).map(({ session }) => session)).toEqual([SESSION])
}, 60_000)

test("an open of a session whose live Claude Code is not its run's own, as the Herdr pane's Move it here asks, leaves exactly one copy: the one in the new terminal", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const runner = Bun.spawn(['sleep', '600'])
  killAfterTest(runner)
  mkdirSync(join(laptop.folder, 'terminals'), { recursive: true })
  writeFileSync(join(laptop.folder, 'terminals', 'opened-before'), `${SESSION} ${runner.pid}\n`)
  const runs = join(laptop.env['XDG_STATE_HOME'] ?? '', 'anyhost', 'runs')
  mkdirSync(runs, { recursive: true })
  writeFileSync(join(runs, `${SESSION}.json`), JSON.stringify({ session: SESSION, runner: { process: { id: runner.pid, start: startOf(runner.pid) }, version: '0.6.0', startedAt: '' }, terminal: { address: 'opened-before', machine: '' }, claude: { command: ['claude'] } }))

  const opened = await postTo(laptop.socket, '/agents/open', { session: SESSION })

  expect(opened.status).toBe(200)
  expect(opened.body['terminal']).not.toBe('opened-before')
  expect([laptop.claude.signalCode, runner.signalCode === null]).toEqual(['SIGTERM', false])
  expect(copiesOn(laptop.folder).filter(({ isRunning }) => isRunning)).toHaveLength(1)
}, 60_000)

test('a session working in another terminal, as in tmux, moves into one terminal of herdr-core only once its turn and its background commands ended, however many opens ask for it meanwhile', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  laptop.status('busy')

  const opens = [postTo(laptop.socket, '/agents/open', { session: SESSION }), postTo(laptop.socket, '/agents/open', { session: SESSION.slice(0, 8) })]
  await Bun.sleep(1500)
  const whileWorking = { stopped: laptop.claude.signalCode, terminals: runsOn(laptop.folder).length }
  laptop.status('shell')
  await Bun.sleep(1500)
  const whileItsCommandRuns = { stopped: laptop.claude.signalCode, terminals: runsOn(laptop.folder).length }
  laptop.status('idle')
  const [first, second] = await Promise.all(opens)

  expect(whileWorking).toEqual({ stopped: null, terminals: 0 })
  expect(whileItsCommandRuns).toEqual({ stopped: null, terminals: 0 })
  expect([first?.status, second?.status]).toEqual([200, 200])
  expect(second?.body['terminal']).toBe(first?.body['terminal'])
  expect(laptop.claude.signalCode).toBe('SIGTERM')
  expect(runsOn(laptop.folder).map(({ session }) => session)).toEqual([SESSION])
}, 60_000)

test('a tell to a machine that holds the session and does not answer gets its answer after 25 s over the socket, which keeps a request open past 10 s', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  laptop.child.kill('SIGSTOP')
  const told = await postTo(worker.socket, '/agents/tell', { session: SESSION, text: 'Book the train' }).finally(() => laptop.child.kill('SIGCONT'))

  expect(told).toEqual({ status: 400, body: { message: `${LAPTOP.name}, which holds 11111111, did not answer within 25 s. An anyhost older than 0.4.0 there does not answer at all.` } })
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

test('an open of a session a connected machine runs, as a click on a list read before that machine connected again asks, takes nothing and leaves its copy running there', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)

  const opened = await postTo(worker.socket, '/agents/open', { session: SESSION.slice(0, 8) })

  expect(opened.status).toBe(400)
  expect(opened.body['message']).toBe(`${LAPTOP.name} runs ${SESSION.slice(0, 8)} and is connected, so ${SESSION.slice(0, 8)} opens there and not on ${WORKER.name}.`)
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect(runsOn(worker.folder)).toEqual([])
  expect(laptop.claude.exitCode).toBeNull()
}, 60_000)

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

test('a visit and an archive reach every machine through the shared list, which a machine that read it once reads again only once it changed', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  const agentOn = async (socket: string): Promise<{ readonly archived: boolean; readonly visitedAt: string } | undefined> =>
    ((await (await fetch('http://localhost/agents', { unix: socket })).json()) as { agents: { id: string; archived: boolean; visitedAt: string }[] }).agents.find(({ id }) => id === SESSION)
  const archived = await anyhostOn(laptop.env, ['archive', SESSION.slice(0, 8)])
  await until(async () => (await agentOn(worker.socket))?.archived === true, 'the worker reading the archive')
  const before = relay.requests.length
  await agentOn(worker.socket)
  const unchanged = relay.requests.slice(before).flat().filter((op) => op.op === 'get')

  const visited = await anyhostOn(laptop.env, ['visit', SESSION.slice(0, 8), '--at', '2026-11-11T16:00:00.000Z'])
  const restored = await anyhostOn(laptop.env, ['archive', SESSION.slice(0, 8), '--undo'])

  expect([archived.code, visited.code, restored.code]).toEqual([0, 0, 0])
  expect(unchanged.length).toBeGreaterThan(0)
  expect(unchanged.every((op) => op.op === 'get' && op.if !== undefined)).toBe(true)
  expect(await agentOn(worker.socket)).toMatchObject({ archived: false, visitedAt: '2026-11-11T16:00:00.000Z' })
}, 60_000)

test('an archive asked while the relay connects again waits for it and archives the session, as the Herdr pane asks one whenever its button is pressed', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const reconnect = relay.disconnect(LAPTOP.id)
  await until(async () => (await statusOn(laptop.socket)).relay.state !== 'connected', 'the program reading its relay down')

  const archived = postTo(laptop.socket, '/agents/archive', { session: SESSION.slice(0, 8) })
  await Bun.sleep(500)
  reconnect()
  const shared = async (): Promise<Record<string, { archived?: boolean }>> => ((JSON.parse(decoder.decode((await relay.read('shared.json')) ?? new TextEncoder().encode('{}'))) as { archived?: Record<string, { archived?: boolean }> }).archived ?? {})

  expect(await archived).toEqual({ status: 200, body: {} })
  expect((await shared())[SESSION]?.archived).toBe(true)
}, 60_000)
