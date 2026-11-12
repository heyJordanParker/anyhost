import type { IndexedSession } from './capture.ts'
import type { Relay } from './relay.ts'

export type Shared = {
  readonly archived: Readonly<Record<string, { readonly archived: boolean; readonly at: string }>>
  readonly archiveAfterDays: number | null
  readonly visited: Readonly<Record<string, string>>
  readonly lastMachine: string
  readonly reach: Readonly<Record<string, string>>
  readonly parents: Readonly<Record<string, string>>
}

const KEY = 'shared.json'
const EMPTY: Shared = { archived: {}, archiveAfterDays: 7, visited: {}, lastMachine: '', reach: {}, parents: {} }

const read = async (relay: Relay): Promise<{ readonly shared: Shared; readonly etag?: string }> => {
  const [answer] = await relay.read([KEY])
  if (answer === undefined || answer.status === 404) return { shared: EMPTY }
  return { shared: { ...EMPTY, ...(JSON.parse(new TextDecoder().decode(answer.bytes)) as Partial<Shared>) }, etag: answer.etag }
}

export const sharedOf = async (relay: Relay): Promise<Shared> => (await read(relay)).shared

export async function updateShared(relay: Relay, change: (shared: Shared) => Shared): Promise<Shared> {
  for (;;) {
    const { shared, etag } = await read(relay)
    const changed = change(shared)
    const put = await relay.runOne({ op: 'put', key: KEY, bytes: new TextEncoder().encode(JSON.stringify(changed)), if: etag === undefined ? { none: '*' } : { match: etag } })
    if (put.status === 200) return changed
  }
}

export function isArchived(shared: Shared, session: Pick<IndexedSession, 'id' | 'lastActivity'>, now = Date.now()): boolean {
  const mark = shared.archived[session.id]
  if (mark !== undefined && mark.at >= session.lastActivity) return mark.archived
  return shared.archiveAfterDays !== null && now - Date.parse(session.lastActivity) > shared.archiveAfterDays * 86_400_000
}

export const archive = (relay: Relay, session: string, archived: boolean): Promise<Shared> =>
  updateShared(relay, (shared) => ({ ...shared, archived: { ...shared.archived, [session]: { archived, at: new Date().toISOString() } } }))

export const visit = (relay: Relay, session: string, at: string): Promise<Shared> => updateShared(relay, (shared) => ({ ...shared, visited: { ...shared.visited, [session]: at } }))
