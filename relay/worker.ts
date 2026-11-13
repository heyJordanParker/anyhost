import { Pool, conditionalPut, healthOf, refuse, reply, type Env } from './pool.ts'
import { tokenOf } from './protocol.ts'

export { Pool }

const OBJECTS = '/v1/objects/'

async function putObject(env: Env, pool: DurableObjectStub<Pool>, key: string, request: Request): Promise<Response> {
  if (!request.headers.has('content-length')) return reply(refuse(411, 'length_required', 'A PUT of an object names its Content-Length.'))
  const holder = request.headers.get('x-anyhost-holder') ?? undefined
  using authorized = await pool.authorize(tokenOf(request.headers.get('authorization')), request.headers.get('x-anyhost-version'), holder)
  if ('refused' in authorized) return reply(authorized.refused)
  const written = await conditionalPut(env.BUCKET, key, request.body, request.headers)
  if ('stored' in written) return Response.json({ etag: written.stored.etag })
  return reply(refuse(412, 'precondition', `${key} failed the request's If-Match or If-None-Match.`, written.etag === undefined ? {} : { etag: written.etag }))
}

async function getObject(env: Env, pool: DurableObjectStub<Pool>, key: string, request: Request): Promise<Response> {
  using authorized = await pool.authorize(tokenOf(request.headers.get('authorization')), request.headers.get('x-anyhost-version'))
  if ('refused' in authorized) return reply(authorized.refused)
  const object = await env.BUCKET.get(key, { range: request.headers }).catch((error: unknown) => {
    if (error instanceof Error && error.message.endsWith('(10039)')) return undefined
    throw error
  })
  if (object === undefined) return reply(refuse(416, 'invalid', `${key} has no bytes in ${request.headers.get('range')}.`))
  if (object === null) return reply(refuse(404, 'missing', `No object ${key} is in the bucket.`))
  const headers = new Headers({ 'content-type': 'application/octet-stream', etag: object.httpEtag, 'last-modified': object.uploaded.toUTCString(), 'accept-ranges': 'bytes' })
  const { offset, end } = servedOf(object.range, object.size)
  if (offset === 0 && end === object.size) return new Response(object.body, { headers })
  headers.set('content-range', `bytes ${offset}-${end - 1}/${object.size}`)
  return new Response(object.body, { status: 206, headers })
}

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
    return reply(await pool.join(body, env.SETUP_CODE_SHA256))
  }
  if (pathname === '/v1/connect' && request.method === 'GET') {
    if (request.headers.get('upgrade') !== 'websocket') return reply(refuse(426, 'invalid', '/v1/connect opens a WebSocket.'))
    return await pool.fetch(request)
  }
  if (pathname.startsWith(OBJECTS) && pathname.length > OBJECTS.length && (request.method === 'PUT' || request.method === 'GET')) {
    let key: string
    try {
      key = decodeURIComponent(pathname.slice(OBJECTS.length))
    } catch {
      return reply(refuse(400, 'invalid', `${pathname} names no key the relay can decode.`))
    }
    return request.method === 'PUT' ? await putObject(env, pool, key, request) : await getObject(env, pool, key, request)
  }
  return reply(refuse(404, 'missing', `The relay has no route ${request.method} ${pathname}.`))
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env)
    } catch (error) {
      console.error(`${request.method} ${new URL(request.url).pathname} failed: ${String(error)}`)
      return reply(refuse(503, 'unavailable', `The relay failed: ${String(error)}`))
    }
  },
} satisfies ExportedHandler<Env>
