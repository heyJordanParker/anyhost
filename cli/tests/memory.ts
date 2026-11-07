import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
// Miniflare is the relay's own dependency, which `bun install --cwd relay` installs.
import { Miniflare, convertV4MiniflareOptions } from '../../relay/node_modules/miniflare'
import { bundleRelay } from '../../relay/build.ts'
import { ANSWER, COMPATIBILITY_DATE, REQUEST, decodeMessage, encodeMessage, type Answer, type Op, type Released, type Request, type Result } from '../../relay/protocol.ts'
import type { Code, Problems } from '../src/capture.ts'
import type { Device, MachineRoots } from '../src/device.ts'
import { connectRelay, type Relay } from '../src/relay.ts'
import type { Status } from '../src/serve.ts'

// The stand-in for the working folder's code: nothing to record, and the session continues in the folder it names.
export const noCode: Code = { captureCode: async () => undefined, restoreCode: async (_header, _readPart, folder) => folder }
// the problems of a test that expects none: the first one fails it
export const failTest: Problems = {
  set: (_key, error) => {
    throw error
  },
  clear: () => undefined,
}

type Bucket = Awaited<ReturnType<Miniflare['getR2Bucket']>>
// A request a front sent the Pool: the results of the ops a switch failed, by their position, and the puts it carried,
// which `puts` keeps once the Pool stored them.
type Asked = { readonly refused: readonly (readonly [number, Result])[]; readonly puts: readonly { readonly index: number; readonly key: string; readonly body: Uint8Array }[] }
// A machine's socket to the front, and the socket the front opened to the Pool for it with the machine's headers. The
// messages the machine sent before the Pool's socket opened wait in `queued`. `device` is the machine the Pool welcomed.
// `held` is the message `holdNext` holds and every message the machine sent after it, in order. `up` and `down` are the
// link's two ways, each the last message it carries, which the next one waits for. A front `silence` set carries
// nothing either way.
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

// The relay as the program meets it: the relay's Worker and Pool in workerd through Miniflare, as `startLocal` in
// relay/relay.test.ts runs them, with the Pool's SQLite and the R2 bucket in memory, behind a front at `url` that
// carries every request, message and object between a machine and the relay, and makes the faults only a stand-in
// makes. `refuse` fails the ops it names as R2 would, `delayMs` sends each request that much later, `stalled` holds
// every request back, `dropAnswers` drops the socket instead of that many answers, `unanswered` never sends that many
// answers on a socket that stays open, `downloadBytesPerMs` and `uploadBytesPerMs` carry every message of a socket, a
// ping, a pong and an answer alike, at that many bytes a millisecond toward the machine and toward the Pool, each
// after the one before it on its way, as a slow link does, `cutDownloads` breaks that many GETs of an object, and
// `dailyLimited` answers that many HTTP requests, a connect too, as Cloudflare answers a Worker past its daily requests.
export type MemoryRelay = {
  readonly url: string
  // the relay's R2 bucket, as another program writes it
  readonly objects: Bucket
  // every object the relay stored for a machine, in order, from a request's put or by HTTP
  readonly puts: { readonly key: string; readonly body: Uint8Array }[]
  // the ops of each request, in the order they came
  readonly requests: (readonly Op[])[]
  refuse: (op: Op) => string | undefined
  delayMs: number
  stalled: boolean
  dropAnswers: number
  unanswered: number
  // 0 carries every message at once
  downloadBytesPerMs: number
  uploadBytesPerMs: number
  dailyLimited: number
  // GETs of an object that break after half its bytes, and the Range header of every GET
  cutDownloads: number
  readonly ranges: (string | null)[]
  // the most requests the relay had not answered at once
  mostAtOnce: number
  // every key under the prefix in the bucket, in order
  keys(prefix: string): Promise<string[]>
  // the bytes of an object in the bucket, or undefined when it holds none
  read(key: string): Promise<Uint8Array | undefined>
  // the machine that holds each session, by its id, as the Pool's claims say
  claims(): Promise<Map<string, string>>
  // each `released` the Pool keeps for a machine until the machine says it heard it, in order, with the machine's id
  waiting(): Promise<{ readonly device: string; readonly released: Released }[]>
  // a new token for the machine from the Pool's join, which a machine that joined before gets too, refusing the one before
  join(device: Device, roots: MachineRoots): Promise<string>
  // Whether a socket of the machine the Pool welcomed is open at the front. The front ends a socket before the Pool reads
  // its close, so only the Pool's `devices` says a machine went offline.
  isConnected(device: string): boolean
  // The machine removes itself on its open socket, and the Pool closes every socket of it. The Pool answers on none, as
  // it closed the one the remove came on.
  remove(device: string): void
  // Holds the next message of the type `t` a machine sends, and every message that machine sends after it, at the front,
  // and answers once it holds one, with the function that sends them on in order.
  holdNext(t: string): Promise<() => void>
  // Ends the machine's socket as the Pool sends it the next message of the type `t`, which the machine never gets, as a
  // connection that broke while the message was on its way, and answers once it did. The machine connects again.
  loseNext(device: string, t: string): Promise<void>
  // Ends every socket of the machine but the first `kept` it opened, and refuses its connects, and answers the function
  // that lets it connect again. The Pool hears each close at once, as it does when the machine or its network closes the
  // connection. With `kept` 1, the program's socket stays and a command's own socket, opened after it, ends.
  disconnect(device: string, kept?: number): () => void
  // The front carries no message, ping or pong of the machine's sockets either way, leaves the Pool's sockets open and
  // refuses the machine's connects, as when the machine went to sleep or its network went with no close, so the Pool
  // hears nothing and the machine hears nothing back. Answers the function that wakes it: the machine's end of those
  // sockets breaks, as a woken machine finds them, and it connects again, while the Pool's end stays open.
  silence(device: string): () => void
  // a client of the machine's token, which a machine that joined before keeps
  connect(device: Device, roots: MachineRoots): Relay
  stop(): Promise<void>
}

