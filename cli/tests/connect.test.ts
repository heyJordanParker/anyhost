import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { COMPATIBILITY_DATE, PROTOCOL_VERSION, RELAY_VERSION } from '../../relay/protocol.ts'
import { decompress } from '../src/capture.ts'
import { connectCloudflare, connectForStep, join as joinRelay, runCf, updateRelay, type Account, type Cloudflare, type Progress } from '../src/connect.ts'
import { forgetRelayLogin, personOptions, relayLogin, saveRelayLogin } from '../src/device.ts'
import { connectRelay, type Relay } from '../src/relay.ts'
import type { Status } from '../src/serve.ts'
import { memoryRelay, stopRelays, temporaryFolder, until, welcomed, type MemoryRelay } from './memory.ts'

const NAMES = { worker: 'anyhost-test-connect', bucket: 'anyhost-test' }
const ACCOUNT: Account = { id: '0534ffa9', name: 'Parker Labs' }
const API = 'https://api.cloudflare.com/client/v4'
const R2_PAGE = 'https://dash.cloudflare.com/?to=/:account/r2/overview'
const DEVICE = { id: 'c0ffee', name: 'macbook', os: 'darwin', arch: 'arm64' }
const kept: Record<string, string | undefined> = {}
let home = ''

type CfEnvironment = Parameters<Cloudflare['cf']>[1]

