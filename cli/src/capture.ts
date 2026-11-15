import { Database } from 'bun:sqlite'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, type Stats } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { isOlder, MAX_KEYS, MAX_MESSAGE_BYTES, MAX_OPS, type DeviceRef, type Listed, type Released } from '../../relay/protocol.ts'
import { claimsOf, followHolders, type Holders } from './claims.ts'
import { captureCode, restoreCode, type CodeCapture } from './code.ts'
import { devicesOf, stateFolder, type DataFolder, type Device, type MachineRoots } from './device.ts'
import type { Call, RanOf, Relay } from './relay.ts'
import { Replay } from './sessions.ts'
import { codexNameOf, codexState, cutsOf, filesOf, filesUnder, firstUuidIn, forkedTranscript, forkIn, forkStartsIn, historyOf, linesFiles, namedIn, namesFork, ownerOf, parentOf, piecesFrom, summarize, TITLE_RULES, transcriptOf, transcriptsOn, uuidsIn, type Fork, type Summary, type Tool } from './transcript.ts'

export const FRAME_BYTES = 64 * 2 ** 20
const SCAN_READ_BYTES = 2 ** 20
const HEAVY_UPLOAD_BYTES = 2 ** 20
const FORK_BYTES = 512 * 2 ** 20
export const CODE_PIECE_BYTES = 128 * 2 ** 10
export const CODE_PIECES = 4
const CODE_EVERY_MS = 60_000
export const QUIET_MS = 10 * 60_000
const SEAL_WAIT_PASSES = 60
const SWEEP_BATCH = 1000
const REQUESTS_AHEAD = 16
const TAIL_BYTES = 32
const COMPACT_LAG_MS = 7 * 24 * 60 * 60_000
const OLDEST_SCHEMA = 4
type Migration = readonly [table: string, column: string, type: string] | { readonly droppedTable: string }
const MIGRATIONS: readonly (readonly Migration[])[] = [
  [
    ['journals', 'compacted_end', 'integer not null default 0'],
    ['journals', 'compacted_kept', 'integer not null default 0'],
    ['journals', 'compact_after', 'integer not null default 0'],
    ['journals', 'replaced', 'integer not null default 0'],
  ],
  [['sessions', 'last_said', "text not null default ''"]],
  [['sessions', 'titled', 'integer not null default 0']],
  [['sessions', 'last_prompt_at', "text not null default ''"]],
  [['sessions', 'source', "text not null default ''"]],
  [{ droppedTable: 'hook_states' }, { droppedTable: 'borrowed' }],
]
const SCHEMA = OLDEST_SCHEMA + MIGRATIONS.length

export type IndexedSession = {
  readonly id: string
  readonly tool: Tool
  readonly title: string
  readonly firstPrompt: string
  readonly cwd: string
  readonly repo: string
  readonly repoFolder: string
  readonly entrypoint: string
  readonly lastSaid: string
  readonly lastActivity: string
  readonly lastPromptAt: string
  readonly source: string
  readonly size: number
  readonly deleted: boolean
}
export type Code = { readonly captureCode: typeof captureCode; readonly restoreCode: typeof restoreCode }
export type Capture = Code & {
  readonly relay: Relay
  readonly db: Database
  readonly device: Device
  readonly roots: MachineRoots
  readonly hashers: Map<string, Bun.CryptoHasher>
  readonly codeRuns: Map<string, Promise<Error | undefined>>
  readonly codeWaiting: Map<string, { readonly folder: string; readonly code: CodeCapture }>
  readonly codeStale: Set<string>
  readonly codeReadAt: Map<string, number>
  readonly codeLater: Map<string, ReturnType<typeof setTimeout>>
  readonly codeEveryMs: number
  readonly readsCode: boolean
  readonly compactLagMs: number
  readonly codeSkipped: Set<string>
  readonly sealWaits: Map<string, { readonly failures: number; passes: number }>
  readonly missingFolders: Set<string>
  readonly onCode: (session: string, tool: Tool, folder: string) => void
  readonly onReleased: (session: string, holder: string) => void
  readonly holders: Holders
  fleet: Fleet
  journalsInR2: { readonly readAt: number; readonly isRewritten: Map<string, boolean> }
  dataFolders: readonly DataFolder[]
  lastIndex: string
  keptIndex?: Promise<readonly IndexedSession[]> | undefined
}
export type Fleet = { readonly readsChunks: boolean; readonly readAt: number; readonly older: readonly string[]; readonly removed: ReadonlySet<string> }
export type Problems = { set(key: string, error: unknown): void; clear(key: string): void }
export type RecordHeader = {
  readonly device: string
  readonly checkout?: string
  readonly path: string
  readonly at: number
  readonly size: number
  readonly after: { readonly size: number; readonly sha256: string } | null
  readonly base?: string
  readonly chunks?: ChunkList
  readonly fork?: Fork
}
export type ChunkList = readonly (readonly [sha256: string, size: number])[]
export type Frame = { readonly key: string; readonly start: number; readonly end?: number; readonly size: number; readonly uploaded?: number; readonly written?: number }
export type FileState = { readonly session: string; readonly path: string; readonly journalSize: number; readonly localSize: number; readonly tail: Uint8Array; readonly sha256: string; readonly mtime: number }
export type Journal = { readonly session: string; readonly tool: Tool; readonly end: number; readonly sealed: number; readonly writtenAt: number; readonly stopped: string; readonly holder: string }

type FileRow = { session: string; path: string; journal_size: number; local_size: number; tail: Uint8Array; sha256: string; mtime: number }
type JournalRow = { session: string; tool: Tool; end: number; sealed: number; written_at: number; stopped: string; holder: string }
type SessionRow = { id: string; tool: Tool; title: string; title_rank: number; first_prompt: string; cwd: string; repo: string; repo_folder: string; entrypoint: string; last_said: string; last_activity: string; last_prompt_at: string; source: string; size: number }
type Source = { readonly size: number; readonly mtime: number; read(from: number, to: number): Promise<Uint8Array> }
type Change = { readonly header: RecordHeader; readonly bytes: Uint8Array; readonly region?: { readonly from: number; readonly to: number }; readonly state: FileState; readonly hasher: Bun.CryptoHasher; readonly isPartial: boolean }

const blocksOf = (change: Change): AsyncIterable<Uint8Array> | Iterable<Uint8Array> => (change.region === undefined ? [change.bytes] : wholeLinesIn(change.header.path, change.region.from, change.region.to))

export function openDatabase(folder = stateFolder()): Database {
  mkdirSync(folder, { recursive: true })
  const db = new Database(join(folder, 'anyhost.db'))
  db.run('pragma busy_timeout = 5000')
  db.run('pragma journal_mode = wal')
  db.run("create table if not exists bucket (name text not null, url text not null default '')")
  const version = versionOf(db)
  if (version > SCHEMA) {
    db.close()
    throw new Error(`${join(folder, 'anyhost.db')} is a database of a newer anyhost, at version ${version}, and this anyhost reads version ${SCHEMA}, so it changes nothing there. Update anyhost on this machine.`)
  }
  if (version < OLDEST_SCHEMA) startOver(db)
  makeTables(db)
  return db
}

const versionOf = (db: Database): number => db.query<{ user_version: number }, []>('pragma user_version').get()?.user_version ?? 0

function startOver(db: Database): void {
  for (const table of ['files', 'sessions', 'journals', 'line_offsets', 'holders', 'holders_changed', 'chunks', 'rewrites', 'borrowed_claims']) db.run(`drop table if exists ${table}`)
  for (const folder of ['code', 'spool', 'bases']) rmSync(join(dirname(db.filename), folder), { recursive: true, force: true })
  db.run(`pragma user_version = ${OLDEST_SCHEMA}`)
}

function makeTables(db: Database): void {
  db.run(`create table if not exists journals (
    session text primary key, tool text not null, end integer not null default 0, sealed integer not null default 0,
    written_at integer not null default 0, stopped text not null default '', holder text not null default '', untold text not null default '')`)
  db.run(`create table if not exists files (
    session text not null, path text not null, journal_size integer not null default 0, local_size integer not null default 0,
    tail blob not null default x'', sha256 text not null default '', mtime integer not null default 0, primary key (session, path))`)
  db.run('create index if not exists files_by_path on files (path)')
  db.run('create table if not exists line_offsets (path text primary key, offset integer not null)')
  db.run(`create table if not exists sessions (
    id text primary key, tool text not null, title text not null default '', title_rank integer not null default 0, first_prompt text not null default '',
    cwd text not null default '', repo text not null default '', repo_folder text not null default '', entrypoint text not null default '',
    last_activity text not null default '', size integer not null default 0)`)
  db.run('create table if not exists holders (session text primary key, device text not null)')
  db.run('create table if not exists holders_changed (changed integer not null)')
  db.run('create table if not exists fork_starts (uuid text not null, path text not null, primary key (uuid, path))')
  db.run('create table if not exists chunks (name text primary key)')
  db.run("create table if not exists rewrites (session text primary key, done integer not null default 0, at integer not null default 0, ops integer not null default 0, failure text not null default '')")
  db.run('create table if not exists borrowed_claims (session text primary key)')
  db.run('insert into holders_changed (changed) select 0 where not exists (select 1 from holders_changed)')
  db.transaction(() => {
    for (const migration of MIGRATIONS.flat()) {
      if ('droppedTable' in migration) {
        db.run(`drop table if exists ${migration.droppedTable}`)
        continue
      }
      const [table, column, type] = migration
      if (db.query('select 1 from pragma_table_info(?) where name = ?').get(table, column) === null) db.run(`alter table ${table} add column ${column} ${type}`)
    }
    db.run(`pragma user_version = ${SCHEMA}`)
  }).immediate()
}

export type CountedRelay = { readonly url: string; readonly bucket: string }

export const countedRelay = (db: Database): CountedRelay | undefined => db.query<CountedRelay, []>('select url, name as bucket from bucket').get() ?? undefined

const isSameRelay = (counted: CountedRelay | undefined, url: string, bucket: string): boolean =>
  counted === undefined || (counted.bucket === bucket && (counted.url === '' || counted.url === url))

function useRelay(db: Database, url: string, bucket: string): boolean {
  const isOther = !isSameRelay(countedRelay(db), url, bucket)
  if (isOther) {
    startOver(db)
    makeTables(db)
  }
  db.transaction(() => {
    db.run('delete from bucket')
    db.query('insert into bucket (name, url) values (?, ?)').run(bucket, url)
  })()
  return isOther
}

export function openCapture(
  relay: Relay,
  device: Device,
  roots: MachineRoots,
  {
    db = openDatabase(),
    code = { captureCode, restoreCode },
    onCode = () => undefined,
    onReleased = () => undefined,
    onOtherRelay = () => undefined,
    codeEveryMs = CODE_EVERY_MS,
    readsCode = true,
    compactLagMs = COMPACT_LAG_MS,
  }: {
    readonly db?: Database
    readonly code?: Code
    readonly onCode?: Capture['onCode']
    readonly onReleased?: Capture['onReleased']
    readonly onOtherRelay?: (url: string, bucket: string) => void
    readonly codeEveryMs?: number
    readonly readsCode?: boolean
    readonly compactLagMs?: number
  } = {},
): Capture {
  relay.on('welcome', ({ bucket, waiting }) => {
    const isOther = useRelay(db, relay.url, bucket)
    for (const message of waiting) released(message)
    if (isOther) onOtherRelay(relay.url, bucket)
  })
  const capture: Capture = {
    ...code, relay, db, device, roots, hashers: new Map(), codeRuns: new Map(), codeWaiting: new Map(), codeStale: new Set(), codeReadAt: new Map(), codeLater: new Map(), codeEveryMs, readsCode, compactLagMs, codeSkipped: new Set(), sealWaits: new Map(), missingFolders: new Set(), onCode, onReleased,
    holders: followHolders(relay, db), fleet: UNREAD_FLEET, journalsInR2: { readAt: 0, isRewritten: new Map() }, dataFolders: [], lastIndex: '',
  }
  const released = ({ session, to, at }: Released): void => releasedTo(capture, session, to, `${at} ${to.name} took the session ${session} over, so ${device.name} stops capturing it.`)
  relay.on('released', released)
  relay.on('claiming', ({ session, call }) => {
    if (call.op === 'claim' || (call.op === 'put' && call.key.startsWith(`${journalPrefix(session)}hot/`))) db.query('delete from borrowed_claims where session = ?').run(session)
  })
  return capture
}

function releasedTo(capture: Capture, session: string, holder: DeviceRef, reason: string, tool?: Tool): void {
  holdElsewhere(capture.db, session, holder.name, reason, tool)
  capture.relay.send({ t: 'heard', session, to: holder.id })
  capture.onReleased(session, holder.name)
}

const FIRST_CHUNKED_PROGRAM = '0.9.0'
const FLEET_EVERY_MS = 10 * 60_000
export const UNREAD_FLEET: Fleet = { readsChunks: false, readAt: 0, older: [], removed: new Set() }

async function everyMachineReadsChunks(capture: Capture, now = Date.now()): Promise<boolean> {
  if (now - capture.fleet.readAt < FLEET_EVERY_MS) return capture.fleet.readsChunks
  const devices = await devicesOf(capture.relay).catch(() => undefined)
  if (devices === undefined) return false
  const joined = [...devices.values()].filter(({ removedAt }) => removedAt === undefined)
  const older = joined.filter(({ program }) => program === undefined || program === '' || isOlder(program, FIRST_CHUNKED_PROGRAM)).map(({ name }) => name)
  const removed = new Set([...devices.values()].flatMap(({ id, removedAt }) => (removedAt === undefined ? [] : [id])))
  capture.fleet = { readsChunks: older.length === 0, readAt: now, older, removed }
  return capture.fleet.readsChunks
}

export const isCodePart = (path: string): boolean => path.startsWith('anyhost:code/')

const isTranscript = (path: string, roots: MachineRoots): boolean => {
  const owner = ownerOf(path, roots)
  return owner !== undefined && 'isTranscript' in owner && owner.isTranscript
}

const position = (at: number): string => String(at).padStart(16, '0')
export const journalPrefix = (session: string): string => `journals/${session}/`
export const hotKey = (session: string, start: number): string => `${journalPrefix(session)}hot/${position(start)}.zst`
const sealedKey = (session: string, start: number, end: number): string => `${journalPrefix(session)}sealed/${position(start)}-${position(end)}.zst`
const rewrittenName = (start: number, end: number, written: number): string => `${position(start)}-${position(end)}-${position(written)}.zst`
const isCompacted = (frame: Frame): boolean => frame.key.includes('/compacted/')
const rewrittenKey = (session: string): string => `${journalPrefix(session)}rewritten`

