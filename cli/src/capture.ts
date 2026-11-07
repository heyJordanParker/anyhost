// A session's journal: every byte any of its files gained, in the order this machine uploaded them, shared by every
// machine that holds the session in turn. A record is a header line `{"device","path","at","size","after"}` and then
// `size` bytes: replaying it makes the file at `path` its first `at` bytes followed by the record's bytes, which covers
// appends, write-once files and rewrites. `after` is the size and sha256 of the file as its writer had it after the
// record, which restore checks. Each upload is one independent zstd frame at its journal position.
//   journals/<session>/hot/<start>.zst            one upload, written with If-None-Match: one writer wins each position
//   journals/<session>/sealed/<start>-<end>.zst   the hot frames of a quiet session, up to 64 MiB each, never rewritten
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, rmSync, statSync, type Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { MAX_KEYS, MAX_MESSAGE_BYTES, MAX_OPS, type Listed } from '../../relay/protocol.ts'
import { captureCode, restoreCode, type CodeCapture } from './code.ts'
import { devicesOf, stateFolder, type Device, type MachineRoots } from './device.ts'
import type { Call, RanOf, Relay } from './relay.ts'
import { codexNameOf, codexState, filesOf, linesFiles, namedIn, ownerOf, summarize, type Summary, type Tool } from './transcript.ts'

export const FRAME_BYTES = 64 * 2 ** 20
// At `uploadEvery` 0 a drain that carries a file's change carries no code, and a drain of code puts up to
// CODE_PIECES frames of at most CODE_PIECE_BYTES each at once, so a line written meanwhile waits for one batch. From a
// test machine whose link takes about 1.2 MB/s, a batch of 4 pieces of 128 KiB takes about 0.6 s: code catches up 2 to 3
// times as fast as one piece at a time, and a line still reaches R2 within about 1 s while the session commits. 8
// pieces fill the link, and lines wait past 2 s.
export const CODE_PIECE_BYTES = 128 * 2 ** 10
export const CODE_PIECES = 4
// A session written within QUIET_MS is active: the backup checks its files every minute, and seals it once it is not.
export const QUIET_MS = 10 * 60_000
// The full sweep yields to the program's other work every SWEEP_BATCH files: a stat of the Architect's Mac's 40,898
// captured files took 0.21 s of CPU in the program's thread, so a batch holds a prompt's check for about 5 ms.
const SWEEP_BATCH = 1000
// A seal that fetched 1110 frames at once held every connection the machine had, so every upload on it timed out
// connecting once a minute. Requests of up to MAX_MESSAGE_BYTES of frames go at most this many ahead of the one read.
const REQUESTS_AHEAD = 16
const TAIL_BYTES = 32
const SCHEMA = 2

export type IndexedSession = {
  readonly id: string
  readonly tool: Tool
  readonly title: string
  readonly firstPrompt: string
  readonly cwd: string
  readonly repo: string
  readonly repoFolder: string
  readonly entrypoint: string
  readonly lastActivity: string
  readonly size: number
}
// The working folder's code, from `code.ts`: a header, and parts each stored once at `anyhost:code/<session>/parts/<sha256>`.
export type Code = { readonly captureCode: typeof captureCode; readonly restoreCode: typeof restoreCode }
// `onCode` hears that a session's code waits in `codeWaiting` for the session's next drains, which put it in frames after
// the files', so no drain waits on git. `codeRuns` holds the one `captureCode` running per session. A session in
// `codeStale` changed while its code was read or went up, so its code is read again once that ends. `claimed` holds
// the sessions this program claimed since it started, so a takeover tells this machine of each one it captures.
// `lastIndex` is the index.json this program last put, which `writeIndex` puts again only once it changed.
export type Capture = Code & {
  readonly relay: Relay
  readonly db: Database
  readonly device: Device
  readonly roots: MachineRoots
  readonly hashers: Map<string, Bun.CryptoHasher>
  readonly codeRuns: Map<string, Promise<void>>
  readonly codeWaiting: Map<string, { readonly folder: string; readonly code: CodeCapture }>
  readonly codeStale: Set<string>
  readonly claimed: Set<string>
  // the working folders found missing, each logged once
  readonly missingFolders: Set<string>
  readonly onCode: (session: string, tool: Tool, folder: string) => void
  lastIndex: string
}
export type Problems = { set(key: string, error: unknown): void; clear(key: string): void }
// `after` is null on a deletion record: the file is gone from its writer's machine.
export type RecordHeader = { readonly device: string; readonly path: string; readonly at: number; readonly size: number; readonly after: { readonly size: number; readonly sha256: string } | null }
export type Frame = { readonly key: string; readonly start: number; readonly end?: number; readonly size: number }
// A file of a session as this machine last uploaded it: `journalSize` bytes of the journal's file stand for the first
// `localSize` bytes of the local file, which differ when a restore rewrote the writer's paths into this machine's.
export type FileState = { readonly session: string; readonly path: string; readonly journalSize: number; readonly localSize: number; readonly tail: Uint8Array; readonly sha256: string; readonly mtime: number }
// `stopped` says why this machine captures nothing of the session: another machine took it over or took its next
// position, or a restore is placing its files. Empty while it captures. `holder` names the machine that holds it when
// another one does, which the program answers each prompt with, so no prompt waits on the relay.
export type Journal = { readonly session: string; readonly tool: Tool; readonly end: number; readonly sealed: number; readonly writtenAt: number; readonly stopped: string; readonly holder: string }

type FileRow = { session: string; path: string; journal_size: number; local_size: number; tail: Uint8Array; sha256: string; mtime: number }
type JournalRow = { session: string; tool: Tool; end: number; sealed: number; written_at: number; stopped: string; holder: string }
type SessionRow = { id: string; tool: Tool; title: string; title_rank: number; first_prompt: string; cwd: string; repo: string; repo_folder: string; entrypoint: string; last_activity: string; size: number }
type Source = { readonly size: number; readonly mtime: number; read(from: number, to: number): Promise<Uint8Array> }
type Change = { readonly header: RecordHeader; readonly bytes: Uint8Array; readonly state: FileState; readonly hasher: Bun.CryptoHasher; readonly isPartial: boolean }

