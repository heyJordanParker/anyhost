import type { AgentStatus } from '../../relay/protocol.ts'
import type { IndexedSession } from './capture.ts'
import type { Read, Relay } from './relay.ts'

export type Shared = {
  readonly archived: Readonly<Record<string, { readonly archived: boolean; readonly at: string }>>
  readonly settled: Readonly<Record<string, { readonly settled: boolean; readonly at: string }>>
  readonly snoozed: Readonly<Record<string, { readonly until: string; readonly at: string }>>
  readonly settleAfterDays: number | null
  readonly projectNames: Readonly<Record<string, string>>
  readonly projectOrder: readonly string[]
  readonly visited: Readonly<Record<string, string>>
  readonly lastMachine: string
  readonly reach: Readonly<Record<string, string>>
  readonly parents: Readonly<Record<string, string>>
  readonly pinned: Readonly<Record<string, string>>
  readonly pinOrder: readonly string[]
  readonly tags: Readonly<Record<string, Tag>>
  readonly tagged: Readonly<Record<string, readonly string[]>>
  readonly stages: readonly Stage[]
  readonly staged: Readonly<Record<string, string>>
  readonly worktreeOrder: Readonly<Record<string, readonly Worktree[]>>
  readonly preferences: Readonly<Record<string, unknown>>
}

export type Worktree = { readonly machine: string; readonly folder: string }
export type Pane = { readonly session: string } | { readonly split: string; readonly children: readonly Pane[] }
export type Window = { readonly space?: string; readonly index?: number; readonly panes?: Pane; readonly layout?: Readonly<Record<string, unknown>>; readonly zoomed?: string | null }
export type Windows = Readonly<Record<string, Window>>

export type Tag = { readonly name: string; readonly color: string }
export type Stage = { readonly id: string; readonly name: string }
export type Organize =
  | { readonly op: 'defineTag'; readonly id: string; readonly name: string; readonly color: string }
  | { readonly op: 'dropTag'; readonly id: string }
  | { readonly op: 'tagSession'; readonly session: string; readonly tag: string; readonly on: boolean }
  | { readonly op: 'defineStages'; readonly stages: readonly Stage[] }
  | { readonly op: 'stageSession'; readonly session: string; readonly stage: string }
  | { readonly op: 'moveProjects'; readonly projects: readonly string[]; readonly before: string | null }
  | { readonly op: 'movePins'; readonly sessions: readonly string[]; readonly before: string | null }
  | { readonly op: 'moveWorktrees'; readonly project: string; readonly worktrees: readonly Worktree[]; readonly before: Worktree | null }
  | { readonly op: 'prefer'; readonly key: string; readonly entry?: string; readonly value: unknown }
  | { readonly op: 'window'; readonly id: string; readonly fields: Window | null }

export const SHARED_KEY = 'shared.json'
export const windowsKeyOf = (device: string): string => `windows/${device}.json`
const DAY_MS = 86_400_000
export const SETTLE_MOST_DAYS = 90
const EMPTY: Shared = { archived: {}, settled: {}, snoozed: {}, settleAfterDays: 7, projectNames: {}, projectOrder: [], visited: {}, lastMachine: '', reach: {}, parents: {}, pinned: {}, pinOrder: [], tags: {}, tagged: {}, stages: [], staged: {}, worktreeOrder: {}, preferences: {} }

const decodedOnce = new WeakMap<Read, Shared>()
const LISTED_PREFERENCES = ['shelves', 'unfolded', 'closed']

const withEntries = (preferences: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(preferences).map(([key, value]) => [key, LISTED_PREFERENCES.includes(key) && Array.isArray(value) ? Object.fromEntries(value.map((entry, at) => [String(entry), key === 'closed' ? value.length - at : true])) : value]))


export function sharedIn(answer: Read | undefined): Shared {
  if (answer === undefined || answer.status === 404) return EMPTY
  const kept = decodedOnce.get(answer)
  if (kept !== undefined) return kept
  const stored = without(JSON.parse(new TextDecoder().decode(answer.bytes)) as Record<string, unknown>, 'archiveAfterDays') as Partial<Shared>
  const shared = { ...EMPTY, ...stored, preferences: withEntries(stored.preferences ?? {}) }
  decodedOnce.set(answer, shared)
  return shared
}

export const windowsIn = (answer: Read | undefined): Windows => (answer === undefined || answer.status === 404 ? {} : (JSON.parse(new TextDecoder().decode(answer.bytes)) as Windows))

export const sharedOf = async (relay: Relay): Promise<Shared> => sharedIn((await relay.read([SHARED_KEY]))[0])

export async function updateObject<T>(relay: Relay, key: string, decode: (answer: Read | undefined) => T, change: (value: T) => T): Promise<T> {
  for (;;) {
    const [answer] = await relay.read([key])
    const changed = change(decode(answer))
    const put = await relay.runOne({ op: 'put', key, bytes: new TextEncoder().encode(JSON.stringify(changed)), if: answer !== undefined && 'etag' in answer ? { match: answer.etag } : { none: '*' } })
    if (put.status === 200) return changed
  }
}

