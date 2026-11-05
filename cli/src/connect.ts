// Connect Cloudflare and joining: deploys the relay into the person's own Cloudflare account with their own cf login,
// keeps it current, and joins machines to it. anyhost reads the access token cf keeps and never refreshes or writes
// cf's login: a refresh token works once, so two programs refreshing one login log the person out. anyhost creates no
// API token. relay-spec section 4 holds the calls and what each Cloudflare answer means.
import { mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join as joinPath } from 'node:path'
import { RELAY_VERSION, type Health, type JoinRequest, type Joined, type Refusal } from '../../relay/protocol.ts'
import relayModule from '../../relay/dist/relay.js' with { type: 'text' }
import { cmodDevice, rootsHere, stateFolder } from './device.ts'

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
// waits on. Tests pass stand-ins.
export type Cloudflare = {
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
  // runs cf with `args` and answers what it printed to stdout, handing every line it prints to `say` when given
  readonly cf: (args: readonly string[], env: CfEnvironment, say?: (line: string) => void) => Promise<string>
  readonly sleep: (ms: number) => Promise<void>
}

const API = 'https://api.cloudflare.com/client/v4'
const CF = 'cf@1.0.0-beta.26'
// the docs' own link to turn R2 on, which the dashboard opens in the person's account (r2/get-started)
const R2_PAGE = 'https://dash.cloudflare.com/?to=/:account/r2/overview'
// A fresh workers.dev address answered Cloudflare's HTML 404 page on and off for about 40 s after its first 200
// (relay-build), so the relay counts as up after 30 s of nothing but its own 200. A new workers.dev subdomain's DNS
// "may take a few minutes" (cf), so a relay that never steadies within 10 minutes is broken.
const STEADY_MS = 30_000
const HEALTH_LIMIT_MS = 10 * 60_000
const HEALTH_EVERY_MS = 1000
const REQUEST_MS = 60_000