// The database of what this machine uploaded to the bucket its relay names. anyhost 0.1 kept per-device segment
// offsets here, which the journal has no use for, so a database of another version starts over, as does the record of
// code parts in the state folder's `code/`.
export function openDatabase(folder = stateFolder()): Database {
  mkdirSync(folder, { recursive: true })
  const db = new Database(join(folder, 'anyhost.db'))
  db.run('pragma journal_mode = wal')
  db.run('pragma busy_timeout = 5000')
  db.run('create table if not exists bucket (name text not null)')
  if (db.query<{ user_version: number }, []>('pragma user_version').get()?.user_version !== SCHEMA) startOver(db)
  makeTables(db)
  return db
}

function startOver(db: Database): void {
  for (const table of ['files', 'sessions', 'journals', 'line_offsets']) db.run(`drop table if exists ${table}`)
  rmSync(join(dirname(db.filename), 'code'), { recursive: true, force: true })
  db.run(`pragma user_version = ${SCHEMA}`)
}

function makeTables(db: Database): void {
  // `untold` names the machine that held the session before this one took it and that the relay could not reach
  db.run(`create table if not exists journals (
    session text primary key, tool text not null, end integer not null default 0, sealed integer not null default 0,
    written_at integer not null default 0, stopped text not null default '', holder text not null default '', untold text not null default '')`)
  for (const column of ['holder', 'untold']) {
    if (db.query<{ name: string }, [string]>("select name from pragma_table_info('journals') where name = ?").get(column) === null) db.run(`alter table journals add column ${column} text not null default ''`)
  }
  db.run(`create table if not exists files (
    session text not null, path text not null, journal_size integer not null default 0, local_size integer not null default 0,
    tail blob not null default x'', sha256 text not null default '', mtime integer not null default 0, primary key (session, path))`)
  db.run('create index if not exists files_by_path on files (path)')
  db.run('create table if not exists line_offsets (path text primary key, offset integer not null)')
  db.run(`create table if not exists sessions (
    id text primary key, tool text not null, title text not null default '', title_rank integer not null default 0, first_prompt text not null default '',
    cwd text not null default '', repo text not null default '', repo_folder text not null default '', entrypoint text not null default '',
    last_activity text not null default '', size integer not null default 0)`)
}

// The bucket the database counts. A database from before the bucket was kept counts the first one its relay names.
export const countedBucket = (db: Database): string | undefined => db.query<{ name: string }, []>('select name from bucket').get()?.name

// The journals' ends and the code parts uploaded count what one bucket holds, so a relay that names another bucket
// than the database counts, as after a machine joined another person's relay, starts the database over.
function useBucket(db: Database, bucket: string): void {
  if (countedBucket(db) === bucket) return
  if (countedBucket(db) !== undefined) {
    startOver(db)
    makeTables(db)
  }
  db.transaction(() => {
    db.run('delete from bucket')
    db.query('insert into bucket (name) values (?)').run(bucket)
  })()
}

// What the relay tells this machine goes into its database at once: the bucket the welcome names, and each session
// another machine took, whether the welcome brings it from the time this machine was away or it comes as it happens.
export function openCapture(
  relay: Relay,
  device: Device,
  roots: MachineRoots,
  db = openDatabase(),
  code: Code = { captureCode, restoreCode },
  onCode: Capture['onCode'] = () => undefined,
): Capture {
  const released = ({ session, to, at }: { readonly session: string; readonly to: { readonly name: string }; readonly at: string }): void =>
    holdElsewhere(db, session, to.name, `${at} ${to.name} took the session ${session} over, so ${device.name} stops capturing it.`)
  relay.on('welcome', ({ bucket, waiting }) => {
    useBucket(db, bucket)
    for (const message of waiting) released(message)
  })
  relay.on('released', released)
  return { ...code, relay, db, device, roots, hashers: new Map(), codeRuns: new Map(), codeWaiting: new Map(), codeStale: new Set(), claimed: new Set(), missingFolders: new Set(), onCode, lastIndex: '' }
}

// A path that names a code part is no file on any machine: restore hands it to `restoreCode` instead of placing it.
export const isCodePart = (path: string): boolean => path.startsWith('anyhost:code/')

const position = (at: number): string => String(at).padStart(16, '0')
export const journalPrefix = (session: string): string => `journals/${session}/`
export const hotKey = (session: string, start: number): string => `${journalPrefix(session)}hot/${position(start)}.zst`
export const sealedKey = (session: string, start: number, end: number): string => `${journalPrefix(session)}sealed/${position(start)}-${position(end)}.zst`

const C = zlib.constants
// Every frame carries zstd's content checksum, so a damaged frame fails to decode instead of placing wrong bytes.
export const compressHot = (body: Uint8Array): Uint8Array => zlib.zstdCompressSync(body, { params: { [C.ZSTD_c_compressionLevel]: 3, [C.ZSTD_c_checksumFlag]: 1 } })
// A sealed frame compresses on libuv's thread pool: 64 MiB of transcript took 7.5 s at level 9 on the Architect's Mac,
// and the program answers each prompt's /claims ask meanwhile.
const zstdCompress = promisify(zlib.zstdCompress)
const compressSealed = (body: Uint8Array): Promise<Uint8Array> =>
  zstdCompress(body, { params: { [C.ZSTD_c_compressionLevel]: 9, [C.ZSTD_c_windowLog]: 27, [C.ZSTD_c_enableLongDistanceMatching]: 1, [C.ZSTD_c_checksumFlag]: 1 } })
export const decompress = (frame: Uint8Array): Uint8Array => zlib.zstdDecompressSync(frame, { params: { [C.ZSTD_d_windowLogMax]: 27 } })

export const encodeRecord = (header: RecordHeader, bytes: Uint8Array): Uint8Array[] => [new TextEncoder().encode(`${JSON.stringify(header)}\n`), bytes]

