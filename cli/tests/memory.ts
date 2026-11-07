import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import {
  ANSWER,
  CLOSE_DEVICE_LIVE,
  CLOSE_REMOVED,
  CLOSE_UNKNOWN_TOKEN,
  MAX_KEYS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  RELAY_VERSION,
  REMOVED_MESSAGE,
  REMOVED_REASON,
  REQUEST,
  STREAM,
  decodeMessage,
  encodeMessage,
  streamOf,
  tokenOf,
  type Condition,
  type DeviceRef,
  type Op,
  type Released,
  type Request,
  type Result,
  type Roots,
  type Welcome,
} from '../../relay/protocol.ts'
import type { Code } from '../src/capture.ts'
import type { Device, MachineRoots } from '../src/device.ts'
import { connectRelay, type Relay } from '../src/relay.ts'

// The stand-in for the working folder's code: nothing to record, and the session continues in the folder it names.
export const noCode: Code = { captureCode: async () => undefined, restoreCode: async (_header, _readPart, folder) => folder }

export type Stored = { readonly body: Uint8Array; readonly etag: string; readonly modified: string }
// `streams` holds each attach stream the socket views, with the machine that hosts it.
type Socket = ServerWebSocket<{ readonly device: string; readonly name: string; readonly roots: Roots; readonly streams: Map<number, string>; readonly refuse?: { readonly code: number; readonly reason: string } }>

// The relay's API as `relay/pool.ts` and `relay/worker.ts` answer it, over real WebSockets and HTTP, with the bucket,
// the machines, the claims and the messages waiting for an offline machine in memory, and messages and attach streams
// routed between machines as the Pool routes them. `refuse` fails the ops it names
// as R2 would, `delayMs` answers each request that much later, `stalled` holds every answer back, `dropAnswers` runs
// that many requests and drops the socket instead of answering them, `unanswered` runs that many requests and never
// answers them on a socket that stays open, `cutDownloads` breaks that many GETs, and `dailyLimited` answers that many
// HTTP requests, a connect too, as Cloudflare answers a Worker past its daily requests.
export type MemoryRelay = {
  readonly url: string
  readonly bucket: string
  readonly objects: Map<string, Stored>
  readonly puts: { readonly key: string; readonly body: Uint8Array }[]
  // the ops of each request, in the order they came
  readonly requests: (readonly Op[])[]
  readonly claims: Map<string, string>
  refuse: (op: Op) => string | undefined
  delayMs: number
  stalled: boolean
  dropAnswers: number
  unanswered: number
  dailyLimited: number
  // GETs of an object that break after half its bytes, and the Range header of every GET
  cutDownloads: number
  readonly ranges: (string | null)[]
  // the most requests answered at once
  mostAtOnce: number
  // an object put straight into the bucket, as another program's write
  put(key: string, body: Uint8Array): void
  // a new token for the machine, which the Pool's join gives a machine that joins again too, refusing the one before
  join(device: Device, roots: MachineRoots): string
  // whether a socket of the machine is open
  isConnected(device: string): boolean
  remove(device: string): void
  connect(device: Device, roots: MachineRoots): Relay
  stop(): void
}

// the bucket a memory relay stands for unless a test names another
export const MEMORY = 'memory'

const started: MemoryRelay[] = []
export const stopRelays = (): void => {
  for (const relay of started.splice(0)) relay.stop()
}

// waits for the relay's welcome
export async function welcomed(relay: Relay): Promise<void> {
  while (relay.state.is !== 'connected') await Bun.sleep(2)
}

const md5 = (bytes: Uint8Array): string => new Bun.CryptoHasher('md5').update(bytes).digest('hex')
// the first half of the bytes, and then the body ends short of its Content-Length, as a broken download does
const cut = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, Math.floor(bytes.length / 2)))
      setTimeout(() => controller.close(), 100)
    },
  })
const conditionHolds = (stored: Stored | undefined, condition: Condition | undefined): boolean =>
  condition === undefined || ('none' in condition ? stored === undefined : stored?.etag === condition.match)