// cmod as the program runs it, from the cmod store's programs folder: `device` prints this machine, `secret store`
// keeps the value it reads from stdin beside itself, `secret get` prints it and `secret delete` removes it, and
// `options` prints the person's options as the `settings.json` beside it holds them. Each `secret get` and `options`
// adds a line to `calls`. A child gets the environment the test process started with, not the one a test sets.
beforeAll(() => {
  home = temporaryFolder()
  const cmod = join(home, 'data', 'cmod', 'programs', 'cmod')
  mkdirSync(dirname(cmod), { recursive: true })
  writeFileSync(
    cmod,
    `#!/bin/sh\ncase "$1 $2" in\n  device*) printf '%s' '${JSON.stringify(DEVICE)}' ;;\n  "secret get") echo "secret get" >> "$(dirname "$0")/calls"; cat "$(dirname "$0")/secret-$3-$4" ;;\n  "secret delete") rm -f "$(dirname "$0")/secret-$3-$4" ;;\n  secret*) cat > "$(dirname "$0")/secret-$3-$4" ;;\n  options*) echo options >> "$(dirname "$0")/calls"; printf '{"person":%s}' "$(cat "$(dirname "$0")/settings.json")" ;;\n  *) exit 2 ;;\nesac\n`,
  )
  chmodSync(cmod, 0o755)
  for (const [name, value] of Object.entries({ XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: undefined, CLAUDE_CONFIG_DIR: undefined, CLOUDFLARE_API_TOKEN: undefined })) {
    kept[name] = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

afterAll(() => {
  for (const [name, value] of Object.entries(kept)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const secretFile = (): string => join(home, 'data', 'cmod', 'programs', 'secret-anyhost-token')

// every `cmod secret get` and `cmod options` the program ran, in order
const cmodCalls = (): string[] => (existsSync(join(home, 'data', 'cmod', 'programs', 'calls')) ? readFileSync(join(home, 'data', 'cmod', 'programs', 'calls'), 'utf8').split('\n').filter(Boolean) : [])

// each test starts with an empty state folder and Claude Code folder, no token and no cmod call
beforeEach(() => {
  process.env['XDG_STATE_HOME'] = temporaryFolder()
  process.env['CLAUDE_CONFIG_DIR'] = temporaryFolder()
  rmSync(secretFile(), { force: true })
  rmSync(join(home, 'data', 'cmod', 'programs', 'calls'), { force: true })
})

const stateFile = (name: string): string => join(process.env['XDG_STATE_HOME'] ?? '', 'anyhost', name)
const storedToken = (): string => readFileSync(secretFile(), 'utf8')
const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex')

// Cloudflare's own page at a workers.dev address with no route on, with the status, type and start a live run read
// from a Worker whose route was off
const CLOUDFLARE_404 = '<!DOCTYPE html><html><body>404</body></html>'
const cloudflare404 = (): Response => new Response(CLOUDFLARE_404, { status: 404, headers: { 'content-type': 'text/html; charset=UTF-8' } })

// `relay` and `protocol` are the versions the Worker's module answers in /v1/health and its welcome
type Worker = { metadata: Record<string, unknown>; module: string; secret: string | undefined; route: boolean; relay: number; protocol: number }
type Envelope = { success: boolean; errors: { code: number; message: string }[]; result: unknown }

// Cloudflare as anyhost meets it: the API of the login's accounts, of which ACCOUNT holds the buckets and Workers, the
// relay each upload runs at its workers.dev address, and cf, whose login is a JSON file of its access token, under
// `keyring` a file no other program reads, and under `apiToken` the API token `fresh` cf runs with in
// CLOUDFLARE_API_TOKEN. `relay` and `protocol` are the versions of a relay deployed before, `health` what its /v1/health
// answers in place of the relay, `notFound` the requests to the Worker Cloudflare's own 404 page answers first, as at a
// new address or a route just turned on, `unavailable` the joins after those the relay answers with its 503
// `unavailable`, as while the Pool resets for a new version, `secretLag` the joins a new setup code answers
// `invite_unknown` after an upload over the Worker, while the busy Pool keeps its old code, `upload` what an upload of
// the Worker waits for before Cloudflare answers it, `resets` the API calls the link resets, and `timeouts` the API calls
// that get no answer until their time limit ends them. A new secret alone reaches the join at once, as the Worker checks
// the setup code itself.
function standIn(account: { r2: boolean; subdomain?: string; taken?: string[]; buckets?: Record<string, string>; keyring?: boolean; apiToken?: boolean; loggedIn?: boolean; expired?: 403 | 401; notFound?: number; unavailable?: number; resets?: number; timeouts?: number; others?: Account[]; relay?: number; protocol?: number; health?: { status: number; body: string }; secretLag?: number; upload?: Promise<void>; loseBucketMake?: boolean } = { r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' } }) {
  const loginFile = join(temporaryFolder(), 'default.json')
  writeFileSync(loginFile, JSON.stringify({ oauth_token: account.expired === undefined ? 'fresh' : 'expired' }))
  let isLoggedIn = account.loggedIn ?? true
  let isExpired = account.expired !== undefined
  let whoamis = 0
  let r2 = account.r2
  let subdomain = account.subdomain
  let notFound = account.notFound ?? 0
  let unavailable = account.unavailable ?? 0
  let resets = account.resets ?? 0
  let timeouts = account.timeouts ?? 0
  // the clock the setup waits on, which moves only as it waits
  let at = Date.parse('2026-11-07T09:00:00.000Z')
  // the joins left before the setup code secret set last reaches the Pool
  let lagging = 0
  const buckets = new Map(Object.entries(account.buckets ?? {}))
  const workers = new Map<string, Worker>()
  if (account.relay !== undefined) {
    const metadata = { bindings: [{ type: 'plain_text', name: 'BUCKET_NAME', text: 'anyhost-test' }] }
    workers.set(NAMES.worker, { metadata, module: 'class Pool {}', secret: sha256('an earlier setup code'), route: true, relay: account.relay, protocol: account.protocol ?? PROTOCOL_VERSION })
  }
  // the machine each used setup code joined, which the Pool joins again with it, as after a lost answer
  const joined = new Map<string, string>()
  const calls: string[] = []
  const cfRuns: { args: readonly string[]; env: CfEnvironment }[] = []
  const said: string[] = []
  const valid = new Set(['fresh', 'own'])

  const envelope = (status: number, result: unknown, error?: [number, string]): Response =>
    Response.json({ success: error === undefined, errors: error === undefined ? [] : [{ code: error[0], message: error[1] }], result } satisfies Envelope, { status })

  async function api(method: string, path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers)
    if (!valid.has(headers.get('authorization')?.replace('Bearer ', '') ?? '')) {
      return account.expired === 401 ? new Response('{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}', { status: 401 }) : envelope(403, null, [9109, 'Invalid access token'])
    }
    // the login's other accounts hold no Worker
    if (account.others?.some(({ id }) => new RegExp(`^/accounts/${id}/workers/scripts/[^/]+/settings$`).test(path)) === true) return envelope(404, null, [10007, 'This Worker does not exist on your account.'])
    const prefix = `/accounts/${ACCOUNT.id}`
    const bucket = new RegExp(`^${prefix}/r2/buckets/([^/]+)$`).exec(path)?.[1]
    if (method === 'GET' && bucket !== undefined) {
      if (!r2) return envelope(403, null, [10042, 'Account not entitled to this feature.'])
      const jurisdiction = headers.get('cf-r2-jurisdiction') ?? 'default'
      return buckets.get(bucket) === jurisdiction ? envelope(200, { name: bucket, jurisdiction }) : envelope(404, null, [10006, 'The specified bucket does not exist.'])
    }
    if (method === 'POST' && path === `${prefix}/r2/buckets`) {
      if (!r2) return envelope(403, null, [10042, 'Account not entitled to this feature.'])
      const { name } = JSON.parse(String(init.body)) as { name: string }
      if (buckets.has(name)) return envelope(409, null, [10073, 'Bucket name already exists.'])
      buckets.set(name, 'default')
      if (account.loseBucketMake === true) throw new Error('ECONNRESET: The socket connection was closed unexpectedly.')
      return envelope(200, { name })
    }
    if (method === 'GET' && path === `${prefix}/workers/subdomain`) return subdomain === undefined ? envelope(404, null, [10007, 'This account has no workers.dev subdomain.']) : envelope(200, { subdomain })
    const checked = new RegExp(`^${prefix}/workers/subdomains/([^/]+)$`).exec(path)?.[1]
    if (method === 'GET' && checked !== undefined) return account.taken?.includes(checked) === true ? envelope(409, null, [10031, 'Subdomain unavailable.']) : envelope(404, null, [10032, 'Subdomain available.'])
    if (method === 'PUT' && path === `${prefix}/workers/subdomain`) {
      subdomain = (JSON.parse(String(init.body)) as { subdomain: string }).subdomain
      return envelope(200, { subdomain })
    }
    const [, worker, rest] = new RegExp(`^${prefix}/workers/scripts/([^/]+)(/.*)?$`).exec(path) ?? []
    if (worker !== undefined && method === 'GET' && rest === '/settings') return workers.has(worker) ? envelope(200, {}) : envelope(404, null, [10007, 'This Worker does not exist on your account.'])
    if (worker !== undefined && method === 'PUT' && rest === undefined) {
      const form = init.body as FormData
      const metadata = JSON.parse(await (form.get('metadata') as Blob).text()) as { bindings: { type: string; text?: string }[]; keep_bindings?: string[] }
      const secret = metadata.bindings.find(({ type }) => type === 'secret_text')?.text ?? (metadata.keep_bindings?.includes('secret_text') === true ? workers.get(worker)?.secret : undefined)
      await account.upload
      // a busy Pool keeps its old code after an upload over the Worker
      if (workers.has(worker)) lagging = account.secretLag ?? 0
      workers.set(worker, { metadata, module: await (form.get('relay.js') as Blob).text(), secret, route: workers.get(worker)?.route ?? false, relay: RELAY_VERSION, protocol: PROTOCOL_VERSION })
      return envelope(200, {})
    }
    if (worker !== undefined && method === 'PUT' && rest === '/secrets') {
      const uploaded = workers.get(worker)
      if (uploaded === undefined) return envelope(404, null, [10007, 'This Worker does not exist on your account.'])
      const { name, text, type } = JSON.parse(String(init.body)) as { name: string; text: string; type: string }
      if (name !== 'SETUP_CODE_SHA256' || type !== 'secret_text') return envelope(400, null, [10021, `The stand-in keeps no secret ${name} of type ${type}.`])
      uploaded.secret = text
      return envelope(200, { name, type })
    }
    if (worker !== undefined && method === 'POST' && rest === '/subdomain') {
      const uploaded = workers.get(worker)
      if (uploaded === undefined) return envelope(404, null, [10007, 'This Worker does not exist on your account.'])
      uploaded.route = true
      return envelope(200, {})
    }
    return envelope(404, null, [7003, `No route for ${method} ${path}.`])
  }

  // the relay as its Pool answers: its health for its bucket, and a join with the setup code its secret names, which
  // joins one machine, again too
  async function relay(worker: Worker, method: string, path: string, init: RequestInit): Promise<Response> {
    const bucketName = (worker.metadata['bindings'] as { name: string; text?: string }[]).find(({ name }) => name === 'BUCKET_NAME')?.text ?? ''
    const health = { relay: worker.relay, protocol: worker.protocol, bucket: bucketName }
    if (method === 'GET' && path === '/v1/health') return Response.json(health)
    if (method === 'POST' && path === '/v1/join') {
      if (unavailable > 0) {
        unavailable -= 1
        return Response.json({ error: 'unavailable', message: 'The relay failed: Error: Durable Object reset because its code was updated.' }, { status: 503 })
      }
      const { invite, device } = JSON.parse(String(init.body)) as { invite: string; device: { id: string; name: string } }
      const code = sha256(invite)
      const isLive = lagging === 0
      lagging = Math.max(0, lagging - 1)
      if (!isLive || code !== worker.secret) return Response.json({ error: 'invite_unknown', message: 'The relay made no invite with that code. Make a new one with Add a machine.' }, { status: 403 })
      const usedBy = joined.get(code)
      if (usedBy !== undefined && usedBy !== device.id) return Response.json({ error: 'invite_used', message: `The invite already joined ${usedBy}. Make a new one with Add a machine.` }, { status: 403 })
      joined.set(code, device.id)
      return Response.json({ ...health, token: `token-of-${device.name}`, device: { id: device.id, name: device.name } })
    }
    return Response.json({ error: 'missing', message: `The relay has no route ${method} ${path}.` }, { status: 404 })
  }

  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? 'GET'
    const { host, pathname } = new URL(url)
    if (url.startsWith(API)) {
      if (resets > 0) {
        resets -= 1
        throw new Error('ECONNRESET: The socket connection was closed unexpectedly.')
      }
      // what fetch rejects with once the AbortSignal.timeout of its call ends it
      if (timeouts > 0) {
        timeouts -= 1
        throw new DOMException('The operation timed out.', 'TimeoutError')
      }
      calls.push(`${method} ${url.slice(API.length)}${new Headers(init.headers).has('cf-r2-jurisdiction') ? ` (${new Headers(init.headers).get('cf-r2-jurisdiction')})` : ''}`)
      return await api(method, url.slice(API.length), init)
    }
    calls.push(`${method} ${url}`)
    const [name, at] = host.split('.')
    const worker = workers.get(name ?? '')
    if (worker === undefined || !worker.route || at !== subdomain) return cloudflare404()
    if (notFound > 0) {
      notFound -= 1
      return cloudflare404()
    }
    if (pathname === '/v1/health' && account.health !== undefined) return new Response(account.health.body, { status: account.health.status })
    return await relay(worker, method, pathname, init)
  }

  const whoami = (env: CfEnvironment): string => {
    const folder = env['XDG_CONFIG_HOME']
    if (folder !== undefined) {
      const own = join(folder, 'cloudflare', 'config', 'default.json')
      return JSON.stringify(existsSync(own) ? { authenticated: true, authSource: `OAuth token from ${own}`, accounts: [ACCOUNT] } : { authenticated: false, error: 'Not logged in' })
    }
    if (!isLoggedIn) return JSON.stringify({ authenticated: false, error: 'Not logged in' })
    // the token expires after the setup's first whoami, and cf refreshes it when it next runs, writing the new one
    whoamis += 1
    if (isExpired && whoamis > 1) {
      writeFileSync(loginFile, JSON.stringify({ oauth_token: 'fresh' }))
      isExpired = false
    }
    // cf logged in with an API token names its source as cf's own `authSource` does, and reads the token from the
    // environment it runs in, which runCf makes of anyhost's own and what it adds
    if (account.apiToken === true && (env['CLOUDFLARE_API_TOKEN'] ?? process.env['CLOUDFLARE_API_TOKEN']) === undefined) return JSON.stringify({ authenticated: false, error: 'Not logged in' })
    const source = account.apiToken === true ? 'CLOUDFLARE_API_TOKEN environment variable' : `OAuth token from ${account.keyring === true ? loginFile.replace('.json', '.enc') : loginFile}`
    return JSON.stringify({ authenticated: true, authSource: source, accounts: [...(account.others ?? []), ACCOUNT] })
  }

  const cloudflare: Cloudflare = {
    fetch,
    cf: async (args, env, say) => {
      cfRuns.push({ args, env })
      if (args.join(' ') === 'auth whoami') return whoami(env)
      if (args[0] === 'auth' && args[1] === 'login') {
        say?.('To authorize cf, please visit: https://dash.cloudflare.com/oauth2/device/verify and enter the code: MQxTn4fA.')
        const folder = env['XDG_CONFIG_HOME']
        if (folder === undefined) isLoggedIn = true
        else {
          mkdirSync(join(folder, 'cloudflare', 'config'), { recursive: true })
          writeFileSync(join(folder, 'cloudflare', 'config', 'default.json'), JSON.stringify({ oauth_token: 'own' }))
        }
        return ''
      }
      throw new Error(`The stand-in runs no cf ${args.join(' ')}.`)
    },
    // the clock moves as the setup waits, so a 30-second wait takes no time
    now: () => at,
    sleep: async (ms) => {
      at += ms
    },
  }
  const enabled: string[] = []
  const progress: Progress = {
    say: (line) => said.push(line),
    pickAccount: async () => {
      throw new Error('Connect Cloudflare asked the person for an account.')
    },
    enableR2: async (page) => {
      enabled.push(page)
      r2 = true
    },
  }
  return { cloudflare, progress, calls, cfRuns, said, enabled, workers, buckets, loginFile, turnOnR2: () => void (r2 = true), get subdomain() {
    return subdomain
  } }
}

test('deploys the relay from nothing into the bucket it finds in the EU and joins this machine, reading no health', async () => {
  const cloudflare = standIn()
  await connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)
  const relayUrl = 'https://anyhost-test-connect.parker-labs.workers.dev'
  expect(cloudflare.calls).toEqual([
    `GET /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/settings`,
    `GET /accounts/${ACCOUNT.id}/workers/subdomain`,
    `GET /accounts/${ACCOUNT.id}/r2/buckets/anyhost-test (default)`,
    `GET /accounts/${ACCOUNT.id}/r2/buckets/anyhost-test (eu)`,
    `PUT /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect`,
    `POST /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/subdomain`,
    `POST ${relayUrl}/v1/join`,
  ])
  const worker = cloudflare.workers.get('anyhost-test-connect')
  expect(worker?.metadata).toEqual({
    main_module: 'relay.js',
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [
      { type: 'r2_bucket', name: 'BUCKET', bucket_name: 'anyhost-test', jurisdiction: 'eu' },
      { type: 'durable_object_namespace', name: 'POOL', class_name: 'Pool' },
      { type: 'plain_text', name: 'BUCKET_NAME', text: 'anyhost-test' },
      { type: 'secret_text', name: 'SETUP_CODE_SHA256', text: worker?.secret ?? '' },
    ],
    migrations: { new_tag: 'v1', new_sqlite_classes: ['Pool'] },
  })
  expect(worker?.module).toContain('class Pool')
  expect(storedToken()).toBe('token-of-macbook')
  expect(JSON.parse(readFileSync(stateFile('relay.json'), 'utf8'))).toEqual({ url: relayUrl })
  expect(cloudflare.said.at(-1)).toBe(`Joined this machine to ${relayUrl}`)
  expect(existsSync(stateFile('connect'))).toBe(false)
})

// The suite missed it: a first Connect read the health 30 times, a fixed 30 s of its 48.1 s live, as the health shows
// nothing of the Pool, whose Worker answers it.
test('a first Connect makes no health read and joins once the new address stops answering Cloudflare\'s 404 page, a second after the last', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, notFound: 3 })
  const started = cloudflare.cloudflare.now()
  await connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)
  const relayUrl = 'https://anyhost-test-connect.parker-labs.workers.dev'
  expect(cloudflare.calls.filter((call) => call.startsWith('GET https://'))).toEqual([])
  expect(cloudflare.calls.filter((call) => call === `POST ${relayUrl}/v1/join`)).toHaveLength(4)
  expect(cloudflare.cloudflare.now() - started).toBe(3000)
  expect(storedToken()).toBe('token-of-macbook')
})

