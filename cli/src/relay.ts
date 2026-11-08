// The one connection between this program and the person's relay: a WebSocket that carries every request of ops and
// every message, and HTTPS for each object over MAX_MESSAGE_BYTES, which the relay's Worker streams to and from R2.
// The socket pings every PING_MS, counts PONG_MS with nothing heard while a ping waits as a drop, and opens again at
// once, then after 1, 2, 4 and up to 60 seconds. A socket whose last ping is so old that the Pool may have counted it
// not live, as after the machine slept, carries nothing more: the next ping or send opens a new socket instead. A request the relay never answered goes again on the next socket, and
// a put that finds its own bytes there counts as written, so a dropped answer writes nothing twice.
import plugin from '../../.claude-plugin/plugin.json'
import {
  ANSWER,
  CLOSE_DEVICE_LIVE,
  CLOSE_REMOVED,
  CLOSE_UNKNOWN_TOKEN,
  LIVE_MS,
  MAX_MESSAGE_BYTES,
  MAX_OPS,
  PING_MS,
  PROTOCOL_VERSION,
  REMOVED_MESSAGE,
  REQUEST,
  STREAM,
  cloneFixFor,
  conditionHeaders,
  decodeMessage,
  encodeMessage,
  type Answer,
  type Condition,
  type Delivered,
  type DeviceRef,
  type FromPool,
  type Heard,
  type Listed,
  type Offline,
  type Op,
  type Released,
  type Result,
  type Results,
  type Roots,
  type Routed,
  type Welcome,
} from '../../relay/protocol.ts'

// A ping goes every PING_MS whatever the socket carries, and the socket counts as dropped once nothing came for
// PONG_MS while a ping waits. The pong comes behind the data the Pool sent before it, so every message heard proves the
// socket alive, as one at 240 KB/s carries a seal's 16 answers of about 700 KB each, the last past 40 s.
const PONG_MS = 40_000
// A socket that brings no answer for ANSWER_MS while a request sent on it waits counts as dropped, and every request it
// had not answered goes again on the next one, as no ping finds a lost answer: the Pool answers pings without waking,
// so a pong is no answer. Each answer starts the wait again, so a slow link that keeps answering is never dropped. A
// drain was answered in 1,714 ms at p90 and 2,098 ms at most over 20 drains (relay-spec R10), and one answer of
// MAX_MESSAGE_BYTES takes 10.5 s at the 100 KB/s a write counts as the slowest link. So only a lost answer waits this
// long, which no path of the Pool loses today, as it answers a get whose body R2 failed with `storage`, and so does
// nothing else on a dropped socket (PONG_MS).
const ANSWER_MS = 40_000
// A socket opened in 494 to 689 ms on a home link (R16).
const CONNECT_MS = 10_000
const RETRY_MS = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000]
// The wait before the next try after `failures` tries in a row failed: 1, 2, 4 and up to 60 seconds, none before a
// failure. `anyhost attach` waits as long between its tries to attach again and to dial the host directly.
export const waitAfter = (failures: number): number => RETRY_MS[Math.min(failures, RETRY_MS.length) - 1] ?? 0
// A write gets REQUEST_MS and as long again as its bytes take at 100 KB/s. A Mac whose uploads moved at 0.4 to 0.9 MB/s
// failed a frame holding a 67 MB tool result, 50 MB compressed, at 120 s on every try. Bun never ends an upload that
// stopped moving, so only a total limit ends one the network dropped.
const REQUEST_MS = 120_000
const SLOWEST_UPLOAD_BYTES_PER_MS = 100
// A ping arrives up to 10.49 s after it went, behind 1 MiB at the slowest link, so one that goes more than LATE_PING_MS
// (34.51 s) after the ping before it may reach the Pool past LIVE_MS after that one, which then counted the socket not
// live, as while this machine slept with its socket open. A takeover meanwhile sent its `released` only to live
// sockets, and an idle machine's pings never wake the Pool to send it again, so such a ping, or any request or
// message sent that late, opens a new socket instead, whose welcome carries the `released` before anything goes up.
const LATE_PING_MS = LIVE_MS - Math.ceil(MAX_MESSAGE_BYTES / SLOWEST_UPLOAD_BYTES_PER_MS)
// A download that moves no byte for this long goes on, in its next try, from the byte it reached.
const IDLE_MS = 30_000
// A redeploy reset a GET that started 10 seconds after it, and the same GET a minute later finished (R14): 6 tries
// wait 1, 2, 4, 8 and 16 seconds between them.
const OBJECT_TRIES = 6

