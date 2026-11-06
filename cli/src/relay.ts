// The one connection between this program and the person's relay: a WebSocket that carries every request of ops and
// every message, and HTTPS for each object over MAX_MESSAGE_BYTES, which the relay's Worker streams to and from R2.
// The socket pings every PING_MS, counts a pong more than PONG_MS late as a drop, and opens again at once, then after
// 1, 2, 4 and up to 60 seconds. A request the relay never answered goes again on the next socket, and a put that
// finds its own bytes there counts as written, so a dropped answer writes nothing twice.
import plugin from '../../.claude-plugin/plugin.json'
import {
  ANSWER,
  CLOSE_DEVICE_LIVE,
  CLOSE_REMOVED,
  CLOSE_UNKNOWN_TOKEN,
  MAX_MESSAGE_BYTES,
  MAX_OPS,
  PROTOCOL_VERSION,
  REQUEST,
  STREAM,
  cloneFixFor,
  decodeMessage,
  encodeMessage,
  type Answer,
  type Condition,
  type Delivered,
  type DeviceRef,
  type FromPool,
  type Listed,
  type Offline,
  type Op,
  type Released,
  type Result,
  type Roots,
  type Routed,
  type Welcome,
} from '../../relay/protocol.ts'

// Cloudflare closes a socket that carries nothing for a while and names no number: one quiet for 10 minutes was closed
// by then, and one pinged every 30 seconds had every pong back within 40 seconds over 50 minutes (relay-spec R16).
const PING_MS = 30_000
const PONG_MS = 40_000
// A socket opened in 494 to 689 ms on a home link (R16).
const CONNECT_MS = 10_000
const RETRY_MS = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000]
// A write gets REQUEST_MS and as long again as its bytes take at 100 KB/s. A Mac whose uploads moved at 0.4 to 0.9 MB/s
// failed a frame holding a 67 MB tool result, 50 MB compressed, at 120 s on every try. Bun never ends an upload that
// stopped moving, so only a total limit ends one the network dropped.
const REQUEST_MS = 120_000
const SLOWEST_UPLOAD_BYTES_PER_MS = 100
// A download that moves no byte for this long goes on, in its next try, from the byte it reached.
const IDLE_MS = 30_000
// A redeploy reset a GET that started 10 seconds after it, and the same GET a minute later finished (R14): 6 tries
// wait 1, 2, 4, 8 and 16 seconds between them.
const OBJECT_TRIES = 6

export type Login = { readonly url: string; readonly token: string }
// A put carries its bytes, whose length its op names as `size`.
export type Call = Exclude<Op, { readonly op: 'put' }> | { readonly op: 'put'; readonly key: string; readonly bytes: Uint8Array; readonly if?: Condition; readonly holder?: string }
export type Got = { readonly status: 200; readonly etag: string; readonly size: number; readonly modified: string; readonly bytes: Uint8Array }
// An op's answer, a get's with its bytes. A result that names an error, as a failed R2 call does, rejects instead.
export type Ran = Exclude<Result, { readonly error: string } | { readonly status: 200; readonly size: number; readonly modified: string } | { readonly status: 413 }> | Got
// `connected` once the welcome came. `unjoined` is no login, as before a join or after the relay refused the login for
// good, `outdated` a relay older than this program needs, and `refused` a clone of a connected machine.
export type RelayState =
  | { readonly is: 'connecting' }
  | { readonly is: 'connected'; readonly welcome: Welcome }
  | { readonly is: 'unjoined' | 'offline' | 'refused' | 'outdated'; readonly message: string }
// What the Pool sends: its own messages, each message another machine routed here by its `t`, and each attach stream
// message whole, its stream id in its first bytes.
type Events = { readonly welcome: Welcome; readonly released: Released; readonly offline: Offline; readonly stream: Uint8Array } & {
  readonly [T in Delivered['t']]: Extract<Delivered, { readonly t: T }>
}