// The suite missed it: a join that met the Worker's 503 while the Pool resets for a new version failed the setup.
test('a join the relay answers with its 503 unavailable asks again a second later, and joins', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, relay: RELAY_VERSION - 1, unavailable: 2 })
  await connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)
  const relayUrl = 'https://anyhost-test-connect.parker-labs.workers.dev'
  expect(cloudflare.calls.filter((call) => call === `POST ${relayUrl}/v1/join`)).toHaveLength(3)
  expect(storedToken()).toBe('token-of-macbook')
})

// The suite missed it: a join whose answer the link lost failed the setup once its tries ran out, though the Pool joins
// the same machine again with the code it used.
test('a join that gets no answer through all its tries asks again within its patience, and joins', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, relay: RELAY_VERSION })
  let lost = 6
  const losing: Cloudflare = {
    ...cloudflare.cloudflare,
    fetch: async (url, init) => {
      if (url.endsWith('/v1/join') && lost > 0) {
        lost -= 1
        throw new Error('ECONNRESET: The socket connection was closed unexpectedly.')
      }
      return await cloudflare.cloudflare.fetch(url, init)
    },
  }
  await connectCloudflare(cloudflare.progress, DEVICE, NAMES, losing)
  expect(lost).toBe(0)
  expect(storedToken()).toBe('token-of-macbook')
})

// The suite missed it: a second machine's Connect Cloudflare set a newer setup code, and the first one's join blamed
// Cloudflare's rollout after 10 minutes.
test('a join whose setup code another Connect Cloudflare replaced fails after 10 minutes, naming that Connect and to press it again', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, relay: RELAY_VERSION })
  // the other machine sets its setup code right after this one's
  const replacing: Cloudflare = {
    ...cloudflare.cloudflare,
    fetch: async (url, init) => {
      const answer = await cloudflare.cloudflare.fetch(url, init)
      const worker = cloudflare.workers.get(NAMES.worker)
      if (url.endsWith('/secrets') && worker !== undefined) worker.secret = sha256("the other machine's setup code")
      return answer
    },
  }
  const relayUrl = 'https://anyhost-test-connect.parker-labs.workers.dev'
  await expect(connectCloudflare(cloudflare.progress, DEVICE, NAMES, replacing)).rejects.toThrow(
    `${relayUrl} still refused the setup code 10 minutes after anyhost set it: The relay made no invite with that code. Make a new one with Add a machine. Another Connect Cloudflare, as on another machine, may have set a newer setup code since. Press Connect Cloudflare again, or run anyhost connect.`,
  )
  expect(existsSync(stateFile('relay.json'))).toBe(false)
})

