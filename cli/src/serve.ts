import { watch } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { changedFiles, countedBucket, journalOf, openCapture, openDatabase, sealQuiet, sessionsOf, startLineOffsets, takeUntold, uploadSessions, writeIndex, type Problems } from './capture.ts'
import { connectForStep, join as joinRelay, joinWithOption, updateRelay, type ConnectRun, type Connecting, type RelayNames } from './connect.ts'
import { inviteMachine, machinesOf, personOptions, relayLogin, removeMachine, rootsHere, stateFolder, type Device } from './device.ts'
import { connectRelay, type RelayState } from './relay.ts'
import { codexState, watchedFolders, type Tool } from './transcript.ts'

const BACKUP_MS = 60_000
const RETRY_MS = 1000

// The option `uploadEvery`, which `cmod options` leaves out until the person sets it. Replayed from a Mac's 30 days of
// transcripts, 5 seconds takes 411,952 uploads, inside R2's free 1,000,000 writes a month, where every write takes
// 1,258,076. A person's 0 stays 0.
export const uploadEveryOf = (chosen: number | undefined): number => chosen ?? 5

export type Status = {
  readonly device: Device
  // `message` says why the program uploads nothing, empty while it connects or is connected
  readonly relay: { readonly url: string; readonly state: RelayState['is']; readonly message: string; readonly bucket: string }
  readonly pending: number
  readonly uploadEvery: number
  readonly capturedAt: string
  readonly problems: readonly string[]
  // the Connect Cloudflare the mod's Step started, while the program runs
  readonly connecting?: Connecting
}
type Queued = { readonly tool: Tool; readonly paths: ReadonlySet<string> }
type Upload = (sessions: ReadonlyMap<string, Queued>) => ReadonlyMap<string, Promise<Set<string>>>

// The upload queue: one per machine, filled on every write the watcher names, and drained every `every` seconds, or on
// every write at 0. A drain uploads every queued session once, in one upload, with everything written since its last
// upload. One upload is in flight per session: writes during it join the next drain, which at 0 starts as soon as it
// ends. At 0 a failed upload tries again after 1 second, then 2, 4 and so on up to a minute, so a line waits out no
// more of an outage than that.
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
    if (this.every === 0) this.drainSessions([session])
  }

  drain(): void {
    this.drainSessions([...this.queued.keys()])
  }

  private schedule(): void {
    clearInterval(this.timer)
    this.timer = this.every > 0 ? setInterval(() => this.drain(), this.every * 1000) : undefined
  }

  private drainSessions(sessions: readonly string[]): void {
    if (!this.isReady()) return
    const drained = new Map<string, { tool: Tool; paths: Set<string> }>()
    for (const session of sessions) {
      const queued = this.queued.get(session)
      if (queued === undefined || this.uploading.has(session)) continue
      this.queued.delete(session)
      this.uploading.add(session)
      drained.set(session, queued)
    }
    if (drained.size === 0) return
    const uploads = this.upload(drained)
    for (const [session, queued] of drained) {
      ;(uploads.get(session) ?? Promise.reject(new Error(`The drain uploaded nothing of the session ${session}.`))).then(
        (left) => {
          this.uploading.delete(session)
          this.retryMs.delete(session)
          for (const path of left) this.add(session, queued.tool, path)
          if (this.every === 0) this.drainSessions([session])
        },
        (error: unknown) => {
          // the paths wait for the next drain: the retry at 0, the next write, the timer, or the 60-second backup
          this.uploading.delete(session)
          const now = this.queued.get(session) ?? { tool: queued.tool, paths: new Set() }
          this.queued.set(session, { tool: now.tool, paths: new Set([...queued.paths, ...now.paths]) })
          this.onFailure(session, error)
          const wait = this.retryMs.get(session) ?? RETRY_MS
          this.retryMs.set(session, Math.min(2 * wait, BACKUP_MS))
          if (this.every === 0) setTimeout(() => this.drainSessions([session]), wait)
        },
      )
    }
  }
}