export type Relay = {
  readonly state: RelayState
  // the address of the relay this machine joined, empty before its login was read or with none
  readonly url: string
  // Runs the ops in as few requests as MAX_OPS and MAX_MESSAGE_BYTES allow, in their order, and answers each in its
  // position. A put over MAX_MESSAGE_BYTES goes by HTTP beside them, and so does a get the answer had no room for.
  run(calls: readonly Call[]): Promise<Ran>[]
  // every object under the prefix, a page of list at a time
  list(prefix: string): Promise<Listed[]>
  // one object by HTTP, which a broken download's next try goes on with from the byte it reached
  getObject(key: string): Promise<Got | undefined>
  // A message for another machine, or an attach stream's bytes, on the socket the relay welcomed. Answers false while
  // no socket is, and the message goes nowhere.
  send(message: Routed | Uint8Array): boolean
  on<K extends keyof Events>(kind: K, listener: (message: Events[K]) => void): void
  // connects at once instead of after the wait, as after this machine joined
  reconnect(): void
  close(): void
}

export type RelayOptions = {
  // relay.json and the device token, read again at each connect, so a machine joined meanwhile connects
  readonly login: () => Promise<Login | undefined>
  // drops a login the relay refused for good, as a removed machine's, so the next connect reads none
  readonly forget: (refused: Login) => Promise<void>
  readonly device: { readonly name: string; readonly os: string }
  // sent at each connect, so another machine relocates this machine's sessions from where its folders are now
  readonly roots: Roots
  // The service waits out any outage. A command fails its requests once a connect fails, so it never hangs.
  readonly isPatient: boolean
}

// A refusal no try fixes, such as a removed machine's token.
class Refused extends Error {}

const NOT_JOINED = 'This machine is not joined to your relay, so anyhost keeps what its sessions write and uploads nothing.'
const md5 = (bytes: Uint8Array): string => new Bun.CryptoHasher('md5').update(bytes).digest('hex')
const objectUrl = (login: Login, key: string): string => `${login.url}/v1/objects/${key.split('/').map(encodeURIComponent).join('/')}`
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const unquoted = (etag: string | null): string => (etag ?? '').replace(/^(W\/)?"|"$/g, '')

const toOp = (call: Call): Op =>
  call.op === 'put' ? { op: 'put', key: call.key, size: call.bytes.length, ...(call.if === undefined ? {} : { if: call.if }), ...(call.holder === undefined ? {} : { holder: call.holder }) } : call

// A put whose condition failed while the object holds its own bytes is written: a try again after a lost answer, or
// bytes an earlier try already put there.
const written = (call: Call, result: Ran): Ran => (call.op === 'put' && result.status === 412 && 'etag' in result && result.etag === md5(call.bytes) ? { status: 200, etag: result.etag } : result)

// An HTTP answer the next try may fix, as a relay error a redeploy or a daily limit gives, answers undefined.
async function failureOf(answer: Response): Promise<undefined> {
  if (answer.status >= 500) {
    await answer.body?.cancel()
    return undefined
  }
  const body = (await answer.json().catch(() => ({}))) as { message?: string }
  throw new Refused(body.message ?? `The relay answered ${answer.status}.`)
}

// The state a refusal no try fixes leaves. A removed machine's token and one the relay never knew are the relay's final
// answer for that login, so the machine forgets it and is unjoined.
function refusedBy(code: number, reason: string, device: RelayOptions['device']): RelayState | undefined {
  if (code === CLOSE_REMOVED) return { is: 'unjoined', message: 'This machine was removed from your machines. Join it again with a link from Add a machine.' }
  if (code === CLOSE_UNKNOWN_TOKEN) return { is: 'unjoined', message: 'The relay knows no machine with this token. Join it again with a link from Add a machine.' }
  if (code === CLOSE_DEVICE_LIVE) return { is: 'refused', message: `The relay refused ${device.name}: ${reason} A machine cloned from another keeps its id, so anyhost captures nothing here. ${cloneFixFor(device.os)}` }
  return undefined
}

