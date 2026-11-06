// The relay end to end: its Worker and Pool run in workerd through Miniflare, with the SQLite Durable Object, an R2
// bucket and real WebSockets, and every test speaks to it over HTTP and WebSockets as a machine does.
// ANYHOST_RELAY_TARGET names a module whose `startRelay` runs the same suite against a deployed relay instead.
// ANYHOST_RELAY_SLOW=1 adds the expired invite, which waits out the invite's 10 minutes.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { bundleRelay } from './build.ts'
import {
  ANSWER,
  CLOSE_DEVICE_LIVE,
  CLOSE_REMOVED,
  CLOSE_UNKNOWN_TOKEN,
  INVITE_MS,
  MAX_MESSAGE_BYTES,
  MAX_OPS,
  PROTOCOL_VERSION,
  RELAY_VERSION,
  REQUEST,
  STREAM,
  cloneFixFor,
  decodeMessage,
  encodeMessage,
  encodeStream,
  streamOf,
  type Condition,
  type JoiningDevice,
  type Op,
  type Roots,
} from './protocol.ts'

// A relay whose Pool never started, with `objects` in its bucket and the setup code's sha256 as its secret.
export type TestRelay = {
  readonly url: () => string
  readonly bucket: string
  // uploads a new setup code's sha256, as setup run again does
  setSetupCode(code: string): Promise<void>
  stop(): Promise<void>
}
export type StartRelay = (seed: { readonly objects: Readonly<Record<string, string>>; readonly setupCode: string }) => Promise<TestRelay>

const COMPATIBILITY_DATE = '2026-11-01'
const BUCKET = 'anyhost-test'

const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex')
const md5 = (bytes: Uint8Array | string): string => new Bun.CryptoHasher('md5').update(bytes).digest('hex')
const hex = (size: number): string => Buffer.from(crypto.getRandomValues(new Uint8Array(size))).toString('hex')
const bytesOf = (size: number, fill = 7): Uint8Array => new Uint8Array(size).fill(fill)

const startLocal: StartRelay = async ({ objects, setupCode }) => {
  const folder = mkdtempSync(join(tmpdir(), 'anyhost-relay-'))
  const contents = await bundleRelay()
  // Miniflare 5 still reads the flat options of Miniflare 4, through its own converter.
  const options = (code: string) =>
    convertV4MiniflareOptions({
      modules: [{ type: 'ESModule', path: 'relay.js', contents }],
      compatibilityDate: COMPATIBILITY_DATE,
      durableObjects: { POOL: { className: 'Pool', useSQLite: true } },
      r2Buckets: { BUCKET },
      bindings: { BUCKET_NAME: BUCKET, SETUP_CODE_SHA256: sha256(code) },
      // the bucket and the Pool's database outlive setOptions, as they outlive a new secret in Cloudflare
      resourcePersistencePath: folder,
    })
  let miniflare = new Miniflare(options(setupCode))
  const bucket = await miniflare.getR2Bucket('BUCKET')
  for (const [key, body] of Object.entries(objects)) await bucket.put(key, body)
  let url = (await miniflare.ready).origin
  return {
    url: () => url,
    bucket: BUCKET,
    // Miniflare's setOptions fails under Bun (`runtimeDispatcher.close is not a function`), so a new secret starts a
    // new workerd on the same folders
    async setSetupCode(code) {
      await miniflare.dispose()
      miniflare = new Miniflare(options(code))
      url = (await miniflare.ready).origin
    },
    async stop() {
      await miniflare.dispose()
      rmSync(folder, { recursive: true, force: true })
    },
  }
}

const target = process.env['ANYHOST_RELAY_TARGET']
const startRelay: StartRelay = target === undefined ? startLocal : ((await import(target)) as { startRelay: StartRelay }).startRelay

setDefaultTimeout(60_000)

const run = hex(4)
const prefix = `relay-test/${run}/`
const roots = (home: string) => ({ home, claudeHome: `${home}/.claude`, claudeTmp: '/tmp/claude-1000', codexHome: `${home}/.codex` })
const machine = (name: string, os = 'linux'): JoiningDevice => ({ id: hex(16), name: `${name}-${run}`, os, arch: 'arm64', roots: roots(`/home/${name}`) })

type Json = Record<string, any>
type Message = Json | Uint8Array

// One machine's socket, whose messages wait in its inbox until a test takes them.
class Socket {
  readonly ws: WebSocket
  readonly closed: Promise<{ code: number; reason: string }>
  readonly #inbox: Message[] = []
  #wake = (): void => undefined
  #id = 0

