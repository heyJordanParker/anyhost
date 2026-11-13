import plugin from '../../.claude-plugin/plugin.json'
import {
  ANSWER,
  CLOSE_DEVICE_LIVE,
  CLOSE_OLDER_PROGRAM,
  CLOSE_REMOVED,
  CLOSE_UNKNOWN_TOKEN,
  LIVE_MS,
  MAX_MESSAGE_BYTES,
  MAX_OPS,
  PING_MS,
  PROTOCOL_VERSION,
  REMOVED_MESSAGE,
  REQUEST,
  cloneFixFor,
  conditionHeaders,
  decodeMessage,
  encodeMessage,
  type Answer,
  type Claimed,
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

const PONG_MS = 40_000
const ANSWER_MS = 40_000
const CONNECT_MS = 10_000
const RETRY_MS = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000]
export const waitAfter = (failures: number): number => RETRY_MS[Math.min(failures, RETRY_MS.length) - 1] ?? 0
const REQUEST_MS = 120_000
const SLOWEST_UPLOAD_BYTES_PER_MS = 100
const LATE_PING_MS = LIVE_MS - Math.ceil(MAX_MESSAGE_BYTES / SLOWEST_UPLOAD_BYTES_PER_MS)
const IDLE_MS = 30_000
const OBJECT_TRIES = 6

export type Login = { readonly url: string; readonly token: string }
export type Call = Exclude<Op, { readonly op: 'put' }> | { readonly op: 'put'; readonly key: string; readonly bytes: Uint8Array; readonly if?: Condition; readonly holder?: string }
type Got = { readonly status: 200; readonly etag: string; readonly size: number; readonly bytes: Uint8Array }
export type RanOf<K extends Op['op']> = K extends 'get' ? Got | { readonly status: 304; readonly etag: string } | { readonly status: 404 } : Results[K]
export type Read = Got | { readonly status: 404 }
type Ran = RanOf<Op['op']>
export type RelayState =
  | { readonly is: 'connecting' }
  | { readonly is: 'connected'; readonly welcome: Welcome }
  | { readonly is: 'unjoined' | 'offline' | 'refused' | 'outdated'; readonly message: string }
type Events = { readonly welcome: Welcome; readonly released: Released; readonly claimed: Claimed; readonly offline: Offline } & {
  readonly [T in Delivered['t']]: Extract<Delivered, { readonly t: T }>
}

export type Relay = {
  readonly state: RelayState
  readonly url: string
  run(calls: readonly Call[]): Promise<Ran>[]
  runOne<C extends Call>(call: C): Promise<RanOf<C['op']>>
  list(prefix: string): Promise<Listed[]>
  getObject(key: string): Promise<Got | undefined>
  read(keys: readonly string[]): Promise<Read[]>
  send(message: Routed | Heard): boolean
  on<K extends keyof Events>(kind: K, listener: (message: Events[K]) => void): () => void
  reconnect(): void
  close(): void
}

export type RelayOptions = {
  readonly login: () => Promise<Login | undefined>
  readonly forget: (refused: Login) => Promise<void>
  readonly device: { readonly name: string; readonly os: string }
  readonly roots: Roots
  readonly isPatient: boolean
  readonly onOlderProgram?: (message: string) => void
}

class Refused extends Error {}

const NOT_JOINED = 'This machine is not joined to your relay, so anyhost keeps what its sessions write and uploads nothing.'
export const DAILY_LIMIT = 'Cloudflare refuses the relay with its error 1027: the relay\'s Worker reached the Free plan\'s limit of 100,000 requests a day, which resets at 00:00 UTC.'
export const isDailyLimit = (status: number, body: string): boolean => status === 429 && body.includes('error code: 1027')
export const ROWS_LIMIT = 'Cloudflare refuses the relay\'s database: it read the Free plan\'s 5,000,000 rows of the day, which resets at 00:00 UTC. The program keeps every change meanwhile and uploads it once the relay answers.'
export const isRowsLimit = (message: string): boolean => message.includes('Exceeded allowed rows read')
const md5 = (bytes: Uint8Array): string => new Bun.CryptoHasher('md5').update(bytes).digest('hex')
const objectUrl = (login: Login, key: string): string => `${login.url}/v1/objects/${key.split('/').map(encodeURIComponent).join('/')}`
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const unquoted = (etag: string | null): string => (etag ?? '').replace(/^(W\/)?"|"$/g, '')

const toOp = (call: Call): Op =>
  call.op === 'put' ? { op: 'put', key: call.key, size: call.bytes.length, ...(call.if === undefined ? {} : { if: call.if }), ...(call.holder === undefined ? {} : { holder: call.holder }) } : call

const written = (call: Call, result: Ran): Ran => (call.op === 'put' && result.status === 412 && 'etag' in result && result.etag === md5(call.bytes) ? { status: 200, etag: result.etag } : result)

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

