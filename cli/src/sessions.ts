import { closeSync, ftruncateSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type * as Protocol from '../../relay/protocol.ts'
import { chainOf, framesOf, journalPrefix, type Capture, type IndexedSession, type RecordHeader } from './capture.ts'
import { devicesOf } from './device.ts'
import type { Relay } from './relay.ts'
import { isArchived, sharedOf } from './shared.ts'

export type ListedSession = IndexedSession & { readonly machine: string; readonly device: string; readonly holder: string }
export type Segment = Pick<RecordHeader, 'device' | 'checkout' | 'path'> & { readonly offset: number; readonly size: number }
type Written = RecordHeader & { readonly after: NonNullable<RecordHeader['after']> }
export type ReplayedFile = { readonly staged: string; readonly size: number; readonly segments: readonly Segment[]; readonly last: Written }
export type Replayed = {
  readonly files: ReadonlyMap<string, ReplayedFile>
  readonly deleted: ReadonlySet<string>
  readonly code: ReadonlyMap<string, { readonly header: RecordHeader; readonly bytes: Uint8Array }>
  readonly end: number
  readonly sealedEnd: number
}

const decoded = (body: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(body))

export async function indexesOf(relay: Relay, devices: Iterable<string>): Promise<Map<string, IndexedSession[]>> {
  const ids = [...devices]
  const read = await relay.read(ids.map((device) => `sessions/${device}/index.json`))
  return new Map(ids.flatMap((device, at) => {
    const index = read[at]
    return index !== undefined && 'bytes' in index ? [[device, decoded(index.bytes) as IndexedSession[]] as const] : []
  }))
}

export async function listSessions(
  capture: Pick<Capture, 'relay' | 'holders'>,
  read?: {
    readonly devices: ReadonlyMap<string, Protocol.Device>
    readonly indexes: ReadonlyMap<string, readonly IndexedSession[]>
    readonly holders: ReadonlyMap<string, string>
  },
): Promise<ListedSession[]> {
  const { relay } = capture
  const known = read?.devices ?? (await devicesOf(relay))
  const [indexes, holders] = await Promise.all([read?.indexes ?? indexesOf(relay, known.keys()), read?.holders ?? capture.holders.current()])
  const latest = new Map<string, ListedSession>()
  for (const [device, index] of indexes) {
    for (const session of index) {
      if (session.cwd === '') continue
      const earlier = latest.get(session.id)
      const holder = holders.get(session.id)
      if (earlier !== undefined && (earlier.device === holder || (device !== holder && earlier.lastActivity >= session.lastActivity))) continue
      latest.set(session.id, { ...session, device, machine: known.get(device)?.name ?? device, holder: holder === undefined ? '' : (known.get(holder)?.name ?? holder) })
    }
  }
  return [...latest.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
}

export type Agent = ListedSession & { readonly status: string; readonly archived: boolean; readonly visitedAt: string; readonly parent: string }
export type Agents = { readonly agents: readonly Agent[]; readonly archiveAfterDays: number | null; readonly lastMachine: string }

export async function agentsOf(capture: Pick<Capture, 'relay' | 'holders'>, statuses: Readonly<Record<string, string>> = {}): Promise<Agents> {
  const [sessions, shared] = await Promise.all([listSessions(capture), sharedOf(capture.relay)])
  const agents = sessions
    .filter((session) => session.firstPrompt !== '')
    .map((session) => ({ ...session, status: statuses[session.id] ?? '', archived: isArchived(shared, session), visitedAt: shared.visited[session.id] ?? '', parent: shared.parents[session.id] ?? '' }))
  return { agents, archiveAfterDays: shared.archiveAfterDays, lastMachine: shared.lastMachine }
}

class Replay {
  readonly files = new Map<string, { staged: string; size: number; segments: Segment[]; last: Written }>()
  readonly deleted = new Set<string>()
  readonly removed = new Map<string, { staged: string; size: number; segments: Segment[]; last: Written }>()
  readonly code = new Map<string, { header: RecordHeader; bytes: Uint8Array }>()
  private stagedCount = 0
  private pending = new Uint8Array()
  private current: { readonly header: RecordHeader; readonly file: string; left: number; position: number; readonly parts: Uint8Array[] } | undefined
  private readonly into: string
  private readonly identify: (header: RecordHeader) => string

  constructor(into: string, identify: (header: RecordHeader) => string) {
    this.into = into
    this.identify = identify
  }

  push(chunk: Uint8Array): void {
    const data = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    let at = 0
    while (at < data.length) {
      if (this.current === undefined) {
        const newline = data.indexOf(10, at)
        if (newline < 0) break
        this.start(JSON.parse(new TextDecoder().decode(data.subarray(at, newline))) as RecordHeader)
        at = newline + 1
        continue
      }
      const take = Math.min(this.current.left, data.length - at)
      this.write(data.subarray(at, at + take))
      at += take
    }
    this.pending = data.slice(at)
  }

  private start(header: RecordHeader): void {
    const file = this.identify(header)
    this.current = { header, file, left: header.size, position: header.at, parts: [] }
    if (header.path.endsWith('/')) {
      if (header.size === 0) this.finish()
      return
    }
    if (header.after === null) {
      const gone = this.files.get(file)
      if (gone !== undefined) this.removed.set(file, gone)
      this.files.delete(file)
      this.deleted.add(file)
      this.finish()
      return
    }
    this.deleted.delete(file)
    const replaced = this.removed.get(file)
    if (replaced !== undefined) rmSync(replaced.staged, { force: true })
    this.removed.delete(file)
    const last: Written = { ...header, after: header.after }
    const known = this.files.get(file) ?? { staged: join(this.into, String((this.stagedCount += 1))), size: 0, segments: [], last }
    if (header.at > known.size) throw new Error(`The journal writes ${header.path} at byte ${header.at}, past its ${known.size} bytes.`)
    const fd = openSync(known.staged, known.size === 0 && header.at === 0 ? 'w' : 'r+')
    ftruncateSync(fd, header.at)
    closeSync(fd)
    const segments = known.segments.flatMap((segment) => (segment.offset >= header.at ? [] : [{ ...segment, size: Math.min(segment.size, header.at - segment.offset) }]))
    this.files.set(file, { staged: known.staged, size: header.at + header.size, segments: [...segments, { device: header.device, ...(header.checkout === undefined ? {} : { checkout: header.checkout }), path: header.path, offset: header.at, size: header.size }], last })
    if (header.size === 0) this.finish()
  }

  private write(bytes: Uint8Array): void {
    const current = this.current
    if (current === undefined) return
    if (current.header.path.endsWith('/')) current.parts.push(bytes.slice())
    else {
      const fd = openSync(this.files.get(current.file)?.staged ?? '', 'r+')
      writeSync(fd, bytes, 0, bytes.length, current.position)
      closeSync(fd)
    }
    current.position += bytes.length
    current.left -= bytes.length
    if (current.left === 0) this.finish()
  }

  private finish(): void {
    const current = this.current
    if (current?.header.path.endsWith('/') === true) {
      this.code.delete(current.file)
      this.code.set(current.file, { header: current.header, bytes: Buffer.concat(current.parts) })
    }
    this.current = undefined
  }

  close(): void {
    if (this.current !== undefined || this.pending.length > 0) throw new Error(`The journal ends inside a record of ${this.current?.header.path ?? 'a header'}.`)
  }
}

export async function downloadJournal(relay: Relay, session: string, into: string, identify: (header: RecordHeader) => string): Promise<Replayed> {
  const { frames, sealedEnd } = framesOf(session, await relay.list(journalPrefix(session)))
  if (frames[0]?.start !== 0) throw new Error(`The bucket holds no journal of the session ${session} from byte 0.`)
  mkdirSync(into, { recursive: true })
  const replay = new Replay(into, identify)
  let end = 0
  for await (const { frame, bytes } of chainOf(relay, frames, 0)) {
    replay.push(bytes)
    end = frame.start + bytes.length
  }
  replay.close()
  const isDeleted = [...replay.deleted].some((path) => path.endsWith(`${session}.jsonl`) && !path.includes('/subagents/') && !replay.files.has(`${path}.zst`))
  if (!isDeleted) return { files: replay.files, deleted: replay.deleted, code: replay.code, end, sealedEnd }
  return { files: new Map([...replay.files, ...replay.removed]), deleted: new Set(), code: replay.code, end, sealedEnd }
}