  constructor(url: string, token: string, name: string, roots: Roots) {
    // Bun's WebSocket takes headers, which the Workers types' WebSocket, loaded beside Bun's, does not name
    const headers = { authorization: `Bearer ${token}`, 'x-anyhost-name': name, 'x-anyhost-version': '0.0.0-test', 'x-anyhost-roots': JSON.stringify(roots) }
    this.ws = new WebSocket(`${url.replace(/^http/, 'ws')}/v1/connect`, { headers } as any)
    this.ws.binaryType = 'arraybuffer'
    this.ws.addEventListener('message', (event) => {
      this.#inbox.push(typeof event.data === 'string' ? (event.data === 'pong' ? { t: 'pong' } : (JSON.parse(event.data) as Json)) : new Uint8Array(event.data as ArrayBuffer))
      this.#wake()
    })
    this.closed = new Promise((resolve) => this.ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })))
  }

  // the next message `match` accepts, from those that came already or the ones still to come
  async next(match: (message: Message) => boolean, what: string, ms = 15_000): Promise<Message> {
    const until = Date.now() + ms
    for (;;) {
      const index = this.#inbox.findIndex(match)
      if (index >= 0) return this.#inbox.splice(index, 1)[0]!
      if (Date.now() > until) throw new Error(`No ${what} came within ${ms} ms. The inbox holds ${JSON.stringify(this.#inbox.map((m) => (m instanceof Uint8Array ? `${m.length} bytes` : m)))}.`)
      await new Promise<void>((resolve) => {
        this.#wake = resolve
        setTimeout(resolve, 100)
      })
    }
  }

  async message(t: string): Promise<Json> {
    return (await this.next((m) => !(m instanceof Uint8Array) && m['t'] === t, `${t} message`)) as Json
  }

  // nothing of type `t` arrives within `ms`
  async none(t: string, ms = 1500): Promise<void> {
    await Bun.sleep(ms)
    expect(this.#inbox.filter((m) => !(m instanceof Uint8Array) && m['t'] === t)).toEqual([])
  }

  send(message: Json | Uint8Array | string): void {
    this.ws.send(message instanceof Uint8Array || typeof message === 'string' ? message : JSON.stringify(message))
  }

  // Sends one request and answers its header and each get's bytes, in the order of its gets.
  async request(ops: readonly Op[], parts: readonly Uint8Array[] = []): Promise<{ answer: Json; gets: Uint8Array[] }> {
    const id = ++this.#id
    this.send(encodeMessage(REQUEST, { id, ops }, parts))
    return this.answer(id)
  }

  async answer(id: number | null): Promise<{ answer: Json; gets: Uint8Array[] }> {
    const message = (await this.next((m) => m instanceof Uint8Array && m[0] === ANSWER && (decodeMessage(m).header as Json)['id'] === id, `answer ${id}`)) as Uint8Array
    const { header, bytes } = decodeMessage(message)
    const answer = header as Json
    const gets: Uint8Array[] = []
    let at = 0
    for (const result of answer['results'] ?? []) {
      if (result.status !== 200 || result.size === undefined || result.modified === undefined) continue
      gets.push(bytes.subarray(at, at + result.size))
      at += result.size
    }
    expect(at).toBe(bytes.length)
    return { answer, gets }
  }

  // the results of one request's ops
  async results(...ops: Op[]): Promise<Json[]> {
    const { answer } = await this.request(ops)
    expect(answer['error']).toBeUndefined()
    return answer['results']
  }

  close(): void {
    this.ws.close()
  }
}