function refusedBy(code: number, reason: string, device: RelayOptions['device']): Extract<RelayState, { readonly message: string }> | undefined {
  if (code === CLOSE_REMOVED) return { is: 'unjoined', message: REMOVED_MESSAGE }
  if (code === CLOSE_UNKNOWN_TOKEN) return { is: 'unjoined', message: 'The relay knows no machine with this token. Join it again with a link from Add a machine.' }
  if (code === CLOSE_DEVICE_LIVE) return { is: 'refused', message: `The relay refused ${device.name}: ${reason} A machine cloned from another keeps its id, so anyhost captures nothing here. ${cloneFixFor(device.os)}` }
  if (code === CLOSE_OLDER_PROGRAM) {
    return {
      is: 'refused',
      message: `The relay refused ${device.name}: ${reason} Run cmod update anyhost, or, to run anyhost ${plugin.version} here on purpose, run anyhost join with the link anyhost machines --invite prints on a joined machine.`,
    }
  }
  return undefined
}

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
  const waiting = new Set<{ readonly resolve: (login: Login) => void; readonly reject: (error: Error) => void }>()
  let state: RelayState = { is: 'connecting' }
  let login: Login | undefined
  let unjoined = NOT_JOINED
  let forgetting: Promise<void> = Promise.resolve()
  let socket: WebSocket | undefined
  let nextId = 1
  let failures = 0
  let opens = 0
  let isClosed = false
  let reopen: ReturnType<typeof setTimeout> | undefined
  let pinger: ReturnType<typeof setInterval> | undefined
  let pingedAt = 0
  let pongDue: ReturnType<typeof setTimeout> | undefined
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
  const isLate = (): boolean => {
    const since = Date.now() - pingedAt
    if (socket === undefined || since <= LATE_PING_MS) return false
    console.error(`${new Date().toISOString()} anyhost last pinged the relay at ${login?.url} ${Math.round(since / 1000)} seconds ago, as before this machine slept, so it connects again before it sends anything more.`)
    drop({ is: 'connecting' })
    return true
  }
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
    if (pending.size > 0) waitForAnswer()
    else {
      clearTimeout(answerDue)
      answerDue = undefined
    }
    if ('error' in answer) request.reject(new Error(`The relay refused the request: ${answer.message}`))
    else request.resolve({ results: answer.results, bytes })
  }

  const control = (ws: WebSocket, used: Login, text: string): void => {
    const message = JSON.parse(text) as FromPool
    if (message.t === 'welcome') {
      if (message.protocol < PROTOCOL_VERSION) {
        drop({ is: 'outdated', message: `The relay at ${login?.url} answers protocol ${message.protocol}, and anyhost ${plugin.version} needs ${PROTOCOL_VERSION}. Connect Cloudflare again to update the relay.` })
        return
      }
      failures = 0
      state = { is: 'connected', welcome: message }
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
      headers: { authorization: `Bearer ${login.token}`, 'x-anyhost-version': plugin.version, 'x-anyhost-name': options.device.name, 'x-anyhost-roots': rootsHeader(options.roots) },
    })
    socket = ws
    ws.binaryType = 'arraybuffer'
    let failed = ''
    const late = setTimeout(() => {
      if (socket === ws && state.is !== 'connected') drop({ is: 'offline', message: `The relay at ${url} did not welcome this machine within ${CONNECT_MS / 1000} seconds.` })
    }, CONNECT_MS)
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
      } catch (error) {
        console.error(`${new Date().toISOString()} anyhost read no message of the relay: ${messageOf(error)}`)
      }
    })
    ws.addEventListener('open', () => {
      if (socket !== ws) return
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
      if (refusal !== undefined && event.code === CLOSE_OLDER_PROGRAM) {
        drop(refusal)
        return options.onOlderProgram?.(refusal.message)
      }
      if (refusal !== undefined || !failed.endsWith('status code: 429')) return drop(refusal ?? offline)
      void fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(CONNECT_MS) })
        .then(async (answer) => isDailyLimit(answer.status, await answer.text()), () => false)
        .then((isLimit) => {
          if (socket === ws) drop(isLimit ? { is: 'offline', message: DAILY_LIMIT } : offline)
        })
    })
  }

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
        'x-anyhost-version': plugin.version,
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
        const answer = await fetch(objectUrl(from, key), { headers: { authorization: `Bearer ${from.token}`, 'x-anyhost-version': plugin.version, ...(got > 0 ? { range: `bytes=${got}-` } : {}) }, signal: controller.signal })
        if (answer.status === 404) return 'missing'
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

  const known = new Map<string, Got>()
  const read = (keys: readonly string[]): Promise<Read[]> => {
    const answers = run(keys.map((key): Call => {
      const etag = known.get(key)?.etag
      return { op: 'get', key, ...(etag === undefined ? {} : { if: { noneMatch: etag } }) }
    }))
    return Promise.all(
      answers.map(async (answer, at): Promise<Read> => {
        const key = keys[at] ?? ''
        const result = (await answer) as RanOf<'get'>
        const kept = known.get(key)
        if (result.status === 304 && kept !== undefined) return kept
        if (result.status === 304) throw new Error(`The relay answered that ${key} did not change, and anyhost has no copy of it.`)
        if (result.status === 404) known.delete(key)
        else known.set(key, result)
        return result
      }),
    )
  }

  const run = (calls: readonly Call[]): Promise<Ran>[] => {
    const answers: Promise<Ran>[] = []
    let batch: { readonly position: number; readonly call: Call }[] = []
    let bytes = 0
    const flush = (): void => {
      if (batch.length === 0) return
      const sent = batch
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
          if (result.status === 413 && call.op === 'get' && 'etag' in result && result.etag === call.if?.noneMatch) return { status: 304, etag: result.etag }
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
    read,
    send(message) {
      if (state.is !== 'connected' || socket === undefined || isLate()) return false
      socket.send(JSON.stringify(message))
      return true
    },
    on(kind, listener) {
      listeners[kind] = [...(listeners[kind] ?? []), listener]
      return () => {
        listeners[kind] = (listeners[kind] ?? []).filter((each) => each !== listener)
      }
    },
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
