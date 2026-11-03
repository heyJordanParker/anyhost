import { watch } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { captureFiles, mergeQuiet, openDatabase, writeIndex, type Capture, type Problems } from './capture.ts'
import { claimOf } from './claims.ts'
import { devicesOf, register, type Device, type DeviceRecord, type Registration } from './device.ts'
import { messageOf, type Store } from './store.ts'
import { roots, type Root } from './transcript.ts'

const UPLOAD_MS = 30_000
const REGISTER_MS = 5 * 60_000
const UPLOADS_AT_ONCE = 4

export type Status = {
  readonly device: Device
  readonly registration: { readonly state: Registration['state'] | 'unregistered'; readonly message: string }
  readonly pending: number
  readonly capturedAt: string
  readonly problems: readonly string[]
}

export async function serve(store: Store, device: Device): Promise<void> {
  const capture: Capture = { store, db: openDatabase(), device }
  const pending = new Map<string, Root>()
  const watched = new Set<string>()
  const current = new Map<string, string>()
  let names = new Map<string, DeviceRecord>()
  let registration: Registration | undefined
  let registeredAt = 0
  let capturedAt = ''
  let lastIndex = ''

  const problems: Problems = {
    set(key, error) {
      const message = `${new Date().toISOString()} ${messageOf(error)}`
      current.set(key, message)
      console.error(message)
    },
    clear: (key) => void current.delete(key),
  }
  const settle = async (key: string, work: () => Promise<unknown>): Promise<void> => {
    try {
      await work()
      problems.clear(key)
    } catch (error) {
      problems.set(key, error)
    }
  }
  const registerHere = (now: number): Promise<void> =>
    settle('registration', async () => {
      registration = await register(store, device, now, registration)
      if (registration.state === 'registered') registeredAt = now
    })
  const watchRoots = async (): Promise<void> => {
    for (const root of roots()) {
      if (watched.has(root.folder) || !(await stat(root.folder).then((info) => info.isDirectory(), () => false))) continue
      watched.add(root.folder)
      watch(root.folder, { recursive: true }, (_event, name) => {
        if (name?.endsWith('.jsonl') === true) pending.set(join(root.folder, name), root)
      })
    }
  }
  const tick = async (started: number): Promise<void> => {
    if (registration?.state !== 'registered' || started - registeredAt >= REGISTER_MS) await registerHere(started)
    await watchRoots()
    if (registration?.state !== 'registered') return
    const live = new Map(pending)
    pending.clear()
    await settle('capture', async () => {
      const again = await captureFiles(capture, live, problems, UPLOADS_AT_ONCE).catch((error: unknown) => {
        for (const [path, root] of live) pending.set(path, root)
        throw error
      })
      for (const [path, root] of again) pending.set(path, root)
    })
    await settle('index', async () => void (lastIndex = await writeIndex(capture, lastIndex)))
    capturedAt = new Date().toISOString()
    await settle('merge', () => mergeQuiet(capture))
  }
  const holderOf = async (session: string): Promise<{ machine?: string; problem?: string }> => {
    if (registration?.state === 'cloned') return { problem: registration.message }
    const held = await claimOf(store, session)
    if (held === undefined || held.claim.device === device.id) return {}
    if (!names.has(held.claim.device)) names = await devicesOf(store)
    return { machine: names.get(held.claim.device)?.name ?? held.claim.device }
  }
  const statusOf = (): Status => ({
    device,
    registration: registration === undefined ? { state: 'unregistered', message: '' } : { state: registration.state, message: 'message' in registration ? registration.message : '' },
    pending: pending.size,
    capturedAt,
    problems: [...current.values()],
  })

  await registerHere(Date.now())
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname === '/status') return Response.json(statusOf())
      const claim = /^\/claims\/([\w-]+)$/.exec(pathname)?.[1]
      if (claim !== undefined) return Response.json(await holderOf(claim))
      return new Response(`anyhost serves /status and /claims/<session>, not ${pathname}.`, { status: 404 })
    },
    error: (error) => new Response(String(error), { status: 500 }),
  })
  console.log(`127.0.0.1:${server.port}`)
  const loop = async (): Promise<void> => {
    const started = Date.now()
    await tick(started).catch((error: unknown) => problems.set('pass', error))
    setTimeout(() => void loop(), Math.max(0, started + UPLOAD_MS - Date.now()))
  }
  await loop()
}