// The frames a restore reads, in journal order: the longest chain of sealed frames from byte 0, then the hot frames
// after it by position. A hot frame ends where its bytes do, and the journal goes on only from a frame that starts
// there. `stale` are hot frames a seal already holds, which it deletes.
export function framesOf(session: string, listed: readonly Listed[]): { readonly frames: Frame[]; readonly sealedEnd: number; readonly stale: string[] } {
  const sealed: Required<Frame>[] = []
  const hot: Frame[] = []
  for (const { key, size } of listed) {
    const rest = key.slice(journalPrefix(session).length)
    const range = /^sealed\/(\d+)-(\d+)\.zst$/.exec(rest)
    if (range !== null) sealed.push({ key, start: Number(range[1]), end: Number(range[2]), size })
    const start = /^hot\/(\d+)\.zst$/.exec(rest)?.[1]
    if (start !== undefined) hot.push({ key, start: Number(start), size })
  }
  const frames: Frame[] = []
  let sealedEnd = 0
  for (;;) {
    const next = sealed.filter((frame) => frame.start === sealedEnd).sort((a, b) => b.end - a.end)[0]
    if (next === undefined) break
    frames.push(next)
    sealedEnd = next.end
  }
  frames.push(...hot.filter((frame) => frame.start >= sealedEnd).sort((a, b) => a.start - b.start))
  return { frames, sealedEnd, stale: hot.filter((frame) => frame.start < sealedEnd).map(({ key }) => key) }
}