test('a call the link reset tries again after 1, 2, 4, 8 and 16 seconds, and fails naming the call after the sixth', async () => {
  const recovers = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, resets: 5 })
  await connectCloudflare(recovers.progress, DEVICE, NAMES, recovers.cloudflare)
  // a reset fails at once, which the Step says, never a wait of 60 s
  expect(recovers.said[1]).toBe(`GET ${API}/accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/settings failed with no answer (ECONNRESET: The socket connection was closed unexpectedly.), so anyhost asks again in 1 s, try 2 of 6.`)
  expect(storedToken()).toBe('token-of-macbook')
  const fails = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, resets: 6 })
  await expect(connectCloudflare(fails.progress, DEVICE, NAMES, fails.cloudflare)).rejects.toThrow(
    `GET ${API}/accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/settings got no answer in 6 tries of up to 60 s: ECONNRESET: The socket connection was closed unexpectedly.`,
  )
})

test('a call that gets no answer within its time limit says on the Step what it waits for and how long, before each try again', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, timeouts: 2 })
  await connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)
  const settings = `GET ${API}/accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/settings`
  expect(cloudflare.said.slice(1, 3)).toEqual([
    `${settings} got no answer within 60 s (The operation timed out.), so anyhost asks again in 1 s, try 2 of 6.`,
    `${settings} got no answer within 60 s (The operation timed out.), so anyhost asks again in 2 s, try 3 of 6.`,
  ])
  expect(storedToken()).toBe('token-of-macbook')
})

test('makes the bucket when no jurisdiction has it, and binds it with no jurisdiction', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs' })
  await connectCloudflare(cloudflare.progress, DEVICE, { worker: 'anyhost-test-connect', bucket: 'anyhost-test-connect' }, cloudflare.cloudflare)
  expect(cloudflare.calls).toContain(`POST /accounts/${ACCOUNT.id}/r2/buckets`)
  expect(cloudflare.buckets.get('anyhost-test-connect')).toBe('default')
  expect((cloudflare.workers.get('anyhost-test-connect')?.metadata['bindings'] as unknown[])[0]).toEqual({ type: 'r2_bucket', name: 'BUCKET', bucket_name: 'anyhost-test-connect' })
})

test('a bucket make whose answer was lost, sent again and answered "already exists" (10073), counts as the bucket made', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', loseBucketMake: true })
  await connectCloudflare(cloudflare.progress, DEVICE, { worker: 'anyhost-test-connect', bucket: 'anyhost-test-connect' }, cloudflare.cloudflare)
  expect(cloudflare.calls.filter((call) => call === `POST /accounts/${ACCOUNT.id}/r2/buckets`)).toHaveLength(2)
  expect((cloudflare.workers.get('anyhost-test-connect')?.metadata['bindings'] as unknown[])[0]).toEqual({ type: 'r2_bucket', name: 'BUCKET', bucket_name: 'anyhost-test-connect' })
  expect(storedToken()).toBe('token-of-macbook')
})

test('an account with R2 off (10042) sends the person to turn it on, then tries the bucket again', async () => {
  const cloudflare = standIn({ r2: false, subdomain: 'parker-labs' })
  await connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)
  expect(cloudflare.enabled).toEqual([R2_PAGE])
  expect(cloudflare.said).toContain(`R2 is off in Parker Labs. Turn it on at ${R2_PAGE}, then go on.`)
  expect(cloudflare.buckets.get('anyhost-test')).toBe('default')
  expect(storedToken()).toBe('token-of-macbook')
})

test('an account with no workers.dev subdomain (10007) registers its own name in lowercase letters, digits and -', async () => {
  const cloudflare = standIn({ r2: true, buckets: { 'anyhost-test': 'eu' } })
  await connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)
  expect(cloudflare.calls).toContain(`GET /accounts/${ACCOUNT.id}/workers/subdomains/parker-labs`)
  expect(cloudflare.calls).toContain(`PUT /accounts/${ACCOUNT.id}/workers/subdomain`)
  expect(cloudflare.subdomain).toBe('parker-labs')
  expect(JSON.parse(readFileSync(stateFile('relay.json'), 'utf8'))).toEqual({ url: 'https://anyhost-test-connect.parker-labs.workers.dev' })
})

test('a workers.dev subdomain name another account took (10031) registers anyhost- and 6 hex digits instead', async () => {
  const cloudflare = standIn({ r2: true, buckets: { 'anyhost-test': 'eu' }, taken: ['parker-labs'] })
  await connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)
  expect(cloudflare.subdomain).toMatch(/^anyhost-[0-9a-f]{6}$/)
  expect(JSON.parse(readFileSync(stateFile('relay.json'), 'utf8'))).toEqual({ url: `https://anyhost-test-connect.${cloudflare.subdomain}.workers.dev` })
})

test.each([403, 401] as const)('an expired access token (%d) runs cf, which refreshes it, reads it again and tries once more', async (status) => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, expired: status })
  await connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)
  // the setup's own whoami ran first, before the token expired, so the refresh is the second one
  expect(cloudflare.cfRuns.map(({ args }) => args.join(' '))).toEqual(['auth whoami', 'auth whoami'])
  expect(cloudflare.calls.slice(0, 2)).toEqual([`GET /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/settings`, `GET /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/settings`])
  expect(JSON.parse(readFileSync(cloudflare.loginFile, 'utf8'))).toEqual({ oauth_token: 'fresh' })
  expect(storedToken()).toBe('token-of-macbook')
})

test('a cf logged in with an API token gets its calls made with the token CLOUDFLARE_API_TOKEN holds', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, apiToken: true })
  // the stand-in API takes the token `fresh`
  process.env['CLOUDFLARE_API_TOKEN'] = 'fresh'
  try {
    await connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)
  } finally {
    delete process.env['CLOUDFLARE_API_TOKEN']
  }
  expect(cloudflare.cfRuns.map(({ args }) => args.join(' '))).toEqual(['auth whoami'])
  expect(storedToken()).toBe('token-of-macbook')
})

// The suite missed it: the program reads its own service environment, which has no CLOUDFLARE_API_TOKEN, so the token
// login worked only with no program running.
test("Connect Cloudflare for the Step logs cf in with the API token anyhost connect sent, which this process's environment lacks, and joins", async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, apiToken: true })
  const run = connectForStep(DEVICE, NAMES, cloudflare.cloudflare, 'fresh')
  await run.done
  expect(run.view).toMatchObject({ is: 'joined' })
  expect(cloudflare.cfRuns).toEqual([{ args: ['auth', 'whoami'], env: { CLOUDFLARE_API_TOKEN: 'fresh' } }])
  expect(process.env['CLOUDFLARE_API_TOKEN']).toBeUndefined()
  expect(storedToken()).toBe('token-of-macbook')
})

test('a cf run that needs no person and never exits is stopped at its limit, which its error names', async () => {
  // a package registry that takes the request and never answers, so `bun x` waits for cf for good
  const registry = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => undefined) })
  try {
    const started = Date.now()
    await expect(runCf(['auth', 'whoami'], { BUN_INSTALL_CACHE_DIR: temporaryFolder(), NPM_CONFIG_REGISTRY: `http://127.0.0.1:${registry.port}/` }, undefined, 2000)).rejects.toThrow(
      'cf auth whoami ran past its limit of 2 s, so anyhost stopped it.',
    )
    expect(Date.now() - started).toBeLessThan(15_000)
  } finally {
    await registry.stop(true)
  }
})

test('logs cf in when nobody is, showing the person the link and code cf prints', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, loggedIn: false })
  await connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)
  expect(cloudflare.cfRuns.map(({ args }) => args.join(' '))).toEqual(['auth whoami', 'auth login', 'auth whoami'])
  expect(cloudflare.said).toContain('To authorize cf, please visit: https://dash.cloudflare.com/oauth2/device/verify and enter the code: MQxTn4fA.')
})

