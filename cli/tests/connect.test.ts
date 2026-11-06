import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PROTOCOL_VERSION, RELAY_VERSION } from '../../relay/protocol.ts'
import { connectCloudflare, connectForStep, join as joinRelay, joinWithOption, updateRelay, type Account, type Cloudflare, type Progress } from '../src/connect.ts'
import { personOptions, relayLogin, saveRelayLogin } from '../src/device.ts'
import { temporaryFolder } from './memory.ts'

const NAMES = { worker: 'anyhost-test-connect', bucket: 'anyhost-test' }
const ACCOUNT: Account = { id: '0534ffa9', name: 'Parker Labs' }
const API = 'https://api.cloudflare.com/client/v4'
const R2_PAGE = 'https://dash.cloudflare.com/?to=/:account/r2/overview'
const DEVICE = { id: 'c0ffee', name: 'macbook', os: 'darwin', arch: 'arm64' }
const kept: Record<string, string | undefined> = {}
let home = ''

type CfEnvironment = Parameters<Cloudflare['cf']>[1]

// cmod as the program runs it, from the cmod store's programs folder: `device` prints this machine, `secret store`
// keeps the value it reads from stdin beside itself and `secret get` prints it, and `options` prints the person's
// options as the `settings.json` beside it holds them. Each `secret get` and `options` adds a line to `calls`. A child
// gets the environment the test process started with, not the one a test sets.
beforeAll(() => {
  home = temporaryFolder()
  const cmod = join(home, 'data', 'cmod', 'programs', 'cmod')
  mkdirSync(dirname(cmod), { recursive: true })
  writeFileSync(
    cmod,
    `#!/bin/sh\ncase "$1 $2" in\n  device*) printf '%s' '${JSON.stringify(DEVICE)}' ;;\n  "secret get") echo "secret get" >> "$(dirname "$0")/calls"; cat "$(dirname "$0")/secret-$3-$4" ;;\n  secret*) cat > "$(dirname "$0")/secret-$3-$4" ;;\n  options*) echo options >> "$(dirname "$0")/calls"; printf '{"person":%s}' "$(cat "$(dirname "$0")/settings.json")" ;;\n  option*) printf '%s=%s\\n' "$3" "$4" >> "$(dirname "$0")/option-$2" ;;\n  *) exit 2 ;;\nesac\n`,
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
// every `cmod option anyhost <key> <value>` the program ran, one `<key>=<value>` line each
const optionsSet = (): string[] => (existsSync(join(home, 'data', 'cmod', 'programs', 'option-anyhost')) ? readFileSync(join(home, 'data', 'cmod', 'programs', 'option-anyhost'), 'utf8').split('\n').filter(Boolean) : [])

// every `cmod secret get` and `cmod options` the program ran, in order
const cmodCalls = (): string[] => (existsSync(join(home, 'data', 'cmod', 'programs', 'calls')) ? readFileSync(join(home, 'data', 'cmod', 'programs', 'calls'), 'utf8').split('\n').filter(Boolean) : [])

// each test starts with an empty state folder and Claude Code folder, no token, no option set and no cmod call
beforeEach(() => {
  process.env['XDG_STATE_HOME'] = temporaryFolder()
  process.env['CLAUDE_CONFIG_DIR'] = temporaryFolder()
  rmSync(secretFile(), { force: true })
  rmSync(join(home, 'data', 'cmod', 'programs', 'option-anyhost'), { force: true })
  rmSync(join(home, 'data', 'cmod', 'programs', 'calls'), { force: true })
})

afterEach(() => setSystemTime())

const stateFile = (name: string): string => join(process.env['XDG_STATE_HOME'] ?? '', 'anyhost', name)
const storedToken = (): string => readFileSync(secretFile(), 'utf8')
const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex')

type Worker = { metadata: Record<string, unknown>; module: string; secret: string | undefined; route: boolean }
type Envelope = { success: boolean; errors: { code: number; message: string }[]; result: unknown }

// Cloudflare as anyhost meets it: the API of one account, the relay each upload runs at its workers.dev address, and
// cf, whose login is a JSON file of its access token or, under `keyring`, a file no other program reads.
function standIn(account: { r2: boolean; subdomain?: string; taken?: string[]; buckets?: Record<string, string>; keyring?: boolean; loggedIn?: boolean; expired?: 403 | 401; notFoundHealth?: number; resets?: number; others?: Account[] } = { r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' } }) {
  const loginFile = join(temporaryFolder(), 'default.json')
  writeFileSync(loginFile, JSON.stringify({ oauth_token: account.expired === undefined ? 'fresh' : 'expired' }))
  let isLoggedIn = account.loggedIn ?? true
  let isExpired = account.expired !== undefined
  let whoamis = 0
  let r2 = account.r2
  let subdomain = account.subdomain
  let notFound = account.notFoundHealth ?? 0
  let resets = account.resets ?? 0
  const buckets = new Map(Object.entries(account.buckets ?? {}))
  const workers = new Map<string, Worker>()
  const joined: string[] = []
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
      buckets.set(name, 'default')
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
      workers.set(worker, { metadata, module: await (form.get('relay.js') as Blob).text(), secret, route: workers.get(worker)?.route ?? false })
      return envelope(200, {})
    }
    if (worker !== undefined && method === 'POST' && rest === '/subdomain') {
      const uploaded = workers.get(worker)
      if (uploaded === undefined) return envelope(404, null, [10007, 'This Worker does not exist on your account.'])
      uploaded.route = true
      return envelope(200, {})
    }
    return envelope(404, null, [7003, `No route for ${method} ${path}.`])
  }

  // the relay as its Pool answers: its health for its bucket, and a join with the setup code its secret names, once
  async function relay(worker: Worker, method: string, path: string, init: RequestInit): Promise<Response> {
    const bucketName = (worker.metadata['bindings'] as { name: string; text?: string }[]).find(({ name }) => name === 'BUCKET_NAME')?.text ?? ''
    const health = { relay: RELAY_VERSION, protocol: PROTOCOL_VERSION, bucket: bucketName }
    if (method === 'GET' && path === '/v1/health') return Response.json(health)
    if (method === 'POST' && path === '/v1/join') {
      const { invite, device } = JSON.parse(String(init.body)) as { invite: string; device: { id: string; name: string } }
      const code = sha256(invite)
      if (code !== worker.secret || joined.includes(code)) return Response.json({ error: 'invite_unknown', message: 'The relay made no invite with that code. Make a new one with Add a machine.' }, { status: 403 })
      joined.push(code)
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
      calls.push(`${method} ${url.slice(API.length)}${new Headers(init.headers).has('cf-r2-jurisdiction') ? ` (${new Headers(init.headers).get('cf-r2-jurisdiction')})` : ''}`)
      return await api(method, url.slice(API.length), init)
    }
    calls.push(`${method} ${url}`)
    const [name, at] = host.split('.')
    const worker = workers.get(name ?? '')
    if (worker === undefined || !worker.route || at !== subdomain) return new Response('<html>404</html>', { status: 404 })
    if (pathname === '/v1/health' && notFound > 0) {
      notFound -= 1
      return new Response('<html>There is nothing here yet</html>', { status: 404, headers: { 'content-type': 'text/html' } })
    }
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
    return JSON.stringify({ authenticated: true, authSource: `OAuth token from ${account.keyring === true ? loginFile.replace('.json', '.enc') : loginFile}`, accounts: [...(account.others ?? []), ACCOUNT] })
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
    sleep: async (ms) => {
      setSystemTime(new Date(Date.now() + ms))
    },
  }
  const enabled: string[] = []
  const progress: Progress = {
    say: (line) => said.push(line),
    pickAccount: async () => {
      throw new Error('The login reaches one account.')
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

// The stand-in moves the clock as the setup waits, so this counts its own tries.
async function until(isTrue: () => boolean): Promise<void> {
  for (let tries = 0; !isTrue(); tries += 1) {
    if (tries > 2500) throw new Error('It did not happen within 5 s.')
    await Bun.sleep(2)
  }
}

test('deploys the relay from nothing into the bucket it finds in the EU, waits for it, and joins this machine', async () => {
  const cloudflare = standIn()
  await connectCloudflare(cloudflare.progress, NAMES, cloudflare.cloudflare)
  const relayUrl = 'https://anyhost-test-connect.parker-labs.workers.dev'
  expect([...new Set(cloudflare.calls)]).toEqual([
    `GET /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/settings`,
    `GET /accounts/${ACCOUNT.id}/r2/buckets/anyhost-test (default)`,
    `GET /accounts/${ACCOUNT.id}/r2/buckets/anyhost-test (eu)`,
    `GET /accounts/${ACCOUNT.id}/workers/subdomain`,
    `PUT /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect`,
    `POST /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/subdomain`,
    `GET ${relayUrl}/v1/health`,
    `POST ${relayUrl}/v1/join`,
  ])
  const worker = cloudflare.workers.get('anyhost-test-connect')
  expect(worker?.metadata).toEqual({
    main_module: 'relay.js',
    compatibility_date: '2026-11-01',
    bindings: [
      { type: 'r2_bucket', name: 'BUCKET', bucket_name: 'anyhost-test', jurisdiction: 'eu' },
      { type: 'durable_object_namespace', name: 'POOL', class_name: 'Pool' },
      { type: 'plain_text', name: 'BUCKET_NAME', text: 'anyhost-test' },
      { type: 'secret_text', name: 'SETUP_CODE_SHA256', text: worker?.secret ?? '' },
    ],
    migrations: { new_tag: 'v1', new_sqlite_classes: ['Pool'] },
  })
  expect(worker?.module).toContain('class Pool')
  // 30 seconds of the relay's own 200, one a second
  expect(cloudflare.calls.filter((call) => call.endsWith('/v1/health')).length).toBe(30)
  expect(storedToken()).toBe('token-of-macbook')
  expect(JSON.parse(readFileSync(stateFile('relay.json'), 'utf8'))).toEqual({ url: relayUrl })
  expect(cloudflare.said.at(-1)).toBe(`Joined this machine to ${relayUrl}`)
  expect(existsSync(stateFile('connect'))).toBe(false)
})

test('waits for 30 seconds straight of the relay answering while the new address still answers Cloudflare\'s 404 page', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, notFoundHealth: 12 })
  await connectCloudflare(cloudflare.progress, NAMES, cloudflare.cloudflare)
  // 30 seconds counted from the last 404, a second before the first 200 after it
  expect(cloudflare.calls.filter((call) => call.endsWith('/v1/health')).length).toBe(12 + 29)
})

test('a call the link reset tries again after 1, 2, 4, 8 and 16 seconds, and fails naming the call after the sixth', async () => {
  const recovers = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, resets: 5 })
  await connectCloudflare(recovers.progress, NAMES, recovers.cloudflare)
  expect(storedToken()).toBe('token-of-macbook')
  const fails = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, resets: 6 })
  await expect(connectCloudflare(fails.progress, NAMES, fails.cloudflare)).rejects.toThrow(
    `GET ${API}/accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/settings got no answer in 6 tries of up to 60 s: ECONNRESET: The socket connection was closed unexpectedly.`,
  )
})

