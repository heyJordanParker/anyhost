import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, rmSync, statSync, type Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { MAX_KEYS, MAX_MESSAGE_BYTES, MAX_OPS, type DeviceRef, type Listed, type Released } from '../../relay/protocol.ts'
import { captureCode, restoreCode, type CodeCapture } from './code.ts'
import { devicesOf, stateFolder, type Device, type MachineRoots } from './device.ts'
import type { Call, RanOf, Relay } from './relay.ts'
import { codexNameOf, codexState, filesOf, linesFiles, namedIn, ownerOf, summarize, type Summary, type Tool } from './transcript.ts'

export const FRAME_BYTES = 64 * 2 ** 20
export const CODE_PIECE_BYTES = 128 * 2 ** 10
export const CODE_PIECES = 4
export const QUIET_MS = 10 * 60_000
const SEAL_WAIT_PASSES = 60
const SWEEP_BATCH = 1000
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
  readonly codeSkipped: Set<string>
  readonly sealWaits: Map<string, { readonly failures: number; passes: number }>
  readonly missingFolders: Set<string>
  readonly onCode: (session: string, tool: Tool, folder: string) => void
  readonly onReleased: (session: string, holder: string) => void
  lastIndex: string
}
export type Problems = { set(key: string, error: unknown): void; clear(key: string): void }
export type RecordHeader = {
  readonly device: string
  readonly checkout?: string
  readonly path: string
  readonly at: number
  readonly size: number
  readonly after: { readonly size: number; readonly sha256: string } | null
}
export type Frame = { readonly key: string; readonly start: number; readonly end?: number; readonly size: number }
export type FileState = { readonly session: string; readonly path: string; readonly journalSize: number; readonly localSize: number; readonly tail: Uint8Array; readonly sha256: string; readonly mtime: number }
export type Journal = { readonly session: string; readonly tool: Tool; readonly end: number; readonly sealed: number; readonly writtenAt: number; readonly stopped: string; readonly holder: string }

type FileRow = { session: string; path: string; journal_size: number; local_size: number; tail: Uint8Array; sha256: string; mtime: number }
type JournalRow = { session: string; tool: Tool; end: number; sealed: number; written_at: number; stopped: string; holder: string }
type SessionRow = { id: string; tool: Tool; title: string; title_rank: number; first_prompt: string; cwd: string; repo: string; repo_folder: string; entrypoint: string; last_activity: string; size: number }
type Source = { readonly size: number; readonly mtime: number; read(from: number, to: number): Promise<Uint8Array> }
type Change = { readonly header: RecordHeader; readonly bytes: Uint8Array; readonly state: FileState; readonly hasher: Bun.CryptoHasher; readonly isPartial: boolean }

export function openDatabase(folder = stateFolder()): Database {
  mkdirSync(folder, { recursive: true })
  const db = new Database(join(folder, 'anyhost.db'))
  db.run('pragma journal_mode = wal')
  db.run('pragma busy_timeout = 5000')
  db.run("create table if not exists bucket (name text not null, url text not null default '')")
  if (db.query<{ name: string }, []>("select name from pragma_table_info('bucket') where name = 'url'").get() === null) db.run("alter table bucket add column url text not null default ''")
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
  }: { readonly db?: Database; readonly code?: Code; readonly onCode?: Capture['onCode']; readonly onReleased?: Capture['onReleased']; readonly onOtherRelay?: (url: string, bucket: string) => void } = {},
): Capture {
  const capture: Capture = {
    ...code, relay, db, device, roots, hashers: new Map(), codeRuns: new Map(), codeWaiting: new Map(), codeStale: new Set(), codeSkipped: new Set(), sealWaits: new Map(), missingFolders: new Set(), onCode, onReleased, lastIndex: '',
  }
  const released = ({ session, to, at }: Released): void => releasedTo(capture, session, to, `${at} ${to.name} took the session ${session} over, so ${device.name} stops capturing it.`)
  relay.on('welcome', ({ bucket, waiting }) => {
    const isOther = useRelay(db, relay.url, bucket)
    for (const message of waiting) released(message)
    if (isOther) onOtherRelay(relay.url, bucket)
  })
  relay.on('released', released)
  return capture
}

function releasedTo(capture: Capture, session: string, holder: DeviceRef, reason: string, tool?: Tool): void {
  holdElsewhere(capture.db, session, holder.name, reason, tool)
  capture.relay.send({ t: 'heard', session, to: holder.id })
  capture.onReleased(session, holder.name)
}

