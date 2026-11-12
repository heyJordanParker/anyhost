import type { Database } from 'bun:sqlite'
import { MAX_KEYS, type Claimed, type DeviceRef } from '../../relay/protocol.ts'
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

export async function takeClaim(relay: Relay, session: string, options: { readonly take: boolean; readonly if?: { readonly at: string } }): Promise<{ readonly previous?: DeviceRef; readonly told: boolean; readonly at: string }> {
  const answer = await relay.runOne({ op: 'claim', session, take: options.take, ...(options.if === undefined ? {} : { if: options.if }) })
  if (answer.status === 409) throw new HeldElsewhere(answer.holder)
  return answer
}

export type Holders = { current(): Promise<ReadonlyMap<string, string>> }

export function followHolders(relay: Relay, db: Database): Holders {
  const changedHere = (): number => db.query<{ changed: number }, []>('select changed from holders_changed').get()?.changed ?? 0
  const apply = (changes: readonly Claimed[]): void =>
    db.transaction(() => {
      for (const { session, device, changed } of changes) {
        if (device === '') db.query('delete from holders where session = ?').run(session)
        else db.query('insert into holders (session, device) values (?, ?) on conflict (session) do update set device = excluded.device').run(session, device)
        db.query('update holders_changed set changed = ?').run(changed)
      }
    })()
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
      apply(changes)
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
  relay.on('welcome', ({ changed }) => {
    if (changed !== changedHere()) void catchUp().catch((error: unknown) => console.error(`${new Date().toISOString()} anyhost could not read which machine holds each session: ${String(error)}`))
    else isCaughtUp = true
  })
  relay.on('claimed', (claimed) => {
    const since = changedHere()
    if (claimed.changed <= since) return
    if (claimed.changed === since + 1 && reading === undefined) apply([claimed])
    else void catchUp().catch((error: unknown) => console.error(`${new Date().toISOString()} anyhost could not read which machine holds each session: ${String(error)}`))
  })
  return {
    async current() {
      if (!isCaughtUp) await catchUp()
      else if (reading !== undefined) await reading
      return new Map(db.query<{ session: string; device: string }, []>('select session, device from holders').all().map(({ session, device }) => [session, device]))
    },
  }
}