const C = zlib.constants
const zstdCompress = promisify(zlib.zstdCompress)
const zstdDecompress = (bytes: Uint8Array, options: zlib.ZstdOptions): Promise<Buffer> => promisify(zlib.zstdDecompress)(bytes, options)
export const compressHot = (body: Uint8Array): Promise<Uint8Array> => zstdCompress(body, { params: { [C.ZSTD_c_compressionLevel]: 3, [C.ZSTD_c_checksumFlag]: 1 } })
const compressSealed = (body: Uint8Array): Promise<Uint8Array> =>
  zstdCompress(body, { params: { [C.ZSTD_c_compressionLevel]: 9, [C.ZSTD_c_windowLog]: 27, [C.ZSTD_c_enableLongDistanceMatching]: 1, [C.ZSTD_c_checksumFlag]: 1 } })
export const decompress = (frame: Uint8Array): Promise<Uint8Array> => zstdDecompress(frame, { params: { [C.ZSTD_d_windowLogMax]: 27 } })
const DELTA_WINDOW_LOG = 24
type DeltaChunk = { readonly size: number; readonly from?: number; readonly to?: number }

async function* deltaChunksOf(delta: Uint8Array, base: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < delta.length; ) {
    const newline = delta.indexOf(10, at)
    if (newline < 0) throw new Error(`The delta ends inside a chunk's header at byte ${at}.`)
    const { size, from, to } = JSON.parse(new TextDecoder().decode(delta.subarray(at, newline))) as DeltaChunk
    const compressed = delta.subarray(newline + 1, newline + 1 + size)
    yield await zstdDecompress(compressed, { params: { [C.ZSTD_d_windowLogMax]: DELTA_WINDOW_LOG }, ...(from === undefined ? {} : { dictionary: base.subarray(from, to) }) })
    at = newline + 1 + size
  }
}

export const decompressDelta = async (delta: Uint8Array, base: Uint8Array): Promise<Uint8Array> => Buffer.concat(await Array.fromAsync(deltaChunksOf(delta, base)))

const baseKey = (name: string): string => `bases/${name}`
export const basesOf = (db: Database): string => join(dirname(db.filename), 'bases')

export async function downloadBase(relay: Relay, folder: string, name: string): Promise<Uint8Array> {
  const kept = join(folder, name)
  const isKept = existsSync(kept)
  const got = isKept ? undefined : await relay.runOne({ op: 'get', key: baseKey(name) })
  if (got !== undefined && got.status !== 200) throw new Error(`A record of the journal names the base ${name}, and the bucket holds no ${baseKey(name)}.`)
  const bytes = got === undefined ? new Uint8Array(readFileSync(kept)) : got.bytes
  const base = await decompress(bytes)
  const found = sha256(base)
  if (found !== name) {
    rmSync(kept, { force: true })
    throw new Error(`${isKept ? kept : baseKey(name)} decompresses to bytes of sha256 ${found}, not the ${name} its name says.`)
  }
  if (!isKept) await Bun.write(kept, bytes)
  return base
}

const CHUNKS_AHEAD = 4
export const chunkKey = (name: string): string => `chunks/${name}`
type ChunkHead = { readonly base?: string }
export type ChunkReader = (name: string) => Promise<Uint8Array>

export function chunkReader(relay: Relay): ChunkReader {
  const bases = new Map<string, Promise<Uint8Array>>()
  const asBase = (name: string): Promise<Uint8Array> => {
    const known = bases.get(name) ?? read(name)
    bases.set(name, known)
    return known
  }
  const read = async (name: string): Promise<Uint8Array> => {
    const got = await relay.runOne({ op: 'get', key: chunkKey(name) })
    if (got.status !== 200) throw new Error(`A record names the chunk ${name}, and the bucket holds no ${chunkKey(name)}.`)
    const newline = got.bytes.indexOf(10)
    if (newline < 0) throw new Error(`${chunkKey(name)} has no header line.`)
    const { base } = JSON.parse(new TextDecoder().decode(got.bytes.subarray(0, newline))) as ChunkHead
    const body = got.bytes.subarray(newline + 1)
    const bytes = base === undefined ? await decompress(body) : await zstdDecompress(body, { params: { [C.ZSTD_d_windowLogMax]: DELTA_WINDOW_LOG }, dictionary: await asBase(base) })
    const found = sha256(bytes)
    if (found !== name) throw new Error(`${chunkKey(name)} decompresses to bytes of sha256 ${found}, not the ${name} its name says.`)
    return bytes
  }
  return read
}

export async function* chunksIn(read: ChunkReader, chunks: ChunkList): AsyncGenerator<Uint8Array> {
  const ahead: Promise<Uint8Array>[] = []
  let next = 0
  const fill = (): void => {
    for (; next < chunks.length && ahead.length < CHUNKS_AHEAD; next += 1) {
      const [name, size] = chunks[next] ?? ['', 0]
      const bytes = read(name).then((found) => {
        if (found.length !== size) throw new Error(`The chunk ${name} holds ${found.length} bytes, and its record says ${size}.`)
        return found
      })
      void bytes.catch(() => undefined)
      ahead.push(bytes)
    }
  }
  fill()
  for (let first = ahead.shift(); first !== undefined; first = ahead.shift()) {
    fill()
    yield await first
  }
}

export async function bytesOfChunks(read: ChunkReader, header: Pick<RecordHeader, 'chunks' | 'fork'>): Promise<Uint8Array> {
  const bytes = Buffer.concat(await Array.fromAsync(chunksIn(read, header.chunks ?? [])))
  return header.fork === undefined ? bytes : (await forkedTranscript(bytes, header.fork)).bytes
}

export const CHUNKED_FROM = 2 ** 20
const CHUNK_PUTS_AT_ONCE = 4
const WHOLE_CHUNK = new TextEncoder().encode('{}\n')
type Piece = { readonly bytes: Uint8Array; readonly against?: Uint8Array }

const compressChunk = (bytes: Uint8Array): Promise<Uint8Array> =>
  zstdCompress(bytes, { params: { [C.ZSTD_c_compressionLevel]: 9, [C.ZSTD_c_windowLog]: DELTA_WINDOW_LOG, [C.ZSTD_c_enableLongDistanceMatching]: 1, [C.ZSTD_c_checksumFlag]: 1 } })
const compressAgainst = (bytes: Uint8Array, base: Uint8Array): Promise<Uint8Array> =>
  zstdCompress(bytes, { params: { [C.ZSTD_c_compressionLevel]: 9, [C.ZSTD_c_windowLog]: DELTA_WINDOW_LOG, [C.ZSTD_c_hashLog]: 22, [C.ZSTD_c_checksumFlag]: 1 }, dictionary: base } as zlib.ZstdOptions)

export function piecesOf(bytes: Uint8Array): Uint8Array[] {
  let at = 0
  return cutsOf(bytes).map((end) => {
    const piece = bytes.subarray(at, end)
    at = end
    return piece
  })
}

const knowsChunk = (db: Database, name: string): boolean => db.query('select 1 from chunks where name = ?').get(name) !== null

async function storedChunk(piece: Piece, name: string): Promise<Uint8Array> {
  const whole = async (): Promise<Uint8Array> => Buffer.concat([WHOLE_CHUNK, await compressChunk(piece.bytes)])
  if (piece.against === undefined) return await whole()
  const base = sha256(piece.against)
  try {
    const delta = await compressAgainst(piece.bytes, piece.against)
    const back = await zstdDecompress(delta, { params: { [C.ZSTD_d_windowLogMax]: DELTA_WINDOW_LOG }, dictionary: piece.against })
    if (sameBytes(back, piece.bytes)) {
      const stored = Buffer.concat([new TextEncoder().encode(`${JSON.stringify({ base } satisfies ChunkHead)}\n`), delta])
      if (4 * delta.length < piece.bytes.length) return stored
      const plain = await whole()
      return stored.length < plain.length ? stored : plain
    }
    console.error(`${new Date().toISOString()} The chunk ${name} does not come back from its delta against ${base}, so anyhost uploads it whole.`)
  } catch (error) {
    console.error(`${new Date().toISOString()} The chunk ${name} does not come back from its delta against ${base}, so anyhost uploads it whole: ${error instanceof Error ? error.message : String(error)}`)
  }
  return await whole()
}

async function keepChunk(relay: Relay, name: string, etag: string | undefined, body: Uint8Array): Promise<void> {
  const found = await chunkReader(relay)(name).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  if (found === undefined) return
  if (etag === undefined) throw new Error(`${chunkKey(name)} holds other bytes (${found}), and the relay named no etag to write over it with.`)
  console.error(`${new Date().toISOString()} ${chunkKey(name)} holds other bytes (${found}), so anyhost writes the chunk over it.`)
  const put = await relay.runOne({ op: 'put', key: chunkKey(name), bytes: body, if: { match: etag } })
  if (put.status !== 200) throw new Error(`The relay answered ${put.status} to the put over ${chunkKey(name)}, so anyhost uploads no record that names it.`)
}

async function putChunk(capture: Pick<Capture, 'relay' | 'db'>, name: string, body: Uint8Array): Promise<void> {
  const answer = await capture.relay.runOne({ op: 'put', key: chunkKey(name), bytes: body, if: { none: '*' } })
  if (answer.status !== 200 && answer.status !== 412) throw new Error(`The relay answered ${answer.status} to the put of ${chunkKey(name)}, so anyhost uploads no record that names it.`)
  if (answer.status === 412) await keepChunk(capture.relay, name, answer.etag, body)
  capture.db.query('insert or ignore into chunks (name) values (?)').run(name)
}

export async function storeChunks(capture: Pick<Capture, 'relay' | 'db'>, pieces: AsyncIterable<Piece> | Iterable<Piece>): Promise<ChunkList> {
  const chunks: (readonly [string, number])[] = []
  const sent = new Set<string>()
  const putting: Promise<void>[] = []
  for await (const piece of pieces) {
    const name = sha256(piece.bytes)
    chunks.push([name, piece.bytes.length])
    if (sent.has(name) || knowsChunk(capture.db, name)) continue
    sent.add(name)
    const put = putChunk(capture, name, await storedChunk(piece, name))
    put.catch(() => undefined)
    putting.push(put)
    if (putting.length >= CHUNK_PUTS_AT_ONCE) await putting.shift()
  }
  await Promise.all(putting)
  return chunks
}

export async function chunkListOf(capture: Pick<Capture, 'relay' | 'db'>, bytes: Uint8Array, parent?: Uint8Array): Promise<ChunkList> {
  const pieces = piecesOf(bytes)
  if (parent === undefined) return await storeChunks(capture, pieces.map((piece) => ({ bytes: piece })))
  const parents = piecesOf(parent)
  const holders = new Map<string, number>()
  for (const [index, piece] of parents.entries()) for (const { uuid } of uuidsIn(piece)) if (!holders.has(uuid)) holders.set(uuid, index)
  const against = pieces.map((piece) => {
    const counts = new Map<number, number>()
    for (const { uuid } of uuidsIn(piece)) {
      const index = holders.get(uuid)
      if (index !== undefined) counts.set(index, (counts.get(index) ?? 0) + 1)
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0]
  })
  const used = [...new Set(against.filter((index) => index !== undefined))]
  await storeChunks(capture, used.map((index) => ({ bytes: parents[index] ?? new Uint8Array() })))
  return await storeChunks(
    capture,
    pieces.map((piece, at) => {
      const index = against[at]
      const base = index === undefined ? undefined : parents[index]
      return base === undefined ? { bytes: piece } : { bytes: piece, against: base }
    }),
  )
}

export const encodeRecord = (header: RecordHeader, bytes: Uint8Array): Uint8Array[] => [new TextEncoder().encode(`${JSON.stringify(header)}\n`), bytes]

export function framesOf(session: string, listed: readonly Listed[]): { readonly frames: Frame[]; readonly sealedEnd: number; readonly stale: string[] } {
  const sealed: (Frame & { readonly end: number })[] = []
  const hot: Frame[] = []
  for (const { key, size, uploaded } of listed) {
    const rest = key.slice(journalPrefix(session).length)
    const range = /^(?:sealed\/(\d+)-(\d+)|compacted\/(\d+)-(\d+)(?:-(\d+))?)\.zst$/.exec(rest)
    const start = Number(range?.[1] ?? range?.[3])
    const end = Number(range?.[2] ?? range?.[4])
    if (range !== null) sealed.push({ key, start, end, size, written: Number(range[5] ?? 0), ...(uploaded === undefined ? {} : { uploaded }) })
    const hotStart = /^hot\/(\d+)\.zst$/.exec(rest)?.[1]
    if (hotStart !== undefined) hot.push({ key, start: Number(hotStart), size })
  }
  const frames: Frame[] = []
  let sealedEnd = 0
  for (;;) {
    const next = sealed.filter((frame) => frame.start === sealedEnd).sort((a, b) => b.end - a.end || Number(isCompacted(b)) - Number(isCompacted(a)) || (b.written ?? 0) - (a.written ?? 0))[0]
    if (next === undefined) break
    frames.push(next)
    sealedEnd = next.end
  }
  const covered = sealed.filter((frame) => !frames.includes(frame) && frame.end <= sealedEnd)
  frames.push(...hot.filter((frame) => frame.start >= sealedEnd).sort((a, b) => a.start - b.start))
  return { frames, sealedEnd, stale: [...hot.filter((frame) => frame.start < sealedEnd), ...covered].map(({ key }) => key) }
}

export const spoolOf = (db: Database, session: string): string => join(dirname(db.filename), 'spool', session)

