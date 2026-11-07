import type { Claim, DeviceRef } from '../../relay/protocol.ts'
import type { Relay } from './relay.ts'

export class HeldElsewhere extends Error {
  readonly holder: DeviceRef

  constructor(holder: DeviceRef) {
    super(`${holder.name} holds the session.`)
    this.holder = holder
  }
}

// Every session a machine claimed whose id begins with `prefix`, every one with none, with the machine that holds it now.
export async function claimsOf(relay: Relay, prefix?: string): Promise<ReadonlyMap<string, Claim>> {
  const { claims } = await relay.runOne({ op: 'claims', ...(prefix === undefined ? {} : { prefix }) })
  return new Map(Object.entries(claims))
}

// Takes the session for this machine, and answers the machine that held it before and whether the relay told it at
// once, as it does a machine connected now. A machine it could not tell hears it in its next welcome.
export async function takeClaim(relay: Relay, session: string, options: { take: boolean }): Promise<{ readonly previous?: DeviceRef; readonly told: boolean }> {
  const answer = await relay.runOne({ op: 'claim', session, take: options.take })
  if (answer.status === 409) throw new HeldElsewhere(answer.holder)
  return answer
}
