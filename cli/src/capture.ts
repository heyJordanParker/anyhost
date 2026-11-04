// A session's journal: every byte any of its files gained, in the order this machine uploaded them, shared by every
// machine that holds the session in turn. A record is a header line `{"device","path","at","size","after"}` and then
// `size` bytes: replaying it makes the file at `path` its first `at` bytes followed by the record's bytes, which covers
// appends, write-once files and rewrites. `after` is the size and sha256 of the file as its writer had it after the
// record, which restore checks. Each upload is one independent zstd frame at its journal position.
//   journals/<session>/hot/<start>.zst            one upload, written with If-None-Match: one writer wins each position
//   journals/<session>/sealed/<start>-<end>.zst   the hot frames of a quiet session, up to 64 MiB each, never rewritten
import { Database } from 'bun:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { claimOf } from './claims.ts'
import { captureCode, restoreCode, type CodeCapture } from './code.ts'
import { devicesOf, stateFolder, type Device, type MachineRoots } from './device.ts'
import type { Listed, Store } from './store.ts'
import { codexNameOf, codexState, filesOf, linesFiles, namedIn, ownerOf, summarize, type Summary, type Tool } from './transcript.ts'

export const FRAME_BYTES = 64 * 2 ** 20
// At `uploadEvery` 0 a drain that carries a file's change carries no code, and a drain of code puts up to
// CODE_PIECES frames of at most CODE_PIECE_BYTES each at once, so a line written meanwhile waits for one batch. From a
// test machine whose link takes about 1.2 MB/s, a batch of 4 pieces of 128 KiB takes about 0.6 s: code catches up 2 to 3
// times as fast as one piece at a time, and a line still reaches R2 within about 1 s while the session commits. 8
// pieces fill the link, and lines wait past 2 s.
export const CODE_PIECE_BYTES = 128 * 2 ** 10
export const CODE_PIECES = 4
const QUIET_MS = 10 * 60_000
const FRAMES_AHEAD = 16
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
// `codeStale` changed while its code was read or went up, so its code is read again once that ends.
export type Capture = Code & {
  readonly store: Store
  readonly db: Database
  readonly device: Device
  readonly roots: MachineRoots
  readonly hashers: Map<string, Bun.CryptoHasher>
  readonly codeRuns: Map<string, Promise<void>>
  readonly codeWaiting: Map<string, { readonly folder: string; readonly code: CodeCapture }>
  readonly codeStale: Set<string>
  // the working folders found missing, each logged once
  readonly missingFolders: Set<string>
  readonly onCode: (session: string, tool: Tool, folder: string) => void
}
export type Problems = { set(key: string, error: unknown): void; clear(key: string): void }
// `after` is null on a deletion record: the file is gone from its writer's machine.
export type RecordHeader = { readonly device: string; readonly path: string; readonly at: number; readonly size: number; readonly after: { readonly size: number; readonly sha256: string } | null }
export type Frame = { readonly key: string; readonly start: number; readonly end?: number }
// A file of a session as this machine last uploaded it: `journalSize` bytes of the journal's file stand for the first
// `localSize` bytes of the local file, which differ when a restore rewrote the writer's paths into this machine's.
export type FileState = { readonly session: string; readonly path: string; readonly journalSize: number; readonly localSize: number; readonly tail: Uint8Array; readonly sha256: string; readonly mtime: number }
// `stopped` says why this machine captures nothing of the session: another machine took it over or took its next
// position, or a restore is placing its files. Empty while it captures. `holder` names the machine that holds it when
// another one does, which the program answers each prompt with, so no prompt waits on R2.
export type Journal = { readonly session: string; readonly tool: Tool; readonly end: number; readonly sealed: number; readonly writtenAt: number; readonly stopped: string; readonly holder: string }