export async function* chainOf(relay: Relay, frames: readonly Frame[], from: number, spool?: string): AsyncGenerator<{ readonly frame: Frame; readonly bytes: Uint8Array; readonly end: number }> {
  const spooled = new Map(spool === undefined ? [] : frames.flatMap((frame) => (frame.end === undefined && existsSync(join(spool, String(frame.start))) ? [[frame.key, join(spool, String(frame.start))] as const] : [])))
  const requests: Frame[][] = []
  const requestOf: number[] = []
  let bytes = 0
  for (const frame of frames) {
    if (spooled.has(frame.key)) {
      requestOf.push(-1)
      continue
    }
    const last = requests.at(-1)
    const fits = last !== undefined && frame.size <= MAX_MESSAGE_BYTES && last.length < MAX_OPS && bytes + frame.size <= MAX_MESSAGE_BYTES
    if (fits) last.push(frame)
    else requests.push([frame])
    bytes = fits ? bytes + frame.size : frame.size
    requestOf.push(requests.length - 1)
  }
  const bodies: Promise<Map<string, Uint8Array>>[] = []
  const fetchRequest = (index: number): Promise<Map<string, Uint8Array>> =>
    (bodies[index] ??= (async () => {
      const asked = requests[index] ?? []
      const [only] = asked
      const found = only !== undefined && only.size > MAX_MESSAGE_BYTES ? [await relay.getObject(only.key)] : await Promise.all(relay.run(asked.map(({ key }) => ({ op: 'get', key }))))
      return new Map(
        asked.map(({ key }, at) => {
          const got = found[at]
          if (got === undefined || !('bytes' in got)) throw new Error(`${key} disappeared while anyhost read it.`)
          return [key, got.bytes]
        }),
      )
    })())
  const fetchedBytes = async (fetched: Map<string, Uint8Array>, key: string): Promise<Uint8Array> => {
    const frameBytes = fetched.get(key)
    if (frameBytes === undefined) throw new Error(`The journal's chain holds ${key} twice.`)
    fetched.delete(key)
    return await decompress(frameBytes)
  }
  let end = from
  for (const [index, frame] of frames.entries()) {
    if (frame.start > end) break
    if (frame.start < end) continue
    const local = spooled.get(frame.key)
    const request = requestOf[index] ?? -1
    const nextRequest = request >= 0 ? request : (requestOf.slice(index).find((each) => each >= 0) ?? requests.length)
    for (let ahead = nextRequest; ahead < Math.min(requests.length, nextRequest + REQUESTS_AHEAD); ahead += 1) void fetchRequest(ahead).catch(() => undefined)
    const bytes = local === undefined ? await fetchedBytes(await fetchRequest(request), frame.key) : new Uint8Array(readFileSync(local))
    const compactedEnd = isCompacted(frame) ? frame.end : undefined
    if (compactedEnd === undefined && frame.end !== undefined && frame.start + bytes.length !== frame.end) throw new Error(`${frame.key} holds ${bytes.length} bytes, not the ${frame.end - frame.start} its name says.`)
    end = compactedEnd ?? frame.start + bytes.length
    yield { frame, bytes, end }
  }
}

const journalRow = (db: Database, session: string): JournalRow | null => db.query<JournalRow, [string]>('select * from journals where session = ?').get(session)
const fileRow = (db: Database, session: string, path: string): FileRow | null => db.query<FileRow, [string, string]>('select * from files where session = ? and path = ?').get(session, path)

export async function isHeavyUpload(capture: Capture, { session, tool, paths }: Changed): Promise<boolean> {
  const isFirst = journalOf(capture.db, session) === undefined
  if (isFirst && tool === 'mod') return true
  let gained = 0
  for (const path of isFirst ? new Set([...paths, ...(await filesOf(session, tool, capture.roots))]) : paths) {
    if (path.endsWith('/')) continue
    const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0
    gained += Math.max(0, size - (fileRow(capture.db, session, path)?.local_size ?? 0))
    if (gained > HEAVY_UPLOAD_BYTES) return true
  }
  return false
}

function rememberFiles(db: Database, session: string, paths: Iterable<string>): void {
  for (const path of paths) db.query('insert or ignore into files (session, path) values (?, ?)').run(session, path)
}

function saveFile(db: Database, file: FileState): void {
  db.query(
    `insert into files (session, path, journal_size, local_size, tail, sha256, mtime) values (?, ?, ?, ?, ?, ?, ?)
     on conflict (session, path) do update set journal_size = excluded.journal_size, local_size = excluded.local_size,
     tail = excluded.tail, sha256 = excluded.sha256, mtime = excluded.mtime`,
  ).run(file.session, file.path, file.journalSize, file.localSize, file.tail, file.sha256, file.mtime)
}

export function stopJournal(db: Database, session: string, tool: Tool, reason: string): void {
  db.query('insert into journals (session, tool, stopped) values (?, ?, ?) on conflict (session) do update set stopped = excluded.stopped').run(session, tool, reason)
}

export function holdElsewhere(db: Database, session: string, holder: string, reason: string, tool: Tool = 'claude'): void {
  db.query(`insert into journals (session, tool, stopped, holder) values (?, ?, ?, ?)
    on conflict (session) do update set stopped = excluded.stopped, holder = excluded.holder`).run(session, tool, reason, holder)
}

export function holdHere(db: Database, session: string): void {
  db.query("update journals set stopped = '', holder = '' where session = ?").run(session)
}

function restartJournal(db: Database, journal: Omit<Journal, 'writtenAt' | 'stopped' | 'holder'>, files: readonly FileState[]): void {
  rmSync(spoolOf(db, journal.session), { recursive: true, force: true })
  db.transaction(() => {
    db.query(`insert into journals (session, tool, end, sealed, written_at) values (?, ?, ?, ?, ?)
      on conflict (session) do update set end = excluded.end, sealed = excluded.sealed, written_at = excluded.written_at, stopped = '', holder = ''`).run(
      journal.session, journal.tool, journal.end, journal.sealed, Date.now(),
    )
    db.query('delete from files where session = ?').run(journal.session)
    for (const file of files) saveFile(db, file)
  })()
}

export function continueJournal(db: Database, journal: Omit<Journal, 'writtenAt' | 'stopped' | 'holder'>, files: readonly FileState[]): void {
  db.transaction(() => {
    restartJournal(db, journal, files)
    db.query("update journals set untold = '' where session = ?").run(journal.session)
  })()
}

export function markUntold(db: Database, session: string, machine: string): void {
  db.query('update journals set untold = ? where session = ?').run(machine, session)
}

export const untoldOf = (db: Database, session: string): string => db.query<{ untold: string }, [string]>('select untold from journals where session = ?').get(session)?.untold ?? ''

export const journalOf = (db: Database, session: string): Journal | undefined => {
  const row = journalRow(db, session)
  return row === null ? undefined : { session: row.session, tool: row.tool, end: row.end, sealed: row.sealed, writtenAt: row.written_at, stopped: row.stopped, holder: row.holder }
}

export const workingFolderOf = (db: Database, session: string): string => db.query<{ cwd: string }, [string]>('select cwd from sessions where id = ?').get(session)?.cwd ?? ''

export async function sessionsOf(capture: Capture, path: string): Promise<{ readonly session: string; readonly tool: Tool }[]> {
  const state = codexState(capture.roots)
  if (path.startsWith(state)) {
    return capture.db.query<{ session: string; tool: Tool }, [string]>("select session, tool from files join journals using (session) where path = ? and mtime = 0 and stopped = ''").all(state)
  }
  const owner = ownerOf(path, capture.roots, capture.dataFolders)
  if (owner === undefined) return []
  if ('session' in owner) return [owner]
  if ('mod' in owner) return [{ session: historyOf(owner.mod, capture.device.id), tool: 'mod' }]
  const { db } = capture
  if ('prefix' in owner) return db.query<{ session: string; tool: Tool }, [string]>('select session, tool from journals where session like ?').all(`${owner.prefix}%`)
  if ('named' in owner) return db.query<{ session: string; tool: Tool }, [string]>('select files.session, journals.tool from files join journals using (session) where path = ?').all(path)
  const offset = db.query<{ offset: number }, [string]>('select offset from line_offsets where path = ?').get(path)?.offset
  const size = await stat(path).then((found) => found.size, () => 0)
  if (offset === undefined || size < offset) {
    db.query('insert or replace into line_offsets (path, offset) values (?, ?)').run(path, size)
    return []
  }
  const bytes = new Uint8Array(await Bun.file(path).slice(offset, size).arrayBuffer())
  const whole = bytes.lastIndexOf(10) + 1
  db.query('update line_offsets set offset = ? where path = ?').run(offset + whole, path)
  const named = new TextDecoder().decode(bytes.subarray(0, whole)).matchAll(new RegExp(`"${owner.lines}":"([0-9a-f-]{36})"`, 'g'))
  return [...new Set([...named].map((match) => match[1] ?? ''))].map((session) => ({ session, tool: owner.tool }))
}

export async function startLineOffsets(capture: Capture): Promise<void> {
  for (const path of linesFiles(capture.roots).keys()) {
    const size = await stat(path).then((found) => found.size, () => 0)
    capture.db.query('insert or ignore into line_offsets (path, offset) values (?, ?)').run(path, size)
  }
}

export const linesOf = (text: string, key: string, session: string): Uint8Array =>
  new TextEncoder().encode(
    text
      .split('\n')
      .slice(0, -1)
      .filter((line) => line.includes(`"${key}":"${session}"`))
      .map((line) => `${line}\n`)
      .join(''),
  )

let codexDatabase: { readonly path: string; readonly db: Database } | undefined

async function codexRow(path: string, session: string, codexHome: string): Promise<Uint8Array | undefined> {
  if (codexDatabase?.path !== path) codexDatabase = { path, db: new Database(path, { readonly: true }) }
  const reader = codexDatabase.db
  const read = (): Record<string, unknown> | null => reader.query<Record<string, unknown>, [string]>('select * from threads where id = ?').get(session)
  let row = read()
  const name = row !== null && 'name' in row && !row['name'] ? await codexNameOf(session, codexHome) : undefined
  if (name !== undefined) {
    const writer = new Database(path)
    try {
      writer.run('pragma busy_timeout = 5000')
      writer.query("update threads set name = ? where id = ? and coalesce(name, '') = ''").run(name, session)
    } finally {
      writer.close()
    }
    row = read()
  }
  return row === null ? undefined : new TextEncoder().encode(JSON.stringify(row))
}

async function sourceOf(capture: Capture, session: string, path: string): Promise<Source | undefined> {
  const found = await stat(path).catch(() => undefined)
  if (found === undefined || !found.isFile()) return undefined
  const lines = linesFiles(capture.roots).get(path)
  const view =
    lines !== undefined
      ? linesOf(await Bun.file(path).text(), lines.lines, session)
      : path === codexState(capture.roots)
        ? await codexRow(path, session, capture.roots.codexHome)
        : undefined
  if (lines !== undefined || path === codexState(capture.roots)) {
    if (view === undefined) return undefined
    return { size: view.length, mtime: found.mtimeMs, read: async (from, to) => view.subarray(from, to) }
  }
  return { size: found.size, mtime: found.mtimeMs, read: async (from, to) => new Uint8Array(await Bun.file(path).slice(from, to).arrayBuffer()) }
}

const isLog = (path: string, roots: MachineRoots): boolean => path.endsWith('.jsonl') || path.endsWith('.output') || linesFiles(roots).has(path)
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b))
export const tailOf = (bytes: Uint8Array): Uint8Array => bytes.slice(Math.max(0, bytes.length - TAIL_BYTES))
export const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

async function hasherOf(source: Source, size: number): Promise<Bun.CryptoHasher> {
  const hasher = new Bun.CryptoHasher('sha256')
  for (let at = 0; at < size; at += SCAN_READ_BYTES) hasher.update(await source.read(at, Math.min(size, at + SCAN_READ_BYTES)))
  return hasher
}

async function lineEndOf(source: Source, from: number): Promise<number> {
  for (let to = source.size; to > from; to -= SCAN_READ_BYTES) {
    const start = Math.max(from, to - SCAN_READ_BYTES)
    const newline = (await source.read(start, to)).lastIndexOf(10)
    if (newline >= 0) return start + newline + 1
  }
  return from
}

const isAppendedFile = (path: string, roots: MachineRoots): boolean => !linesFiles(roots).has(path) && path !== codexState(roots) && (isLog(path, roots) || isTranscript(path, roots))

async function streamedChange(
  capture: Capture,
  session: string,
  path: string,
  source: Source,
  region: { readonly from: number; readonly to: number },
  journalSize: number,
  prefix: Bun.CryptoHasher,
  baseOf: () => Promise<Uint8Array | undefined> = async () => undefined,
): Promise<Change> {
  const hasher = prefix.copy()
  let tail: Uint8Array = new Uint8Array()
  const pieces = async function* (): AsyncGenerator<Piece> {
    for await (const bytes of piecesFrom(path, region.from, region.to)) {
      hasher.update(bytes)
      tail = tailOf(Buffer.concat([tail, bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES))]))
      const base = await baseOf()
      yield base === undefined ? { bytes } : { bytes, against: base }
    }
  }
  const chunks = await storeChunks(capture, pieces())
  const sha256 = hasher.copy().digest('hex')
  return {
    header: { ...writerOf(capture, session), path, at: journalSize, size: 0, after: { size: region.to, sha256 }, chunks },
    bytes: new Uint8Array(),
    region,
    state: { session, path, journalSize: journalSize + region.to - region.from, localSize: region.to, tail, sha256, mtime: source.mtime },
    hasher,
    isPartial: false,
  }
}

export const checkoutOfEntry = (entry: Pick<IndexedSession, 'cwd' | 'repo' | 'repoFolder'>, home: string): string =>
  (entry.repo !== '' && entry.repoFolder !== '' ? entry.cwd.slice(0, -entry.repoFolder.length - 1) : entry.cwd) || home

const dataOf = (capture: Capture, session: string): DataFolder | undefined => capture.dataFolders.find(({ mod }) => historyOf(mod, capture.device.id) === session)

function writerOf(capture: Capture, session: string): Pick<RecordHeader, 'device' | 'checkout'> {
  const row = capture.db.query<Pick<SessionRow, 'cwd' | 'repo' | 'repo_folder'>, [string]>('select cwd, repo, repo_folder from sessions where id = ?').get(session)
  const checkout = dataOf(capture, session)?.folder ?? (row === null ? '' : checkoutOfEntry({ cwd: row.cwd, repo: row.repo, repoFolder: row.repo_folder }, ''))
  return { device: capture.device.id, ...(checkout === '' ? {} : { checkout }) }
}

async function deletionOf(capture: Capture, session: string, path: string, row: FileRow | null): Promise<Change | undefined> {
  if (row === null || row.sha256 === '' || linesFiles(capture.roots).has(path) || path === codexState(capture.roots)) return undefined
  if ((await stat(path).catch(() => undefined)) !== undefined) return undefined
  return {
    header: { ...writerOf(capture, session), path, at: 0, size: 0, after: null },
    bytes: new Uint8Array(),
    state: { session, path, journalSize: 0, localSize: 0, tail: new Uint8Array(), sha256: '', mtime: Date.now() },
    hasher: new Bun.CryptoHasher('sha256'),
    isPartial: false,
  }
}