let relay: TestRelay
const sockets: Socket[] = []
const url = (path: string): string => `${relay.url()}${path}`
const post = (path: string, body: unknown): Promise<Response> => fetch(url(path), { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
async function json(response: Response): Promise<Json> {
  const text = await response.text()
  try {
    return { status: response.status, ...(JSON.parse(text) as Json) }
  } catch {
    throw new Error(`${response.url} answered ${response.status} with no JSON: ${text.slice(0, 300)}`)
  }
}

async function connect(token: string, name: string, roots: Roots): Promise<Socket> {
  const socket = new Socket(relay.url(), token, name, roots)
  sockets.push(socket)
  await new Promise((resolve, reject) => {
    socket.ws.addEventListener('open', resolve)
    socket.ws.addEventListener('error', () => reject(new Error(`The socket of ${name} failed to open.`)))
  })
  return socket
}

type Joined = { device: JoiningDevice; token: string; socket: Socket }

async function joinWith(code: string, device: JoiningDevice): Promise<Joined> {
  const answer = await json(await post('/v1/join', { invite: code, device }))
  expect(answer).toMatchObject({ status: 200, device: { id: device.id, name: device.name }, relay: RELAY_VERSION, protocol: PROTOCOL_VERSION, bucket: relay.bucket })
  const socket = await connect(answer['token'], device.name, device.roots)
  expect(await socket.message('welcome')).toMatchObject({ device: { id: device.id, name: device.name }, waiting: [] })
  return { device, token: answer['token'], socket }
}

const codeOf = (link: string): string => link.slice(link.indexOf('#') + 1)
async function invite(by: Joined): Promise<string> {
  const [made] = await by.socket.results({ op: 'invite' })
  return codeOf(made!['link'])
}
const joinNew = async (by: Joined, name: string, os?: string): Promise<Joined> => joinWith(await invite(by), machine(name, os))

const objectUrl = (key: string): string => url(`/v1/objects/${key.split('/').map(encodeURIComponent).join('/')}`)
const putObject = (token: string, key: string, body: Uint8Array | string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(objectUrl(key), { method: 'PUT', body, headers: { authorization: `Bearer ${token}`, ...headers } })
const getObject = (token: string, key: string, headers: Record<string, string> = {}): Promise<Response> => fetch(objectUrl(key), { headers: { authorization: `Bearer ${token}`, ...headers } })

// What the bucket held before anyhost had a relay: one record per machine and per claim, which the Pool's first
// start moves into SQLite.
const imported = {
  mac: { id: hex(16), record: { name: `mac-${run}`, os: 'darwin', arch: 'arm64', ssh: `mac-${run}`, ...roots('/Users/jordan') } },
  // anyhost 0.1 wrote no claudeHome
  old: { id: hex(16), record: { name: `old-${run}`, os: 'linux', arch: 'x64', ssh: `old-${run}`, home: '/home/old', claudeTmp: '/tmp/claude-1000', codexHome: '/home/old/.codex' } },
  session: crypto.randomUUID(),
  broken: hex(16),
}
const firstCode = hex(32)
let mac: Joined

beforeAll(async () => {
  relay = await startRelay({
    setupCode: firstCode,
    objects: {
      [`devices/${imported.mac.id}.json`]: JSON.stringify(imported.mac.record),
      [`devices/${imported.old.id}.json`]: JSON.stringify(imported.old.record),
      [`devices/${imported.broken}.json`]: '{"name":',
      [`claims/${imported.session}.json`]: JSON.stringify({ device: imported.old.id, at: '2026-11-05T06:52:05.684Z' }),
    },
  })
  // the Pool's first start, which imports the records, is the first machine's join
  mac = await joinWith(firstCode, { id: imported.mac.id, ...imported.mac.record, roots: roots('/Users/jordan') })
  // A target that deploys a relay waits for its route to settle: a Worker deployed again after its deletion answered
  // Cloudflare's 404 page now and then for 41 seconds.
}, 300_000)

// The objects the tests wrote leave the bucket, as a deployed relay's bucket outlives the run.
afterAll(async () => {
  if (mac !== undefined) {
    const cleaner = await connect(mac.token, mac.device.name, mac.device.roots)
    for (;;) {
      const [listed] = await cleaner.results({ op: 'list', prefix })
      const keys = (listed!['objects'] as Json[]).map((object) => object['key'] as string)
      if (keys.length === 0) break
      await cleaner.results({ op: 'delete', keys })
    }
  }
  for (const socket of sockets) socket.close()
  await relay?.stop()
})

describe('the first start', () => {
  test('imports devices/ and claims/ into SQLite and deletes them from R2, leaving a record it cannot read', async () => {
    const [devices, claims, devicesLeft, claimsLeft] = await mac.socket.results({ op: 'devices' }, { op: 'claims' }, { op: 'list', prefix: 'devices/' }, { op: 'list', prefix: 'claims/' })
    const byId = new Map((devices!['devices'] as Json[]).map((device) => [device['id'], device]))
    expect(byId.get(imported.mac.id)).toMatchObject({ name: imported.mac.record.name, os: 'darwin', connected: true, roots: roots('/Users/jordan') })
    expect(byId.get(imported.old.id)).toMatchObject({ name: imported.old.record.name, os: 'linux', arch: 'x64', connected: false, roots: roots('/home/old') })
    expect(claims!['claims'][imported.session]).toEqual({ id: imported.old.id, name: imported.old.record.name, at: '2026-11-05T06:52:05.684Z' })
    const keysLeft = [...devicesLeft!['objects'], ...claimsLeft!['objects']].map((object: Json) => object['key'])
    expect(keysLeft).toContain(`devices/${imported.broken}.json`)
    for (const key of [`devices/${imported.mac.id}.json`, `devices/${imported.old.id}.json`, `claims/${imported.session}.json`]) expect(keysLeft).not.toContain(key)
    expect(await mac.socket.results({ op: 'delete', keys: [`devices/${imported.broken}.json`] })).toEqual([{ status: 200 }])
  })
})

describe('HTTP', () => {
  test('/v1/health names the relay, its protocol and its bucket without a token', async () => {
    expect(await json(await fetch(url('/v1/health')))).toEqual({ status: 200, relay: RELAY_VERSION, protocol: PROTOCOL_VERSION, bucket: relay.bucket })
  })

  test('a route the relay lacks answers 404', async () => {
    expect(await json(await fetch(url('/v2/health')))).toMatchObject({ status: 404, error: 'missing' })
  })
})

describe('joining', () => {
  test('a setup code joins one machine, and the next setup code joins one more', async () => {
    const used = await json(await post('/v1/join', { invite: firstCode, device: machine('second') }))
    expect(used).toMatchObject({ status: 403, error: 'invite_used' })
    expect(used['message']).toContain(mac.device.name)
    const nextCode = hex(32)
    await relay.setSetupCode(nextCode)
    // the restart dropped the first machine's socket
    mac.socket = await connect(mac.token, mac.device.name, mac.device.roots)
    await joinWith(nextCode, machine('setup'))
    expect(await json(await post('/v1/join', { invite: nextCode, device: machine('third') }))).toMatchObject({ status: 403, error: 'invite_used' })
    expect(await json(await post('/v1/join', { invite: firstCode, device: machine('third') }))).toMatchObject({ status: 403, error: 'invite_used' })
  })

  test('an invite joins one machine within 10 minutes, and is refused when used or unknown', async () => {
    const [made] = await mac.socket.results({ op: 'invite' })
    expect(made!['link']).toStartWith(`${relay.url()}/v1/join#`)
    expect(codeOf(made!['link'])).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(Date.parse(made!['expiresAt']) - Date.now()).toBeWithin(INVITE_MS - 60_000, INVITE_MS + 1)
    const joined = await joinWith(codeOf(made!['link']), machine('invited'))
    const used = await json(await post('/v1/join', { invite: codeOf(made!['link']), device: machine('late') }))
    expect(used).toMatchObject({ status: 403, error: 'invite_used' })
    expect(used['message']).toContain(joined.device.name)
    expect(await json(await post('/v1/join', { invite: 'K7QX2M4W9TPR6ZC3HN8JD5VB00', device: machine('stranger') }))).toMatchObject({ status: 403, error: 'invite_unknown' })
    expect(await json(await post('/v1/join', { invite: codeOf(made!['link']) }))).toMatchObject({ status: 400, error: 'invalid' })
  })

  test.skipIf(process.env['ANYHOST_RELAY_SLOW'] !== '1')(
    'an invite 10 minutes old is refused as expired',
    async () => {
      const code = await invite(mac)
      await Bun.sleep(INVITE_MS + 5_000)
      const expired = await json(await post('/v1/join', { invite: code, device: machine('slow') }))
      expect(expired).toMatchObject({ status: 403, error: 'invite_expired' })
    },
    INVITE_MS + 60_000,
  )

  test('a machine with a connected machine\'s id and another name, a clone, is refused with the fix', async () => {
    const original = await joinNew(mac, 'original', 'darwin')
    const clone = { ...original.device, name: `clone-${run}` }
    const refused = await json(await post('/v1/join', { invite: await invite(mac), device: clone }))
    expect(refused).toMatchObject({ status: 409, error: 'device_live' })
    expect(refused['message']).toContain(original.device.name)
    expect(refused['message']).toContain(cloneFixFor('darwin'))
    const cloned = await connect(original.token, clone.name, clone.roots)
    expect(await cloned.closed).toMatchObject({ code: CLOSE_DEVICE_LIVE })
    // the original keeps working
    expect(await original.socket.results({ op: 'claims' })).toMatchObject([{ status: 200 }])
  })

  test('a machine that connects under a new name while no socket holds the old one was renamed', async () => {
    const renamed = await joinNew(mac, 'before')
    renamed.socket.close()
    await renamed.socket.closed
    const after = await connect(renamed.token, `after-${run}`, renamed.device.roots)
    expect(await after.message('welcome')).toMatchObject({ device: { id: renamed.device.id, name: `after-${run}` } })
    const [devices] = await mac.socket.results({ op: 'devices' })
    expect((devices!['devices'] as Json[]).find((device) => device['id'] === renamed.device.id)).toMatchObject({ name: `after-${run}`, connected: true })
  })

  test('each connect brings the machine\'s roots, which devices answers from then on, and a connect without them is refused', async () => {
    const moved = await joinNew(mac, 'moved')
    moved.socket.close()
    await moved.socket.closed
    const now = { ...moved.device.roots, claudeHome: '/srv/claude-config', claudeTmp: '/var/tmp/claude-1000' }
    const back = await connect(moved.token, moved.device.name, now)
    await back.message('welcome')
    const [devices] = await mac.socket.results({ op: 'devices' })
    expect((devices!['devices'] as Json[]).find((device) => device['id'] === moved.device.id)).toMatchObject({ roots: now, connected: true })
    const bare = await fetch(url('/v1/connect'), { headers: { upgrade: 'websocket', authorization: `Bearer ${moved.token}`, 'x-anyhost-name': moved.device.name } })
    expect(await json(bare)).toMatchObject({ status: 400, error: 'invalid', message: 'A connect names its machine\'s roots as JSON in X-Anyhost-Roots.' })
  })
})

describe('the socket', () => {
  test('answers ping with pong', async () => {
    mac.socket.send('ping')
    expect(await mac.socket.message('pong')).toEqual({ t: 'pong' })
  })

  test('closes an unknown token with 4401', async () => {
    const stranger = await connect(hex(32), 'stranger', roots('/home/stranger'))
    expect(await stranger.closed).toMatchObject({ code: CLOSE_UNKNOWN_TOKEN })
  })

  test('refuses a request over the limits whole', async () => {
    const tooMany = await mac.socket.request(Array.from({ length: MAX_OPS + 1 }, () => ({ op: 'claims' }) as const))
    expect(tooMany.answer).toMatchObject({ error: 'too_large' })
    const tooBig = await mac.socket.request([{ op: 'put', key: `${prefix}big`, size: MAX_MESSAGE_BYTES + 1 }], [bytesOf(MAX_MESSAGE_BYTES + 1)])
    expect(tooBig.answer).toMatchObject({ error: 'too_large' })
    const short = await mac.socket.request([{ op: 'put', key: `${prefix}short`, size: 10 }], [bytesOf(4)])
    expect(short.answer).toMatchObject({ error: 'invalid' })
    const [unknown] = await mac.socket.results({ op: 'rename' } as unknown as Op)
    expect(unknown).toMatchObject({ status: 400, error: 'invalid' })
  })
})

describe('ops', () => {
  test('put stores, and get answers the bytes with etag, size and modified time, or 404', async () => {
    const key = `${prefix}ops/a.txt`
    const { answer } = await mac.socket.request([{ op: 'put', key, size: 5 }], [new TextEncoder().encode('hello')])
    expect(answer['results']).toEqual([{ status: 200, etag: md5('hello') }])
    const { answer: got, gets } = await mac.socket.request([{ op: 'get', key }, { op: 'get', key: `${prefix}ops/none` }])
    expect(got['results'][0]).toMatchObject({ status: 200, etag: md5('hello'), size: 5 })
    expect(Math.abs(Date.parse(got['results'][0].modified) - Date.now())).toBeLessThan(120_000)
    expect(got['results'][1]).toEqual({ status: 404 })
    expect(new TextDecoder().decode(gets[0])).toBe('hello')
  })

  test('put with if none or if match stores only when it holds, and a refusal names the etag there', async () => {
    const key = `${prefix}ops/conditional.txt`
    const put = async (body: string, condition: Condition): Promise<Json> =>
      (await mac.socket.request([{ op: 'put', key, size: body.length, if: condition }], [new TextEncoder().encode(body)])).answer['results'][0]
    expect(await put('one', { none: '*' })).toEqual({ status: 200, etag: md5('one') })
    expect(await put('two', { none: '*' })).toEqual({ status: 412, etag: md5('one') })
    expect(await put('three', { match: md5('one') })).toEqual({ status: 200, etag: md5('three') })
    expect(await put('four', { match: md5('one') })).toEqual({ status: 412, etag: md5('three') })
    expect(await put('five', { match: md5('five') })).toEqual({ status: 412, etag: md5('three') })
  })

  test('an answer carries get bytes up to 1 MiB, and answers 413 with size and etag for the rest', async () => {
    const big = bytesOf(700 * 1024, 1)
    const [first, second] = [`${prefix}ops/big-1`, `${prefix}ops/big-2`]
    const { answer: stored } = await mac.socket.request([{ op: 'put', key: first, size: big.length }], [big])
    expect(stored['results']).toEqual([{ status: 200, etag: md5(big) }])
    // two of them are past one message, so the second goes up as its own object
    expect((await putObject(mac.token, second, big)).status).toBe(200)
    const { answer, gets } = await mac.socket.request([{ op: 'get', key: first }, { op: 'get', key: second }])
    expect(answer['results']).toEqual([
      { status: 200, etag: md5(big), size: big.length, modified: expect.any(String) },
      { status: 413, etag: md5(big), size: big.length },
    ])
    expect(gets[0]).toEqual(big)
  })

  test('list answers keys, sizes and modified times up to 1,000 at a time, with a cursor while more remain', async () => {
    const folder = `${prefix}ops/list/`
    for (let at = 0; at < 1001; at += MAX_OPS) {
      const ops = Array.from({ length: Math.min(MAX_OPS, 1001 - at) }, (_, index) => ({ op: 'put', key: `${folder}${String(at + index).padStart(4, '0')}`, size: 1 }) as const)
      const { answer } = await mac.socket.request(ops, [bytesOf(ops.length)])
      expect((answer['results'] as Json[]).every((result) => result['status'] === 200)).toBe(true)
    }
    // R2 may answer fewer than 1,000 keys on a page that is not the last
    const pages: Json[] = []
    let cursor: string | undefined
    do {
      const [page] = await mac.socket.results({ op: 'list', prefix: folder, ...(cursor === undefined ? {} : { cursor }) })
      expect(page!['objects'].length).toBeLessThanOrEqual(1000)
      pages.push(page!)
      cursor = page!['cursor']
    } while (cursor !== undefined)
    expect(pages.length).toBeGreaterThan(1)
    const objects = pages.flatMap((page) => page['objects'] as Json[])
    expect(objects[0]).toEqual({ key: `${folder}0000`, size: 1, modified: expect.any(String) })
    const keys = objects.map((object) => object['key'] as string)
    expect(keys).toEqual(Array.from({ length: 1001 }, (_, index) => `${folder}${String(index).padStart(4, '0')}`))
    const [tooMany] = await mac.socket.results({ op: 'delete', keys })
    expect(tooMany).toMatchObject({ status: 400, error: 'invalid' })
    expect(await mac.socket.results({ op: 'delete', keys: keys.slice(0, 1000) }, { op: 'delete', keys: keys.slice(1000) })).toEqual([{ status: 200 }, { status: 200 }])
    const [empty] = await mac.socket.results({ op: 'list', prefix: folder })
    expect(empty).toEqual({ status: 200, objects: [] })
  })

  test('claim takes a free session, refuses one another machine holds, and takes it over with take', async () => {
    const other = await joinNew(mac, 'claimer')
    const session = crypto.randomUUID()
    expect(await mac.socket.results({ op: 'claim', session, take: false })).toEqual([{ status: 200, told: true }])
    expect(await mac.socket.results({ op: 'claim', session, take: false })).toEqual([{ status: 200, told: true }])
    expect(await other.socket.results({ op: 'claim', session, take: false })).toEqual([{ status: 409, holder: { id: mac.device.id, name: mac.device.name } }])
    expect(await other.socket.results({ op: 'claim', session, take: true })).toEqual([{ status: 200, previous: { id: mac.device.id, name: mac.device.name }, told: true }])
    expect(await mac.socket.message('released')).toEqual({ t: 'released', session, to: { id: other.device.id, name: other.device.name }, at: expect.any(String) })
    const [claims] = await mac.socket.results({ op: 'claims' })
    expect(claims!['claims'][session]).toEqual({ id: other.device.id, name: other.device.name, at: expect.any(String) })
  })

  test('devices lists every joined machine with its roots and whether it is connected', async () => {
    const [devices] = await mac.socket.results({ op: 'devices' })
    expect((devices!['devices'] as Json[]).find((device) => device['id'] === mac.device.id)).toEqual({
      id: mac.device.id,
      name: mac.device.name,
      os: 'darwin',
      arch: 'arm64',
      roots: roots('/Users/jordan'),
      connected: true,
      joinedAt: expect.any(String),
      seenAt: expect.any(String),
    })
  })
})

describe('objects over HTTP', () => {
  test('PUT /v1/objects honours If-None-Match and If-Match, and needs a Content-Length', async () => {
    const key = `${prefix}http/frame.zst`
    expect(await json(await putObject(mac.token, key, 'first', { 'if-none-match': '*' }))).toEqual({ status: 200, etag: md5('first'), size: 5 })
    expect(await json(await putObject(mac.token, key, 'again', { 'if-none-match': '*' }))).toMatchObject({ status: 412, error: 'precondition', etag: md5('first') })
    expect(await json(await putObject(mac.token, key, 'second', { 'if-match': `"${md5('first')}"` }))).toEqual({ status: 200, etag: md5('second'), size: 6 })
    expect(await json(await putObject(mac.token, key, 'third', { 'if-match': `"${md5('first')}"` }))).toMatchObject({ status: 412, etag: md5('second') })
    const unsized = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('no length'))
        controller.close()
      },
    })
    const chunked = await json(await fetch(objectUrl(`${key}.chunked`), { method: 'PUT', body: unsized, headers: { authorization: `Bearer ${mac.token}` } }))
    // workerd hands the Worker a chunked body without a length, which R2 refuses, while Cloudflare takes the whole
    // body first and names its length
    if (target === undefined) expect(chunked).toMatchObject({ status: 411, error: 'length_required' })
    else expect(chunked).toEqual({ status: 200, etag: md5('no length'), size: 9 })
  })

  test('GET /v1/objects streams the object with ETag, Content-Length and Last-Modified, and a Range of it', async () => {
    const key = `${prefix}http/range.bin`
    const body = Uint8Array.from({ length: 256 }, (_, index) => index)
    expect((await putObject(mac.token, key, body)).status).toBe(200)
    const whole = await getObject(mac.token, key)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('etag')).toBe(`"${md5(body)}"`)
    expect(whole.headers.get('content-length')).toBe('256')
    expect(Date.parse(whole.headers.get('last-modified') ?? '')).not.toBeNaN()
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(body)
    const part = await getObject(mac.token, key, { range: 'bytes=10-19' })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 10-19/256')
    expect(part.headers.get('content-length')).toBe('10')
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(body.subarray(10, 20))
    const rest = await getObject(mac.token, key, { range: 'bytes=250-' })
    expect(rest.headers.get('content-range')).toBe('bytes 250-255/256')
    expect(new Uint8Array(await rest.arrayBuffer())).toEqual(body.subarray(250))
    const tail = await getObject(mac.token, key, { range: 'bytes=-4' })
    expect(tail.headers.get('content-range')).toBe('bytes 252-255/256')
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(body.subarray(252))
    expect(await json(await getObject(mac.token, key, { range: 'bytes=300-' }))).toMatchObject({ status: 416 })
    expect(await json(await getObject(mac.token, key, { range: 'bytes=0-1,5-6' }))).toMatchObject({ status: 416 })
    expect(await json(await getObject(mac.token, `${prefix}http/none`))).toMatchObject({ status: 404, error: 'missing' })
  })

  test('an unknown token is refused with 401', async () => {
    expect(await json(await getObject(hex(32), `${prefix}http/range.bin`))).toMatchObject({ status: 401, error: 'unknown_token' })
    expect(await json(await putObject(hex(32), `${prefix}http/x`, 'x'))).toMatchObject({ status: 401, error: 'unknown_token' })
  })
})

