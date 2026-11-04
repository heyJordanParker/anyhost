import { watch } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { changedFiles, checkHolders, journalOf, openCapture, sealQuiet, sessionsOf, startLineOffsets, takeUntold, uploadSession, writeIndex, type Problems } from './capture.ts'
import { personOptions, register, rootsHere, stateFolder, type Device, type Registration } from './device.ts'
import { bucketOf, messageOf, type Store } from './store.ts'
import { codexState, watchedFolders, type Tool } from './transcript.ts'

const BACKUP_MS = 60_000
const REGISTER_MS = 5 * 60_000
const RETRY_MS = 1000

export type Status = {
  readonly device: Device
  readonly bucket: string
  readonly registration: { readonly state: Registration['state'] | 'unregistered'; readonly message: string }
  readonly pending: number
  readonly uploadEvery: number
  readonly capturedAt: string
  readonly problems: readonly string[]
}
type Upload = (session: string, tool: Tool, paths: ReadonlySet<string>) => Promise<Set<string>>

// The upload queue: one per machine, filled on every write the watcher names, and drained every `every` seconds, or on
// every write at 0. A drain uploads each queued session once with everything written since its last upload. One
// upload is in flight per session: writes during it join the next drain, which at 0 starts as soon as it ends. At 0 a
// failed upload tries again after 1 second, then 2, 4 and so on up to a minute, so a line waits out no more of an
// outage than that.
export class UploadQueue {
  private readonly queued = new Map<string, { tool: Tool; paths: Set<string> }>()
  private readonly uploading = new Set<string>()
  private readonly retryMs = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | undefined
  private every: number
  private readonly upload: Upload
  private readonly onFailure: (session: string, error: unknown) => void
  private readonly isReady: () => boolean

  constructor(every: number, upload: Upload, onFailure: (session: string, error: unknown) => void, isReady: () => boolean = () => true) {
    this.every = every
    this.upload = upload
    this.onFailure = onFailure
    this.isReady = isReady
    this.schedule()
  }

  get pending(): number {
    return [...this.queued.values()].reduce((total, { paths }) => total + paths.size, 0)
  }

  get uploadEvery(): number {
    return this.every
  }

  set uploadEvery(seconds: number) {
    if (seconds === this.every) return
    this.every = seconds
    this.schedule()
  }

  add(session: string, tool: Tool, path: string): void {
    const queued = this.queued.get(session) ?? { tool, paths: new Set() }
    this.queued.set(session, queued)
    queued.paths.add(path)
    if (this.every === 0) this.drainSession(session)
  }

  drain(): void {
    for (const session of this.queued.keys()) this.drainSession(session)
  }

  private schedule(): void {
    clearInterval(this.timer)
    this.timer = this.every > 0 ? setInterval(() => this.drain(), this.every * 1000) : undefined
  }

  private drainSession(session: string): void {
    const queued = this.queued.get(session)
    if (queued === undefined || this.uploading.has(session) || !this.isReady()) return
    this.queued.delete(session)
    this.uploading.add(session)
    this.upload(session, queued.tool, queued.paths).then(
      (left) => {
        this.uploading.delete(session)
        this.retryMs.delete(session)
        for (const path of left) this.add(session, queued.tool, path)
        if (this.every === 0) this.drainSession(session)
      },
      (error: unknown) => {
        // the paths wait for the next drain: the retry at 0, the next write, the timer, or the 60-second backup
        this.uploading.delete(session)
        const now = this.queued.get(session) ?? { tool: queued.tool, paths: new Set() }
        this.queued.set(session, { tool: now.tool, paths: new Set([...queued.paths, ...now.paths]) })
        this.onFailure(session, error)
        const wait = this.retryMs.get(session) ?? RETRY_MS
        this.retryMs.set(session, Math.min(2 * wait, BACKUP_MS))
        if (this.every === 0) setTimeout(() => this.drainSession(session), wait)
      },
    )
  }
}