export function memoryRelay(bucket = MEMORY): MemoryRelay {
  const objects = new Map<string, Stored>()
  const puts: { key: string; body: Uint8Array }[] = []
  const requests: (readonly Op[])[] = []
  const claims = new Map<string, string>()
  const devices = new Map<string, { readonly id: string; name: string; readonly os: string; readonly arch: string; roots: Roots; readonly token: string; removedAt?: string; readonly joinedAt: string; seenAt: string }>()
  const waiting = new Map<string, Released[]>()
  const sockets = new Set<Socket>()
  const clients: Relay[] = []
  let atOnce = 0

  const deviceOf = (token: string) => [...devices.values()].find((device) => device.token === token)
  const refOf = (id: string): DeviceRef => ({ id, name: devices.get(id)?.name ?? id })
  const socketsOf = (id: string): Socket[] => [...sockets].filter((socket) => socket.data.device === id)
  const store = (key: string, body: Uint8Array): Stored => {
    const stored = { body, etag: md5(body), modified: new Date().toISOString() }
    objects.set(key, stored)
    puts.push({ key, body })
    return stored
  }

  function run(device: string, op: Op, bytes: Uint8Array): Result | { readonly get: Stored } {
    const failure = relay.refuse(op)
    if (failure !== undefined) return { status: 500, error: 'storage', message: failure }
    switch (op.op) {
      case 'get': {
        const stored = objects.get(op.key)
        return stored === undefined ? { status: 404 } : { get: stored }
      }
      case 'put': {
        const holder = op.holder === undefined ? undefined : claims.get(op.holder)
        if (holder !== undefined && holder !== device) return { status: 409, holder: refOf(holder) }
        const there = objects.get(op.key)
        if (!conditionHolds(there, op.if)) return there === undefined ? { status: 412 } : { status: 412, etag: there.etag }
        return { status: 200, etag: store(op.key, bytes.slice()).etag }
      }
      case 'list': {
        const keys = [...objects.keys()].filter((key) => key.startsWith(op.prefix) && (op.cursor === undefined || key > op.cursor)).sort()
        const page = keys.slice(0, MAX_KEYS).map((key) => ({ key, size: objects.get(key)?.body.length ?? 0, modified: objects.get(key)?.modified ?? '' }))
        return keys.length > MAX_KEYS ? { status: 200, objects: page, cursor: page.at(-1)?.key ?? '' } : { status: 200, objects: page }
      }
      case 'delete':
        for (const key of op.keys) objects.delete(key)
        return { status: 200 }
      case 'claim': {
        const held = claims.get(op.session)
        if (held !== undefined && held !== device && !op.take) return { status: 409, holder: refOf(held) }
        claims.set(op.session, device)
        if (held === undefined || held === device) return { status: 200, told: true }
        const released: Released = { t: 'released', session: op.session, to: refOf(device), at: new Date().toISOString() }
        const live = socketsOf(held)
        for (const socket of live) socket.send(JSON.stringify(released))
        if (live.length === 0) waiting.set(held, [...(waiting.get(held) ?? []), released])
        return { status: 200, previous: refOf(held), told: live.length > 0 }
      }
      case 'claims': {
        const asked = [...claims].filter(([session]) => session.startsWith(op.prefix ?? ''))
        return { status: 200, claims: Object.fromEntries(asked.map(([session, id]) => [session, { ...refOf(id), at: new Date().toISOString() }])) }
      }
      case 'devices':
        return {
          status: 200,
          devices: [...devices.values()].map(({ id, name, os, arch, roots, joinedAt, seenAt, removedAt }) => ({
            id,
            name,
            os,
            arch,
            roots,
            connected: socketsOf(id).length > 0,
            joinedAt,
            seenAt,
            ...(removedAt === undefined ? {} : { removedAt }),
          })),
        }
      case 'invite':
        return { status: 200, link: `${url}/v1/join#${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }
      case 'remove': {
        const known = devices.get(op.device)
        if (known === undefined || known.removedAt !== undefined) return { status: 404, error: 'unknown_device', message: `No machine with the id ${op.device} is joined.` }
        relay.remove(op.device)
        return { status: 200 }
      }
    }
  }

  async function answer(socket: Socket, message: Uint8Array): Promise<void> {
    const { header, bytes } = decodeMessage(message)
    const { id, ops } = header as Request
    requests.push(ops)
    atOnce += 1
    relay.mostAtOnce = Math.max(relay.mostAtOnce, atOnce)
    try {
      await Bun.sleep(relay.delayMs)
      while (relay.stalled) await Bun.sleep(10)
      let at = 0
      const done = ops.map((op) => {
        const size = op.op === 'put' ? op.size : 0
        at += size
        return run(socket.data.device, op, bytes.subarray(at - size, at))
      })
      if (relay.dropAnswers > 0) {
        relay.dropAnswers -= 1
        socket.terminate()
        return
      }
      if (relay.unanswered > 0) {
        relay.unanswered -= 1
        return
      }
      let room = MAX_MESSAGE_BYTES
      const parts: Uint8Array[] = []
      const results = done.map((result): Result => {
        if (!('get' in result)) return result
        const { body, etag, modified } = result.get
        if (body.length > room) return { status: 413, size: body.length, etag }
        room -= body.length
        parts.push(body)
        return { status: 200, etag, size: body.length, modified }
      })
      socket.send(encodeMessage(ANSWER, { id, results }, parts))
    } finally {
      atOnce -= 1
    }
  }

  // The sockets at the other end of a stream: the host's, from its viewer, else the viewer socket that opened it.
  const peersOf = (socket: Socket, stream: number): Socket[] => {
    const host = socket.data.streams.get(stream)
    if (host !== undefined) return socketsOf(host)
    return [...sockets].filter((other) => other !== socket && other.data.streams.get(stream) === socket.data.device)
  }
  const send = (to: readonly Socket[], message: object | Uint8Array): void => {
    for (const socket of to) socket.send(message instanceof Uint8Array ? message : JSON.stringify(message))
  }
  function route(socket: Socket, text: string): void {
    const message = JSON.parse(text) as { t: string; to?: string; stream?: number; id?: string }
    const routed = { ...message, from: refOf(socket.data.device) }
    if (message.t === 'attached' || message.t === 'detach') {
      const peers = peersOf(socket, message.stream ?? -1)
      if (message.t === 'detach') for (const each of [socket, ...peers]) each.data.streams.delete(message.stream ?? -1)
      return send(peers, routed)
    }
    const targets = socketsOf(message.to ?? '')
    if (targets.length === 0) return send([socket], { t: 'offline', ...(message.id === undefined ? {} : { id: message.id }), ...(message.stream === undefined ? {} : { stream: message.stream }), to: message.to })
    send(targets, routed)
    if (message.t === 'attach' && message.stream !== undefined && message.to !== undefined) socket.data.streams.set(message.stream, message.to)
  }

  async function object(request: globalThis.Request, key: string): Promise<Response> {
    const device = deviceOf(tokenOf(request.headers.get('authorization')))
    if (device === undefined) return Response.json({ error: 'unknown_token', message: 'The relay knows no machine with this token.' }, { status: 401 })
    if (device.removedAt !== undefined) return Response.json({ error: 'removed', message: REMOVED_MESSAGE }, { status: 403 })
    const there = objects.get(key)
    if (request.method === 'PUT') {
      const holder = request.headers.get('x-anyhost-holder')
      const held = holder === null ? undefined : claims.get(holder)
      if (held !== undefined && held !== device.id) return Response.json({ error: 'held', message: `${refOf(held).name} holds the session ${holder}.`, holder: refOf(held) }, { status: 409 })
      const match = request.headers.get('if-match')
      const condition: Condition | undefined = request.headers.get('if-none-match') === '*' ? { none: '*' } : match === null ? undefined : { match: match.replaceAll('"', '') }
      const body = new Uint8Array(await request.arrayBuffer())
      if (!conditionHolds(there, condition)) return Response.json({ error: 'precondition', message: `${key} failed the condition.`, ...(there === undefined ? {} : { etag: there.etag }) }, { status: 412 })
      const stored = store(key, body)
      return Response.json({ etag: stored.etag, size: body.length })
    }
    if (there === undefined) return Response.json({ error: 'missing', message: `No object ${key} is in the bucket.` }, { status: 404 })
    relay.ranges.push(request.headers.get('range'))
    const headers = { 'content-type': 'application/octet-stream', etag: `"${there.etag}"`, 'last-modified': new Date(there.modified).toUTCString() }
    const from = Number(/^bytes=(\d+)-$/.exec(request.headers.get('range') ?? '')?.[1] ?? 'NaN')
    const body = Number.isNaN(from) ? there.body : there.body.subarray(from)
    const sent = relay.cutDownloads > 0 ? cut(body) : body
    if (relay.cutDownloads > 0) relay.cutDownloads -= 1
    if (Number.isNaN(from)) return new Response(sent, { headers: { ...headers, 'content-length': String(body.length) } })
    return new Response(sent, { status: 206, headers: { ...headers, 'content-length': String(body.length), 'content-range': `bytes ${from}-${there.body.length - 1}/${there.body.length}` } })
  }

  const server = Bun.serve<Socket['data']>({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request, server) {
      const { pathname } = new URL(request.url)
      if (relay.dailyLimited > 0) {
        relay.dailyLimited -= 1
        return new Response('error code: 1027', { status: 429, headers: { 'content-type': 'text/plain' } })
      }
      if (pathname === '/v1/health') return Response.json({ relay: RELAY_VERSION, protocol: PROTOCOL_VERSION, bucket })
      if (pathname.startsWith('/v1/objects/')) return await object(request, decodeURIComponent(pathname.slice('/v1/objects/'.length)))
      if (pathname !== '/v1/connect') return new Response('no route', { status: 404 })
      const name = request.headers.get('x-anyhost-name') ?? ''
      const roots = JSON.parse(request.headers.get('x-anyhost-roots') ?? 'null') as Roots | null
      if (roots === null) return Response.json({ error: 'invalid', message: 'A connect names its machine\'s roots as JSON in X-Anyhost-Roots.' }, { status: 400 })
      const device = deviceOf(tokenOf(request.headers.get('authorization')))
      const live = device === undefined ? undefined : socketsOf(device.id).find((socket) => socket.data.name !== name)
      const refuse =
        device === undefined
          ? { code: CLOSE_UNKNOWN_TOKEN, reason: 'The relay knows no machine with this token.' }
          : device.removedAt !== undefined
            ? { code: CLOSE_REMOVED, reason: REMOVED_REASON }
            : live !== undefined
              ? { code: CLOSE_DEVICE_LIVE, reason: `${live.data.name} is connected with this machine's id.` }
              : undefined
      if (server.upgrade(request, { data: { device: device?.id ?? '', name, roots, streams: new Map(), ...(refuse === undefined ? {} : { refuse }) } })) return undefined
      return new Response('no upgrade', { status: 400 })
    },
    websocket: {
      open(socket) {
        if (socket.data.refuse !== undefined) return socket.close(socket.data.refuse.code, socket.data.refuse.reason)
        const device = devices.get(socket.data.device)
        if (device === undefined) return
        device.name = socket.data.name
        device.roots = socket.data.roots
        sockets.add(socket)
        const welcome: Welcome = { t: 'welcome', relay: RELAY_VERSION, protocol: PROTOCOL_VERSION, bucket, device: refOf(device.id), waiting: waiting.get(device.id) ?? [] }
        waiting.delete(device.id)
        socket.send(JSON.stringify(welcome))
      },
      message(socket, message) {
        if (message === 'ping') return void socket.send('pong')
        if (typeof message === 'string') return route(socket, message)
        if (message[0] === REQUEST) void answer(socket, new Uint8Array(message))
        if (message[0] !== STREAM) return
        const peers = peersOf(socket, streamOf(message))
        if (peers.length === 0) return send([socket], { t: 'detach', stream: streamOf(message) })
        send(peers, new Uint8Array(message))
      },
      // the streams the socket viewed end at their hosts, and a machine with no socket left ends the streams it hosted
      close(socket) {
        sockets.delete(socket)
        const device = devices.get(socket.data.device)
        if (device !== undefined) device.seenAt = new Date().toISOString()
        const from = refOf(socket.data.device)
        for (const [stream, host] of socket.data.streams) send(socketsOf(host), { t: 'detach', stream, from })
        if (socketsOf(socket.data.device).length > 0) return
        for (const viewer of sockets) {
          for (const [stream, host] of viewer.data.streams) {
            if (host !== socket.data.device) continue
            viewer.data.streams.delete(stream)
            send([viewer], { t: 'detach', stream, from })
          }
        }
      },
    },
  })

  const url = `http://127.0.0.1:${server.port}`
  const relay: MemoryRelay = {
    url,
    bucket,
    objects,
    puts,
    requests,
    claims,
    refuse: () => undefined,
    delayMs: 0,
    stalled: false,
    dropAnswers: 0,
    unanswered: 0,
    cutDownloads: 0,
    dailyLimited: 0,
    ranges: [],
    mostAtOnce: 0,
    put: (key, body) => void store(key, body),
    join(device, roots) {
      const token = crypto.randomUUID()
      const now = new Date().toISOString()
      devices.set(device.id, { ...device, roots, token, joinedAt: now, seenAt: now })
      return token
    },
    isConnected: (id) => socketsOf(id).length > 0,
    remove(id) {
      const device = devices.get(id)
      if (device !== undefined) device.removedAt = new Date().toISOString()
      for (const socket of socketsOf(id)) socket.close(CLOSE_REMOVED, REMOVED_REASON)
    },
    // a client of the machine's token, which a machine joined before keeps
    connect(device, roots) {
      const token = devices.get(device.id)?.token ?? relay.join(device, roots)
      const client = connectRelay({ login: async () => ({ url, token }), forget: async () => undefined, device, roots, isPatient: true })
      clients.push(client)
      return client
    },
    stop() {
      for (const client of clients) client.close()
      server.stop(true)
    },
  }
  started.push(relay)
  return relay
}

export const temporaryFolder = (): string => mkdtempSync(join(tmpdir(), 'anyhost-test-'))
