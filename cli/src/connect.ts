import { rmSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { COMPATIBILITY_DATE, PROTOCOL_VERSION, RELAY_VERSION, type Health, type JoinRequest, type Joined, type Refusal } from '../../relay/protocol.ts'
import relayModule from '../../relay/dist/relay.js' with { type: 'text' }
import { rootsHere, saveRelayLogin, stateFolder, type Device } from './device.ts'

export type RelayNames = { readonly worker: string; readonly bucket: string }
const RELAY: RelayNames = { worker: 'anyhost', bucket: 'anyhost' }

export type Account = { readonly id: string; readonly name: string }

export type Progress = {
  readonly say: (line: string) => void
  readonly pickAccount: (accounts: readonly Account[]) => Promise<Account>
  readonly enableR2: (page: string) => Promise<void>
}

type CfEnvironment = Readonly<Record<string, string | undefined>>

export type Cloudflare = {
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
  readonly cf: (args: readonly string[], env: CfEnvironment, say?: (line: string) => void) => Promise<string>
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

const API = 'https://api.cloudflare.com/client/v4'
const CF = 'cf@1.0.0-beta.26'
const R2_PAGE = 'https://dash.cloudflare.com/?to=/:account/r2/overview'
const ASK_EVERY_MS = 1000
const REQUEST_MS = 60_000
const TRIES = 6
const LIST_SIZE = 1000
const CF_MS = 2 * 60_000
const ROUTE_LIMIT_MS = 30_000
const SECRET_LIMIT_MS = 10 * 60_000

const INVALID_TOKEN = 9109
const R2_NOT_ENTITLED = 10042
const NO_SUBDOMAIN = 10007
const NO_WORKER = 10007
const SUBDOMAIN_TAKEN = 10031
const SUBDOMAIN_FREE = 10032
const NO_BUCKET = 10006
const BUCKET_EXISTS = 10073

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function jsonOf<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

const logLine = (line: string): void => console.error(`${new Date().toISOString()} ${line}`)

async function linesOf(stream: ReadableStream<Uint8Array>, say?: (line: string) => void): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  let line = ''
  for await (const bytes of stream) {
    const chunk = decoder.decode(bytes, { stream: true })
    text += chunk
    line += chunk
    const lines = line.split('\n')
    line = lines.pop() ?? ''
    for (const done of lines) if (done.trim() !== '') say?.(done)
  }
  if (line.trim() !== '') say?.(line)
  return text
}

export async function runCf(args: readonly string[], env: CfEnvironment, say?: (line: string) => void, limitMs = CF_MS): Promise<string> {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries({ ...process.env, ...env, BUN_BE_BUN: '1', NO_COLOR: '1' })) if (value !== undefined) environment[name] = value
  const started = Date.now()
  const child = Bun.spawn([process.execPath, 'x', '--bun', CF, ...args], { env: environment, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', ...(say === undefined ? { timeout: limitMs, killSignal: 'SIGKILL' } : {}) })
  const [output, error] = [linesOf(child.stdout, say), linesOf(child.stderr, say)]
  const code = await child.exited
  if (say === undefined && child.signalCode === 'SIGKILL' && Date.now() - started >= limitMs) throw new Error(`cf ${args.join(' ')} ran past its limit of ${limitMs / 1000} s, so anyhost stopped it.`)
  const [printed, failed] = await Promise.all([output, error])
  if (code !== 0) throw new Error(`cf ${args.join(' ')} exited with ${code}: ${failed.trim().split('\n').slice(-3).join(' ')}`)
  return printed
}

const CLOUDFLARE: Cloudflare = { fetch: (url, init) => fetch(url, init), cf: runCf, now: Date.now, sleep: Bun.sleep }

type Login = { readonly env: CfEnvironment; readonly accounts: readonly Account[]; readonly token: () => Promise<string>; readonly say: (line: string) => void }
type WhoAmI = { readonly authenticated: boolean; readonly authSource?: string; readonly accounts?: readonly Account[] }

async function whoami(cloudflare: Cloudflare, env: CfEnvironment): Promise<WhoAmI> {
  const output = await cloudflare.cf(['auth', 'whoami'], env)
  const who = jsonOf<WhoAmI>(output)
  if (who === undefined) throw new Error(`cf auth whoami printed no login: ${output.trim().slice(0, 200)}`)
  return who
}

function readableToken(who: WhoAmI, apiToken: string | undefined): (() => Promise<string>) | undefined {
  const file = /^OAuth token from (.+\.json)$/.exec(who.authSource ?? '')?.[1]
  if (file !== undefined) return async () => ((await Bun.file(file).json()) as { oauth_token: string }).oauth_token
  if (who.authSource === 'CLOUDFLARE_API_TOKEN environment variable' && apiToken !== undefined) return async () => apiToken
  return undefined
}

const ownLoginFolder = (): string => joinPath(stateFolder(), 'connect')

async function loginOf(cloudflare: Cloudflare, progress?: Progress, apiToken = process.env['CLOUDFLARE_API_TOKEN']): Promise<Login> {
  const say = progress?.say ?? logLine
  say('Checking your Cloudflare login')
  const env: CfEnvironment = apiToken === undefined ? {} : { CLOUDFLARE_API_TOKEN: apiToken }
  let who = await whoami(cloudflare, env)
  if (!who.authenticated) {
    if (progress === undefined) throw new Error('cf is logged in to no Cloudflare account on this machine. Connect Cloudflare logs it in.')
    say('Log in to Cloudflare: approve cf on the page that opens, or open the link below on any device.')
    await cloudflare.cf(['auth', 'login'], env, say)
    who = await whoami(cloudflare, env)
    if (!who.authenticated) throw new Error('cf is still logged in to no Cloudflare account. Approve cf on Cloudflare\'s page, then connect again.')
  }
  const token = readableToken(who, apiToken)
  if (token !== undefined) return { env, accounts: who.accounts ?? [], token, say }
  if (progress === undefined) throw new Error(`cf keeps its login encrypted (${who.authSource ?? 'no source'}), which anyhost cannot read with no one watching. Connect Cloudflare logs cf in for the update.`)
  const ownEnv: CfEnvironment = { XDG_CONFIG_HOME: ownLoginFolder(), CLOUDFLARE_AUTH_USE_KEYRING: undefined }
  say('cf keeps your login encrypted, where anyhost cannot read it, so cf logs in once more for this setup alone. Approve it on the page that opens, or open the link below on any device.')
  await cloudflare.cf(['auth', 'login', '--no-use-keyring'], ownEnv, say)
  const own = await whoami(cloudflare, ownEnv)
  const ownToken = readableToken(own, undefined)
  if (!own.authenticated || ownToken === undefined) throw new Error(`cf's login for this setup left no token anyhost can read: ${own.authSource ?? 'no login'}.`)
  return { env: ownEnv, accounts: own.accounts ?? [], token: ownToken, say }
}

type Envelope<T> = { readonly success: boolean; readonly errors: readonly { readonly code: number; readonly message: string }[]; readonly result: T; readonly result_info?: { readonly cursor?: string; readonly is_truncated?: boolean } }
type Answer<T> = Envelope<T> & { readonly status: number }

const hasError = (envelope: Envelope<unknown>, code: number): boolean => envelope.errors.some((error) => error.code === code)

function refused(envelope: Envelope<unknown>, what: string): never {
  throw new Error(`${what} failed: ${envelope.errors.map(({ code, message }) => `${code} ${message}`).join('; ') || 'Cloudflare named no error'}.`)
}

const resultOf = <T>(envelope: Envelope<T>, what: string): T => (envelope.success ? envelope.result : refused(envelope, what))

async function answerTo(cloudflare: Cloudflare, url: string, init: RequestInit, say: (line: string) => void): Promise<Response> {
  const what = `${init.method ?? 'GET'} ${url}`
  for (let tried = 1, wait = 1000; ; tried += 1, wait *= 2) {
    try {
      return await cloudflare.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_MS) })
    } catch (error) {
      if (tried === TRIES) throw new Error(`${what} got no answer in ${TRIES} tries of up to ${REQUEST_MS / 1000} s: ${messageOf(error)}`)
      const happened = error instanceof DOMException && error.name === 'TimeoutError' ? `got no answer within ${REQUEST_MS / 1000} s (${error.message})` : `failed with no answer (${messageOf(error)})`
      say(`${what} ${happened}, so anyhost asks again in ${wait / 1000} s, try ${tried + 1} of ${TRIES}.`)
      await cloudflare.sleep(wait)
    }
  }
}

