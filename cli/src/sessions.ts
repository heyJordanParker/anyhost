import { closeSync, ftruncateSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type * as Protocol from '../../relay/protocol.ts'
import { chainOf, framesOf, journalPrefix, type IndexedSession, type RecordHeader } from './capture.ts'
import { claimsOf } from './claims.ts'
import { devicesOf } from './device.ts'
import type { Relay } from './relay.ts'

export type ListedSession = IndexedSession & { readonly machine: string; readonly device: string; readonly holder: string }
// A run of one record's bytes in a replayed file: `size` bytes from `offset`, as `device` wrote them at `path`.
export type Segment = { readonly device: string; readonly path: string; readonly offset: number; readonly size: number }
// A file of the journal, replayed into `staged`: its bytes as each writer wrote them, and its last record, which is
// never a deletion.
type Written = RecordHeader & { readonly after: NonNullable<RecordHeader['after']> }
export type ReplayedFile = { readonly staged: string; readonly size: number; readonly segments: readonly Segment[]; readonly last: Written }
export type Replayed = {
  readonly files: ReadonlyMap<string, ReplayedFile>
  // the files whose last record is a deletion
  readonly deleted: ReadonlySet<string>
  // the last code record of each working folder, a record whose path ends in `/`, the latest folder last
  readonly code: ReadonlyMap<string, { readonly header: RecordHeader; readonly bytes: Uint8Array }>
  readonly end: number
  readonly sealedEnd: number
}

const decoded = (body: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(body))

// The index each machine wrote, by its device id, read in as few requests as the indexes fit.
export async function indexesOf(relay: Relay, devices: Iterable<string>): Promise<Map<string, IndexedSession[]>> {
  const ids = [...devices]
  const read = await Promise.all(relay.run(ids.map((device) => ({ op: 'get', key: `sessions/${device}/index.json` }))))
  return new Map(ids.flatMap((device, at) => {
    const index = read[at]
    return index !== undefined && 'bytes' in index ? [[device, decoded(index.bytes) as IndexedSession[]] as const] : []
  }))
}

// Every session with a conversation the machines' indexes name, each from the index of the machine that holds it, else
// the latest. A session that never got a message has no transcript, whose first line names its working folder, and
// nothing to resume, as Claude Code's own /resume lists it nowhere. `read` is the machines, their indexes and the
// claims a caller read already, as a restore reads only its own session's claim.
export async function listSessions(
  relay: Relay,
  read?: {
    readonly devices: ReadonlyMap<string, Protocol.Device>
    readonly indexes: ReadonlyMap<string, readonly IndexedSession[]>
    readonly claims: ReadonlyMap<string, Protocol.DeviceRef>
  },
): Promise<ListedSession[]> {
  const known = read?.devices ?? (await devicesOf(relay))
  const [indexes, claims] = await Promise.all([read?.indexes ?? indexesOf(relay, known.keys()), read?.claims ?? claimsOf(relay)])
  const latest = new Map<string, ListedSession>()
  for (const [device, index] of indexes) {
    for (const session of index) {
      if (session.cwd === '') continue
      const earlier = latest.get(session.id)
      const holder = claims.get(session.id)
      if (earlier !== undefined && (earlier.device === holder?.id || (device !== holder?.id && earlier.lastActivity >= session.lastActivity))) continue
      latest.set(session.id, { ...session, device, machine: known.get(device)?.name ?? device, holder: holder?.name ?? '' })
    }
  }
  return [...latest.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
}

// Applies journal bytes as they arrive, across frame boundaries: each record makes its file its first `at` bytes
// followed by the record's bytes. `identify` names the file a record writes, so records two machines wrote at their
// own paths land in one file.
class Replay {
  readonly files = new Map<string, { staged: string; size: number; segments: Segment[]; last: Written }>()
  readonly deleted = new Set<string>()
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
      if (gone !== undefined) rmSync(gone.staged, { force: true })
      this.files.delete(file)
      this.deleted.add(file)
      this.finish()
      return
    }
    this.deleted.delete(file)
    const last: Written = { ...header, after: header.after }
    const known = this.files.get(file) ?? { staged: join(this.into, String((this.stagedCount += 1))), size: 0, segments: [], last }
    if (header.at > known.size) throw new Error(`The journal writes ${header.path} at byte ${header.at}, past its ${known.size} bytes.`)
    const fd = openSync(known.staged, known.size === 0 && header.at === 0 ? 'w' : 'r+')
    ftruncateSync(fd, header.at)
    closeSync(fd)
    const segments = known.segments.flatMap((segment) => (segment.offset >= header.at ? [] : [{ ...segment, size: Math.min(segment.size, header.at - segment.offset) }]))
    this.files.set(file, { staged: known.staged, size: header.at + header.size, segments: [...segments, { device: header.device, path: header.path, offset: header.at, size: header.size }], last })
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
      // the folder written last ends the map, so the session's latest working folder comes last
      this.code.delete(current.file)
      this.code.set(current.file, { header: current.header, bytes: Buffer.concat(current.parts) })
    }
    this.current = undefined
  }

  close(): void {
    if (this.current !== undefined || this.pending.length > 0) throw new Error(`The journal ends inside a record of ${this.current?.header.path ?? 'a header'}.`)
  }
}

// Downloads a session's journal, the chain of frames from byte 0, and replays it into `into`.
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
  return { files: replay.files, deleted: replay.deleted, code: replay.code, end, sealedEnd }
}
