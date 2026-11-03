import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { heldElsewhere } from './claims.ts'
import { stateFolder, type Device } from './device.ts'
import type { Store } from './store.ts'
import { codexNameOf, keyOf, secondKeyOf, sessionOf, summarize, type Root, type Summary, type Tool } from './transcript.ts'

const SEGMENT_BYTES = 8 * 1024 * 1024
const QUIET_MS = 10 * 60_000

export type IndexedSession = {
  readonly id: string
  readonly tool: Tool
  readonly title: string
  readonly firstPrompt: string
  readonly cwd: string
  readonly repo: string
  readonly repoFolder: string
  readonly lastActivity: string
  readonly size: number
}
export type Capture = { readonly store: Store; readonly db: Database; readonly device: Device }
export class SkippedFile extends Error {}
export type Problems = { set(key: string, error: unknown): void; clear(key: string): void }
export type Segment = { readonly key: string; readonly start: number; readonly end: number }

type FileRow = { path: string; key: string; offset: number; local_start: number; remote_start: number }
type SessionRow = { id: string; tool: Tool; title: string; title_rank: number; first_prompt: string; cwd: string; repo: string; repo_folder: string; last_activity: string; size: number }

export function openDatabase(folder = stateFolder()): Database {
  mkdirSync(folder, { recursive: true })
  const db = new Database(join(folder, 'anyhost.db'))
  db.run('pragma journal_mode = wal')
  db.run('pragma busy_timeout = 5000')
  db.run(`create table if not exists files (
    path text primary key, key text not null, offset integer not null default 0, local_start integer not null default 0,
    remote_start integer not null default 0, grown_at integer not null default 0, is_merged integer not null default 1)`)
  db.run('create index if not exists files_by_key on files (key)')
  db.run(`create table if not exists sessions (
    id text primary key, tool text not null, title text not null default '', title_rank integer not null default 0, first_prompt text not null default '',
    cwd text not null default '', repo text not null default '', repo_folder text not null default '', last_activity text not null default '', size integer not null default 0)`)
  return db
}

export const segmentPrefix = (device: string, key: string): string => `sessions/${device}/${key}/`

function segmentsOf(prefix: string, keys: readonly { key: string }[]): Segment[] {
  return keys
    .flatMap(({ key }) => {
      const match = /^(\d+)-(\d+)\.jsonl$/.exec(key.slice(prefix.length))
      return match === null ? [] : [{ key, start: Number(match[1]), end: Number(match[2]) }]
    })
    .sort((a, b) => a.start - b.start || b.end - a.end)
}

async function completeLines(path: string, from: number, size: number): Promise<Uint8Array | undefined> {
  let end = Math.min(size, from + SEGMENT_BYTES)
  for (;;) {
    const bytes = new Uint8Array(await Bun.file(path).slice(from, end).arrayBuffer())
    const last = bytes.lastIndexOf(10)
    if (last >= 0) return bytes.subarray(0, last + 1)
    if (end === size) return undefined
    end = Math.min(size, end + SEGMENT_BYTES)
  }
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
      id, tool, title: '', title_rank: 0, first_prompt: '', cwd: '', repo: '', repo_folder: '', last_activity: '', size: 0,
    }
  )
}

export async function recordSummary(db: Database, id: string, tool: Tool, text: string, size: number, lastActivity: string): Promise<void> {
  const row = sessionRow(db, id, tool)
  const before: Summary = { title: row.title, titleRank: row.title_rank, firstPrompt: row.first_prompt, cwd: row.cwd, repo: tool === 'codex' ? row.repo : '' }
  const after = summarize(before, text, tool)
  const checkout = after.cwd === row.cwd && row.last_activity !== '' ? { repo: row.repo, folder: row.repo_folder } : await checkoutOf(after.cwd)
  db.query(
    `insert into sessions (id, tool, title, title_rank, first_prompt, cwd, repo, repo_folder, last_activity, size) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do update set title = excluded.title, title_rank = excluded.title_rank, first_prompt = excluded.first_prompt, cwd = excluded.cwd,
     repo = excluded.repo, repo_folder = excluded.repo_folder, last_activity = excluded.last_activity, size = excluded.size`,
  ).run(id, tool, (tool === 'codex' ? await codexNameOf(id) : undefined) ?? after.title, after.titleRank, after.firstPrompt, after.cwd, checkout.repo || after.repo, checkout.folder, lastActivity, size)
}