test('makes the bucket when no jurisdiction has it, and binds it with no jurisdiction', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs' })
  await connectCloudflare(cloudflare.progress, { worker: 'anyhost-test-connect', bucket: 'anyhost-test-connect' }, cloudflare.cloudflare)
  expect(cloudflare.calls).toContain(`POST /accounts/${ACCOUNT.id}/r2/buckets`)
  expect(cloudflare.buckets.get('anyhost-test-connect')).toBe('default')
  expect((cloudflare.workers.get('anyhost-test-connect')?.metadata['bindings'] as unknown[])[0]).toEqual({ type: 'r2_bucket', name: 'BUCKET', bucket_name: 'anyhost-test-connect' })
})

test('an account with R2 off (10042) sends the person to turn it on, then tries the bucket again', async () => {
  const cloudflare = standIn({ r2: false, subdomain: 'parker-labs' })
  await connectCloudflare(cloudflare.progress, NAMES, cloudflare.cloudflare)
  expect(cloudflare.enabled).toEqual([R2_PAGE])
  expect(cloudflare.said).toContain(`R2 is off in Parker Labs. Turn it on at ${R2_PAGE}, then go on.`)
  expect(cloudflare.buckets.get('anyhost-test')).toBe('default')
  expect(storedToken()).toBe('token-of-macbook')
})

