import type { Database } from 'bun:sqlite'
import { MAX_KEYS, type Claimed, type DeviceRef, type TakeCondition } from '../../relay/protocol.ts'
import type { Relay } from './relay.ts'

export class HeldElsewhere extends Error {
  readonly holder: DeviceRef

  constructor(holder: DeviceRef) {
    super(`${holder.name} holds the session.`)
    this.holder = holder
  }
}

export async function claimsOf(relay: Relay, prefix: string): Promise<ReadonlyMap<string, DeviceRef>> {
  const { claims } = await relay.runOne({ op: 'claims', prefix })
  return new Map(Object.entries(claims))
}

export async function takeClaim(relay: Relay, session: string, options: { readonly take: boolean; readonly if?: TakeCondition }): Promise<{ readonly previous?: DeviceRef; readonly told: boolean }> {
  const answer = await relay.runOne({ op: 'claim', session, take: options.take, ...(options.if === undefined ? {} : { if: options.if }) })
  if (answer.status === 409) throw new HeldElsewhere(answer.holder)
  return answer
}

export type Placement = Pick<Claimed, 'device' | 'wanted' | 'spec' | 'error'>
const NOWHERE: Placement = { device: '', wanted: '' }

export type Holders = {
  current(): Promise<ReadonlyMap<string, string>>
  known(): ReadonlyMap<string, string>
  placementOf(session: string): Placement
  wanted(): ReadonlyMap<string, Placement>
}

type HolderRow = { session: string; device: string; wanted: string; spec: string; error: string }
const placementIn = ({ device, wanted, spec, error }: HolderRow): Placement => ({
  device,
  wanted,
  ...(spec === '' ? {} : { spec: JSON.parse(spec) as Readonly<Record<string, unknown>> }),
  ...(error === '' ? {} : { error }),
})

export function followHolders(relay: Relay, db: Database, onChanged: (changes: readonly Claimed[]) => Promise<void> = async () => undefined): Holders {
  const changedHere = (): number => db.query<{ changed: number }, []>('select changed from holders_changed').get()?.changed ?? 0
  const apply = async (changes: readonly Claimed[]): Promise<void> => {
    db.transaction(() => {
      for (const { session, device, wanted, spec, error = '', changed } of changes) {
        if (device === '' && wanted === '' && spec === undefined && error === '') db.query('delete from holders where session = ?').run(session)
        else
          db.query('insert into holders (session, device, wanted, spec, error) values (?, ?, ?, ?, ?) on conflict (session) do update set device = excluded.device, wanted = excluded.wanted, spec = excluded.spec, error = excluded.error').run(
            session,
            device,
            wanted,
            spec === undefined ? '' : JSON.stringify(spec),
            error,
          )
        db.query('update holders_changed set changed = ?').run(changed)
      }
    })()
    if (changes.length > 0) await onChanged(changes)
  }
  const startAgain = (): void =>
    db.transaction(() => {
      db.run('delete from holders')
      db.run('update holders_changed set changed = 0')
    })()
  const readChanges = async (): Promise<void> => {
    for (;;) {
      const since = changedHere()
      const { changes, last } = await relay.runOne({ op: 'changes', since })
      if (last < since) {
        startAgain()
        continue
      }
      await apply(changes)
      if (changes.length < MAX_KEYS) return
    }
  }
  let reading: Promise<void> | undefined
  let isCaughtUp = false
  const catchUp = (): Promise<void> => {
    const next = (reading ?? Promise.resolve()).then(readChanges).then(() => void (isCaughtUp = true))
    const settled = next.then(
      () => undefined,
      () => undefined,
    )
    reading = settled
    void settled.then(() => {
      if (reading === settled) reading = undefined
    })
    return next
  }
  const readFailed = (error: unknown): void => console.error(`${new Date().toISOString()} anyhost could not read which machine holds each session: ${String(error)}`)
  relay.on('welcome', ({ changed }) => {
    if (changed !== changedHere()) void catchUp().catch(readFailed)
    else isCaughtUp = true
  })
  relay.on('claimed', (claimed) => {
    const since = changedHere()
    if (claimed.changed <= since) return
    if (claimed.changed === since + 1 && reading === undefined) void apply([claimed]).catch(readFailed)
    else void catchUp().catch(readFailed)
  })
  const known = (): ReadonlyMap<string, string> => new Map(db.query<{ session: string; device: string }, []>("select session, device from holders where device != ''").all().map(({ session, device }) => [session, device]))
  return {
    async current() {
      if (!isCaughtUp) await catchUp()
      else if (reading !== undefined) await reading
      return known()
    },
    known,
    placementOf(session) {
      const row = db.query<HolderRow, [string]>('select * from holders where session = ?').get(session)
      return row === null ? NOWHERE : placementIn(row)
    },
    wanted: () => new Map(db.query<HolderRow, []>("select * from holders where wanted != ''").all().map((row) => [row.session, placementIn(row)])),
  }
}
