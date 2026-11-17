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

export type Tag = { readonly name: string; readonly color: string }
export type Stage = { readonly id: string; readonly name: string }
export type Organize =
  | { readonly op: 'defineTag'; readonly id: string; readonly name: string; readonly color: string }
  | { readonly op: 'dropTag'; readonly id: string }
  | { readonly op: 'tagSession'; readonly session: string; readonly tag: string; readonly on: boolean }
  | { readonly op: 'defineStages'; readonly stages: readonly Stage[] }
  | { readonly op: 'stageSession'; readonly session: string; readonly stage: string }
  | { readonly op: 'orderProjects'; readonly projects: readonly string[] }
  | { readonly op: 'orderPins'; readonly sessions: readonly string[] }
  | { readonly op: 'orderWorktrees'; readonly project: string; readonly worktrees: readonly Worktree[] }
  | { readonly op: 'prefer'; readonly key: string; readonly value: unknown }

export const SHARED_KEY = 'shared.json'
const DAY_MS = 86_400_000
export const SETTLE_MOST_DAYS = 90
const EMPTY: Shared = { archived: {}, settled: {}, snoozed: {}, settleAfterDays: 7, projectNames: {}, projectOrder: [], visited: {}, lastMachine: '', reach: {}, parents: {}, pinned: {}, pinOrder: [], tags: {}, tagged: {}, stages: [], staged: {}, worktreeOrder: {}, preferences: {} }

const decodedOnce = new WeakMap<Read, Shared>()


export function sharedIn(answer: Read | undefined): Shared {
  if (answer === undefined || answer.status === 404) return EMPTY
  const kept = decodedOnce.get(answer)
  if (kept !== undefined) return kept
  const stored = without(JSON.parse(new TextDecoder().decode(answer.bytes)) as Record<string, unknown>, 'archiveAfterDays') as Partial<Shared>
  const shared = { ...EMPTY, ...stored }
  decodedOnce.set(answer, shared)
  return shared
}

const read = async (relay: Relay): Promise<{ readonly shared: Shared; readonly etag?: string }> => {
  const [answer] = await relay.read([SHARED_KEY])
  return { shared: sharedIn(answer), ...(answer !== undefined && 'etag' in answer ? { etag: answer.etag } : {}) }
}

export const sharedOf = async (relay: Relay): Promise<Shared> => (await read(relay)).shared

export async function updateShared(relay: Relay, change: (shared: Shared) => Shared): Promise<Shared> {
  for (;;) {
    const { shared, etag } = await read(relay)
    const changed = change(shared)
    const put = await relay.runOne({ op: 'put', key: SHARED_KEY, bytes: new TextEncoder().encode(JSON.stringify(changed)), if: etag === undefined ? { none: '*' } : { match: etag } })
    if (put.status === 200) return changed
  }
}

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

function organized(shared: Shared, change: Organize): Shared {
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
    case 'orderProjects':
      if (new Set(change.projects).size !== change.projects.length) throw new Error('The project order names each project once.')
      return { ...shared, projectOrder: change.projects }
    case 'orderPins':
      if (new Set(change.sessions).size !== change.sessions.length) throw new Error('The pin order names each session once.')
      return { ...shared, pinOrder: change.sessions }
    case 'orderWorktrees':
      if (new Set(change.worktrees.map(({ machine, folder }) => `${machine}\0${folder}`)).size !== change.worktrees.length) throw new Error('The worktree order names each worktree once.')
      return { ...shared, worktreeOrder: { ...shared.worktreeOrder, [change.project]: change.worktrees } }
    case 'prefer':
      return { ...shared, preferences: change.value === null ? without(shared.preferences, change.key) : { ...shared.preferences, [change.key]: change.value } }
  }
}

export const organize = (relay: Relay, changes: readonly Organize[]): Promise<Shared> => updateShared(relay, (shared) => changes.reduce(organized, shared))

export const pin = (relay: Relay, session: string, pinned: boolean): Promise<Shared> =>
  updateShared(relay, (shared) =>
    pinned
      ? { ...shared, pinned: { ...shared.pinned, [session]: shared.pinned[session] ?? markedNow() }, settled: { ...shared.settled, [session]: { settled: false, at: markedNow() } }, snoozed: without(shared.snoozed, session) }
      : { ...shared, ...unpinned(shared, session) },
  )
