import { expect } from 'bun:test'
import { test } from './test.ts'
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
  const pinOrdered = await asked('organize', JSON.stringify([{ op: 'movePins', sessions: [SESSION], before: null }]))
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
  const ordered = await asked('organize', JSON.stringify([{ op: 'moveProjects', projects: ['acme/zoo', 'acme/trip'], before: null }]))
  await until(async () => (await orderOn(worker.socket)).length === 2, 'the worker reading the project order')
  const orderedThere = await orderOn(worker.socket)
  const twice = await asked('organize', JSON.stringify([{ op: 'moveProjects', projects: ['acme/trip', 'acme/trip'], before: null }]))
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
  expect([twice.code, twice.err]).toEqual([1, expect.stringContaining('A move names each item once.')])
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

test('two machines that move projects, pins and worktrees and set entries of one preference from the same read keep every change, as each change moves its own items', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  type Listed = { readonly projectOrder: string[]; readonly pinOrder: string[]; readonly worktreeOrder: Record<string, { machine: string; folder: string }[]>; readonly preferences: Record<string, unknown> }
  const listedOn = async (): Promise<Listed> => (await (await fetch('http://localhost/agents', { unix: worker.socket })).json()) as Listed
  const on = (env: Record<string, string>, changes: object[]) => anyhostOn(env, ['organize', JSON.stringify(changes)])
  const [a, b, c] = [{ machine: 'laptop', folder: '/a' }, { machine: 'laptop', folder: '/b' }, { machine: 'worker', folder: '/c' }]
  const base = await on(laptop.env, [
    { op: 'moveProjects', projects: ['acme/a', 'acme/b', 'acme/c'], before: null },
    { op: 'movePins', sessions: ['p1', 'p2', 'p3'], before: null },
    { op: 'moveWorktrees', project: 'acme/a', worktrees: [a, b, c], before: null },
  ])

  const both = await Promise.all([
    on(laptop.env, [
      { op: 'moveProjects', projects: ['acme/c'], before: 'acme/a' },
      { op: 'movePins', sessions: ['p3'], before: 'p1' },
      { op: 'moveWorktrees', project: 'acme/a', worktrees: [c], before: a },
      { op: 'prefer', key: 'workspaces', entry: 'space-1', value: { mode: 'board' } },
    ]),
    on(worker.env, [
      { op: 'moveProjects', projects: ['acme/d'], before: 'acme/a' },
      { op: 'movePins', sessions: ['p1'], before: null },
      { op: 'moveWorktrees', project: 'acme/a', worktrees: [a], before: null },
      { op: 'prefer', key: 'workspaces', entry: 'space-2', value: { mode: 'tabs' } },
    ]),
  ])
  await until(async () => (await listedOn()).preferences['workspaces'] !== undefined && Object.keys((await listedOn()).preferences['workspaces'] as object).length === 2, 'the worker reading both entries')
  const listed = await listedOn()
  const dropped = await on(laptop.env, [{ op: 'prefer', key: 'workspaces', entry: 'space-1', value: null }, { op: 'moveProjects', projects: ['acme/b', 'acme/b'], before: null }])

  expect([base.code, ...both.map(({ code }) => code)]).toEqual([0, 0, 0])
  expect(listed.projectOrder).toEqual(expect.arrayContaining(['acme/a', 'acme/b', 'acme/c', 'acme/d']))
  expect(listed.projectOrder.indexOf('acme/c')).toBeLessThan(listed.projectOrder.indexOf('acme/a'))
  expect(listed.projectOrder.indexOf('acme/d')).toBeLessThan(listed.projectOrder.indexOf('acme/a'))
  expect(listed.pinOrder.indexOf('p3')).toBeLessThan(listed.pinOrder.indexOf('p1'))
  expect(listed.pinOrder.at(-1)).toBe('p1')
  const worktrees = listed.worktreeOrder['acme/a']?.map(({ folder }) => folder) ?? []
  expect(worktrees.toSorted()).toEqual(['/a', '/b', '/c'])
  expect(worktrees.indexOf('/c')).toBeLessThan(worktrees.indexOf('/a'))
  expect(worktrees.at(-1)).toBe('/a')
  expect(listed.preferences['workspaces']).toEqual({ 'space-1': { mode: 'board' }, 'space-2': { mode: 'tabs' } })
  expect([dropped.code, dropped.err]).toEqual([1, expect.stringContaining('A move names each item once.')])
}, 90_000)

test('the shelves, the unfolded subagents and the closed sessions an older anyhost kept as lists read as entries, the newest closed highest', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const asked = await anyhostOn(laptop.env, ['organize', JSON.stringify([{ op: 'prefer', key: 'shelves', value: ['working', 'settled'] }, { op: 'prefer', key: 'closed', value: ['newest', 'older'] }])])
  const preferences = ((await (await fetch('http://localhost/agents', { unix: laptop.socket })).json()) as { preferences: Record<string, unknown> }).preferences

  expect(asked.code).toBe(0)
  expect(preferences).toEqual({ shelves: { working: true, settled: true }, closed: { newest: 2, older: 1 } })
}, 60_000)

