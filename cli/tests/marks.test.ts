import { expect, test } from 'bun:test'
import { memoryRelay, statusOn, until } from './memory.ts'
import { anyhostOn, LAPTOP, postTo, runningOn, serveOn, SESSION, sharedIn, workerOn } from './program.ts'

test('an archive, a visit, a pin, a settle, a snooze, a project name, tags, stages, the project order and the pin order one machine sets reach every machine through the shared list, which another machine reads again only when told it changed, and --undo takes each back', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  const wakeAt = new Date(Date.now() + 86_400_000).toISOString()
  type Listed = {
    settleAfterDays: number | null
    projectNames: Record<string, string>
    tags: Record<string, { name: string; color: string }>
    stages: { id: string; name: string }[]
    agents: { id: string; archived: boolean; visitedAt: string; pinned: string; settled: boolean; snoozedUntil: string; tags: string[]; stage: string }[]
  }
  const listOn = async (socket: string) => {
    const listed = (await (await fetch('http://localhost/agents', { unix: socket })).json()) as Listed
    const agent = listed.agents.find(({ id }) => id === SESSION)
    return { ...agent, name: listed.projectNames['acme/trip'], settleAfterDays: listed.settleAfterDays, catalog: listed.tags, stages: listed.stages.map(({ name }) => name) }
  }
  const orderOn = async (socket: string, order: 'projectOrder' | 'pinOrder' = 'projectOrder'): Promise<string[]> => ((await (await fetch('http://localhost/agents', { unix: socket })).json()) as Record<typeof order, string[]>)[order]
  const asked = (...args: string[]) => anyhostOn(laptop.env, args)
  const id = SESSION.slice(0, 8)

  const archived = await asked('archive', id)
  await until(async () => (await listOn(worker.socket)).archived === true, 'the worker reading the archive')
  const before = relay.requests.length
  await listOn(worker.socket)
  const readAgain = relay.requests.slice(before).flat().filter((op) => op.op === 'get')
  const visited = await asked('visit', id, '--at', '2026-11-11T16:00:00.000Z')
  const restored = await asked('archive', id, '--undo')
  await until(async () => (await listOn(worker.socket)).archived === false, 'the worker reading the restore')
  const afterVisit = await listOn(worker.socket)

  const pinned = await asked('pin', id)
  await until(async () => ((await listOn(worker.socket)).pinned ?? '') !== '', 'the worker reading the pin')
  const pinOrdered = await asked('organize', JSON.stringify([{ op: 'orderPins', sessions: [SESSION] }]))
  await until(async () => (await orderOn(worker.socket, 'pinOrder')).length === 1, 'the worker reading the pin order')
  const pinOrderThere = await orderOn(worker.socket, 'pinOrder')
  const unpinned = await asked('pin', id, '--undo')
  await until(async () => (await listOn(worker.socket)).pinned === '', 'the worker reading the unpin')
  const pinOrderUnpinned = await orderOn(worker.socket, 'pinOrder')

  const settings = [await asked('settle', id), await asked('project-name', 'acme/trip', 'Lisbon Trip'), await asked('settle', '--after', '30')]
  await until(async () => (await listOn(worker.socket)).settleAfterDays === 30, 'the worker reading the settings')
  const set = await listOn(worker.socket)
  const snoozed = await asked('snooze', id, wakeAt)
  await until(async () => (await listOn(worker.socket)).snoozedUntil === wakeAt, 'the worker reading the snooze')
  const whileSnoozed = await listOn(worker.socket)
  const undone = [await asked('snooze', id, '--undo'), await asked('settle', id, '--undo'), await asked('project-name', 'acme/trip', '--undo')]
  const refused = await asked('settle', '--after', '91')
  const afterUndo = await listOn(worker.socket)

  const organized = await asked('organize', JSON.stringify([
    { op: 'defineTag', id: 'bug', name: 'Bug', color: 'red' },
    { op: 'defineStages', stages: [{ id: 'todo', name: 'To do' }, { id: 'review', name: 'Review' }] },
    { op: 'tagSession', session: id, tag: 'bug', on: true },
    { op: 'stageSession', session: id, stage: 'review' },
  ]))
  await until(async () => (await listOn(worker.socket)).stage === 'review', 'the worker reading the stage')
  const organizedThere = await listOn(worker.socket)
  const ordered = await asked('organize', JSON.stringify([{ op: 'orderProjects', projects: ['acme/zoo', 'acme/trip'] }]))
  await until(async () => (await orderOn(worker.socket)).length === 2, 'the worker reading the project order')
  const orderedThere = await orderOn(worker.socket)
  const twice = await asked('organize', JSON.stringify([{ op: 'orderProjects', projects: ['acme/trip', 'acme/trip'] }]))
  const unknown = await asked('organize', JSON.stringify([{ op: 'tagSession', session: id, tag: 'nope', on: true }]))
  const dropped = await asked('organize', JSON.stringify([{ op: 'dropTag', id: 'bug' }, { op: 'defineStages', stages: [{ id: 'todo', name: 'To do' }] }]))

  expect([archived, visited, restored, pinned, pinOrdered, unpinned, ...settings, snoozed, ...undone, organized, dropped].map(({ code }) => code)).toEqual(Array(15).fill(0))
  expect([pinOrderThere, pinOrderUnpinned]).toEqual([[SESSION], []])
  expect(readAgain).toEqual([])
  expect(afterVisit).toMatchObject({ archived: false, visitedAt: '2026-11-11T16:00:00.000Z' })
  expect(set).toMatchObject({ settled: true, snoozedUntil: '', name: 'Lisbon Trip', settleAfterDays: 30 })
  expect(whileSnoozed).toMatchObject({ snoozedUntil: wakeAt })
  expect(afterUndo).toMatchObject({ settled: false, snoozedUntil: '', name: undefined, settleAfterDays: 30 })
  expect([refused.code, refused.err.trim()]).toEqual([1, 'anyhost settle --after takes a whole number of days from 1 to 90, or never, not 91.'])
  expect(organizedThere).toMatchObject({ tags: ['bug'], stage: 'review', catalog: { bug: { name: 'Bug', color: 'red' } }, stages: ['To do', 'Review'] })
  expect([ordered.code, orderedThere]).toEqual([0, ['acme/zoo', 'acme/trip']])
  expect([twice.code, twice.err]).toEqual([1, expect.stringContaining('The project order names each project once.')])
  expect([unknown.code, unknown.err]).toEqual([1, expect.stringContaining('No tag has the id nope.')])
  expect(await listOn(laptop.socket)).toMatchObject({ tags: [], stage: '', catalog: {}, stages: ['To do'] })
}, 90_000)

