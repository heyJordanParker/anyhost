import { Database } from 'bun:sqlite'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Relay } from './relay.ts'
import { sharedOf, updateShared, type Shared } from './shared.ts'

export const T3_STATE = join(homedir(), '.t3', 'userdata', 'statev2.sqlite')

const SETTLED = `select json_extract(p.payload_json, '$.nativeThreadRef.nativeId') as session,
  max(coalesce(t.deleted_at, ''), coalesce(t.archived_at, ''), coalesce(json_extract(t.payload_json, '$.settledAt'), t.updated_at)) as settledAt
  from orchestration_v2_projection_threads t join orchestration_v2_projection_provider_threads p on p.thread_id = t.thread_id
  where t.deleted_at is not null or t.archived_at is not null or json_extract(t.payload_json, '$.settledOverride') = 'settled'`

const read = new Map<string, string>()

const versionOf = (path: string): string => {
  try {
    const { mtimeMs, size } = statSync(path)
    return `${mtimeMs}:${size}`
  } catch {
    return ''
  }
}

export async function archiveSettledInT3(relay: Relay, db: Database, path = T3_STATE): Promise<void> {
  const database = versionOf(path)
  const version = `${database} ${versionOf(`${path}-wal`)}`
  if (database === '' || read.get(path) === version) return
  const t3 = new Database(path, { readonly: true })
  const settled = (() => {
    try {
      return t3.query<{ session: string | null; settledAt: string }, []>(SETTLED).all()
    } finally {
      t3.close()
    }
  })()
  const lastActivityOf = (session: string): string | undefined => db.query<{ last_activity: string }, [string]>('select last_activity from sessions where id = ?').get(session)?.last_activity
  const marks = settled.flatMap(({ session, settledAt }) => {
    const lastActivity = session === null ? undefined : lastActivityOf(session)
    return session === null || lastActivity === undefined ? [] : [{ session, settledAt, at: lastActivity > settledAt ? lastActivity : settledAt }]
  })
  const unmarked = (shared: Shared): typeof marks => marks.filter(({ session, settledAt }) => (shared.archived[session]?.at ?? '') < settledAt)
  if (unmarked(await sharedOf(relay)).length > 0) {
    await updateShared(relay, (shared) => ({ ...shared, archived: { ...shared.archived, ...Object.fromEntries(unmarked(shared).map(({ session, at }) => [session, { archived: true, at }])) } }))
  }
  read.set(path, version)
}
