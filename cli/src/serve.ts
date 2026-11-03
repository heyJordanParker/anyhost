import { Glob } from 'bun'
import { watch } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { captureFiles, mergeQuiet, openDatabase, writeIndex, type Capture } from './capture.ts'
import { claimOf } from './claims.ts'
import { ClonedDevice, devicesOf, register, type Device, type DeviceRecord } from './device.ts'
import type { Store } from './store.ts'
import { roots, type Root } from './transcript.ts'

const UPLOAD_MS = 30_000
const BACKLOG_MS = 20_000
const REGISTER_MS = 5 * 60_000
const UPLOADS_AT_ONCE = 4
const BACKLOG_UPLOADS_AT_ONCE = 2

export type Status = {
  readonly device: Device
  readonly isRegistered: boolean
  readonly pending: number
  readonly backlog: number
  readonly capturedAt: string
  readonly lastError: string
}

async function changedFiles(root: Root, offsets: (path: string) => number): Promise<string[]> {
  const found: { path: string; at: number }[] = []
  for await (const name of new Glob('**/*.jsonl').scan({ cwd: root.folder, onlyFiles: true })) {
    const path = join(root.folder, name)
    const info = await stat(path).catch(() => undefined)
    if (info !== undefined && info.size > offsets(path)) found.push({ path, at: info.mtimeMs })
  }
  return found.sort((a, b) => b.at - a.at).map(({ path }) => path)
}

export async function serve(store: Store, device: Device): Promise<void> {
  const capture: Capture = { store, db: openDatabase(), device }
  const pending = new Map<string, Root>()
  let backlog = new Map<string, Root>()
  const watched = new Set<string>()
  let names = new Map<string, DeviceRecord>()
  let isRegistered = false
  let registeredAt = 0
  let capturedAt = ''
  let lastError = ''
  let lastIndex = ''

  const fail = (error: unknown): void => {
    lastError = `${new Date().toISOString()} ${String(error)}`
    console.error(lastError)
  }
  const registerHere = async (): Promise<void> => {
    try {
      await register(store, device)
      isRegistered = true
      registeredAt = Date.now()
    } catch (error) {
      if (error instanceof ClonedDevice) throw error
      fail(error)
    }
  }
  const offsetOf = (path: string): number => capture.db.query<{ offset: number }, [string]>('select offset from files where path = ?').get(path)?.offset ?? -1
  const watchRoots = async (): Promise<void> => {
    for (const root of roots()) {
      if (watched.has(root.folder) || !(await stat(root.folder).then((info) => info.isDirectory(), () => false))) continue
      watched.add(root.folder)
      watch(root.folder, { recursive: true }, (_event, name) => {
        if (name?.endsWith('.jsonl') === true) pending.set(join(root.folder, name), root)
      })
      for (const path of await changedFiles(root, offsetOf)) backlog.set(path, root)
    }
  }
  const publishIndex = async (): Promise<void> => {
    lastIndex = await writeIndex(capture, lastIndex).catch((error: unknown) => {
      fail(error)
      return lastIndex
    })
  }
  const tick = async (started: number): Promise<void> => {
    if (!isRegistered || started - registeredAt >= REGISTER_MS) await registerHere()
    if (!isRegistered) return
    await watchRoots()
    const live = new Map(pending)
    pending.clear()
    const again = await captureFiles(capture, live, fail, { parallel: UPLOADS_AT_ONCE }).catch((error: unknown) => {
      fail(error)
      return live
    })
    for (const [path, root] of again) pending.set(path, root)
    await publishIndex()
    if (backlog.size > 0) {
      const left = backlog
      backlog = await captureFiles(capture, left, fail, { parallel: BACKLOG_UPLOADS_AT_ONCE, until: started + BACKLOG_MS }).catch((error: unknown) => {
        fail(error)
        return left
      })
    }
    capturedAt = new Date().toISOString()
    await mergeQuiet(capture).catch(fail)
  }
  const holderOf = async (session: string): Promise<{ machine?: string }> => {
    const held = await claimOf(store, session)
    if (held === undefined || held.claim.device === device.id) return {}
    if (!names.has(held.claim.device)) names = await devicesOf(store)
    return { machine: names.get(held.claim.device)?.name ?? held.claim.device }
  }

  await registerHere()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname === '/status') return Response.json({ device, isRegistered, pending: pending.size, backlog: backlog.size, capturedAt, lastError } satisfies Status)
      const claim = /^\/claims\/([\w-]+)$/.exec(pathname)?.[1]
      if (claim !== undefined) return Response.json(await holderOf(claim))
      return new Response(`anyhost serves /status and /claims/<session>, not ${pathname}.`, { status: 404 })
    },
    error: (error) => new Response(String(error), { status: 500 }),
  })
  console.log(`127.0.0.1:${server.port}`)
  const loop = async (): Promise<void> => {
    const started = Date.now()
    try {
      await tick(started)
    } catch (error) {
      if (error instanceof ClonedDevice) {
        console.error(error.message)
        process.exit(1)
      }
      fail(error)
    }
    setTimeout(() => void loop(), Math.max(0, started + UPLOAD_MS - Date.now()))
  }
  await loop()
}