type FileRow = { session: string; path: string; journal_size: number; local_size: number; tail: Uint8Array; sha256: string; mtime: number }
type JournalRow = { session: string; tool: Tool; end: number; sealed: number; written_at: number; stopped: string; holder: string }
type SessionRow = { id: string; tool: Tool; title: string; title_rank: number; first_prompt: string; cwd: string; repo: string; repo_folder: string; entrypoint: string; last_activity: string; size: number }
type Source = { readonly size: number; readonly mtime: number; read(from: number, to: number): Promise<Uint8Array> }
type Change = { readonly header: RecordHeader; readonly bytes: Uint8Array; readonly state: FileState; readonly hasher: Bun.CryptoHasher; readonly isPartial: boolean }

// The database of what this machine uploaded to `bucket`. anyhost 0.1 kept per-device segment offsets here, which the
// journal has no use for, and the journals' ends and the code parts uploaded count what one bucket holds, so a database
// of another version or another bucket starts over, as does the record of code parts. A database from before the
// bucket was kept counts as this bucket's.
export function openDatabase(bucket: string, folder = stateFolder()): Database {
  mkdirSync(folder, { recursive: true })
  const db = new Database(join(folder, 'anyhost.db'))
  db.run('pragma journal_mode = wal')
  db.run('pragma busy_timeout = 5000')
  db.run('create table if not exists bucket (name text not null)')
  const kept = db.query<{ name: string }, []>('select name from bucket').get()?.name ?? bucket
  if (db.query<{ user_version: number }, []>('pragma user_version').get()?.user_version !== SCHEMA || kept !== bucket) {
    for (const table of ['files', 'sessions', 'journals', 'line_offsets']) db.run(`drop table if exists ${table}`)
    rmSync(join(folder, 'code'), { recursive: true, force: true })
    db.run(`pragma user_version = ${SCHEMA}`)
  }
  db.transaction(() => {
    db.run('delete from bucket')
    db.query('insert into bucket (name) values (?)').run(bucket)
  })()
  // `untold` names the machine that held the session before this one took it and that ssh could not reach
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
  return db
}

export const openCapture = (
  store: Store,
  device: Device,
  roots: MachineRoots,
  db = openDatabase(store.bucket),
  code: Code = { captureCode, restoreCode },
  onCode: Capture['onCode'] = () => undefined,
): Capture => ({ ...code, store, db, device, roots, hashers: new Map(), codeRuns: new Map(), codeWaiting: new Map(), codeStale: new Set(), missingFolders: new Set(), onCode })

// A path that names a code part is no file on any machine: restore hands it to `restoreCode` instead of placing it.
export const isCodePart = (path: string): boolean => path.startsWith('anyhost:code/')

const position = (at: number): string => String(at).padStart(16, '0')
export const journalPrefix = (session: string): string => `journals/${session}/`
export const hotKey = (session: string, start: number): string => `${journalPrefix(session)}hot/${position(start)}.zst`
export const sealedKey = (session: string, start: number, end: number): string => `${journalPrefix(session)}sealed/${position(start)}-${position(end)}.zst`

const C = zlib.constants
// Every frame carries zstd's content checksum, so a damaged frame fails to decode instead of placing wrong bytes.
export const compressHot = (body: Uint8Array): Uint8Array => zlib.zstdCompressSync(body, { params: { [C.ZSTD_c_compressionLevel]: 3, [C.ZSTD_c_checksumFlag]: 1 } })
const compressSealed = (body: Uint8Array): Uint8Array =>
  zlib.zstdCompressSync(body, { params: { [C.ZSTD_c_compressionLevel]: 9, [C.ZSTD_c_windowLog]: 27, [C.ZSTD_c_enableLongDistanceMatching]: 1, [C.ZSTD_c_checksumFlag]: 1 } })
export const decompress = (frame: Uint8Array): Uint8Array => zlib.zstdDecompressSync(frame, { params: { [C.ZSTD_d_windowLogMax]: 27 } })

export const encodeRecord = (header: RecordHeader, bytes: Uint8Array): Uint8Array[] => [new TextEncoder().encode(`${JSON.stringify(header)}\n`), bytes]

