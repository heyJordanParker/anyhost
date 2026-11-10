import type { Subprocess } from 'bun'
import { rmSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { changedFiles, countedRelay, journalOf, openCapture, openDatabase, QUIET_MS, sealQuiet, sessionsOf, startLineOffsets, takeUntold, uploadSessions, writeIndex, type Changed, type Problems } from './capture.ts'
import { recordedSessions, runSessions, type OnRecordsChange } from './claude.ts'
import { connectForStep, join as joinRelay, needsUpload, updateRelay, type Cloudflare, type ConnectRun, type Connecting, type RelayNames } from './connect.ts'
import { cmod, forgetRelayLogin, inviteMachine, machinesOf, personOptions, relayLogin, removeMachine, rootsHere, stateFolder, type Device } from './device.ts'
import { hcPath, machinesReached } from './hc.ts'
import { installHerdr } from './herdr.ts'
import { addMachine, candidatesOf, keepHerdrReaching, reachedAt } from './machines.ts'
import { move, receiveList, receiveMove, receiveReleased, receiveStart, receiveTell, startNew, statusesOf, takeHere, tell, type MoveHere, type Moving } from './move.ts'
import { connectRelay, waitAfter, type RelayState } from './relay.ts'
import { reopenStopped } from './runner.ts'
import { listSessions } from './sessions.ts'
import { isSettled, settle as settleSession, sharedOf, updateShared } from './shared.ts'
import { codexState, filesUnder, watchedFolders, type Tool } from './transcript.ts'

const BACKUP_MS = 60_000
// The backup stats every file of every session it captures at the program's start and once an hour, for the writes to
// those files no event named, as a write while the program was down, as Syncthing pairs its watcher with an hourly full
// rescan. Each other minute it stats the files of the sessions written in the last QUIET_MS alone, so a quiet session
// costs nothing. The stats reach only the files it captured, so each full sweep also lists the watched folders for the
// files written since the full sweep before it, or since the program last ran, which finds a file no event named: macOS's
// watcher drops events with no word of it, as Bun 1.4.4 ignores FSEvents' `UserDropped` and `MustScanSubDirs`, and
// fseventsd logged 3,622 `USER DROPPED` lines in 30 minutes on the Architect's Mac. That listing took 0.90 to 2.99 s for
// 58,984 files there. A change the watcher prints as `unnamed` starts a listing of its folder at once.
const SWEEP_ALL_MS = 60 * 60_000
// Claude Code renames a new record into `sessions/` at each change of a session's status, and removes it as the
// session ends, once each, so whatever waits on the records reads them again at each change of the folder the watcher
// heard. A watcher drops a change with no word of it, as Bun 1.4.4's on macOS does, which would leave the wait on it
// waiting, so the records are read every READ_MS too while anything waits on them, whatever the watcher's state, and
// while no ready watcher hears the folder: one read a second, and none on a machine where nothing waits and a watcher
// hears. One read of one record took 0.014 to 0.020 ms of CPU in the program's thread on anyhost-a.
const READ_MS = 1000
// Bun 1.4.4's `fs.watch` on macOS runs every watch of a process through one FSEvents thread, which holds the lock that
// each `watch()` and `close()` takes across `FSEventStreamStart`, and that waits on macOS's fseventsd, which takes no
// new watcher for minutes at a time while OrbStack Helper holds its 512 (Bun issue #43870). The process's JavaScript
// then waits on the lock, which no signal ends, and so does its exit, as Bun's exit joins that thread. So the program
// never watches in its own process: WATCHER is the program of the one process that holds its watches, run as bun. It prints the path of each change within its folder's `depth`, `null` for every level,
// as a JSON string on a line of its own, so no write deeper in a scratchpad's checkout crosses the pipe, and `ready`
// once its watches hear, which a write of `probe` says: it writes the probe every 100 ms until its watch of the probe
// heard one, as a stream that waits on fseventsd hears nothing though each `watch()` returned. A change its watch gives
// no name, as Bun's recursive watch on Linux gives the removal of the watched folder itself, and an inotify overflow
// to every watch of the process, is `unnamed` and that watch's folder as a JSON string. A folder it cannot watch, as
// one gone since the program found it, which `watch()` throws at, or one it may not list, which Bun's recursive watch
// on Linux fails with EACCES, costs only that folder: the log names it, and the watcher prints `lost` and the folder as
// a JSON string, which the listings then hear in its place. It ends by SIGKILL once its input closes,
// as the program's end closes it, since its exit would wait on the lock too. For tests, `ANYHOST_WATCHER_HANGS=1` blocks it before its watches, as a stall does, and
// `ANYHOST_WATCHER_DROPS=1` makes it drop every change its watches hear, as macOS's watcher drops events.
const WATCHER = `
const { join, sep } = require('node:path')
const { watch, writeFileSync } = require('node:fs')
const { probe, folders } = JSON.parse(process.argv.at(-1))
if (process.env.ANYHOST_WATCHER_HANGS === '1') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
const isDropping = process.env.ANYHOST_WATCHER_DROPS === '1'
const say = (line) => process.stdout.write(line + '\\n')
for (const { folder, depth } of folders) {
  const failed = (error) => {
    console.error(new Date().toISOString() + ' anyhost hears no change in a folder under ' + folder + ': ' + error.message)
    say('lost ' + JSON.stringify(folder))
  }
  const heard = (_event, name) => {
    if (isDropping) return
    if (typeof name !== 'string') return say('unnamed ' + JSON.stringify(folder))
    if (depth === null || name.split(sep).length <= depth) say(JSON.stringify(join(folder, name)))
  }
  try {
    watch(folder, { recursive: depth !== 1 }, heard).on('error', failed)
  } catch (error) {
    failed(error)
  }
}
const write = () => writeFileSync(probe, String(process.pid))
write()
let probing = setInterval(write, 100)
watch(probe, () => {
  if (probing === undefined) return
  clearInterval(probing)
  probing = undefined
  say('ready')
})
process.stdin.on('end', () => process.kill(process.pid, 'SIGKILL')).resume()
`
// A watcher that is not ready this long after its start gets SIGKILL, and another starts after `waitAfter` its failures.
// Ten watchers on anyhost-a were ready 25 to 468 ms after their start, at a Mac load average near 130. No watcher on the
// Mac was ready from 09:02 to 09:55 on 2026-11-07, as fseventsd took no new watcher for that whole time.
const WATCHER_MS = 10_000
// A running program answers /status in milliseconds over its socket.
const RUNNING_MS = 2000
// What the program's 404 names, every route it serves.
const ROUTES = 'anyhost serves GET /status, /machines, /agents and /claims/<session>, POST /connect, /connect/account, /connect/r2, /join, /machines/add, /machines/invite, /machines/remove, /move, /move/keep, /new, /agents/tell, /agents/take, /agents/settle and /settings'

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
  // each problem the program tries again by itself
  readonly problems: readonly string[]
  // each span of a session's journal R2 lost while this machine had no transcript of the session to upload again, which
  // no try brings back, until the program restarts
  readonly journalGaps: readonly string[]
  // why the program could not update a relay that needs its upload, which it tries once a run, until this machine joins
  // again or a relay that needs no upload welcomes it
  readonly updateProblem?: string
  // the Connect Cloudflare the mod's Step started, while the program runs
  readonly connecting?: Connecting
  // The join with the link of the option `join`: `running` from the program's start until its first read of the
  // options found no link, and while a link's join runs, and `failed` with why until this machine joins.
  readonly joining?: { readonly is: 'running' } | { readonly is: 'failed'; readonly error: string }
}
// The answer to POST /join: the address of the relay this machine joined.
export type JoinedRelay = { readonly url: string }
// A drain's upload of the sessions, which answers each one with its paths left for the next drain.
type Upload = (sessions: readonly Changed[]) => readonly (readonly [Changed, Promise<Set<string>>])[]
// how a session's upload ended: with the paths it left for the next drain, or its failure
type Uploaded = { readonly left: ReadonlySet<string> } | { readonly error: unknown }

