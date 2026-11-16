import type { AgentStatus, HookEvent } from '../../relay/protocol.ts'
import { statusOfRecord, type RunningSession } from './claude.ts'

const HEARD: Partial<Record<HookEvent, AgentStatus>> = { turnStart: 'working', asked: 'waiting', turnEnd: 'idle' }
const RECORD_DECIDES = new Set<HookEvent>(['started', 'ended', 'quit'])
const BACKGROUND = new Set(['busy', 'shell'])

type Heard = { readonly status: AgentStatus; readonly at: number }
export type Shown = { readonly statuses: Readonly<Record<string, AgentStatus>>; readonly since: Readonly<Record<string, number>>; readonly background: readonly string[] }

export class Activity {
  readonly #heard = new Map<string, Heard>()
  readonly #inTurn = new Set<string>()

  hear(session: string, event: HookEvent, at: number): boolean {
    if (event === 'turnStart') this.#inTurn.add(session)
    if (event === 'turnEnd' || RECORD_DECIDES.has(event)) this.#inTurn.delete(session)
    const status = HEARD[event]
    if (status !== undefined) {
      const before = this.#heard.get(session)
      if (before !== undefined && before.at > at) return false
      this.#heard.set(session, { status, at })
      return before?.status !== status
    }
    return RECORD_DECIDES.has(event) && this.#heard.delete(session)
  }

  #newer(record: RunningSession): Heard | undefined {
    const heard = this.#heard.get(record.sessionId)
    return heard !== undefined && heard.at > (record.statusSince ?? 0) ? heard : undefined
  }

  of(record: RunningSession | undefined): AgentStatus | undefined {
    if (record === undefined) return undefined
    const heard = this.#newer(record)
    return heard !== undefined && heard.status !== 'idle' ? heard.status : statusOfRecord(record.status)
  }

  mainOf(record: RunningSession): AgentStatus {
    return this.#newer(record)?.status ?? (record.status === 'shell' ? 'idle' : statusOfRecord(record.status))
  }

  mainSince(record: RunningSession): number {
    return this.#newer(record)?.at ?? record.statusSince ?? 0
  }

  isBackground(record: RunningSession): boolean {
    return !this.#inTurn.has(record.sessionId) && this.mainOf(record) !== 'working' && BACKGROUND.has(record.status ?? '')
  }

  shownOf(records: readonly RunningSession[]): Shown {
    return {
      statuses: Object.fromEntries(records.map((record) => [record.sessionId, this.mainOf(record)])),
      since: Object.fromEntries(records.map((record) => [record.sessionId, this.mainSince(record)])),
      background: records.filter((record) => this.isBackground(record)).map(({ sessionId }) => sessionId),
    }
  }
}