test('a login cf keeps encrypted logs cf in to a folder of anyhost\'s own for the setup, and deletes it after', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, keyring: true })
  await connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)
  const own = { XDG_CONFIG_HOME: stateFile('connect'), CLOUDFLARE_AUTH_USE_KEYRING: undefined }
  expect(cloudflare.cfRuns).toEqual([
    { args: ['auth', 'whoami'], env: {} },
    { args: ['auth', 'login', '--no-use-keyring'], env: own },
    { args: ['auth', 'whoami'], env: own },
  ])
  expect(cloudflare.said).toContain('To authorize cf, please visit: https://dash.cloudflare.com/oauth2/device/verify and enter the code: MQxTn4fA.')
  expect(storedToken()).toBe('token-of-macbook')
  expect(existsSync(stateFile('connect'))).toBe(false)
  // the person's own login is as it was
  expect(JSON.parse(readFileSync(cloudflare.loginFile, 'utf8'))).toEqual({ oauth_token: 'fresh' })
})

// The suite missed it: every stand-in relay answered this program's own RELAY_VERSION, so an upload over it changed nothing.
test.each([RELAY_VERSION, RELAY_VERSION + 1])('setup on an account whose relay answers relay %d sets only a new setup code, uploads no module, and joins at the first try while the Pool is busy', async (version) => {
  // a busy Pool lags no join after a new secret alone
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, relay: version, secretLag: 3 })
  const before = cloudflare.workers.get(NAMES.worker)
  await connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)
  const relayUrl = 'https://anyhost-test-connect.parker-labs.workers.dev'
  expect(cloudflare.calls).toEqual([
    `GET /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/settings`,
    `GET /accounts/${ACCOUNT.id}/workers/subdomain`,
    // the route goes on first, so a Worker whose route was off answers its health
    `POST /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/subdomain`,
    `GET ${relayUrl}/v1/health`,
    `PUT /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/secrets`,
    // the Worker checks the new code against its own secret
    `POST ${relayUrl}/v1/join`,
  ])
  const after = cloudflare.workers.get(NAMES.worker)
  expect(after?.module).toBe(before?.module)
  expect(after?.relay).toBe(version)
  expect(after?.secret).not.toBe(sha256('an earlier setup code'))
  expect(cloudflare.said).toContain(`Joining ${relayUrl} once it takes the new setup code, for up to 10 minutes`)
  expect(storedToken()).toBe('token-of-macbook')
  expect(cloudflare.said.at(-1)).toBe(`Joined this machine to ${relayUrl}`)
})

test('setup on an account whose relay is older than this program uploads this one with a new setup code, no migration, and joins, turning the route on once', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, relay: RELAY_VERSION - 1 })
  await connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)
  const relayUrl = 'https://anyhost-test-connect.parker-labs.workers.dev'
  expect(cloudflare.calls).toEqual([
    `GET /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/settings`,
    `GET /accounts/${ACCOUNT.id}/workers/subdomain`,
    `POST /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/subdomain`,
    `GET ${relayUrl}/v1/health`,
    `GET /accounts/${ACCOUNT.id}/r2/buckets/anyhost-test (default)`,
    `GET /accounts/${ACCOUNT.id}/r2/buckets/anyhost-test (eu)`,
    `PUT /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect`,
    `POST ${relayUrl}/v1/join`,
  ])
  const again = cloudflare.workers.get(NAMES.worker)
  expect(again?.relay).toBe(RELAY_VERSION)
  expect(again?.module).toContain('class Pool')
  expect(again?.secret).not.toBe(sha256('an earlier setup code'))
  expect(again?.metadata['migrations']).toBeUndefined()
  expect(again?.metadata['keep_bindings']).toBeUndefined()
  expect(storedToken()).toBe('token-of-macbook')
})

// The suite missed it: an upload went up only for a lower relay version, so a protocol bump that left RELAY_VERSION as
// it was left every machine outdated with nothing that fixed it.
test('setup and updateRelay upload this relay over one at this relay version that answers an older protocol', async () => {
  const connecting = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, relay: RELAY_VERSION, protocol: PROTOCOL_VERSION - 1 })
  await connectCloudflare(connecting.progress, DEVICE, NAMES, connecting.cloudflare)
  expect(connecting.workers.get(NAMES.worker)?.protocol).toBe(PROTOCOL_VERSION)
  expect(connecting.calls).toContain(`PUT /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect`)
  expect(storedToken()).toBe('token-of-macbook')

  const updating = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, relay: RELAY_VERSION, protocol: PROTOCOL_VERSION - 1 })
  const secret = updating.workers.get(NAMES.worker)?.secret
  await updateRelay(NAMES, updating.cloudflare)
  expect(updating.workers.get(NAMES.worker)).toMatchObject({ protocol: PROTOCOL_VERSION, secret })
})

// The suite missed it: the stand-in's cmod named the machine the program connects as.
test('setup joins the machine the program connects as, not the name cmod gives it since a rename', async () => {
  const cloudflare = standIn()
  await connectCloudflare(cloudflare.progress, { ...DEVICE, name: 'old-macbook' }, NAMES, cloudflare.cloudflare)
  expect(storedToken()).toBe('token-of-old-macbook')
})

// The suite missed it: the stand-in's Pool lagged only after a new setup code secret, never after an upload.
test('setup over an older relay whose Pool takes the new setup code 3 joins late joins once it does', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, relay: RELAY_VERSION - 1, secretLag: 3 })
  await connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)
  const relayUrl = 'https://anyhost-test-connect.parker-labs.workers.dev'
  expect(cloudflare.workers.get(NAMES.worker)?.relay).toBe(RELAY_VERSION)
  expect(cloudflare.calls.filter((call) => call === `POST ${relayUrl}/v1/join`)).toHaveLength(4)
  expect(storedToken()).toBe('token-of-macbook')
  expect(cloudflare.said.at(-1)).toBe(`Joined this machine to ${relayUrl}`)
})

// The suite missed it: every stand-in Worker answered its health as a relay, so no setup met one that answered else.
test.each([
  [429, 'error code: 1027'],
  [503, '{"error":"unavailable","message":"The relay failed: Error: R2 is down"}'],
])('setup over a Worker whose /v1/health answers %d uploads nothing over it and fails naming that answer', async (status, body) => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, relay: RELAY_VERSION + 1, health: { status, body } })
  const relayUrl = 'https://anyhost-test-connect.parker-labs.workers.dev'
  await expect(connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)).rejects.toThrow(
    `${relayUrl}/v1/health answered ${status} ${body}, which names no relay version, so anyhost uploads nothing over the Worker there. Try again later.`,
  )
  // at once, with no second read
  expect(cloudflare.calls.filter((call) => call.endsWith('/v1/health'))).toHaveLength(1)
  expect(cloudflare.calls.filter((call) => call.startsWith('PUT'))).toEqual([])
  expect(cloudflare.workers.get(NAMES.worker)?.relay).toBe(RELAY_VERSION + 1)
  expect(existsSync(stateFile('relay.json'))).toBe(false)
})

// The suite missed it: every stand-in Worker answered its health the moment its route went on, while a live route
// answered Cloudflare's 404 page 13 ms after it went on and the relay 0.55 to 1.4 s after.
test('setup over a Worker whose route was just turned on asks again while Cloudflare answers its 404 page, and joins', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, relay: RELAY_VERSION, notFound: 2 })
  await connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)
  const relayUrl = 'https://anyhost-test-connect.parker-labs.workers.dev'
  expect(cloudflare.calls.slice(2)).toEqual([
    `POST /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/subdomain`,
    ...Array.from({ length: 3 }, () => `GET ${relayUrl}/v1/health`),
    `PUT /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/secrets`,
    `POST ${relayUrl}/v1/join`,
  ])
  expect(storedToken()).toBe('token-of-macbook')
})