// The journal's chain from `from`, in order: each frame starts where the one before it ends. A frame off the chain is
// one its writer put up while an earlier one failed and never counted, which it writes over later, so the chain skips
// it and ends at the first position no frame holds. Frames of up to MAX_MESSAGE_BYTES together come in one request, a
// larger frame by HTTP alone, at most REQUESTS_AHEAD requests ahead of the frame read, so a journal of thousands of
// frames holds neither every connection nor every frame in memory at once.
export async function* chainOf(relay: Relay, frames: readonly Frame[], from: number): AsyncGenerator<{ readonly frame: Frame; readonly bytes: Uint8Array }> {
  const requests: Frame[][] = []
  const requestOf: number[] = []
  let bytes = 0
  for (const frame of frames) {
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
  let end = from
  for (const [index, frame] of frames.entries()) {
    if (frame.start > end) break
    if (frame.start < end) continue
    const request = requestOf[index] ?? 0
    for (let ahead = request; ahead < Math.min(requests.length, request + REQUESTS_AHEAD); ahead += 1) void fetchRequest(ahead).catch(() => undefined)
    const fetched = await fetchRequest(request)
    const frameBytes = fetched.get(frame.key)
    // each frame's bytes are taken once, and a chain holds no frame twice
    if (frameBytes === undefined) throw new Error(`The journal's chain holds ${frame.key} twice.`)
    const bytes = decompress(frameBytes)
    fetched.delete(frame.key)
    if (frame.end !== undefined && frame.start + bytes.length !== frame.end) throw new Error(`${frame.key} holds ${bytes.length} bytes, not the ${frame.end - frame.start} its name says.`)
    yield { frame, bytes }
    end = frame.start + bytes.length
  }
}

const journalRow = (db: Database, session: string): JournalRow | null => db.query<JournalRow, [string]>('select * from journals where session = ?').get(session)
const fileRow = (db: Database, session: string, path: string): FileRow | null => db.query<FileRow, [string, string]>('select * from files where session = ? and path = ?').get(session, path)

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

// The machine `holder` holds the session now: this machine captures nothing more of it, and each prompt the session
// takes here is refused with that machine's name. The relay's `released` names a session this machine may never have
// captured, which counts as Claude Code's.
export function holdElsewhere(db: Database, session: string, holder: string, reason: string, tool: Tool = 'claude'): void {
  db.query(`insert into journals (session, tool, stopped, holder) values (?, ?, ?, ?)
    on conflict (session) do update set stopped = excluded.stopped, holder = excluded.holder`).run(session, tool, reason, holder)
}

// This machine took back a session another machine took a moment ago, as after a move that failed: it captures the
// session again from its own journal's end, and the session's prompts go through.
export function holdHere(db: Database, session: string): void {
  db.query("update journals set stopped = '', holder = '' where session = ?").run(session)
}

// After a restore: this machine continues the journal from its end, with the files it placed.
export function continueJournal(db: Database, journal: Omit<Journal, 'writtenAt' | 'stopped' | 'holder'>, files: readonly FileState[]): void {
  db.transaction(() => {
    db.query(`insert into journals (session, tool, end, sealed, written_at, stopped, holder, untold) values (?, ?, ?, ?, ?, '', '', '')
      on conflict (session) do update set end = excluded.end, sealed = excluded.sealed, written_at = excluded.written_at, stopped = '', holder = '', untold = ''`).run(
      journal.session, journal.tool, journal.end, journal.sealed, Date.now(),
    )
    db.query('delete from files where session = ?').run(journal.session)
    for (const file of files) saveFile(db, file)
  })()
}

// The machine a takeover found with no connection to the relay, which may take one more prompt of the session before
// its next welcome tells it. The program answers it once, to the session the takeover opened, which shows it.
export function markUntold(db: Database, session: string, machine: string): void {
  db.query('update journals set untold = ? where session = ?').run(machine, session)
}

export function takeUntold(db: Database, session: string): string {
  const machine = db.query<{ untold: string }, [string]>('select untold from journals where session = ?').get(session)?.untold ?? ''
  if (machine !== '') db.query("update journals set untold = '' where session = ?").run(session)
  return machine
}

export const journalOf = (db: Database, session: string): Journal | undefined => {
  const row = journalRow(db, session)
  return row === null ? undefined : { session: row.session, tool: row.tool, end: row.end, sealed: row.sealed, writtenAt: row.written_at, stopped: row.stopped, holder: row.holder }
}

// The folder the session works in, as its index entry names it, or '' before its transcript named one.
export const workingFolderOf = (db: Database, session: string): string => db.query<{ cwd: string }, [string]>('select cwd from sessions where id = ?').get(session)?.cwd ?? ''

// The sessions a written file belongs to, among those this machine captures. Lines files name new sessions too.
export async function sessionsOf(capture: Capture, path: string): Promise<{ readonly session: string; readonly tool: Tool }[]> {
  // Codex's database, or its write-ahead log, changed: the sessions a restore placed here whose row anyhost has not read
  // since, so the row Codex makes at its first start on this machine gets its name at once
  const state = codexState(capture.roots)
  if (path.startsWith(state)) {
    return capture.db.query<{ session: string; tool: Tool }, [string]>("select session, tool from files join journals using (session) where path = ? and mtime = 0 and stopped = ''").all(state)
  }
  const owner = ownerOf(path, capture.roots)
  if (owner === undefined) return []
  if ('session' in owner) return [owner]
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

// Lines files start where they end now, so the program never reads the lines written before its first start.
export async function startLineOffsets(capture: Capture): Promise<void> {
  for (const path of linesFiles(capture.roots).keys()) {
    const size = await stat(path).then((found) => found.size, () => 0)
    capture.db.query('insert or ignore into line_offsets (path, offset) values (?, ?)').run(path, size)
  }
}

// A session's view of a lines file: its whole lines naming the session in `key`. A last line still being written waits.
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

// Codex 0.166 names a thread from its row's `name` alone. A restore onto a machine Codex never ran on has no database
// to place the row in, so Codex makes the row at its first start with no name, and names the thread anew after its
// next turn. The name is in the session_index.jsonl line the restore placed, so it goes into the row as soon as Codex
// writes the row, before anyhost reads it.
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
const tailOf = (bytes: Uint8Array): Uint8Array => bytes.slice(Math.max(0, bytes.length - TAIL_BYTES))

async function hasherOf(source: Source, size: number): Promise<Bun.CryptoHasher> {
  const hasher = new Bun.CryptoHasher('sha256')
  for (let at = 0; at < size; at += FRAME_BYTES) hasher.update(await source.read(at, Math.min(size, at + FRAME_BYTES)))
  return hasher
}

// The deletion record of a file the journal holds and this machine no longer has, as a plan `/rewind` took back or a
// task Claude Code deleted. A lines file's view and Codex's row are never deleted: other sessions share their files.
async function deletionOf(capture: Capture, session: string, path: string, row: FileRow | null): Promise<Change | undefined> {
  if (row === null || row.sha256 === '' || linesFiles(capture.roots).has(path) || path === codexState(capture.roots)) return undefined
  if ((await stat(path).catch(() => undefined)) !== undefined) return undefined
  return {
    header: { device: capture.device.id, path, at: 0, size: 0, after: null },
    bytes: new Uint8Array(),
    // the session worked when it deleted the file
    state: { session, path, journalSize: 0, localSize: 0, tail: new Uint8Array(), sha256: '', mtime: Date.now() },
    hasher: new Bun.CryptoHasher('sha256'),
    isPartial: false,
  }
}

// What a file gained since its last record: an append of its new bytes (whole lines of a JSONL file) when it only
// grew, else the whole file. A record reads at most `budget` new bytes of a log, unless one line is longer.
async function changeOf(capture: Capture, session: string, path: string, budget: number): Promise<Change | undefined> {
  const source = await sourceOf(capture, session, path)
  const row = fileRow(capture.db, session, path)
  if (source === undefined) return await deletionOf(capture, session, path, row)
  const known = { journalSize: row?.journal_size ?? 0, localSize: row?.local_size ?? 0, tail: row?.tail ?? new Uint8Array(), sha256: row?.sha256 ?? '' }
  const key = `${session}\0${path}`
  const record = (at: number, bytes: Uint8Array, localSize: number, journalSize: number, hasher: Bun.CryptoHasher, tail: Uint8Array, isPartial: boolean): Change => {
    const sha256 = hasher.copy().digest('hex')
    return {
      header: { device: capture.device.id, path, at, size: bytes.length, after: { size: localSize, sha256 } },
      bytes,
      state: { session, path, journalSize, localSize, tail, sha256, mtime: source.mtime },
      hasher,
      isPartial,
    }
  }
  const touched = (): undefined => void capture.db.query('update files set mtime = ? where session = ? and path = ?').run(source.mtime, session, path)
  // an empty file is a file, as a background command's output before its first line; a session's lines file view is not
  if (source.size === 0 && !linesFiles(capture.roots).has(path)) {
    const empty = new Bun.CryptoHasher('sha256')
    return row !== null && known.sha256 === empty.copy().digest('hex') ? touched() : record(0, new Uint8Array(), 0, 0, empty, new Uint8Array(), false)
  }
  if (isLog(path, capture.roots) && source.size >= known.localSize) {
    if (source.size === known.localSize) return touched()
    const from = Math.max(0, known.localSize - known.tail.length)
    let end = Math.min(source.size, known.localSize + budget)
    let read = await source.read(from, end)
    // a log uploads whole lines only, so no path a restore rewrites straddles two records
    while (read.lastIndexOf(10) < known.localSize - from && end < source.size) {
      end = Math.min(source.size, end + FRAME_BYTES)
      read = await source.read(from, end)
    }
    if (sameBytes(read.subarray(0, known.localSize - from), known.tail)) {
      const gained = read.subarray(known.localSize - from, read.lastIndexOf(10) + 1)
      if (gained.length === 0) return undefined
      // the hash of the bytes already uploaded: kept in memory, else rebuilt from the file once, and either way it must
      // match the last record's, or the file changed before its end and goes up whole
      let hasher = known.localSize === 0 ? new Bun.CryptoHasher('sha256') : capture.hashers.get(key)
      if (hasher !== undefined && known.localSize > 0 && hasher.copy().digest('hex') !== known.sha256) hasher = undefined
      if (hasher === undefined && known.localSize > 0) {
        hasher = await hasherOf(source, known.localSize)
        if (hasher.copy().digest('hex') !== known.sha256) hasher = undefined
      }
      if (hasher !== undefined) {
        const grown = hasher.copy().update(gained)
        const localSize = known.localSize + gained.length
        return record(known.journalSize, gained, localSize, known.journalSize + gained.length, grown, tailOf(read.subarray(0, localSize - from)), end < source.size)
      }
    }
  }
  // the whole file: a new file, a rewrite, or a log whose bytes before the end changed
  const bytes = await source.read(0, source.size)
  const hasher = new Bun.CryptoHasher('sha256').update(bytes)
  if (row !== null && bytes.length === known.localSize && hasher.copy().digest('hex') === known.sha256) return touched()
  const end = isLog(path, capture.roots) ? bytes.lastIndexOf(10) + 1 : bytes.length
  // a log with no whole line yet waits; an empty file of another kind is a file too
  if (end === 0 && isLog(path, capture.roots)) return undefined
  const whole = bytes.subarray(0, end)
  return record(0, whole, end, end, end === bytes.length ? hasher : new Bun.CryptoHasher('sha256').update(whole), tailOf(whole), false)
}

// What one session sends in a drain: its frames from the journal's end, the records each holds, and the paths left.
type Upload = {
  readonly session: string
  readonly tool: Tool
  readonly end: number
  readonly changes: readonly Change[]
  readonly frames: readonly (readonly Change[])[]
  readonly code: { readonly isDone: boolean }
  readonly waiting: { readonly folder: string; readonly code: CodeCapture } | undefined
  readonly left: Set<string>
}

// The paths of one session a drain reads.
export type Changed = { readonly session: string; readonly tool: Tool; readonly paths: ReadonlySet<string> }
// One frame of a drain: its position in the journal, its bytes, the records they hold, and the relay's answer to its put.
type Put = { readonly start: number; readonly body: Uint8Array; readonly records: readonly Change[]; readonly put: Promise<RanOf<'put'>> }

// A drain: every session's frames go up in one request, after each session read what its files gained, and a frame
// over MAX_MESSAGE_BYTES goes by HTTP beside it, so it holds back no other frame. The first drain of a session since
// the program started claims it in the same request, before its frames, so a takeover tells this machine. Answers
// each session with its paths left for the next drain.
export function uploadSessions(capture: Capture, sessions: readonly Changed[], problems: Problems, isEveryWrite = false): (readonly [Changed, Promise<Set<string>>])[] {
  const read = sessions.map((changed) => [changed, readUpload(capture, changed.session, changed.tool, changed.paths, problems, isEveryWrite)] as const)
  const sent = Promise.allSettled(read.map(([, upload]) => upload)).then((all) => {
    const calls: Call[] = []
    const asked: { readonly session: string; readonly claim: number | undefined; readonly frames: readonly (Omit<Put, 'put'> & { readonly call: number })[] }[] = []
    for (const done of all) {
      if (done.status === 'rejected' || done.value instanceof Set) continue
      const { session, end, frames } = done.value
      const claim = capture.claimed.has(session) ? undefined : calls.push({ op: 'claim', session, take: false }) - 1
      let start = end
      const framed = frames.map((records) => {
        const body = Buffer.concat(records.flatMap((record) => encodeRecord(record.header, record.bytes)))
        const frame = { start, body, records, call: calls.push({ op: 'put', key: hotKey(session, start), bytes: compressHot(body), if: { none: '*' }, holder: session }) - 1 }
        start += body.length
        return frame
      })
      asked.push({ session, claim, frames: framed })
    }
    // the relay answers each call in its position, a put's with a put's result
    const answers = capture.relay.run(calls)
    return new Map(
      asked.map(({ session, claim, frames }) => [
        session,
        { claim: claim === undefined ? undefined : (answers[claim] as Promise<RanOf<'claim'>>), puts: frames.map(({ call, ...frame }): Put => ({ ...frame, put: answers[call] as Promise<RanOf<'put'>> })) },
      ]),
    )
  })
  return read.map(([changed, reading]) => [
    changed,
    reading.then(async (upload) => {
      if (upload instanceof Set) return upload
      const answers = (await sent).get(changed.session)
      if (answers === undefined) throw new Error(`The drain sent nothing of the session ${changed.session}.`)
      return await finishUpload(capture, upload, answers, problems)
    }),
  ])
}

// Reads everything a session's files gained since its last upload and its waiting code, as one hot frame at the
// journal's end, or answers the paths left when there is nothing to send. With `isEveryWrite`, at `uploadEvery` 0, the
// files go up alone and the code in drains of its own, several pieces at once. A session another machine holds, or
// whose position another machine took, uploads nothing more.
async function readUpload(capture: Capture, session: string, tool: Tool, paths: ReadonlySet<string>, problems: Problems, isEveryWrite: boolean): Promise<Upload | Set<string>> {
  const { db, roots } = capture
  let journal = journalOf(db, session)
  const work = new Set(paths)
  if (journal === undefined) {
    // the files the session will write to are known before they exist, so the backup stats them
    const files = await filesOf(session, tool, roots)
    rememberFiles(db, session, files)
    for (const path of files) work.add(path)
    journal = { session, tool, end: 0, sealed: 0, writtenAt: 0, stopped: '', holder: '' }
  }
  if (journal.stopped !== '') return new Set()
  if (tool === 'codex') work.add(codexState(roots))
  const changes: Change[] = []
  const left = new Set<string>()
  let budget = FRAME_BYTES
  for (const path of work) {
    // a folder's path ends in `/`: the queue's note that its code waits in codeWaiting
    if (path.endsWith('/')) continue
    if (budget <= 0) {
      left.add(path)
      continue
    }
    // A file that fails to read waits for the backup's next stat of it, so it never holds up the session's other files:
    // within a minute while the session wrote in the last QUIET_MS, else at the hourly sweep of every file.
    const change = await changeOf(capture, session, path, budget).then(
      (found) => (problems.clear(path), found),
      (error: unknown) => void problems.set(path, error),
    )
    if (change === undefined) continue
    changes.push(change)
    budget -= change.bytes.length
    if (change.isPartial) left.add(path)
    if (path.endsWith('.jsonl')) {
      const named = namedIn(new TextDecoder().decode(change.bytes), roots).filter((file) => !work.has(file))
      rememberFiles(db, session, named)
      for (const file of named) work.add(file)
    }
  }
  const waiting = capture.codeWaiting.get(session)
  const code = waiting === undefined || (isEveryWrite && changes.length > 0) ? { frames: [], isDone: false } : codeFrames(capture, session, waiting, isEveryWrite)
  const frames = (isEveryWrite && changes.length > 0 ? [changes] : isEveryWrite ? code.frames : [[...changes, ...code.frames.flat()]]).filter((records) => records.length > 0)
  if (frames.length === 0) return left
  return { session, tool, end: journal.end, changes, frames, code, waiting, left }
}

// Counts what of a session's drain the relay took, and answers the paths left for the next drain.
async function finishUpload(
  capture: Capture,
  upload: Upload,
  answers: { readonly claim: Promise<RanOf<'claim'>> | undefined; readonly puts: readonly Put[] },
  problems: Problems,
): Promise<Set<string>> {
  const { db, roots, relay } = capture
  const { session, tool, changes, code, waiting, left } = upload
  // a claim another machine holds refuses the frames after it too, which say who holds the session
  if ((await answers.claim)?.status === 200) capture.claimed.add(session)
  type Outcome = { readonly frame: Put; readonly isHere: boolean } | { readonly frame: Put; readonly error: unknown }
  const outcomes = await Promise.all(
    answers.puts.map((frame) =>
      frame.put.then((put) => frameWritten(capture, session, tool, frame.start, frame.body, put)).then(
        (isHere): Outcome => ({ frame, isHere }),
        (error: unknown): Outcome => ({ frame, error }),
      ),
    ),
  )
  if (outcomes.some((outcome) => 'isHere' in outcome && !outcome.isHere)) return new Set()
  // The journal counts the frames up to the first that failed. The frames after it are never read, and the next drain
  // writes over them; the code stays in codeWaiting, since captureCode counts every part it returned as written.
  const failure = outcomes.find((outcome) => 'error' in outcome)
  const counted = failure === undefined ? outcomes : outcomes.slice(0, outcomes.indexOf(failure))
  const after = failure === undefined ? [] : outcomes.slice(outcomes.indexOf(failure) + 1).flatMap((outcome) => ('error' in outcome ? [] : [hotKey(session, outcome.frame.start)]))
  if (after.length > 0) await relay.runOne({ op: 'delete', keys: after }).catch(() => undefined)
  const records = counted.flatMap(({ frame }) => frame.records)
  const last = counted.at(-1)?.frame
  const end = last === undefined ? upload.end : last.start + last.body.length
  const transcript = changes.find((change) => {
    const owner = ownerOf(change.header.path, roots)
    return owner !== undefined && 'isTranscript' in owner && owner.isTranscript
  })
  if (counted.length > 0) {
    db.transaction(() => {
      db.query(`insert into journals (session, tool, end, written_at) values (?, ?, ?, ?)
        on conflict (session) do update set end = excluded.end, written_at = excluded.written_at`).run(session, tool, end, Date.now())
      for (const record of records) saveFile(db, record.state)
    })()
    for (const record of records) capture.hashers.set(`${session}\0${record.header.path}`, record.hasher)
  }
  if (failure !== undefined && 'error' in failure) throw failure.error
  // the session's own files say when it last worked; a lines file or Codex's database changes for every session
  const own = changes.filter(({ header }) => !linesFiles(roots).has(header.path) && header.path !== codexState(roots))
  const lastActivity = new Date(own.length === 0 ? Date.now() : Math.max(...own.map((change) => change.state.mtime))).toISOString()
  // a restore finds a new session and its working folder in the index at once, not after the next 60-second backup
  if (await recordSummary(capture, session, tool, transcript === undefined ? '' : new TextDecoder().decode(transcript.bytes), end, lastActivity)) {
    // the files are up, so an index that fails to go up waits for the backup and fails nothing else
    await writeIndex(capture).then(() => problems.clear('index'), (error: unknown) => problems.set('index', error))
  }
  if (waiting !== undefined && !code.isDone) left.add(`${waiting.folder}/`)
  if (code.isDone) capture.codeWaiting.delete(session)
  if (changes.length > 0 || capture.codeStale.has(session)) startCode(capture, session, tool, problems)
  return left
}

// Answers whether a frame put with If-None-Match at its journal position and the session as its holder is there. The
// position holding the same bytes counts as written, as after an answer lost on the way back. This machine's own other
// bytes there went up past a position that failed, or before a crash, and the journal never counted them, so this
// frame replaces them. Another machine's bytes there make this machine's lines a fork, and a session another machine
// holds refuses the frame: either way this machine stops capturing the session.
async function frameWritten(capture: Capture, session: string, tool: Tool, start: number, body: Uint8Array, put: RanOf<'put'>): Promise<boolean> {
  const { relay, db, device } = capture
  const key = hotKey(session, start)
  const heldBy = (holder: string, reason: string): false => {
    holdElsewhere(db, session, holder, reason, tool)
    return false
  }
  let answer = put
  if (answer.status === 412) {
    const there = await relay.runOne({ op: 'get', key })
    const written = there.status === 200 ? decompress(there.bytes) : undefined
    if (written !== undefined && sameBytes(written, body)) return true
    // the frame's first record names the machine that wrote it
    const writer = written === undefined ? undefined : (JSON.parse(new TextDecoder().decode(written.subarray(0, written.indexOf(10)))) as RecordHeader).device
    if (writer === device.id || writer === undefined) {
      await relay.runOne({ op: 'delete', keys: [key] })
      answer = await relay.runOne({ op: 'put', key, bytes: compressHot(body), if: { none: '*' }, holder: session })
    }
    if (answer.status === 412) {
      const fork = `${new Date().toISOString()} Another machine wrote byte ${start} of the session ${session}'s journal first, so ${device.name} stops capturing it, and its lines from here are a fork of the session.`
      console.error(fork)
      const machine = writer === undefined || writer === device.id ? undefined : (await devicesOf(relay)).get(writer)?.name
      if (machine === undefined) stopJournal(db, session, tool, fork)
      return machine === undefined ? false : heldBy(machine, fork)
    }
  }
  if (answer.status === 409) return heldBy(answer.holder.name, `${new Date().toISOString()} ${answer.holder.name} took the session ${session} over, so ${device.name} stops capturing it.`)
  return true
}

// The frames of a session's waiting code this drain sends: what the journal lacks of each part, then the header that
// names the parts once they are all up. At `uploadEvery` 0 that is up to CODE_PIECES frames of a piece each, a part
// longer than a piece going up as appends; at N seconds one frame of up to FRAME_BYTES.
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

// The record of bytes `from` to `to` of a code part or header, which no machine holds as a file. `previous` is the
// record of the part's bytes before `from` in the same drain.
function codeRecord(capture: Capture, session: string, path: string, bytes: Uint8Array, from: number, to: number, previous?: Change): Change {
  // the hash of the bytes before: from the piece before, else kept in memory from the last drain, else hashed again
  const kept = capture.hashers.get(`${session}\0${path}`)
  const known = from === 0 ? undefined : (previous?.hasher ?? (kept?.copy().digest('hex') === fileRow(capture.db, session, path)?.sha256 ? kept : undefined))
  const before = known === undefined ? new Bun.CryptoHasher('sha256').update(bytes.subarray(0, from)) : known.copy()
  const hasher = before.update(bytes.subarray(from, to))
  const sha256 = hasher.copy().digest('hex')
  return {
    header: { device: capture.device.id, path, at: from, size: to - from, after: { size: to, sha256 } },
    bytes: bytes.subarray(from, to),
    state: { session, path, journalSize: to, localSize: to, tail: tailOf(bytes.subarray(0, to)), sha256, mtime: 0 },
    hasher,
    isPartial: false,
  }
}

// Reads the working folder's code after the files' upload, never before it: what changed waits for the next drain. One
// read runs per session, and none while the last one's records still go up; a change meanwhile reads it again after.
// A move reads it once more, for a change nothing the session wrote names.
export function startCode(capture: Capture, session: string, tool: Tool, problems: Problems): void {
  const folder = workingFolderOf(capture.db, session)
  if (folder === '') return
  if (capture.codeRuns.has(session) || capture.codeWaiting.has(session)) {
    capture.codeStale.add(session)
    return
  }
  capture.codeStale.delete(session)
  const run = stat(folder)
    .then(
      (found) => found.isDirectory(),
      () => false,
    )
    .then((isFolder) => {
      if (isFolder) return capture.captureCode(folder, session)
      // a session whose working folder this machine lacks, such as one deleted since, keeps the code it has
      if (!capture.missingFolders.has(folder)) console.error(`${new Date().toISOString()} ${folder} is no folder on ${capture.device.name}, so anyhost keeps no code of the sessions that work in it.`)
      capture.missingFolders.add(folder)
      return undefined
    })
    .then(
      (code) => {
        problems.clear(`code ${folder}`)
        if (code === undefined) return
        capture.codeWaiting.set(session, { folder, code })
        capture.onCode(session, tool, folder)
      },
      (error: unknown) => problems.set(`code ${folder}`, error),
    )
    .finally(() => {
      capture.codeRuns.delete(session)
      // code that waits to go up reads again once it is up
      if (!capture.codeWaiting.has(session) && capture.codeStale.has(session)) startCode(capture, session, tool, problems)
    })
  capture.codeRuns.set(session, run)
}

// A file's stat, or undefined when it is gone or cannot be read, as `stat` rejects.
function statOf(path: string): Stats | undefined {
  try {
    return statSync(path, { throwIfNoEntry: false })
  } catch {
    return undefined
  }
}

// Every file of every session this machine captures and wrote at `writtenSince` or later whose size or modified time
// moved past its last record, or that is gone since its last record: an event the watcher dropped, an upload that
// failed, or a folder the watcher was not on yet. It stats in this thread: 40,898 stats through libuv's thread pool
// took 2.58 s of CPU on the Architect's Mac, and 0.21 s here.
export async function changedFiles(capture: Capture, writtenSince = 0): Promise<Map<string, Set<string>>> {
  const { db, roots } = capture
  const rows = db.query<{ session: string; path: string; local_size: number; mtime: number; sha256: string }, [number]>(
    "select files.session, path, local_size, mtime, sha256 from files join journals using (session) where stopped = '' and written_at >= ?",
  ).all(writtenSince)
  const lines = linesFiles(roots)
  const codex = codexState(roots)
  const changed = new Map<string, Set<string>>()
  for (const [index, { session, path, local_size, mtime, sha256 }] of rows.entries()) {
    if (index % SWEEP_BATCH === SWEEP_BATCH - 1) await new Promise((resolve) => setImmediate(resolve))
    // a code record is no file: a part only the journal holds, or a header at its working folder's path with a `/`
    if (lines.has(path) || path === codex || isCodePart(path) || path.endsWith('/')) continue
    const found = statOf(path)
    const isGone = found === undefined && sha256 !== ''
    if (!isGone && (found === undefined || !found.isFile() || (found.size === local_size && found.mtimeMs === mtime))) continue
    // a file this program captures no more, such as the job record `jobs/<8 hex>/state.json` earlier versions captured
    if (ownerOf(path, roots) === undefined) continue
    changed.set(session, (changed.get(session) ?? new Set()).add(path))
  }
  return changed
}

// Turns a session's hot frames into sealed frames of up to 64 MiB each, then deletes them. The claim holder seals,
// after 10 quiet minutes or before a move. Sealed frames hold whole hot frames, so the journal never splits a
// position another machine may still write at. A seal reaches no further than the journal's end: a frame past it is
// one this machine put up and never counted, as before a crash, which its next upload writes over, so sealing it would
// hide that upload from every restore. Answers where the chain from byte 0 ends, short of the journal's end where R2
// holds no frame at a position this machine counted.
export async function seal(capture: Capture, session: string): Promise<number> {
  const { relay, db } = capture
  const end = journalOf(db, session)?.end ?? 0
  const { frames, sealedEnd, stale } = framesOf(session, await relay.list(journalPrefix(session)))
  const hot = frames.filter((frame) => frame.key.includes('/hot/') && frame.start < end)
  let at = sealedEnd
  let run: Uint8Array[] = []
  let runBytes = 0
  // A sealed frame already there holds these bytes, from a seal that failed before its delete, and counts as written.
  // One that holds other bytes deletes no hot frame.
  const flush = async (): Promise<void> => {
    if (runBytes === 0) return
    const key = sealedKey(session, at, at + runBytes)
    const put = await relay.runOne({ op: 'put', key, bytes: await compressSealed(Buffer.concat(run)), if: { none: '*' } })
    if (put.status !== 200) throw new Error(`The relay answered ${put.status} to the put of ${key}, so anyhost deletes no hot frame of ${session}.`)
    ;[at, run, runBytes] = [at + runBytes, [], 0]
  }
  for await (const { bytes } of chainOf(relay, hot, sealedEnd)) {
    if (runBytes > 0 && runBytes + bytes.length > FRAME_BYTES) await flush()
    run.push(bytes)
    runBytes += bytes.length
  }
  await flush()
  // the chain's frames, the frames off it inside the journal, and the ones after a position R2 lacks, which no restore
  // reads
  const sealed = [...stale, ...hot.map(({ key }) => key)]
  const deletes: Call[] = []
  for (let from = 0; from < sealed.length; from += MAX_KEYS) deletes.push({ op: 'delete', keys: sealed.slice(from, from + MAX_KEYS) })
  await Promise.all(relay.run(deletes))
  return at
}

// The journal goes on from `at`, where its chain in R2 ends, short of the `end` this machine counted, as after R2 lost a
// frame: with every file of the session whole, as a new session's files go up from byte 0, and with every part of its
// code again, since a code header past `at` may name a part only the lost frames held. The warning a takeover left for
// the session's next prompt stays. Answers the session's files, which the caller uploads. A session whose transcript
// is gone here leaves the problem `journal <session>`, which names the span a restore lacks.
function captureAgainFrom(capture: Capture, session: string, tool: Tool, at: number, end: number, problems: Problems): Set<string> {
  const { db, device, roots } = capture
  const paths = db
    .query<{ path: string }, [string]>('select path from files where session = ?')
    .all(session)
    .map(({ path }) => path)
    .filter((path) => !isCodePart(path) && !path.endsWith('/'))
  const untold = db.query<{ untold: string }, [string]>('select untold from journals where session = ?').get(session)?.untold ?? ''
  continueJournal(db, { session, tool, end: at, sealed: at }, paths.map((path) => ({ session, path, journalSize: 0, localSize: 0, tail: new Uint8Array(), sha256: '', mtime: 0 })))
  if (untold !== '') markUntold(db, session, untold)
  rmSync(join(dirname(db.filename), 'code', session), { recursive: true, force: true })
  capture.codeWaiting.delete(session)
  const reached = `The journal of ${session} in R2 reaches byte ${at}, and ${device.name} counted ${end}`
  const hasTranscript = paths.some((path) => {
    const owner = ownerOf(path, roots)
    return owner !== undefined && 'isTranscript' in owner && owner.isTranscript && existsSync(path)
  })
  if (hasTranscript) console.error(`${new Date().toISOString()} ${reached}, so it uploads the session's files whole again from byte ${at}.`)
  else problems.set(`journal ${session}`, `${reached}, and holds no transcript of the session to upload again, so a restore of the session lacks what the journal held from byte ${at}.`)
  return new Set(paths)
}

// Seals the session's journal up to the end this machine counted, which `journals.sealed` then records, and answers no
// file. A journal whose chain in R2 ends short of that end goes on from where the chain ends (`captureAgainFrom`), and
// the answer is the session's files, which the caller uploads whole.
export async function sealJournal(capture: Capture, session: string, tool: Tool, problems: Problems): Promise<Set<string>> {
  const end = journalOf(capture.db, session)?.end ?? 0
  const at = await seal(capture, session)
  if (at !== end) return captureAgainFrom(capture, session, tool, at, end, problems)
  capture.db.query('update journals set sealed = ? where session = ?').run(at, session)
  return new Set()
}

// Seals every session quiet for QUIET_MS that this machine holds. A journal whose chain in R2 ends elsewhere than this
// machine counted goes on from where the chain ends, with every file whole, once, so it is not read again each minute.
// Answers the files of those sessions, for the upload queue.
export async function sealQuiet(capture: Capture, problems: Problems, now = Date.now()): Promise<Map<string, Set<string>>> {
  const { db, relay, device } = capture
  const quiet = db.query<{ session: string; tool: Tool }, [number]>("select session, tool from journals where stopped = '' and end > sealed and written_at < ?").all(now - QUIET_MS)
  const again = new Map<string, Set<string>>()
  for (const { session, tool } of quiet) {
    try {
      // a session another machine holds is that machine's to seal
      const claim = await relay.runOne({ op: 'claim', session, take: false })
      if (claim.status === 409) holdElsewhere(db, session, claim.holder.name, `${new Date().toISOString()} ${claim.holder.name} holds the session ${session}, so ${device.name} stops capturing it.`, tool)
      else {
        const files = await sealJournal(capture, session, tool, problems)
        if (files.size > 0) again.set(session, files)
      }
      problems.clear(`seal ${session}`)
    } catch (error) {
      problems.set(`seal ${session}`, error)
    }
  }
  return again
}

export async function checkoutOf(cwd: string): Promise<{ repo: string; folder: string }> {
  const git = async (...args: string[]): Promise<string> => {
    const child = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'ignore' })
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
      id, tool, title: '', title_rank: 0, first_prompt: '', cwd: '', repo: '', repo_folder: '', entrypoint: '', last_activity: '', size: 0,
    }
  )
}

