import type { AgentStatus, HookEvent } from '../../relay/protocol.ts'
import { statusOfRecord, type RunningSession } from './claude.ts'
import type { Turn } from './transcript.ts'

const HEARD: Partial<Record<HookEvent, AgentStatus>> = { turnStart: 'working', asked: 'waiting', turnEnd: 'idle' }
const OPENS: Partial<Record<HookEvent, boolean>> = { turnStart: true, turnEnd: false, ended: false, quit: false }
const RECORD_DECIDES = new Set<HookEvent>(['started', 'ended', 'quit'])
const BACKGROUND = new Set(['busy', 'shell'])
const OUT_OF_TURN = new Set(['idle', 'shell'])

type Heard = { readonly status: AgentStatus; readonly at: number }
export type Shown = { readonly statuses: Readonly<Record<string, AgentStatus>>; readonly since: Readonly<Record<string, number>>; readonly background: readonly string[] }

export class Activity {
  readonly #heard = new Map<string, Heard>()
  readonly #turns = new Map<string, Turn>()
  readonly #readFor = new Map<string, number>()

  hear(session: string, event: HookEvent, at: number): boolean {
    const isOpen = OPENS[event]
    const turned = isOpen !== undefined && this.#learn(session, { isOpen, at })
    const status = HEARD[event]
    if (status === undefined) return (RECORD_DECIDES.has(event) && this.#heard.delete(session)) || turned
    const before = this.#heard.get(session)
    if (before !== undefined && before.at > at) return turned
    this.#heard.set(session, { status, at })
    return turned || before?.status !== status
  }

  #learn(session: string, turn: Turn): boolean {
    const known = this.#turns.get(session)
    if (known !== undefined && known.at > turn.at) return false
    this.#turns.set(session, turn)
    return known?.isOpen !== turn.isOpen
  }

  #newer(record: RunningSession): Heard | undefined {
    const heard = this.#heard.get(record.sessionId)
    return heard !== undefined && heard.at > (record.statusSince ?? 0) ? heard : undefined
  }

  #isInTurn(record: RunningSession): boolean {
    const known = this.#turns.get(record.sessionId)
    if (OUT_OF_TURN.has(record.status ?? 'idle') && (known === undefined || known.at <= (record.statusSince ?? 0))) return false
    return known?.isOpen ?? true
  }

  #isUnread(record: RunningSession): boolean {
    const known = this.#turns.get(record.sessionId)
    const since = record.statusSince ?? 0
    return record.status === 'busy' && this.#readFor.get(record.sessionId) !== since && (known === undefined || known.at < since)
  }

  of(record: RunningSession | undefined): AgentStatus | undefined {
    if (record === undefined) return undefined
    const heard = this.#newer(record)
    return heard !== undefined && heard.status !== 'idle' ? heard.status : statusOfRecord(record.status)
  }

  mainOf(record: RunningSession): AgentStatus {
    return this.#newer(record)?.status ?? (this.isBackground(record) ? 'idle' : statusOfRecord(record.status))
  }

  mainSince(record: RunningSession): number {
    return this.#newer(record)?.at ?? record.statusSince ?? 0
  }

  isBackground(record: RunningSession): boolean {
    return BACKGROUND.has(record.status ?? '') && !this.#isInTurn(record)
  }

  async shownOf(records: readonly RunningSession[], lastTurnOf: (session: string) => Promise<Turn | undefined>): Promise<Shown> {
    await Promise.all(
      records
        .filter((record) => this.#isUnread(record))
        .map(async ({ sessionId, statusSince = 0 }) => {
          this.#readFor.set(sessionId, statusSince)
          const turn = await lastTurnOf(sessionId)
          if (turn !== undefined) this.#learn(sessionId, turn)
        }),
    )
    return {
      statuses: Object.fromEntries(records.map((record) => [record.sessionId, this.mainOf(record)])),
      since: Object.fromEntries(records.map((record) => [record.sessionId, this.mainSince(record)])),
      background: records.filter((record) => this.isBackground(record)).map(({ sessionId }) => sessionId),
    }
  }
}
