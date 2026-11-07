// Connect Cloudflare and joining: deploys the relay into the person's own Cloudflare account with their own cf login,
// keeps it current, and joins machines to it. anyhost reads the access token cf keeps and never refreshes or writes
// cf's login: a refresh token works once, so two programs refreshing one login log the person out. anyhost creates no
// API token. relay-spec section 4 holds the calls and what each Cloudflare answer means.
import { rmSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { COMPATIBILITY_DATE, PROTOCOL_VERSION, RELAY_VERSION, type Health, type JoinRequest, type Joined, type Refusal } from '../../relay/protocol.ts'
import relayModule from '../../relay/dist/relay.js' with { type: 'text' }
import { rootsHere, saveRelayLogin, stateFolder, type Device } from './device.ts'

// The Worker that runs the relay, and the R2 bucket it keeps every session in. Test relays pass their own.
export type RelayNames = { readonly worker: string; readonly bucket: string }
const RELAY: RelayNames = { worker: 'anyhost', bucket: 'anyhost' }

export type Account = { readonly id: string; readonly name: string }

// What the person sees and answers while Connect Cloudflare runs.
export type Progress = {
  // each call as it runs, and every line cf prints while it logs in, such as the link and code to approve on any device
  readonly say: (line: string) => void
  // the account to put the relay in, when the cf login reaches several
  readonly pickAccount: (accounts: readonly Account[]) => Promise<Account>
  // R2 is off in the account: resolves once the person turned it on at `page`, and the setup tries the bucket again
  readonly enableR2: (page: string) => Promise<void>
}

// Variables to set in cf's environment, or to remove from it as undefined.
type CfEnvironment = Readonly<Record<string, string | undefined>>

// What setup reaches beyond this program: Cloudflare's API and the relay over `fetch`, cf, and the clock the setup
// waits on, which `now` reads and `sleep` moves. Tests pass stand-ins.
export type Cloudflare = {
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
  // Runs cf with `args` and answers what it printed to stdout. A run that waits on the person, as a login does, hands
  // every line it prints to `say`, and any other ends after CF_MS.
  readonly cf: (args: readonly string[], env: CfEnvironment, say?: (line: string) => void) => Promise<string>
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

const API = 'https://api.cloudflare.com/client/v4'
const CF = 'cf@1.0.0-beta.26'
// the docs' own link to turn R2 on, which the dashboard opens in the person's account (r2/get-started)
const R2_PAGE = 'https://dash.cloudflare.com/?to=/:account/r2/overview'
// how often a health read or a join asks again while its answer says to wait
const ASK_EVERY_MS = 1000
const REQUEST_MS = 60_000
const TRIES = 6
// the most one page of a list of buckets or objects holds, which Cloudflare caps at 1000 (`per_page`)
const LIST_SIZE = 1000
// A cf run that needs no person, such as `cf auth whoami`, ends after CF_MS, so a cf that never exits holds nothing for
// good. A first `bun x` of cf downloaded its 184 packages in 5.2 s on the Architect's Mac at a load average around
// 100, and a cached one ran in 0.13 s.
const CF_MS = 2 * 60_000
// The Worker's workers.dev route, turned on by turnOn, answered Cloudflare's own 404 page (`text/html; charset=UTF-8`,
// `<!DOCTYPE html>…`) 13 ms after the call returned 200, and the relay's /v1/health 0.55 s and 1.4 s after it in two
// live runs, steadily from then on (docs/agents/20261103-anyhost/live-setup/task.md, measured in the live-setup entry of
// docs/agents/20261103-anyhost/triage.md). So right after turnOn the health read asks again while that page answers,
// for up to ROUTE_LIMIT_MS, 20 times the slowest. The join after a first setup follows turnOn at once, and a new
// subdomain's DNS "may take a few minutes" (cf), so the join asks again while that page answers too.
const ROUTE_LIMIT_MS = 30_000
// A new setup code deploys a new version of the Worker, by a new secret or an upload of the relay. Cloudflare serves each
// Worker request with the newest version, and the Worker checks the setup code against its own secret, so a new secret
// joins at once. A Durable Object busy with requests keeps its old code for up to 300 s
// (durable-objects/deployments/durable-objects-code-updates), so a join after an upload of a new relay version can meet
// the Pool's old code, or the Worker's 503 `unavailable` while the Pool resets, until Cloudflare runs the new Pool code:
// a live run with a joined machine keeping the Pool busy waited 300.4 s after an upload. So the join asks again for up
// to SECRET_LIMIT_MS, every ASK_EVERY_MS.
const SECRET_LIMIT_MS = 10 * 60_000

const INVALID_TOKEN = 9109
const R2_NOT_ENTITLED = 10042
const NO_SUBDOMAIN = 10007
const NO_WORKER = 10007
const SUBDOMAIN_TAKEN = 10031
const SUBDOMAIN_FREE = 10032
const NO_BUCKET = 10006
// "Bucket name already exists." (r2/api/error-codes), as a make whose answer was lost and that was sent again finds it
const BUCKET_EXISTS = 10073

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// The JSON value `text` holds, or undefined when it holds none, as Cloudflare's own pages and cf's errors do. Every
// answer setup and anyhost doctor read goes through it.
export function jsonOf<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

// where the calls of a setup no person watches say what they wait for: the program's log, or the command's terminal
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

// cf runs pinned through this program: a compiled Bun program runs as `bun` with BUN_BE_BUN set, so a machine needs
// neither Node nor a cf of its own. A run without `say` needs no person, and Bun kills it after `limitMs`, which only a
// test sets.
export async function runCf(args: readonly string[], env: CfEnvironment, say?: (line: string) => void, limitMs = CF_MS): Promise<string> {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries({ ...process.env, ...env, BUN_BE_BUN: '1', NO_COLOR: '1' })) if (value !== undefined) environment[name] = value
  const started = Date.now()
  const child = Bun.spawn([process.execPath, 'x', '--bun', CF, ...args], { env: environment, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', ...(say === undefined ? { timeout: limitMs, killSignal: 'SIGKILL' } : {}) })
  const [output, error] = [linesOf(child.stdout, say), linesOf(child.stderr, say)]
  const code = await child.exited
  // a process cf left holds the pipes open, so a killed run's output is not waited for
  if (say === undefined && child.signalCode === 'SIGKILL' && Date.now() - started >= limitMs) throw new Error(`cf ${args.join(' ')} ran past its limit of ${limitMs / 1000} s, so anyhost stopped it.`)
  const [printed, failed] = await Promise.all([output, error])
  if (code !== 0) throw new Error(`cf ${args.join(' ')} exited with ${code}: ${failed.trim().split('\n').slice(-3).join(' ')}`)
  return printed
}

const CLOUDFLARE: Cloudflare = { fetch: (url, init) => fetch(url, init), cf: runCf, now: Date.now, sleep: Bun.sleep }

// A cf login anyhost reads: the environment cf runs in, its accounts, the access token it keeps, read again before
// each call because only cf refreshes it, and where its calls say what they wait for.
type Login = { readonly env: CfEnvironment; readonly accounts: readonly Account[]; readonly token: () => Promise<string>; readonly say: (line: string) => void }
type WhoAmI = { readonly authenticated: boolean; readonly authSource?: string; readonly accounts?: readonly Account[] }

async function whoami(cloudflare: Cloudflare, env: CfEnvironment): Promise<WhoAmI> {
  const output = await cloudflare.cf(['auth', 'whoami'], env)
  const who = jsonOf<WhoAmI>(output)
  if (who === undefined) throw new Error(`cf auth whoami printed no login: ${output.trim().slice(0, 200)}`)
  return who
}

// The token a login holds in plain sight: in the JSON file cf names, or the API token cf ran with in
// CLOUDFLARE_API_TOKEN. A login cf keeps encrypted (`cf auth login --use-keyring`) names a file no other program reads.
function readableToken(who: WhoAmI, apiToken: string | undefined): (() => Promise<string>) | undefined {
  const file = /^OAuth token from (.+\.json)$/.exec(who.authSource ?? '')?.[1]
  if (file !== undefined) return async () => ((await Bun.file(file).json()) as { oauth_token: string }).oauth_token
  if (who.authSource === 'CLOUDFLARE_API_TOKEN environment variable' && apiToken !== undefined) return async () => apiToken
  return undefined
}

// The folder a keyring login logs cf in to for one setup, deleted when the setup ends.
const ownLoginFolder = (): string => joinPath(stateFolder(), 'connect')

// The person's cf login, logging cf in when nobody is. With no one watching (`progress` undefined), a login that needs
// the person fails instead, so the caller shows Connect Cloudflare. `apiToken` is the person's CLOUDFLARE_API_TOKEN,
// which `anyhost connect` sends the program, whose service environment has none, so cf runs with it for this login
// alone and nothing keeps it.
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
  // cf honours XDG_CONFIG_HOME, so this login lands in a folder of anyhost's own, in plain JSON, and the person's
  // encrypted login stays as it is
  const ownEnv: CfEnvironment = { XDG_CONFIG_HOME: ownLoginFolder(), CLOUDFLARE_AUTH_USE_KEYRING: undefined }
  say('cf keeps your login encrypted, where anyhost cannot read it, so cf logs in once more for this setup alone. Approve it on the page that opens, or open the link below on any device.')
  await cloudflare.cf(['auth', 'login', '--no-use-keyring'], ownEnv, say)
  const own = await whoami(cloudflare, ownEnv)
  const ownToken = readableToken(own, undefined)
  if (!own.authenticated || ownToken === undefined) throw new Error(`cf's login for this setup left no token anyhost can read: ${own.authSource ?? 'no login'}.`)
  return { env: ownEnv, accounts: own.accounts ?? [], token: ownToken, say }
}

// A list's answer names in `result_info.cursor` where its next page starts.
type Envelope<T> = { readonly success: boolean; readonly errors: readonly { readonly code: number; readonly message: string }[]; readonly result: T; readonly result_info?: { readonly cursor?: string } }

const hasError = (envelope: Envelope<unknown>, code: number): boolean => envelope.errors.some((error) => error.code === code)

function refused(envelope: Envelope<unknown>, what: string): never {
  throw new Error(`${what} failed: ${envelope.errors.map(({ code, message }) => `${code} ${message}`).join('; ') || 'Cloudflare named no error'}.`)
}

const resultOf = <T>(envelope: Envelope<T>, what: string): T => (envelope.success ? envelope.result : refused(envelope, what))

// The Architect's Mac's link reset 2 of 4 calls to Cloudflare's API in a row on 2026-11-05 (ECONNRESET), so a request
// that gets no answer tries again after 1, 2, 4, 8 and 16 seconds, as relay.ts retries an object. fetch waits forever
// by itself, and the slowest call of the test deploys, the relay's upload, took 2.7 s, so a try ends after 60 s. Each
// try again says on `say` what happened to the last one, and how long it waits.
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

// One Cloudflare API call. Cloudflare refuses an expired access token with 403 and 9109 (a 401 for others), and then cf
// refreshes it: `cf auth whoami` wrote a new token when the old one had expired. The call reads the token again and
// tries once more.
async function call<T>(cloudflare: Cloudflare, login: Login, method: string, path: string, body?: { readonly json: object } | { readonly form: FormData }, headers: Record<string, string> = {}): Promise<Envelope<T>> {
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
  return answer.envelope
}

type Bucket = { readonly name: string; readonly jurisdiction: string }

// The jurisdictions anyhost looks for a bucket in. Each answers only for its own buckets.
const JURISDICTIONS = ['default', 'eu'] as const

// The bucket named `name` in the default or the EU jurisdiction, made when neither has it, or `off` when R2 is off.
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
  // a make with no jurisdiction makes the bucket in the default one
  if (made.success || hasError(made, BUCKET_EXISTS)) return { name, jurisdiction: 'default' }
  return hasError(made, R2_NOT_ENTITLED) ? 'off' : refused(made, `Making the bucket ${name}`)
}

// An account that never turned R2 on answers 10042, and no API turns it on, so the person does it on the dashboard and
// the bucket is tried again.
async function bucketOf(cloudflare: Cloudflare, login: Login, account: Account, name: string, progress?: Progress): Promise<Bucket> {
  for (;;) {
    const bucket = await findOrMakeBucket(cloudflare, login, account, name)
    if (bucket !== 'off') return bucket
    if (progress === undefined) throw new Error(`R2 is off in the Cloudflare account ${account.name}. Connect Cloudflare turns it on.`)
    progress.say(`R2 is off in ${account.name}. Turn it on at ${R2_PAGE}, then go on.`)
    await progress.enableR2(R2_PAGE)
  }
}

// The bucket a first relay binds: `name`, unless another bucket holds anyhost 0.2's machine records, `devices/<id>.json`.
// anyhost 0.2 kept every session in the bucket its option R2 bucket named, which cmod 5.13's `cmod options` no longer
// prints once the mod declares no such option, so that bucket is known only by the records 0.2 wrote there. The relay's
// first start imports them from its bucket, and the sessions stay where 0.2 put them. Each 0.2 machine wrote its record
// again every 5 minutes, so of several such buckets the one whose newest record was written last is the one 0.2 used
// last. An account with R2 off holds none.
async function firstBucketOf(cloudflare: Cloudflare, login: Login, account: Account, name: string): Promise<string> {
  const holding: { readonly name: string; readonly writtenAt: number }[] = []
  for (const jurisdiction of JURISDICTIONS) {
    const header = { 'cf-r2-jurisdiction': jurisdiction }
    for (let cursor = ''; ; ) {
      const listed = await call<{ readonly buckets: readonly { readonly name: string }[] }>(cloudflare, login, 'GET', `/accounts/${account.id}/r2/buckets?per_page=${LIST_SIZE}${cursor === '' ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, undefined, header)
      if (hasError(listed, R2_NOT_ENTITLED)) return name
      const { buckets } = resultOf(listed, `Listing the buckets of ${account.name}`)
      for (const bucket of buckets.filter((each) => each.name !== name)) {
        const listedRecords = await call<readonly { readonly last_modified?: string }[]>(cloudflare, login, 'GET', `/accounts/${account.id}/r2/buckets/${bucket.name}/objects?prefix=${encodeURIComponent('devices/')}&per_page=${LIST_SIZE}`, undefined, header)
        const records = resultOf(listedRecords, `Looking for anyhost 0.2's records in the bucket ${bucket.name}`)
        if (records.length > 0) holding.push({ name: bucket.name, writtenAt: Math.max(...records.map(({ last_modified }) => Date.parse(last_modified ?? '') || 0)) })
      }
      cursor = listed.result_info?.cursor ?? ''
      if (cursor === '' || buckets.length < LIST_SIZE) break
    }
  }
  const [newest, ...others] = [...holding].sort((one, other) => other.writtenAt - one.writtenAt)
  if (newest === undefined) return name
  const kept = 'which kept every session in the bucket its option R2 bucket named'
  const othersNamed = others.map((other) => other.name).join(', ')
  login.say(
    others.length === 0
      ? `The bucket ${newest.name} holds the machine records of anyhost 0.2, ${kept}, so your relay keeps every session in ${newest.name}`
      : `The buckets ${newest.name}, ${othersNamed} hold the machine records of anyhost 0.2, ${kept}. ${newest.name} holds the most recently written, so your relay keeps every session in ${newest.name}, and the sessions in ${othersNamed} stay where they are`,
  )
  return newest.name
}

// The account's workers.dev subdomain, registered the way cf registers one when the account has none: its name in
// lowercase letters, digits and `-`, else `anyhost-` and 6 hex digits when that is taken.
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

// The accounts of the login that hold the Worker `worker`, in the login's order.
async function accountsHolding(cloudflare: Cloudflare, login: Login, worker: string): Promise<Account[]> {
  const holding: Account[] = []
  for (const account of login.accounts) {
    const settings = await call(cloudflare, login, 'GET', `/accounts/${account.id}/workers/scripts/${worker}/settings`)
    if (!settings.success && !hasError(settings, NO_WORKER)) refused(settings, `Looking for the Worker ${worker} in ${account.name}`)
    if (settings.success) holding.push(account)
  }
  return holding
}

// The address the Worker answers at, on the account's workers.dev subdomain.
const relayUrlOf = async (cloudflare: Cloudflare, login: Login, account: Account, worker: string): Promise<string> => `https://${worker}.${await subdomainOf(cloudflare, login, account)}.workers.dev`

// Whether the relay that answered these versions, in /v1/health or its welcome, needs this program's upload: an older
// relay, or one that answers an older protocol, as a protocol bump that left RELAY_VERSION as it was makes. Connect
// Cloudflare, updateRelay and the program's welcome all decide by this rule, so no machine uploads over a relay as new
// as its own in both.
export const needsUpload = ({ relay, protocol }: Pick<Health, 'relay' | 'protocol'>): boolean => relay < RELAY_VERSION || protocol < PROTOCOL_VERSION

// Cloudflare's own page at a workers.dev address whose route is off or not yet live, which the relay never answers.
const isCloudflare404 = (answer: Response): boolean => answer.status === 404 && (answer.headers.get('content-type') ?? '').startsWith('text/html')

// What the Worker at `url` answers in /v1/health: its versions, and the bucket it binds, which an upload over it binds
// again. Cloudflare's own 404 page is asked again every ASK_EVERY_MS for up to `routeLimitMs`, as right after turnOn.
// Any other answer, such as Cloudflare's 429 `error code: 1027` past the Free plan's daily requests or a 503 of the
// relay's own, names no version, and the relay there may be newer than this program's, so it fails the setup before
// anything goes up.
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

// Uploads the relay this program carries as the Worker `names.worker`, bound to the bucket `names.bucket`: the one a
// first relay binds, or the one the relay there names, so an upload never moves a relay to another bucket. A first
// upload makes the Pool's SQLite class. With no `setupCode`, the upload keeps the setup code secret the last one set
// (R15). Nothing waits for the new version: the join after a setup asks again until it answers, and a relay update's
// program connects again once it does. `progress` answers only R2 being off, which bucketOf asks the person.
async function deploy(cloudflare: Cloudflare, login: Login, account: Account, names: RelayNames, isFirst: boolean, setupCode: string | undefined, progress?: Progress): Promise<void> {
  const bucket = await bucketOf(cloudflare, login, account, names.bucket, progress)
  const metadata = {
    main_module: 'relay.js',
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [
      { type: 'r2_bucket', name: 'BUCKET', bucket_name: bucket.name, ...(bucket.jurisdiction === 'default' ? {} : { jurisdiction: bucket.jurisdiction }) },
      { type: 'durable_object_namespace', name: 'POOL', class_name: 'Pool' },
      // the relay answers its bucket's name from it, which the R2 binding does not tell
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

// Turns on the Worker's workers.dev route at `url`, which a route already on takes again.
async function turnOn(cloudflare: Cloudflare, login: Login, account: Account, names: RelayNames, url: string): Promise<void> {
  login.say(`Turning on ${url}`)
  resultOf(await call(cloudflare, login, 'POST', `/accounts/${account.id}/workers/scripts/${names.worker}/subdomain`, { json: { enabled: true, previews_enabled: false } }), `Turning on ${url}`)
}

// Sets the relay up in the person's Cloudflare account and joins `device`, this machine, to it, in the one account of
// the login that holds the relay, else the login's one account, else the account the person picks. A missing relay gets
// this program's upload, bound to the bucket firstBucketOf picks, then its route turned on. A Worker there has its route
// turned on and its /v1/health read: a relay that needsUpload gets the upload with a new setup code, bound to the
// bucket it names, any other only a new setup code secret, and an answer that names no version fails the setup. The Pool takes each setup code from one machine, so any machine with the
// person's Cloudflare login joins without an invite. `apiToken` is the person's CLOUDFLARE_API_TOKEN, which loginOf
// reads from this process's environment when it is undefined.
export async function connectCloudflare(progress: Progress, device: Device, names: RelayNames = RELAY, cloudflare: Cloudflare = CLOUDFLARE, apiToken?: string): Promise<void> {
  try {
    const login = await loginOf(cloudflare, progress, apiToken)
    if (login.accounts.length === 0) throw new Error('Your Cloudflare login reaches no account.')
    const holding = await accountsHolding(cloudflare, login, names.worker)
    const choices = holding.length === 0 ? login.accounts : holding
    const [only, ...more] = choices
    const account = only !== undefined && more.length === 0 ? only : await progress.pickAccount(choices)
    const url = await relayUrlOf(cloudflare, login, account, names.worker)
    const setupCode = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    // the account picked holds the Worker whenever one does, and a route goes on only for a Worker that is there
    const isFirst = holding.length === 0
    if (isFirst) await deploy(cloudflare, login, account, { worker: names.worker, bucket: await firstBucketOf(cloudflare, login, account, names.bucket) }, true, setupCode, progress)
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

// Connect Cloudflare as the mod's Step shows it: `lines` holds every line said so far, and a question waits in
// `accounts` or `r2Page` until the person answers it on the Step.
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
  // resolves once the run joined this machine or failed
  readonly done: Promise<void>
}

// Runs connectCloudflare in the program for the mod's Step and `anyhost connect`, which read `view` and answer each
// question. `apiToken` is the CLOUDFLARE_API_TOKEN `anyhost connect` sent, which this run alone uses.
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
    (error: unknown) => void (view = { ...view, is: 'failed', error: error instanceof Error ? error.message : String(error) }),
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

// Uploads the relay this program carries over the one deployed when that one needsUpload, keeping its setup code
// secret and its bucket, with the cf login this machine has, so a machine never puts an older relay over the one a
// newer machine put up. It asks the person nothing: a machine without a usable login fails, which the program's
// `updateProblem` keeps for anyhost doctor, and the mod's Step shows Connect Cloudflare only for an `outdated` relay.
// Each call it runs goes to the program's log.
export async function updateRelay(names: RelayNames = RELAY, cloudflare: Cloudflare = CLOUDFLARE): Promise<void> {
  const login = await loginOf(cloudflare)
  const holding = await accountsHolding(cloudflare, login, names.worker)
  const [account, ...more] = holding
  if (account === undefined || more.length > 0) {
    throw new Error(`${holding.length} accounts of your Cloudflare login hold the Worker ${names.worker}${holding.length > 0 ? `: ${holding.map(({ name }) => name).join(', ')}` : ''}, so anyhost updates none. Connect Cloudflare deploys it.`)
  }
  const url = await relayUrlOf(cloudflare, login, account, names.worker)
  const health = await healthAt(cloudflare, url, login.say)
  if (!needsUpload(health)) return login.say(`${url} runs relay ${health.relay} at protocol ${health.protocol}, which needs no upload of this anyhost's, so anyhost uploads nothing.`)
  await deploy(cloudflare, login, account, { worker: names.worker, bucket: health.bucket }, false, undefined)
}

// Joins `device`, this machine, with an invite link, or with the setup code in the same form,
// `https://<relay>/v1/join#<code>`, alone or in the install command Add a machine gives: the relay exchanges the code for
// a device token, which saveRelayLogin keeps. Answers the relay's address.
export async function join(link: string, device: Device, cloudflare: Cloudflare = CLOUDFLARE): Promise<string> {
  const url = URL.parse(/https?:\/\/[^\s'"]+\/v1\/join#[\w-]+/.exec(link)?.[0] ?? link.trim())
  const code = url?.hash.slice(1) ?? ''
  if (url === null || url.pathname !== '/v1/join' || code === '') throw new Error(`${link} is no invite link, which reads https://<relay>/v1/join#<code>.`)
  await exchangeCode(url.origin, code, device, cloudflare, logLine)
  return url.origin
}

// Exchanges an invite's code or the setup code at the relay `origin` for the device token of `device`, which
// saveRelayLogin keeps. The program passes the machine it connects as, so a machine renamed since joins under the name
// its own socket uses, which the Pool would refuse as a clone's otherwise. A join whose answer was lost goes again, and
// the Pool joins the same machine again with a code it used: a join with no patience, as with an invite, through
// answerTo's tries. Within `patienceMs`, as right after a setup, the join sends one request every ASK_EVERY_MS, each
// ended by the patience's end, while its answer says the new relay is not there yet: Cloudflare's 404 page, as at a
// route just turned on, no answer, the relay's 503 `unavailable`, as while the Pool resets for a new version, and
// `invite_unknown`, as while Cloudflare still runs the Pool's old code. A join Cloudflare's page answered never reached
// the Worker, so no join counts twice.
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
    const limitMs = Math.min(REQUEST_MS, patienceMs - (cloudflare.now() - started))
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

// What a join's answer says: the device token, or that the new relay is not there yet, with whether it was
// `invite_unknown`. Every other answer throws its refusal.
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