test('setup over a Worker that answers Cloudflare\'s 404 page 30 s after its route went on uploads nothing and fails naming the limit', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, relay: RELAY_VERSION, notFound: 1000 })
  const relayUrl = 'https://anyhost-test-connect.parker-labs.workers.dev'
  await expect(connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)).rejects.toThrow(
    `${relayUrl}/v1/health still answered Cloudflare's 404 page 30 s after anyhost turned its route on, so anyhost uploads nothing over the Worker there. Try again later. Its answer: <!DOCTYPE html>`,
  )
  // one read a second, from 0 to 30 s
  expect(cloudflare.calls.filter((call) => call.endsWith('/v1/health'))).toHaveLength(31)
  expect(cloudflare.calls.filter((call) => call.startsWith('PUT'))).toEqual([])
  expect(existsSync(stateFile('relay.json'))).toBe(false)
})

// The suite missed it: the stand-in's login reached one account, so no test had a login on several.
test('with a login on two accounts, one of which holds the Worker, Connect Cloudflare asks nothing and joins that account', async () => {
  const other: Account = { id: 'f00dfeed', name: 'Side Project' }
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, others: [other], relay: RELAY_VERSION })
  // the stand-in's pickAccount fails the setup when it is asked
  await connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)
  expect(cloudflare.calls.slice(0, 2)).toEqual([`GET /accounts/${other.id}/workers/scripts/anyhost-test-connect/settings`, `GET /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/settings`])
  expect(cloudflare.calls.some((call) => call.startsWith(`PUT /accounts/${other.id}`) || call.startsWith(`POST /accounts/${other.id}`))).toBe(false)
  expect(JSON.parse(readFileSync(stateFile('relay.json'), 'utf8'))).toEqual({ url: 'https://anyhost-test-connect.parker-labs.workers.dev' })
  expect(storedToken()).toBe('token-of-macbook')
})

test('updateRelay uploads the relay over an older one with keep_bindings and no secret, so the setup code secret stays', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, relay: RELAY_VERSION - 1 })
  const secret = cloudflare.workers.get(NAMES.worker)?.secret
  await updateRelay(NAMES, cloudflare.cloudflare)
  const updated = cloudflare.workers.get(NAMES.worker)
  expect(updated?.relay).toBe(RELAY_VERSION)
  expect(updated?.metadata['keep_bindings']).toEqual(['secret_text'])
  expect((updated?.metadata['bindings'] as { type: string }[]).map(({ type }) => type)).toEqual(['r2_bucket', 'durable_object_namespace', 'plain_text'])
  expect(updated?.metadata['migrations']).toBeUndefined()
  expect(updated?.secret).toBe(secret)
})

test('updateRelay uploads nothing over a relay as new as this program\'s or newer, as a newer machine put up', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, relay: RELAY_VERSION + 1 })
  await updateRelay(NAMES, cloudflare.cloudflare)
  expect(cloudflare.workers.get(NAMES.worker)?.relay).toBe(RELAY_VERSION + 1)
  expect(cloudflare.calls.filter((call) => call.startsWith('PUT') || call.startsWith('POST'))).toEqual([])
})

test('updateRelay asks nothing: with cf logged out, or no relay to update, it fails and logs nobody in', async () => {
  const loggedOut = standIn({ r2: true, subdomain: 'parker-labs', loggedIn: false })
  await expect(updateRelay(NAMES, loggedOut.cloudflare)).rejects.toThrow('cf is logged in to no Cloudflare account on this machine. Connect Cloudflare logs it in.')
  expect(loggedOut.cfRuns.map(({ args }) => args.join(' '))).toEqual(['auth whoami'])
  const keyring = standIn({ r2: true, subdomain: 'parker-labs', keyring: true })
  await expect(updateRelay(NAMES, keyring.cloudflare)).rejects.toThrow('which anyhost cannot read with no one watching')
  expect(keyring.cfRuns.map(({ args }) => args.join(' '))).toEqual(['auth whoami'])
  const none = standIn()
  await expect(updateRelay(NAMES, none.cloudflare)).rejects.toThrow('0 accounts of your Cloudflare login hold the Worker anyhost-test-connect, so anyhost updates none. Connect Cloudflare deploys it.')
})

test("the options are read at the first ask, then again only after a write to Claude Code's settings.json, also through a symlink", async () => {
  // the Architect's settings.json links into his dotfiles, which this stand-in cmod reads
  const dotfiles = join(home, 'data', 'cmod', 'programs', 'settings.json')
  writeFileSync(dotfiles, '{"uploadEvery":7}')
  symlinkSync(dotfiles, join(process.env['CLAUDE_CONFIG_DIR'] ?? '', 'settings.json'))
  expect(await personOptions()).toEqual({ uploadEvery: 7 })
  // the service asks again each minute
  expect(await personOptions()).toEqual({ uploadEvery: 7 })
  expect(cmodCalls()).toEqual(['options'])

  // cmod option anyhost join <link> writes the file the link names
  writeFileSync(dotfiles, '{"uploadEvery":7,"join":"https://anyhost-test-connect.parker-labs.workers.dev/v1/join#code"}')
  expect(await personOptions()).toEqual({ uploadEvery: 7, join: 'https://anyhost-test-connect.parker-labs.workers.dev/v1/join#code' })
  expect(await personOptions()).toEqual({ uploadEvery: 7, join: 'https://anyhost-test-connect.parker-labs.workers.dev/v1/join#code' })
  expect(cmodCalls()).toEqual(['options', 'options'])
})

test('the device token is read at the first connect, then again only after a join wrote relay.json', async () => {
  const url = 'https://anyhost-test-connect.parker-labs.workers.dev'
  await saveRelayLogin({ url, token: 'first-token' })
  expect(await relayLogin()).toEqual({ url, token: 'first-token' })
  // a service whose relay does not answer connects again each minute
  expect(await relayLogin()).toEqual({ url, token: 'first-token' })
  expect(cmodCalls()).toEqual(['secret get'])

  // a join keeps the same address and a new token
  await saveRelayLogin({ url, token: 'second-token' })
  expect(await relayLogin()).toEqual({ url, token: 'second-token' })
  expect(await relayLogin()).toEqual({ url, token: 'second-token' })
  expect(cmodCalls()).toEqual(['secret get', 'secret get'])
})

const ROOTS = { home: '/home/ada', claudeHome: '/home/ada/.claude', claudeTmp: '/tmp/claude-1000', codexHome: '/home/ada/.codex' }
const services: Relay[] = []
afterEach(async () => {
  for (const relay of services.splice(0)) relay.close()
  await stopRelays()
})
// the service's connection, with the login relay.json and the token hold
function service(): Relay {
  const relay = connectRelay({ login: relayLogin, forget: forgetRelayLogin, device: DEVICE, roots: ROOTS, isPatient: true })
  services.push(relay)
  return relay
}

test('a machine its relay removed forgets relay.json and the token, and is unjoined with the reason', async () => {
  const relay = await memoryRelay()
  await saveRelayLogin({ url: relay.url, token: await relay.join(DEVICE, ROOTS) })
  const here = service()
  await welcomed(here)

  relay.remove(DEVICE.id)
  // the connect after the removal read no login
  await until(() => here.url === '')
  expect(here.state).toEqual({ is: 'unjoined', message: 'This machine was removed from your machines. Join it again with a link from Add a machine.' })
  expect(existsSync(stateFile('relay.json'))).toBe(false)
  expect(existsSync(secretFile())).toBe(false)
})