describe('the holder', () => {
  test('a put with holder is refused with 409 once another machine took the session, on the socket and over HTTP', async () => {
    const taker = await joinNew(mac, 'taker')
    const session = crypto.randomUUID()
    const frame = (start: number): string => `${prefix}journals/${session}/hot/${String(start).padStart(16, '0')}.zst`
    expect(await mac.socket.results({ op: 'claim', session, take: false })).toEqual([{ status: 200, told: true }])
    const { answer: written } = await mac.socket.request([{ op: 'put', key: frame(0), size: 3, if: { none: '*' }, holder: session }], [bytesOf(3)])
    expect(written['results']).toEqual([{ status: 200, etag: md5(bytesOf(3)) }])
    expect((await putObject(mac.token, frame(3), 'abc', { 'if-none-match': '*', 'x-anyhost-holder': session })).status).toBe(200)
    // a session nobody claimed takes any machine's frames
    expect((await putObject(taker.token, `${prefix}free`, 'abc', { 'x-anyhost-holder': crypto.randomUUID() })).status).toBe(200)
    expect(await taker.socket.results({ op: 'claim', session, take: true })).toMatchObject([{ status: 200, previous: { id: mac.device.id }, told: true }])
    const { answer: refused } = await mac.socket.request([{ op: 'put', key: frame(6), size: 3, if: { none: '*' }, holder: session }], [bytesOf(3)])
    expect(refused['results']).toEqual([{ status: 409, holder: { id: taker.device.id, name: taker.device.name } }])
    expect(await json(await putObject(mac.token, frame(6), 'abc', { 'if-none-match': '*', 'x-anyhost-holder': session }))).toMatchObject({
      status: 409,
      error: 'held',
      holder: { id: taker.device.id, name: taker.device.name },
    })
    const [listed] = await taker.socket.results({ op: 'list', prefix: `${prefix}journals/${session}/` })
    expect((listed!['objects'] as Json[]).map((object) => object['key'])).toEqual([frame(0), frame(3)])
  })

  test('a takeover answers only after the frame a streaming PUT is writing landed, or that PUT is refused', async () => {
    const taker = await joinNew(mac, 'waiter')
    const session = crypto.randomUUID()
    const key = `${prefix}journals/${session}/hot/0000000000000000.zst`
    expect(await mac.socket.results({ op: 'claim', session, take: false })).toEqual([{ status: 200, told: true }])
    // the body arrives over 3 seconds, so the frame's write is in flight while the takeover runs
    const size = 64 * 1024
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let sent = 0; sent < size; sent += 8 * 1024) {
          controller.enqueue(bytesOf(8 * 1024, 3))
          await Bun.sleep(375)
        }
        controller.close()
      },
    })
    const putting = fetch(objectUrl(key), { method: 'PUT', body, headers: { authorization: `Bearer ${mac.token}`, 'content-length': String(size), 'x-anyhost-holder': session } }).then(async (response) => ({
      status: response.status,
      at: performance.now(),
    }))
    await Bun.sleep(1000)
    const takeAt = performance.now()
    const [taken] = await taker.socket.results({ op: 'claim', session, take: true })
    const takenAt = performance.now()
    expect(taken).toMatchObject({ status: 200, previous: { id: mac.device.id } })
    const put = await putting
    const [got] = await taker.socket.results({ op: 'get', key })
    if (put.status === 200) {
      // the takeover waited out the 2 seconds of body left, and the new holder reads the frame
      expect(takenAt - takeAt).toBeGreaterThan(1000)
      expect(put.at).toBeLessThanOrEqual(takenAt + 50)
      expect(got).toMatchObject({ status: 200, size })
    } else {
      // Cloudflare took the whole body before the Worker ran, which asked the Pool after the takeover
      expect(put.status).toBe(409)
      expect(got).toEqual({ status: 404 })
    }
    console.log(`The streaming PUT answered ${put.status} at ${Math.round(put.at - takeAt)} ms, and the takeover at ${Math.round(takenAt - takeAt)} ms.`)
  })

  test('a takeover waits for the frames a request is writing on the socket', async () => {
    const taker = await joinNew(mac, 'socket-waiter')
    const session = crypto.randomUUID()
    const frame = bytesOf(MAX_MESSAGE_BYTES - 64, 5)
    const key = `${prefix}journals/${session}/hot/0000000000000000.zst`
    expect(await mac.socket.results({ op: 'claim', session, take: false })).toEqual([{ status: 200, told: true }])
    const writing = mac.socket.request([{ op: 'put', key, size: frame.length, if: { none: '*' }, holder: session }], [frame])
    const [taken] = await taker.socket.results({ op: 'claim', session, take: true })
    const [got] = await taker.socket.results({ op: 'get', key })
    const { answer } = await writing
    if (answer['results'][0].status === 200) expect(got).toMatchObject({ status: 200, size: frame.length })
    else expect(answer['results'][0]).toMatchObject({ status: 409, holder: { id: taker.device.id } })
    expect(taken).toMatchObject({ status: 200, previous: { id: mac.device.id } })
  })

  test('released reaches an offline machine in its next welcome', async () => {
    const away = await joinNew(mac, 'away')
    const session = crypto.randomUUID()
    expect(await away.socket.results({ op: 'claim', session, take: false })).toEqual([{ status: 200, told: true }])
    away.socket.close()
    await away.socket.closed
    // the Pool hears the close a moment after the machine does
    await Bun.sleep(500)
    expect(await mac.socket.results({ op: 'claim', session, take: true })).toEqual([{ status: 200, previous: { id: away.device.id, name: away.device.name }, told: false }])
    const back = await connect(away.token, away.device.name, away.device.roots)
    expect(await back.message('welcome')).toMatchObject({ waiting: [{ t: 'released', session, to: { id: mac.device.id, name: mac.device.name }, at: expect.any(String) }] })
    back.close()
    await back.closed
    const again = await connect(away.token, away.device.name, away.device.roots)
    expect(await again.message('welcome')).toMatchObject({ waiting: [] })
  })
})

