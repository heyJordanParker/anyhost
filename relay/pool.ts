import { DurableObject, RpcTarget } from 'cloudflare:workers'
import {
  ANSWER,
  CLOSE_DEVICE_LIVE,
  CLOSE_REMOVED,
  CLOSE_UNKNOWN_TOKEN,
  INVITE_MS,
  LIVE_MS,
  MAX_KEYS,
  MAX_MESSAGE_BYTES,
  MAX_OPS,
  PROTOCOL_VERSION,
  RELAY_VERSION,
  REMOVED_MESSAGE,
  REMOVED_REASON,
  REQUEST,
  cloneFixFor,
  conditionHeaders,
  decodeMessage,
  encodeMessage,
  tokenOf,
  type Answer,
  type Claimed,
  type DeviceRef,
  type ErrorCode,
  type Health,
  type JoiningDevice,
  type Joined,
  type Op,
  type Refusal,
  type TakeCondition,
  type Released,
  type Result,
  type Roots,
  type Welcome,
} from './protocol.ts'

export type Env = {
  readonly BUCKET: R2Bucket
  readonly POOL: DurableObjectNamespace<Pool>
  readonly BUCKET_NAME: string
  readonly SETUP_CODE_SHA256?: string
}

export type Reply = { readonly status: number; readonly body: object }

type Attachment = { readonly device: string; readonly name: string; readonly origin: string; readonly connectedAt: number }

type DeviceRow = {
  id: string
  name: string
  os: string
  arch: string
  roots: string
  token_sha256: string | null
  joined_at: number
  seen_at: number
  removed_at: number | null
}

type Fetched = { readonly object: R2ObjectBody }

const SCHEMA = `
create table if not exists devices (id text primary key, name text not null, os text not null, arch text not null,
  roots text not null, token_sha256 text unique, joined_at integer not null, seen_at integer not null, removed_at integer);
create table if not exists invites (code_sha256 text primary key, made_by text, expires_at integer, used_by text, used_at integer);
create table if not exists claims (session text primary key, device text not null, at integer not null, changed integer not null default 0);
create table if not exists waiting (id integer primary key, device text not null, session text not null, taker text not null, message text not null, at integer not null);
create index if not exists waiting_by_session on waiting (session, taker);
create index if not exists waiting_by_device on waiting (device);
create table if not exists meta (key text primary key, value text not null);`

const CHANGES = `
create index if not exists claims_by_changed on claims (changed);
insert into meta (key, value) select 'changed', coalesce(max(changed), 0) from claims where true on conflict (key) do nothing;`

const IMPORT_READS = 50
const HEAVY_ROWS = 100
const HEARD_MS = 1000
const INVITE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const encoder = new TextEncoder()
const iso = (ms: number): string => new Date(ms).toISOString()
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''
function jsonOf(text: string | null): unknown {
  try {
    return JSON.parse(text ?? '')
  } catch {
    return undefined
  }
}
export const refuse = (status: number, error: ErrorCode, message: string, more: object = {}): Reply => ({ status, body: { error, message, ...more } satisfies Refusal })
export const reply = ({ status, body }: Reply): Response => Response.json(body, { status })

export const healthOf = (env: Env): Health => ({ relay: RELAY_VERSION, protocol: PROTOCOL_VERSION, bucket: env.BUCKET_NAME })

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const randomBytes = (size: number): Uint8Array => crypto.getRandomValues(new Uint8Array(size))
const hearingKey = (holder: string, session: string, taker: string): string => JSON.stringify([holder, session, taker])
const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

function inviteCode(): string {
  let bits = 0
  let value = 0
  let code = ''
  for (const byte of randomBytes(16)) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      code += INVITE_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return bits > 0 ? code + INVITE_ALPHABET[(value << (5 - bits)) & 31] : code
}

