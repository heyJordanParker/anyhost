import { onTestFinished } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { Miniflare, convertV4MiniflareOptions } from '../../relay/node_modules/miniflare'
import { bundleRelay } from '../../relay/build.ts'
import { ANSWER, COMPATIBILITY_DATE, REQUEST, decodeMessage, encodeMessage, type Answer, type Op, type Released, type Request, type Result } from '../../relay/protocol.ts'
import type { Code, Problems } from '../src/capture.ts'
import type { Device, MachineRoots } from '../src/device.ts'
import { connectRelay, type Relay } from '../src/relay.ts'
import type { Status } from '../src/serve.ts'

export const noCode: Code = { captureCode: async () => undefined, restoreCode: async (_header, _readPart, folder) => folder }
export const failTest: Problems = {
  set: (_key, error) => {
    throw error
  },
  clear: () => undefined,
}

type Bucket = Awaited<ReturnType<Miniflare['getR2Bucket']>>
type Asked = { readonly refused: readonly (readonly [number, Result])[]; readonly puts: readonly { readonly index: number; readonly key: string; readonly body: Uint8Array }[] }
type Front = {
  readonly headers: Record<string, string>
  readonly queued: (string | Uint8Array)[]
  readonly asked: Map<number, Asked>
  pool?: WebSocket
  device?: string
  held?: (string | Uint8Array)[] | undefined
  up: Promise<void>
  down: Promise<void>
  isSilent?: boolean
}

export type MemoryRelay = {
  readonly url: string
  readonly objects: Bucket
  readonly puts: { readonly key: string; readonly body: Uint8Array }[]
  readonly requests: (readonly Op[])[]
  refuse: (op: Op) => string | undefined
  before: (op: Op) => Promise<void> | undefined
  delayMs: number
  stalled: boolean
  dropAnswers: number
  unanswered: number
  downloadBytesPerMs: number
  uploadBytesPerMs: number
  dailyLimited: number
  cutDownloads: number
  readonly ranges: (string | null)[]
  mostAtOnce: number
  keys(prefix: string): Promise<string[]>
  read(key: string): Promise<Uint8Array | undefined>
  claims(): Promise<Map<string, string>>
  waiting(): Promise<{ readonly device: string; readonly released: Released }[]>
  join(device: Device, roots: MachineRoots): Promise<string>
  isConnected(device: string): boolean
  remove(device: string): void
  holdNext(t: string): Promise<() => void>
  loseNext(device: string, t: string): Promise<void>
  dropNext(device: string, t: string): Promise<void>
  disconnect(device: string, kept?: number): () => void
  silence(device: string): () => void
  connect(device: Device, roots: MachineRoots): Relay
  stop(): Promise<void>
}

export const MEMORY = 'memory'
const WORKER = 'relay'

export async function welcomed(relay: Relay): Promise<void> {
  while (relay.state.is !== 'connected') await Bun.sleep(2)
}

export async function until(isTrue: () => boolean | Promise<boolean>, what = 'It', ms = 15_000): Promise<void> {
  for (const started = performance.now(); !(await isTrue()); await Bun.sleep(10)) {
    if (performance.now() - started > ms) throw new Error(`${what} did not happen within ${ms} ms.`)
  }
}

export const statusOn = async (socket: string): Promise<Status> => (await (await fetch('http://localhost/status', { unix: socket })).json()) as Status

let relayCode: Promise<string> | undefined
const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex')
const cut = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, Math.floor(bytes.length / 2)))
      setTimeout(() => controller.close(), 100)
    },
  })
function forwarded(request: globalThis.Request, url: string): Record<string, string> {
  const { pathname, search } = new URL(request.url)
  const headers: Record<string, string> = { 'mf-original-url': `${url}${pathname}${search}`, 'accept-encoding': 'identity' }
  for (const [name, value] of request.headers) if (!/^(host|connection|upgrade|content-length|accept-encoding|sec-websocket-.*)$/.test(name)) headers[name] = value
  return headers
}
const closeWith = (socket: { close(code?: number, reason?: string): void; terminate(): void }, code: number, reason: string): void =>
  code === 1000 || (code >= 3000 && code < 5000) ? socket.close(code, reason) : socket.terminate()