// the bucket a memory relay stands for unless a test names another
export const MEMORY = 'memory'
// the Worker's name in Miniflare, which reaching the Pool's database takes
const WORKER = 'relay'

const started: MemoryRelay[] = []
export const stopRelays = async (): Promise<void> => {
  await Promise.all(started.splice(0).map((relay) => relay.stop()))
}

// waits for the relay's welcome
export async function welcomed(relay: Relay): Promise<void> {
  while (relay.state.is !== 'connected') await Bun.sleep(2)
}

// Waits for `what` a machine hears on its own, or a stand-in does, trying every 10 ms, and fails naming it once `ms`
// passed on the monotonic clock, which `setSystemTime` and a stand-in's own clock leave alone.
export async function until(isTrue: () => boolean | Promise<boolean>, what = 'It', ms = 15_000): Promise<void> {
  for (const started = performance.now(); !(await isTrue()); await Bun.sleep(10)) {
    if (performance.now() - started > ms) throw new Error(`${what} did not happen within ${ms} ms.`)
  }
}

// what the program at `socket` answers at GET /status
export const statusOn = async (socket: string): Promise<Status> => (await (await fetch('http://localhost/status', { unix: socket })).json()) as Status

let relayCode: Promise<string> | undefined
const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex')
// the first half of the bytes, and then the body ends short of its Content-Length, as a broken download does
const cut = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, Math.floor(bytes.length / 2)))
      setTimeout(() => controller.close(), 100)
    },
  })
// The headers a machine sent that the front sends on: the ones of the connection itself are the front's own. The Worker
// reads the address the machine asked at as the request's URL, as an invite names it.
function forwarded(request: globalThis.Request, url: string): Record<string, string> {
  const { pathname, search } = new URL(request.url)
  const headers: Record<string, string> = { 'mf-original-url': `${url}${pathname}${search}`, 'accept-encoding': 'identity' }
  for (const [name, value] of request.headers) if (!/^(host|connection|upgrade|content-length|accept-encoding|sec-websocket-.*)$/.test(name)) headers[name] = value
  return headers
}
// A close the front passes on with its code, or a socket that ended with no close, as 1006 says, which it ends alike.
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
  // One way of the machine's link: a message goes after the one before it on that way, once its bytes took their time
  // at `bytesPerMs`, or at once at 0, so a pong waits behind the answers ahead of it as it does on a real link.
  const carried = (after: Promise<void>, message: string | Uint8Array, bytesPerMs: number, carry: () => void): Promise<void> =>
    after.then(async () => {
      if (bytesPerMs > 0) await Bun.sleep((typeof message === 'string' ? Buffer.byteLength(message) : message.length) / bytesPerMs)
      carry()
    })
  const toMachine = (front: ServerWebSocket<Front>, message: string | Uint8Array): void =>
    void (front.data.down = carried(front.data.down, message, relay.downloadBytesPerMs, () => {
      if (fronts.has(front)) front.send(message)
    }))
  // The answer to a request, with the results of the ops a switch failed in their positions, unless a switch drops it.
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
    await Bun.sleep(relay.delayMs)
    while (relay.stalled) await Bun.sleep(10)
    if (!fronts.has(front)) return
    if (kept.length === 0) return answered(front, encodeMessage(ANSWER, { id, results: [] }, []))
    toPool(front, refused.length === 0 ? message : encodeMessage(REQUEST, { id, ops: kept.map(({ op }) => op) }, kept.map((each) => each.bytes)))
  }
  // the type of the message `holdNext` holds next, with what hears it held
  let holding: { readonly t: string; readonly heard: (release: () => void) => void } | undefined
  // the machine and the type of the message `loseNext` loses next, with what hears it lost
  let losing: { readonly device: string; readonly t: string; readonly lost: () => void } | undefined
  // the machines `disconnect` ended or `silence` put to sleep, whose connects the front refuses
  const disconnected = new Set<string>()
  // A message the machine sent: held while a message before it is, else a request, or a message for the Pool.
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
      // the bytes whole, with the Content-Length the relay names, which a stream of them would lose
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
              const { lost } = losing
              losing = undefined
              front.terminate()
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
      const rows = await pool.exec<{ session: string; device: string }>('select session, device from claims')
      return new Map(rows.map(({ session, device }) => [session, device]))
    },
    async waiting() {
      const rows = await pool.exec<{ device: string; message: string }>('select device, message from waiting order by id')
      return rows.map(({ device, message }) => ({ device, released: JSON.parse(message) as Released }))
    },
    // The Pool's join with an invite of the test's own, as one Add a machine made.
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
    loseNext: (device, t) => new Promise((lost) => void (losing = { device, t, lost })),
    disconnect(device, kept = 0) {
      disconnected.add(device)
      // the fronts in the order the machine opened them
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
    // a join still on its way ends first, so no closed client reads a login the relay never answered
    stop: () =>
      (stopping ??= (async () => {
        for (const client of clients) client.close()
        server.stop(true)
        await Promise.allSettled(tokens.values())
        await miniflare.dispose()
      })()),
  }
  started.push(relay)
  return relay
}

export const temporaryFolder = (): string => mkdtempSync(join(tmpdir(), 'anyhost-test-'))
