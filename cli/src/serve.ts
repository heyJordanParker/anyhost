import type { ServerWebSocket } from 'bun'
import { rmSync, watch } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeStream, streamOf, type Routed } from '../../relay/protocol.ts'
import { attachTerminal, personEnvironment, runningSessions, startInBackground, type AttachedTerminal } from './background.ts'
import { changedFiles, countedBucket, journalOf, openCapture, openDatabase, sealQuiet, sessionsOf, startLineOffsets, takeUntold, uploadSessions, writeIndex, type Problems } from './capture.ts'
import { claimsOf } from './claims.ts'
import { connectForStep, join as joinRelay, joinWithOption, updateRelay, type ConnectRun, type Connecting, type RelayNames } from './connect.ts'
import { inviteMachine, machinesOf, personOptions, relayLogin, removeMachine, rootsHere, stateFolder, type Device } from './device.ts'
import { connectRelay, type RelayState } from './relay.ts'
import { openStream, type Link, type SessionState, type Size, type Stream } from './stream.ts'
import { codexState, watchedFolders, type Tool } from './transcript.ts'

const BACKUP_MS = 60_000
const RETRY_MS = 1000
// The relay carries a terminal's output at most once per OUTPUT_MS, so a full-screen redraw is one message, not
// hundreds (relay-spec "Control messages").
const OUTPUT_MS = 20
// A viewer whose link is gone keeps its place for the longest wait between its tries to attach again.
const LINGER_MS = 60_000
// Claude Code rewrites a running session's record in `sessions/` under its folder at each change of its status, once
// each, so the status of the sessions shown is read again STATE_MS after the folder changed. A read every 2 seconds
// took a quarter of a core: one `claude agents --json` took 1.15 s of CPU on a test machine running one session.
const STATE_MS = 200
// A new viewer of a session already shown gets a redraw: the terminal a row shorter until Claude Code clears the screen
// to paint it at that size, then back. On a test machine Claude Code set only its modes again when the size came back
// within 50 ms, and 1 of 7 redraws with the size back after 300 ms painted nothing, so the size comes back once the
// screen was cleared, or after REDRAW_MS when it never is.
const REDRAW_MS = 2000
const CLEAR = '\x1b[2J'
// A `claude attach` that ends QUICK_ENDS times in a row within QUICK_END_MS of its start fails at its start, and the
// host stops starting it again. A person who presses `←` and leaves the agents view takes longer than that.
const QUICK_END_MS = 2000
const QUICK_ENDS = 3
// A running program answers /status in milliseconds over its socket.
const RUNNING_MS = 2000
// A redraw repaints the screen and sets every terminal mode again but the alternate screen.
const ALTERNATE_SCREEN = '\x1b[?1049h'
const MAIN_SCREEN = '\x1b[?1049l'

