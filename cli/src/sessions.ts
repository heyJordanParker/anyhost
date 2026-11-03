import type { IndexedSession, Segment } from './capture.ts'
import { claimOf } from './claims.ts'
import { devicesOf, type DeviceRecord } from './device.ts'
import type { Store } from './store.ts'

export type ListedSession = IndexedSession & { readonly machine: string; readonly device: string; readonly holder: string }

const decoded = (body: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(body))

export async function listSessions(store: Store, devices?: Map<string, DeviceRecord>): Promise<ListedSession[]> {
  const known = devices ?? (await devicesOf(store))
  const [indexes, claimed] = await Promise.all([
    Promise.all([...known.keys()].map(async (device) => ({ device, stored: await store.get(`sessions/${device}/index.json`) }))),
    store.list('claims/'),
  ])
  const claims = new Map(
    await Promise.all(
      claimed.map(async ({ key }) => {
        const session = key.slice('claims/'.length, -'.json'.length)
        return [session, (await claimOf(store, session))?.claim.device ?? ''] as const
      }),
    ),
  )
  const latest = new Map<string, ListedSession>()
  for (const { device, stored } of indexes) {
    if (stored === undefined) continue
    for (const session of decoded(stored.body) as IndexedSession[]) {
      const earlier = latest.get(session.id)
      const holder = claims.get(session.id) ?? ''
      if (earlier !== undefined && (earlier.device === holder || (device !== holder && earlier.lastActivity >= session.lastActivity))) continue
      latest.set(session.id, { ...session, device, machine: known.get(device)?.name ?? device, holder: holder === '' ? '' : (known.get(holder)?.name ?? holder) })
    }
  }
  return [...latest.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
}

export function chainOf(segments: readonly Segment[]): Segment[] {
  const longest = new Map<number, Segment[]>()
  for (const at of [...new Set(segments.map((segment) => segment.start))].sort((a, b) => b - a)) {
    let best: Segment[] = []
    for (const segment of segments) {
      if (segment.start !== at) continue
      const chain = [segment, ...(longest.get(segment.end) ?? [])]
      if ((chain.at(-1)?.end ?? 0) > (best.at(-1)?.end ?? 0)) best = chain
    }
    longest.set(at, best)
  }
  const chain = longest.get(0)
  if (chain === undefined) throw new Error(`R2 holds no bytes of ${segments[0]?.key ?? 'the transcript'} from byte 0.`)
  const end = chain.at(-1)?.end ?? 0
  for (const left of segments.filter((segment) => segment.end > end)) console.error(`anyhost leaves out ${left.key}, which no piece from byte 0 reaches.`)
  return chain
}

export async function downloadSession(store: Store, devices: Iterable<string>, session: string): Promise<Map<string, Uint8Array>> {
  const byKey = new Map<string, Segment[]>()
  for (const listed of (await Promise.all([...devices].map((device) => store.list(`sessions/${device}/${session}/`)))).flat()) {
    const match = /^sessions\/[^/]+\/(.+)\/(\d+)-(\d+)\.jsonl$/.exec(listed.key)
    if (match?.[1] === undefined) continue
    byKey.set(match[1], [...(byKey.get(match[1]) ?? []), { key: listed.key, start: Number(match[2]), end: Number(match[3]) }])
  }
  const transcripts = new Map<string, Uint8Array>()
  for (const [key, segments] of byKey) {
    const bodies = await Promise.all(chainOf(segments).map(async ({ key: object }) => (await store.get(object))?.body ?? Promise.reject(new Error(`${object} disappeared while anyhost downloaded it.`))))
    transcripts.set(key, Buffer.concat(bodies))
  }
  return transcripts
}