describe('remove', () => {
  test('closes the machine\'s sockets with 4403 and refuses its token on every route, until it joins again', async () => {
    const gone = await joinNew(mac, 'gone')
    const second = await connect(gone.token, gone.device.name, gone.device.roots)
    await second.message('welcome')
    expect(await mac.socket.results({ op: 'remove', device: gone.device.id })).toEqual([{ status: 200 }])
    expect(await gone.socket.closed).toMatchObject({ code: CLOSE_REMOVED })
    expect(await second.closed).toMatchObject({ code: CLOSE_REMOVED })
    expect(await json(await getObject(gone.token, `${prefix}http/range.bin`))).toMatchObject({ status: 403, error: 'removed' })
    expect(await json(await putObject(gone.token, `${prefix}gone`, 'x'))).toMatchObject({ status: 403, error: 'removed' })
    const refused = await connect(gone.token, gone.device.name, gone.device.roots)
    expect(await refused.closed).toMatchObject({ code: CLOSE_REMOVED })
    expect(await mac.socket.results({ op: 'remove', device: gone.device.id })).toMatchObject([{ status: 404, error: 'unknown_device' }])
    const rejoined = await joinWith(await invite(mac), gone.device)
    expect((await getObject(rejoined.token, `${prefix}http/range.bin`)).status).toBe(200)
    expect(await json(await getObject(gone.token, `${prefix}http/range.bin`))).toMatchObject({ status: 401 })
  })

  test('devices answers a removed machine with when it was removed and the roots its sessions were written at', async () => {
    const gone = await joinNew(mac, 'removed')
    const removedAt = Date.now()
    expect(await mac.socket.results({ op: 'remove', device: gone.device.id })).toEqual([{ status: 200 }])
    const [devices] = await mac.socket.results({ op: 'devices' })
    const listed = (devices!['devices'] as Json[]).find((device) => device['id'] === gone.device.id)
    expect(Math.abs(Date.parse(listed!['removedAt']) - removedAt)).toBeLessThan(120_000)
    expect(listed).toMatchObject({ name: gone.device.name, roots: gone.device.roots, connected: false })
    expect((devices!['devices'] as Json[]).find((device) => device['id'] === mac.device.id)).not.toHaveProperty('removedAt')
    await joinWith(await invite(mac), gone.device)
    const [again] = await mac.socket.results({ op: 'devices' })
    expect((again!['devices'] as Json[]).find((device) => device['id'] === gone.device.id)).not.toHaveProperty('removedAt')
  })
})