async function filesUnder(folder: string, isRecursive: boolean): Promise<string[]> {
  const entries = await readdir(folder, { recursive: isRecursive, withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
}

// `names` is the relay Connect Cloudflare deploys and keeps current, the Worker and bucket anyhost unless a test names
// its own.
export async function serve(device: Device, names?: RelayNames): Promise<void> {
  const roots = rootsHere()
  const relay = connectRelay({ login: relayLogin, device, roots, isPatient: true })
  const db = openDatabase()
  const counted = countedBucket(db)
  // a session's code that captureCode read after an upload goes up in the session's next drains
  const capture = openCapture(relay, device, roots, db, undefined, (session, tool, folder) => queue.add(session, tool, `${folder}/`))
  const heartbeat = join(stateFolder(), 'heartbeat')
  const watched = new Set<string>()
  const current = new Map<string, string>()
  let capturedAt = ''
  let lastIndex = ''

  // a problem names what failed, such as `seal <session>` or a file's path, so a timeout says which call it ended
  const problems: Problems = {
    set(key, error) {
      const message = `${new Date().toISOString()} ${key}: ${error instanceof AggregateError ? error.errors.map(String).join(', ') : String(error)}`
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
    uploadEveryOf(undefined),
    (sessions) =>
      new Map(
        [...uploadSessions(capture, sessions, problems, queue.uploadEvery === 0)].map(([session, upload]) => [
          session,
          upload.then((left) => {
            problems.clear(`upload ${session}`)
            capturedAt = new Date().toISOString()
            return left
          }),
        ]),
      ),
    (session, error) => problems.set(`upload ${session}`, error),
    () => relay.state.is === 'connected',
  )
  // The welcome's sessions another machine took are in the database by now, so the queue drains what waited for the
  // relay. The database counts what one bucket holds, so a relay of another bucket takes a new start, which the
  // service gives the program.
  relay.on('welcome', ({ bucket }) => {
    if (counted !== undefined && bucket !== counted) {
      console.error(`${new Date().toISOString()} The relay keeps sessions in ${bucket} now, not ${counted}, so anyhost exits, and its service starts it again on that bucket.`)
      process.exit(0)
    }
    queue.drain()
  })
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
  // A join here takes effect at once: the relay connects with the new login, and the problems it solves leave.
  const joined = (): void => {
    problems.clear('join')
    problems.clear('relay update')
    relay.reconnect()
  }
  let connecting: ConnectRun | undefined
  // A relay older than this program is updated once a run, with this machine's cf login, which only a person may
  // refresh. Without a usable login the mod's Step shows Connect Cloudflare.
  let isUpdateTried = false
  const keepRelayCurrent = async (): Promise<void> => {
    if (relay.state.is !== 'outdated' || isUpdateTried) return
    isUpdateTried = true
    await settle('relay update', async () => {
      await updateRelay(names)
      relay.reconnect()
    })
  }
  const backup = async (): Promise<void> => {
    await watchFolders()
    await Bun.write(heartbeat, '')
    await settle('options', async () => {
      const { uploadEvery, join: link } = await personOptions()
      queue.uploadEvery = uploadEveryOf(uploadEvery)
      if (link === undefined || link === '') return
      await settle('join', async () => {
        await joinWithOption(link)
        joined()
      })
    })
    await keepRelayCurrent()
    if (relay.state.is !== 'connected') return
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
  // What a prompt waits for: this machine's own record of who holds the session, which the relay's `released` and each
  // upload keep, so the answer never waits on the relay. `untold` names, once, the machine this machine took the
  // session from while that machine had no connection to the relay.
  const holderOf = (session: string): { machine?: string; problem?: string; untold?: string } => {
    const { state } = relay
    if (state.is === 'refused' || state.is === 'removed' || state.is === 'outdated') return { problem: state.message }
    const holder = journalOf(capture.db, session)?.holder ?? ''
    const untold = takeUntold(capture.db, session)
    return { ...(holder === '' ? {} : { machine: holder }), ...(untold === '' ? {} : { untold }) }
  }
  const statusOf = (): Status => {
    const { state, url } = relay
    return {
      device,
      relay: { url, state: state.is, message: 'message' in state ? state.message : '', bucket: state.is === 'connected' ? state.welcome.bucket : (countedBucket(capture.db) ?? '') },
      pending: queue.pending,
      uploadEvery: queue.uploadEvery,
      capturedAt,
      problems: [...current.values()],
      ...(connecting === undefined ? {} : { connecting: connecting.view }),
    }
  }
  const failed = (status: number, error: unknown): Response => Response.json({ message: error instanceof Error ? error.message : String(error) }, { status })
  // The relay's answer to the mod's /machines, or at once why the relay gives none.
  const throughRelay = async (work: () => Promise<unknown>): Promise<Response> => {
    const { state } = relay
    if (state.is !== 'connected') return failed(503, 'message' in state ? state.message : `anyhost connects to the relay at ${relay.url}.`)
    return Response.json((await work()) ?? {})
  }
  const connectRun = (): ConnectRun => {
    if (connecting === undefined) throw new Error('No Connect Cloudflare runs on this machine.')
    return connecting
  }
  // What the mod's Step and /machines send, as JSON, which a web page cannot send to this address unasked.
  const act = async (pathname: string, { id = '', link = '' }: { readonly id?: string; readonly link?: string }): Promise<Response> => {
    switch (pathname) {
      case '/connect': {
        if (connecting?.view.is === 'running') return Response.json(connecting.view)
        const started = connectForStep(names)
        connecting = started
        void started.done.then(() => {
          if (started.view.is === 'joined') joined()
        })
        return Response.json(started.view)
      }
      case '/connect/account':
        connectRun().pickAccount(id)
        return Response.json(connectRun().view)
      case '/connect/r2':
        connectRun().turnedOnR2()
        return Response.json(connectRun().view)
      case '/join': {
        const url = await joinRelay(link)
        joined()
        return Response.json({ url })
      }
      case '/machines/invite':
        return await throughRelay(() => inviteMachine(relay))
      case '/machines/remove':
        if (id === device.id) return failed(400, `${device.name} is this machine. Remove it from another machine's /machines.`)
        return await throughRelay(() => removeMachine(relay, id))
      default:
        return new Response(`anyhost takes no ${pathname}.`, { status: 404 })
    }
  }

  await startLineOffsets(capture)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // Bun cuts a connection after 10 quiet seconds by default, a pending answer included.
    idleTimeout: 0,
    // A web page whose name resolves to this address names its own host, as cmod's web app checks too.
    async fetch(request, { port }) {
      if (request.headers.get('host') !== `127.0.0.1:${port}`) return failed(403, `anyhost answers 127.0.0.1:${port} alone.`)
      const { pathname } = new URL(request.url)
      if (request.method === 'GET' && pathname === '/status') return Response.json(statusOf())
      if (request.method === 'GET' && pathname === '/machines') return await throughRelay(async () => ({ here: device.id, machines: await machinesOf(relay) }))
      const claim = /^\/claims\/([\w-]+)$/.exec(pathname)?.[1]
      if (request.method === 'GET' && claim !== undefined) return Response.json(holderOf(claim))
      if (request.method !== 'POST' || request.headers.get('content-type') !== 'application/json') return failed(404, `anyhost serves GET /status, /claims/<session> and /machines, and takes JSON at POST /connect, /join and /machines, not ${request.method} ${pathname}.`)
      return await act(pathname, (await request.json()) as { id?: string; link?: string })
    },
    error: (error) => failed(500, error),
  })
  console.log(`127.0.0.1:${server.port}`)
  await watchFolders(true)
  await settle('catch-up', catchUp)
  const loop = async (): Promise<void> => {
    const started = Date.now()
    await backup().catch((error: unknown) => problems.set('backup', error))
    setTimeout(() => void loop(), Math.max(0, started + BACKUP_MS - Date.now()))
  }
  await loop()
}
