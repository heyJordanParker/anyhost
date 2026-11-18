import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryRelay, until } from './memory.ts'
import { anyhostOn, copiesOn, CTO, LAPTOP, logOf, machineFor, postTo, runningOn, runsOn, script, sentOn, serveOn, SESSION, startedOn, stepsOf, tripOn, WORKER, workerOn } from './program.ts'

test('anyhost tell types into a session another machine runs and prints its screen, and with no text only reads it', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)
  await anyhostOn(laptop.env, ['new', WORKER.name, checkout])
  const session = startedOn(worker)

  const told = await anyhostOn(laptop.env, ['tell', session, 'Book the train'])
  const read = await anyhostOn(laptop.env, ['tell', session])

  expect(told).toMatchObject({ code: 0, out: `screen of ${session}\nBook the train\n` })
  expect(read).toMatchObject({ code: 0, out: `screen of ${session}\nBook the train\n` })
  expect(sentOn(worker.folder)).toEqual(['t0 Book the train'])
  expect(sentOn(laptop.folder)).toEqual([])
}, 60_000)

test('anyhost sleep asks the runner of a session another machine runs to stop its Claude Code, and keeps its terminal', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  await anyhostOn(laptop.env, ['new', WORKER.name, tripOn(laptop)])
  const session = startedOn(worker)

  const slept = await anyhostOn(laptop.env, ['sleep', session])

  expect(slept).toMatchObject({ code: 0, out: `${session.slice(0, 8)} on ${WORKER.name} goes to sleep once its turn ends. A message wakes it.\n` })
  expect(logOf(worker.folder, 'labels.log').filter((line) => line.includes('anyhost.sleep='))).toEqual([expect.stringMatching(/^t0 anyhost\.sleep=\d+$/)])
  expect(copiesOn(worker.folder).filter(({ isRunning }) => isRunning)).toHaveLength(1)
}, 60_000)

test("anyhost show puts a session's terminal on this machine's Herdr app with Herdr's own commands, as a multiplexer places a pane", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  script(join(laptop.folder, 'bin', 'herdr-app'), `#!/bin/sh\ncase "$1" in\n  ls) cat '${join(laptop.folder, 'shown.json')}' ;;\n  do) shift; echo "$*" >> '${join(laptop.folder, 'herdr.log')}' ;;\nesac\n`)
  const shown = (pane: string | null): void => writeFileSync(join(laptop.folder, 'shown.json'), JSON.stringify({ spaces: [{ tabs: [{ terminals: [{ terminal: 't0', pane }] }] }] }))
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const folder = join(laptop.env['HOME'] ?? '', 'trip')
  mkdirSync(folder, { recursive: true })
  await anyhostOn(laptop.env, ['new', LAPTOP.name, folder])
  const session = startedOn(laptop)

  shown(null)
  const kept = await anyhostOn(laptop.env, ['show', session])
  const peeked = await anyhostOn(laptop.env, ['show', session, 'peek'])
  shown('p1')
  const focused = await anyhostOn(laptop.env, ['show', session])
  const beside = await anyhostOn(laptop.env, ['show', session, 'right'])
  const hidden = await anyhostOn(laptop.env, ['show', session, 'hide'])
  const refused = await anyhostOn(laptop.env, ['show', session, 'sideways'])

  expect([kept, peeked, focused, beside, hidden].map(({ code, out }) => ({ code, out }))).toEqual(Array.from({ length: 5 }, () => ({ code: 0, out: `${session.slice(0, 8)} of ${LAPTOP.name} shows in terminal t0.\n` })))
  expect(refused).toMatchObject({ code: 1, err: '/agents/show takes place, one of focus, peek, tab, right, down, hide, not sideways.\n' })
  expect(logOf(laptop.folder, 'herdr.log').map((line) => [line.slice(0, line.indexOf(' ')), JSON.parse(line.slice(line.indexOf(' ') + 1)) as unknown])).toEqual([
    ['terminal.keep', { terminal: 't0', place: 'tab' }],
    ['terminal.peek', { terminal: 't0' }],
    ['agent.focus', { terminal: 't0' }],
    ['pane.split', { direction: 'right', argv: ['sh', '-c', expect.stringContaining('exec hc attach'), 'view', session, 't0'] }],
    ['terminal.park', { terminal: 't0' }],
  ])
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
  expect(runsOn(worker.folder).map(({ session, command }) => ({ session, command: command.split(' ').slice(-3).join(' ') }))).toEqual([
    { session: SESSION, command: `claude --resume ${SESSION}` },
    { session: SESSION, command: `claude --resume ${SESSION}` },
  ])
  expect(sentOn(worker.folder)).toEqual(['t1 And the hotel'])
}, 90_000)