const INVALID_TOKEN = 9109
const R2_NOT_ENTITLED = 10042
const NO_SUBDOMAIN = 10007
const NO_WORKER = 10007
const SUBDOMAIN_TAKEN = 10031
const SUBDOMAIN_FREE = 10032
const NO_BUCKET = 10006

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
// neither Node nor a cf of its own.
async function runCf(args: readonly string[], env: CfEnvironment, say?: (line: string) => void): Promise<string> {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries({ ...process.env, ...env, BUN_BE_BUN: '1', NO_COLOR: '1' })) if (value !== undefined) environment[name] = value
  const child = Bun.spawn([process.execPath, 'x', '--bun', CF, ...args], { env: environment, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [output, error, code] = await Promise.all([linesOf(child.stdout, say), linesOf(child.stderr, say), child.exited])
  if (code !== 0) throw new Error(`cf ${args.join(' ')} exited with ${code}: ${error.trim().split('\n').slice(-3).join(' ')}`)
  return output
}

const CLOUDFLARE: Cloudflare = { fetch: (url, init) => fetch(url, init), cf: runCf, sleep: Bun.sleep }

// A cf login anyhost reads: the environment cf runs in, its accounts, and the access token it keeps, read again
// before each call because only cf refreshes it.
type Login = { readonly env: CfEnvironment; readonly accounts: readonly Account[]; readonly token: () => Promise<string> }
type WhoAmI = { readonly authenticated: boolean; readonly authSource?: string; readonly accounts?: readonly Account[] }

async function whoami(cloudflare: Cloudflare, env: CfEnvironment): Promise<WhoAmI> {
  const output = await cloudflare.cf(['auth', 'whoami'], env)
  try {
    return JSON.parse(output) as WhoAmI
  } catch {
    throw new Error(`cf auth whoami printed no login: ${output.trim().slice(0, 200)}`)
  }
}

// The token a login holds in plain sight: in the JSON file cf names, or in CLOUDFLARE_API_TOKEN. A login cf keeps
// encrypted (`cf auth login --use-keyring`) names a file no other program reads.
function readableToken(who: WhoAmI): (() => Promise<string>) | undefined {
  const file = /^OAuth token from (.+\.json)$/.exec(who.authSource ?? '')?.[1]
  if (file !== undefined) return async () => ((await Bun.file(file).json()) as { oauth_token: string }).oauth_token
  const token = process.env['CLOUDFLARE_API_TOKEN']
  if (who.authSource === 'CLOUDFLARE_API_TOKEN environment variable' && token !== undefined) return async () => token
  return undefined
}

// The folder a keyring login logs cf in to for one setup, deleted when the setup ends.
const ownLoginFolder = (): string => joinPath(stateFolder(), 'connect')

// The person's cf login, logging cf in when nobody is. With no one watching (`progress` undefined), a login that needs
// the person fails instead, so the caller shows Connect Cloudflare.
async function loginOf(cloudflare: Cloudflare, progress?: Progress): Promise<Login> {
  progress?.say('Checking your Cloudflare login')
  let who = await whoami(cloudflare, {})
  if (!who.authenticated) {
    if (progress === undefined) throw new Error('cf is logged in to no Cloudflare account on this machine. Connect Cloudflare logs it in.')
    progress.say('Log in to Cloudflare: approve cf on the page that opens, or open the link below on any device.')
    await cloudflare.cf(['auth', 'login'], {}, progress.say)
    who = await whoami(cloudflare, {})
    if (!who.authenticated) throw new Error('cf is still logged in to no Cloudflare account. Approve cf on Cloudflare\'s page, then connect again.')
  }
  const token = readableToken(who)
  if (token !== undefined) return { env: {}, accounts: who.accounts ?? [], token }
  if (progress === undefined) throw new Error(`cf keeps its login encrypted (${who.authSource ?? 'no source'}), which anyhost cannot read with no one watching. Connect Cloudflare logs cf in for the update.`)
  // cf honours XDG_CONFIG_HOME, so this login lands in a folder of anyhost's own, in plain JSON, and the person's
  // encrypted login stays as it is
  const env: CfEnvironment = { XDG_CONFIG_HOME: ownLoginFolder(), CLOUDFLARE_AUTH_USE_KEYRING: undefined }
  progress.say('cf keeps your login encrypted, where anyhost cannot read it, so cf logs in once more for this setup alone. Approve it on the page that opens, or open the link below on any device.')
  await cloudflare.cf(['auth', 'login', '--no-use-keyring'], env, progress.say)
  const own = await whoami(cloudflare, env)
  const ownToken = readableToken(own)
  if (!own.authenticated || ownToken === undefined) throw new Error(`cf's login for this setup left no token anyhost can read: ${own.authSource ?? 'no login'}.`)
  return { env, accounts: own.accounts ?? [], token: ownToken }
}

type Envelope<T> = { readonly success: boolean; readonly errors: readonly { readonly code: number; readonly message: string }[]; readonly result: T }

const hasError = (envelope: Envelope<unknown>, code: number): boolean => envelope.errors.some((error) => error.code === code)

function refused(envelope: Envelope<unknown>, what: string): never {
  throw new Error(`${what} failed: ${envelope.errors.map(({ code, message }) => `${code} ${message}`).join('; ') || 'Cloudflare named no error'}.`)
}

const resultOf = <T>(envelope: Envelope<T>, what: string): T => (envelope.success ? envelope.result : refused(envelope, what))

// The Architect's Mac's link reset 2 of 4 calls to Cloudflare's API in a row on 2026-11-05 (ECONNRESET), so a request
// that gets no answer tries again after 1, 2, 4, 8 and 16 seconds, as relay.ts retries an object. fetch waits forever
// by itself, and the slowest call of the test deploys, the relay's upload, took 2.7 s, so a try ends after 60 s.
async function answerTo(cloudflare: Cloudflare, url: string, init: RequestInit): Promise<Response> {
  for (let wait = 1000; ; wait *= 2) {
    try {
      return await cloudflare.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_MS) })
    } catch (error) {
      if (wait > 16_000) throw new Error(`${init.method ?? 'GET'} ${url} got no answer in 6 tries of up to ${REQUEST_MS / 1000} s: ${error instanceof Error ? error.message : String(error)}`)
      await cloudflare.sleep(wait)
    }
  }
}