export type Login = { readonly url: string; readonly token: string }
// A put carries its bytes, whose length its op names as `size`.
export type Call = Exclude<Op, { readonly op: 'put' }> | { readonly op: 'put'; readonly key: string; readonly bytes: Uint8Array; readonly if?: Condition; readonly holder?: string }
type Got = { readonly status: 200; readonly etag: string; readonly size: number; readonly bytes: Uint8Array }
// An op's answer, a get's with its bytes, which come by HTTP when the relay's answer had no room for them. A result that
// names an error, as a failed R2 call does, rejects instead.
export type RanOf<K extends Op['op']> = K extends 'get' ? Got | { readonly status: 404 } : Results[K]
type Ran = RanOf<Op['op']>
// `connected` once the welcome came. `unjoined` is no login, as before a join or after the relay refused the login for
// good, `offline` a relay that does not answer or a login that failed to read, each tried again, `outdated` a relay
// that answers an older protocol than this program speaks, while an older relay at this protocol is `connected`, and
// `refused` a clone of a connected machine.
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
  // one op, answered with its own op's result
  runOne<C extends Call>(call: C): Promise<RanOf<C['op']>>
  // every object under the prefix, a page of list at a time
  list(prefix: string): Promise<Listed[]>
  // one object by HTTP, which a broken download's next try goes on with from the byte it reached
  getObject(key: string): Promise<Got | undefined>
  // A message for another machine, a `heard` for the Pool, or an attach stream's bytes, on the socket the relay
  // welcomed. Answers false while no socket is, and the message goes nowhere.
  send(message: Routed | Heard | Uint8Array): boolean
  // calls `listener` with each message of the kind, until the function it answers is called
  on<K extends keyof Events>(kind: K, listener: (message: Events[K]) => void): () => void
  // connects at once on the login read now, closing the socket open on the last one, as after this machine joined
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
// Cloudflare answers a Worker past the Free plan's 100,000 requests a day with 429 and `error code: 1027` until midnight
// UTC (workers/platform/limits, "Daily requests"), while open sockets go on carrying requests, which are no Worker
// requests. Cloudflare's documentation names no status or body for 1027: 429 and that body are what workers.dev answered
// a client that is no browser (github.com/rancher/rke2/issues/11326). anyhost doctor reads the relay's health the same way.
export const DAILY_LIMIT = 'Cloudflare refuses the relay with its error 1027: the relay\'s Worker reached the Free plan\'s limit of 100,000 requests a day, which resets at 00:00 UTC.'
export const isDailyLimit = (status: number, body: string): boolean => status === 429 && body.includes('error code: 1027')
const md5 = (bytes: Uint8Array): string => new Bun.CryptoHasher('md5').update(bytes).digest('hex')
const objectUrl = (login: Login, key: string): string => `${login.url}/v1/objects/${key.split('/').map(encodeURIComponent).join('/')}`
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const unquoted = (etag: string | null): string => (etag ?? '').replace(/^(W\/)?"|"$/g, '')

const toOp = (call: Call): Op =>
  call.op === 'put' ? { op: 'put', key: call.key, size: call.bytes.length, ...(call.if === undefined ? {} : { if: call.if }), ...(call.holder === undefined ? {} : { holder: call.holder }) } : call

// A put whose condition failed while the object holds its own bytes is written: a try again after a lost answer, or
// bytes an earlier try already put there.
const written = (call: Call, result: Ran): Ran => (call.op === 'put' && result.status === 412 && 'etag' in result && result.etag === md5(call.bytes) ? { status: 200, etag: result.etag } : result)

// Throws why an HTTP answer failed: an Error the next try may fix, which the try records, as a relay error a redeploy
// gives, Cloudflare's daily limit, or a range past the end of an object written again shorter, which the next try reads
// from byte 0; and a Refused no try fixes.
async function failureOf(answer: Response): Promise<never> {
  const body = await answer.text().catch(() => '')
  if (isDailyLimit(answer.status, body)) throw new Error(DAILY_LIMIT)
  const message = ((): string | undefined => {
    try {
      return (JSON.parse(body) as { message?: string } | null)?.message
    } catch {
      return undefined
    }
  })() ?? `The relay answered ${answer.status}.`
  if (answer.status >= 500 || answer.status === 429 || answer.status === 416) throw new Error(message)
  throw new Refused(message)
}