test('a token the relay knows no machine with is forgotten too, and the machine is unjoined with the reason', async () => {
  const relay = await memoryRelay()
  await saveRelayLogin({ url: relay.url, token: 'token-the-relay-never-gave' })
  const here = service()

  await until(() => here.state.is === 'unjoined' && here.url === '')
  expect(here.state).toEqual({ is: 'unjoined', message: 'The relay knows no machine with this token. Join it again with a link from Add a machine.' })
  expect(existsSync(stateFile('relay.json'))).toBe(false)
  expect(existsSync(secretFile())).toBe(false)
})

test('a removal that arrives after a newer join saved its login keeps that login, and the machine connects with it', async () => {
  const old = await memoryRelay()
  await saveRelayLogin({ url: old.url, token: await old.join(DEVICE, ROOTS) })
  const here = service()
  await welcomed(here)
  // a join to another relay saves its login while the socket the old login opened is still connected
  const newer = await memoryRelay()
  const token = await newer.join(DEVICE, ROOTS)
  await saveRelayLogin({ url: newer.url, token })

  old.remove(DEVICE.id)
  await until(() => here.state.is === 'connected' && here.url === newer.url)
  expect(JSON.parse(readFileSync(stateFile('relay.json'), 'utf8'))).toEqual({ url: newer.url })
  expect(storedToken()).toBe(token)
})

test('Connect Cloudflare for the Step keeps every line, and waits on the account and on R2 for the person\'s answers', async () => {
  const other: Account = { id: 'f00dfeed', name: 'Side Project' }
  const cloudflare = standIn({ r2: false, subdomain: 'parker-labs', others: [other] })
  const run = connectForStep(DEVICE, NAMES, cloudflare.cloudflare)
  await until(() => run.view.accounts !== undefined)
  expect(run.view).toEqual({ is: 'running', lines: ['Checking your Cloudflare login'], accounts: [other, ACCOUNT] })
  expect(() => run.turnedOnR2()).toThrow('Connect Cloudflare waits for no R2 now.')

  run.pickAccount(ACCOUNT.id)
  await until(() => run.view.r2Page !== undefined)
  expect(run.view.accounts).toBeUndefined()
  expect(run.view.r2Page).toBe(R2_PAGE)
  expect(run.view.lines.at(-1)).toBe(`R2 is off in Parker Labs. Turn it on at ${R2_PAGE}, then go on.`)

  cloudflare.turnOnR2()
  run.turnedOnR2()
  await run.done
  expect(run.view).toMatchObject({ is: 'joined' })
  expect(run.view.r2Page).toBeUndefined()
  expect(run.view.lines.at(-1)).toBe('Joined this machine to https://anyhost-test-connect.parker-labs.workers.dev')
  expect(storedToken()).toBe('token-of-macbook')
})

test('Connect Cloudflare for the Step ends failed with the reason', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, resets: 6 })
  const run = connectForStep(DEVICE, NAMES, cloudflare.cloudflare)
  await run.done
  expect(run.view).toMatchObject({ is: 'failed', error: expect.stringContaining('got no answer in 6 tries') })
})

test('join refuses a link that is no invite link, and says why the relay refused one', async () => {
  const cloudflare = standIn()
  await connectCloudflare(cloudflare.progress, DEVICE, NAMES, cloudflare.cloudflare)
  await expect(joinRelay('K7QX2M4W9TPR6ZC3HN8JD5VB', DEVICE, cloudflare.cloudflare)).rejects.toThrow('K7QX2M4W9TPR6ZC3HN8JD5VB is no invite link, which reads https://<relay>/v1/join#<code>.')
  await expect(joinRelay('https://anyhost-test-connect.parker-labs.workers.dev/v1/join#K7QX2M4W9TPR6ZC3HN8JD5VB', DEVICE, cloudflare.cloudflare)).rejects.toThrow(
    'https://anyhost-test-connect.parker-labs.workers.dev refused to join macbook: The relay made no invite with that code. Make a new one with Add a machine.',
  )
})

const SRC = join(import.meta.dir, '..', 'src')
const SESSION = '11111111-2222-3333-4444-555555555555'
const decoder = new TextDecoder()
const children: Subprocess[] = []
const servers: { stop(closeActiveConnections?: boolean): Promise<void> }[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited
  }
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
})

// A program that runs `anyhost serve` against the relay in workerd took 5.0 to 8.3 s on test machines, as relay.test.ts
// measured, so a wait on one gives it 30 s.
async function waitFor(what: string, isTrue: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  for (const started = Date.now(); !(await isTrue()); await Bun.sleep(20)) if (Date.now() - started > ms) throw new Error(`${what} did not happen within ${ms} ms.`)
}

const statusOf = async (socket: string): Promise<Status> => (await (await fetch('http://localhost/status', { unix: socket })).json()) as Status

// The environment this machine's program and commands run in, as its service gives one: the test's state folder,
// Claude Code folder and cmod, whose options set `uploadEvery` 0, and folders of their own for the rest, so no child
// reads this Mac's. No test here runs a session, so Claude Code is a program that fails.
function machineEnv(): Record<string, string> {
  const folder = temporaryFolder()
  writeFileSync(join(home, 'data', 'cmod', 'programs', 'settings.json'), '{"uploadEvery":0}')
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: folder,
    XDG_STATE_HOME: process.env['XDG_STATE_HOME'] ?? '',
    XDG_DATA_HOME: join(home, 'data'),
    CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'] ?? '',
    CLAUDE_CODE_TMPDIR: folder,
    CODEX_HOME: join(folder, '.codex'),
    CLAUDE_CODE_EXECPATH: '/usr/bin/false',
    ANYHOST_DEVICE_ID: DEVICE.id,
    ANYHOST_DEVICE_NAME: DEVICE.name,
    ANYHOST_DEVICE_OS: DEVICE.os,
    ANYHOST_DEVICE_ARCH: DEVICE.arch,
  }
}

// Runs `anyhost serve` as its service runs it, with `cloudflare` for the Cloudflare its Connect Cloudflare and relay
// update reach: a script hands `serve` a Cloudflare that sends each fetch and cf run to a server of this test, which
// answers it from `cloudflare`. Answers the program's socket. What the program logs goes to the test's own errors.
async function programWith(cloudflare: Cloudflare, env: Record<string, string>): Promise<string> {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname === '/cf') {
        const { args, env: cfEnv } = (await request.json()) as { args: string[]; env: CfEnvironment }
        return await cloudflare.cf(args, cfEnv).then(
          (printed) => new Response(printed),
          (error: unknown) => new Response(error instanceof Error ? error.message : String(error), { status: 500 }),
        )
      }
      // an upload's form, its parts as the program sent them, as the stand-in reads a form
      const formOf = async (): Promise<FormData> => {
        const form = new FormData()
        for (const [name, value] of await request.formData()) form.append(name, value)
        return form
      }
      const isForm = (request.headers.get('content-type') ?? '').startsWith('multipart/form-data')
      const body = request.method === 'GET' ? undefined : isForm ? await formOf() : await request.text()
      return await cloudflare.fetch(decodeURIComponent(pathname.slice('/fetch/'.length)), { method: request.method, headers: request.headers, ...(body === undefined ? {} : { body }) })
    },
  })
  servers.push(server)
  const script = join(temporaryFolder(), 'program.ts')
  writeFileSync(
    script,
    `import { deviceFromEnvironment } from ${JSON.stringify(join(SRC, 'device.ts'))}
import { serve } from ${JSON.stringify(join(SRC, 'serve.ts'))}
const at = 'http://127.0.0.1:${server.port}'
await serve(deviceFromEnvironment(), ${JSON.stringify(NAMES)}, {
  fetch: (url, init) => fetch(at + '/fetch/' + encodeURIComponent(url), init),
  async cf(args, env) {
    const answer = await fetch(at + '/cf', { method: 'POST', body: JSON.stringify({ args, env }) })
    const printed = await answer.text()
    if (!answer.ok) throw new Error(printed)
    return printed
  },
  now: Date.now,
  sleep: Bun.sleep,
})
`,
  )
  const child = Bun.spawn(['bun', script], { env, stdout: 'pipe', stderr: 'inherit' })
  children.push(child)
  const reader = child.stdout.getReader()
  let printed = ''
  while (!printed.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`anyhost serve exited, having printed ${JSON.stringify(printed)}.`)
    printed += decoder.decode(value)
  }
  reader.releaseLock()
  return printed.slice('unix:'.length, printed.indexOf('\n'))
}

