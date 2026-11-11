import type { DeviceRef } from '../../relay/protocol.ts'
import type { Relay } from './relay.ts'

export class HeldElsewhere extends Error {
  readonly holder: DeviceRef

  constructor(holder: DeviceRef) {
    super(`${holder.name} holds the session.`)
    this.holder = holder
  }
}

export async function claimsOf(relay: Relay, prefix?: string): Promise<ReadonlyMap<string, DeviceRef>> {
  const { claims } = await relay.runOne({ op: 'claims', ...(prefix === undefined ? {} : { prefix }) })
  return new Map(Object.entries(claims))
}

export async function takeClaim(relay: Relay, session: string, options: { readonly take: boolean; readonly if?: { readonly at: string } }): Promise<{ readonly previous?: DeviceRef; readonly told: boolean; readonly at: string }> {
  const answer = await relay.runOne({ op: 'claim', session, take: options.take, ...(options.if === undefined ? {} : { if: options.if }) })
  if (answer.status === 409) throw new HeldElsewhere(answer.holder)
  return answer
}