async function changeOf(capture: Capture, session: string, path: string, budget: number): Promise<Change | undefined> {
  const source = await sourceOf(capture, session, path)
  const row = fileRow(capture.db, session, path)
  if (source === undefined) return await deletionOf(capture, session, path, row)
  const known = { journalSize: row?.journal_size ?? 0, localSize: row?.local_size ?? 0, tail: row?.tail ?? new Uint8Array(), sha256: row?.sha256 ?? '' }
  const key = `${session}\0${path}`
  const record = (at: number, bytes: Uint8Array, localSize: number, journalSize: number, hasher: Bun.CryptoHasher, tail: Uint8Array, isPartial: boolean): Change => {
    const sha256 = hasher.copy().digest('hex')
    return {
      header: { ...writerOf(capture, session), path, at, size: bytes.length, after: { size: localSize, sha256 } },
      bytes,
      state: { session, path, journalSize, localSize, tail, sha256, mtime: source.mtime },
      hasher,
      isPartial,
    }
  }
  const touched = (): undefined => void capture.db.query('update files set mtime = ? where session = ? and path = ?').run(source.mtime, session, path)
  if (source.size === 0 && !linesFiles(capture.roots).has(path)) {
    const empty = new Bun.CryptoHasher('sha256')
    return row !== null && known.sha256 === empty.copy().digest('hex') ? touched() : record(0, new Uint8Array(), 0, 0, empty, new Uint8Array(), false)
  }
  const owner = ownerOf(path, capture.roots)
  if (known.localSize === 0 && owner !== undefined && 'isTranscript' in owner && owner.isTranscript && owner.tool === 'claude') {
    const fork = await forkChange(capture, session, path, source)
    if (fork !== undefined) return fork
  }
  const isChunkable = async (): Promise<boolean> => isAppendedFile(path, capture.roots) && (await everyMachineReadsChunks(capture))
  if (isLog(path, capture.roots) && source.size >= known.localSize) {
    if (source.size === known.localSize) return touched()
    const from = Math.max(0, known.localSize - known.tail.length)
    if (sameBytes(await source.read(from, known.localSize), known.tail)) {
      const lineEnd = await lineEndOf(source, known.localSize)
      if (lineEnd === known.localSize) return undefined
      let hasher = known.localSize === 0 ? new Bun.CryptoHasher('sha256') : capture.hashers.get(key)
      if (hasher !== undefined && known.localSize > 0 && hasher.copy().digest('hex') !== known.sha256) hasher = undefined
      if (hasher === undefined && known.localSize > 0) {
        hasher = await hasherOf(source, known.localSize)
        if (hasher.copy().digest('hex') !== known.sha256) hasher = undefined
      }
      if (hasher !== undefined && lineEnd - known.localSize >= CHUNKED_FROM && (await isChunkable())) return await streamedChange(capture, session, path, source, { from: known.localSize, to: lineEnd }, known.journalSize, hasher)
      if (hasher !== undefined) {
        let end = Math.min(source.size, known.localSize + budget)
        let read = await source.read(from, end)
        while (read.lastIndexOf(10) < known.localSize - from && end < source.size) {
          end = Math.min(source.size, end + FRAME_BYTES)
          read = await source.read(from, end)
        }
        const gained = read.subarray(known.localSize - from, read.lastIndexOf(10) + 1)
        const grown = hasher.copy().update(gained)
        const localSize = known.localSize + gained.length
        return record(known.journalSize, gained, localSize, known.journalSize + gained.length, grown, tailOf(read.subarray(0, localSize - from)), end < source.size)
      }
    }
  }
  const wholeEnd = isLog(path, capture.roots) ? await lineEndOf(source, 0) : source.size
  if (wholeEnd >= CHUNKED_FROM && (await isChunkable())) {
    if (row !== null && source.size === known.localSize && (await hasherOf(source, source.size)).digest('hex') === known.sha256) return touched()
    return await streamedChange(capture, session, path, source, { from: 0, to: wholeEnd }, 0, new Bun.CryptoHasher('sha256'))
  }
  const bytes = await source.read(0, source.size)
  const hasher = new Bun.CryptoHasher('sha256').update(bytes)
  if (row !== null && bytes.length === known.localSize && hasher.copy().digest('hex') === known.sha256) return touched()
  const end = isLog(path, capture.roots) ? bytes.lastIndexOf(10) + 1 : bytes.length
  if (end === 0 && isLog(path, capture.roots)) return undefined
  const whole = bytes.subarray(0, end)
  return record(0, whole, end, end, end === bytes.length ? hasher : new Bun.CryptoHasher('sha256').update(whole), tailOf(whole), false)
}

export function recordForkStarts(db: Database, path: string, bytes: Uint8Array): void {
  const starts = forkStartsIn(bytes)
  if (starts.length === 0) return
  db.transaction(() => {
    for (const uuid of starts) db.query('insert or ignore into fork_starts (uuid, path) values (?, ?)').run(uuid, path)
  })()
}

export async function indexForkStarts(capture: Pick<Capture, 'db' | 'roots'>): Promise<number> {
  const { db, roots } = capture
  if (db.query('select 1 from fork_starts limit 1').get() !== null) return 0
  let indexed = 0
  for (const [, { tool, paths }] of await transcriptsOn(roots)) {
    if (tool !== 'claude') continue
    for (const path of paths.filter((each) => each.endsWith('.jsonl'))) {
      for await (const lines of wholeLinesIn(path)) recordForkStarts(db, path, lines)
      indexed += 1
    }
  }
  return indexed
}

export async function* wholeLinesIn(path: string, from = 0, to = Infinity): AsyncGenerator<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    let buffer = Buffer.allocUnsafe(SCAN_READ_BYTES)
    let filled = 0
    for (let at = from; at < to; ) {
      const { bytesRead } = await handle.read(buffer, filled, Math.min(buffer.length - filled, to - at), at)
      if (bytesRead === 0) break
      at += bytesRead
      filled += bytesRead
      const end = buffer.lastIndexOf(10, filled - 1) + 1
      if (end === 0) {
        if (filled === buffer.length) buffer = Buffer.concat([buffer, Buffer.allocUnsafe(buffer.length)])
        continue
      }
      yield buffer.subarray(0, end)
      buffer.copyWithin(0, end, filled)
      filled -= end
    }
  } finally {
    await handle.close()
  }
}

function chunkedChange(capture: Capture, session: string, path: string, written: Uint8Array, mtime: number, kind: Pick<RecordHeader, 'chunks' | 'fork'>, isPartial: boolean): Change {
  const hasher = new Bun.CryptoHasher('sha256').update(written)
  const sha256 = hasher.copy().digest('hex')
  return {
    header: { ...writerOf(capture, session), path, at: 0, size: 0, after: { size: written.length, sha256 }, ...kind },
    bytes: new Uint8Array(),
    region: { from: 0, to: written.length },
    state: { session, path, journalSize: written.length, localSize: written.length, tail: tailOf(written), sha256, mtime },
    hasher,
    isPartial,
  }
}

async function forkedChange(capture: Capture, session: string, path: string, whole: Uint8Array, mtime: number): Promise<Change | undefined> {
  const fork = forkIn(whole, session)
  const sourcePath = fork === undefined ? undefined : transcriptOf(capture.roots.claudeHome, fork.source)
  if (fork === undefined || sourcePath === undefined || Bun.file(sourcePath).size > FORK_BYTES) return undefined
  const read = await Bun.file(sourcePath).bytes()
  const source = read.subarray(0, read.lastIndexOf(10) + 1)
  const derived = await forkedTranscript(source, fork).catch(() => undefined)
  if (derived === undefined || derived.bytes.length > whole.length || !sameBytes(whole.subarray(0, derived.bytes.length), derived.bytes)) return undefined
  const pieces: Uint8Array[] = []
  let covered = 0
  for (const piece of piecesOf(source)) {
    if (covered >= derived.read) break
    pieces.push(piece)
    covered += piece.length
  }
  if (!sameBytes((await forkedTranscript(source.subarray(0, covered), fork)).bytes, derived.bytes) || !(await everyMachineReadsChunks(capture))) return undefined
  const chunks = await storeChunks(capture, pieces.map((bytes) => ({ bytes })))
  return chunkedChange(capture, session, path, derived.bytes, mtime, { chunks, fork }, derived.bytes.length < whole.length)
}

async function forkSignsOf(path: string): Promise<{ readonly isNamed: boolean; readonly first: string | undefined }> {
  let first: string | undefined
  for await (const lines of wholeLinesIn(path)) {
    if (namesFork(lines)) return { isNamed: true, first: first ?? firstUuidIn(lines) }
    first ??= firstUuidIn(lines)
  }
  return { isNamed: false, first }
}

const fileSource = (path: string): Source => {
  const file = Bun.file(path)
  return { size: file.size, mtime: file.lastModified, read: async (from, to) => new Uint8Array(await file.slice(from, to).arrayBuffer()) }
}