export const updateShared = (relay: Relay, change: (shared: Shared) => Shared): Promise<Shared> => updateObject(relay, SHARED_KEY, sharedIn, change)

export function isArchived(shared: Shared, session: Pick<IndexedSession, 'id' | 'lastActivity'>): boolean {
  const mark = shared.archived[session.id]
  return mark !== undefined && mark.at >= session.lastActivity && mark.archived
}

type Activity = Pick<IndexedSession, 'id' | 'lastActivity' | 'lastPromptAt'>

export function isSnoozed(shared: Shared, session: Activity, status: AgentStatus | '', now = Date.now()): boolean {
  const snooze = shared.snoozed[session.id]
  return snooze !== undefined && Date.parse(snooze.until) > now && status !== 'waiting' && !(session.lastPromptAt > snooze.at)
}

export function settledAtOf(shared: Shared, session: Activity, status: AgentStatus | '', now = Date.now()): string {
  const mark = shared.settled[session.id]
  if (mark !== undefined && mark.at >= session.lastActivity) return mark.settled ? mark.at : ''
  if (shared.settleAfterDays === null || shared.pinned[session.id] !== undefined || status === 'working' || status === 'waiting' || isSnoozed(shared, session, status, now)) return ''
  const until = Date.parse(shared.snoozed[session.id]?.until ?? '')
  const settlesAt = Math.max(Date.parse(session.lastActivity), until <= now ? until : 0) + shared.settleAfterDays * DAY_MS
  return now > settlesAt ? new Date(settlesAt).toISOString() : ''
}

const markedNow = (): string => new Date().toISOString()

export const archive = (relay: Relay, session: string, archived: boolean): Promise<Shared> =>
  updateShared(relay, (shared) => ({ ...shared, archived: { ...shared.archived, [session]: { archived, at: markedNow() } } }))

export const settle = (relay: Relay, session: string, settled: boolean): Promise<Shared> =>
  updateShared(relay, (shared) => ({
    ...shared,
    settled: { ...shared.settled, [session]: { settled, at: markedNow() } },
    ...(settled ? unpinned(shared, session) : {}),
    snoozed: settled ? without(shared.snoozed, session) : shared.snoozed,
  }))

export const snooze = (relay: Relay, session: string, until: string | null): Promise<Shared> =>
  updateShared(relay, (shared) => ({ ...shared, snoozed: until === null ? without(shared.snoozed, session) : { ...shared.snoozed, [session]: { until, at: markedNow() } } }))

export function nameProject(relay: Relay, project: string, name: string | null): Promise<Shared> {
  if (name !== null && name.trim() === '') throw new Error('A project name needs a letter. Drop the custom name with null instead.')
  return updateShared(relay, (shared) => ({ ...shared, projectNames: name === null ? without(shared.projectNames, project) : { ...shared.projectNames, [project]: name.trim() } }))
}

export const visit = (relay: Relay, session: string, at: string): Promise<Shared> => updateShared(relay, (shared) => ({ ...shared, visited: { ...shared.visited, [session]: at } }))

const without = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([each]) => each !== key))
const unpinned = (shared: Shared, session: string): Pick<Shared, 'pinned' | 'pinOrder'> => ({ pinned: without(shared.pinned, session), pinOrder: shared.pinOrder.filter((each) => each !== session) })
const worktreeKey = ({ machine, folder }: Worktree): string => `${machine}\0${folder}`

function moved<T>(list: readonly T[], items: readonly T[], before: T | null, keyOf: (item: T) => string = String): T[] {
  const keys = new Set(items.map(keyOf))
  if (keys.size !== items.length) throw new Error('A move names each item once.')
  const rest = list.filter((item) => !keys.has(keyOf(item)))
  const at = before === null ? -1 : rest.findIndex((item) => keyOf(item) === keyOf(before))
  const place = at < 0 ? rest.length : at
  return [...rest.slice(0, place), ...items, ...rest.slice(place)]
}

const preferred = (preferences: Readonly<Record<string, unknown>>, key: string, entry: string | undefined, value: unknown): Record<string, unknown> => {
  if (entry === undefined) return value === null ? without(preferences, key) : { ...preferences, [key]: value }
  const was = preferences[key]
  const entries = typeof was === 'object' && was !== null && !Array.isArray(was) ? (was as Record<string, unknown>) : {}
  const next = value === null ? without(entries, entry) : { ...entries, [entry]: value }
  return Object.keys(next).length === 0 ? without(preferences, key) : { ...preferences, [key]: next }
}