// A header holds Latin-1 alone, so a root's other characters go as JSON escapes, which the relay reads back the same.
const rootsHeader = (roots: Roots): string => JSON.stringify(roots).replace(/[^\x20-\x7e]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)

type Pending = { readonly message: Uint8Array; wasSent: boolean; readonly resolve: (answer: { results: readonly Result[]; bytes: Uint8Array }) => void; readonly reject: (error: Error) => void }

export function connectRelay(options: RelayOptions): Relay {
  const listeners: Partial<Record<keyof Events, ((message: never) => void)[]>> = {}
  const emit = <K extends keyof Events>(kind: K, message: Events[K]): void => {
    for (const listener of listeners[kind] ?? []) (listener as (message: Events[K]) => void)(message)
  }
  const pending = new Map<number, Pending>()
  // the object requests waiting for a relay that welcomed this machine, whose login they use
  const waiting = new Set<{ readonly resolve: (login: Login) => void; readonly reject: (error: Error) => void }>()
  let state: RelayState = { is: 'connecting' }
  let login: Login | undefined
  // why this machine has no login: never joined, or the refusal of the login it forgot, until it reads a login again
  let unjoined = NOT_JOINED
  // the forget of a refused login, which the next connect waits for, so it never reads that login again
  let forgetting: Promise<void> = Promise.resolve()
  let socket: WebSocket | undefined
  let nextId = 1
  let failures = 0
  let isClosed = false
  let reopen: ReturnType<typeof setTimeout> | undefined
  let pinger: ReturnType<typeof setInterval> | undefined
  let pongDue: ReturnType<typeof setTimeout> | undefined

  const failPending = (message: string): void => {
    for (const [id, request] of pending) {
      pending.delete(id)
      request.reject(new Error(message))
    }
    for (const waiter of waiting) waiter.reject(new Error(message))
    waiting.clear()
  }
  const send = (request: Pending): void => {
    socket?.send(request.message)
    request.wasSent = true
  }
  const welcomedLogin = (): Promise<Login> => {
    if (state.is === 'connected' && login !== undefined) return Promise.resolve(login)
    if (!options.isPatient && 'message' in state) return Promise.reject(new Error(state.message))
    return new Promise((resolve, reject) => waiting.add({ resolve, reject }))
  }

  // The socket is gone, and its events count no more. The next one opens at once after a socket the relay welcomed,
  // else after the next wait of RETRY_MS.
  const drop = (next: RelayState): void => {
    clearInterval(pinger)
    clearTimeout(pongDue)
    pongDue = undefined
    const was = socket
    socket = undefined
    was?.terminate()
    const wasConnected = state.is === 'connected'
    state = next
    if (isClosed) return
    if (wasConnected && 'message' in next) console.error(`${new Date().toISOString()} ${next.message}${next.is === 'unjoined' ? '' : ' anyhost connects again.'}`)
    if (!wasConnected) failures += 1
    if (!wasConnected && !options.isPatient && 'message' in next) failPending(next.message)
    reopen = setTimeout(() => void open(), wasConnected ? 0 : (RETRY_MS[Math.min(failures, RETRY_MS.length) - 1] ?? 0))
  }

  const answered = (message: Uint8Array): void => {
    const { header, bytes } = decodeMessage(message)
    const answer = header as Answer
    const request = answer.id === null ? undefined : pending.get(answer.id)
    if (request === undefined || answer.id === null) {
      if ('error' in answer) console.error(`${new Date().toISOString()} The relay refused a request: ${answer.message}`)
      return
    }
    pending.delete(answer.id)
    if ('error' in answer) request.reject(new Error(`The relay refused the request: ${answer.message}`))
    else request.resolve({ results: answer.results, bytes })
  }

  const heard = (text: string): void => {
    if (text === 'pong') {
      clearTimeout(pongDue)
      pongDue = undefined
      return
    }
    const message = JSON.parse(text) as FromPool
    if (message.t === 'welcome') {
      if (message.protocol < PROTOCOL_VERSION) {
        drop({ is: 'outdated', message: `The relay at ${login?.url} answers protocol ${message.protocol}, and anyhost ${plugin.version} needs ${PROTOCOL_VERSION}. Connect Cloudflare again to update the relay.` })
        return
      }
      failures = 0
      state = { is: 'connected', welcome: message }
      // The listeners take the sessions another machine took meanwhile from the welcome's `waiting` before anything
      // goes up, and may end the program first. A request sent since is in `pending` too, and none goes twice.
      const unanswered = [...pending.values()]
      emit('welcome', message)
      const again = unanswered.filter((request) => request.wasSent).length
      if (again > 0) console.error(`${new Date().toISOString()} anyhost sends again ${again === 1 ? 'the request' : `the ${again} requests`} the relay had not answered.`)
      for (const request of unanswered) send(request)
      for (const waiter of waiting) if (login !== undefined) waiter.resolve(login)
      waiting.clear()
      return
    }
    if (message.t === 'invalid') console.error(`${new Date().toISOString()} The relay read no message of this program: ${message.message}`)
    else emit(message.t, message as never)
  }

  const open = async (): Promise<void> => {
    state = { is: 'connecting' }
    await forgetting
    login = await options.login().catch((error: unknown) => {
      console.error(`${new Date().toISOString()} anyhost could not read this machine's relay login: ${messageOf(error)}`)
      return undefined
    })
    if (isClosed) return
    if (login === undefined) return drop({ is: 'unjoined', message: unjoined })
    unjoined = NOT_JOINED
    const used = login
    const url = login.url
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/v1/connect`, {
      headers: { authorization: `Bearer ${login.token}`, 'x-anyhost-name': options.device.name, 'x-anyhost-version': plugin.version, 'x-anyhost-roots': rootsHeader(options.roots) },
    })
    socket = ws
    ws.binaryType = 'arraybuffer'
    let failed = ''
    const late = setTimeout(() => {
      if (socket === ws && state.is !== 'connected') drop({ is: 'offline', message: `The relay at ${url} did not welcome this machine within ${CONNECT_MS / 1000} seconds.` })
    }, CONNECT_MS)
    ws.addEventListener('message', (event) => {
      if (socket !== ws) return
      try {
        if (typeof event.data === 'string') return heard(event.data)
        const bytes = new Uint8Array(event.data as ArrayBuffer)
        if (bytes[0] === ANSWER) answered(bytes)
        else if (bytes[0] === STREAM) emit('stream', bytes)
      } catch (error) {
        console.error(`${new Date().toISOString()} anyhost read no message of the relay: ${messageOf(error)}`)
      }
    })
    ws.addEventListener('open', () => {
      if (socket !== ws) return
      pinger = setInterval(() => {
        if (socket !== ws || pongDue !== undefined) return
        ws.send('ping')
        pongDue = setTimeout(() => {
          if (socket === ws) drop({ is: 'offline', message: `The relay at ${url} answered no ping within ${PONG_MS / 1000} seconds.` })
        }, PONG_MS)
      }, PING_MS)
    })
    ws.addEventListener('error', (event) => void (failed = (event as ErrorEvent).message ?? ''))
    ws.addEventListener('close', (event) => {
      clearTimeout(late)
      if (socket !== ws) return
      const why = event.reason || failed
      const refusal = refusedBy(event.code, event.reason, options.device)
      if (refusal?.is === 'unjoined') {
        unjoined = refusal.message
        forgetting = options.forget(used).catch((error: unknown) => console.error(`${new Date().toISOString()} anyhost could not forget the relay login the relay refused: ${messageOf(error)}`))
      }
      drop(refusal ?? { is: 'offline', message: `The relay at ${url} closed the connection with ${event.code}${why === '' ? '' : `: ${why}`}.` })
    })
  }

  // One message of ops within its limits.
  const request = (calls: readonly Call[]): Promise<{ results: readonly Result[]; bytes: Uint8Array }> => {
    if (!options.isPatient && 'message' in state) return Promise.reject(new Error(state.message))
    const id = nextId++
    const message = encodeMessage(REQUEST, { id, ops: calls.map(toOp) }, calls.flatMap((call) => (call.op === 'put' ? [call.bytes] : [])))
    return new Promise((resolve, reject) => {
      const asked: Pending = { message, wasSent: false, resolve, reject }
      pending.set(id, asked)
      if (state.is === 'connected') send(asked)
    })
  }

  // An object request, tried again after a failed connection or a relay error.
  async function tryObject<T>(what: string, attempt: (login: Login) => Promise<T | undefined>): Promise<T> {
    let last = ''
    for (let tries = 1; ; tries += 1) {
      const done = await attempt(await welcomedLogin()).catch((error: unknown) => {
        if (error instanceof Refused) throw error
        last = messageOf(error)
        return undefined
      })
      if (done !== undefined) return done
      if (tries === OBJECT_TRIES) throw new Error(`The relay failed ${what} ${OBJECT_TRIES} times${last === '' ? '' : `, the last time with ${last}`}.`)
      await Bun.sleep(RETRY_MS[tries - 1] ?? 0)
    }
  }

  const putObject = (call: Extract<Call, { readonly op: 'put' }>): Promise<Ran> =>
    tryObject(`PUT ${call.key}`, async (from): Promise<Ran | undefined> => {
      const headers = new Headers({ authorization: `Bearer ${from.token}`, 'content-type': 'application/octet-stream' })
      if (call.if !== undefined) {
        if ('none' in call.if) headers.set('if-none-match', '*')
        else headers.set('if-match', `"${call.if.match}"`)
      }
      if (call.holder !== undefined) headers.set('x-anyhost-holder', call.holder)
      const answer = await fetch(objectUrl(from, call.key), { method: 'PUT', headers, body: call.bytes, signal: AbortSignal.timeout(REQUEST_MS + Math.ceil(call.bytes.length / SLOWEST_UPLOAD_BYTES_PER_MS)) })
      if (answer.status !== 200 && answer.status !== 409 && answer.status !== 412) return await failureOf(answer)
      const body = (await answer.json()) as { etag?: string; holder?: DeviceRef }
      if (answer.status === 409 && body.holder !== undefined) return { status: 409, holder: body.holder }
      if (answer.status === 412) return written(call, body.etag === undefined ? { status: 412 } : { status: 412, etag: body.etag })
      return { status: 200, etag: body.etag ?? '' }
    })

  const getObject = async (key: string): Promise<Got | undefined> => {
    const parts: Uint8Array[] = []
    let got = 0
    let etag = ''
    const found = await tryObject(`GET ${key}`, async (from): Promise<Got | 'missing' | undefined> => {
      const controller = new AbortController()
      let idle = setTimeout(() => controller.abort(new Error(`no byte came for ${IDLE_MS / 1000} seconds`)), IDLE_MS)
      try {
        const answer = await fetch(objectUrl(from, key), { headers: { authorization: `Bearer ${from.token}`, ...(got > 0 ? { range: `bytes=${got}-` } : {}) }, signal: controller.signal })
        if (answer.status === 404) return 'missing'
        if (answer.status !== 200 && answer.status !== 206 && answer.status !== 416) return await failureOf(answer)
        // an object written again between two tries starts over
        if (answer.status !== 206 || unquoted(answer.headers.get('etag')) !== etag) {
          parts.length = 0
          got = 0
          if (answer.status !== 200) {
            await answer.body?.cancel()
            return undefined
          }
        }
        etag = unquoted(answer.headers.get('etag'))
        const range = answer.headers.get('content-range')
        const size = range === null ? Number(answer.headers.get('content-length')) : Number(range.split('/')[1])
        const reader = answer.body?.getReader()
        for (let chunk = await reader?.read(); chunk !== undefined && !chunk.done; chunk = await reader?.read()) {
          parts.push(chunk.value)
          got += chunk.value.length
          clearTimeout(idle)
          idle = setTimeout(() => controller.abort(new Error(`no byte came for ${IDLE_MS / 1000} seconds`)), IDLE_MS)
        }
        if (got !== size) return undefined
        return { status: 200, etag, size, modified: new Date(answer.headers.get('last-modified') ?? 0).toISOString(), bytes: Buffer.concat(parts) }
      } finally {
        clearTimeout(idle)
      }
    })
    return found === 'missing' ? undefined : found
  }

  const run = (calls: readonly Call[]): Promise<Ran>[] => {
    const answers: Promise<Ran>[] = []
    let batch: { readonly position: number; readonly call: Call }[] = []
    let bytes = 0
    const flush = (): void => {
      if (batch.length === 0) return
      const sent = batch
      // a get's bytes follow the header in the order of the gets answered 200
      const results = request(sent.map(({ call }) => call)).then(({ results, bytes: parts }) => {
        let at = 0
        return results.map((result, index) => {
          if (sent[index]?.call.op !== 'get' || result.status !== 200 || !('size' in result)) return result
          at += result.size
          return { ...result, bytes: parts.subarray(at - result.size, at) } satisfies Got
        })
      })
      for (const [index, { position, call }] of sent.entries()) {
        answers[position] = results.then(async (all): Promise<Ran> => {
          const result = all[index]
          if (result === undefined) throw new Error(`The relay answered no result for ${call.op}${'key' in call ? ` ${call.key}` : ''}.`)
          if ('error' in result) throw new Error(result.message)
          if (result.status === 413 && call.op === 'get') return (await getObject(call.key)) ?? { status: 404 }
          return written(call, result as Ran)
        })
      }
      batch = []
      bytes = 0
    }
    for (const [position, call] of calls.entries()) {
      if (call.op === 'put' && call.bytes.length > MAX_MESSAGE_BYTES) {
        answers[position] = putObject(call)
        continue
      }
      const size = call.op === 'put' ? call.bytes.length : 0
      if (batch.length === MAX_OPS || bytes + size > MAX_MESSAGE_BYTES) flush()
      batch.push({ position, call })
      bytes += size
    }
    flush()
    return answers
  }

  void open()
  return {
    get state() {
      return state
    },
    get url() {
      return login?.url ?? ''
    },
    run,
    async list(prefix) {
      const listed: Listed[] = []
      let cursor: string | undefined
      do {
        const page = await run([{ op: 'list', prefix, ...(cursor === undefined ? {} : { cursor }) }])[0]
        if (page === undefined || !('objects' in page)) throw new Error(`The relay answered no list of ${prefix}.`)
        listed.push(...page.objects)
        cursor = page.cursor
      } while (cursor !== undefined)
      return listed
    },
    getObject,
    send(message) {
      if (state.is !== 'connected' || socket === undefined) return false
      socket.send(message instanceof Uint8Array ? message : JSON.stringify(message))
      return true
    },
    on(kind, listener) {
      listeners[kind] = [...(listeners[kind] ?? []), listener]
    },
    // a state with a message waits to open again, and a connecting or connected socket needs nothing
    reconnect() {
      if (isClosed || !('message' in state)) return
      clearTimeout(reopen)
      failures = 0
      void open()
    },
    close() {
      isClosed = true
      clearTimeout(reopen)
      drop(state)
      failPending('anyhost closed its connection to the relay.')
    },
  }
}