function holderOf(piece: Uint8Array, holders: ReadonlyMap<string, number>): number | undefined {
  const counts = new Map<number, number>()
  for (const { uuid } of uuidsIn(piece)) {
    const index = holders.get(uuid)
    if (index !== undefined) counts.set(index, (counts.get(index) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0]
}

async function deltaChange(capture: Capture, session: string, path: string, source: Source, parentPath: string): Promise<Change | undefined> {
  const parent = fileSource(parentPath)
  const read = (from: number, to: number): Promise<Uint8Array> => parent.read(from, to)
  const places: { readonly from: number; readonly to: number }[] = []
  const holders = new Map<string, number>()
  for await (const piece of piecesFrom(parentPath, 0, await lineEndOf(parent, 0))) {
    for (const { uuid } of uuidsIn(piece)) if (!holders.has(uuid)) holders.set(uuid, places.length)
    const from = places.at(-1)?.to ?? 0
    places.push({ from, to: from + piece.length })
  }
  const end = await lineEndOf(source, 0)
  if (end === 0) return undefined
  const against: (number | undefined)[] = []
  for await (const piece of piecesFrom(path, 0, end)) against.push(holderOf(piece, holders))
  const pieceOf = async (index: number | undefined): Promise<Uint8Array | undefined> => {
    const place = index === undefined ? undefined : places[index]
    return place === undefined ? undefined : await read(place.from, place.to)
  }
  const used = async function* (): AsyncGenerator<Piece> {
    for (const index of new Set(against)) {
      const bytes = await pieceOf(index)
      if (bytes !== undefined) yield { bytes }
    }
  }
  await storeChunks(capture, used())
  let next = 0
  return await streamedChange(capture, session, path, source, { from: 0, to: end }, 0, new Bun.CryptoHasher('sha256'), () => pieceOf(against[next++]))
}

async function forkChange(capture: Capture, session: string, path: string, source: Source): Promise<Change | undefined> {
  if (source.size > FORK_BYTES) return undefined
  const { isNamed, first } = await forkSignsOf(path)
  if (isNamed) {
    const read = await source.read(0, source.size)
    const forked = await forkedChange(capture, session, path, read.subarray(0, read.lastIndexOf(10) + 1), source.mtime)
    if (forked !== undefined) return forked
  }
  if (first === undefined) return undefined
  const candidates = capture.db.query<{ path: string }, [string, string]>('select path from fork_starts where uuid = ? and path != ?').all(first, path).map((start) => start.path)
  const parent = await parentOf(path, candidates, FORK_BYTES)
  if (parent === undefined || !(await everyMachineReadsChunks(capture))) return undefined
  return await deltaChange(capture, session, path, source, parent)
}

type Upload = {
  readonly session: string
  readonly tool: Tool
  readonly end: number
  readonly isFirst: boolean
  readonly changes: readonly Change[]
  readonly frames: readonly (readonly Change[])[]
  readonly code: { readonly isDone: boolean }
  readonly waiting: { readonly folder: string; readonly code: CodeCapture } | undefined
  readonly left: Set<string>
}

export type Changed = { readonly session: string; readonly tool: Tool; readonly paths: ReadonlySet<string> }
type Put = { readonly start: number; readonly body: Uint8Array; readonly records: readonly Change[]; readonly put: Promise<RanOf<'put'>> }

export function uploadSessions(capture: Capture, sessions: readonly Changed[], problems: Problems, isEveryWrite = false): (readonly [Changed, Promise<Set<string>>])[] {
  const drains = sessions.map((changed) => ({
    changed,
    upload: readUpload(capture, changed.session, changed.tool, changed.paths, problems, isEveryWrite),
    answered: Promise.withResolvers<readonly Put[]>(),
  }))
  void Promise.allSettled(drains.map(async ({ upload, answered }) => ({ upload: await upload, answered }))).then(async (all) => {
    const sending = all.flatMap((done) => (done.status === 'rejected' || done.value.upload instanceof Set ? [] : [{ upload: done.value.upload, answered: done.value.answered }]))
    try {
      const calls: Promise<Call>[] = []
      const asked = sending.map(({ upload: { session, end, frames }, answered }) => {
        let start = end
        const framed = frames.map((records) => {
          const body = Buffer.concat(records.flatMap((record) => encodeRecord(record.header, record.bytes)))
          const key = hotKey(session, start)
          const frame = { start, body, records, call: calls.push(compressHot(body).then((bytes): Call => ({ op: 'put', key, bytes, if: { none: '*' }, holder: session }))) - 1 }
          start += body.length
          return frame
        })
        return { answered, frames: framed }
      })
      const answers = capture.relay.run(await Promise.all(calls))
      for (const { answered, frames } of asked) answered.resolve(frames.map(({ call, ...frame }): Put => ({ ...frame, put: answers[call] as Promise<RanOf<'put'>> })))
    } catch (error) {
      for (const { answered } of sending) answered.reject(error)
    }
  })
  return drains.map(({ changed, upload, answered }) => [changed, upload.then(async (read) => (read instanceof Set ? read : await finishUpload(capture, read, await answered.promise, problems)))])
}

async function readUpload(capture: Capture, session: string, tool: Tool, paths: ReadonlySet<string>, problems: Problems, isEveryWrite: boolean): Promise<Upload | Set<string>> {
  const { db, roots } = capture
  let journal = journalOf(db, session)
  let isFirst = false
  const work = new Set(paths)
  const data = dataOf(capture, session)
  if (tool === 'mod' && data === undefined) return new Set()
  if (journal === undefined) {
    const files = data === undefined ? await filesOf(session, tool, roots) : (await filesUnder(data.folder)).map(({ path }) => path).filter((path) => ownerOf(path, roots, [data]) !== undefined)
    const isWritten = [...work].some((path) => existsSync(path)) && [...work, ...files].some((path) => isTranscript(path, roots) && existsSync(path))
    if (data === undefined && !isWritten) return new Set()
    db.transaction(() => {
      db.query('insert or ignore into journals (session, tool, written_at) values (?, ?, ?)').run(session, tool, Date.now())
      rememberFiles(db, session, files)
    })()
    for (const path of files) work.add(path)
    journal = { session, tool, end: 0, sealed: 0, writtenAt: 0, stopped: '', holder: '' }
    isFirst = true
  }
  if (journal.stopped !== '') return new Set()
  if (tool === 'codex') work.add(codexState(roots))
  const changes: Change[] = []
  const left = new Set<string>()
  let budget = FRAME_BYTES
  for (const path of work) {
    if (path.endsWith('/')) continue
    if (budget <= 0) {
      left.add(path)
      continue
    }
    const change = await changeOf(capture, session, path, budget).then(
      (found) => (problems.clear(path), found),
      (error: unknown) => void problems.set(path, error),
    )
    if (change === undefined) continue
    changes.push(change)
    budget -= change.region === undefined ? change.bytes.length : change.region.to - change.region.from
    if (change.isPartial) left.add(path)
    if (data === undefined && path.endsWith('.jsonl')) {
      const found = new Set<string>()
      for await (const block of blocksOf(change)) for (const file of namedIn(block, roots)) found.add(file)
      const named = [...found].filter((file) => !work.has(file))
      rememberFiles(db, session, named)
      for (const file of named) work.add(file)
    }
  }
  const waiting = capture.codeWaiting.get(session)
  const isFilesAlone = isEveryWrite && changes.length > 0 && !capture.codeSkipped.has(session)
  if (isFilesAlone && waiting !== undefined) capture.codeSkipped.add(session)
  else capture.codeSkipped.delete(session)
  const code = waiting === undefined || isFilesAlone ? { frames: [], isDone: false } : codeFrames(capture, session, waiting, isEveryWrite)
  const frames = (isFilesAlone ? [changes] : isEveryWrite ? [changes, ...code.frames] : [[...changes, ...code.frames.flat()]]).filter((records) => records.length > 0)
  const unplaced = (): void => void db.query('delete from journals where session = ? and end = 0').run(session)
  if (frames.length === 0) {
    if (isFirst) unplaced()
    return left
  }
  const end = isFirst
    ? await chainEndAtFirstCapture(capture, session).catch((error: unknown) => {
        unplaced()
        throw error
      })
    : journal.end
  return { session, tool, end, isFirst, changes, frames, code, waiting, left }
}

async function finishUpload(capture: Capture, upload: Upload, puts: readonly Put[], problems: Problems): Promise<Set<string>> {
  const { db, roots } = capture
  const { session, tool, isFirst, changes, code, waiting, left } = upload
  type Outcome = { readonly frame: Put; readonly landed: Landed } | { readonly frame: Put; readonly error: unknown }
  const outcomes = await Promise.all(
    puts.map((frame) =>
      frame.put.then((put) => frameWritten(capture, session, tool, frame.start, frame.body, put, isFirst)).then(
        (landed): Outcome => ({ frame, landed }),
        (error: unknown): Outcome => ({ frame, error }),
      ),
    ),
  )
  const landed = new Set(outcomes.flatMap((outcome) => ('landed' in outcome ? [outcome.landed] : [])))
  if (landed.has('refused')) return new Set()
  if (landed.has('behind')) {
    db.query('delete from journals where session = ? and end = ?').run(session, upload.end)
    rmSync(spoolOf(db, session), { recursive: true, force: true })
    return new Set([...changes.map(({ header }) => header.path), ...left])
  }
  const failure = outcomes.find((outcome) => 'error' in outcome)
  const counted = failure === undefined ? outcomes : outcomes.slice(0, outcomes.indexOf(failure))
  const records = counted.flatMap(({ frame }) => frame.records)
  const last = counted.at(-1)?.frame
  const end = last === undefined ? upload.end : last.start + last.body.length
  const transcripts = changes.filter(({ header }) => isTranscript(header.path, roots) && (header.size > 0 || header.chunks !== undefined))
  if (counted.length > 0) {
    db.transaction(() => {
      db.query(`insert into journals (session, tool, end, written_at) values (?, ?, ?, ?)
        on conflict (session) do update set end = excluded.end, written_at = excluded.written_at`).run(session, tool, end, Date.now())
      for (const record of records) saveFile(db, record.state)
    })()
    for (const record of records) capture.hashers.set(`${session}\0${record.header.path}`, record.hasher)
    for (const record of records) {
      if (tool !== 'claude' || !record.header.path.endsWith('.jsonl') || !isTranscript(record.header.path, roots)) continue
      for await (const block of blocksOf(record)) recordForkStarts(db, record.header.path, block)
    }
  }
  if (failure !== undefined && 'error' in failure) throw failure.error
  const own = changes.filter(({ header }) => !linesFiles(roots).has(header.path) && header.path !== codexState(roots))
  const lastActivity = new Date(own.length === 0 ? Date.now() : Math.max(...own.map((change) => change.state.mtime))).toISOString()
  const texts = async function* (): AsyncGenerator<Uint8Array | string> {
    for (const change of transcripts) {
      const { header, region, bytes } = change
      if (!header.path.endsWith('.zst')) yield* blocksOf(change)
      else yield await zstdSummaryTextOf(region === undefined ? Readable.from([bytes]) : createReadStream(header.path, { start: region.from, end: region.to - 1 }), header.path)
    }
  }
  if (tool !== 'mod' && (await recordSummary(capture, session, tool, texts(), end, lastActivity))) {
    await writeIndex(capture).then(() => problems.clear('index'), (error: unknown) => problems.set('index', error))
  }
  if (waiting !== undefined && !code.isDone) left.add(`${waiting.folder}/`)
  if (code.isDone) capture.codeWaiting.delete(session)
  if (capture.readsCode && (changes.length > 0 || capture.codeStale.has(session))) startCode(capture, session, tool, problems)
  return left
}

type Landed = 'written' | 'refused' | 'behind'

async function frameWritten(capture: Capture, session: string, tool: Tool, start: number, body: Uint8Array, put: RanOf<'put'>, isFirst: boolean): Promise<Landed> {
  const { relay, db, device } = capture
  const key = hotKey(session, start)
  let answer = put
  if (answer.status === 412) {
    const there = await relay.runOne({ op: 'get', key })
    const written = there.status === 200 ? await decompress(there.bytes) : undefined
    const writer = written === undefined ? undefined : (JSON.parse(new TextDecoder().decode(written.subarray(0, written.indexOf(10)))) as RecordHeader).device
    const isStale = !isFirst && start > 0 && writer !== undefined && writer !== device.id && (await claimsOf(relay, session)).get(session)?.id === device.id
    if (writer === device.id || writer === undefined || isStale) {
      if (isStale) console.error(`${new Date().toISOString()} ${device.name} holds the session ${session}, and a frame another machine wrote after it took the session sits at byte ${start} of its journal, so ${device.name} writes its own frame over it.`)
      answer = await relay.runOne({ op: 'put', key, bytes: await compressHot(body), if: there.status === 200 ? { match: there.etag } : { none: '*' }, holder: session })
    }
    if (answer.status === 412 && isFirst) {
      console.error(`${new Date().toISOString()} Another machine wrote byte ${start} of the session ${session}'s journal as ${device.name} started capturing it, so ${device.name} starts again from the end of the journal in R2.`)
      return 'behind'
    }
    if (answer.status === 412) {
      const fork = `${new Date().toISOString()} Another machine wrote byte ${start} of the session ${session}'s journal first, so ${device.name} stops capturing it, and its lines from here are a fork of the session.`
      console.error(fork)
      const machine = writer === undefined || writer === device.id ? undefined : (await devicesOf(relay)).get(writer)?.name
      if (machine === undefined) stopJournal(db, session, tool, fork)
      else holdElsewhere(db, session, machine, fork, tool)
      return 'refused'
    }
  }
  if (answer.status === 409) {
    releasedTo(capture, session, answer.holder, `${new Date().toISOString()} ${answer.holder.name} took the session ${session} over, so ${device.name} stops capturing it.`, tool)
    return 'refused'
  }
  await Bun.write(join(spoolOf(db, session), String(start)), body)
  return 'written'
}

function codeFrames(capture: Capture, session: string, waiting: { readonly folder: string; readonly code: CodeCapture }, isEveryWrite: boolean): { frames: Change[][]; isDone: boolean } {
  const frameBytes = isEveryWrite ? CODE_PIECE_BYTES : FRAME_BYTES
  let room = isEveryWrite ? CODE_PIECE_BYTES * CODE_PIECES : FRAME_BYTES
  const frames: Change[][] = []
  let size = 0
  for (const { path, bytes } of waiting.code.parts) {
    let previous: Change | undefined
    let sent = fileRow(capture.db, session, path)?.journal_size ?? 0
    while (sent < bytes.length) {
      if (room <= 0) return { frames, isDone: false }
      const to = Math.min(bytes.length, sent + frameBytes, sent + room)
      previous = codeRecord(capture, session, path, bytes, sent, to, previous)
      if (frames.length === 0 || size + previous.bytes.length > frameBytes) {
        frames.push([])
        size = 0
      }
      frames.at(-1)?.push(previous)
      size += previous.bytes.length
      room -= to - sent
      sent = to
    }
  }
  const { header } = waiting.code
  const last = frames.at(-1)
  const record = codeRecord(capture, session, `${waiting.folder}/`, header, 0, header.length)
  if (last === undefined) frames.push([record])
  else last.push(record)
  return { frames, isDone: true }
}

function codeRecord(capture: Capture, session: string, path: string, bytes: Uint8Array, from: number, to: number, previous?: Change): Change {
  const kept = capture.hashers.get(`${session}\0${path}`)
  const known = from === 0 ? undefined : (previous?.hasher ?? (kept?.copy().digest('hex') === fileRow(capture.db, session, path)?.sha256 ? kept : undefined))
  const before = known === undefined ? new Bun.CryptoHasher('sha256').update(bytes.subarray(0, from)) : known.copy()
  const hasher = before.update(bytes.subarray(from, to))
  const sha256 = hasher.copy().digest('hex')
  return {
    header: { ...writerOf(capture, session), path, at: from, size: to - from, after: { size: to, sha256 } },
    bytes: bytes.subarray(from, to),
    state: { session, path, journalSize: to, localSize: to, tail: tailOf(bytes.subarray(0, to)), sha256, mtime: 0 },
    hasher,
    isPartial: false,
  }
}

export function startCode(capture: Capture, session: string, tool: Tool, problems: Problems, isNow = false): void {
  const folder = workingFolderOf(capture.db, session)
  if (folder === '') return
  if (capture.codeRuns.has(session) || capture.codeWaiting.has(session)) {
    capture.codeStale.add(session)
    return
  }
  const wait = (capture.codeReadAt.get(session) ?? -Infinity) + capture.codeEveryMs - Date.now()
  if (!isNow && wait > 0) {
    capture.codeStale.add(session)
    if (!capture.codeLater.has(session)) {
      const later = setTimeout(() => {
        capture.codeLater.delete(session)
        if (capture.codeStale.has(session)) startCode(capture, session, tool, problems)
      }, wait)
      later.unref()
      capture.codeLater.set(session, later)
    }
    return
  }
  clearTimeout(capture.codeLater.get(session))
  capture.codeLater.delete(session)
  capture.codeReadAt.set(session, Date.now())
  capture.codeStale.delete(session)
  const run = stat(folder)
    .then(
      (found) => found.isDirectory(),
      () => false,
    )
    .then((isFolder) => {
      if (isFolder) return capture.captureCode(folder, session)
      if (!capture.missingFolders.has(folder)) console.error(`${new Date().toISOString()} ${folder} is no folder on ${capture.device.name}, so anyhost keeps no code of the sessions that work in it.`)
      capture.missingFolders.add(folder)
      return undefined
    })
    .then(
      (code): undefined => {
        problems.clear(`code ${folder}`)
        if (code === undefined) return
        capture.codeWaiting.set(session, { folder, code })
        capture.onCode(session, tool, folder)
      },
      (error: unknown): Error => {
        problems.set(`code ${folder}`, error)
        return error instanceof Error ? error : new Error(String(error))
      },
    )
    .finally(() => {
      capture.codeRuns.delete(session)
      if (!capture.codeWaiting.has(session) && capture.codeStale.has(session)) startCode(capture, session, tool, problems)
    })
  capture.codeRuns.set(session, run)
}

function statOf(path: string): Stats | undefined {
  try {
    return statSync(path, { throwIfNoEntry: false })
  } catch {
    return undefined
  }
}

export async function changedFiles(capture: Capture, writtenSince = 0, session?: string): Promise<Map<string, Set<string>>> {
  const { db, roots } = capture
  const rows = db.query<{ session: string; path: string; local_size: number; mtime: number; sha256: string }, [number, string | null]>(
    "select files.session, path, local_size, mtime, sha256 from files join journals using (session) where stopped = '' and written_at >= ?1 and (?2 is null or session = ?2)",
  ).all(writtenSince, session ?? null)
  const lines = linesFiles(roots)
  const codex = codexState(roots)
  const changed = new Map<string, Set<string>>()
  for (const [index, { session, path, local_size, mtime, sha256 }] of rows.entries()) {
    if (index % SWEEP_BATCH === SWEEP_BATCH - 1) await new Promise((resolve) => setImmediate(resolve))
    if (lines.has(path) || path === codex || isCodePart(path) || path.endsWith('/')) continue
    const found = statOf(path)
    const isGone = found === undefined && sha256 !== ''
    if (!isGone && (found === undefined || !found.isFile() || (found.size === local_size && found.mtimeMs === mtime))) continue
    if (ownerOf(path, roots, capture.dataFolders) === undefined) continue
    changed.set(session, (changed.get(session) ?? new Set()).add(path))
  }
  return changed
}

export async function seal(capture: Capture, session: string): Promise<number> {
  const { relay, db } = capture
  const end = journalOf(db, session)?.end ?? 0
  const listed = await relay.list(journalPrefix(session))
  const { frames, sealedEnd, stale } = framesOf(session, listed)
  const leftover = listed.flatMap(({ key }) => (key.startsWith(nextPrefix(session)) ? [key] : []))
  const hot = frames.filter((frame) => frame.key.includes('/hot/') && frame.start < end)
  let at = sealedEnd
  let run: Uint8Array[] = []
  let runBytes = 0
  const flush = async (): Promise<void> => {
    if (runBytes === 0) return
    const key = sealedKey(session, at, at + runBytes)
    const put = await relay.runOne({ op: 'put', key, bytes: await compressSealed(Buffer.concat(run)), if: { none: '*' } })
    if (put.status !== 200) throw new Error(`The relay answered ${put.status} to the put of ${key}, so anyhost deletes no hot frame of ${session}.`)
    ;[at, run, runBytes] = [at + runBytes, [], 0]
  }
  const spool = spoolOf(db, session)
  for await (const { bytes } of chainOf(relay, hot, sealedEnd, spool)) {
    if (runBytes > 0 && runBytes + bytes.length > FRAME_BYTES) await flush()
    run.push(bytes)
    runBytes += bytes.length
  }
  await flush()
  await deleteFrames(relay, session, [...stale, ...hot.map(({ key }) => key), ...leftover])
  for (const frame of hot) rmSync(join(spool, String(frame.start)), { force: true })
  return at
}

async function deleteFrames(relay: Relay, session: string, keys: readonly string[]): Promise<void> {
  const deletes: Call[] = []
  for (let from = 0; from < keys.length; from += MAX_KEYS) deletes.push({ op: 'delete', keys: keys.slice(from, from + MAX_KEYS), holder: session })
  await Promise.all(relay.run(deletes))
}

async function deleteReplacedWhileBorrowed(capture: Capture, session: string): Promise<void> {
  const { relay, db } = capture
  const listed = await relay.list(journalPrefix(session))
  const leftover = listed.flatMap(({ key }) => (key.startsWith(nextPrefix(session)) ? [key] : []))
  if (db.query('select 1 from borrowed_claims where session = ?').get(session) === null) return
  await deleteFrames(relay, session, [...framesOf(session, listed).stale, ...leftover])
}

async function chainEndIn(relay: Relay, session: string): Promise<{ readonly end: number; readonly sealedEnd: number }> {
  const { frames, sealedEnd } = framesOf(session, await relay.list(journalPrefix(session)))
  let end = sealedEnd
  for await (const { end: reached } of chainOf(relay, frames.filter((frame) => frame.start >= sealedEnd), sealedEnd)) end = reached
  return { end, sealedEnd }
}

async function chainEndAtFirstCapture(capture: Capture, session: string): Promise<number> {
  const { relay, db, device } = capture
  const { end, sealedEnd } = await chainEndIn(relay, session)
  if (end === 0) return 0
  db.query('update journals set end = ?, sealed = ? where session = ? and end = 0').run(end, sealedEnd, session)
  console.error(`${new Date().toISOString()} The journal of ${session} in R2 reaches byte ${end}, and ${device.name} held no row of it, so it uploads the files of ${session} whole from byte ${end}.`)
  return end
}

export function captureAgainFrom(capture: Capture, session: string, tool: Tool, at: number, end: number, problems: Problems): Set<string> {
  const { db, device, roots } = capture
  const paths = db
    .query<{ path: string }, [string]>('select path from files where session = ?')
    .all(session)
    .map(({ path }) => path)
    .filter((path) => !isCodePart(path) && !path.endsWith('/'))
  restartJournal(db, { session, tool, end: at, sealed: at }, paths.map((path) => ({ session, path, journalSize: 0, localSize: 0, tail: new Uint8Array(), sha256: '', mtime: 0 })))
  rmSync(join(dirname(db.filename), 'code', session), { recursive: true, force: true })
  capture.codeWaiting.delete(session)
  const reached = `The journal of ${session} in R2 reaches byte ${at}, and ${device.name} counted ${end}`
  const hasFiles = tool === 'mod' || paths.some((path) => {
    const owner = ownerOf(path, roots)
    return owner !== undefined && 'isTranscript' in owner && owner.isTranscript && existsSync(path)
  })
  if (hasFiles) console.error(`${new Date().toISOString()} ${reached}, so it uploads the files of ${session} whole again from byte ${at}.`)
  else problems.set(`journal ${session}`, `${reached}, and holds no transcript of the session to upload again, so a restore of the session lacks what the journal held from byte ${at}.`)
  return new Set(paths)
}

export async function sealJournal(capture: Capture, session: string, tool: Tool, problems: Problems): Promise<Set<string>> {
  const end = journalOf(capture.db, session)?.end ?? 0
  const at = await seal(capture, session)
  if (at !== end) return captureAgainFrom(capture, session, tool, at, end, problems)
  capture.db.query('update journals set sealed = ?, replaced = 0 where session = ?').run(at, session)
  return new Set()
}

export async function sealQuiet(capture: Capture, problems: Problems, now = Date.now()): Promise<Map<string, Set<string>>> {
  const { db, relay, device, sealWaits } = capture
  type Sealing = { readonly session: string; readonly tool: Tool }
  const quiet = db.query<Sealing, [number]>("select session, tool from journals where stopped = '' and end > sealed and written_at < ?").all(now - QUIET_MS)
  const compactable = db
    .query<Sealing, [number]>(
      `select session, tool from journals where stopped = '' and end > 0 and end = sealed
       and (replaced = 1 or (compact_after <= ? and sealed - compacted_end > compacted_kept)) order by replaced desc, written_at`,
    )
    .all(now)
  const isTried = ({ session }: Sealing): boolean => {
    const wait = sealWaits.get(session)
    if (wait === undefined || wait.passes <= 1) return true
    wait.passes -= 1
    return false
  }
  const again = new Map<string, Set<string>>()
  const compacting = compactable.find(isTried)
  for (const { session, tool } of [...quiet.filter(isTried), ...(compacting === undefined ? [] : [compacting])]) {
    try {
      const claim = await relay.runOne({ op: 'claim', session, take: false })
      if (claim.status === 409) releasedTo(capture, session, claim.holder, `${new Date().toISOString()} ${claim.holder.name} holds the session ${session}, so ${device.name} stops capturing it.`, tool)
      else {
        const files = await sealJournal(capture, session, tool, problems)
        if (files.size > 0) again.set(session, files)
        else await rewriteJournal(capture, session, tool, now, { lagMs: capture.compactLagMs, isForced: false })
      }
      sealWaits.delete(session)
      problems.clear(`seal ${session}`)
    } catch (error) {
      const failures = (sealWaits.get(session)?.failures ?? 0) + 1
      sealWaits.set(session, { failures, passes: Math.min(2 ** (failures - 1), SEAL_WAIT_PASSES) })
      problems.set(`seal ${session}`, error)
    }
  }
  return again
}

type Span = { readonly start: number; readonly end: number; readonly from: number; readonly to: number; readonly written: number }
type Staged = { readonly header: RecordHeader; readonly from: number; readonly body: number; readonly to: number }

type Group = { readonly spans: Span[]; readonly records: number[]; kept: number }

function groupsOf(spans: readonly Span[], records: readonly Staged[], dropped: ReadonlySet<number>, ends: ReadonlySet<number>): Group[] {
  const groups: Group[] = []
  let next = 0
  for (const span of spans) {
    const inSpan: number[] = []
    let kept = 0
    for (let record = records[next]; record !== undefined && record.from < span.to; record = records[next]) {
      inSpan.push(next)
      if (!dropped.has(next)) kept += record.to - record.from
      next += 1
    }
    const group = groups.at(-1)
    const last = group?.spans.at(-1)
    if (group === undefined || last === undefined || (ends.has(last.to) && group.kept + kept > FRAME_BYTES)) groups.push({ spans: [span], records: inSpan, kept })
    else {
      group.spans.push(span)
      for (const index of inSpan) group.records.push(index)
      group.kept += kept
    }
  }
  return groups
}

async function readAt(handle: FileHandle, at: number, length: number): Promise<Uint8Array> {
  const { bytesRead, buffer } = await handle.read(new Uint8Array(length), 0, length, at)
  if (bytesRead !== length) throw new Error(`anyhost read ${bytesRead} of ${length} bytes at byte ${at} of the journal it compacts.`)
  return buffer
}

async function lineAt(handle: FileHandle, at: number, end: number): Promise<Uint8Array> {
  for (let length = Math.min(4096, end - at); ; length = Math.min(2 * length, end - at)) {
    const read = await readAt(handle, at, length)
    const newline = read.indexOf(10)
    if (newline >= 0) return read.subarray(0, newline)
    if (at + length === end) throw new Error(`The record at byte ${at} of the journal anyhost compacts has no header line.`)
  }
}

async function stagedRecordsOf(handle: FileHandle, size: number, session: string): Promise<Staged[]> {
  const records: Staged[] = []
  let at = 0
  while (at < size) {
    const line = await lineAt(handle, at, size)
    const header = JSON.parse(new TextDecoder().decode(line)) as RecordHeader
    const body = at + line.length + 1
    records.push({ header, from: at, body, to: body + header.size })
    at = body + header.size
  }
  if (at !== size) throw new Error(`The journal of ${session} ends inside a record of ${records.at(-1)?.header.path ?? 'a header'}, so anyhost compacts none of it.`)
  return records
}

async function stagedBytes(handle: FileHandle, records: readonly Staged[]): Promise<Uint8Array> {
  const runs: { from: number; to: number }[] = []
  for (const { from, to } of records) {
    const last = runs.at(-1)
    if (last?.to === from) last.to = to
    else runs.push({ from, to })
  }
  const parts: Uint8Array[] = []
  for (const { from, to } of runs) parts.push(await readAt(handle, from, to - from))
  return Buffer.concat(parts)
}

async function droppedOf(handle: FileHandle, records: readonly Staged[]): Promise<Set<number>> {
  const dropped = new Set<number>()
  const laterCode = new Set<string>()
  const laterWhole = new Map<string, Set<string>>()
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const header = records[index]?.header
    if (header === undefined) continue
    const writer = `${header.device}\0${header.checkout ?? ''}\0${header.path}`
    if (header.path.endsWith('/')) {
      if (laterCode.has(writer)) dropped.add(index)
      laterCode.add(writer)
    } else if (header.after !== null) {
      const whole = laterWhole.get(basename(header.path)) ?? new Set<string>()
      if (whole.has(writer)) dropped.add(index)
      if (header.at === 0) whole.add(writer)
      else for (const other of whole) if (other !== writer) whole.delete(other)
      laterWhole.set(basename(header.path), whole)
    }
  }
  const named = new Set<string>()
  for (const [index, { header, body, to }] of records.entries()) {
    if (!header.path.endsWith('/') || dropped.has(index) || body === to) continue
    const code = JSON.parse(new TextDecoder().decode(await lineAt(handle, body, to))) as { readonly parts: readonly (readonly [string, number, string])[] }
    for (const [hash, , where] of code.parts) if (where === 'record') named.add(hash)
  }
  for (const [index, { header }] of records.entries()) if (isCodePart(header.path) && !named.has(basename(header.path))) dropped.add(index)
  return dropped
}

type Replacement = { readonly header: RecordHeader; readonly body: Uint8Array }
export type Rewritten = { readonly isCurrent: boolean; readonly ops: number }

const representedOf = (header: RecordHeader): number => header.chunks?.reduce((total, [, size]) => total + size, 0) ?? 0

async function contentOf(capture: Capture, handle: FileHandle, record: Staged, read: ChunkReader): Promise<Uint8Array> {
  const { header } = record
  if (header.chunks !== undefined) return await bytesOfChunks(read, header)
  const body = await readAt(handle, record.body, record.to - record.body)
  return header.base === undefined ? body : await decompressDelta(body, await downloadBase(capture.relay, basesOf(capture.db), header.base))
}

async function foldOf(capture: Capture, handle: FileHandle, records: readonly Staged[], run: readonly number[], read: ChunkReader, checkout: string | undefined): Promise<Replacement | undefined> {
  const anchor = records[run[0] ?? -1]?.header
  const last = records[run.at(-1) ?? -1]?.header
  if (anchor === undefined || last === undefined || last.after === null || anchor.at !== 0 || anchor.fork !== undefined) return undefined
  const isOld = anchor.base !== undefined
  if (!isOld && (last.after.size > FORK_BYTES || (run.length < 2 && (anchor.chunks !== undefined || anchor.size < CHUNKED_FROM)))) return undefined
  const parts: Uint8Array[] = []
  let length = 0
  for (const index of run) {
    const record = records[index]
    if (record === undefined || record.header.at > length) return undefined
    while (length > record.header.at) {
      const tail = parts.pop() ?? new Uint8Array()
      const keep = Math.max(0, tail.length - (length - record.header.at))
      if (keep > 0) parts.push(tail.subarray(0, keep))
      length -= tail.length - keep
    }
    const content = await contentOf(capture, handle, record, read)
    parts.push(content)
    length += content.length
  }
  const bytes = Buffer.concat(parts)
  if (bytes.length !== last.after.size || sha256(bytes) !== last.after.sha256) {
    console.error(`${new Date().toISOString()} ${anchor.path} replays to ${bytes.length} bytes from its records, not the ${last.after.size} with the sha256 its last record says, so anyhost leaves its records as they are.`)
    return undefined
  }
  const header = { device: anchor.device, ...(checkout === undefined ? {} : { checkout }), path: anchor.path, at: 0, after: last.after }
  if (bytes.length < CHUNKED_FROM) return { header: { ...header, size: bytes.length }, body: bytes }
  const base = anchor.base === undefined ? undefined : await downloadBase(capture.relay, basesOf(capture.db), anchor.base)
  return { header: { ...header, size: 0, chunks: await chunkListOf(capture, bytes, base) }, body: new Uint8Array() }
}

async function foldsOf(capture: Capture, handle: FileHandle, records: readonly Staged[], dropped: ReadonlySet<number>, count: number, read: ChunkReader): Promise<{ readonly replaced: Map<number, Replacement>; readonly folded: Set<number> }> {
  const runs = new Map<string, { readonly name: string; checkout?: string; readonly indices: number[] }>()
  const replaced = new Map<number, Replacement>()
  const folded = new Set<number>()
  const close = async (key: string): Promise<void> => {
    const run = runs.get(key)
    runs.delete(key)
    const last = run?.indices.at(-1)
    if (run === undefined || last === undefined) return
    const replacement = await foldOf(capture, handle, records, run.indices, read, run.checkout)
    if (replacement === undefined) return
    for (const index of run.indices.slice(0, -1)) folded.add(index)
    replaced.set(last, replacement)
  }
  for (let index = 0; index < count; index += 1) {
    const header = records[index]?.header
    if (header === undefined || dropped.has(index) || header.path.endsWith('/') || isCodePart(header.path)) continue
    const key = `${header.device}\0${header.path}`
    const name = basename(header.path)
    for (const [other, run] of [...runs]) if (other !== key && run.name === name) await close(other)
    const run = runs.get(key)
    if (header.after === null || header.at === 0 || (run?.checkout !== undefined && header.checkout !== run.checkout)) await close(key)
    if (header.after !== null && header.at === 0) runs.set(key, { name, ...(header.checkout === undefined ? {} : { checkout: header.checkout }), indices: [index] })
    else if (header.after !== null && run !== undefined && runs.has(key)) {
      run.indices.push(index)
      if (header.checkout !== undefined) run.checkout = header.checkout
    }
  }
  for (const key of [...runs.keys()]) await close(key)
  return { replaced, folded }
}

const nextPrefix = (session: string): string => `${journalPrefix(session)}next/`
const compactedName = (start: number, end: number, written: number | undefined): string => (written === undefined ? `${position(start)}-${position(end)}.zst` : rewrittenName(start, end, written))
const RECHECK_BYTES = 8 * 2 ** 20

const fileKeyOf = (session: string, path: string): string => (path.includes(session) ? path.slice(path.indexOf(session)) : basename(path))

async function fileStatesOf(capture: Capture, session: string, folder: string, parts: AsyncIterable<Uint8Array>): Promise<Map<string, string>> {
  mkdirSync(folder, { recursive: true })
  const replay = new Replay(folder, ({ path }) => fileKeyOf(session, path), (base) => downloadBase(capture.relay, basesOf(capture.db), base), chunkReader(capture.relay))
  for await (const bytes of parts) await replay.push(bytes)
  replay.close()
  const states = new Map<string, string>()
  const stateOf = async (staged: string): Promise<string> => {
    const hasher = new Bun.CryptoHasher('sha256')
    for await (const piece of Bun.file(staged).stream()) hasher.update(piece)
    return `${Bun.file(staged).size} ${hasher.digest('hex')}`
  }
  for (const [path, { staged, last }] of replay.files) if (!isCodePart(last.path)) states.set(path, await stateOf(staged))
  for (const [path, { staged }] of replay.removed) states.set(`removed ${path}`, await stateOf(staged))
  for (const path of replay.deleted) states.set(`deleted ${path}`, '')
  return states
}

async function* stagedRange(handle: FileHandle, from: number, to: number): AsyncGenerator<Uint8Array> {
  for (let at = from; at < to; at += RECHECK_BYTES) yield await readAt(handle, at, Math.min(RECHECK_BYTES, to - at))
}

export async function rewriteJournal(capture: Capture, session: string, tool: Tool | undefined, now: number, { lagMs, isForced }: { readonly lagMs: number; readonly isForced: boolean }): Promise<Rewritten | undefined> {
  const { db, relay, device } = capture
  const row = db
    .query<{ sealed: number; compacted_end: number; compacted_kept: number; compact_after: number }, [string]>('select sealed, compacted_end, compacted_kept, compact_after from journals where session = ?')
    .get(session)
  if (!isForced && (row === null || row.compact_after > now || row.sealed - row.compacted_end <= row.compacted_kept)) return undefined
  const journal = row ?? { sealed: 0, compacted_end: 0, compacted_kept: 0, compact_after: 0 }
  if (capture.codeRuns.has(session) || capture.codeWaiting.has(session)) return undefined
  const listed = await relay.list(journalPrefix(session))
  if (isForced && listed.some(({ key }) => key === rewrittenKey(session))) return { isCurrent: true, ops: 1 }
  const leftover = listed.flatMap(({ key }) => (key.startsWith(nextPrefix(session)) ? [key] : []))
  if (leftover.length > 0) await Promise.all(relay.run([{ op: 'delete', keys: leftover, holder: session }]))
  const { frames, stale } = framesOf(session, listed)
  const chain = frames.filter((frame) => frame.end !== undefined)
  if (lagMs > 0 && chain.some((frame) => frame.uploaded === undefined)) return undefined
  const young = lagMs === 0 ? undefined : chain.find((frame) => !isCompacted(frame) && (frame.uploaded ?? now) > now - lagMs)
  if (!isForced) db.query('update journals set compact_after = ? where session = ?').run(young === undefined ? 0 : (young.uploaded ?? now) + lagMs, session)
  const old = young === undefined ? chain : chain.slice(0, chain.indexOf(young))
  const oldEnd = old.at(-1)?.end ?? 0
  if (!isForced && oldEnd - journal.compacted_end <= journal.compacted_kept) return undefined
  const staging = join(dirname(db.filename), 'compact', session)
  mkdirSync(dirname(staging), { recursive: true })
  const handle = await open(staging, 'w+')
  const chunksBefore = db.query<{ count: number }, []>('select count(*) as count from chunks').get()?.count ?? 0
  let reads = 0
  const reader = chunkReader(relay)
  const read: ChunkReader = (name) => ((reads += 1), reader(name))
  const checking = `${staging}.check`
  try {
    const spans: Span[] = []
    for await (const { frame, bytes, end } of chainOf(relay, chain, 0)) {
      const from = spans.at(-1)?.to ?? 0
      for (let at = 0; at < bytes.length; ) at += (await handle.write(bytes, at, bytes.length - at, from + at)).bytesWritten
      spans.push({ start: frame.start, end, from, to: from + bytes.length, written: frame.written ?? 0 })
    }
    const records = await stagedRecordsOf(handle, spans.at(-1)?.to ?? 0, session)
    const dropped = await droppedOf(handle, records)
    const ends = new Set([0, ...records.map(({ to }) => to)])
    const oldSpans = spans.slice(0, old.length)
    let reach = oldSpans.length
    while (reach > 0 && !ends.has(oldSpans[reach - 1]?.to ?? 0)) reach -= 1
    const prefixEnd = oldSpans[reach - 1]?.to ?? 0
    const inPrefix = records.findIndex(({ to }) => to > prefixEnd)
    const count = inPrefix < 0 ? records.length : inPrefix
    const readsChunks = await everyMachineReadsChunks(capture)
    const { replaced, folded } = readsChunks ? await foldsOf(capture, handle, records, dropped, count, read) : { replaced: new Map<number, Replacement>(), folded: new Set<number>() }
    const gone = new Set([...[...dropped].filter((index) => index < count), ...folded])
    const keptOf = (index: number): number => {
      const record = records[index]
      const replacement = replaced.get(index)
      if (record === undefined || gone.has(index)) return 0
      return replacement === undefined ? record.to - record.from + representedOf(record.header) : replacement.body.length + representedOf(replacement.header)
    }
    const written: { readonly name: string; readonly body: Uint8Array; readonly changed: readonly Replacement[] }[] = []
    let kept = 0
    const groups = groupsOf(oldSpans.slice(0, reach), records, gone, ends)
    async function* newPrefix(): AsyncGenerator<Uint8Array> {
      for (const group of groups) {
        const [first] = group.spans
        const last = group.spans.at(-1)
        kept += group.records.reduce((total, index) => total + keptOf(index), 0)
        if (first === undefined || last === undefined) continue
        if (!group.records.some((index) => gone.has(index) || replaced.has(index))) {
          yield* stagedRange(handle, first.from, last.to)
          continue
        }
        const parts: Uint8Array[] = []
        for (const index of group.records) {
          const record = records[index]
          const replacement = replaced.get(index)
          if (record === undefined || gone.has(index)) continue
          parts.push(...(replacement === undefined ? [await stagedBytes(handle, [record])] : encodeRecord(replacement.header, replacement.body)))
        }
        const body = Buffer.concat(parts)
        yield body
        const after = readsChunks ? 1 + Math.max(...group.spans.map(({ written: was }) => was)) : undefined
        written.push({ name: compactedName(first.start, last.end, after), body: await compressSealed(body), changed: group.records.flatMap((index) => replaced.get(index) ?? []) })
      }
    }
    const before = await fileStatesOf(capture, session, join(checking, 'before'), stagedRange(handle, 0, prefixEnd))
    const after = await fileStatesOf(capture, session, join(checking, 'after'), newPrefix())
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(path) !== after.get(path)) throw new Error(`The rewrite of ${session}'s journal replays ${path} as ${after.get(path) ?? 'nothing'}, not the ${before.get(path) ?? 'nothing'} its frames give, so anyhost keeps every frame as it was.`)
    }
    const put = async (key: string, bytes: Uint8Array): Promise<'written' | 'held' | 'other'> => {
      const answer = await relay.runOne({ op: 'put', key, bytes, if: { none: '*' }, holder: session })
      if (answer.status === 200) return 'written'
      if (answer.status === 409) {
        releasedTo(capture, session, answer.holder, `${new Date().toISOString()} ${answer.holder.name} took the session ${session} over, so ${device.name} stops capturing it.`, tool)
        return 'held'
      }
      const there = await relay.runOne({ op: 'get', key })
      return there.status === 200 && sameBytes(there.bytes, bytes) ? 'written' : 'other'
    }
    for (const { name, body } of written) if ((await put(`${nextPrefix(session)}${name}`, body)) !== 'written') return undefined
    const check = chunkReader(relay)
    for (const { name, body, changed } of written) {
      const key = `${nextPrefix(session)}${name}`
      const got = await relay.runOne({ op: 'get', key })
      if (got.status !== 200 || !sameBytes(got.bytes, body)) throw new Error(`${key} does not read back as the frame anyhost wrote, so anyhost keeps every frame of ${session} as it was.`)
      for (const { header } of changed) {
        if (header.chunks === undefined || header.after === null) continue
        const bytes = await bytesOfChunks(check, header)
        if (bytes.length !== header.after.size || sha256(bytes) !== header.after.sha256) throw new Error(`The chunks of ${header.path} in ${key} read back as ${bytes.length} bytes, not the ${header.after.size} its record says, so anyhost keeps every frame of ${session} as it was.`)
      }
    }
    const published: string[] = []
    for (const { name, body } of [...written].reverse()) {
      const outcome = await put(`${journalPrefix(session)}compacted/${name}`, body)
      if (outcome === 'held' || (outcome === 'other' && readsChunks)) break
      if (outcome === 'written') published.push(`${journalPrefix(session)}compacted/${name}`)
    }
    if (written.length > 0) await Promise.all(relay.run([{ op: 'delete', keys: written.map(({ name }) => `${nextPrefix(session)}${name}`), holder: session }]))
    const isWhole = published.length === written.length
    const left = new Set(records.flatMap(({ header }, index) => (gone.has(index) ? [] : [header.path])))
    const goneParts = new Set([...gone].flatMap((index) => records[index]?.header.path ?? []).filter((path) => isCodePart(path) && !left.has(path)))
    if (isWhole && goneParts.size > 0) rmSync(join(dirname(db.filename), 'code', session), { recursive: true, force: true })
    db.transaction(() => {
      if (isWhole) for (const path of goneParts) db.query('delete from files where session = ? and path = ?').run(session, path)
      if (isWhole) db.query('update journals set compacted_end = ?, compacted_kept = ? where session = ?').run(oldEnd, kept, session)
      db.query('update journals set replaced = max(replaced, ?) where session = ?').run(Number(published.length > 0 || stale.length > 0), session)
    })()
    const picked = new Set(framesOf(session, await relay.list(journalPrefix(session))).frames.map(({ key }) => key))
    const stored = (db.query<{ count: number }, []>('select count(*) as count from chunks').get()?.count ?? 0) - chunksBefore
    const isCurrent =
      readsChunks &&
      isWhole &&
      published.every((key) => picked.has(key)) &&
      count === records.length &&
      !records.some((record, index) => record.header.base !== undefined && !gone.has(index) && !replaced.has(index))
    return { isCurrent, ops: 2 + chain.length + reads + stored + 3 * written.length + written.reduce((total, { changed }) => total + changed.reduce((sum, { header }) => sum + (header.chunks?.length ?? 0), 0), 0) }
  } finally {
    await handle.close()
    rmSync(staging, { force: true })
    rmSync(checking, { recursive: true, force: true })
  }
}