// The upload queue: one per machine, filled on every write the watcher names, and drained every `every` seconds, or on
// every write at 0. A drain uploads every queued session once, in one upload, with everything written since its last
// upload. One upload is in flight per session: writes during it join the next drain, which at 0 starts as soon as it
// ends. At 0 a failed upload tries again after 1 second, then 2, 4 and so on up to a minute, so a line waits out no
// more of an outage than that.
export class UploadQueue {
  private readonly queued = new Map<string, { tool: Tool; paths: Set<string> }>()
  private readonly uploading = new Set<string>()
  // the uploads of each session that failed in a row
  private readonly failures = new Map<string, number>()
  // what waits for each session's upload in flight to end
  private readonly ended = new Map<string, ((end: Uploaded) => void)[]>()
  // each flush that waits for the relay, which the next drain wakes
  private readonly relayWaits = new Set<() => void>()
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

  // Drains every queued session, and wakes each flush that waits for the relay, as the relay's welcome drains the queue.
  drain(): void {
    for (const wake of [...this.relayWaits]) wake()
    this.drainSessions([...this.queued.keys()])
  }

  // Drains what of the session is queued or goes up as it is called, and again the paths those uploads left for a later
  // drain, as a line still being written or code pieces. A write after the call waits for the next drain the queue runs
  // itself, so the flush of a session that keeps writing ends. A relay that is not connected holds the flush until a
  // drain finds it connected, as the welcome's does, and `onRelay` hears as that wait starts and ends. Answers once that
  // is up, or rejects with the failure of an upload, or with the signal's reason once it aborts.
  async flush(session: string, signal: AbortSignal, onRelay: (isConnected: boolean) => void): Promise<void> {
    // whether the queue holds paths the flush waits for, and whether the upload it waits for next is the one in flight
    // as it was called, which carries none of them
    let isOwed = this.queued.has(session)
    let isInFlight = this.uploading.has(session)
    while (isOwed || isInFlight) {
      signal.throwIfAborted()
      if (!this.isReady()) {
        onRelay(false)
        while (!this.isReady()) await this.nextDrain(signal)
        onRelay(true)
      }
      if (!this.uploading.has(session)) this.drainSessions([session])
      // nothing of the session waits or goes up
      if (!this.uploading.has(session)) return
      const end = await this.uploadEnd(session, signal)
      if ('error' in end) throw end.error
      isOwed = (isOwed && isInFlight) || end.left.size > 0
      isInFlight = false
    }
  }