async function call<T>(cloudflare: Cloudflare, login: Login, method: string, path: string, body?: { readonly json: object } | { readonly form: FormData }, headers: Record<string, string> = {}): Promise<Answer<T>> {
  const send = async (): Promise<{ readonly status: number; readonly envelope: Envelope<T> | undefined }> => {
    const answer = await answerTo(
      cloudflare,
      `${API}${path}`,
      {
        method,
        headers: { authorization: `Bearer ${await login.token()}`, ...(body !== undefined && 'json' in body ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body === undefined ? {} : { body: 'json' in body ? JSON.stringify(body.json) : body.form }),
      },
      login.say,
    )
    const envelope = jsonOf<Envelope<T> | null>(await answer.text())
    return { status: answer.status, envelope: typeof envelope?.success === 'boolean' ? envelope : undefined }
  }
  let answer = await send()
  if (answer.status === 401 || (answer.envelope !== undefined && hasError(answer.envelope, INVALID_TOKEN))) {
    await cloudflare.cf(['auth', 'whoami'], login.env)
    answer = await send()
  }
  if (answer.envelope === undefined) throw new Error(`Cloudflare answered ${method} ${path} with ${answer.status} and no API answer.`)
  return { ...answer.envelope, status: answer.status }
}

type Bucket = { readonly name: string; readonly jurisdiction: string }

const JURISDICTIONS = ['default', 'eu'] as const

async function findOrMakeBucket(cloudflare: Cloudflare, login: Login, account: Account, name: string): Promise<Bucket | 'off'> {
  for (const jurisdiction of JURISDICTIONS) {
    const found = await call(cloudflare, login, 'GET', `/accounts/${account.id}/r2/buckets/${name}`, undefined, { 'cf-r2-jurisdiction': jurisdiction })
    if (found.success) {
      login.say(`Found the bucket ${name} in the ${jurisdiction} jurisdiction`)
      return { name, jurisdiction }
    }
    if (hasError(found, R2_NOT_ENTITLED)) return 'off'
    if (!hasError(found, NO_BUCKET)) refused(found, `Looking for the bucket ${name}`)
  }
  login.say(`Making the bucket ${name}`)
  const made = await call(cloudflare, login, 'POST', `/accounts/${account.id}/r2/buckets`, { json: { name } })
  if (made.success || hasError(made, BUCKET_EXISTS)) return { name, jurisdiction: 'default' }
  return hasError(made, R2_NOT_ENTITLED) ? 'off' : refused(made, `Making the bucket ${name}`)
}

async function bucketOf(cloudflare: Cloudflare, login: Login, account: Account, name: string, progress?: Progress): Promise<Bucket> {
  for (;;) {
    const bucket = await findOrMakeBucket(cloudflare, login, account, name)
    if (bucket !== 'off') return bucket
    if (progress === undefined) throw new Error(`R2 is off in the Cloudflare account ${account.name}. Connect Cloudflare turns it on.`)
    progress.say(`R2 is off in ${account.name}. Turn it on at ${R2_PAGE}, then go on.`)
    await progress.enableR2(R2_PAGE)
  }
}

const RECORD = /^devices\/[^/]+\.json$/

async function recordsIn(cloudflare: Cloudflare, login: Login, account: Account, bucket: string, header: Record<string, string>): Promise<ReadonlyMap<string, number>> {
  const records = new Map<string, number>()
  for (let cursor = ''; ; ) {
    const listed = await call<readonly { readonly key: string; readonly last_modified?: string }[]>(cloudflare, login, 'GET', `/accounts/${account.id}/r2/buckets/${bucket}/objects?prefix=${encodeURIComponent('devices/')}&per_page=${LIST_SIZE}${cursor === '' ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, undefined, header)
    for (const { key, last_modified } of resultOf(listed, `Looking for anyhost 0.2's machine records in the bucket ${bucket}`)) if (RECORD.test(key)) records.set(key, Date.parse(last_modified ?? '') || 0)
    cursor = listed.result_info?.is_truncated === true ? (listed.result_info.cursor ?? '') : ''
    if (cursor === '') return records
  }
}

async function firstBucketOf(cloudflare: Cloudflare, login: Login, account: Account, name: string, device: string): Promise<string> {
  const holding: { readonly name: string; readonly newestAt: number; readonly ownAt: number | undefined }[] = []
  for (const jurisdiction of JURISDICTIONS) {
    const header = { 'cf-r2-jurisdiction': jurisdiction }
    for (let cursor = ''; ; ) {
      const listed = await call<{ readonly buckets: readonly { readonly name: string }[] }>(cloudflare, login, 'GET', `/accounts/${account.id}/r2/buckets?per_page=${LIST_SIZE}${cursor === '' ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, undefined, header)
      if (hasError(listed, R2_NOT_ENTITLED)) return name
      const { buckets } = resultOf(listed, `Listing the buckets of ${account.name}`)
      for (const bucket of buckets) {
        const records = await recordsIn(cloudflare, login, account, bucket.name, header)
        if (records.size > 0) holding.push({ name: bucket.name, newestAt: Math.max(...records.values()), ownAt: records.get(`devices/${device}.json`) })
      }
      cursor = listed.result_info?.cursor ?? ''
      if (cursor === '' || buckets.length < LIST_SIZE) break
    }
  }
  const own = holding.filter(({ ownAt }) => ownAt !== undefined).sort((one, other) => (other.ownAt ?? 0) - (one.ownAt ?? 0))
  const [chosen] = own.length > 0 ? own : [...holding].sort((one, other) => other.newestAt - one.newestAt)
  if (chosen === undefined) {
    login.say(`No bucket holds a machine record of anyhost 0.2, so your relay keeps every session in the bucket ${name}`)
    return name
  }
  const why = own.length === 0 ? `No bucket holds this machine's record, and the bucket ${chosen.name} holds the one written last` : `The bucket ${chosen.name} holds this machine's record${own.length === 1 ? '' : ' written last'}`
  const others = holding.filter((bucket) => bucket !== chosen).map((bucket) => bucket.name)
  const othersSaid = others.length === 0 ? '' : `. ${others.length === 1 ? `The bucket ${others[0]} holds` : `The buckets ${others.join(', ')} hold`} anyhost 0.2 machine records too, and the sessions there stay where they are`
  login.say(`anyhost 0.2 kept every session in the bucket its option R2 bucket named. ${why}, so your relay keeps every session in ${chosen.name}${othersSaid}`)
  return chosen.name
}

async function subdomainOf(cloudflare: Cloudflare, login: Login, account: Account): Promise<string> {
  const current = await call<{ subdomain: string }>(cloudflare, login, 'GET', `/accounts/${account.id}/workers/subdomain`)
  if (current.success) return current.result.subdomain
  if (!hasError(current, NO_SUBDOMAIN)) refused(current, 'Reading the workers.dev subdomain')
  const named = account.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 63).replace(/-+$/, '')
  const checked = named === '' ? undefined : await call(cloudflare, login, 'GET', `/accounts/${account.id}/workers/subdomains/${named}`)
  if (checked !== undefined && !checked.success && !hasError(checked, SUBDOMAIN_TAKEN) && !hasError(checked, SUBDOMAIN_FREE)) refused(checked, `Checking the workers.dev subdomain ${named}`)
  const subdomain = checked === undefined || hasError(checked, SUBDOMAIN_TAKEN) ? `anyhost-${Buffer.from(crypto.getRandomValues(new Uint8Array(3))).toString('hex')}` : named
  login.say(`Registering the workers.dev subdomain ${subdomain}`)
  return resultOf(await call<{ subdomain: string }>(cloudflare, login, 'PUT', `/accounts/${account.id}/workers/subdomain`, { json: { subdomain } }), `Registering the workers.dev subdomain ${subdomain}`).subdomain
}

async function accountsHolding(cloudflare: Cloudflare, login: Login, worker: string): Promise<{ readonly readable: readonly Account[]; readonly holding: readonly Account[] }> {
  const readable: Account[] = []
  const holding: Account[] = []
  for (const account of login.accounts) {
    const settings = await call(cloudflare, login, 'GET', `/accounts/${account.id}/workers/scripts/${worker}/settings`)
    if (!settings.success && settings.status === 403 && !hasError(settings, INVALID_TOKEN)) {
      login.say(`Your Cloudflare login may not read the Workers of ${account.name} (403 ${settings.errors.map(({ code, message }) => `${code} ${message}`).join('; ')}), so anyhost leaves that account out`)
      continue
    }
    if (!settings.success && !hasError(settings, NO_WORKER)) refused(settings, `Looking for the Worker ${worker} in ${account.name}`)
    readable.push(account)
    if (settings.success) holding.push(account)
  }
  return { readable, holding }
}

const relayUrlOf = async (cloudflare: Cloudflare, login: Login, account: Account, worker: string): Promise<string> => `https://${worker}.${await subdomainOf(cloudflare, login, account)}.workers.dev`

export const needsUpload = ({ relay, protocol }: Pick<Health, 'relay' | 'protocol'>): boolean => relay < RELAY_VERSION || protocol < PROTOCOL_VERSION

const isCloudflare404 = (answer: Response): boolean => answer.status === 404 && (answer.headers.get('content-type') ?? '').startsWith('text/html')

async function healthAt(cloudflare: Cloudflare, url: string, say: (line: string) => void, routeLimitMs = 0): Promise<Health> {
  const started = cloudflare.now()
  for (;;) {
    const answer = await answerTo(cloudflare, `${url}/v1/health`, {}, say)
    const body = await answer.text()
    const health = answer.ok ? jsonOf<Partial<Health> | null>(body) : undefined
    if (typeof health?.relay === 'number' && typeof health.protocol === 'number' && typeof health.bucket === 'string') return { relay: health.relay, protocol: health.protocol, bucket: health.bucket }
    const text = body.trim().slice(0, 200)
    if (!isCloudflare404(answer) || routeLimitMs === 0) throw new Error(`${url}/v1/health answered ${answer.status} ${text}, which names no relay version, so anyhost uploads nothing over the Worker there. Try again later.`)
    if (cloudflare.now() - started >= routeLimitMs) {
      throw new Error(`${url}/v1/health still answered Cloudflare's 404 page ${routeLimitMs / 1000} s after anyhost turned its route on, so anyhost uploads nothing over the Worker there. Try again later. Its answer: ${text}`)
    }
    await cloudflare.sleep(ASK_EVERY_MS)
  }
}

const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex')

async function deploy(cloudflare: Cloudflare, login: Login, account: Account, names: RelayNames, isFirst: boolean, setupCode: string | undefined, progress?: Progress): Promise<void> {
  const bucket = await bucketOf(cloudflare, login, account, names.bucket, progress)
  const metadata = {
    main_module: 'relay.js',
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [
      { type: 'r2_bucket', name: 'BUCKET', bucket_name: bucket.name, ...(bucket.jurisdiction === 'default' ? {} : { jurisdiction: bucket.jurisdiction }) },
      { type: 'durable_object_namespace', name: 'POOL', class_name: 'Pool' },
      { type: 'plain_text', name: 'BUCKET_NAME', text: bucket.name },
      ...(setupCode === undefined ? [] : [{ type: 'secret_text', name: 'SETUP_CODE_SHA256', text: sha256(setupCode) }]),
    ],
    ...(setupCode === undefined ? { keep_bindings: ['secret_text'] } : {}),
    ...(isFirst ? { migrations: { new_tag: 'v1', new_sqlite_classes: ['Pool'] } } : {}),
  }
  const form = new FormData()
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  form.set('relay.js', new Blob([relayModule], { type: 'application/javascript+module' }), 'relay.js')
  login.say(`Uploading the relay as the Worker ${names.worker}`)
  resultOf(await call(cloudflare, login, 'PUT', `/accounts/${account.id}/workers/scripts/${names.worker}`, { form }), `Uploading the Worker ${names.worker}`)
}

async function turnOn(cloudflare: Cloudflare, login: Login, account: Account, names: RelayNames, url: string): Promise<void> {
  login.say(`Turning on ${url}`)
  resultOf(await call(cloudflare, login, 'POST', `/accounts/${account.id}/workers/scripts/${names.worker}/subdomain`, { json: { enabled: true, previews_enabled: false } }), `Turning on ${url}`)
}

export async function connectCloudflare(progress: Progress, device: Device, names: RelayNames = RELAY, cloudflare: Cloudflare = CLOUDFLARE, apiToken?: string): Promise<void> {
  try {
    const login = await loginOf(cloudflare, progress, apiToken)
    if (login.accounts.length === 0) throw new Error('Your Cloudflare login reaches no account.')
    const { readable, holding } = await accountsHolding(cloudflare, login, names.worker)
    if (readable.length === 0) throw new Error('Your Cloudflare login may read the Workers of none of its accounts. Log cf in to an account where you may deploy Workers, then connect again.')
    const choices = holding.length === 0 ? readable : holding
    const [only, ...more] = choices
    const account = only !== undefined && more.length === 0 ? only : await progress.pickAccount(choices)
    const url = await relayUrlOf(cloudflare, login, account, names.worker)
    const setupCode = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    const isFirst = holding.length === 0
    if (isFirst) await deploy(cloudflare, login, account, { worker: names.worker, bucket: await firstBucketOf(cloudflare, login, account, names.bucket, device.id) }, true, setupCode, progress)
    await turnOn(cloudflare, login, account, names, url)
    if (!isFirst) {
      const health = await healthAt(cloudflare, url, login.say, ROUTE_LIMIT_MS)
      if (needsUpload(health)) await deploy(cloudflare, login, account, { worker: names.worker, bucket: health.bucket }, false, setupCode, progress)
      else {
        login.say(`${url} runs relay ${health.relay} at protocol ${health.protocol}, which needs no upload of this anyhost's, so anyhost gives it a new setup code and uploads nothing`)
        const secret = { name: 'SETUP_CODE_SHA256', text: sha256(setupCode), type: 'secret_text' }
        resultOf(await call(cloudflare, login, 'PUT', `/accounts/${account.id}/workers/scripts/${names.worker}/secrets`, { json: secret }), `Setting the setup code of the Worker ${names.worker}`)
      }
    }
    login.say(`Joining ${url} once it takes the new setup code, for up to ${SECRET_LIMIT_MS / 60_000} minutes`)
    await exchangeCode(url, setupCode, device, cloudflare, login.say, SECRET_LIMIT_MS)
    login.say(`Joined this machine to ${url}`)
  } finally {
    rmSync(ownLoginFolder(), { recursive: true, force: true })
  }
}

export type Connecting = {
  readonly is: 'running' | 'joined' | 'failed'
  readonly lines: readonly string[]
  readonly accounts?: readonly Account[]
  readonly r2Page?: string
  readonly error?: string
}

export type ConnectRun = {
  readonly view: Connecting
  pickAccount(id: string): void
  turnedOnR2(): void
  readonly done: Promise<void>
}

export function connectForStep(device: Device, names: RelayNames = RELAY, cloudflare: Cloudflare = CLOUDFLARE, apiToken?: string): ConnectRun {
  let view: Connecting = { is: 'running', lines: [] }
  let answerAccount: ((account: Account) => void) | undefined
  let answerR2: (() => void) | undefined
  const progress: Progress = {
    say: (line) => void (view = { ...view, lines: [...view.lines, line] }),
    pickAccount: (accounts) =>
      new Promise((resolve) => {
        view = { ...view, accounts }
        answerAccount = resolve
      }),
    enableR2: (page) =>
      new Promise((resolve) => {
        view = { ...view, r2Page: page }
        answerR2 = resolve
      }),
  }
  const done = connectCloudflare(progress, device, names, cloudflare, apiToken).then(
    () => void (view = { ...view, is: 'joined' }),
    (error: unknown) => void (view = { ...view, is: 'failed', error: messageOf(error) }),
  )
  return {
    get view() {
      return view
    },
    pickAccount(id) {
      const account = view.accounts?.find((each) => each.id === id)
      if (account === undefined || answerAccount === undefined) throw new Error(`Connect Cloudflare asks for no account ${id} now.`)
      const { accounts: _, ...rest } = view
      view = rest
      answerAccount(account)
    },
    turnedOnR2() {
      if (view.r2Page === undefined || answerR2 === undefined) throw new Error('Connect Cloudflare waits for no R2 now.')
      const { r2Page: _, ...rest } = view
      view = rest
      answerR2()
    },
    done,
  }
}

export async function updateRelay(names: RelayNames = RELAY, cloudflare: Cloudflare = CLOUDFLARE): Promise<void> {
  const login = await loginOf(cloudflare)
  const { holding } = await accountsHolding(cloudflare, login, names.worker)
  const [account, ...more] = holding
  if (account === undefined || more.length > 0) {
    throw new Error(`${holding.length} accounts of your Cloudflare login hold the Worker ${names.worker}${holding.length > 0 ? `: ${holding.map(({ name }) => name).join(', ')}` : ''}, so anyhost updates none. Connect Cloudflare deploys it.`)
  }
  const url = await relayUrlOf(cloudflare, login, account, names.worker)
  const health = await healthAt(cloudflare, url, login.say)
  if (!needsUpload(health)) return login.say(`${url} runs relay ${health.relay} at protocol ${health.protocol}, which needs no upload of this anyhost's, so anyhost uploads nothing.`)
  await deploy(cloudflare, login, account, { worker: names.worker, bucket: health.bucket }, false, undefined)
}

export async function join(link: string, device: Device, cloudflare: Cloudflare = CLOUDFLARE): Promise<string> {
  const url = URL.parse(/https?:\/\/[^\s'"]+\/v1\/join#[\w-]+/.exec(link)?.[0] ?? link.trim())
  const code = url?.hash.slice(1) ?? ''
  if (url === null || url.pathname !== '/v1/join' || code === '') throw new Error(`${link} is no invite link, which reads https://<relay>/v1/join#<code>.`)
  await exchangeCode(url.origin, code, device, cloudflare, logLine)
  return url.origin
}

async function exchangeCode(origin: string, code: string, device: Device, cloudflare: Cloudflare, say: (line: string) => void, patienceMs = 0): Promise<void> {
  const url = `${origin}/v1/join`
  const request: JoinRequest = { invite: code, device: { ...device, roots: rootsHere() } }
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }
  if (patienceMs === 0) {
    const joined = await joinAnswerOf(origin, device, await answerTo(cloudflare, url, init, say))
    if ('wait' in joined) throw new Error(`${origin} refused to join ${device.name}: ${joined.wait}`)
    return await saveRelayLogin({ url: origin, token: joined.token })
  }
  const started = cloudflare.now()
  for (;;) {
    const limitMs = Math.max(1, Math.min(REQUEST_MS, patienceMs - (cloudflare.now() - started)))
    const joined = await cloudflare.fetch(url, { ...init, signal: AbortSignal.timeout(limitMs) }).then(
      (answer) => joinAnswerOf(origin, device, answer),
      (error: unknown): JoinAnswer => ({ wait: `no answer (${messageOf(error)}).`, isRefused: false }),
    )
    if ('token' in joined) return await saveRelayLogin({ url: origin, token: joined.token })
    if (cloudflare.now() + ASK_EVERY_MS - started >= patienceMs) {
      const minutes = patienceMs / 60_000
      throw new Error(
        joined.isRefused
          ? `${origin} still refused the setup code ${minutes} minutes after anyhost set it: ${joined.wait} Another Connect Cloudflare, as on another machine, may have set a newer setup code since. Press Connect Cloudflare again, or run anyhost connect.`
          : `${origin} did not join ${device.name} within ${minutes} minutes of the setup. Its last answer: ${joined.wait} Press Connect Cloudflare again, or run anyhost connect.`,
      )
    }
    await cloudflare.sleep(ASK_EVERY_MS)
  }
}

type JoinAnswer = { readonly token: string } | { readonly wait: string; readonly isRefused: boolean }

async function joinAnswerOf(origin: string, device: Device, answer: Response): Promise<JoinAnswer> {
  const text = await answer.text()
  const body = jsonOf<Partial<Joined & Refusal> | null>(text)
  if (answer.ok && typeof body?.token === 'string') return { token: body.token }
  const isPage = isCloudflare404(answer)
  if ((body === undefined || body === null) && !isPage) throw new Error(`${origin} answered the join with ${answer.status} and no relay answer: ${text.slice(0, 200)}`)
  const wait = body?.message ?? `${answer.status} ${text.trim().slice(0, 200)}`
  const isRefused = body?.error === 'invite_unknown'
  if (!(isPage || isRefused || body?.error === 'unavailable')) throw new Error(`${origin} refused to join ${device.name}: ${wait}`)
  return { wait, isRefused }
}