export const REWRITE_OPS_PER_DAY = 20_000
const DAY_MS = 86_400_000
const JOURNALS_EVERY_MS = 60 * 60_000
const HELD = "stopped = '' and holder = '' and end > 0"

export async function journalsIn(relay: Relay): Promise<Map<string, boolean>> {
  const isRewritten = new Map<string, boolean>()
  let cursor: string | undefined
  do {
    const answer = await relay.runOne({ op: 'list', prefix: 'journals/', ...(cursor === undefined ? {} : { cursor }) })
    for (const { key } of answer.objects) {
      const session = key.split('/')[1] ?? ''
      isRewritten.set(session, isRewritten.get(session) === true || key === rewrittenKey(session))
    }
    cursor = answer.cursor
  } while (cursor !== undefined)
  return isRewritten
}

async function markRewritten(capture: Capture, session: string): Promise<void> {
  await capture.relay.runOne({ op: 'put', key: rewrittenKey(session), bytes: new Uint8Array(), if: { none: '*' } })
  capture.journalsInR2.isRewritten.set(session, true)
}

async function readJournalsInR2(capture: Capture, now: number): Promise<void> {
  if (now - capture.journalsInR2.readAt < JOURNALS_EVERY_MS) return
  capture.journalsInR2 = { readAt: now, isRewritten: await journalsIn(capture.relay) }
  for (const { session } of capture.db.query<{ session: string }, []>('select session from rewrites where done = 1').all()) {
    if (capture.journalsInR2.isRewritten.get(session) === false) await markRewritten(capture, session)
  }
}

