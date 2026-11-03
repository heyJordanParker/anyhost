import type { Store } from './store.ts'

export type Claim = { readonly device: string; readonly at: string }

const claimKey = (session: string): string => `claims/${session}.json`

export class HeldElsewhere extends Error {
  readonly device: string

  constructor(device: string) {
    super(`The device ${device} holds the session.`)
    this.device = device
  }
}

export async function claimOf(store: Store, session: string): Promise<{ claim: Claim; etag: string } | undefined> {
  const stored = await store.get(claimKey(session))
  return stored === undefined ? undefined : { claim: JSON.parse(new TextDecoder().decode(stored.body)) as Claim, etag: stored.etag }
}

export async function heldElsewhere(store: Store, device: string, sessions: ReadonlySet<string>): Promise<Set<string>> {
  if (sessions.size === 0) return new Set()
  const claimed = (await store.list('claims/')).map(({ key }) => key.slice('claims/'.length, -'.json'.length)).filter((session) => sessions.has(session))
  const holders = await Promise.all(claimed.map(async (session) => ({ session, device: (await claimOf(store, session))?.claim.device ?? device })))
  return new Set(holders.filter((holder) => holder.device !== device).map(({ session }) => session))
}

export async function takeClaim(store: Store, session: string, device: string, options: { take: boolean }): Promise<void> {
  const held = await claimOf(store, session)
  if (held !== undefined && held.claim.device !== device && !options.take) throw new HeldElsewhere(held.claim.device)
  const body = JSON.stringify({ device, at: new Date().toISOString() } satisfies Claim)
  const etag = await store.put(claimKey(session), body, held === undefined ? { ifNoneMatch: '*' } : { ifMatch: held.etag })
  if (etag === undefined) throw new Error(`Another machine took the session ${session} while this one did. Run the command again to see who holds it.`)
}
