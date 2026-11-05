// The relay's Worker: the HTTP routes under /v1. It streams each object over 1 MiB straight between the machine and
// R2, and hands everything else to the Pool, the one Durable Object of the person's machines.
import { Pool, healthOf, type Env, type Reply } from './pool.ts'
import type { ErrorCode, Refusal } from './protocol.ts'

export { Pool }

const OBJECTS = '/v1/objects/'

const reply = ({ status, body }: Reply): Response => Response.json(body, { status })
const refuse = (status: number, error: ErrorCode, message: string): Response => reply({ status, body: { error, message } satisfies Refusal })
const tokenOf = (request: Request): string => request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''

// Streams the request's body into R2. A journal frame names its session in X-Anyhost-Holder: the Pool refuses it once
// another machine holds the session, and a takeover waits until the write ends.
async function putObject(env: Env, pool: DurableObjectStub<Pool>, key: string, request: Request): Promise<Response> {
  // the R2 binding refuses a stream of unknown length
  if (!request.headers.has('content-length')) return refuse(411, 'length_required', 'A PUT of an object names its Content-Length.')
  const holder = request.headers.get('x-anyhost-holder') ?? undefined
  using authorized = await pool.authorize(tokenOf(request), holder)
  if ('refused' in authorized) return reply(authorized.refused)
  const onlyIf = new Headers()
  for (const name of ['if-none-match', 'if-match']) {
    const value = request.headers.get(name)
    if (value !== null) onlyIf.set(name, value)
  }
  const stored = await env.BUCKET.put(key, request.body, { onlyIf })
  if (stored !== null) return Response.json({ etag: stored.etag, size: stored.size })
  const there = await env.BUCKET.head(key)
  return Response.json({ error: 'precondition', message: `${key} failed the request's ${[...onlyIf.keys()].join(' and ')}.`, ...(there === null ? {} : { etag: there.etag }) }, { status: 412 })
}

// Streams an object from R2, or the part its Range names, so a broken download resumes.
async function getObject(env: Env, pool: DurableObjectStub<Pool>, key: string, request: Request): Promise<Response> {
  using authorized = await pool.authorize(tokenOf(request))
  if ('refused' in authorized) return reply(authorized.refused)
  const header = request.headers.get('range')
  const range = header === null ? undefined : rangeOf(header)
  if (range === null) return refuse(416, 'invalid', `The relay serves one range of bytes, as bytes=0-99, bytes=100- or bytes=-100, not ${header}.`)
  const object = await env.BUCKET.get(key, range === undefined ? {} : { range }).catch((error: unknown) => {
    if (range === undefined) throw error
    return undefined
  })
  if (object === undefined) return refuse(416, 'invalid', `${key} has no bytes in ${header}.`)
  if (object === null) return refuse(404, 'missing', `No object ${key} is in the bucket.`)
  // an object without a type is text to Cloudflare, which compresses it and drops its Content-Length
  const headers = new Headers({ 'content-type': 'application/octet-stream', etag: object.httpEtag, 'last-modified': object.uploaded.toUTCString(), 'accept-ranges': 'bytes' })
  if (range === undefined) return new Response(object.body, { headers })
  const offset = 'suffix' in range ? Math.max(0, object.size - range.suffix) : range.offset
  const end = 'length' in range ? Math.min(object.size, offset + range.length) : object.size
  headers.set('content-range', `bytes ${offset}-${end - 1}/${object.size}`)
  return new Response(object.body, { status: 206, headers })
}

// The one range a Range header names, or null for one the relay does not serve.
function rangeOf(header: string): { offset: number; length?: number } | { suffix: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null || (match[1] === '' && match[2] === '')) return null
  const [first, last] = [match[1] === '' ? undefined : Number(match[1]), match[2] === '' ? undefined : Number(match[2])]
  if (first === undefined) return last === 0 ? null : { suffix: last! }
  if (last === undefined) return { offset: first }
  return last < first ? null : { offset: first, length: last - first + 1 }
}

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url)
  const pool = env.POOL.get(env.POOL.idFromName('pool'))
  if (pathname === '/v1/health' && request.method === 'GET') return Response.json(healthOf(env))
  if (pathname === '/v1/join' && request.method === 'POST') {
    const body: unknown = await request.json().catch(() => undefined)
    return reply(await pool.join(body))
  }
  if (pathname === '/v1/connect' && request.method === 'GET') {
    if (request.headers.get('upgrade') !== 'websocket') return refuse(426, 'invalid', '/v1/connect opens a WebSocket.')
    return await pool.fetch(request)
  }
  if (pathname.startsWith(OBJECTS) && pathname.length > OBJECTS.length && (request.method === 'PUT' || request.method === 'GET')) {
    let key: string
    try {
      key = decodeURIComponent(pathname.slice(OBJECTS.length))
    } catch {
      return refuse(400, 'invalid', `${pathname} names no key the relay can decode.`)
    }
    return request.method === 'PUT' ? await putObject(env, pool, key, request) : await getObject(env, pool, key, request)
  }
  return refuse(404, 'missing', `The relay has no route ${request.method} ${pathname}.`)
}

export default {
  // A failure of the Pool or of R2, such as the Pool's reset by a new version, answers JSON a machine reads and
  // retries, never Cloudflare's error page.
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env)
    } catch (error) {
      console.error(`${request.method} ${new URL(request.url).pathname} failed: ${String(error)}`)
      return refuse(503, 'unavailable', `The relay failed: ${String(error)}`)
    }
  },
} satisfies ExportedHandler<Env>