async function giveBack(capture: Capture): Promise<void> {
  const { db, relay } = capture
  for (const { session } of db.query<{ session: string }, []>('select session from borrowed_claims').all()) {
    if (db.query('select 1 from borrowed_claims where session = ?').get(session) === null) continue
    await relay.runOne({ op: 'forget', session })
    db.query('delete from borrowed_claims where session = ?').run(session)
  }
}

type NextRewrite = { readonly session: string; readonly tool: Tool | undefined; readonly claim?: Extract<Call, { readonly op: 'claim' }> }

async function unheldNext(capture: Capture, now: number): Promise<NextRewrite | undefined> {
  const { db, device, fleet } = capture
  const captured = new Set(db.query<{ session: string }, []>("select session from journals where stopped = ''").all().map(({ session }) => session))
  const tried = new Set(db.query<{ session: string }, [number]>('select session from rewrites where done = 1 or at > ?').all(now - DAY_MS).map(({ session }) => session))
  const holders = await capture.holders.current()
  for (const [session, isRewritten] of capture.journalsInR2.isRewritten) {
    if (isRewritten || captured.has(session) || tried.has(session)) continue
    const holder = holders.get(session)
    const tool = db.query<{ tool: Tool }, [string]>('select tool from sessions where id = ?').get(session)?.tool
    if (holder === device.id) return { session, tool }
    if (holder === undefined) return { session, tool, claim: { op: 'claim', session, take: false } }
    if (fleet.removed.has(holder)) return { session, tool, claim: { op: 'claim', session, take: true, if: { gone: true } } }
  }
  return undefined
}