// The frames a restore reads, in journal order: the longest chain of sealed frames from byte 0, then the hot frames
// after it by position. A hot frame ends where its bytes do, and the journal goes on only from a frame that starts
// there. `stale` are hot frames a seal already holds, which it deletes.
export function framesOf(session: string, listed: readonly Listed[]): { readonly frames: Frame[]; readonly sealedEnd: number; readonly stale: string[] } {
  const sealed: Required<Frame>[] = []
  const hot: Frame[] = []
  for (const { key } of listed) {
    const rest = key.slice(journalPrefix(session).length)
    const range = /^sealed\/(\d+)-(\d+)\.zst$/.exec(rest)
    if (range !== null) sealed.push({ key, start: Number(range[1]), end: Number(range[2]) })
    const start = /^hot\/(\d+)\.zst$/.exec(rest)?.[1]
    if (start !== undefined) hot.push({ key, start: Number(start) })
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
// it and ends at the first position no frame holds. Frames download at most FRAMES_AHEAD ahead of the one read, so a
// journal of thousands of frames holds neither every connection to R2 nor every frame in memory at once.
export async function* chainOf(store: Store, frames: readonly Frame[], from: number): AsyncGenerator<{ readonly frame: Frame; readonly bytes: Uint8Array }> {
  const bodies: Promise<Uint8Array>[] = []
  const fetchFrame = (index: number): Promise<Uint8Array> => {
    const frame = frames[index]
    bodies[index] ??= frame === undefined ? Promise.resolve(new Uint8Array()) : store.get(frame.key).then((found) => found?.body ?? Promise.reject(new Error(`${frame.key} disappeared while anyhost read it.`)))
    return bodies[index]
  }
  let end = from
  for (const [index, frame] of frames.entries()) {
    if (frame.start > end) break
    if (frame.start < end) continue
    for (let ahead = index; ahead < Math.min(frames.length, index + FRAMES_AHEAD); ahead += 1) void fetchFrame(ahead).catch(() => undefined)
    const bytes = decompress(await fetchFrame(index))
    bodies[index] = Promise.resolve(new Uint8Array())
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
// takes here is refused with that machine's name. `anyhost released` runs it for a session this machine may never have
// captured, which counts as Claude Code's.
export function holdElsewhere(db: Database, session: string, holder: string, reason: string, tool: Tool = 'claude'): void {
  db.query(`insert into journals (session, tool, stopped, holder) values (?, ?, ?, ?)
    on conflict (session) do update set stopped = excluded.stopped, holder = excluded.holder`).run(session, tool, reason, holder)
}

// The machine `device` holds the session, by its id from a claim or a journal record.
async function heldBy(capture: Capture, session: string, tool: Tool, device: string, reason: (holder: string) => string): Promise<void> {
  const holder = (await devicesOf(capture.store)).get(device)?.name ?? device
  holdElsewhere(capture.db, session, holder, reason(holder), tool)
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

// The machine a takeover could not reach over ssh, which may take one more prompt of the session before it learns. The
// program answers it once, to the session the takeover opened, which shows it.
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

// Uploads everything a session's files gained since its last upload and its waiting code as one hot frame at the
// journal's end, and answers the paths left for the next drain. With `isEveryWrite`, at `uploadEvery` 0, the files go up
// alone and the code in drains of its own, several pieces at once. A session another machine holds, or whose position
// another machine took, uploads nothing more.
export async function uploadSession(capture: Capture, session: string, tool: Tool, paths: ReadonlySet<string>, problems: Problems, isEveryWrite = false): Promise<Set<string>> {
  const { store, db, device, roots } = capture
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
    // A file that fails to read waits for the 60-second backup, so it never holds up the session's other files.
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
  const held = await claimOf(store, session)
  if (held !== undefined && held.claim.device !== device.id) {
    await heldBy(capture, session, tool, held.claim.device, (holder) => `${new Date().toISOString()} ${holder} took the session ${session} over, so ${device.name} stops capturing it.`)
    return new Set()
  }
  const bodies = frames.map((records) => Buffer.concat(records.flatMap((record) => encodeRecord(record.header, record.bytes))))
  const starts = bodies.map((_, index) => journal.end + bodies.slice(0, index).reduce((total, body) => total + body.length, 0))
  const puts = await Promise.allSettled(bodies.map((body, index) => putFrame(capture, session, tool, starts[index] ?? 0, body)))
  if (puts.some((put) => put.status === 'fulfilled' && !put.value)) return new Set()
  // The journal counts the frames up to the first that failed. The frames after it are never read, and the next drain
  // writes over them; the code stays in codeWaiting, since captureCode counts every part it returned as written.
  const failed = puts.findIndex((put) => put.status === 'rejected')
  const counted = failed < 0 ? frames.length : failed
  if (failed >= 0) await store.delete(puts.slice(failed + 1).flatMap((put, index) => (put.status === 'fulfilled' ? [hotKey(session, starts[failed + 1 + index] ?? 0)] : []))).catch(() => undefined)
  const records = frames.slice(0, counted).flat()
  const end = journal.end + bodies.slice(0, counted).reduce((total, body) => total + body.length, 0)
  const transcript = changes.find((change) => {
    const owner = ownerOf(change.header.path, roots)
    return owner !== undefined && 'isTranscript' in owner && owner.isTranscript
  })
  if (counted > 0) {
    db.transaction(() => {
      db.query(`insert into journals (session, tool, end, written_at) values (?, ?, ?, ?)
        on conflict (session) do update set end = excluded.end, written_at = excluded.written_at`).run(session, tool, end, Date.now())
      for (const record of records) saveFile(db, record.state)
    })()
    for (const record of records) capture.hashers.set(`${session}\0${record.header.path}`, record.hasher)
  }
  const failure = puts[failed]
  if (failure?.status === 'rejected') throw failure.reason
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

// Puts one frame at its journal position and answers whether it is there, written with If-None-Match. The position
// holding the same bytes counts as written, as after an answer lost on the way back. This machine's own other bytes
// there went up past a position that failed, or before a crash, and the journal never counted them, so this frame
// replaces them. Another machine's bytes there make this machine's lines a fork: it stops capturing the session.
async function putFrame(capture: Capture, session: string, tool: Tool, start: number, body: Uint8Array): Promise<boolean> {
  const { store, db, device } = capture
  const key = hotKey(session, start)
  const frame = compressHot(body)
  if ((await store.put(key, frame, { ifNoneMatch: '*' })) !== undefined) return true
  const there = await store.get(key)
  const written = there === undefined ? undefined : decompress(there.body)
  if (written !== undefined && sameBytes(written, body)) return true
  // the frame's first record names the machine that wrote it
  const writer = written === undefined ? undefined : (JSON.parse(new TextDecoder().decode(written.subarray(0, written.indexOf(10)))) as RecordHeader).device
  if (writer === device.id) {
    await store.delete([key])
    if ((await store.put(key, frame, { ifNoneMatch: '*' })) !== undefined) return true
  }
  const fork = `${new Date().toISOString()} Another machine wrote byte ${start} of the session ${session}'s journal first, so ${device.name} stops capturing it, and its lines from here are a fork of the session.`
  if (writer === undefined || writer === device.id) stopJournal(db, session, tool, fork)
  else await heldBy(capture, session, tool, writer, () => fork)
  console.error(fork)
  return false
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
function startCode(capture: Capture, session: string, tool: Tool, problems: Problems): void {
  const folder = capture.db.query<{ cwd: string }, [string]>('select cwd from sessions where id = ?').get(session)?.cwd ?? ''
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

// Every file of every session this machine captures whose size or modified time moved past its last record, or that
// is gone since its last record: an event the watcher dropped, an upload that failed, or a folder the watcher was not
// on yet.
export async function changedFiles(capture: Capture): Promise<Map<string, Set<string>>> {
  const rows = capture.db.query<{ session: string; path: string; local_size: number; mtime: number; sha256: string }, []>(
    "select files.session, path, local_size, mtime, sha256 from files join journals using (session) where stopped = ''",
  ).all()
  const changed = new Map<string, Set<string>>()
  for (const { session, path, local_size, mtime, sha256 } of rows) {
    // a code record is no file: a part only the journal holds, or a header at its working folder's path with a `/`
    if (linesFiles(capture.roots).has(path) || path === codexState(capture.roots) || isCodePart(path) || path.endsWith('/')) continue
    const found = await stat(path).catch(() => undefined)
    const isGone = found === undefined && sha256 !== ''
    if (!isGone && (found === undefined || !found.isFile() || (found.size === local_size && found.mtimeMs === mtime))) continue
    changed.set(session, (changed.get(session) ?? new Set()).add(path))
  }
  return changed
}

// Turns a session's hot frames into sealed frames of up to 64 MiB each, then deletes them. The claim holder seals,
// after 10 quiet minutes or before a move. Sealed frames hold whole hot frames, so the journal never splits a
// position another machine may still write at.
export async function seal(store: Store, session: string): Promise<number> {
  const { frames, sealedEnd, stale } = framesOf(session, await store.list(journalPrefix(session)))
  const hot = frames.filter((frame) => frame.key.includes('/hot/'))
  let at = sealedEnd
  let run: Uint8Array[] = []
  let runBytes = 0
  const flush = async (): Promise<void> => {
    if (runBytes === 0) return
    await store.put(sealedKey(session, at, at + runBytes), compressSealed(Buffer.concat(run)), { ifNoneMatch: '*' })
    ;[at, run, runBytes] = [at + runBytes, [], 0]
  }
  for await (const { bytes } of chainOf(store, hot, sealedEnd)) {
    if (runBytes > 0 && runBytes + bytes.length > FRAME_BYTES) await flush()
    run.push(bytes)
    runBytes += bytes.length
  }
  await flush()
  // the chain's frames, and the frames off it inside its span, which no restore reads
  await store.delete([...stale, ...hot.filter((frame) => frame.start < at).map(({ key }) => key)])
  return at
}

export async function sealQuiet(capture: Capture, problems: Problems, now = Date.now()): Promise<void> {
  const quiet = capture.db.query<{ session: string; end: number }, [number]>("select session, end from journals where stopped = '' and end > sealed and written_at < ?").all(now - QUIET_MS)
  for (const { session, end } of quiet) {
    try {
      // a session another machine holds is that machine's to seal
      const held = await claimOf(capture.store, session)
      const isHeld = held === undefined || held.claim.device === capture.device.id
      capture.db.query('update journals set sealed = ? where session = ?').run(isHeld ? await seal(capture.store, session) : end, session)
      problems.clear(`seal ${session}`)
    } catch (error) {
      problems.set(`seal ${session}`, error)
    }
  }
}

// The sessions this machine captures that another machine took over while the program did not run here, as when
// anyhost resume could not reach it over ssh. The program checks them at its start, before it captures.
export async function checkHolders(capture: Capture): Promise<void> {
  const { store, db, device } = capture
  const capturing = new Map(db.query<{ session: string; tool: Tool }, []>("select session, tool from journals where stopped = ''").all().map(({ session, tool }) => [session, tool]))
  const claimed = (await store.list('claims/')).map(({ key }) => key.slice('claims/'.length, -'.json'.length)).filter((session) => capturing.has(session))
  await Promise.all(
    claimed.map(async (session) => {
      const held = await claimOf(store, session)
      if (held === undefined || held.claim.device === device.id) return
      await heldBy(capture, session, capturing.get(session) ?? 'claude', held.claim.device, (holder) => `${new Date().toISOString()} ${holder} took the session ${session} over while anyhost did not run on ${device.name}, so ${device.name} stops capturing it.`)
    }),
  )
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

export async function writeIndex(capture: Capture, written = ''): Promise<string> {
  const index = JSON.stringify(indexOf(capture.db))
  if (index !== written) await capture.store.put(`sessions/${capture.device.id}/index.json`, index)
  return index
}
