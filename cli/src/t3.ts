import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Relay } from './relay.ts'
import { sharedOf, updateShared, type Shared } from './shared.ts'

export const T3_STATE = join(homedir(), '.t3', 'userdata', 'statev2.sqlite')

const MARKED = `select json_extract(p.payload_json, '$.nativeThreadRef.nativeId') as session,
  t.deleted_at is not null or t.archived_at is not null as isArchived,
  case when t.deleted_at is not null or t.archived_at is not null then max(coalesce(t.deleted_at, ''), coalesce(t.archived_at, ''))
    else coalesce(json_extract(t.payload_json, '$.settledAt'), t.updated_at) end as markedAt
  from orchestration_v2_projection_threads t join orchestration_v2_projection_provider_threads p on p.thread_id = t.thread_id
  where t.deleted_at is not null or t.archived_at is not null or json_extract(t.payload_json, '$.settledOverride') = 'settled'`

const read = new Map<string, string>()

function readCopy<T>(path: string, query: (database: Database) => T): T {
  const folder = mkdtempSync(join(tmpdir(), 'anyhost-t3-'))
  try {
    const copy = join(folder, 'state.sqlite')
    copyFileSync(path, copy)
    if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`)
    const database = new Database(copy)
    try {
      return query(database)
    } finally {
      database.close()
    }
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

const versionOf = (path: string): string => {
  try {
    const { mtimeMs, size } = statSync(path)
    return `${mtimeMs}:${size}`
  } catch {
    return ''
  }
}

export async function copyT3Marks(relay: Relay, db: Database, path = T3_STATE): Promise<void> {
  const database = versionOf(path)
  const version = `${database} ${versionOf(`${path}-wal`)}`
  if (database === '' || read.get(path) === version) return
  const threads = readCopy(path, (t3) => t3.query<{ session: string | null; isArchived: number; markedAt: string }, []>(MARKED).all())
  const lastActivityOf = (session: string): string | undefined => db.query<{ last_activity: string }, [string]>('select last_activity from sessions where id = ?').get(session)?.last_activity
  const marks = threads.flatMap(({ session, isArchived, markedAt }) => {
    const lastActivity = session === null ? undefined : lastActivityOf(session)
    return session === null || lastActivity === undefined ? [] : [{ session, isArchived: isArchived === 1, markedAt, at: lastActivity > markedAt ? lastActivity : markedAt }]
  })
  const unmarked = (shared: Shared): typeof marks => marks.filter(({ session, isArchived, markedAt }) => ((isArchived ? shared.archived : shared.settled)[session]?.at ?? '') < markedAt)
  if (unmarked(await sharedOf(relay)).length > 0) {
    await updateShared(relay, (shared) => {
      const marked = unmarked(shared)
      const archived = marked.filter(({ isArchived }) => isArchived).map(({ session, at }) => [session, { archived: true, at }] as const)
      const settled = marked.filter(({ isArchived }) => !isArchived).map(({ session, at }) => [session, { settled: true, at }] as const)
      return { ...shared, archived: { ...shared.archived, ...Object.fromEntries(archived) }, settled: { ...shared.settled, ...Object.fromEntries(settled) } }
    })
  }
  read.set(path, version)
}