export const isCodePart = (path: string): boolean => path.startsWith('anyhost:code/')

const position = (at: number): string => String(at).padStart(16, '0')
export const journalPrefix = (session: string): string => `journals/${session}/`
export const hotKey = (session: string, start: number): string => `${journalPrefix(session)}hot/${position(start)}.zst`
const sealedKey = (session: string, start: number, end: number): string => `${journalPrefix(session)}sealed/${position(start)}-${position(end)}.zst`

const C = zlib.constants
export const compressHot = (body: Uint8Array): Uint8Array => zlib.zstdCompressSync(body, { params: { [C.ZSTD_c_compressionLevel]: 3, [C.ZSTD_c_checksumFlag]: 1 } })
const zstdCompress = promisify(zlib.zstdCompress)
const compressSealed = (body: Uint8Array): Promise<Uint8Array> =>
  zstdCompress(body, { params: { [C.ZSTD_c_compressionLevel]: 9, [C.ZSTD_c_windowLog]: 27, [C.ZSTD_c_enableLongDistanceMatching]: 1, [C.ZSTD_c_checksumFlag]: 1 } })
export const decompress = (frame: Uint8Array): Uint8Array => zlib.zstdDecompressSync(frame, { params: { [C.ZSTD_d_windowLogMax]: 27 } })

export const encodeRecord = (header: RecordHeader, bytes: Uint8Array): Uint8Array[] => [new TextEncoder().encode(`${JSON.stringify(header)}\n`), bytes]

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

export function holdElsewhere(db: Database, session: string, holder: string, reason: string, tool: Tool = 'claude'): void {
  db.query(`insert into journals (session, tool, stopped, holder) values (?, ?, ?, ?)
    on conflict (session) do update set stopped = excluded.stopped, holder = excluded.holder`).run(session, tool, reason, holder)
}

export function holdHere(db: Database, session: string): void {
  db.query("update journals set stopped = '', holder = '' where session = ?").run(session)
}

function restartJournal(db: Database, journal: Omit<Journal, 'writtenAt' | 'stopped' | 'holder'>, files: readonly FileState[]): void {
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

export function takeUntold(db: Database, session: string): string {
  const machine = db.query<{ untold: string }, [string]>('select untold from journals where session = ?').get(session)?.untold ?? ''
  if (machine !== '') db.query("update journals set untold = '' where session = ?").run(session)
  return machine
}

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
  for (let at = 0; at < size; at += FRAME_BYTES) hasher.update(await source.read(at, Math.min(size, at + FRAME_BYTES)))
  return hasher
}

export const checkoutOfEntry = (entry: Pick<IndexedSession, 'cwd' | 'repo' | 'repoFolder'>, home: string): string =>
  (entry.repo !== '' && entry.repoFolder !== '' ? entry.cwd.slice(0, -entry.repoFolder.length - 1) : entry.cwd) || home