  // The next drain, or the signal's reason once it aborts, which takes this wait out of `relayWaits`.
  private nextDrain(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const woken = (): void => {
        this.relayWaits.delete(woken)
        signal.removeEventListener('abort', aborted)
        resolve()
      }
      const aborted = (): void => {
        this.relayWaits.delete(woken)
        reject(signal.reason)
      }
      signal.addEventListener('abort', aborted, { once: true })
      this.relayWaits.add(woken)
    })
  }

  // How the session's upload in flight ends, or the signal's reason once it aborts, which takes this wait out of `ended`.
  private uploadEnd(session: string, signal: AbortSignal): Promise<Uploaded> {
    return new Promise((resolve, reject) => {
      const ended = (end: Uploaded): void => {
        signal.removeEventListener('abort', aborted)
        resolve(end)
      }
      const aborted = (): void => {
        const others = (this.ended.get(session) ?? []).filter((each) => each !== ended)
        if (others.length > 0) this.ended.set(session, others)
        else this.ended.delete(session)
        reject(signal.reason)
      }
      signal.addEventListener('abort', aborted, { once: true })
      this.ended.set(session, [...(this.ended.get(session) ?? []), ended])
    })
  }

  private uploaded(session: string, end: Uploaded): void {
    const waiting = this.ended.get(session) ?? []
    this.ended.delete(session)
    for (const resolve of waiting) resolve(end)
  }

  private schedule(): void {
    clearInterval(this.timer)
    this.timer = this.every > 0 ? setInterval(() => this.drain(), this.every * 1000) : undefined
  }

  private drainSessions(sessions: readonly string[]): void {
    if (!this.isReady()) return
    const drained: Changed[] = []
    for (const session of sessions) {
      const queued = this.queued.get(session)
      if (queued === undefined || this.uploading.has(session)) continue
      this.queued.delete(session)
      this.uploading.add(session)
      drained.push({ session, ...queued })
    }
    if (drained.length === 0) return
    for (const [queued, upload] of this.upload(drained)) {
      const { session } = queued
      upload.then(
        (left) => {
          this.uploading.delete(session)
          this.failures.delete(session)
          // every path left goes in the one next drain, which carries them all
          const now = this.queued.get(session) ?? { tool: queued.tool, paths: new Set<string>() }
          for (const path of left) now.paths.add(path)
          if (now.paths.size > 0) this.queued.set(session, now)
          if (this.every === 0) this.drainSessions([session])
          this.uploaded(session, { left })
        },
        (error: unknown) => {
          // the paths wait for the next drain: the retry at 0, the next write, the timer, or the 60-second backup
          this.uploading.delete(session)
          const now = this.queued.get(session) ?? { tool: queued.tool, paths: new Set() }
          this.queued.set(session, { tool: now.tool, paths: new Set([...queued.paths, ...now.paths]) })
          this.onFailure(session, error)
          const failures = (this.failures.get(session) ?? 0) + 1
          this.failures.set(session, failures)
          if (this.every === 0) setTimeout(() => this.drainSessions([session]), waitAfter(failures))
          this.uploaded(session, { error })
        },
      )
    }
  }
}