// One Cloudflare API call. Cloudflare refuses an expired access token with 403 and 9109 (a 401 for others), and then cf
// refreshes it: `cf auth whoami` wrote a new token when the old one had expired. The call reads the token again and
// tries once more.
async function call<T>(cloudflare: Cloudflare, login: Login, method: string, path: string, body?: { readonly json: object } | { readonly form: FormData }, headers: Record<string, string> = {}): Promise<Envelope<T>> {
  const send = async (): Promise<{ readonly status: number; readonly envelope: Envelope<T> | undefined }> => {
    const answer = await answerTo(cloudflare, `${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${await login.token()}`, ...(body !== undefined && 'json' in body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body === undefined ? {} : { body: 'json' in body ? JSON.stringify(body.json) : body.form }),
    })
    const envelope = (await answer.json().catch(() => undefined)) as Envelope<T> | undefined
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

// The bucket named `name` in the default or the EU jurisdiction, made when neither has it, or `off` when R2 is off.
async function findOrMakeBucket(cloudflare: Cloudflare, login: Login, account: Account, name: string, progress?: Progress): Promise<Bucket | 'off'> {
  for (const jurisdiction of ['default', 'eu']) {
    const found = await call(cloudflare, login, 'GET', `/accounts/${account.id}/r2/buckets/${name}`, undefined, { 'cf-r2-jurisdiction': jurisdiction })
    if (found.success) {
      progress?.say(`Found the bucket ${name} in the ${jurisdiction} jurisdiction`)
      return { name, jurisdiction }
    }
    if (hasError(found, R2_NOT_ENTITLED)) return 'off'
    if (!hasError(found, NO_BUCKET)) refused(found, `Looking for the bucket ${name}`)
  }
  progress?.say(`Making the bucket ${name}`)
  const made = await call(cloudflare, login, 'POST', `/accounts/${account.id}/r2/buckets`, { json: { name } })
  if (made.success) return { name, jurisdiction: 'default' }
  return hasError(made, R2_NOT_ENTITLED) ? 'off' : refused(made, `Making the bucket ${name}`)
}

// An account that never turned R2 on answers 10042, and no API turns it on, so the person does it on the dashboard and
// the bucket is tried again.
async function bucketOf(cloudflare: Cloudflare, login: Login, account: Account, name: string, progress?: Progress): Promise<Bucket> {
  for (;;) {
    const bucket = await findOrMakeBucket(cloudflare, login, account, name, progress)
    if (bucket !== 'off') return bucket
    if (progress === undefined) throw new Error(`R2 is off in the Cloudflare account ${account.name}. Connect Cloudflare turns it on.`)
    progress.say(`R2 is off in ${account.name}. Turn it on at ${R2_PAGE}, then go on.`)
    await progress.enableR2(R2_PAGE)
  }
}

// The account's workers.dev subdomain, registered the way cf registers one when the account has none: its name in
// lowercase letters, digits and `-`, else `anyhost-` and 6 hex digits when that is taken.
async function subdomainOf(cloudflare: Cloudflare, login: Login, account: Account, progress?: Progress): Promise<string> {
  const current = await call<{ subdomain: string }>(cloudflare, login, 'GET', `/accounts/${account.id}/workers/subdomain`)
  if (current.success) return current.result.subdomain
  if (!hasError(current, NO_SUBDOMAIN)) refused(current, 'Reading the workers.dev subdomain')
  const named = account.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 63).replace(/-+$/, '')
  const checked = named === '' ? undefined : await call(cloudflare, login, 'GET', `/accounts/${account.id}/workers/subdomains/${named}`)
  if (checked !== undefined && !checked.success && !hasError(checked, SUBDOMAIN_TAKEN) && !hasError(checked, SUBDOMAIN_FREE)) refused(checked, `Checking the workers.dev subdomain ${named}`)
  const subdomain = checked === undefined || hasError(checked, SUBDOMAIN_TAKEN) ? `anyhost-${Buffer.from(crypto.getRandomValues(new Uint8Array(3))).toString('hex')}` : named
  progress?.say(`Registering the workers.dev subdomain ${subdomain}`)
  return resultOf(await call<{ subdomain: string }>(cloudflare, login, 'PUT', `/accounts/${account.id}/workers/subdomain`, { json: { subdomain } }), `Registering the workers.dev subdomain ${subdomain}`).subdomain
}