// Records the session's index entry, and answers whether it is new or moved to another working folder or repository,
// which a restore reads from the index to know where the session goes.
export async function recordSummary(capture: Pick<Capture, 'db' | 'roots'>, id: string, tool: Tool, text: string, size: number, lastActivity: string): Promise<boolean> {
  const { db } = capture
  const row = sessionRow(db, id, tool)
  const before: Summary = { title: row.title, titleRank: row.title_rank, firstPrompt: row.first_prompt, cwd: row.cwd, repo: tool === 'codex' ? row.repo : '', entrypoint: row.entrypoint }
  const after = summarize(before, text, tool)
  const checkout = after.cwd === row.cwd && row.last_activity !== '' ? { repo: row.repo, folder: row.repo_folder } : await checkoutOf(after.cwd)
  const title = (tool === 'codex' ? await codexNameOf(id, capture.roots.codexHome) : undefined) ?? after.title
  const repo = checkout.repo || after.repo
  db.query(
    `insert into sessions (id, tool, title, title_rank, first_prompt, cwd, repo, repo_folder, entrypoint, last_activity, size) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do update set title = excluded.title, title_rank = excluded.title_rank, first_prompt = excluded.first_prompt, cwd = excluded.cwd,
     repo = excluded.repo, repo_folder = excluded.repo_folder, entrypoint = excluded.entrypoint, last_activity = excluded.last_activity, size = excluded.size`,
  ).run(id, tool, title, after.titleRank, after.firstPrompt, after.cwd, repo, checkout.folder, after.entrypoint, lastActivity, size)
  return row.last_activity === '' || after.cwd !== row.cwd || repo !== row.repo || checkout.folder !== row.repo_folder
}

function indexOf(db: Database): IndexedSession[] {
  return db
    .query<SessionRow, []>('select * from sessions order by last_activity desc')
    .all()
    .map((row) => ({
      id: row.id, tool: row.tool, title: row.title, firstPrompt: row.first_prompt, cwd: row.cwd, repo: row.repo, repoFolder: row.repo_folder,
      entrypoint: row.entrypoint, lastActivity: row.last_activity, size: row.size,
    }))
}

// Puts this machine's index.json, once it differs from the one this program last put.
export async function writeIndex(capture: Capture): Promise<void> {
  const index = JSON.stringify(indexOf(capture.db))
  if (index === capture.lastIndex) return
  await capture.relay.runOne({ op: 'put', key: `sessions/${capture.device.id}/index.json`, bytes: new TextEncoder().encode(index) })
  capture.lastIndex = index
}