export async function uploadFile(capture: Capture, root: Root, path: string): Promise<'done' | 'more'> {
  const { store, db, device } = capture
  const pathKey = keyOf(root, path)
  if (pathKey === undefined) return 'done'
  let row = db.query<FileRow, [string]>('select * from files where path = ?').get(path)
  if (row === null) {
    const isTaken = db.query<{ path: string }, [string]>('select path from files where key = ?').get(pathKey) !== null
    const key = isTaken ? secondKeyOf(root, path, pathKey) : pathKey
    db.query('insert into files (path, key) values (?, ?)').run(path, key)
    row = { path, key, offset: 0, local_start: 0, remote_start: 0 }
  }
  const { key } = row
  const found = await stat(path)
  if (found.size < row.offset) throw new SkippedFile(`${path} shrank from ${row.offset} to ${found.size} bytes. anyhost keeps the ${row.offset} bytes it uploaded and captures nothing more of it.`)
  if (found.size === row.offset) return 'done'
  const bytes = await completeLines(path, row.offset, found.size)
  if (bytes === undefined) return 'done'
  const start = row.remote_start + row.offset - row.local_start
  const end = start + bytes.length
  await store.put(`${segmentPrefix(device.id, key)}${start}-${end}.jsonl`, bytes)
  db.query('update files set offset = ?, grown_at = ?, is_merged = 0 where path = ?').run(row.offset + bytes.length, Date.now(), path)
  if (!key.includes('/')) await recordSummary(db, sessionOf(key), root.tool, new TextDecoder().decode(bytes), end, found.mtime.toISOString())
  return row.offset + bytes.length < found.size ? 'more' : 'done'
}

export async function captureFiles(
  capture: Capture,
  files: ReadonlyMap<string, Root>,
  problems: Problems,
  parallel = 1,
): Promise<Map<string, Root>> {
  const sessionsOf = new Map([...files].flatMap(([path, root]) => {
    const key = keyOf(root, path)
    return key === undefined ? [] : [[path, sessionOf(key)] as const]
  }))
  const held = await heldElsewhere(capture.store, capture.device.id, new Set(sessionsOf.values()))
  const again = new Map<string, Root>()
  const queue = [...files]
  const work = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const [path, root] = next
      const session = sessionsOf.get(path)
      if (session === undefined || held.has(session)) continue
      try {
        if ((await uploadFile(capture, root, path)) === 'more') again.set(path, root)
        problems.clear(path)
      } catch (error) {
        problems.set(path, error)
        if (!(error instanceof SkippedFile)) again.set(path, root)
      }
    }
  }
  await Promise.all(Array.from({ length: parallel }, work))
  return again
}

export async function merge(store: Store, prefix: string): Promise<void> {
  const segments = segmentsOf(prefix, await store.list(prefix))
  const groups: Segment[][] = []
  for (const segment of segments) {
    const group = groups.at(-1)
    const last = group?.at(-1)
    if (group !== undefined && last !== undefined && last.end === segment.start && segment.end - (group[0]?.start ?? 0) <= SEGMENT_BYTES) group.push(segment)
    else groups.push([segment])
  }
  for (const group of groups) {
    const [first, last] = [group[0], group.at(-1)]
    if (group.length < 2 || first === undefined || last === undefined) continue
    const bodies = await Promise.all(group.map(async ({ key }) => (await store.get(key))?.body ?? Promise.reject(new Error(`${key} disappeared during its merge.`))))
    await store.put(`${prefix}${first.start}-${last.end}.jsonl`, Buffer.concat(bodies))
    await store.delete(group.map(({ key }) => key))
  }
}

export async function mergeQuiet(capture: Capture, now = Date.now()): Promise<void> {
  const quiet = capture.db.query<{ path: string; key: string }, [number]>('select path, key from files where is_merged = 0 and grown_at < ?').all(now - QUIET_MS)
  for (const { path, key } of quiet) {
    await merge(capture.store, segmentPrefix(capture.device.id, key))
    capture.db.query('update files set is_merged = 1 where path = ?').run(path)
  }
}

function indexOf(db: Database): IndexedSession[] {
  return db
    .query<SessionRow, []>('select * from sessions order by last_activity desc')
    .all()
    .map((row) => ({
      id: row.id, tool: row.tool, title: row.title, firstPrompt: row.first_prompt, cwd: row.cwd, repo: row.repo, repoFolder: row.repo_folder, lastActivity: row.last_activity, size: row.size,
    }))
}

export async function writeIndex(capture: Capture, written = ''): Promise<string> {
  const index = JSON.stringify(indexOf(capture.db))
  if (index !== written) await capture.store.put(`sessions/${capture.device.id}/index.json`, index)
  return index
}

export function placeFile(db: Database, path: string, key: string, localSize: number, remoteSize: number): void {
  db.query(
    `insert into files (path, key, offset, local_start, remote_start, grown_at, is_merged) values (?, ?, ?, ?, ?, 0, 1)
     on conflict (path) do update set key = excluded.key, offset = excluded.offset, local_start = excluded.local_start, remote_start = excluded.remote_start, is_merged = 1`,
  ).run(path, key, localSize, localSize, remoteSize)
}
