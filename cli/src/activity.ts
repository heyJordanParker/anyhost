import type { AgentStatus, HookEvent } from '../../relay/protocol.ts'
import { statusOfRecord, type RunningSession } from './claude.ts'

const HEARD: Partial<Record<HookEvent, AgentStatus>> = { turnStart: 'working', asked: 'waiting' }
const RECORD_DECIDES = new Set<HookEvent>(['started', 'turnEnd', 'ended'])

type Heard = { readonly status: AgentStatus; readonly at: number }

export class Activity {
  readonly #heard = new Map<string, Heard>()

  hear(session: string, event: HookEvent, at: number): boolean {
    const status = HEARD[event]
    if (status !== undefined) {
      const before = this.#heard.get(session)
      if (before !== undefined && before.at > at) return false
      this.#heard.set(session, { status, at })
      return before?.status !== status
    }
    return RECORD_DECIDES.has(event) && this.#heard.delete(session)
  }

  of(record: RunningSession | undefined): AgentStatus | undefined {
    if (record === undefined) return undefined
    const heard = this.#heard.get(record.sessionId)
    return heard !== undefined && heard.at > (record.statusSince ?? 0) ? heard.status : statusOfRecord(record.status)
  }

  ofAll(records: readonly RunningSession[]): Record<string, AgentStatus> {
    return Object.fromEntries(records.map((record) => [record.sessionId, this.of(record) ?? 'idle']))
  }
}