async function workerExists(cloudflare: Cloudflare, login: Login, account: Account, worker: string): Promise<boolean> {
  const settings = await call(cloudflare, login, 'GET', `/accounts/${account.id}/workers/scripts/${worker}/settings`)
  if (!settings.success && !hasError(settings, NO_WORKER)) refused(settings, `Looking for the Worker ${worker}`)
  return settings.success
}

const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex')

// Uploads the relay this program carries and turns on its workers.dev route, then waits for it to answer steadily.
// A first upload makes the Pool's SQLite class. With no `setupCode`, the upload keeps the setup code secret the last
// one set (R15). Answers the relay's address.
async function deploy(cloudflare: Cloudflare, login: Login, account: Account, names: RelayNames, isFirst: boolean, setupCode: string | undefined, progress?: Progress): Promise<string> {
  const bucket = await bucketOf(cloudflare, login, account, names.bucket, progress)
  const subdomain = await subdomainOf(cloudflare, login, account, progress)
  const metadata = {
    main_module: 'relay.js',
    compatibility_date: '2026-11-01',
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
  progress?.say(`Uploading the relay as the Worker ${names.worker}`)
  resultOf(await call(cloudflare, login, 'PUT', `/accounts/${account.id}/workers/scripts/${names.worker}`, { form }), `Uploading the Worker ${names.worker}`)
  const url = `https://${names.worker}.${subdomain}.workers.dev`
  progress?.say(`Turning on ${url}`)
  resultOf(await call(cloudflare, login, 'POST', `/accounts/${account.id}/workers/scripts/${names.worker}/subdomain`, { json: { enabled: true, previews_enabled: false } }), `Turning on ${url}`)
  progress?.say(`Waiting until ${url} answers for 30 seconds straight`)
  await waitForHealth(cloudflare, url, bucket.name)
  return url
}

// Waits until the relay this program carries answers /v1/health for its bucket for STEADY_MS without a break.
async function waitForHealth(cloudflare: Cloudflare, url: string, bucket: string): Promise<void> {
  const started = Date.now()
  let steadySince = started
  let last = 'no answer'
  while (Date.now() - steadySince < STEADY_MS) {
    if (Date.now() - started > HEALTH_LIMIT_MS) throw new Error(`${url}/v1/health answered steadily for less than ${STEADY_MS / 1000} s within ${HEALTH_LIMIT_MS / 60_000} minutes of the upload. Its last answer: ${last}.`)
    const answer = await cloudflare.fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(REQUEST_MS) }).catch((error: unknown) => String(error))
    const health = typeof answer === 'string' || answer.status !== 200 ? undefined : ((await answer.json().catch(() => undefined)) as Health | undefined)
    if (health?.relay !== RELAY_VERSION || health.bucket !== bucket) {
      last = typeof answer === 'string' ? answer : `${answer.status} ${JSON.stringify(health ?? null)}`
      steadySince = Date.now()
    }
    await cloudflare.sleep(HEALTH_EVERY_MS)
  }
}