export async function memoryRelay(bucket = MEMORY): Promise<MemoryRelay> {
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      name: WORKER,
      modules: [{ type: 'ESModule', path: 'relay.js', contents: await (relayCode ??= bundleRelay()) }],
      compatibilityDate: COMPATIBILITY_DATE,
      durableObjects: { POOL: { className: 'Pool', useSQLite: true } },
      r2Buckets: { BUCKET: bucket },
      bindings: { BUCKET_NAME: bucket },
      unsafeInspectDurableObjects: true,
    }),
  )
  const origin = (await miniflare.ready).origin
  const [objects, pool] = await Promise.all([miniflare.getR2Bucket('BUCKET'), miniflare.unsafeGetDurableObjectStorage(WORKER, 'Pool', { name: 'pool' })])
  const tokens = new Map<string, Promise<string>>()
  const clients: Relay[] = []
  const fronts = new Set<ServerWebSocket<Front>>()
  let atOnce = 0

  const toPool = (front: ServerWebSocket<Front>, message: string | Uint8Array): void => {
    const { pool: socket } = front.data
    if (socket?.readyState === WebSocket.OPEN) socket.send(message)
    else if (socket === undefined || socket.readyState === WebSocket.CONNECTING) front.data.queued.push(message)
  }
  const carried = (after: Promise<void>, message: string | Uint8Array, bytesPerMs: number, carry: () => void): Promise<void> =>
    after.then(async () => {
      if (bytesPerMs > 0) await Bun.sleep((typeof message === 'string' ? Buffer.byteLength(message) : message.length) / bytesPerMs)
      carry()
    })
  const toMachine = (front: ServerWebSocket<Front>, message: string | Uint8Array): void =>
    void (front.data.down = carried(front.data.down, message, relay.downloadBytesPerMs, () => {
      if (fronts.has(front)) front.send(message)
    }))
  const answered = (front: ServerWebSocket<Front>, message: Uint8Array): void => {
    const { header, bytes } = decodeMessage(message)
    const answer = header as Answer
    const asked = answer.id === null ? undefined : front.data.asked.get(answer.id)
    if (asked === undefined || answer.id === null) return toMachine(front, message)
    front.data.asked.delete(answer.id)
    atOnce -= 1
    const results = 'results' in answer ? [...answer.results] : undefined
    for (const [index, result] of asked.refused) results?.splice(index, 0, result)
    for (const { index, key, body } of asked.puts) if (results?.[index]?.status === 200) relay.puts.push({ key, body })
    if (relay.dropAnswers > 0) {
      relay.dropAnswers -= 1
      return front.terminate()
    }
    if (relay.unanswered > 0) {
      relay.unanswered -= 1
      return
    }
    toMachine(front, asked.refused.length === 0 || results === undefined ? message : encodeMessage(ANSWER, { id: answer.id, results }, [bytes]))
  }
  const request = async (front: ServerWebSocket<Front>, message: Uint8Array): Promise<void> => {
    const { header, bytes } = decodeMessage(message)
    const { id, ops } = header as Request
    relay.requests.push(ops)
    const kept: { readonly op: Op; readonly bytes: Uint8Array }[] = []
    const refused: (readonly [number, Result])[] = []
    const puts: Asked['puts'][number][] = []
    let at = 0
    for (const [index, op] of ops.entries()) {
      const part = bytes.subarray(at, at + (op.op === 'put' ? op.size : 0))
      at += part.length
      const failure = relay.refuse(op)
      if (failure !== undefined) refused.push([index, { status: 500, error: 'storage', message: failure }])
      else kept.push({ op, bytes: part })
      if (failure === undefined && op.op === 'put') puts.push({ index, key: op.key, body: part.slice() })
    }
    front.data.asked.set(id, { refused, puts })
    atOnce += 1
    relay.mostAtOnce = Math.max(relay.mostAtOnce, atOnce)
    await Promise.all(ops.map((op) => relay.before(op)))
    await Bun.sleep(relay.delayMs)
    while (relay.stalled) await Bun.sleep(10)
    if (!fronts.has(front)) return
    if (kept.length === 0) return answered(front, encodeMessage(ANSWER, { id, results: [] }, []))
    toPool(front, refused.length === 0 ? message : encodeMessage(REQUEST, { id, ops: kept.map(({ op }) => op) }, kept.map((each) => each.bytes)))
  }
  let holding: { readonly t: string; readonly heard: (release: () => void) => void } | undefined
  let losing: { readonly device: string; readonly t: string; readonly lost: () => void; readonly isKept: boolean } | undefined
  const disconnected = new Set<string>()
  const fromMachine = (front: ServerWebSocket<Front>, message: string | Uint8Array): void => {
    if (front.data.isSilent === true) return
    if (front.data.held !== undefined) return void front.data.held.push(message)
    if (typeof message === 'string') {
      if (holding === undefined || !message.includes(`"t":"${holding.t}"`)) return toPool(front, message)
      const { heard } = holding
      holding = undefined
      front.data.held = [message]
      return heard(() => {
        const held = front.data.held ?? []
        front.data.held = undefined
        for (const each of held) fromMachine(front, each)
      })
    }
    if (message[0] === REQUEST) void request(front, message)
    else toPool(front, message)
  }

  const server = Bun.serve<Front>({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request, server) {
      if (relay.dailyLimited > 0) {
        relay.dailyLimited -= 1
        return new Response('error code: 1027', { status: 429, headers: { 'content-type': 'text/plain' } })
      }
      const headers = forwarded(request, url)
      if (request.headers.get('upgrade') === 'websocket') {
        for (const device of disconnected) if (request.headers.get('authorization') === `Bearer ${await tokens.get(device)}`) return new Response(`${device} has no network.`, { status: 503 })
        if (server.upgrade(request, { data: { headers, queued: [], asked: new Map(), up: Promise.resolve(), down: Promise.resolve() } })) return undefined
        return new Response('The front opened no WebSocket.', { status: 400 })
      }
      const { pathname, search } = new URL(request.url)
      const isObject = pathname.startsWith('/v1/objects/')
      const body = request.method === 'GET' ? undefined : new Uint8Array(await request.arrayBuffer())
      if (isObject && request.method === 'GET') relay.ranges.push(request.headers.get('range'))
      const answer = await fetch(`${origin}${pathname}${search}`, { method: request.method, headers, ...(body === undefined ? {} : { body }) })
      const bytes = new Uint8Array(await answer.arrayBuffer())
      if (isObject && request.method === 'PUT' && answer.status === 200 && body !== undefined) relay.puts.push({ key: decodeURIComponent(pathname.slice('/v1/objects/'.length)), body })
      const isCut = isObject && request.method === 'GET' && answer.ok && relay.cutDownloads > 0
      if (isCut) relay.cutDownloads -= 1
      const answered = Object.fromEntries([...answer.headers].filter(([name]) => !/^(content-length|transfer-encoding|content-encoding)$/.test(name)))
      return new Response(isCut ? cut(bytes) : bytes, { status: answer.status, headers: { ...answered, 'content-length': String(bytes.length) } })
    },
    websocket: {
      open(front) {
        fronts.add(front)
        const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/v1/connect`, { headers: front.data.headers })
        socket.binaryType = 'arraybuffer'
        front.data.pool = socket
        socket.addEventListener('open', () => {
          for (const message of front.data.queued.splice(0)) socket.send(message)
        })
        socket.addEventListener('message', ({ data }) => {
          if (front.data.isSilent === true) return
          if (typeof data !== 'string') {
            const bytes = new Uint8Array(data as ArrayBuffer)
            return bytes[0] === ANSWER ? answered(front, bytes) : toMachine(front, bytes)
          }
          if (data !== 'pong') {
            const message = JSON.parse(data) as { readonly t: string; readonly device?: { readonly id: string } }
            if (message.t === 'welcome' && message.device !== undefined) front.data.device = message.device.id
            if (losing !== undefined && front.data.device === losing.device && message.t === losing.t) {
              const { lost, isKept } = losing
              losing = undefined
              if (!isKept) front.terminate()
              return lost()
            }
          }
          toMachine(front, data)
        })
        socket.addEventListener('close', ({ code, reason }) => {
          if (fronts.has(front) && front.data.isSilent !== true) closeWith(front, code, reason)
        })
      },
      message(front, message) {
        const sent = typeof message === 'string' ? message : new Uint8Array(message)
        front.data.up = carried(front.data.up, sent, relay.uploadBytesPerMs, () => {
          if (fronts.has(front)) fromMachine(front, sent)
        })
      },
      close(front, code, reason) {
        fronts.delete(front)
        atOnce -= front.data.asked.size
        front.data.asked.clear()
        const { pool: socket } = front.data
        if (socket !== undefined && socket.readyState !== WebSocket.CLOSED && front.data.isSilent !== true) closeWith(socket, code, reason)
      },
    },
  })

  const url = `http://127.0.0.1:${server.port}`
  let stopping: Promise<void> | undefined
  const relay: MemoryRelay = {
    url,
    objects,
    puts: [],
    requests: [],
    refuse: () => undefined,
    before: () => undefined,
    delayMs: 0,
    stalled: false,
    dropAnswers: 0,
    unanswered: 0,
    downloadBytesPerMs: 0,
    uploadBytesPerMs: 0,
    cutDownloads: 0,
    dailyLimited: 0,
    ranges: [],
    mostAtOnce: 0,
    async keys(prefix) {
      const keys: string[] = []
      let cursor: string | undefined
      do {
        const page = await objects.list({ prefix, ...(cursor === undefined ? {} : { cursor }) })
        keys.push(...page.objects.map(({ key }) => key))
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor !== undefined)
      return keys
    },
    async read(key) {
      const object = await objects.get(key)
      return object === null ? undefined : new Uint8Array(await object.arrayBuffer())
    },
    async claims() {
      const rows = await pool.exec<{ session: string; device: string }>("select session, device from claims where device != ''")
      return new Map(rows.map(({ session, device }) => [session, device]))
    },
    async waiting() {
      const rows = await pool.exec<{ device: string; message: string }>('select device, message from waiting order by id')
      return rows.map(({ device, message }) => ({ device, released: JSON.parse(message) as Released }))
    },
    join(device, roots) {
      const token = (async (): Promise<string> => {
        const invite = crypto.randomUUID()
        await pool.exec('insert into invites (code_sha256) values (?)', sha256(invite))
        const answer = await fetch(`${origin}/v1/join`, { method: 'POST', body: JSON.stringify({ invite, device: { ...device, roots } }) })
        const joined = (await answer.json()) as { readonly token?: string; readonly message?: string }
        if (joined.token === undefined) throw new Error(`The relay refused to join ${device.name}: ${joined.message}`)
        return joined.token
      })()
      tokens.set(device.id, token)
      return token
    },
    isConnected: (device) => [...fronts].some((front) => front.data.device === device),
    remove(device) {
      const socket = [...fronts].find((front) => front.data.device === device)?.data.pool
      if (socket?.readyState !== WebSocket.OPEN) throw new Error(`No socket of ${device} is open to remove it on.`)
      socket.send(encodeMessage(REQUEST, { id: 0, ops: [{ op: 'remove', device }] }, []))
    },
    holdNext: (t) => new Promise((heard) => void (holding = { t, heard })),
    loseNext: (device, t) => new Promise((lost) => void (losing = { device, t, lost, isKept: false })),
    dropNext: (device, t) => new Promise((lost) => void (losing = { device, t, lost, isKept: true })),
    disconnect(device, kept = 0) {
      disconnected.add(device)
      for (const front of [...fronts].filter((each) => each.data.device === device).slice(kept)) front.terminate()
      return () => void disconnected.delete(device)
    },
    silence(device) {
      disconnected.add(device)
      const silent = [...fronts].filter((front) => front.data.device === device)
      for (const front of silent) front.data.isSilent = true
      return () => {
        disconnected.delete(device)
        for (const front of silent) front.terminate()
      }
    },
    connect(device, roots) {
      const token = tokens.get(device.id) ?? relay.join(device, roots)
      const client = connectRelay({ login: async () => ({ url, token: await token }), forget: async () => undefined, device, roots, isPatient: true })
      clients.push(client)
      return client
    },
    stop: () =>
      (stopping ??= (async () => {
        for (const client of clients) client.close()
        server.stop(true)
        await Promise.allSettled(tokens.values())
        await miniflare.dispose()
      })()),
  }
  onTestFinished(() => relay.stop())
  return relay
}

export const temporaryFolder = (): string => mkdtempSync(join(tmpdir(), 'anyhost-test-'))