// The state a refusal no try fixes leaves. A removed machine's token and one the relay never knew are the relay's final
// answer for that login, so the machine forgets it and is unjoined.
function refusedBy(code: number, reason: string, device: RelayOptions['device']): RelayState | undefined {
  if (code === CLOSE_REMOVED) return { is: 'unjoined', message: REMOVED_MESSAGE }
  if (code === CLOSE_UNKNOWN_TOKEN) return { is: 'unjoined', message: 'The relay knows no machine with this token. Join it again with a link from Add a machine.' }
  if (code === CLOSE_DEVICE_LIVE) return { is: 'refused', message: `The relay refused ${device.name}: ${reason} A machine cloned from another keeps its id, so anyhost captures nothing here. ${cloneFixFor(device.os)}` }
  return undefined
}

// A header holds Latin-1 alone, so a root's other characters go as JSON escapes, which the relay reads back the same.
const rootsHeader = (roots: Roots): string => JSON.stringify(roots).replace(/[^\x20-\x7e]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)

type Pending = {
  readonly id: number
  readonly message: Uint8Array
  wasSent: boolean
  readonly resolve: (answer: { results: readonly Result[]; bytes: Uint8Array }) => void
  readonly reject: (error: Error) => void
}

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
  // counts the opens, so only the latest one opens a socket once its login is read
  let opens = 0
  let isClosed = false
  let reopen: ReturnType<typeof setTimeout> | undefined
  let pinger: ReturnType<typeof setInterval> | undefined
  // when the socket open now last pinged, on the wall clock, which counts the time the machine slept, as Linux's
  // monotonic clock does not
  let pingedAt = 0
  let pongDue: ReturnType<typeof setTimeout> | undefined
  // the socket's one wait for an answer, while a request sent on it waits for its own
  let answerDue: ReturnType<typeof setTimeout> | undefined

  const failPending = (message: string): void => {
    for (const [id, request] of pending) {
      pending.delete(id)
      request.reject(new Error(message))
    }
    for (const waiter of waiting) waiter.reject(new Error(message))
    waiting.clear()
  }
  const waitForAnswer = (): void => {
    clearTimeout(answerDue)
    answerDue = setTimeout(() => drop({ is: 'offline', message: `The relay at ${login?.url} sent no answer for ${ANSWER_MS / 1000} seconds while a request waited.` }), ANSWER_MS)
  }
  // Whether the socket open now last pinged more than LATE_PING_MS ago, as before this machine slept with it open: then
  // it carries nothing more, and a new socket opens, whose welcome comes before anything this program sends. The timers
  // of a machine that wakes fire in the order they came due, so a drain's can come before the pinger's.
  const isLate = (): boolean => {
    const since = Date.now() - pingedAt
    if (socket === undefined || since <= LATE_PING_MS) return false
    console.error(`${new Date().toISOString()} anyhost last pinged the relay at ${login?.url} ${Math.round(since / 1000)} seconds ago, as before this machine slept, so it connects again before it sends anything more.`)
    drop({ is: 'connecting' })
    return true
  }
  // a request on the socket the relay welcomed
  const send = (on: WebSocket, request: Pending): void => {
    if (isLate()) return
    on.send(request.message)
    request.wasSent = true
    if (answerDue === undefined) waitForAnswer()
  }
  const welcomedLogin = (): Promise<Login> => {
    if (state.is === 'connected' && login !== undefined && !isLate()) return Promise.resolve(login)
    if (!options.isPatient && 'message' in state) return Promise.reject(new Error(state.message))
    return new Promise((resolve, reject) => waiting.add({ resolve, reject }))
  }

  // The socket is gone, and its events count no more. The next one opens at once after a socket the relay welcomed,
  // else after the next wait of RETRY_MS.
  const drop = (next: RelayState): void => {
    clearInterval(pinger)
    clearTimeout(pongDue)
    pongDue = undefined
    clearTimeout(answerDue)
    answerDue = undefined
    const was = socket
    socket = undefined
    was?.terminate()
    const wasConnected = state.is === 'connected'
    state = next
    if (isClosed) return
    if (wasConnected && 'message' in next) console.error(`${new Date().toISOString()} ${next.message}${next.is === 'unjoined' ? '' : ' anyhost connects again.'}`)
    if (!wasConnected) failures += 1
    if (!wasConnected && !options.isPatient && 'message' in next) failPending(next.message)
    reopen = setTimeout(() => void open(), wasConnected ? 0 : waitAfter(failures))
  }

  const answered = (message: Uint8Array): void => {
    const { header, bytes } = decodeMessage(message)
    const answer = header as Answer
    const request = answer.id === null ? undefined : pending.get(answer.id)
    if (request === undefined) {
      if ('error' in answer) console.error(`${new Date().toISOString()} The relay refused a request: ${answer.message}`)
      return
    }
    pending.delete(request.id)
    // every request still pending went out on this socket, as the welcome sends each one
    if (pending.size > 0) waitForAnswer()
    else {
      clearTimeout(answerDue)
      answerDue = undefined
    }
    if ('error' in answer) request.reject(new Error(`The relay refused the request: ${answer.message}`))
    else request.resolve({ results: answer.results, bytes })
  }

  // A text message of the Pool's on the socket `ws` opened with the login `used`.
  const control = (ws: WebSocket, used: Login, text: string): void => {
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
      for (const request of unanswered) send(ws, request)
      for (const waiter of waiting) waiter.resolve(used)
      waiting.clear()
      return
    }
    if (message.t === 'invalid') console.error(`${new Date().toISOString()} The relay read no message of this program: ${message.message}`)
    else emit(message.t, message as never)
  }

  const open = async (): Promise<void> => {
    const attempt = (opens += 1)
    state = { is: 'connecting' }
    await forgetting
    let read: Login | undefined
    try {
      read = await options.login()
    } catch (error) {
      if (isClosed || attempt !== opens) return
      // a token cmod could not read, or a relay.json that is no JSON, says nothing of whether this machine joined
      const message = `anyhost could not read this machine's relay login: ${messageOf(error)}`
      console.error(`${new Date().toISOString()} ${message}`)
      return drop({ is: 'offline', message })
    }
    if (isClosed || attempt !== opens) return
    login = read
    if (login === undefined) return drop({ is: 'unjoined', message: unjoined })
    unjoined = NOT_JOINED
    const used = login
    const url = login.url
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/v1/connect`, {
      headers: { authorization: `Bearer ${login.token}`, 'x-anyhost-name': options.device.name, 'x-anyhost-roots': rootsHeader(options.roots) },
    })
    socket = ws
    ws.binaryType = 'arraybuffer'
    let failed = ''
    const late = setTimeout(() => {
      if (socket === ws && state.is !== 'connected') drop({ is: 'offline', message: `The relay at ${url} did not welcome this machine within ${CONNECT_MS / 1000} seconds.` })
    }, CONNECT_MS)
    // the wait for a ping's pong, which each message heard meanwhile starts again
    const awaitPong = (): void => {
      clearTimeout(pongDue)
      pongDue = setTimeout(() => {
        if (socket === ws) drop({ is: 'offline', message: `The relay at ${url} sent nothing for ${PONG_MS / 1000} seconds after a ping.` })
      }, PONG_MS)
    }
    ws.addEventListener('message', (event) => {
      if (socket !== ws) return
      if (event.data === 'pong') {
        clearTimeout(pongDue)
        pongDue = undefined
        return
      }
      if (pongDue !== undefined) awaitPong()
      try {
        if (typeof event.data === 'string') return control(ws, used, event.data)
        const bytes = new Uint8Array(event.data as ArrayBuffer)
        if (bytes[0] === ANSWER) answered(bytes)
        else if (bytes[0] === STREAM) emit('stream', bytes)
      } catch (error) {
        console.error(`${new Date().toISOString()} anyhost read no message of the relay: ${messageOf(error)}`)
      }
    })
    ws.addEventListener('open', () => {
      if (socket !== ws) return
      // the Pool counts the connect as it counts a ping
      pingedAt = Date.now()
      pinger = setInterval(() => {
        if (socket !== ws || isLate()) return
        pingedAt = Date.now()
        ws.send('ping')
        if (pongDue === undefined) awaitPong()
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
      const offline: RelayState = { is: 'offline', message: `The relay at ${url} closed the connection with ${event.code}${why === '' ? '' : `: ${why}`}.` }
      // Bun names the status of a connect Cloudflare refused, never its body, so a 429 reads the relay's health for the
      // body that says the daily limit
      if (refusal !== undefined || !failed.endsWith('status code: 429')) return drop(refusal ?? offline)
      void fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(CONNECT_MS) })
        .then(async (answer) => isDailyLimit(answer.status, await answer.text()), () => false)
        .then((isLimit) => {
          if (socket === ws) drop(isLimit ? { is: 'offline', message: DAILY_LIMIT } : offline)
        })
    })
  }

  // One message of ops within its limits.
  const request = (calls: readonly Call[]): Promise<{ results: readonly Result[]; bytes: Uint8Array }> => {
    if (!options.isPatient && 'message' in state) return Promise.reject(new Error(state.message))
    const id = nextId++
    const message = encodeMessage(REQUEST, { id, ops: calls.map(toOp) }, calls.flatMap((call) => (call.op === 'put' ? [call.bytes] : [])))
    return new Promise((resolve, reject) => {
      const asked: Pending = { id, message, wasSent: false, resolve, reject }
      pending.set(id, asked)
      if (state.is === 'connected' && socket !== undefined) send(socket, asked)
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
      await Bun.sleep(waitAfter(tries))
    }
  }

  const putObject = (call: Extract<Call, { readonly op: 'put' }>): Promise<Ran> =>
    tryObject(`PUT ${call.key}`, async (from): Promise<Ran | undefined> => {
      const headers = new Headers({
        authorization: `Bearer ${from.token}`,
        'content-type': 'application/octet-stream',
        ...(call.if === undefined ? {} : conditionHeaders(call.if)),
        ...(call.holder === undefined ? {} : { 'x-anyhost-holder': call.holder }),
      })
      const answer = await fetch(objectUrl(from, call.key), { method: 'PUT', headers, body: call.bytes, signal: AbortSignal.timeout(REQUEST_MS + Math.ceil(call.bytes.length / SLOWEST_UPLOAD_BYTES_PER_MS)) })
      if (answer.status !== 200 && answer.status !== 409 && answer.status !== 412) return await failureOf(answer)
      const body = (await answer.json()) as { etag?: string; holder?: DeviceRef }
      if (answer.status === 409 && body.holder !== undefined) return { status: 409, holder: body.holder }
      if (answer.status === 412) return written(call, body.etag === undefined ? { status: 412 } : { status: 412, etag: body.etag })
      if (answer.status === 200 && body.etag !== undefined) return { status: 200, etag: body.etag }
      throw new Refused(`The relay answered ${answer.status} with no ${answer.status === 409 ? 'holder' : 'etag'} to the PUT of ${call.key}.`)
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
        // An object written again between two tries starts over from byte 0: one shorter than the bytes read refuses
        // their range, and a longer one answers it with its new etag. A whole object is the answer to no range, or to a
        // range the relay did not serve.
        const isNew = answer.status === 416 || (answer.status === 206 && unquoted(answer.headers.get('etag')) !== etag)
        if (answer.status === 200 || isNew) {
          parts.length = 0
          got = 0
        }
        if (answer.status === 206 && isNew) {
          await answer.body?.cancel()
          throw new Error(`${key} was written again while anyhost read it`)
        }
        if (answer.status !== 200 && answer.status !== 206) return await failureOf(answer)
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
        if (got !== size) throw new Error(`the download of ${key} ended at byte ${got} of ${size}`)
        return { status: 200, etag, size, bytes: Buffer.concat(parts) }
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
  // The relay answers each op with the result Results names for it, so the one call's answer is its op's.
  const runOne = <C extends Call>(call: C): Promise<RanOf<C['op']>> => run([call])[0] as Promise<RanOf<C['op']>>

  void open()
  return {
    get state() {
      return state
    },
    get url() {
      return login?.url ?? ''
    },
    run,
    runOne,
    async list(prefix) {
      const listed: Listed[] = []
      let cursor: string | undefined
      do {
        const page = await runOne({ op: 'list', prefix, ...(cursor === undefined ? {} : { cursor }) })
        listed.push(...page.objects)
        cursor = page.cursor
      } while (cursor !== undefined)
      return listed
    },
    getObject,
    send(message) {
      if (state.is !== 'connected' || socket === undefined || isLate()) return false
      socket.send(message instanceof Uint8Array ? message : JSON.stringify(message))
      return true
    },
    // a new list at each change, so an emit that runs calls the listeners it began with
    on(kind, listener) {
      listeners[kind] = [...(listeners[kind] ?? []), listener]
      return () => {
        listeners[kind] = (listeners[kind] ?? []).filter((each) => each !== listener)
      }
    },
    // The socket open or opening on the login read before closes, as its object requests would use that login, which a
    // join since replaced, and the next opens at once on the login read now. Every request it had not answered goes
    // again on the next socket.
    reconnect() {
      if (isClosed) return
      drop({ is: 'connecting' })
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
