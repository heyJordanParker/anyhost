import type { IndexedSession } from './capture.ts'
import type { Relay } from './relay.ts'

export type Shared = {
  readonly settled: Readonly<Record<string, { readonly settled: boolean; readonly at: string }>>
  readonly settleAfterDays: number | null
  readonly lastMachine: string
  readonly reach: Readonly<Record<string, string>>
  readonly parents: Readonly<Record<string, string>>
}

const KEY = 'shared.json'
const EMPTY: Shared = { settled: {}, settleAfterDays: 7, lastMachine: '', reach: {}, parents: {} }

const read = async (relay: Relay): Promise<{ readonly shared: Shared; readonly etag?: string }> => {
  const answer = await relay.runOne({ op: 'get', key: KEY })
  if (answer.status !== 200 || !('bytes' in answer)) return { shared: EMPTY }
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

export function isSettled(shared: Shared, session: Pick<IndexedSession, 'id' | 'lastActivity'>, now = Date.now()): boolean {
  const mark = shared.settled[session.id]
  if (mark !== undefined && mark.at >= session.lastActivity) return mark.settled
  return shared.settleAfterDays !== null && now - Date.parse(session.lastActivity) > shared.settleAfterDays * 86_400_000
}

export const settle = (relay: Relay, session: string, settled: boolean): Promise<Shared> =>
  updateShared(relay, (shared) => ({ ...shared, settled: { ...shared.settled, [session]: { settled, at: new Date().toISOString() } } }))