test('an account with no workers.dev subdomain (10007) registers its own name in lowercase letters, digits and -', async () => {
  const cloudflare = standIn({ r2: true, buckets: { 'anyhost-test': 'eu' } })
  await connectCloudflare(cloudflare.progress, NAMES, cloudflare.cloudflare)
  expect(cloudflare.calls).toContain(`GET /accounts/${ACCOUNT.id}/workers/subdomains/parker-labs`)
  expect(cloudflare.calls).toContain(`PUT /accounts/${ACCOUNT.id}/workers/subdomain`)
  expect(cloudflare.subdomain).toBe('parker-labs')
  expect(JSON.parse(readFileSync(stateFile('relay.json'), 'utf8'))).toEqual({ url: 'https://anyhost-test-connect.parker-labs.workers.dev' })
})

test('a workers.dev subdomain name another account took (10031) registers anyhost- and 6 hex digits instead', async () => {
  const cloudflare = standIn({ r2: true, buckets: { 'anyhost-test': 'eu' }, taken: ['parker-labs'] })
  await connectCloudflare(cloudflare.progress, NAMES, cloudflare.cloudflare)
  expect(cloudflare.subdomain).toMatch(/^anyhost-[0-9a-f]{6}$/)
  expect(JSON.parse(readFileSync(stateFile('relay.json'), 'utf8'))).toEqual({ url: `https://anyhost-test-connect.${cloudflare.subdomain}.workers.dev` })
})