// A machine's socket to the front, with the headers the relay reads, and the messages it sent before the front's own
// socket to the relay opened.
type Carried = { readonly headers: Record<string, string>; readonly queued: (string | Uint8Array)[]; relay?: WebSocket }

// The memory relay behind a front whose welcome names the versions `worker` runs, as the relay Connect Cloudflare put
// up answers its own, and keeps each welcome's versions in `welcomes`.
function frontOf(relay: MemoryRelay, worker: () => Worker | undefined): { readonly url: string; readonly welcomes: { relay: number; protocol: number }[] } {
  const welcomes: { relay: number; protocol: number }[] = []
  const server = Bun.serve<Carried>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, server) {
      const headers: Record<string, string> = {}
      for (const [name, value] of request.headers) if (name === 'authorization' || name.startsWith('x-anyhost-')) headers[name] = value
      return server.upgrade(request, { data: { headers, queued: [] } }) ? undefined : new Response("The front carries only the relay's WebSocket.", { status: 400 })
    },
    websocket: {
      open(front) {
        const socket = new WebSocket(`${relay.url.replace(/^http/, 'ws')}/v1/connect`, { headers: front.data.headers })
        socket.binaryType = 'arraybuffer'
        front.data.relay = socket
        socket.addEventListener('open', () => {
          for (const message of front.data.queued.splice(0)) socket.send(message)
        })
        socket.addEventListener('message', ({ data }) => {
          if (typeof data !== 'string') return void front.send(new Uint8Array(data as ArrayBuffer))
          const message = data === 'pong' ? undefined : (JSON.parse(data) as { readonly t?: string })
          if (message?.t !== 'welcome') return void front.send(data)
          const versions = { relay: worker()?.relay ?? 0, protocol: worker()?.protocol ?? 0 }
          welcomes.push(versions)
          front.send(JSON.stringify({ ...message, ...versions }))
        })
        // a close the front passes on with its code, or a socket that ended with no close, as 1006 says
        socket.addEventListener('close', ({ code, reason }) => (code === 1000 || (code >= 3000 && code < 5000) ? front.close(code, reason) : front.terminate()))
      },
      message(front, message) {
        const { relay: socket } = front.data
        if (socket?.readyState === WebSocket.OPEN) socket.send(message)
        else front.data.queued.push(typeof message === 'string' ? message : new Uint8Array(message))
      },
      close(front) {
        front.data.relay?.close()
      },
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, welcomes }
}

// The suite missed it: the program updated only a relay of an older protocol, so a relay fix alone, at the same
// protocol, never rolled out.
test('a running program whose relay is an older relay version at its protocol keeps capturing while it uploads this relay with its cf login, then connects to it', async () => {
  const relay = await memoryRelay()
  const upload = Promise.withResolvers<void>()
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, relay: RELAY_VERSION - 1, upload: upload.promise })
  const front = frontOf(relay, () => cloudflare.workers.get(NAMES.worker))
  await saveRelayLogin({ url: front.url, token: await relay.join(DEVICE, ROOTS) })
  const env = machineEnv()
  const socket = await programWith(cloudflare.cloudflare, env)
  await waitFor('the relay update uploading', () => cloudflare.calls.includes(`PUT /accounts/${ACCOUNT.id}/workers/scripts/${NAMES.worker}`))
  expect((await statusOf(socket)).relay.state).toBe('connected')

  // a session's line goes up while the upload waits
  const transcript = join(env['CLAUDE_CONFIG_DIR'] ?? '', 'projects', '-work', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
  await waitFor('the line uploading', () => relay.puts.some(({ key, body }) => key.startsWith(`journals/${SESSION}/hot/`) && decoder.decode(decompress(body)).includes('Plan the trip')))
  expect(cloudflare.workers.get(NAMES.worker)?.relay).toBe(RELAY_VERSION - 1)

  upload.resolve()
  await waitFor('the program connecting to the relay it put up', () => front.welcomes.length === 2)
  expect(front.welcomes).toEqual([
    { relay: RELAY_VERSION - 1, protocol: PROTOCOL_VERSION },
    { relay: RELAY_VERSION, protocol: PROTOCOL_VERSION },
  ])
  const updated = cloudflare.workers.get(NAMES.worker)
  expect(updated?.metadata['keep_bindings']).toEqual(['secret_text'])
  expect(updated?.secret).toBe(sha256('an earlier setup code'))
  const status = await statusOf(socket)
  expect(status.relay.state).toBe('connected')
  expect(status.updateProblem).toBeUndefined()
}, 60_000)

// The suite missed it: a machine whose own update failed kept the problem, and anyhost doctor its ✘, after another
// machine updated the relay.
test('a running program whose relay update failed loses the relay update problem once a relay that needs no upload welcomes it', async () => {
  const relay = await memoryRelay()
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, loggedIn: false, relay: RELAY_VERSION, protocol: PROTOCOL_VERSION - 1 })
  const front = frontOf(relay, () => cloudflare.workers.get(NAMES.worker))
  await saveRelayLogin({ url: front.url, token: await relay.join(DEVICE, ROOTS) })
  const socket = await programWith(cloudflare.cloudflare, machineEnv())
  await waitFor('the failed update in /status', async () => (await statusOf(socket)).updateProblem !== undefined)
  const failed = await statusOf(socket)
  expect(failed.relay.state).toBe('outdated')
  expect(failed.updateProblem).toEndWith('relay update: Error: cf is logged in to no Cloudflare account on this machine. Connect Cloudflare logs it in.')

  // another machine's Connect Cloudflare puts this program's relay up, which the program's next connect meets
  const worker = cloudflare.workers.get(NAMES.worker)
  if (worker !== undefined) worker.protocol = PROTOCOL_VERSION
  await waitFor('the program connecting', async () => (await statusOf(socket)).relay.state === 'connected')
  expect((await statusOf(socket)).updateProblem).toBeUndefined()
}, 60_000)

// The suite missed it: anyhost connect goes through the program, whose service environment has no
// CLOUDFLARE_API_TOKEN, so a token login worked only with no program running.
test("anyhost connect with CLOUDFLARE_API_TOKEN set sends it to the running program, whose Connect Cloudflare logs cf in and calls Cloudflare's API with it", async () => {
  const other: Account = { id: 'f00dfeed', name: 'Side Project' }
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', apiToken: true, others: [other] })
  const env = machineEnv()
  await programWith(cloudflare.cloudflare, env)
  const command = Bun.spawn(['bun', join(SRC, 'main.ts'), 'connect'], { env: { ...env, CLOUDFLARE_API_TOKEN: 'fresh' }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  children.push(command)
  // the run asks which account only once the token's login listed them and the API took it, and it joins nothing
  // before the answer, as a join would point the program at the stand-in's workers.dev address
  const reader = command.stdout.getReader()
  let printed = ''
  while (!printed.includes('Type the number of the account your relay goes in:')) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`anyhost connect exited, having printed ${JSON.stringify(printed)}: ${await new Response(command.stderr).text()}`)
    printed += decoder.decode(value)
  }
  expect(cloudflare.cfRuns).toEqual([{ args: ['auth', 'whoami'], env: { CLOUDFLARE_API_TOKEN: 'fresh' } }])
  expect(cloudflare.calls).toEqual([`GET /accounts/${other.id}/workers/scripts/anyhost-test-connect/settings`, `GET /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/settings`])
}, 60_000)
