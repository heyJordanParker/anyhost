import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryRelay, until } from './memory.ts'
import { copiesOn, CTO, isIndexed, isUploaded, LAPTOP, machineFor, postTo, runningOn, runsOn, sentOn, serveOn, SESSION, tripOn, WORKER, workerOn } from './program.ts'

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
  await until(() => isUploaded(relay, session, 'Booked the 9:15 train.'), 'the worker uploading the transcript', 30_000)
  await until(() => isIndexed(relay, WORKER, session), "the worker's index listing the session")

  const read = await postTo(laptop.socket, '/agents/tell', { session: session.slice(0, 8), messages: 2 })
  const earlier = await postTo(laptop.socket, '/agents/tell', { session: session.slice(0, 8), messages: 1, skip: 1 })
  const parentOf = async (): Promise<string | undefined> => ((await (await fetch('http://localhost/agents', { unix: laptop.socket })).json()) as { agents: { id: string; parent: string }[] }).agents.find(({ id }) => id === session)?.parent
  await until(async () => (await parentOf()) !== undefined, 'the laptop listing the session')
  const parent = await parentOf()
  const deleted = await postTo(laptop.socket, '/agents/delete', { session: session.slice(0, 8) })

  expect(sentOn(worker.folder)).toEqual(['t0 <anyhost from="c7000000 on anyhost-b" reach="tell_agent c7000000 when done or stuck">Book the train</anyhost>'])
  expect(read).toMatchObject({ status: 200, body: { machine: WORKER.name, messages: [{ role: 'assistant', at: '2026-11-12T10:00:01.000Z', text: 'Looking at the trains.' }, { role: 'assistant', at: '2026-11-12T10:00:04.000Z', text: 'Booked the 9:15 train.' }] } })
  expect(earlier).toMatchObject({ status: 200, body: { messages: [{ role: 'assistant', at: '2026-11-12T10:00:01.000Z', text: 'Looking at the trains.' }] } })
  expect(parent).toBe(CTO)
  expect(deleted).toEqual({ status: 200, body: { session } })
  expect(existsSync(transcript)).toBe(false)
  expect(copiesOn(worker.folder).filter(({ isRunning }) => isRunning)).toEqual([])
}, 90_000)

test('an agent that starts waiting at a permission prompt on another machine tells the agent that started it which keys answer it', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  laptop.status('idle')
  expect((await postTo(laptop.socket, '/agents/open', { session: SESSION })).status).toBe(200)
  const worker = await workerOn(relay)
  const checkout = tripOn(laptop)
  const started = await postTo(laptop.socket, '/new', { machine: WORKER.name, folder: checkout, prompt: 'Book the train', parent: SESSION })
  const child = String(started.body['session'])
  await until(() => sentOn(worker.folder).length > 0, 'the first message going in')
  const records = join(worker.env['CLAUDE_CONFIG_DIR'] ?? '', 'sessions')
  const record = readdirSync(records).map((name) => join(records, name)).find((path) => readFileSync(path, 'utf8').includes(child)) ?? ''
  await until(() => readFileSync(record, 'utf8').includes('"status":"busy"'), 'the first message starting its turn')

  writeFileSync(record, readFileSync(record, 'utf8').replace(/"status":"[a-z]+"/, '"status":"waiting"'))
  await until(() => sentOn(laptop.folder).length > 0, 'the note reaching the agent that started it', 60_000)

  const id = child.slice(0, 8)
  expect(sentOn(laptop.folder)).toEqual([`t0 <anyhost from="${id} on ${WORKER.name}" reach="tell_agent ${id} when done or stuck">${id} waits at a permission prompt on ${WORKER.name}. read_agent ${id} shows it, and press_keys ${id} answers it.</anyhost>`])
}, 120_000)

test('an agent that starts waiting while its machine hears no change of Claude Code records still tells the agent that started it, at the next backup pass', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  laptop.status('idle')
  expect((await postTo(laptop.socket, '/agents/open', { session: SESSION })).status).toBe(200)
  const worker = await machineFor(relay, WORKER)
  const served = await serveOn({ ...worker.env, ANYHOST_WATCHER_DROPS: '1' })
  await until(() => relay.isConnected(WORKER.id), 'the worker connecting')
  const started = await postTo(laptop.socket, '/new', { machine: WORKER.name, folder: tripOn(laptop), prompt: 'Book the train', parent: SESSION })
  const child = String(started.body['session'])
  await until(() => sentOn(worker.folder).length > 0, 'the first message going in', 30_000)
  const records = join(worker.env['CLAUDE_CONFIG_DIR'] ?? '', 'sessions')
  const record = readdirSync(records).map((name) => join(records, name)).find((path) => readFileSync(path, 'utf8').includes(child)) ?? ''
  await until(() => readFileSync(record, 'utf8').includes('"status":"busy"'), 'the first message starting its turn')

  writeFileSync(record, readFileSync(record, 'utf8').replace(/"status":"[a-z]+"/, '"status":"waiting"'))
  await until(() => sentOn(laptop.folder).length > 0, 'the note reaching the agent that started it', 90_000)

  expect(sentOn(laptop.folder)).toHaveLength(1)
  expect(served.logged()).not.toContain('could not tell')
}, 150_000)