describe('messages between machines', () => {
  test('move and moved reach the other machine with from, and a message to a machine with no socket answers offline', async () => {
    const target = await joinNew(mac, 'target')
    const session = crypto.randomUUID()
    mac.socket.send({ t: 'move', id: 'm1', to: target.device.id, session, t3: false, trusted: true })
    expect(await target.socket.message('move')).toEqual({ t: 'move', id: 'm1', to: target.device.id, session, t3: false, trusted: true, from: { id: mac.device.id, name: mac.device.name } })
    target.socket.send({ t: 'moved', id: 'm1', to: mac.device.id, ok: true })
    expect(await mac.socket.message('moved')).toEqual({ t: 'moved', id: 'm1', to: mac.device.id, ok: true, from: { id: target.device.id, name: target.device.name } })
    mac.socket.send({ t: 'move', id: 'm2', to: imported.old.id, session, t3: false, trusted: true })
    expect(await mac.socket.message('offline')).toEqual({ t: 'offline', id: 'm2', to: imported.old.id })
    mac.socket.send({ t: 'released', session, to: target.device.id })
    expect(await mac.socket.message('invalid')).toMatchObject({ message: 'Only the relay sends released.' })
    await target.socket.none('released')
  })

  test('an attach stream carries attached back, bytes both ways and detach, and ends when a side leaves', async () => {
    const host = await joinNew(mac, 'host')
    const viewer = await connect(mac.token, mac.device.name, mac.device.roots)
    await viewer.message('welcome')
    const stream = 0xfeed1234
    const session = crypto.randomUUID()
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
    viewer.send({ t: 'attach', stream, to: host.device.id, session, cols: 80, rows: 24, key })
    expect(await host.socket.message('attach')).toMatchObject({ stream, session, cols: 80, rows: 24, key, from: { id: mac.device.id } })
    // the host's answer goes back by its stream, to the socket that attached
    host.socket.send({ t: 'attached', stream, port: 0, addresses: [] })
    expect(await viewer.message('attached')).toEqual({ t: 'attached', stream, port: 0, addresses: [], from: { id: host.device.id, name: host.device.name } })
    const isStream = (m: Message): boolean => m instanceof Uint8Array && m[0] === STREAM && streamOf(m) === stream
    viewer.send(encodeStream(stream, new TextEncoder().encode('ls\r')))
    expect(new TextDecoder().decode(((await host.socket.next(isStream, 'keys')) as Uint8Array).subarray(5))).toBe('ls\r')
    host.socket.send(encodeStream(stream, new TextEncoder().encode('README.md\r\n')))
    expect(new TextDecoder().decode(((await viewer.next(isStream, 'output')) as Uint8Array).subarray(5))).toBe('README.md\r\n')
    // the stream goes to the socket that attached, not to the viewer machine's other sockets
    await mac.socket.none('attach', 300)
    await mac.socket.none('attached', 300)
    expect(await mac.socket.next(isStream, 'a stranger\'s copy', 500).catch(() => undefined)).toBeUndefined()
    // a size travels as a frame of the stream, so a resize is no message the Pool routes
    viewer.send({ t: 'resize', stream, cols: 120, rows: 40 })
    expect(await viewer.message('invalid')).toEqual({ t: 'invalid', message: 'A resize message names the machine it goes to in to.' })
    await host.socket.none('resize', 300)
    host.socket.send({ t: 'detach', stream })
    expect(await viewer.message('detach')).toMatchObject({ stream, from: { id: host.device.id } })
    // a stream that ended answers its next bytes with detach
    viewer.send(encodeStream(stream, new TextEncoder().encode('x')))
    expect(await viewer.message('detach')).toMatchObject({ stream })
    viewer.send({ t: 'attach', stream: 7, to: host.device.id, session, cols: 80, rows: 24, key })
    await host.socket.message('attach')
    viewer.close()
    expect(await host.socket.message('detach')).toMatchObject({ stream: 7, from: { id: mac.device.id } })
    // a host whose last socket closes ends every stream viewed on it
    const second = await connect(mac.token, mac.device.name, mac.device.roots)
    await second.message('welcome')
    second.send({ t: 'attach', stream: 8, to: host.device.id, session, cols: 80, rows: 24, key })
    second.send({ t: 'attach', stream: 9, to: host.device.id, session, cols: 80, rows: 24, key })
    await host.socket.message('attach')
    await host.socket.message('attach')
    host.socket.close()
    const ended = [await second.message('detach'), await second.message('detach')].map((message) => message['stream'])
    expect(ended.sort()).toEqual([8, 9])
    second.send(encodeStream(8, new TextEncoder().encode('x')))
    expect(await second.message('detach')).toEqual({ t: 'detach', stream: 8 })
  })
})