async function filesUnder(folder: string, isRecursive: boolean): Promise<string[]> {
  const entries = await readdir(folder, { recursive: isRecursive, withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
}

export async function serve(store: Store, device: Device): Promise<void> {
  const roots = rootsHere()
  // a session's code that captureCode read after an upload goes up in the session's next drains
  const capture = openCapture(store, device, roots, undefined, undefined, (session, tool, folder) => queue.add(session, tool, `${folder}/`))
  const heartbeat = join(stateFolder(), 'heartbeat')
  const watched = new Set<string>()
  const current = new Map<string, string>()
  let registration: Registration | undefined
  let registeredAt = 0
  let capturedAt = ''
  let lastIndex = ''

  // a problem names what failed, such as `seal <session>` or a file's path, so a timeout says which call it ended
  const problems: Problems = {
    set(key, error) {
      const message = `${new Date().toISOString()} ${key}: ${messageOf(error)}`
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
  const queue = new UploadQueue(
    0,
    async (session, tool, paths) => {
      const left = await uploadSession(capture, session, tool, paths, problems, queue.uploadEvery === 0)
      problems.clear(`upload ${session}`)
      capturedAt = new Date().toISOString()
      return left
    },
    (session, error) => problems.set(`upload ${session}`, error),
    () => registration?.state === 'registered',
  )
  const heard = (path: string): void => {
    if (!watched.has(path) && watchedFolders(roots).some(({ folder }) => folder === path)) void watchFolders()
    // a write to Codex's write-ahead log is a change of its database
    const changed = path.startsWith(codexState(roots)) ? codexState(roots) : path
    void sessionsOf(capture, path).then(
      (owners) => {
        for (const { session, tool } of owners) queue.add(session, tool, changed)
      },
      (error: unknown) => problems.set(path, error),
    )
  }
  // A folder Claude Code makes while the program runs, such as `tasks/` at a session's first task, is watched as soon
  // as its parent's watcher names it, and every file it already holds is new, so each is heard.
  const watchFolders = async (isStart = false): Promise<void> => {
    for (const { folder, isRecursive } of watchedFolders(roots)) {
      if (watched.has(folder) || !(await stat(folder).then((info) => info.isDirectory(), () => false)) || watched.has(folder)) continue
      watched.add(folder)
      watch(folder, { recursive: isRecursive }, (_event, name) => {
        if (name !== null) heard(join(folder, name))
      })
      if (!isStart) for (const path of await filesUnder(folder, isRecursive)) heard(path)
    }
  }
  // The files that changed while the program did not run: stats only, so it reads no unchanged file. A first start
  // has no heartbeat and captures nothing old.
  const catchUp = async (): Promise<void> => {
    const since = await stat(heartbeat).then((found) => found.mtimeMs, () => undefined)
    if (since === undefined) return
    for (const { folder, isRecursive } of watchedFolders(roots)) {
      for (const path of await filesUnder(folder, isRecursive)) {
        if (await stat(path).then((found) => found.mtimeMs > since, () => false)) heard(path)
      }
    }
  }
  const registerHere = (now: number): Promise<void> =>
    settle('registration', async () => {
      registration = await register(store, device, roots, now, registration)
      if (registration.state === 'registered') {
        registeredAt = now
        queue.drain()
      }
    })
  const backup = async (started: number): Promise<void> => {
    if (registration?.state !== 'registered' || started - registeredAt >= REGISTER_MS) await registerHere(started)
    await watchFolders()
    await Bun.write(heartbeat, '')
    await settle('options', async () => {
      const options = await personOptions()
      queue.uploadEvery = options.uploadEvery ?? 0
      // the database counts what one bucket holds, so a new bucket takes a new start, which the service gives the program
      if (bucketOf(options.bucket) === store.bucket) return
      console.error(`${new Date().toISOString()} The bucket is ${bucketOf(options.bucket)} now, not ${store.bucket}, so anyhost exits, and its service starts it again on that bucket.`)
      process.exit(0)
    })
    if (registration?.state !== 'registered') return
    await settle('backup', async () => {
      for (const [session, paths] of await changedFiles(capture)) {
        const tool = capture.db.query<{ tool: Tool }, [string]>('select tool from journals where session = ?').get(session)?.tool ?? 'claude'
        for (const path of paths) queue.add(session, tool, path)
      }
    })
    if (queue.uploadEvery === 0) queue.drain()
    await settle('index', async () => void (lastIndex = await writeIndex(capture, lastIndex)))
    await sealQuiet(capture, problems)
  }
  // What a prompt waits for: this machine's own record of who holds the session, which a takeover's ssh message, the
  // program's start, and each upload keep, so the answer never waits on R2. `untold` names, once, the machine this
  // machine took the session from without reaching it.
  const holderOf = (session: string): { machine?: string; problem?: string; untold?: string } => {
    if (registration?.state === 'cloned') return { problem: registration.message }
    const holder = journalOf(capture.db, session)?.holder ?? ''
    const untold = takeUntold(capture.db, session)
    return { ...(holder === '' ? {} : { machine: holder }), ...(untold === '' ? {} : { untold }) }
  }
  const statusOf = (): Status => ({
    device,
    bucket: store.bucket,
    registration: registration === undefined ? { state: 'unregistered', message: '' } : { state: registration.state, message: 'message' in registration ? registration.message : '' },
    pending: queue.pending,
    uploadEvery: queue.uploadEvery,
    capturedAt,
    problems: [...current.values()],
  })

  await startLineOffsets(capture)
  await settle('holders', () => checkHolders(capture))
  await registerHere(Date.now())
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // Bun cuts a connection after 10 quiet seconds by default, a pending answer included.
    idleTimeout: 0,
    fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname === '/status') return Response.json(statusOf())
      const claim = /^\/claims\/([\w-]+)$/.exec(pathname)?.[1]
      if (claim !== undefined) return Response.json(holderOf(claim))
      return new Response(`anyhost serves /status and /claims/<session>, not ${pathname}.`, { status: 404 })
    },
    error: (error) => new Response(String(error), { status: 500 }),
  })
  console.log(`127.0.0.1:${server.port}`)
  await watchFolders(true)
  await settle('catch-up', catchUp)
  const loop = async (): Promise<void> => {
    const started = Date.now()
    await backup(started).catch((error: unknown) => problems.set('backup', error))
    setTimeout(() => void loop(), Math.max(0, started + BACKUP_MS - Date.now()))
  }
  await loop()
}
