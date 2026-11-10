import type { IndexedSession } from './capture.ts'
import type { Relay } from './relay.ts'

// What every machine shares beyond the sessions themselves: which sessions the person settled or brought back, after
// how many idle days a session settles by itself (null: never), the machine the person last started a session on, and
// how herdr-core reaches each machine, by its device id. One object in R2, which every write replaces whole on the etag
// it read, so two machines' writes never lose one another.
export type Shared = {
  readonly settled: Readonly<Record<string, { readonly settled: boolean; readonly at: string }>>
  readonly settleAfterDays: number | null
  readonly lastMachine: string
  readonly reach: Readonly<Record<string, string>>
}

const KEY = 'shared.json'
const EMPTY: Shared = { settled: {}, settleAfterDays: 7, lastMachine: '', reach: {} }

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

// A session is settled when the person settled it after its last activity, or brought it back after it, else when it
// sat idle longer than the shared setting, so working in a settled session brings it back by itself.
export function isSettled(shared: Shared, session: Pick<IndexedSession, 'id' | 'lastActivity'>, now = Date.now()): boolean {
  const mark = shared.settled[session.id]
  if (mark !== undefined && mark.at >= session.lastActivity) return mark.settled
  return shared.settleAfterDays !== null && now - Date.parse(session.lastActivity) > shared.settleAfterDays * 86_400_000
}

export const settle = (relay: Relay, session: string, settled: boolean): Promise<Shared> =>
  updateShared(relay, (shared) => ({ ...shared, settled: { ...shared.settled, [session]: { settled, at: new Date().toISOString() } } }))