// `names` is the relay Connect Cloudflare deploys and keeps current, the Worker and bucket anyhost, and `cloudflare` what
// both and every join reach, Cloudflare itself, unless a test passes its own.
export async function serve(device: Device, names?: RelayNames, cloudflare?: Cloudflare): Promise<void> {
  // Two programs on one state folder would both write its database and its journals, so a second one refuses to start.
  // It replaces only a socket file nothing answers on, as a stopped program leaves.
  const socket = serveSocket()
  const running = await fetch('http://localhost/status', { unix: socket, signal: AbortSignal.timeout(RUNNING_MS) }).then(
    async (answer) => (await answer.json()) as Status,
    () => undefined,
  )
  if (running !== undefined) throw new Error(`The anyhost program of ${running.device.name} already answers at ${socket}, so this one does not start. Two programs on one state folder would both write its database.`)
  const roots = rootsHere()
  const relay = connectRelay({ login: relayLogin, forget: forgetRelayLogin, device, roots, isPatient: true })
  const db = openDatabase()
  // A session's code that captureCode read after an upload goes up in the session's next drains. The database counts
  // what one relay's bucket holds, so a welcome from another relay starts it over and the program exits, and its
  // service starts it again on that relay. Another machine holds a session, and its background job here stops: the
  // program sets `release` below, once it can stop a job, and then stops each job a release before that missed, as a
  // welcome can come while the program starts.
  let release = (_session: string, _holder: string): void => undefined
  const capture = openCapture(relay, device, roots, {
    db,
    onCode: (session, tool, folder) => queue.add(session, tool, `${folder}/`),
    onReleased: (session, holder) => release(session, holder),
    onOtherRelay: (url, bucket) => {
      console.error(`${new Date().toISOString()} This machine connects to the relay at ${url}, whose bucket is ${bucket}, not to the one its database counts, so anyhost exits, and its service starts it again on that relay.`)
      process.exit(0)
    },
  })
  const heartbeat = join(stateFolder(), 'heartbeat')
  const current = new Map<string, string>()
  // the option join's run, as /status carries it, until the first read of the options found no link
  let joining: Status['joining'] = { is: 'running' }
  let capturedAt = ''
  // when the backup last statted every file of every session, which the program's start has not yet
  let sweptAllAt = 0
  // the person's `checkouts` option, read with the others, where a session moved or started here clones its repository
  let checkouts = ''

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
      uploadSessions(capture, sessions, problems, queue.uploadEvery === 0).map(([changed, upload]) => [
        changed,
        upload.then((left) => {
          problems.clear(`upload ${changed.session}`)
          capturedAt = new Date().toISOString()
          return left
        }),
      ]),
    (session, error) => problems.set(`upload ${session}`, error),
    () => relay.state.is === 'connected',
  )
  // The welcome's sessions another machine took are in the database by now, and a welcome from another relay ended the
  // program, so the queue drains what waited for the relay. A machine the relay welcomes is joined, so a join that
  // failed before is no problem now.
  relay.on('welcome', () => {
    joining = undefined
    queue.drain()
  })
  // Claude Code's records of the sessions it runs, in `sessions/` under its folder, and what waits on their changes.
  const records = join(roots.claudeHome, 'sessions')
  const recordsHeard = new Set<() => void>()
  const onRecordsChange: OnRecordsChange = (heard) => {
    recordsHeard.add(heard)
    followRecords()
    return () => {
      recordsHeard.delete(heard)
      followRecords()
    }
  }
  const recordsChanged = (): void => {
    for (const read of recordsHeard) read()
  }
  // every folder the watcher watches once it is there, with the levels of folders in it that a listing reads
  const watchable: readonly { readonly folder: string; readonly depth: number }[] = [...watchedFolders(roots), { folder: records, depth: 1 }]
  const heard = (path: string): void => {
    if (watchable.some(({ folder }) => folder === path)) void watchFolders()
    if (dirname(path) === records) return recordsChanged()
    // a write to Codex's write-ahead log is a change of its database
    const changed = path.startsWith(codexState(roots)) ? codexState(roots) : path
    void sessionsOf(capture, path).then(
      (owners) => {
        for (const { session, tool } of owners) queue.add(session, tool, changed)
      },
      (error: unknown) => problems.set(path, error),
    )
  }
  // The folders the watcher watches once they are there, each by its inode and birth time, as a folder removed and made
  // again is another, which a filesystem may give the inode number it had. The watcher is a process that runs WATCHER:
  // `ready` is the one that hears, with each folder it watches by the inode and birth time it had at the watcher's
  // start, less the folders it lost, and when it got ready, and `starting` the newest one, from its start until it is
  // ready or ended, while the one before goes on hearing, as a new watcher can wait minutes on fseventsd.
  const watched = new Map<string, string>()
  const probe = join(stateFolder(), 'watcher')
  let ready: { readonly child: Subprocess; readonly folders: ReadonlyMap<string, string>; readonly at: number } | undefined
  let starting: Subprocess | undefined
  let watcherFailures = 0
  let nextWatcher: ReturnType<typeof setTimeout> | undefined
  // A folder made again where the ready watcher watched is no folder it hears, as Bun's watch on Linux hears nothing of
  // it, until the watcher started on it is ready.
  const hears = (folder: string): boolean => watched.has(folder) && ready?.folders.get(folder) === watched.get(folder)
  // Reads Claude Code's records every READ_MS while anything waits on them, or no ready watcher hears `sessions/`, and
  // runs no timer from the first read after neither holds.
  let pollingRecords: ReturnType<typeof setInterval> | undefined
  const followRecords = (): void => {
    if (recordsHeard.size > 0 || !hears(records)) {
      pollingRecords ??= setInterval(() => {
        recordsChanged()
        followRecords()
      }, READ_MS)
    } else {
      clearInterval(pollingRecords)
      pollingRecords = undefined
    }
  }
  // The time from which a write in each watched folder may have gone unheard, which the next listing hears, and none
  // for a folder a ready watcher hears every write in: every folder's from the heartbeat's at the start, so the start
  // hears what changed while the program did not run, or from the start's own on a first start, which captures nothing
  // old, and from 0 a folder watched since the last listing, whose every file the next listing hears, as Claude Code
  // writes into a new folder before any watcher hears it.
  const lastRanAt = await stat(heartbeat).then((found) => found.mtimeMs, () => Date.now())
  const unheard = new Map<string, number>()
  const unheardFrom = (since: number, folders: readonly string[] = watchable.map(({ folder }) => folder)): void => {
    for (const folder of folders) unheard.set(folder, Math.min(unheard.get(folder) ?? Infinity, since))
  }
  unheardFrom(lastRanAt)
  // The ready watcher ended, by its exit or a SIGKILL here, as its own exit would wait on its watches. Each write in its
  // folders from then on may go unheard.
  const endReady = (): void => {
    if (ready === undefined) return
    ready.child.kill('SIGKILL')
    unheardFrom(Date.now(), [...ready.folders.keys()])
    ready = undefined
    followRecords()
  }
  // When each folder's last listing started, which heard every file written there before it.
  const listedAt = new Map<string, number>()
  // A change a watcher could not name in `folder` may be of any file written there since that watcher got ready at
  // `readyAt`, or since the folder's last listing after that, so the next listing hears each of those, as Watchman
  // crawls again after an overflow. Bun gives an inotify overflow to every watch, so each folder whose writes it dropped
  // says so.
  const unnamed = (folder: string, readyAt: number): void => {
    unheardFrom(Math.max(listedAt.get(folder) ?? 0, readyAt), [folder])
    void watchFolders()
    void listWritten()
  }
  // Starts a watcher of every folder in `watched`, and answers once it is ready or ended. It replaces a watcher still
  // starting at once, and the ready one only once it is ready itself, so a watched folder that appears while fseventsd
  // takes no new watcher leaves the ready one hearing the folders it watches. A watcher that is not ready WATCHER_MS
  // after its start, or that exits, is a problem until a watcher is ready, and another starts after `waitAfter` the
  // failures in a row, unless one starts already.
  const startWatcher = (): Promise<void> => {
    starting?.kill('SIGKILL')
    clearTimeout(nextWatcher)
    const settled = Promise.withResolvers<void>()
    // each folder the watcher hears, by its inode and birth time as the watcher starts, less each folder it lost
    const hearing = new Map(watched)
    const folders = watchable.flatMap(({ folder, depth }) => (hearing.has(folder) ? [{ folder, depth: Number.isFinite(depth) ? depth : null }] : []))
    const child = Bun.spawn([process.execPath, '-e', WATCHER, JSON.stringify({ probe, folders })], { env: { ...process.env, BUN_BE_BUN: '1' }, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
    starting = child
    const ended = (why: string): void => {
      clearTimeout(limit)
      settled.resolve()
      if (child === ready?.child) endReady()
      else if (child === starting) {
        child.kill('SIGKILL')
        starting = undefined
      } else return
      if (starting !== undefined) return
      watcherFailures++
      const wait = waitAfter(watcherFailures)
      problems.set('watcher', new Error(`anyhost's watcher ${why}, so each backup pass lists the watched folders for the files written since the one before, and another watcher starts in ${wait / 1000} s.`))
      nextWatcher = setTimeout(() => void startWatcher(), wait)
    }
    const limit = setTimeout(() => ended(`heard none of its watches ${WATCHER_MS / 1000} s after its start, as while macOS's fseventsd takes no new watcher`), WATCHER_MS)
    void child.exited.then(() => ended(`exited with ${child.signalCode ?? child.exitCode}`))
    // when the watcher got ready, from which its changes count
    let readyAt: number | undefined
    const gotReady = (): void => {
      clearTimeout(limit)
      starting = undefined
      const before = ready
      readyAt = Date.now()
      ready = { child, folders: hearing, at: readyAt }
      before?.child.kill('SIGKILL')
      // the watcher before heard the folders this one lost at its start until now at most
      unheardFrom(readyAt, folders.map(({ folder }) => folder).filter((folder) => !hearing.has(folder)))
      watcherFailures = 0
      problems.clear('watcher')
      followRecords()
      void listWritten()
      settled.resolve()
    }
    // A folder the ready watcher lost is heard by no watch: the listings hear it in the watcher's place from the time
    // `unnamed` names, and the records are read every READ_MS when it is `sessions/`.
    const lose = (folder: string): void => {
      hearing.delete(folder)
      if (child !== ready?.child || readyAt === undefined) return
      followRecords()
      unnamed(folder, readyAt)
    }
    // A watcher's changes count from its `ready` on, as the ready watcher before it hears them until then, and until its
    // output closes, as one the next ready watcher replaced may still have lines in its pipe.
    void (async () => {
      const decoder = new TextDecoder()
      let left = ''
      for await (const chunk of child.stdout) {
        const lines = (left + decoder.decode(chunk, { stream: true })).split('\n')
        left = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('lost ')) lose(JSON.parse(line.slice('lost '.length)) as string)
          else if (readyAt === undefined) {
            if (line === 'ready' && child === starting) gotReady()
          } else if (line.startsWith('unnamed ')) unnamed(JSON.parse(line.slice('unnamed '.length)) as string, readyAt)
          else heard(JSON.parse(line) as string)
        }
      }
    })()
    return settled.promise
  }
  // A folder Claude Code makes while the program runs, such as `tasks/` at a session's first task, and one removed and
  // made again, as Claude Code's temp root can be, is watched as soon as the watch of its parent names it, or the next
  // backup pass finds it, by a new watcher of every folder, and the next listing hears every file in it. A folder that
  // went leaves the watched ones, so no watcher starts on it.
  const watchFolders = async (isStart = false): Promise<void> => {
    let isNew = false
    for (const { folder } of watchable) {
      const found = await stat(folder).then((info) => (info.isDirectory() ? `${info.ino} ${info.birthtimeMs}` : undefined), () => undefined)
      if (found === watched.get(folder)) continue
      if (found === undefined) {
        watched.delete(folder)
        continue
      }
      watched.set(folder, found)
      if (!isStart) unheardFrom(0, [folder])
      isNew = true
    }
    followRecords()
    if (isNew) await startWatcher()
  }
  // A listing of the folders in `unheard` hears each file written in each since the time it names, in place of a
  // watcher: as a watcher gets ready, at each backup pass while a folder has none, and at a change the watcher could
  // not name. A listing of all the Architect's Mac's 58,984 files took 0.90 to 2.99 s and 0.54 to 1.13 s of CPU at a
  // load average near 70 to 90, and held the program's thread 212 ms at most.
  const listOnce = async (): Promise<void> => {
    const [started, listing] = [Date.now(), new Map(unheard)]
    unheard.clear()
    for (const { folder, depth } of watchable) {
      const since = listing.get(folder)
      if (since === undefined || !watched.has(folder)) continue
      listedAt.set(folder, started)
      for (const { path, mtimeMs } of await filesUnder(folder, depth)) if (mtimeMs >= since) heard(path)
    }
    // a watcher ready since before the listing started heard every write in its folders the listing did not
    const isHeard = (folder: string): boolean => (ready?.at ?? Infinity) <= started && hears(folder)
    unheardFrom(started, watchable.map(({ folder }) => folder).filter((folder) => !isHeard(folder)))
  }
  // The listing that runs, and the one asked while it runs, which starts once that one ended and answers every ask
  // meanwhile, as an `unnamed` or a new watcher's ready can come during a listing, which already read its folders.
  let listing: Promise<void> | undefined
  let listingNext: Promise<void> | undefined
  const listWritten = (): Promise<void> => {
    if (listing !== undefined) {
      listingNext ??= listing.then(() => {
        listingNext = undefined
        return listWritten()
      })
      return listingNext
    }
    if (unheard.size === 0) return Promise.resolve()
    listing = listOnce().finally(() => (listing = undefined))
    return listing
  }
  // A join here takes effect at once: the relay connects with the new login, and the problems it solves leave.
  const joined = (): void => {
    joining = undefined
    problems.clear('relay update')
    relay.reconnect()
  }
  let connecting: ConnectRun | undefined
  // A relay that needsUpload is updated once a run, with this machine's cf login, which only a person may refresh: one
  // that answers an older protocol is `outdated`, and the machine captures nothing until the update, while an older one
  // at this protocol welcomes the machine, which captures meanwhile. Without a usable login the mod's Step shows Connect
  // Cloudflare for an outdated relay, and anyhost doctor the failure. The update's calls take minutes at worst, so the
  // backup goes on without it.
  let isUpdateTried = false
  const keepRelayCurrent = async (): Promise<void> => {
    const { state } = relay
    if (isUpdateTried || !(state.is === 'outdated' || (state.is === 'connected' && needsUpload(state.welcome)))) return
    isUpdateTried = true
    await settle('relay update', async () => {
      await updateRelay(names, cloudflare)
      relay.reconnect()
    })
  }
  // A welcome from an older relay starts its update at once, as a backup pass would within a minute, and one from a
  // relay that needs no upload, as another machine's update or Connect Cloudflare puts up, ends a failed update's problem.
  relay.on('welcome', (welcome) => {
    if (needsUpload(welcome)) void keepRelayCurrent()
    else problems.clear('relay update')
  })
  // each session's files on the upload queue, with the session's tool
  const queueFiles = (files: ReadonlyMap<string, ReadonlySet<string>>): void => {
    for (const [session, paths] of files) {
      const tool = journalOf(capture.db, session)?.tool ?? 'claude'
      for (const path of paths) queue.add(session, tool, path)
    }
  }
  // The person's options, read at the program's start and at each backup pass. The link `cmod install … --option
  // join=<link>` set joins once, and the option empties whether it joined or not, so a refused or expired invite is not
  // tried again and the next machine's command needs nothing else. The Step waits on the join while it runs, and a join
  // that failed stays in /status until this machine joins, for the Step and anyhost doctor to show with its fix. A
  // machine the relay welcomes is joined already, so its failure is only logged.
  const readOptions = async (): Promise<void> => {
    const options = await personOptions().catch((error: unknown) => void problems.set('options', error))
    if (options !== undefined) {
      problems.clear('options')
      queue.uploadEvery = uploadEveryOf(options.uploadEvery)
      checkouts = options.checkouts ?? ''
    }
    const link = options?.join ?? ''
    if (link === '') {
      if (joining?.is === 'running') joining = undefined
      return
    }
    joining = { is: 'running' }
    try {
      try {
        await joinRelay(link, device, cloudflare)
      } finally {
        await cmod(['option', 'anyhost', 'join', ''])
      }
      joined()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`${new Date().toISOString()} The link of the option join joined no relay: ${message}`)
      joining = relay.state.is === 'connected' ? undefined : { is: 'failed', error: message }
    }
  }
  const backup = async (): Promise<void> => {
    await watchFolders()
    await Bun.write(heartbeat, '')
    const started = Date.now()
    const isAll = started - sweptAllAt >= SWEEP_ALL_MS
    // a full sweep lists the files written since the full sweep before it, or since the program last ran
    if (isAll) unheardFrom(sweptAllAt > 0 ? sweptAllAt : lastRanAt)
    await listWritten()
    await readOptions()
    // the Herdr app makes its home at its first start, which can come while the program runs
    await settle('herdr', () => installHerdr())
    // the queue keeps what the sweep finds until the relay welcomes this machine
    await settle('backup', async () => {
      queueFiles(await changedFiles(capture, isAll ? 0 : started - QUIET_MS))
      if (isAll) sweptAllAt = started
    })
    void keepRelayCurrent()
    if (relay.state.is !== 'connected') return
    if (queue.uploadEvery === 0) queue.drain()
    await settle('index', () => writeIndex(capture))
    queueFiles(await sealQuiet(capture, problems))
    await settle('herdr machines', () => keepHerdrReaching(relay, device))
  }
  // Each move this program ran since it started, by its whole session id, which its session and `anyhost move` follow.
  const moves = new Map<string, Moving>()
  // a move as /claims and /move answer it
  const shownMove = ({ to, step, line }: Moving): Pick<Moving, 'to' | 'step' | 'line'> => ({ to, step, line })
  // What a prompt waits for: this machine's own record of who holds the session, which the relay's `released` and each
  // upload keep, so the answer never waits on the relay, and the move of it this program runs or ran. `untold` names,
  // once, the machine this machine took the session from while that machine had no connection to the relay.
  const holderOf = (session: string): { machine?: string; problem?: string; untold?: string; move?: Pick<Moving, 'to' | 'step' | 'line'> } => {
    const moving = moves.get(session)
    const move = moving === undefined ? {} : { move: shownMove(moving) }
    const { state } = relay
    if (state.is === 'refused' || state.is === 'outdated') return { problem: state.message, ...move }
    const holder = journalOf(capture.db, session)?.holder ?? ''
    const untold = takeUntold(capture.db, session)
    return { ...(holder === '' ? {} : { machine: holder }), ...(untold === '' ? {} : { untold }), ...move }
  }
  // `problems` holds what the program tries again by itself, and the rest each has its own key: a span R2 lost, and the
  // relay update, which runs once a run.
  const statusOf = (): Status => {
    const { state, url } = relay
    const updateProblem = current.get('relay update')
    return {
      device,
      relay: { url, state: state.is, message: 'message' in state ? state.message : '', bucket: state.is === 'connected' ? state.welcome.bucket : (countedRelay(capture.db)?.bucket ?? '') },
      pending: queue.pending,
      uploadEvery: queue.uploadEvery,
      capturedAt,
      problems: [...current].filter(([key]) => !key.startsWith('journal ') && key !== 'relay update').map(([, line]) => line),
      journalGaps: [...current].filter(([key]) => key.startsWith('journal ')).map(([, line]) => line),
      ...(updateProblem === undefined ? {} : { updateProblem }),
      ...(connecting === undefined ? {} : { connecting: connecting.view }),
      ...(joining === undefined ? {} : { joining }),
    }
  }
  // Each machine an add runs for, by its ssh target, with why it failed once it did.
  const adding = new Map<string, { readonly error?: string }>()
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
  // What the mod's Step, /machines and /move send, and anyhost move, anyhost new and anyhost connect, as JSON. `apiToken`
  // is the CLOUDFLARE_API_TOKEN of anyhost connect's environment, which only the run it starts uses. `folder` is the
  // absolute folder anyhost new starts a session for, and `prompt` what it types into it. `text`, `keys`, `lines` and
  // `sender` are what /agents/tell does to a session (`Tell`).
  type Asked = {
    readonly id?: string
    readonly link?: string
    readonly session?: string
    readonly machine?: string
    readonly folder?: string
    readonly prompt?: string
    readonly text?: string
    readonly keys?: readonly string[]
    readonly lines?: number
    readonly sender?: string
    readonly apiToken?: string
    readonly target?: string
    readonly settled?: boolean
    readonly settleAfterDays?: number | null
  }
  const act = async (pathname: string, { id = '', link = '', session = '', machine = '', folder = '', prompt = '', text = '', keys = [], lines = 0, sender = '', apiToken, target = '', settled = true, settleAfterDays }: Asked): Promise<Response> => {
    switch (pathname) {
      case '/connect': {
        if (connecting?.view.is === 'running') return Response.json(connecting.view)
        const started = connectForStep(device, names, cloudflare, apiToken)
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
        const url = await joinRelay(link, device, cloudflare)
        joined()
        return Response.json({ url } satisfies JoinedRelay)
      }
      case '/machines/invite':
        return await throughRelay(() => inviteMachine(relay))
      case '/machines/remove':
        if (id === device.id) return failed(400, `${device.name} is this machine. Remove it from another machine's /machines.`)
        return await throughRelay(() => removeMachine(relay, id))
      // An add takes minutes, as it installs herdr-core, cmod and anyhost there, so it runs on in the program and /machines
      // says how it goes, as the Step does with Connect Cloudflare.
      case '/machines/add':
        if (target === '') return failed(400, 'Name the machine to add as ssh reaches it, such as devbox or me@10.0.0.7.')
        if (adding.get(target)?.error === undefined && adding.has(target)) return Response.json({ target })
        adding.set(target, {})
        void addMachine(relay, target).then(
          () => adding.delete(target),
          (error: unknown) => adding.set(target, { error: error instanceof Error ? error.message : String(error) }),
        )
        return Response.json({ target })
      case '/agents/settle':
        return await throughRelay(async () => void (await settleSession(relay, session, settled)))
      case '/settings':
        return await throughRelay(async () => void (await updateShared(relay, (shared) => ({ ...shared, settleAfterDays: settleAfterDays ?? null }))))
      case '/move':
        return await move(capture, session, machine, mover).then(
          (moving) => Response.json({ session: moving.session, ...shownMove(moving) }),
          (error: unknown) => failed(400, error),
        )
      case '/move/keep':
        if (moves.get(session)?.keep() !== true) return failed(400, `No move of ${session} can keep it here now: none runs, or its machine answered already.`)
        return Response.json({})
      // anyhost new asks here, as the relay sends the other machine's `started` to the sockets this machine has open as
      // it comes, and a command's own socket that dropped meanwhile would never hear it. It waits for the relay as the
      // program does.
      case '/new':
        return await startNew(capture, machine, folder, prompt, mover).then(
          async (started) => {
            await updateShared(relay, (shared) => ({ ...shared, lastMachine: machine || device.name }))
            return Response.json({ session: started, machine: machine || device.name })
          },
          (error: unknown) => failed(400, error),
        )
      case '/agents/tell':
        return await tell(capture, session, { text, keys, lines, sender }, mover).then(
          (told) => Response.json(told),
          (error: unknown) => failed(400, error),
        )
      case '/agents/take':
        return await takeHere(capture, session, mover).then(
          (taken) => Response.json({ session: taken, machine: device.name }),
          (error: unknown) => failed(400, error),
        )
      default:
        return failed(404, `${ROUTES}, not POST ${pathname}.`)
    }
  }

  // Every end of the program, by a signal or by `process.exit`, ends each watcher by SIGKILL first, which no wait on
  // fseventsd holds up.
  const killWatchers = (): void => {
    ready?.child.kill('SIGKILL')
    starting?.kill('SIGKILL')
  }
  process.once('exit', killWatchers)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, () => {
      killWatchers()
      process.kill(process.pid, signal)
    })
  }
  // what every move, received move and start, and take of a session from here uses of this program, built once, with
  // the `checkouts` option as the last options read left it
  const mover: MoveHere = {
    moves,
    answers: new Map(),
    problems,
    get checkouts() {
      return checkouts
    },
    queue: (session, tool, path) => queue.add(session, tool, path),
    flush: (session, signal, onRelay) => queue.flush(session, signal, onRelay),
    onRecordsChange,
  }
  // Another machine moves a session here, or starts a new one here, and hears whether it runs.
  relay.on('move', (message) => void receiveMove(capture, message, mover))
  relay.on('start', (message) => void receiveStart(capture, message, mover))
  relay.on('tell', (message) => void receiveTell(capture, message, mover))
  relay.on('list', (message) => void receiveList(capture, message, mover))
  // Another machine holds a session, and its copy here stops: at each `released` this socket takes and each 409 a frame
  // or a seal of this program meets (`onReleased`), now for every copy a release before missed, and at each welcome for
  // every copy of a session the database names another holder of. Each copy stops once, whichever comes.
  const releasing = new Set<string>()
  release = (session, holder) => {
    if (releasing.has(session)) return
    releasing.add(session)
    void receiveReleased(capture, session, holder, mover).finally(() => releasing.delete(session))
  }
  const releaseHeld = async (): Promise<void> => {
    // a sleeping session's runner runs with no record of Claude Code's
    for (const session of new Set([...(await recordedSessions(roots.claudeHome)).map(({ sessionId }) => sessionId), ...runSessions()])) {
      const holder = journalOf(db, session)?.holder ?? ''
      if (holder !== '') release(session, holder)
    }
  }
  relay.on('welcome', releaseHeld)
  void releaseHeld()
  void settle('herdr', () => installHerdr())
  if (hcPath() !== undefined) void reopenStopped().catch((error: unknown) => problems.set('reopen', error))

  await startLineOffsets(capture)
  // a socket file a stopped program left refuses the listen
  rmSync(socket, { force: true })
  // A port's server cuts an answer after 10 quiet seconds, and this one answered after 12 s, so it needs no idleTimeout.
  Bun.serve({
    unix: socket,
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (request.method === 'GET' && pathname === '/status') return Response.json(statusOf())
      if (request.method === 'GET' && pathname === '/machines')
        return await throughRelay(async () => {
          const [machines, shared, reached, candidates] = await Promise.all([machinesOf(relay), sharedOf(relay), hcPath() === undefined ? [] : machinesReached(), candidatesOf()])
          const joined = new Set([...machines.map(({ name }) => name), ...Object.values(shared.reach)])
          // a failed add of a machine that joined since, as one that took longer than the add waited, is over
          for (const machine of machines) if (machine.connected && shared.reach[machine.id] !== undefined) adding.delete(shared.reach[machine.id] ?? '')
          return {
            here: device.id,
            machines: machines.map((machine) => ({ ...machine, herdr: reachedAt(reached, shared.reach[machine.id])?.name ?? null })),
            candidates: candidates.filter(({ target }) => !joined.has(target) && !machines.some(({ name }) => name.toLowerCase() === target.toLowerCase())),
            adding: [...adding].map(([target, { error }]) => ({ target, ...(error === undefined ? {} : { error }) })),
          }
        })
      if (request.method === 'GET' && pathname === '/agents')
        return await throughRelay(async () => {
          const [agents, statuses, shared] = await Promise.all([listSessions(relay), statusesOf(capture), sharedOf(relay)])
          return { agents: agents.map((agent) => ({ ...agent, status: statuses[agent.id] ?? '', settled: isSettled(shared, agent) })), settleAfterDays: shared.settleAfterDays, lastMachine: shared.lastMachine }
        })
      const claim = /^\/claims\/([\w-]+)$/.exec(pathname)?.[1]
      if (request.method === 'GET' && claim !== undefined) return Response.json(holderOf(claim))
      if (request.method !== 'POST') return failed(404, `${ROUTES}, not ${request.method} ${pathname}.`)
      const body = await request.json().catch((error: unknown) => new Error(`anyhost takes a JSON object at POST ${pathname}, and this body is none: ${error instanceof Error ? error.message : String(error)}`))
      if (body instanceof Error) return failed(400, body)
      return await act(pathname, body as Asked)
    },
    error: (error) => failed(500, error),
  })
  console.log(`unix:${socket}`)
  // the option's join starts at once, as the Step waits on it, while the watcher starts, which can take 10 s
  const firstOptions = readOptions()
  await watchFolders(true)
  await firstOptions
  const loop = async (): Promise<void> => {
    const started = Date.now()
    await backup().catch((error: unknown) => problems.set('backup', error))
    setTimeout(() => void loop(), Math.max(0, started + BACKUP_MS - Date.now()))
  }
  await loop()
}