function organized(shared: Shared, change: Exclude<Organize, { op: 'window' }>): Shared {
  switch (change.op) {
    case 'defineTag':
      if (change.name.trim() === '') throw new Error('A tag needs a name.')
      return { ...shared, tags: { ...shared.tags, [change.id]: { name: change.name.trim(), color: change.color } } }
    case 'dropTag':
      return { ...shared, tags: without(shared.tags, change.id), tagged: Object.fromEntries(Object.entries(shared.tagged).flatMap(([session, tags]) => { const kept = tags.filter((tag) => tag !== change.id); return kept.length === 0 ? [] : [[session, kept] as const] })) }
    case 'tagSession': {
      if (shared.tags[change.tag] === undefined) throw new Error(`No tag has the id ${change.tag}.`)
      const tags = (shared.tagged[change.session] ?? []).filter((tag) => tag !== change.tag)
      const next = change.on ? [...tags, change.tag] : tags
      return { ...shared, tagged: next.length === 0 ? without(shared.tagged, change.session) : { ...shared.tagged, [change.session]: next } }
    }
    case 'defineStages': {
      const kept = new Set(change.stages.map(({ id }) => id))
      if (kept.size !== change.stages.length || change.stages.some(({ name }) => name.trim() === '')) throw new Error('Each stage needs a name and an id of its own.')
      return { ...shared, stages: change.stages.map(({ id, name }) => ({ id, name: name.trim() })), staged: Object.fromEntries(Object.entries(shared.staged).filter(([, stage]) => kept.has(stage))) }
    }
    case 'stageSession':
      if (change.stage !== '' && !shared.stages.some(({ id }) => id === change.stage)) throw new Error(`No stage has the id ${change.stage}.`)
      return { ...shared, staged: change.stage === '' ? without(shared.staged, change.session) : { ...shared.staged, [change.session]: change.stage } }
    case 'moveProjects':
      return { ...shared, projectOrder: moved(shared.projectOrder, change.projects, change.before) }
    case 'movePins':
      return { ...shared, pinOrder: moved(shared.pinOrder, change.sessions, change.before) }
    case 'moveWorktrees':
      return { ...shared, worktreeOrder: { ...shared.worktreeOrder, [change.project]: moved(shared.worktreeOrder[change.project] ?? [], change.worktrees, change.before, worktreeKey) } }
    case 'prefer':
      return { ...shared, preferences: preferred(shared.preferences, change.key, change.entry, change.value) }
  }
}

const windowed = (windows: Windows, change: Extract<Organize, { op: 'window' }>): Windows =>
  change.fields === null ? without(windows, change.id) : { ...windows, [change.id]: { ...windows[change.id], ...change.fields } }

export async function organize(relay: Relay, device: string, changes: readonly Organize[]): Promise<void> {
  const windowChanges = changes.filter((change): change is Extract<Organize, { op: 'window' }> => change.op === 'window')
  const sharedChanges = changes.filter((change): change is Exclude<Organize, { op: 'window' }> => change.op !== 'window')
  if (sharedChanges.length > 0) await updateShared(relay, (shared) => sharedChanges.reduce(organized, shared))
  if (windowChanges.length > 0) await updateObject(relay, windowsKeyOf(device), windowsIn, (windows) => windowChanges.reduce(windowed, windows))
}

const leavesOf = (pane: Pane): string[] => ('session' in pane ? [pane.session] : pane.children.flatMap(leavesOf))

export async function moveWindowPreferences(relay: Relay, device: string): Promise<void> {
  const keys = [`tabOrder@${device}`, `tabLayouts@${device}`, `windows@${device}`]
  const { preferences } = await sharedOf(relay)
  if (!keys.some((key) => key in preferences)) return
  const [orders, trees, layouts] = keys.map((key) => (preferences[key] ?? {}) as Record<string, unknown>) as [Record<string, string[]>, Record<string, Pane>, Record<string, Record<string, unknown>>]
  const moved: Record<string, Window> = {}
  for (const id of new Set([...Object.keys(trees), ...Object.keys(layouts)])) {
    const panes = trees[id]
    const first = panes === undefined ? undefined : leavesOf(panes)[0]
    const [space, order] = Object.entries(orders).find(([, sessions]) => first !== undefined && sessions.includes(first)) ?? []
    const { zoomed = null, ...layout } = layouts[id] ?? {}
    moved[id] = { ...(space === undefined || order === undefined || first === undefined ? {} : { space, index: order.indexOf(first) }), ...(panes === undefined ? {} : { panes }), ...(layouts[id] === undefined ? {} : { layout, zoomed: zoomed as string | null }) }
  }
  await updateObject(relay, windowsKeyOf(device), windowsIn, (windows) => ({ ...moved, ...windows }))
  await updateShared(relay, (shared) => ({ ...shared, preferences: Object.fromEntries(Object.entries(shared.preferences).filter(([key]) => !keys.includes(key))) }))
}

export const pin = (relay: Relay, session: string, pinned: boolean): Promise<Shared> =>
  updateShared(relay, (shared) =>
    pinned
      ? { ...shared, pinned: { ...shared.pinned, [session]: shared.pinned[session] ?? markedNow() }, settled: { ...shared.settled, [session]: { settled: false, at: markedNow() } }, snoozed: without(shared.snoozed, session) }
      : { ...shared, ...unpinned(shared, session) },
  )