test.each([403, 401] as const)('an expired access token (%d) runs cf, which refreshes it, reads it again and tries once more', async (status) => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, expired: status })
  await connectCloudflare(cloudflare.progress, NAMES, cloudflare.cloudflare)
  // the setup's own whoami ran first, before the token expired, so the refresh is the second one
  expect(cloudflare.cfRuns.map(({ args }) => args.join(' '))).toEqual(['auth whoami', 'auth whoami'])
  expect(cloudflare.calls.slice(0, 2)).toEqual([`GET /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/settings`, `GET /accounts/${ACCOUNT.id}/workers/scripts/anyhost-test-connect/settings`])
  expect(JSON.parse(readFileSync(cloudflare.loginFile, 'utf8'))).toEqual({ oauth_token: 'fresh' })
  expect(storedToken()).toBe('token-of-macbook')
})

test('logs cf in when nobody is, showing the person the link and code cf prints', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, loggedIn: false })
  await connectCloudflare(cloudflare.progress, NAMES, cloudflare.cloudflare)
  expect(cloudflare.cfRuns.map(({ args }) => args.join(' '))).toEqual(['auth whoami', 'auth login', 'auth whoami'])
  expect(cloudflare.said).toContain('To authorize cf, please visit: https://dash.cloudflare.com/oauth2/device/verify and enter the code: MQxTn4fA.')
})