test('a message to a session asleep on its own machine looks for its terminal once, wakes that same conversation with claude --resume and never starts a new one', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  laptop.claude.kill('SIGKILL')
  await laptop.claude.exited
  writeFileSync(join(laptop.folder, 'calls.log'), '')

  const told = await anyhostOn(laptop.env, ['tell', SESSION.slice(0, 8), 'Wake up and report'])
  const looked = logOf(laptop.folder, 'calls.log').filter((line) => line.startsWith('ls '))
  const again = await anyhostOn(laptop.env, ['tell', SESSION.slice(0, 8), 'And once more'])

  expect(told).toMatchObject({ code: 0 })
  expect(looked).toEqual([`ls --json --label anyhost.session=${SESSION}`])
  expect(again).toMatchObject({ code: 0 })
  expect(runsOn(laptop.folder).map(({ session, command }) => ({ session, command: command.split(' ').slice(-3).join(' ') }))).toEqual([{ session: SESSION, command: `claude --resume ${SESSION}` }])
  expect(runsOn(laptop.folder).some(({ command }) => command.includes('--session-id'))).toBe(false)
  expect(sentOn(laptop.folder)).toEqual(['t0 Wake up and report', 't0 And once more'])
}, 90_000)

test("GET /agents lists what a session another machine runs does now, and an agent's message to it names the agent and the machine that sent it, so the agent it reaches answers it, and keys answer a prompt", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  expect((await stepsOf(laptop.socket)).last.step).toBe('moved')

  const listed = (await (await fetch('http://localhost/agents', { unix: laptop.socket })).json()) as { agents: { id: string; status: string }[] }
  expect(listed.agents.find(({ id }) => id === SESSION)?.status).toBe('idle')
  const told = await postTo(laptop.socket, '/agents/tell', { session: SESSION.slice(0, 8), text: 'Book the train', sender: CTO })
  const pressed = await anyhostOn(laptop.env, ['tell', SESSION.slice(0, 8), '--keys', 'down', '--keys', 'enter'])

  const tagged = `<anyhost from="c7000000 on ${LAPTOP.name}" reach="tell_agent c7000000 when done or stuck">Book the train</anyhost>`
  expect(told).toEqual({ status: 200, body: { machine: WORKER.name, session: SESSION, status: 'working', screen: `screen of ${SESSION}\n${tagged}`, terminal: 't0' } })
  expect(pressed).toEqual({ code: 0, out: `screen of ${SESSION}\n${tagged}\n`, err: '' })
  expect(sentOn(worker.folder)).toEqual([`t0 ${tagged}`])
  expect(logOf(worker.folder, 'keys.log')).toEqual(['t0 down enter'])
}, 90_000)

test("the machine that moved a session or told it something lists the status that answer gave at once, before the other machine's next statuses arrive", async () => {
  const relay = await memoryRelay()
  const dropsStatuses = async (): Promise<void> => {
    for (;;) await relay.dropNext(LAPTOP.id, 'statuses')
  }
  void dropsStatuses()
  const laptop = await runningOn(relay)
  await workerOn(relay)
  const statusOf = async (): Promise<string | undefined> => ((await (await fetch('http://localhost/agents', { unix: laptop.socket })).json()) as { agents: { id: string; status: string }[] }).agents.find(({ id }) => id === SESSION)?.status

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  expect((await stepsOf(laptop.socket)).last.step).toBe('moved')
  const moved = await statusOf()
  await postTo(laptop.socket, '/agents/tell', { session: SESSION, text: 'Book the train' })
  const told = await statusOf()

  expect([moved, told]).toEqual(['idle', 'working'])
}, 90_000)

test('a tell to a session the person runs here outside herdr-core, as in tmux, says so and leaves the session running where it is', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  laptop.status('idle')

  const told = await postTo(laptop.socket, '/agents/tell', { session: SESSION, text: 'Book the train' })

  expect(told.status).toBe(400)
  expect(told.body['message']).toBe(`${SESSION.slice(0, 8)} runs on ${LAPTOP.name} outside herdr-core, as in tmux, so anyhost cannot type into it or read it, and leaves it where the person runs it. Opening it in the Herdr app moves it into herdr-core.`)
  expect(laptop.claude.exitCode).toBeNull()
  expect(laptop.claude.signalCode).toBeNull()
  expect(runsOn(laptop.folder)).toEqual([])
  expect(sentOn(laptop.folder)).toEqual([])
}, 60_000)

test('a tell to a machine that holds the session and does not answer gets its answer after 25 s over the socket, which keeps a request open past 10 s', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  laptop.child.kill('SIGSTOP')
  const told = await postTo(worker.socket, '/agents/tell', { session: SESSION, text: 'Book the train' }).finally(() => laptop.child.kill('SIGCONT'))

  expect(told).toEqual({ status: 400, body: { message: `${LAPTOP.name}, which holds 11111111, did not answer within 25 s. An anyhost older than 0.4.0 there does not answer at all.` } })
}, 60_000)
