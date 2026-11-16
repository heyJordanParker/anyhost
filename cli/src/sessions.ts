import { closeSync, ftruncateSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type * as Protocol from '../../relay/protocol.ts'
import { bytesOfChunks, chainOf, chunkReader, chunksIn, decompressDelta, downloadBase, framesOf, journalPrefix, ownIndex, type Capture, type ChunkReader, type IndexedSession, type RecordHeader } from './capture.ts'
import { devicesOf } from './device.ts'
import type { Relay } from './relay.ts'
import { isArchived, isSnoozed, settledAtOf, sharedOf, type Stage, type Tag } from './shared.ts'

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

export type Agent = ListedSession & {
  readonly terminal: string
  readonly status: Protocol.AgentStatus | ''
  readonly archived: boolean
  readonly settled: boolean
  readonly settledAt: string
  readonly snoozedUntil: string
  readonly visitedAt: string
  readonly parent: string
  readonly pinned: string
  readonly tags: readonly string[]
  readonly stage: string
}
export type Agents = {
  readonly agents: readonly Agent[]
  readonly settleAfterDays: number | null
  readonly projectNames: Readonly<Record<string, string>>
  readonly lastMachine: string
  readonly tags: Readonly<Record<string, Tag>>
  readonly stages: readonly Stage[]
}

export const titleOfPrompt = (prompt: string): string => (prompt.split('\n')[0] ?? '').replace(/(?:~|\/)\S*\/([^/\s]+)/g, '$1').slice(0, 120)

export async function agentsOf(capture: Capture, statuses: Readonly<Record<string, Protocol.AgentStatus>> = {}, terminals: ReadonlyMap<string, string> = new Map(), now = Date.now()): Promise<Agents> {
  const devices = await devicesOf(capture.relay)
  const [indexes, own, holders, shared] = await Promise.all([indexesOf(capture.relay, devices.keys()), ownIndex(capture), capture.holders.current(), sharedOf(capture.relay)])
  const sessions = await listSessions(capture, { devices, indexes: new Map([...indexes, [capture.device.id, own]]), holders })
  const agents = sessions.filter((session) => session.firstPrompt !== '').map((session) => {
    const status: Agent['status'] = statuses[session.id] ?? ''
    const settledAt = settledAtOf(shared, session, status, now)
    return {
      ...session,
      title: session.title || titleOfPrompt(session.firstPrompt),
      terminal: terminals.get(session.id) ?? '',
      status,
      archived: isArchived(shared, session),
      settled: settledAt !== '',
      settledAt,
      snoozedUntil: isSnoozed(shared, session, status, now) ? (shared.snoozed[session.id]?.until ?? '') : '',
      visitedAt: shared.visited[session.id] ?? '',
      parent: shared.parents[session.id] ?? '',
      source: session.source ?? '',
      pinned: shared.pinned[session.id] ?? '',
      tags: shared.tagged[session.id] ?? [],
      stage: shared.staged[session.id] ?? '',
    }
  })
  return { agents, settleAfterDays: shared.settleAfterDays, projectNames: shared.projectNames, lastMachine: shared.lastMachine, tags: shared.tags, stages: shared.stages }
}

export class Replay {
  readonly files = new Map<string, { staged: string; size: number; segments: Segment[]; last: Written }>()
  readonly deleted = new Set<string>()
  readonly removed = new Map<string, { staged: string; size: number; segments: Segment[]; last: Written }>()
  readonly code = new Map<string, { header: RecordHeader; bytes: Uint8Array }>()
  private stagedCount = 0
  private pending = new Uint8Array()
  private current: { readonly header: RecordHeader; readonly file: string; left: number; position: number; readonly parts: Uint8Array[] } | undefined
  private readonly bases = new Map<string, Promise<Uint8Array>>()
  private readonly into: string
  private readonly identify: (header: RecordHeader) => string
  private readonly download: (base: string) => Promise<Uint8Array>
  private readonly readChunk: ChunkReader

  constructor(into: string, identify: (header: RecordHeader) => string, download: (base: string) => Promise<Uint8Array>, readChunk: ChunkReader) {
    this.into = into
    this.identify = identify
    this.download = download
    this.readChunk = readChunk
  }

  async push(chunk: Uint8Array): Promise<void> {
    const data = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    let at = 0
    while (at < data.length) {
      if (this.current === undefined) {
        const newline = data.indexOf(10, at)
        if (newline < 0) break
        await this.start(JSON.parse(new TextDecoder().decode(data.subarray(at, newline))) as RecordHeader)
        at = newline + 1
        continue
      }
      const take = Math.min(this.current.left, data.length - at)
      await this.write(data.subarray(at, at + take))
      at += take
    }
    this.pending = data.slice(at)
  }

  private isCollected(header: RecordHeader): boolean {
    return header.path.endsWith('/') || header.base !== undefined || header.chunks !== undefined
  }

  private async start(header: RecordHeader): Promise<void> {
    const file = this.identify(header)
    this.current = { header, file, left: header.size, position: header.at, parts: [] }
    if (this.isCollected(header)) {
      if (header.size === 0) await this.finish()
      return
    }
    if (header.after === null) {
      const gone = this.files.get(file)
      if (gone !== undefined) this.removed.set(file, gone)
      this.files.delete(file)
      this.deleted.add(file)
      await this.finish()
      return
    }
    this.place(file, header, header.after, header.size)
    if (header.size === 0) await this.finish()
  }

  private place(file: string, header: RecordHeader, after: Written['after'], size: number): string {
    this.deleted.delete(file)
    const replaced = this.removed.get(file)
    if (replaced !== undefined) rmSync(replaced.staged, { force: true })
    this.removed.delete(file)
    const last: Written = { ...header, after }
    const known = this.files.get(file) ?? { staged: join(this.into, String((this.stagedCount += 1))), size: 0, segments: [], last }
    if (header.at > known.size) throw new Error(`The journal writes ${header.path} at byte ${header.at}, past its ${known.size} bytes.`)
    const fd = openSync(known.staged, known.size === 0 && header.at === 0 ? 'w' : 'r+')
    ftruncateSync(fd, header.at)
    closeSync(fd)
    const segments = known.segments.flatMap((segment) => (segment.offset >= header.at ? [] : [{ ...segment, size: Math.min(segment.size, header.at - segment.offset) }]))
    this.files.set(file, { staged: known.staged, size: header.at + size, segments: [...segments, { device: header.device, ...(header.checkout === undefined ? {} : { checkout: header.checkout }), path: header.path, offset: header.at, size }], last })
    return known.staged
  }

  private async write(bytes: Uint8Array): Promise<void> {
    const current = this.current
    if (current === undefined) return
    if (this.isCollected(current.header)) current.parts.push(bytes.slice())
    else {
      const fd = openSync(this.files.get(current.file)?.staged ?? '', 'r+')
      writeSync(fd, bytes, 0, bytes.length, current.position)
      closeSync(fd)
    }
    current.position += bytes.length
    current.left -= bytes.length
    if (current.left === 0) await this.finish()
  }

  private async finish(): Promise<void> {
    const current = this.current
    this.current = undefined
    if (current === undefined) return
    const { header, file, parts } = current
    if (header.path.endsWith('/')) {
      this.code.delete(file)
      this.code.set(file, { header, bytes: Buffer.concat(parts) })
    } else if (header.base !== undefined && header.after !== null) {
      const name = header.base
      const base = this.bases.get(name) ?? this.download(name)
      this.bases.set(name, base)
      const bytes = await decompressDelta(Buffer.concat(parts), await base)
      const fd = openSync(this.place(file, header, header.after, bytes.length), 'r+')
      writeSync(fd, bytes, 0, bytes.length, header.at)
      closeSync(fd)
    } else if (header.chunks !== undefined && header.after !== null) {
      const derived = header.fork === undefined ? undefined : await bytesOfChunks(this.readChunk, header)
      const size = derived?.length ?? header.chunks.reduce((total, [, each]) => total + each, 0)
      const fd = openSync(this.place(file, header, header.after, size), 'r+')
      try {
        let at = header.at
        for await (const bytes of derived === undefined ? chunksIn(this.readChunk, header.chunks) : [derived]) {
          writeSync(fd, bytes, 0, bytes.length, at)
          at += bytes.length
        }
      } finally {
        closeSync(fd)
      }
    }
  }

  close(): void {
    if (this.current !== undefined || this.pending.length > 0) throw new Error(`The journal ends inside a record of ${this.current?.header.path ?? 'a header'}.`)
  }
}

export async function downloadJournal(relay: Relay, session: string, into: string, identify: (header: RecordHeader) => string, bases = join(into, 'bases')): Promise<Replayed> {
  const { frames, sealedEnd } = framesOf(session, await relay.list(journalPrefix(session)))
  if (frames[0]?.start !== 0) throw new Error(`The bucket holds no journal of ${session} from byte 0.`)
  mkdirSync(into, { recursive: true })
  const replay = new Replay(into, identify, (base) => downloadBase(relay, bases, base), chunkReader(relay))
  let end = 0
  for await (const { bytes, end: reached } of chainOf(relay, frames, 0)) {
    await replay.push(bytes)
    end = reached
  }
  replay.close()
  const isDeleted = [...replay.deleted].some((path) => path.endsWith(`${session}.jsonl`) && !path.includes('/subagents/') && !replay.files.has(`${path}.zst`))
  if (!isDeleted) return { files: replay.files, deleted: replay.deleted, code: replay.code, end, sealedEnd }
  return { files: new Map([...replay.files, ...replay.removed]), deleted: new Set(), code: replay.code, end, sealedEnd }
}