test('a login cf keeps encrypted logs cf in to a folder of anyhost\'s own for the setup, and deletes it after', async () => {
  const cloudflare = standIn({ r2: true, subdomain: 'parker-labs', buckets: { 'anyhost-test': 'eu' }, keyring: true })
  await connectCloudflare(cloudflare.progress, NAMES, cloudflare.cloudflare)
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

test('setup on an account whose relay exists uploads a new setup code, no migration, and joins with it', async () => {
  const cloudflare = standIn()
  await connectCloudflare(cloudflare.progress, NAMES, cloudflare.cloudflare)
  const first = cloudflare.workers.get('anyhost-test-connect')?.secret
  await connectCloudflare(cloudflare.progress, NAMES, cloudflare.cloudflare)
  const again = cloudflare.workers.get('anyhost-test-connect')
  expect(again?.secret).not.toBe(first)
  expect(again?.metadata['migrations']).toBeUndefined()
  expect(again?.metadata['keep_bindings']).toBeUndefined()
  expect(storedToken()).toBe('token-of-macbook')
})

test('updateRelay uploads the relay again with keep_bindings and no secret, so the setup code secret stays', async () => {
  const cloudflare = standIn()
  await connectCloudflare(cloudflare.progress, NAMES, cloudflare.cloudflare)
  const secret = cloudflare.workers.get('anyhost-test-connect')?.secret
  await updateRelay(NAMES, cloudflare.cloudflare)
  const updated = cloudflare.workers.get('anyhost-test-connect')
  expect(updated?.metadata['keep_bindings']).toEqual(['secret_text'])
  expect((updated?.metadata['bindings'] as { type: string }[]).map(({ type }) => type)).toEqual(['r2_bucket', 'durable_object_namespace', 'plain_text'])
  expect(updated?.metadata['migrations']).toBeUndefined()
  expect(updated?.secret).toBe(secret)
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

test('the option join joins this machine at the program\'s start, then empties itself, and a refused one empties too', async () => {
  const cloudflare = standIn()
  await connectCloudflare(cloudflare.progress, NAMES, cloudflare.cloudflare)
  const relayUrl = 'https://anyhost-test-connect.parker-labs.workers.dev'
  rmSync(secretFile(), { force: true })
  rmSync(stateFile('relay.json'), { force: true })
  // a setup code is a join link in the same form, which the stand-in relay takes once
  const code = 'second-setup-code'
  const worker = cloudflare.workers.get('anyhost-test-connect')
  if (worker !== undefined) worker.secret = sha256(code)

  expect(await joinWithOption(`${relayUrl}/v1/join#${code}`, cloudflare.cloudflare)).toBe(relayUrl)
  expect(storedToken()).toBe('token-of-macbook')
  expect(JSON.parse(readFileSync(stateFile('relay.json'), 'utf8'))).toEqual({ url: relayUrl })
  expect(optionsSet()).toEqual(['join='])

  await expect(joinWithOption(`${relayUrl}/v1/join#${code}`, cloudflare.cloudflare)).rejects.toThrow('The relay made no invite with that code.')
  expect(optionsSet()).toEqual(['join=', 'join='])
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

test('Connect Cloudflare for the Step keeps every line, and waits on the account and on R2 for the person\'s answers', async () => {
  const other: Account = { id: 'f00dfeed', name: 'Side Project' }
  const cloudflare = standIn({ r2: false, subdomain: 'parker-labs', others: [other] })
  const run = connectForStep(NAMES, cloudflare.cloudflare)
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
  const run = connectForStep(NAMES, cloudflare.cloudflare)
  await run.done
  expect(run.view).toMatchObject({ is: 'failed', error: expect.stringContaining('got no answer in 6 tries') })
})

test('join refuses a link that is no invite link, and says why the relay refused one', async () => {
  const cloudflare = standIn()
  await connectCloudflare(cloudflare.progress, NAMES, cloudflare.cloudflare)
  await expect(joinRelay('K7QX2M4W9TPR6ZC3HN8JD5VB', cloudflare.cloudflare)).rejects.toThrow('K7QX2M4W9TPR6ZC3HN8JD5VB is no invite link, which reads https://<relay>/v1/join#<code>.')
  await expect(joinRelay('https://anyhost-test-connect.parker-labs.workers.dev/v1/join#K7QX2M4W9TPR6ZC3HN8JD5VB', cloudflare.cloudflare)).rejects.toThrow(
    'https://anyhost-test-connect.parker-labs.workers.dev refused to join macbook: The relay made no invite with that code. Make a new one with Add a machine.',
  )
})