// Sets the relay up in the person's Cloudflare account and joins this machine to it. On an account whose relay exists,
// it uploads a new setup code and joins with it, since the Pool takes each setup code once, so any machine with the
// person's Cloudflare login joins without an invite.
export async function connectCloudflare(progress: Progress, names: RelayNames = RELAY, cloudflare: Cloudflare = CLOUDFLARE): Promise<void> {
  try {
    const login = await loginOf(cloudflare, progress)
    const [only, ...more] = login.accounts
    if (only === undefined) throw new Error('Your Cloudflare login reaches no account.')
    const account = more.length === 0 ? only : await progress.pickAccount(login.accounts)
    const isFirst = !(await workerExists(cloudflare, login, account, names.worker))
    const setupCode = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    const url = await deploy(cloudflare, login, account, names, isFirst, setupCode, progress)
    await join(`${url}/v1/join#${setupCode}`, cloudflare)
    progress.say(`Joined this machine to ${url}`)
  } finally {
    rmSync(ownLoginFolder(), { recursive: true, force: true })
  }
}

// Uploads the relay this program carries over the one deployed, keeping its setup code secret, with the cf login this
// machine has. It asks the person nothing: a machine without a usable login fails, and the caller shows Connect Cloudflare.
export async function updateRelay(names: RelayNames = RELAY, cloudflare: Cloudflare = CLOUDFLARE): Promise<void> {
  const login = await loginOf(cloudflare)
  const holding = []
  for (const account of login.accounts) if (await workerExists(cloudflare, login, account, names.worker)) holding.push(account)
  const [account, ...more] = holding
  if (account === undefined || more.length > 0) {
    throw new Error(`${holding.length} accounts of your Cloudflare login hold the Worker ${names.worker}${holding.length > 0 ? `: ${holding.map(({ name }) => name).join(', ')}` : ''}, so anyhost updates none. Connect Cloudflare deploys it.`)
  }
  await deploy(cloudflare, login, account, names, false, undefined)
}

const cmodProgram = (): string => joinPath(process.env['XDG_DATA_HOME'] || joinPath(homedir(), '.local', 'share'), 'cmod', 'programs', 'cmod')

// `cmod secret store` reads the value from stdin, so the token never shows in a process's arguments.
async function storeToken(token: string): Promise<void> {
  const program = (await Bun.file(cmodProgram()).exists()) ? cmodProgram() : Bun.which('cmod')
  if (program === null) throw new Error(`anyhost keeps its token with cmod secret, and neither ${cmodProgram()} nor a cmod on PATH exists. Install cmod with npm install -g @cmodjs/cli.`)
  const child = Bun.spawn([program, 'secret', 'store', 'anyhost', 'token'], { stdin: new Blob([token]), stdout: 'ignore', stderr: 'pipe' })
  const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`cmod secret store anyhost token exited with ${code}: ${error.trim()}`)
}

// Joins this machine with an invite link, or with the setup code in the same form, `https://<relay>/v1/join#<code>`:
// the relay exchanges the code for a device token, which goes to `cmod secret` as `anyhost token`, and the relay's
// address to `relay.json` in the state folder.
export async function join(link: string, cloudflare: Cloudflare = CLOUDFLARE): Promise<void> {
  const url = URL.parse(link)
  const code = url?.hash.slice(1) ?? ''
  if (url === null || url.pathname !== '/v1/join' || code === '') throw new Error(`${link} is no invite link, which reads https://<relay>/v1/join#<code>.`)
  const device = await cmodDevice()
  const request: JoinRequest = { invite: code, device: { ...device, roots: rootsHere() } }
  const answer = await answerTo(cloudflare, `${url.origin}/v1/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
  const text = await answer.text()
  let body: Partial<Joined & Refusal>
  try {
    body = JSON.parse(text) as Partial<Joined & Refusal>
  } catch {
    throw new Error(`${url.origin} answered the join with ${answer.status} and no relay answer: ${text.slice(0, 200)}`)
  }
  if (!answer.ok || body.token === undefined) throw new Error(`${url.origin} refused to join ${device.name}: ${body.message ?? `${answer.status} ${text.slice(0, 200)}`}`)
  await storeToken(body.token)
  mkdirSync(stateFolder(), { recursive: true })
  await Bun.write(joinPath(stateFolder(), 'relay.json'), `${JSON.stringify({ url: url.origin })}\n`)
}