function rootsOf(value: unknown): Roots | undefined {
  if (!isRecord(value)) return undefined
  const { home, claudeHome, claudeTmp, codexHome } = value
  return isText(home) && isText(claudeHome) && isText(claudeTmp) && isText(codexHome) ? { home, claudeHome, claudeTmp, codexHome } : undefined
}

function joiningOf(value: unknown): JoiningDevice | undefined {
  if (!isRecord(value)) return undefined
  const { id, name, os, arch } = value
  const roots = rootsOf(value['roots'])
  return isText(id) && isText(name) && isText(os) && isText(arch) && roots !== undefined ? { id, name, os, arch, roots } : undefined
}

export async function conditionalPut(bucket: R2Bucket, key: string, body: ReadableStream | Uint8Array | null, onlyIf: Headers): Promise<{ readonly stored: R2Object } | { readonly etag: string | undefined }> {
  const stored = await bucket.put(key, body, { onlyIf })
  return stored === null ? { etag: (await bucket.head(key))?.etag } : { stored }
}

type Sql = { exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): { toArray(): T[] } }

function loggedSql(sql: SqlStorage): Sql {
  return {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) {
      const cursor = sql.exec<T>(query, ...bindings)
      const rows = cursor.toArray()
      if (cursor.rowsRead > HEAVY_ROWS) console.warn(`The relay read ${cursor.rowsRead} rows for ${query.trim().slice(0, 160)}`)
      return { toArray: () => rows }
    },
  }
}

class Write extends RpcTarget {
  readonly #done: () => void

  constructor(done: () => void) {
    super()
    this.#done = done
  }

  [Symbol.dispose](): void {
    this.#done()
  }
}

