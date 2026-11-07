// The relay's Worker: the HTTP routes under /v1. It streams each object over 1 MiB straight between the machine and
// R2, and hands everything else to the Pool, the one Durable Object of the person's machines.
import { Pool, conditionalPut, healthOf, type Env, type Reply } from './pool.ts'
import { tokenOf, type ErrorCode, type Refusal } from './protocol.ts'

export { Pool }

const OBJECTS = '/v1/objects/'

const reply = ({ status, body }: Reply): Response => Response.json(body, { status })
const refuse = (status: number, error: ErrorCode, message: string): Response => reply({ status, body: { error, message } satisfies Refusal })

// Streams the request's body into R2, which reads its If-Match and If-None-Match as the binding's `onlyIf`. A journal
// frame names its session in X-Anyhost-Holder: the Pool refuses it once another machine holds the session, and a
// takeover waits until the write ends.
async function putObject(env: Env, pool: DurableObjectStub<Pool>, key: string, request: Request): Promise<Response> {
  // the R2 binding refuses a stream of unknown length
  if (!request.headers.has('content-length')) return refuse(411, 'length_required', 'A PUT of an object names its Content-Length.')
  const holder = request.headers.get('x-anyhost-holder') ?? undefined
  using authorized = await pool.authorize(tokenOf(request.headers.get('authorization')), holder)
  if ('refused' in authorized) return reply(authorized.refused)
  const written = await conditionalPut(env.BUCKET, key, request.body, request.headers)
  if ('stored' in written) return Response.json({ etag: written.stored.etag, size: written.stored.size })
  return Response.json({ error: 'precondition', message: `${key} failed the request's If-Match or If-None-Match.`, ...(written.etag === undefined ? {} : { etag: written.etag }) }, { status: 412 })
}

// Streams an object from R2, or the part its Range names, which R2 reads from the request's headers, so a broken
// download resumes. R2 serves the whole object for a range it does not serve, as one of several ranges, and refuses a
// range past the object's end with its error 10039, "Requested byte range is not satisfiable" (r2/api/error-codes),
// which names its code at the end of the message. Every other error of R2 answers 503, which the program tries again.
async function getObject(env: Env, pool: DurableObjectStub<Pool>, key: string, request: Request): Promise<Response> {
  using authorized = await pool.authorize(tokenOf(request.headers.get('authorization')))
  if ('refused' in authorized) return reply(authorized.refused)
  const object = await env.BUCKET.get(key, { range: request.headers }).catch((error: unknown) => {
    if (error instanceof Error && error.message.endsWith('(10039)')) return undefined
    throw error
  })
  if (object === undefined) return refuse(416, 'invalid', `${key} has no bytes in ${request.headers.get('range')}.`)
  if (object === null) return refuse(404, 'missing', `No object ${key} is in the bucket.`)
  // an object without a type is text to Cloudflare, which compresses it and drops its Content-Length
  const headers = new Headers({ 'content-type': 'application/octet-stream', etag: object.httpEtag, 'last-modified': object.uploaded.toUTCString(), 'accept-ranges': 'bytes' })
  const { offset, end } = servedOf(object.range, object.size)
  if (offset === 0 && end === object.size) return new Response(object.body, { headers })
  headers.set('content-range', `bytes ${offset}-${end - 1}/${object.size}`)
  return new Response(object.body, { status: 206, headers })
}

// The bytes R2 served of an object of `size` bytes, as its `range` names them: from an offset, up to a length, or the
// last `suffix` bytes. workerd names all three on every range it serves, `suffix` with no value, which R2Range's
// types, one kind of range each, do not allow.
function servedOf(range: R2Range | undefined, size: number): { readonly offset: number; readonly end: number } {
  const { offset = 0, length, suffix } = (range ?? {}) as { readonly offset?: number; readonly length?: number; readonly suffix?: number }
  if (suffix !== undefined) return { offset: Math.max(0, size - suffix), end: size }
  return { offset, end: length === undefined ? size : Math.min(size, offset + length) }
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