// The address the mod and every command of this machine reach the service at.
export const serveSocket = (): string => join(stateFolder(), 'serve.sock')

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
  // why Claude Code starts with the program's own environment, not the person's shell's, until the program restarts
  readonly shell?: string
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
  // Two programs on one state folder would both write its database and its journals, so a second one refuses to start.
  // It replaces only a socket file nothing answers on, as a stopped program leaves.
  const socket = serveSocket()
  const running = await fetch('http://localhost/status', { unix: socket, signal: AbortSignal.timeout(RUNNING_MS) }).then(
    async (answer) => (await answer.json()) as Status,
    () => undefined,
  )
  if (running !== undefined) throw new Error(`The anyhost program of ${running.device.name} already answers at ${socket}, so this one does not start. Two programs on one state folder would both write its database.`)
  const roots = rootsHere()
  const relay = connectRelay({ login: relayLogin, device, roots, isPatient: true })
  const db = openDatabase()
  const counted = countedBucket(db)
  // a session's code that captureCode read after an upload goes up in the session's next drains
  const capture = openCapture(relay, device, roots, db, undefined, (session, tool, folder) => queue.add(session, tool, `${folder}/`))
  const heartbeat = join(stateFolder(), 'heartbeat')
  const watched = new Set<string>()
  const current = new Map<string, string>()
  let shell: string | undefined
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
      ...(shell === undefined ? {} : { shell }),
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
  // What the mod's Step and /machines send, as JSON.
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

  // The sessions this machine shows to viewers, on other machines and on this one: one `claude attach` per session, at
  // the smallest size of the viewers linked now, as tmux's `window-size smallest`, so every viewer draws it whole, and
  // its output goes to every viewer's stream. A second `claude attach` would draw the session at its own size and break
  // the other viewers' screens (worker-spec W9). A viewer whose link is gone keeps its stream for LINGER_MS, so its next
  // attach with the same stream goes on where both sides' bytes reached, and one forgotten attaches as a new viewer.
  // `carrier` reaches the viewer: through the relay, or the WebSocket of an `anyhost attach` on this machine.
  type Carrier = { readonly attached: () => void; readonly link: Link; readonly isRelay: boolean }
  type Viewer = { readonly session: string; readonly stream: Stream; size: Size; isLinked: boolean; carrier: Carrier; forget?: ReturnType<typeof setTimeout> }
  // `cleared` runs at the next screen Claude Code clears, while a redraw waits for it
  type Shown = { terminal: AttachedTerminal; size: Size; isAlternateScreen: boolean; state: SessionState; cleared?: (() => void) | undefined }
  const viewers = new Map<number, Viewer>()
  const shown = new Map<string, Promise<Shown>>()
  const viewersOf = (session: string): Viewer[] => [...viewers.values()].filter((viewer) => viewer.session === session)
  const throughRelayTo = (stream: number): Carrier => ({
    attached: () => void relay.send({ t: 'attached', stream, port: 0, addresses: [] }),
    link: { send: (frame) => void relay.send(encodeStream(stream, frame)) },
    isRelay: true,
  })
  // the environment Claude Code starts with, the person's own, read once at the program's start
  const environment = personEnvironment().then(({ environment: found, problem }) => {
    shell = problem
    return found
  })
  const fit = (session: string, view: Shown): boolean => {
    const sizes = viewersOf(session).filter(({ isLinked }) => isLinked).map(({ size }) => size)
    if (sizes.length === 0) return false
    const size = { cols: Math.min(...sizes.map(({ cols }) => cols)), rows: Math.min(...sizes.map(({ rows }) => rows)) }
    if (size.cols === view.size.cols && size.rows === view.size.rows) return false
    view.size = size
    view.terminal.resize(size.cols, size.rows)
    return true
  }
  const fitShown = (session: string): void => void shown.get(session)?.then((view) => fit(session, view), () => undefined)
  // Claude Code clears and paints the whole screen at a new size, so a row less and back redraws it for every viewer.
  // A redraw that runs already serves the next viewer too.
  const redraw = (view: Shown): void => {
    if (view.cleared !== undefined) return
    const back = (): void => {
      clearTimeout(waited)
      view.cleared = undefined
      view.terminal.resize(view.size.cols, view.size.rows)
    }
    const waited = setTimeout(back, REDRAW_MS)
    view.cleared = back
    view.terminal.resize(view.size.cols, view.size.rows - 1)
  }
  // The id `claude attach` takes for a session this machine holds, and the folder it runs in, started in Claude Code's
  // background when it does not run, in the folder this machine knows it in.
  const runHere = async (session: string): Promise<{ readonly id: string; readonly cwd: string }> => {
    const holder = journalOf(capture.db, session)?.holder ?? ''
    if (holder !== '') throw new Error(`The session ${session} continues on ${holder}.`)
    const running = (await runningSessions()).find((entry) => entry.sessionId === session)
    if (running?.kind === 'interactive') throw new Error(`${device.name} runs the session ${session} in a terminal of its own, so only that terminal shows it.`)
    if (running?.id !== undefined) return { id: running.id, cwd: running.cwd }
    const cwd = capture.db.query<{ cwd: string }, [string]>('select cwd from sessions where id = ?').get(session)?.cwd ?? ''
    if (cwd === '') throw new Error(`${device.name} knows no folder of the session ${session}, so it cannot start it.`)
    return { id: await startInBackground(session, cwd, await environment), cwd }
  }
  const startShowing = (session: string, size: Size): Promise<Shown> => {
    let pending: Uint8Array[] = []
    let flush: ReturnType<typeof setTimeout> | undefined
    let tail = ''
    let quickEnds = 0
    const isCurrent = (): boolean => shown.get(session) === view
    const send = (): void => {
      clearTimeout(flush)
      flush = undefined
      const bytes = Buffer.concat(pending)
      pending = []
      if (bytes.length === 0 || !isCurrent()) return
      void view.then((current) => {
        const seen = tail + bytes.toString('latin1')
        const [on, off] = [seen.lastIndexOf(ALTERNATE_SCREEN), seen.lastIndexOf(MAIN_SCREEN)]
        if (on !== off) current.isAlternateScreen = on > off
        tail = seen.slice(1 - ALTERNATE_SCREEN.length)
        for (const viewer of viewersOf(session)) viewer.stream.write('output', bytes)
        if (seen.includes(CLEAR)) current.cleared?.()
      })
    }
    // in the session's folder, where Claude Code's agents view, which `←` opens in it, has the folder's trust
    const open = (id: string, cwd: string, env: Record<string, string>, at: Size): AttachedTerminal => {
      const started = Date.now()
      const terminal = attachTerminal(id, cwd, env, at, (bytes) => {
        pending.push(bytes)
        flush ??= setTimeout(send, OUTPUT_MS)
      })
      void terminal.exited.then(() => ended(started))
      return terminal
    }
    // `claude attach` ends when a viewer leaves Claude Code's agents view, which `←` opens, or when the session ends.
    // While the session runs, this program starts a new one, which paints the whole screen for every viewer, so no
    // viewer's keys end the others'.
    const ended = async (started: number): Promise<void> => {
      send()
      if (!isCurrent()) return
      const current = await view
      const running = (await runningSessions().catch(() => [])).find((entry) => entry.sessionId === session && entry.id !== undefined)
      if (!isCurrent()) return
      quickEnds = Date.now() - started < QUICK_END_MS ? quickEnds + 1 : 0
      if (running?.id !== undefined && quickEnds < QUICK_ENDS) {
        console.error(`${new Date().toISOString()} claude attach ${running.id} ended while ${session} runs, so anyhost starts it again for its viewers.`)
        Object.assign(current, { isAlternateScreen: false, terminal: open(running.id, running.cwd, await environment, current.size) })
        tail = ''
        return
      }
      shown.delete(session)
      const message = running === undefined ? '' : `claude attach ${running.id} ended ${QUICK_ENDS} times within ${QUICK_END_MS / 1000} s of its start, so ${device.name} stops showing ${session}.`
      if (message !== '') console.error(`${new Date().toISOString()} ${message}`)
      for (const viewer of viewersOf(session)) viewer.stream.write('exit', { code: message === '' ? 0 : 1, message })
    }
    const view = (async (): Promise<Shown> => {
      const { id, cwd } = await runHere(session)
      const terminal = open(id, cwd, await environment, size)
      // a running session has its record in `sessions/`, so the folder is there to watch
      watchStates()
      statesChanged()
      return { terminal, size, isAlternateScreen: false, state: { session, status: 'unknown' } }
    })()
    shown.set(session, view)
    view.catch(() => {
      if (isCurrent()) shown.delete(session)
    })
    return view
  }
  const forget = (stream: number): void => {
    const viewer = viewers.get(stream)
    if (viewer === undefined) return
    viewers.delete(stream)
    clearTimeout(viewer.forget)
    viewer.stream.close()
    if (viewersOf(viewer.session).length > 0) return fitShown(viewer.session)
    const showing = shown.get(viewer.session)
    shown.delete(viewer.session)
    void showing?.then((view) => view.terminal.close(), () => undefined)
  }
  // The viewer's link is gone, so its size counts no more and its stream waits for it.
  const unlink = (stream: number): void => {
    const viewer = viewers.get(stream)
    if (viewer === undefined || !viewer.isLinked) return
    viewer.isLinked = false
    viewer.stream.use(undefined)
    viewer.forget = setTimeout(() => forget(stream), LINGER_MS)
    fitShown(viewer.session)
  }
  const show = async ({ stream, session, cols, rows }: Pick<Extract<Routed, { readonly t: 'attach' }>, 'stream' | 'session' | 'cols' | 'rows'>, carrier: Carrier): Promise<void> => {
    const known = viewers.get(stream)
    if (known !== undefined) {
      clearTimeout(known.forget)
      Object.assign(known, { size: { cols, rows }, isLinked: true, carrier })
      carrier.attached()
      known.stream.use(carrier.link)
      return fitShown(known.session)
    }
    const viewer: Viewer = { session, stream: openStream(), size: { cols, rows }, isLinked: true, carrier }
    viewers.set(stream, viewer)
    viewer.stream.on('input', (bytes) => void shown.get(session)?.then((view) => view.terminal.write(bytes), () => undefined))
    viewer.stream.on('resize', (size) => {
      viewer.size = size
      fitShown(session)
    })
    viewer.stream.on('lost', (why) => {
      console.error(`${new Date().toISOString()} anyhost stops showing ${session} to a viewer: ${why}`)
      forget(stream)
    })
    const isShown = shown.has(session)
    const view = await (shown.get(session) ?? startShowing(session, { cols, rows })).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
    viewer.carrier.attached()
    viewer.stream.use(viewer.carrier.link)
    if (view instanceof Error) return viewer.stream.write('exit', { code: 1, message: view.message })
    viewer.stream.write('state', view.state)
    if (!isShown) return
    if (view.isAlternateScreen) viewer.stream.write('output', new TextEncoder().encode(ALTERNATE_SCREEN))
    if (!fit(session, view)) redraw(view)
  }
  // Claude Code's own status of each session shown, which each viewer hears as it changes.
  let statesWatch: ReturnType<typeof watch> | undefined
  let reading: ReturnType<typeof setTimeout> | undefined
  const statesChanged = (): void => {
    clearTimeout(reading)
    reading = setTimeout(() => void readStates(), STATE_MS)
  }
  const watchStates = (): void => {
    if (statesWatch !== undefined) return
    try {
      statesWatch = watch(join(roots.claudeHome, 'sessions'), statesChanged)
      problems.clear('claude sessions')
    } catch (error) {
      problems.set('claude sessions', error)
    }
  }
  const readStates = async (): Promise<void> => {
    if (shown.size === 0) return
    const running = await runningSessions().catch((error: unknown) => void problems.set('claude agents', error))
    if (running === undefined) return
    problems.clear('claude agents')
    for (const [session, showing] of shown) {
      const status = running.find((entry) => entry.sessionId === session)?.status ?? 'unknown'
      void showing.then((view) => {
        if (view.state.status === status) return
        view.state = { session, status }
        for (const viewer of viewersOf(session)) viewer.stream.write('state', view.state)
      }, () => undefined)
    }
  }

  // Each `anyhost attach` on this machine. Its first text message is its attach, and so is each later one, with the
  // same stream. A session this machine holds, this program shows it as it shows any viewer. Any other goes through
  // this program's one socket to the relay, to the machine that holds the session, and what the relay answers about
  // the stream goes back as it came. `isHere` says this program shows the leg's stream.
  type Leg = ServerWebSocket<{ stream?: number; isHere?: boolean }>
  const legs = new Map<number, Leg>()
  const toLeg = (stream: number, message: object | Uint8Array): void => void legs.get(stream)?.send(message instanceof Uint8Array ? message : JSON.stringify(message))
  const attachFrom = async (leg: Leg, text: string): Promise<void> => {
    const asked = JSON.parse(text) as Omit<Extract<Routed, { readonly t: 'attach' }>, 'to'>
    const { stream } = asked
    leg.data = { stream, isHere: false }
    legs.set(stream, leg)
    const showHere = async (session: string): Promise<void> => {
      leg.data.isHere = true
      const carrier: Carrier = { attached: () => toLeg(stream, { t: 'attached', stream, port: 0, addresses: [] }), link: { send: (frame) => toLeg(stream, frame) }, isRelay: false }
      await show({ ...asked, session }, carrier)
    }
    // With no relay to say which machine holds the session, one Claude Code runs in this machine's background still
    // shows here, as `claude attach` shows it with no relay. Any other waits for the relay.
    const unanswered = async (reply: object): Promise<void> => {
      const here = (await runningSessions().catch(() => [])).filter((entry) => entry.id !== undefined && entry.sessionId.startsWith(asked.session))
      if (legs.get(stream) !== leg) return
      const [only, ...more] = here
      if (only !== undefined && more.length === 0) return await showHere(only.sessionId)
      toLeg(stream, reply)
    }
    const offline = { t: 'offline', stream, to: '' }
    const { state } = relay
    if (state.is === 'connecting' || state.is === 'offline') return await unanswered(offline)
    if (state.is !== 'connected') return await unanswered({ t: 'invalid', message: state.message })
    const claims = await claimsOf(relay).catch(() => undefined)
    // an `anyhost attach` that ended meanwhile attaches nothing
    if (legs.get(stream) !== leg) return
    if (claims === undefined) return await unanswered(offline)
    const exact = claims.get(asked.session)
    const matches = exact === undefined ? [...claims].filter(([session]) => session.startsWith(asked.session)) : [[asked.session, exact] as const]
    const [found, ...more] = matches
    if (found === undefined || more.length > 0) {
      const message = found === undefined ? `No machine holds the session ${asked.session}. anyhost list shows every session.` : `${matches.length} sessions' ids begin with ${asked.session}. Give more of it.`
      return toLeg(stream, { t: 'invalid', message })
    }
    const [session, holder] = found
    if (holder.id === device.id) return await showHere(session)
    if (!relay.send({ ...asked, session, to: holder.id })) toLeg(stream, { t: 'offline', stream, to: holder.id })
  }

  relay.on('attach', (message) => void show(message, throughRelayTo(message.stream)))
  relay.on('attached', (message) => toLeg(message.stream, message))
  relay.on('offline', (message) => (message.stream === undefined ? undefined : toLeg(message.stream, message)))
  relay.on('detach', (message) => {
    unlink(message.stream)
    toLeg(message.stream, message)
  })
  relay.on('stream', (bytes) => {
    const stream = streamOf(bytes)
    viewers.get(stream)?.stream.receive(bytes.subarray(5))
    toLeg(stream, bytes.subarray(5))
  })
  // a new socket holds none of the streams the last one carried
  relay.on('welcome', () => {
    for (const [stream, viewer] of viewers) if (viewer.carrier.isRelay) unlink(stream)
    for (const [stream, leg] of legs) if (leg.data.isHere !== true) toLeg(stream, { t: 'detach', stream })
  })
  await startLineOffsets(capture)
  // a socket file a stopped program left refuses the listen
  rmSync(socket, { force: true })
  // A port's server cuts an answer after 10 quiet seconds, and this one answered after 12 s, so it needs no idleTimeout.
  Bun.serve<Leg['data']>({
    unix: socket,
    async fetch(request, server) {
      const { pathname } = new URL(request.url)
      if (pathname === '/attach' && server.upgrade(request, { data: {} })) return undefined
      if (request.method === 'GET' && pathname === '/status') return Response.json(statusOf())
      if (request.method === 'GET' && pathname === '/machines') return await throughRelay(async () => ({ here: device.id, machines: await machinesOf(relay) }))
      const claim = /^\/claims\/([\w-]+)$/.exec(pathname)?.[1]
      if (request.method === 'GET' && claim !== undefined) return Response.json(holderOf(claim))
      if (request.method !== 'POST') return failed(404, `anyhost serves GET /status, /claims/<session> and /machines, POST /connect, /join and /machines, and a WebSocket at /attach, not ${request.method} ${pathname}.`)
      const body = await request.json().catch((error: unknown) => new Error(`anyhost takes a JSON object at POST ${pathname}, and this body is none: ${error instanceof Error ? error.message : String(error)}`))
      if (body instanceof Error) return failed(400, body)
      return await act(pathname, body as { id?: string; link?: string })
    },
    websocket: {
      message(leg, message) {
        if (typeof message === 'string') return void attachFrom(leg, message)
        const { stream, isHere } = leg.data
        if (stream === undefined) return
        if (isHere === true) viewers.get(stream)?.stream.receive(new Uint8Array(message))
        else relay.send(encodeStream(stream, message))
      },
      // `anyhost attach` ended, so the machine that shows it the session stops
      close(leg) {
        const { stream, isHere } = leg.data
        if (stream === undefined || legs.get(stream) !== leg) return
        legs.delete(stream)
        if (isHere === true) unlink(stream)
        else relay.send({ t: 'detach', stream })
      },
    },
    error: (error) => failed(500, error),
  })
  console.log(`unix:${socket}`)
  await watchFolders(true)
  await settle('catch-up', catchUp)
  const loop = async (): Promise<void> => {
    const started = Date.now()
    await backup().catch((error: unknown) => problems.set('backup', error))
    setTimeout(() => void loop(), Math.max(0, started + BACKUP_MS - Date.now()))
  }
  await loop()
}