export async function rewriteNext(capture: Capture, problems: Problems, now = Date.now()): Promise<string | undefined> {
  const { db, relay } = capture
  await readJournalsInR2(capture, now).then(
    () => problems.clear('rewrite list'),
    (error: unknown) => problems.set('rewrite list', error),
  )
  const spent = db.query<{ ops: number }, [number]>('select coalesce(sum(ops), 0) as ops from rewrites where at > ?').get(now - DAY_MS)?.ops ?? 0
  if (spent >= REWRITE_OPS_PER_DAY || !(await everyMachineReadsChunks(capture, now))) return undefined
  const isGivenBack = await giveBack(capture).then(
    () => (problems.clear('borrowed claims'), true),
    (error: unknown) => (problems.set('borrowed claims', error), false),
  )
  if (!isGivenBack) return undefined
  const held = db
    .query<{ session: string; tool: Tool }, [number]>(`select session, tool from journals where ${HELD} and end = sealed and session not in (select session from rewrites where done = 1 or at > ?) order by written_at limit 1`)
    .get(now - DAY_MS)
  const next: NextRewrite | undefined = held ?? (await unheldNext(capture, now))
  if (next === undefined) return undefined
  const { session, tool, claim } = next
  const record = (done: boolean, ops: number, failure: string): void =>
    void db.query('insert or replace into rewrites (session, done, at, ops, failure) values (?, ?, ?, ?, ?)').run(session, Number(done), now, ops, failure)
  record(false, 1, `The rewrite of ${session}'s journal that started at ${new Date(now).toISOString()} never finished, as the program stopped during it.`)
  try {
    if (claim !== undefined) {
      const claiming = relay.runOne(claim)
      db.query('insert or replace into borrowed_claims (session) values (?)').run(session)
      const claimed = await claiming
      if (claimed.status === 409) {
        db.query('delete from borrowed_claims where session = ?').run(session)
        record(false, 1, `${claimed.holder.name} holds the session ${session}, so it rewrites the journal itself.`)
        return session
      }
    }
    const rewritten = await rewriteJournal(capture, session, tool, now, { lagMs: 0, isForced: true })
    if (rewritten === undefined) {
      db.query('delete from rewrites where session = ?').run(session)
      return undefined
    }
    if (claim !== undefined) await deleteReplacedWhileBorrowed(capture, session)
    if (rewritten.isCurrent) await markRewritten(capture, session)
    const failure = rewritten.isCurrent ? '' : `A record of ${session}'s journal still names a base whose file does not replay to its record's sha256, so anyhost keeps it as it is.`
    record(rewritten.isCurrent, rewritten.ops + 1 + (claim === undefined ? 0 : 4), failure)
    if (failure === '') problems.clear(`rewrite ${session}`)
    else problems.set(`rewrite ${session}`, failure)
  } catch (error) {
    record(false, 1, error instanceof Error ? error.message : String(error))
    problems.set(`rewrite ${session}`, error)
  } finally {
    if (claim !== undefined) await giveBack(capture).catch((error: unknown) => problems.set('borrowed claims', error))
  }
  return session
}

export function rewriteProgress(capture: Capture): { readonly done: number; readonly journals: number; readonly olderMachines: readonly string[] } | undefined {
  const { readAt, isRewritten } = capture.journalsInR2
  if (readAt === 0) return undefined
  return { done: [...isRewritten.values()].filter(Boolean).length, journals: isRewritten.size, olderMachines: capture.fleet.older }
}

export async function checkoutOf(cwd: string): Promise<{ repo: string; folder: string }> {
  const git = async (...args: string[]): Promise<string> => {
    const child = Bun.spawn(['git', '-C', cwd, ...args], { env: process.env, stdout: 'pipe', stderr: 'ignore' })
    const output = await new Response(child.stdout).text()
    return (await child.exited) === 0 ? output.trim() : ''
  }
  if (cwd === '' || !(await stat(cwd).then((found) => found.isDirectory(), () => false))) return { repo: '', folder: '' }
  const repo = await git('remote', 'get-url', 'origin')
  return { repo, folder: repo === '' ? '' : (await git('rev-parse', '--show-prefix')).replace(/\/$/, '') }
}

function sessionRow(db: Database, id: string, tool: Tool): SessionRow {
  return (
    db.query<SessionRow, [string]>('select * from sessions where id = ?').get(id) ?? {
      id, tool, title: '', title_rank: 0, first_prompt: '', cwd: '', repo: '', repo_folder: '', entrypoint: '', last_said: '', last_activity: '', last_prompt_at: '', source: '', size: 0,
    }
  )
}

export async function recordSummary(capture: Pick<Capture, 'db' | 'roots'>, id: string, tool: Tool, texts: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>, size: number, writtenAt: string): Promise<boolean> {
  const { db } = capture
  const row = sessionRow(db, id, tool)
  let after: Summary = { title: row.title, titleRank: row.title_rank, firstPrompt: row.first_prompt, cwd: row.cwd, repo: tool === 'codex' ? row.repo : '', entrypoint: row.entrypoint, lastSaid: row.last_said, lastActivity: row.last_activity, lastPromptAt: row.last_prompt_at, source: row.source }
  for await (const text of texts) after = summarize(after, text, tool)
  const lastActivity = after.lastActivity || writtenAt
  const checkout = after.cwd === row.cwd && row.last_activity !== '' ? { repo: row.repo, folder: row.repo_folder } : await checkoutOf(after.cwd)
  const title = (tool === 'codex' ? await codexNameOf(id, capture.roots.codexHome) : undefined) ?? after.title
  const repo = checkout.repo || after.repo
  db.query(
    `insert into sessions (id, tool, title, title_rank, first_prompt, cwd, repo, repo_folder, entrypoint, last_said, last_activity, last_prompt_at, source, size) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do update set title = excluded.title, title_rank = excluded.title_rank, first_prompt = excluded.first_prompt, cwd = excluded.cwd,
     repo = excluded.repo, repo_folder = excluded.repo_folder, entrypoint = excluded.entrypoint, last_said = excluded.last_said, last_activity = excluded.last_activity,
     last_prompt_at = excluded.last_prompt_at, source = excluded.source, size = excluded.size`,
  ).run(id, tool, title, after.titleRank, after.firstPrompt, after.cwd, repo, checkout.folder, after.entrypoint, after.lastSaid, lastActivity, after.lastPromptAt, after.source, size)
  return row.last_activity === '' || after.cwd !== row.cwd || repo !== row.repo || checkout.folder !== row.repo_folder
}

export async function recordFolder(db: Database, id: string, cwd: string): Promise<boolean> {
  const row = db.query<Pick<SessionRow, 'cwd'>, [string]>('select cwd from sessions where id = ?').get(id)
  if (row === null || cwd === '' || row.cwd === cwd) return false
  const checkout = await checkoutOf(cwd)
  db.query('update sessions set cwd = ?, repo = ?, repo_folder = ? where id = ?').run(cwd, checkout.repo, checkout.folder, id)
  return true
}

const IS_TRANSCRIPT = "files.session = sessions.id and (files.path like '%' || sessions.id || '.jsonl' or files.path like '%' || sessions.id || '.jsonl.zst')"
const TRANSCRIPT_GONE = `(exists (select 1 from files where ${IS_TRANSCRIPT}) and not exists (select 1 from files where ${IS_TRANSCRIPT} and files.sha256 != ''))`

export const isDeleted = (db: Database, session: string): boolean =>
  db.query<{ deleted: number }, [string]>(`select ${TRANSCRIPT_GONE} as deleted from sessions where id = ?`).get(session)?.deleted === 1

function indexOf(db: Database): IndexedSession[] {
  return db
    .query<SessionRow & { deleted: number }, []>(`select *, ${TRANSCRIPT_GONE} as deleted from sessions order by last_activity desc`)
    .all()
    .map((row) => ({
      id: row.id, tool: row.tool, title: row.title, firstPrompt: row.first_prompt, cwd: row.cwd, repo: row.repo, repoFolder: row.repo_folder,
      entrypoint: row.entrypoint, lastSaid: row.last_said, lastActivity: row.last_activity, lastPromptAt: row.last_prompt_at, source: row.source, size: row.size, deleted: row.deleted === 1,
    }))
}

const indexKey = (device: Device): string => `sessions/${device.id}/index.json`

function keptIndexOf(capture: Capture): Promise<readonly IndexedSession[]> {
  capture.keptIndex ??= capture.relay.runOne({ op: 'get', key: indexKey(capture.device) }).then(
    (answer) => ('bytes' in answer ? (JSON.parse(new TextDecoder().decode(answer.bytes)) as IndexedSession[]) : []),
    (error: unknown) => {
      capture.keptIndex = undefined
      throw error
    },
  )
  return capture.keptIndex
}

export async function relistSessions(capture: Capture): Promise<number> {
  const { relay, db } = capture
  const journaled = await journalsIn(relay)
  const rows = new Map(db.query<Pick<SessionRow, 'id' | 'cwd' | 'last_said'> & { readonly titled: number }, []>('select id, cwd, last_said, titled from sessions').all().map((row) => [row.id, row]))
  const kept = new Map((await keptIndexOf(capture)).map((entry) => [entry.id, entry]))
  let relisted = 0
  for (const [id, { tool, paths }] of await transcriptsOn(capture.roots)) {
    const row = rows.get(id)
    const entry = kept.get(id)
    if (!journaled.has(id) || (row !== undefined && row.last_said !== '' && row.titled >= TITLE_RULES) || (row ?? entry)?.cwd === '') continue
    if (row === undefined && entry !== undefined) {
      db.query('insert into sessions (id, tool, title, first_prompt, cwd, repo, repo_folder, entrypoint, last_said, last_activity, last_prompt_at, source, size) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        id, tool, entry.title, entry.firstPrompt, entry.cwd, entry.repo, entry.repoFolder, entry.entrypoint ?? '', entry.lastSaid ?? '', entry.lastActivity, entry.lastPromptAt ?? '', entry.source ?? '', entry.size,
      )
    }
    const files = paths.map((path) => ({ path, info: statSync(path) })).sort((a, b) => a.info.mtimeMs - b.info.mtimeMs)
    const text = (await Promise.all(files.map(({ path }) => summaryTextOf(path)))).join('')
    const size = files.reduce((total, { info }) => total + info.size, 0)
    await recordSummary(capture, id, tool, [text], size, new Date(Math.max(...files.map(({ info }) => info.mtimeMs))).toISOString())
    db.query('update sessions set titled = ? where id = ?').run(TITLE_RULES, id)
    if (row === undefined || db.query<Pick<SessionRow, 'last_said'>, [string]>('select last_said from sessions where id = ?').get(id)?.last_said !== '') relisted += 1
  }
  return relisted
}

const SUMMARY_END_BYTES = 1 << 20

const wholeLinesOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes.subarray(0, bytes.lastIndexOf(10) + 1))

const endsTextOf = (head: Uint8Array, tail: Uint8Array): string => `${wholeLinesOf(head)}${wholeLinesOf(tail.subarray(tail.indexOf(10) + 1))}`

export async function summaryTextOf(path: string): Promise<string> {
  if (path.endsWith('.zst')) return await zstdSummaryTextOf(createReadStream(path), path)
  const file = Bun.file(path)
  if (file.size <= SUMMARY_END_BYTES) return wholeLinesOf(await file.bytes())
  return endsTextOf(await file.slice(0, SUMMARY_END_BYTES).bytes(), await file.slice(file.size - SUMMARY_END_BYTES).bytes())
}

async function zstdSummaryTextOf(compressed: Readable, path: string): Promise<string> {
  let head = new Uint8Array()
  const tail: Uint8Array[] = []
  let [tailBytes, size] = [0, 0]
  try {
    for await (const chunk of compressed.pipe(zlib.createZstdDecompress({ params: { [C.ZSTD_d_windowLogMax]: 27 } })) as AsyncIterable<Uint8Array>) {
      if (head.length < SUMMARY_END_BYTES) head = Buffer.concat([head, chunk.subarray(0, SUMMARY_END_BYTES - head.length)])
      tail.push(chunk)
      ;[tailBytes, size] = [tailBytes + chunk.length, size + chunk.length]
      for (let first = tail[0]; first !== undefined && tailBytes - first.length >= SUMMARY_END_BYTES; first = tail[0]) tailBytes -= tail.shift()?.length ?? 0
    }
  } catch (error) {
    console.error(`${new Date().toISOString()} anyhost summarizes nothing of ${path}, as its zstd frame does not decompress: ${error instanceof Error ? error.message : String(error)}`)
    return ''
  } finally {
    compressed.destroy()
  }
  if (size <= SUMMARY_END_BYTES) return wholeLinesOf(head)
  const last = Buffer.concat(tail)
  return endsTextOf(head, last.subarray(last.length - SUMMARY_END_BYTES))
}

export async function ownIndex(capture: Capture): Promise<IndexedSession[]> {
  const here = indexOf(capture.db)
  const ids = new Set(here.map(({ id }) => id))
  const kept = (await keptIndexOf(capture)).filter(({ id }) => !ids.has(id))
  return [...here, ...kept].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
}

export async function writeIndex(capture: Capture): Promise<void> {
  const index = JSON.stringify(await ownIndex(capture))
  if (index === capture.lastIndex) return
  await capture.relay.runOne({ op: 'put', key: indexKey(capture.device), bytes: new TextEncoder().encode(index) })
  capture.lastIndex = index
}