test("an archive on one machine answers another machine's waiting list read within a second, as the writer tells it shared.json changed", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  type Listed = { readonly version: string; readonly agents: readonly { readonly id: string; readonly archived: boolean }[] }
  const listOn = async (after?: string): Promise<Listed> => (await (await fetch(`http://localhost/agents${after === undefined ? '' : `?after=${encodeURIComponent(after)}`}`, { unix: worker.socket })).json()) as Listed
  await until(async () => (await listOn()).agents.some(({ id }) => id === SESSION), 'the worker listing the session')
  let listed = await listOn()

  await postTo(laptop.socket, '/agents/archive', { session: SESSION, archived: true })
  const started = Date.now()
  while (listed.agents.find(({ id }) => id === SESSION)?.archived !== true && Date.now() - started < 10_000) listed = await listOn(listed.version)

  expect(listed.agents.find(({ id }) => id === SESSION)?.archived).toBe(true)
  expect(Date.now() - started).toBeLessThan(1000)
}, 60_000)

test('an archive sent while the program restarts waits for the program and lands, so the sidebar never rolls it back', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  laptop.child.kill('SIGKILL')
  await laptop.child.exited

  const archiving = anyhostOn(laptop.env, ['archive', SESSION.slice(0, 8)])
  await Bun.sleep(2000)
  await serveOn(laptop.env)
  const archived = await archiving
  const isListedArchived = async (): Promise<boolean> =>
    ((await (await fetch('http://localhost/agents', { unix: laptop.socket })).json()) as { agents: { id: string; archived: boolean }[] }).agents.find(({ id }) => id === SESSION)?.archived === true

  expect(archived).toMatchObject({ code: 0 })
  await until(isListedArchived, 'the list showing the session archived', 30_000)
}, 90_000)

test('an archive asked while the relay connects again waits for it and archives the session, as the Herdr pane asks one whenever its button is pressed', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const reconnect = relay.disconnect(LAPTOP.id)
  await until(async () => (await statusOn(laptop.socket)).relay.state !== 'connected', 'the program reading its relay down')

  const archived = postTo(laptop.socket, '/agents/archive', { session: SESSION.slice(0, 8) })
  await Bun.sleep(500)
  reconnect()

  expect(await archived).toEqual({ status: 200, body: {} })
  expect((await sharedIn(relay)).archived?.[SESSION]?.archived).toBe(true)
}, 60_000)

test('a session archived during its turn keeps working, and its copy here stops as soon as the turn ends, as archiving frees what a finished session holds', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  laptop.status('busy')

  const archived = await postTo(laptop.socket, '/agents/archive', { session: SESSION.slice(0, 8) })
  await Bun.sleep(1000)
  const duringTurn = laptop.claude.signalCode
  laptop.status('idle')

  await until(() => laptop.claude.signalCode !== null, 'the copy stopping once its turn ended')
  expect([archived.status, duringTurn, laptop.claude.signalCode]).toEqual([200, null, 'SIGTERM'])
}, 60_000)