export class Pool extends DurableObject<Env> {
  readonly #sql: Sql
  readonly #writes = new Map<string, Set<Promise<void>>>()
  readonly #heardAt = new WeakMap<WebSocket, number>()
  readonly #hearing = new Map<string, Set<() => void>>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.#sql = loggedSql(ctx.storage.sql)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    void ctx.blockConcurrencyWhile(() => this.#start())
  }

  async #start(): Promise<void> {
    this.#sql.exec(SCHEMA)
    if (this.#sql.exec("select name from pragma_table_info('claims') where name = 'changed'").toArray().length === 0) {
      this.#sql.exec('alter table claims add column changed integer not null default 0')
      this.#sql.exec('update claims set changed = rowid')
    }
    this.#sql.exec(CHANGES)
    if (this.#sql.exec('select value from meta where key = ?', 'relay').toArray().length > 0) return
    await this.#importBucket()
    this.#sql.exec('insert into meta (key, value) values (?, ?)', 'relay', String(RELAY_VERSION))
  }

  async #importBucket(): Promise<void> {
    const imported: string[] = []
    const importEach = async (prefix: string, add: (name: string, record: Record<string, unknown>, uploaded: number) => boolean): Promise<void> => {
      let cursor: string | undefined
      do {
        const page = await this.env.BUCKET.list({ prefix, limit: MAX_KEYS, ...(cursor === undefined ? {} : { cursor }) })
        for (let at = 0; at < page.objects.length; at += IMPORT_READS) {
          await Promise.all(
            page.objects.slice(at, at + IMPORT_READS).map(async ({ key }) => {
              const stored = await this.env.BUCKET.get(key)
              if (stored === null) return
              const record: unknown = await stored.json().catch(() => undefined)
              const name = key.slice(prefix.length, -'.json'.length)
              if (key.endsWith('.json') && isRecord(record) && add(name, record, stored.uploaded.getTime())) imported.push(key)
              else console.error(`The relay left ${key} in R2, because it is no record it reads.`)
            }),
          )
        }
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor !== undefined)
    }
    await importEach('devices/', (id, record, uploaded) => {
      const { name, os, arch, home } = record
      const roots = rootsOf({ claudeHome: isText(home) ? `${home}/.claude` : undefined, ...record })
      if (!isText(name) || !isText(os) || !isText(arch) || roots === undefined) return false
      this.#sql.exec(
        'insert into devices (id, name, os, arch, roots, joined_at, seen_at) values (?, ?, ?, ?, ?, ?, ?) on conflict (id) do nothing',
        id,
        name,
        os,
        arch,
        JSON.stringify(roots),
        uploaded,
        uploaded,
      )
      return true
    })
    await importEach('claims/', (session, record) => {
      const { device, at } = record
      if (!isText(device) || !isText(at) || Number.isNaN(Date.parse(at))) return false
      if (this.#sql.exec('select session from claims where session = ?', session).toArray().length === 0) this.#setHolder(session, device, Date.parse(at))
      return true
    })
    for (let at = 0; at < imported.length; at += MAX_KEYS) await this.env.BUCKET.delete(imported.slice(at, at + MAX_KEYS))
    if (imported.length > 0) console.log(`The relay imported ${imported.length} device and claim records from R2 and deleted them there.`)
  }

  #deviceOf(tokenSha256: string): DeviceRow | undefined {
    return this.#sql.exec<DeviceRow>('select * from devices where token_sha256 = ?', tokenSha256).toArray()[0]
  }

  #holderOf(session: string): DeviceRef | undefined {
    const row = this.#sql
      .exec<{ id: string; name: string | null }>("select claims.device as id, devices.name from claims left join devices on devices.id = claims.device where session = ? and claims.device != ''", session)
      .toArray()[0]
    return row === undefined ? undefined : { id: row.id, name: row.name ?? row.id }
  }

  #setHolder(session: string, device: string, at: number): void {
    const changed = Number(this.#sql.exec<{ value: string }>("update meta set value = value + 1 where key = 'changed' returning value").toArray()[0]?.value)
    this.#sql.exec(
      'insert into claims (session, device, at, changed) values (?, ?, ?, ?) on conflict (session) do update set device = excluded.device, at = excluded.at, changed = excluded.changed',
      session,
      device,
      at,
      changed,
    )
    const claimed: Claimed = { t: 'claimed', changed, session, device }
    this.#deliver('every machine', JSON.stringify(claimed), this.ctx.getWebSockets())
  }

  #liveOtherThan(id: string, name: string): string | undefined {
    return this.ctx
      .getWebSockets(id)
      .filter((socket) => this.#isLive(socket))
      .map((socket) => (socket.deserializeAttachment() as Attachment).name)
      .find((live) => live !== name)
  }

  #startWrite(device: DeviceRef, session: string): { readonly holder: DeviceRef } | { readonly done: () => void } {
    const held = this.#holderOf(session)
    if (held !== undefined && held.id !== device.id) return { holder: held }
    if (held === undefined) this.#setHolder(session, device.id, Date.now())
    const writes = this.#writes.get(session) ?? new Set()
    this.#writes.set(session, writes)
    let done = (): void => undefined
    const write = new Promise<void>((resolve) => (done = resolve))
    writes.add(write)
    return {
      done: () => {
        done()
        writes.delete(write)
        if (writes.size === 0) this.#writes.delete(session)
      },
    }
  }

  #isLive(socket: WebSocket): boolean {
    const pingedAt = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0
    const { connectedAt } = socket.deserializeAttachment() as Attachment
    return Date.now() - Math.max(this.#heardAt.get(socket) ?? 0, pingedAt, connectedAt) <= LIVE_MS
  }

  #deliver(device: string, message: string | Uint8Array, sockets = this.ctx.getWebSockets(device)): boolean {
    const live = sockets.filter((socket) => this.#isLive(socket))
    for (const socket of live) {
      try {
        socket.send(message)
      } catch (error) {
        console.error(`The relay could not send to a socket of ${device}: ${String(error)}`)
      }
    }
    return live.length > 0
  }

  async join(body: unknown, setupCodeSha256: string | undefined): Promise<Reply> {
    const device = isRecord(body) ? joiningOf(body['device']) : undefined
    const code = isRecord(body) ? body['invite'] : undefined
    if (device === undefined || !isText(code)) return refuse(400, 'invalid', 'A join names the invite and the device with its id, name, os, arch and roots.')
    const codeSha256 = await sha256(code)
    const now = Date.now()
    const invite = this.#sql.exec<{ expires_at: number | null; used_by: string | null; used_at: number | null }>('select expires_at, used_by, used_at from invites where code_sha256 = ?', codeSha256).toArray()[0]
    if (invite === undefined && codeSha256 !== setupCodeSha256) return refuse(403, 'invite_unknown', 'The relay made no invite with that code. Make a new one with Add a machine.')
    const usedBy = invite?.used_by == null ? undefined : this.#sql.exec<{ name: string; removed_at: number | null }>('select name, removed_at from devices where id = ?', invite.used_by).toArray()[0]
    const isRepeat = invite?.used_by === device.id && now - (invite.used_at ?? 0) <= INVITE_MS && usedBy !== undefined && usedBy.removed_at === null
    if (invite?.used_by != null && !isRepeat) {
      return refuse(403, 'invite_used', `The invite already joined ${usedBy?.name ?? invite.used_by} at ${iso(invite.used_at ?? 0)}. Make a new one with Add a machine.`)
    }
    if (!isRepeat && invite?.expires_at != null && now > invite.expires_at) return refuse(403, 'invite_expired', `The invite expired at ${iso(invite.expires_at)}, 10 minutes after it was made. Make a new one with Add a machine.`)
    const live = this.#liveOtherThan(device.id, device.name)
    if (live !== undefined) {
      return refuse(409, 'device_live', `This machine, ${device.name}, has the id of ${live}, which is connected now, as a machine cloned from it is. ${cloneFixFor(device.os)}`)
    }
    const token = base64url(randomBytes(32))
    const tokenSha256 = await sha256(token)
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec(
        `insert into devices (id, name, os, arch, roots, token_sha256, joined_at, seen_at) values (?, ?, ?, ?, ?, ?, ?, ?)
          on conflict (id) do update set name = excluded.name, os = excluded.os, arch = excluded.arch, roots = excluded.roots,
          token_sha256 = excluded.token_sha256, joined_at = excluded.joined_at, seen_at = excluded.seen_at, removed_at = null`,
        device.id,
        device.name,
        device.os,
        device.arch,
        JSON.stringify(device.roots),
        tokenSha256,
        now,
        now,
      )
      this.#sql.exec(
        'insert into invites (code_sha256, used_by, used_at) values (?, ?, ?) on conflict (code_sha256) do update set used_by = excluded.used_by, used_at = coalesce(invites.used_at, excluded.used_at)',
        codeSha256,
        device.id,
        now,
      )
    })
    return { status: 200, body: { ...healthOf(this.env), token, device: { id: device.id, name: device.name } } satisfies Joined }
  }

  async authorize(token: string, holder?: string): Promise<{ refused: Reply } | { device: DeviceRef; write?: Write }> {
    const row = this.#deviceOf(await sha256(token))
    if (row === undefined) return { refused: refuse(401, 'unknown_token', 'The relay knows no machine with this token. Join it with a link from Add a machine.') }
    if (row.removed_at !== null) return { refused: refuse(403, 'removed', REMOVED_MESSAGE) }
    const device = { id: row.id, name: row.name }
    if (holder === undefined) return { device }
    const write = this.#startWrite(device, holder)
    if ('holder' in write) return { refused: refuse(409, 'held', `${write.holder.name} holds the session ${holder}.`, { holder: write.holder }) }
    return { device, write: new Write(write.done) }
  }

  override async fetch(request: Request): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    const opened = new Response(null, { status: 101, webSocket: client })
    const closeWith = (code: number, reason: string): Response => {
      server.accept()
      server.close(code, reason)
      return opened
    }
    const name = request.headers.get('x-anyhost-name') ?? ''
    if (name === '') return reply(refuse(400, 'invalid', 'A connect names its machine in X-Anyhost-Name.'))
    const roots = rootsOf(jsonOf(request.headers.get('x-anyhost-roots')))
    if (roots === undefined) return reply(refuse(400, 'invalid', 'A connect names its machine\'s roots as JSON in X-Anyhost-Roots.'))
    const row = this.#deviceOf(await sha256(tokenOf(request.headers.get('authorization'))))
    if (row === undefined) return closeWith(CLOSE_UNKNOWN_TOKEN, 'The relay knows no machine with this token.')
    if (row.removed_at !== null) return closeWith(CLOSE_REMOVED, REMOVED_REASON)
    const live = this.#liveOtherThan(row.id, name)
    if (live !== undefined) return closeWith(CLOSE_DEVICE_LIVE, `${live.slice(0, 64)} is connected with this machine's id.`)
    const now = Date.now()
    this.#sql.exec('update devices set name = ?, roots = ?, seen_at = ? where id = ?', name, JSON.stringify(roots), now, row.id)
    this.ctx.acceptWebSocket(server, [row.id])
    server.serializeAttachment({ device: row.id, name, origin: new URL(request.url).origin, connectedAt: now } satisfies Attachment)
    const waiting = this.#sql.exec<{ message: string }>('select message from waiting where device = ? order by id', row.id).toArray()
    const welcome: Welcome = { t: 'welcome', ...healthOf(this.env), device: { id: row.id, name }, waiting: waiting.map(({ message }) => JSON.parse(message) as Released), changed: this.#changed() }
    server.send(JSON.stringify(welcome))
    return opened
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.#heardAt.set(ws, Date.now())
    if (typeof message === 'string') return this.#control(ws, message)
    const bytes = new Uint8Array(message)
    if (bytes[0] === REQUEST) return await this.#request(ws, bytes)
    ws.send(JSON.stringify({ t: 'invalid', message: `The relay reads no binary message of kind ${bytes[0]}.` }))
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.#sql.exec('update devices set seen_at = ? where id = ?', Date.now(), (ws.deserializeAttachment() as Attachment).device)
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error(`The socket of ${(ws.deserializeAttachment() as Attachment | null)?.name} failed: ${String(error)}`)
  }

  #control(ws: WebSocket, text: string): void {
    const invalid = (message: string): void => ws.send(JSON.stringify({ t: 'invalid', message }))
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return invalid(`The relay reads no message ${text.slice(0, 100)}.`)
    }
    if (!isRecord(message) || !isText(message['t'])) return invalid('A message is a JSON object that names its type in t.')
    const own = ws.deserializeAttachment() as Attachment
    const from = { id: own.device, name: own.name }
    const { t, to } = message
    if (t === 'welcome' || t === 'released' || t === 'offline' || t === 'invalid') return invalid(`Only the relay sends ${t}.`)
    if (t === 'heard') {
      const { session } = message
      if (!isText(session) || !isText(to)) return invalid('A heard names the session of the released it answers, and in to the machine that took it.')
      return this.#heard(own.device, session, to)
    }
    if (!isText(to)) return invalid(`A ${t} message names the machine it goes to in to.`)
    if (!this.#deliver(to, JSON.stringify({ ...message, from }))) ws.send(JSON.stringify({ t: 'offline', ...('id' in message ? { id: message['id'] } : {}), to }))
  }

  async #request(ws: WebSocket, message: Uint8Array): Promise<void> {
    const send = (answer: Answer, parts: readonly Uint8Array[] = []): void => ws.send(encodeMessage(ANSWER, answer, parts))
    let header: unknown
    let bytes: Uint8Array
    try {
      ;({ header, bytes } = decodeMessage(message))
    } catch (error) {
      return send({ id: null, error: 'invalid', message: `The relay reads no request: ${String(error)}` })
    }
    const id = isRecord(header) && typeof header['id'] === 'number' ? header['id'] : null
    const ops = isRecord(header) ? header['ops'] : undefined
    if (id === null || !Array.isArray(ops)) return send({ id, error: 'invalid', message: 'A request is {id, ops}.' })
    if (ops.length > MAX_OPS) return send({ id, error: 'too_large', message: `A request carries at most ${MAX_OPS} ops, and this one ${ops.length}.` })
    if (bytes.length > MAX_MESSAGE_BYTES) return send({ id, error: 'too_large', message: `A request carries at most ${MAX_MESSAGE_BYTES} bytes, and this one ${bytes.length}.` })
    const sizes = ops.map((op: unknown) => (isRecord(op) && op['op'] === 'put' ? op['size'] : 0))
    if (!sizes.every((size) => Number.isInteger(size) && (size as number) >= 0)) return send({ id, error: 'invalid', message: 'Every put names its size in bytes.' })
    const total = (sizes as number[]).reduce((sum, size) => sum + size, 0)
    if (total !== bytes.length) return send({ id, error: 'invalid', message: `The puts name ${total} bytes, and the request carries ${bytes.length}.` })
    const own = ws.deserializeAttachment() as Attachment
    let at = 0
    const runs = ops.map((op: unknown, index) => {
      const part = bytes.subarray(at, at + (sizes[index] as number))
      at += part.length
      return this.#run(own, op, part).catch((error: unknown): Result => {
        console.error(`The relay failed ${JSON.stringify(op).slice(0, 200)}: ${String(error)}`)
        return { status: 500, error: 'storage', message: String(error) }
      })
    })
    const done = await Promise.all(runs)
    let room = MAX_MESSAGE_BYTES
    const parts: Uint8Array[] = []
    const results: Result[] = []
    for (const result of done) {
      if (!('object' in result)) {
        results.push(result)
        continue
      }
      const { object } = result
      try {
        if (object.size > room) {
          await object.body.cancel()
          results.push({ status: 413, size: object.size, etag: object.etag })
          continue
        }
        parts.push(new Uint8Array(await object.arrayBuffer()))
        room -= object.size
        results.push({ status: 200, etag: object.etag, size: object.size })
      } catch (error) {
        console.error(`The relay failed to read ${object.key}: ${String(error)}`)
        results.push({ status: 500, error: 'storage', message: String(error) })
      }
    }
    send({ id, results }, parts)
  }

  async #run(own: Attachment, value: unknown, bytes: Uint8Array): Promise<Result | Fetched> {
    const invalid = (message: string): Result => ({ status: 400, error: 'invalid', message })
    if (!isRecord(value) || !isText(value['op'])) return invalid('An op names what it does in op.')
    const op = value as Op
    const device = { id: own.device, name: own.name }
    switch (op.op) {
      case 'get': {
        if (!isText(op.key)) return invalid('A get names its key.')
        const unless: unknown = op.if
        if (unless !== undefined && !(isRecord(unless) && isText(unless['noneMatch']))) return invalid('A get\'s if is {"noneMatch":"<etag>"}.')
        const object: R2Object | R2ObjectBody | null = await this.env.BUCKET.get(op.key, op.if === undefined ? {} : { onlyIf: { etagDoesNotMatch: op.if.noneMatch } })
        if (object === null) return { status: 404 }
        return 'body' in object ? { object } : { status: 304, etag: object.etag }
      }
      case 'put': {
        if (!isText(op.key)) return invalid('A put names its key.')
        const condition: unknown = op.if
        if (condition !== undefined && !(isRecord(condition) && (condition['none'] === '*' || isText(condition['match'])))) return invalid('A put\'s if is {"none":"*"} or {"match":"<etag>"}.')
        if (op.holder !== undefined && !isText(op.holder)) return invalid('A put\'s holder names a session.')
        const write = op.holder === undefined ? undefined : this.#startWrite(device, op.holder)
        if (write !== undefined && 'holder' in write) return { status: 409, holder: write.holder }
        const written = await conditionalPut(this.env.BUCKET, op.key, bytes, new Headers(op.if === undefined ? {} : conditionHeaders(op.if))).finally(write?.done)
        if ('stored' in written) return { status: 200, etag: written.stored.etag }
        return written.etag === undefined ? { status: 412 } : { status: 412, etag: written.etag }
      }
      case 'list': {
        if (typeof op.prefix !== 'string') return invalid('A list names its prefix.')
        const page = await this.env.BUCKET.list({ prefix: op.prefix, limit: MAX_KEYS, ...(isText(op.cursor) ? { cursor: op.cursor } : {}) })
        const objects = page.objects.map(({ key, size, uploaded }) => ({ key, size, uploaded: uploaded.getTime() }))
        return page.truncated ? { status: 200, objects, cursor: page.cursor } : { status: 200, objects }
      }
      case 'delete': {
        if (!Array.isArray(op.keys) || !op.keys.every(isText) || op.keys.length > MAX_KEYS) return invalid(`A delete names up to ${MAX_KEYS} keys.`)
        if (op.keys.length > 0) await this.env.BUCKET.delete([...op.keys])
        return { status: 200 }
      }
      case 'claim': {
        if (!isText(op.session) || typeof op.take !== 'boolean') return invalid('A claim names its session and whether it takes it from another machine.')
        const condition: unknown = op.if
        if (condition !== undefined && !(isRecord(condition) && (isText(condition['at']) || condition['gone'] === true))) return invalid('A claim\'s if is {"at":"<the at of the claim it takes>"} or {"gone":true}.')
        return await this.#claim(device, op.session, op.take, op.if)
      }
      case 'claims': {
        if (op.prefix !== undefined && typeof op.prefix !== 'string') return invalid('A claims names the start of the sessions it asks for in prefix.')
        const rows = this.#sql
          .exec<{ session: string; id: string; name: string | null }>(
            "select session, claims.device as id, devices.name from claims left join devices on devices.id = claims.device where session >= ?1 and session < ?1 || x'ff' and claims.device != ''",
            op.prefix ?? '',
          )
          .toArray()
        return { status: 200, claims: Object.fromEntries(rows.map(({ session, id, name }) => [session, { id, name: name ?? id } satisfies DeviceRef])) }
      }
      case 'changes': {
        if (!Number.isInteger(op.since) || op.since < 0) return invalid('A changes names in since the last change number it holds.')
        const rows = this.#sql.exec<{ session: string; device: string; changed: number }>('select session, device, changed from claims where changed > ? order by changed limit ?', op.since, MAX_KEYS).toArray()
        return { status: 200, changes: rows.map(({ session, device: holder, changed }) => ({ t: 'claimed', changed, session, device: holder }) satisfies Claimed), last: this.#changed() }
      }
      case 'forget': {
        if (!isText(op.session)) return invalid('A forget names its session.')
        const held = this.#holderOf(op.session)
        if (held === undefined) return { status: 200 }
        if (held.id !== device.id) return { status: 409, holder: held }
        this.#sql.exec('delete from waiting where session = ?', op.session)
        this.#setHolder(op.session, '', Date.now())
        return { status: 200 }
      }
      case 'devices': {
        const rows = this.#sql.exec<DeviceRow>('select * from devices order by name').toArray()
        const devices = rows.map(({ id, name, os, arch, roots, seen_at, removed_at }) => ({
          id,
          name,
          os,
          arch,
          roots: JSON.parse(roots) as Roots,
          connected: this.ctx.getWebSockets(id).some((socket) => this.#isLive(socket)),
          seenAt: iso(seen_at),
          ...(removed_at === null ? {} : { removedAt: iso(removed_at) }),
        }))
        return { status: 200, devices }
      }
      case 'invite': {
        const code = inviteCode()
        const expiresAt = Date.now() + INVITE_MS
        this.#sql.exec('insert into invites (code_sha256, made_by, expires_at) values (?, ?, ?)', await sha256(code), device.id, expiresAt)
        return { status: 200, link: `${own.origin}/v1/join#${code}`, expiresAt: iso(expiresAt) }
      }
      case 'remove': {
        if (!isText(op.device)) return invalid('A remove names the device id.')
        const row = this.#sql.exec<{ removed_at: number | null }>('select removed_at from devices where id = ?', op.device).toArray()[0]
        if (row === undefined) return { status: 404, error: 'unknown_device', message: `No machine with the id ${op.device} is joined.` }
        if (row.removed_at !== null) return { status: 200 }
        this.#sql.exec('update devices set removed_at = ? where id = ?', Date.now(), op.device)
        this.#sql.exec('delete from waiting where device = ?', op.device)
        for (const socket of this.ctx.getWebSockets(op.device)) socket.close(CLOSE_REMOVED, REMOVED_REASON)
        return { status: 200 }
      }
      default:
        return invalid(`The relay runs no op ${String((op as { op: unknown }).op)}.`)
    }
  }

  async #claim(device: DeviceRef, session: string, take: boolean, condition?: TakeCondition): Promise<Result> {
    const held = this.#holderOf(session)
    const before = this.#sql.exec<{ at: number }>('select at from claims where session = ?', session).toArray()[0]?.at
    const isRefused = (holder: DeviceRef): boolean => {
      if (!take || condition === undefined) return !take
      if ('at' in condition) return iso(before ?? 0) !== condition.at
      return this.ctx.getWebSockets(holder.id).some((socket) => this.#isLive(socket))
    }
    if (held !== undefined && held.id !== device.id && isRefused(held)) return { status: 409, holder: held }
    const isKept = held?.id === device.id && !take
    const at = isKept && before !== undefined ? before : Math.max(Date.now(), (before ?? 0) + 1)
    if (!isKept) this.#setHolder(session, device.id, at)
    this.#sql.exec('delete from waiting where device = ? and session = ?', device.id, session)
    if (held !== undefined && held.id !== device.id) {
      const released = JSON.stringify({ t: 'released', session, to: device, at: iso(at) } satisfies Released)
      this.#sql.exec('insert into waiting (device, session, taker, message, at) values (?, ?, ?, ?, ?)', held.id, session, device.id, released, at)
      this.#deliver(held.id, released)
    }
    if (!take) return { status: 200, told: true, at: iso(at) }
    await Promise.all([...(this.#writes.get(session) ?? [])])
    let untold = this.#untold(session, device.id)
    if (untold !== undefined && this.ctx.getWebSockets(untold.id).some((socket) => this.#isLive(socket))) {
      await this.#heardWithin(untold.id, session, device.id)
      untold = this.#untold(session, device.id)
    }
    return untold === undefined ? { status: 200, told: true, at: iso(at) } : { status: 200, previous: untold, told: false, at: iso(at) }
  }

  #changed(): number {
    return Number(this.#sql.exec<{ value: string }>("select value from meta where key = 'changed'").toArray()[0]?.value ?? 0)
  }

  #untold(session: string, taker: string): DeviceRef | undefined {
    return this.#sql
      .exec<{ id: string; name: string }>(
        "select waiting.device as id, devices.name from waiting join devices on devices.id = waiting.device where waiting.session = ? and waiting.taker = ? and devices.removed_at is null",
        session,
        taker,
      )
      .toArray()[0]
  }

  #heardWithin(holder: string, session: string, taker: string): Promise<void> {
    const key = hearingKey(holder, session, taker)
    const waiters = this.#hearing.get(key) ?? new Set()
    this.#hearing.set(key, waiters)
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(late)
        waiters.delete(done)
        if (waiters.size === 0) this.#hearing.delete(key)
        resolve()
      }
      const late = setTimeout(done, HEARD_MS)
      waiters.add(done)
    })
  }

  #heard(holder: string, session: string, taker: string): void {
    this.#sql.exec('delete from waiting where device = ? and session = ? and taker = ?', holder, session, taker)
    for (const done of [...(this.#hearing.get(hearingKey(holder, session, taker)) ?? [])]) done()
  }
}
