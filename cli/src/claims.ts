import type { DeviceRef } from '../../relay/protocol.ts'
import type { Relay } from './relay.ts'

export class HeldElsewhere extends Error {
  readonly holder: DeviceRef

  constructor(holder: DeviceRef) {
    super(`${holder.name} holds the session.`)
    this.holder = holder
  }
}

// Every session a machine claimed whose id begins with `prefix`, every one with none, with the machine that holds it now.
export async function claimsOf(relay: Relay, prefix?: string): Promise<ReadonlyMap<string, DeviceRef>> {
  const { claims } = await relay.runOne({ op: 'claims', ...(prefix === undefined ? {} : { prefix }) })
  return new Map(Object.entries(claims))
}

// Takes the session for this machine, and answers the machine that held it before, whether that machine said it heard
// of it within about a second, as a connected one does, and the claim's `at`, which a take writes anew and a claim of a
// session this machine holds keeps. One that did not hear hears it in each welcome until it does. A take with `if`
// takes the session from another machine only while that machine's claim has the `at` it names.
export async function takeClaim(relay: Relay, session: string, options: { readonly take: boolean; readonly if?: { readonly at: string } }): Promise<{ readonly previous?: DeviceRef; readonly told: boolean; readonly at: string }> {
  const answer = await relay.runOne({ op: 'claim', session, take: options.take, ...(options.if === undefined ? {} : { if: options.if }) })
  if (answer.status === 409) throw new HeldElsewhere(answer.holder)
  return answer
}