test("a machine's windows live in its own object: two writers patch their own fields of one window, null deletes it, and the window layouts an older anyhost kept as preferences become windows at the next start", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const listed = async (): Promise<{ windows: Record<string, unknown>; preferences: Record<string, unknown> }> => (await (await fetch('http://localhost/agents', { unix: laptop.socket })).json()) as { windows: Record<string, unknown>; preferences: Record<string, unknown> }
  const on = (changes: object[]) => anyhostOn(laptop.env, ['organize', JSON.stringify(changes)])
  const panes = { split: 'right', children: [{ session: 'a1' }, { session: 'a3' }] }

  const written = await Promise.all([
    on([{ op: 'window', id: 'a1', fields: { space: 'anyhost-w-1', index: 0, panes } }]),
    on([{ op: 'window', id: 'a1', fields: { layout: { mode: 'master', side: 'left', ratio: 0.6, offset: 0 }, zoomed: null } }]),
    on([{ op: 'window', id: 'gone', fields: { space: 'anyhost-w-1', index: 1 } }]),
  ])
  await on([{ op: 'window', id: 'gone', fields: null }])
  const windows = (await listed()).windows
  const keys = await relay.keys('windows/')

  await on([
    { op: 'prefer', key: `tabOrder@${LAPTOP.id}`, value: { 'anyhost-w-2': ['b1', 'b2'] } },
    { op: 'prefer', key: `tabLayouts@${LAPTOP.id}`, value: { b1: { split: 'down', children: [{ session: 'b1' }, { session: 'b2' }] } } },
    { op: 'prefer', key: `windows@${LAPTOP.id}`, value: { b1: { mode: 'grid', side: 'left', ratio: 0.6, offset: 0, zoomed: 't4', order: [] } } },
  ])
  laptop.child.kill('SIGKILL')
  await laptop.child.exited
  await serveOn(laptop.env)
  const movedOn = async () => {
    const answer = await fetch('http://localhost/agents', { unix: laptop.socket })
    const text = await answer.text()
    if (answer.status !== 200) throw new Error(`${answer.status} ${text}`)
    return JSON.parse(text) as { windows: Record<string, unknown>; preferences: Record<string, unknown> }
  }
  await until(() => relay.isConnected(LAPTOP.id), 'the restarted program connecting')
  await until(async () => {
    const now = await movedOn()
    return now.windows['b1'] !== undefined && !Object.keys(now.preferences).some((key) => key.includes('@'))
  }, 'the window layouts moving into windows')
  const moved = await movedOn()

  expect(written.map(({ code }) => code)).toEqual([0, 0, 0])
  expect(windows).toEqual({ a1: { space: 'anyhost-w-1', index: 0, panes, layout: { mode: 'master', side: 'left', ratio: 0.6, offset: 0 }, zoomed: null } })
  expect(keys).toEqual([`windows/${LAPTOP.id}.json`])
  expect(moved.windows['b1']).toEqual({ space: 'anyhost-w-2', index: 0, panes: { split: 'down', children: [{ session: 'b1' }, { session: 'b2' }] }, layout: { mode: 'grid', side: 'left', ratio: 0.6, offset: 0, order: [] }, zoomed: 't4' })
  expect(Object.keys(moved.preferences).filter((key) => key.includes('@'))).toEqual([])
}, 90_000)

test('a worktree order and a preference one machine sets reach every machine through the shared list, and a null preference drops it', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  type Listed = { readonly worktreeOrder: Record<string, { machine: string; folder: string }[]>; readonly preferences: Record<string, unknown> }
  const listedOn = async (): Promise<Listed> => (await (await fetch('http://localhost/agents', { unix: worker.socket })).json()) as Listed
  const worktrees = [{ machine: 'worker', folder: '/home/a/trip-b' }, { machine: 'laptop', folder: '/Users/a/trip' }]
  const asked = (changes: object[]) => anyhostOn(laptop.env, ['organize', JSON.stringify(changes)])

  const ordered = await asked([{ op: 'moveWorktrees', project: 'acme/trip', worktrees, before: null }, { op: 'prefer', key: 'shelves', entry: 'working', value: true }])
  await until(async () => (await listedOn()).preferences['shelves'] !== undefined, 'the worker reading the preference')
  const there = await listedOn()
  const twice = await asked([{ op: 'moveWorktrees', project: 'acme/trip', worktrees: [worktrees[0], worktrees[0]], before: null }])
  const dropped = await asked([{ op: 'prefer', key: 'shelves', value: null }])
  await until(async () => (await listedOn()).preferences['shelves'] === undefined, 'the worker reading the dropped preference')

  expect([ordered.code, dropped.code]).toEqual([0, 0])
  expect(there).toMatchObject({ worktreeOrder: { 'acme/trip': worktrees }, preferences: { shelves: { working: true } } })
  expect([twice.code, twice.err]).toEqual([1, expect.stringContaining('A move names each item once.')])
}, 90_000)