function writerOf(capture: Capture, session: string): Pick<RecordHeader, 'device' | 'checkout'> {
  const row = capture.db.query<Pick<SessionRow, 'cwd' | 'repo' | 'repo_folder'>, [string]>('select cwd, repo, repo_folder from sessions where id = ?').get(session)
  const checkout = row === null ? '' : checkoutOfEntry({ cwd: row.cwd, repo: row.repo, repoFolder: row.repo_folder }, '')
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
  if (isLog(path, capture.roots) && source.size >= known.localSize) {
    if (source.size === known.localSize) return touched()
    const from = Math.max(0, known.localSize - known.tail.length)
    let end = Math.min(source.size, known.localSize + budget)
    let read = await source.read(from, end)
    while (read.lastIndexOf(10) < known.localSize - from && end < source.size) {
      end = Math.min(source.size, end + FRAME_BYTES)
      read = await source.read(from, end)
    }
    if (sameBytes(read.subarray(0, known.localSize - from), known.tail)) {
      const gained = read.subarray(known.localSize - from, read.lastIndexOf(10) + 1)
      if (gained.length === 0) return undefined
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
  const bytes = await source.read(0, source.size)
  const hasher = new Bun.CryptoHasher('sha256').update(bytes)
  if (row !== null && bytes.length === known.localSize && hasher.copy().digest('hex') === known.sha256) return touched()
  const end = isLog(path, capture.roots) ? bytes.lastIndexOf(10) + 1 : bytes.length
  if (end === 0 && isLog(path, capture.roots)) return undefined
  const whole = bytes.subarray(0, end)
  return record(0, whole, end, end, end === bytes.length ? hasher : new Bun.CryptoHasher('sha256').update(whole), tailOf(whole), false)
}

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

export type Changed = { readonly session: string; readonly tool: Tool; readonly paths: ReadonlySet<string> }
type Put = { readonly start: number; readonly body: Uint8Array; readonly records: readonly Change[]; readonly put: Promise<RanOf<'put'>> }

export function uploadSessions(capture: Capture, sessions: readonly Changed[], problems: Problems, isEveryWrite = false): (readonly [Changed, Promise<Set<string>>])[] {
  const drains = sessions.map((changed) => ({
    changed,
    upload: readUpload(capture, changed.session, changed.tool, changed.paths, problems, isEveryWrite),
    answered: Promise.withResolvers<readonly Put[]>(),
  }))
  void Promise.allSettled(drains.map(async ({ upload, answered }) => ({ upload: await upload, answered }))).then((all) => {
    const sending = all.flatMap((done) => (done.status === 'rejected' || done.value.upload instanceof Set ? [] : [{ upload: done.value.upload, answered: done.value.answered }]))
    try {
      const calls: Call[] = []
      const asked = sending.map(({ upload: { session, end, frames }, answered }) => {
        let start = end
        const framed = frames.map((records) => {
          const body = Buffer.concat(records.flatMap((record) => encodeRecord(record.header, record.bytes)))
          const frame = { start, body, records, call: calls.push({ op: 'put', key: hotKey(session, start), bytes: compressHot(body), if: { none: '*' }, holder: session }) - 1 }
          start += body.length
          return frame
        })
        return { answered, frames: framed }
      })
      const answers = capture.relay.run(calls)
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
  const work = new Set(paths)
  if (journal === undefined) {
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
    budget -= change.bytes.length
    if (change.isPartial) left.add(path)
    if (path.endsWith('.jsonl')) {
      const named = namedIn(new TextDecoder().decode(change.bytes), roots).filter((file) => !work.has(file))
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
  if (frames.length === 0) return left
  return { session, tool, end: journal.end, changes, frames, code, waiting, left }
}

async function finishUpload(capture: Capture, upload: Upload, puts: readonly Put[], problems: Problems): Promise<Set<string>> {
  const { db, roots } = capture
  const { session, tool, changes, code, waiting, left } = upload
  type Outcome = { readonly frame: Put; readonly isHere: boolean } | { readonly frame: Put; readonly error: unknown }
  const outcomes = await Promise.all(
    puts.map((frame) =>
      frame.put.then((put) => frameWritten(capture, session, tool, frame.start, frame.body, put)).then(
        (isHere): Outcome => ({ frame, isHere }),
        (error: unknown): Outcome => ({ frame, error }),
      ),
    ),
  )
  if (outcomes.some((outcome) => 'isHere' in outcome && !outcome.isHere)) return new Set()
  const failure = outcomes.find((outcome) => 'error' in outcome)
  const counted = failure === undefined ? outcomes : outcomes.slice(0, outcomes.indexOf(failure))
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
  const own = changes.filter(({ header }) => !linesFiles(roots).has(header.path) && header.path !== codexState(roots))
  const lastActivity = new Date(own.length === 0 ? Date.now() : Math.max(...own.map((change) => change.state.mtime))).toISOString()
  if (await recordSummary(capture, session, tool, transcript === undefined ? '' : new TextDecoder().decode(transcript.bytes), end, lastActivity)) {
    await writeIndex(capture).then(() => problems.clear('index'), (error: unknown) => problems.set('index', error))
  }
  if (waiting !== undefined && !code.isDone) left.add(`${waiting.folder}/`)
  if (code.isDone) capture.codeWaiting.delete(session)
  if (changes.length > 0 || capture.codeStale.has(session)) startCode(capture, session, tool, problems)
  return left
}

async function frameWritten(capture: Capture, session: string, tool: Tool, start: number, body: Uint8Array, put: RanOf<'put'>): Promise<boolean> {
  const { relay, db, device } = capture
  const key = hotKey(session, start)
  let answer = put
  if (answer.status === 412) {
    const there = await relay.runOne({ op: 'get', key })
    const written = there.status === 200 ? decompress(there.bytes) : undefined
    const writer = written === undefined ? undefined : (JSON.parse(new TextDecoder().decode(written.subarray(0, written.indexOf(10)))) as RecordHeader).device
    if (writer === device.id || writer === undefined) {
      answer = await relay.runOne({ op: 'put', key, bytes: compressHot(body), if: there.status === 200 ? { match: there.etag } : { none: '*' }, holder: session })
    }
    if (answer.status === 412) {
      const fork = `${new Date().toISOString()} Another machine wrote byte ${start} of the session ${session}'s journal first, so ${device.name} stops capturing it, and its lines from here are a fork of the session.`
      console.error(fork)
      const machine = writer === undefined || writer === device.id ? undefined : (await devicesOf(relay)).get(writer)?.name
      if (machine === undefined) stopJournal(db, session, tool, fork)
      else holdElsewhere(db, session, machine, fork, tool)
      return false
    }
  }
  if (answer.status === 409) {
    releasedTo(capture, session, answer.holder, `${new Date().toISOString()} ${answer.holder.name} took the session ${session} over, so ${device.name} stops capturing it.`, tool)
    return false
  }
  return true
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
    if (ownerOf(path, roots) === undefined) continue
    changed.set(session, (changed.get(session) ?? new Set()).add(path))
  }
  return changed
}

export async function seal(capture: Capture, session: string): Promise<number> {
  const { relay, db } = capture
  const end = journalOf(db, session)?.end ?? 0
  const { frames, sealedEnd, stale } = framesOf(session, await relay.list(journalPrefix(session)))
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
  for await (const { bytes } of chainOf(relay, hot, sealedEnd)) {
    if (runBytes > 0 && runBytes + bytes.length > FRAME_BYTES) await flush()
    run.push(bytes)
    runBytes += bytes.length
  }
  await flush()
  const sealed = [...stale, ...hot.map(({ key }) => key)]
  const deletes: Call[] = []
  for (let from = 0; from < sealed.length; from += MAX_KEYS) deletes.push({ op: 'delete', keys: sealed.slice(from, from + MAX_KEYS) })
  await Promise.all(relay.run(deletes))
  return at
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
  const hasTranscript = paths.some((path) => {
    const owner = ownerOf(path, roots)
    return owner !== undefined && 'isTranscript' in owner && owner.isTranscript && existsSync(path)
  })
  if (hasTranscript) console.error(`${new Date().toISOString()} ${reached}, so it uploads the session's files whole again from byte ${at}.`)
  else problems.set(`journal ${session}`, `${reached}, and holds no transcript of the session to upload again, so a restore of the session lacks what the journal held from byte ${at}.`)
  return new Set(paths)
}

export async function sealJournal(capture: Capture, session: string, tool: Tool, problems: Problems): Promise<Set<string>> {
  const end = journalOf(capture.db, session)?.end ?? 0
  const at = await seal(capture, session)
  if (at !== end) return captureAgainFrom(capture, session, tool, at, end, problems)
  capture.db.query('update journals set sealed = ? where session = ?').run(at, session)
  return new Set()
}

export async function sealQuiet(capture: Capture, problems: Problems, now = Date.now()): Promise<Map<string, Set<string>>> {
  const { db, relay, device, sealWaits } = capture
  const quiet = db.query<{ session: string; tool: Tool }, [number]>("select session, tool from journals where stopped = '' and end > sealed and written_at < ?").all(now - QUIET_MS)
  const again = new Map<string, Set<string>>()
  for (const { session, tool } of quiet) {
    const wait = sealWaits.get(session)
    if (wait !== undefined && wait.passes > 1) {
      wait.passes -= 1
      continue
    }
    try {
      const claim = await relay.runOne({ op: 'claim', session, take: false })
      if (claim.status === 409) releasedTo(capture, session, claim.holder, `${new Date().toISOString()} ${claim.holder.name} holds the session ${session}, so ${device.name} stops capturing it.`, tool)
      else {
        const files = await sealJournal(capture, session, tool, problems)
        if (files.size > 0) again.set(session, files)
      }
      sealWaits.delete(session)
      problems.clear(`seal ${session}`)
    } catch (error) {
      const failures = (wait?.failures ?? 0) + 1
      sealWaits.set(session, { failures, passes: Math.min(2 ** (failures - 1), SEAL_WAIT_PASSES) })
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

export async function writeIndex(capture: Capture): Promise<void> {
  const index = JSON.stringify(indexOf(capture.db))
  if (index === capture.lastIndex) return
  await capture.relay.runOne({ op: 'put', key: `sessions/${capture.device.id}/index.json`, bytes: new TextEncoder().encode(index) })
  capture.lastIndex = index
}
