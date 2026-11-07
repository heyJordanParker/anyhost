import type { ServerWebSocket, Subprocess } from 'bun'
import { rmSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { encodeStream, streamOf, type Routed } from '../../relay/protocol.ts'
import { attachTerminal, backgroundJobOf, personEnvironment, recordedSessions, whenSessions, type AttachedTerminal, type OnRecordsChange, type RunningSession } from './background.ts'
import { changedFiles, countedRelay, journalOf, openCapture, openDatabase, QUIET_MS, sealQuiet, sessionsOf, startLineOffsets, takeUntold, uploadSessions, workingFolderOf, writeIndex, type Changed, type Problems } from './capture.ts'
import { claimsOf } from './claims.ts'
import { connectForStep, join as joinRelay, needsUpload, updateRelay, type Cloudflare, type ConnectRun, type Connecting, type RelayNames } from './connect.ts'
import { cmod, forgetRelayLogin, inviteMachine, machinesOf, personOptions, relayLogin, removeMachine, rootsHere, stateFolder, type Device } from './device.ts'
import { listenDirect, type DirectLink, type DirectListener, type DirectOffer } from './direct.ts'
import { move, receiveMove, receiveReleased, receiveStart, startNew, type MoveHere, type Moving } from './move.ts'
import { connectRelay, waitAfter, type RelayState } from './relay.ts'
import { offsetOf, openStream, randomStreamId, type Exit, type Link, type SessionState, type Size, type Stream } from './stream.ts'
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
// The relay carries a viewer's output at most once per OUTPUT_MS, all of it since the last in one frame, so a busy
// session costs the Pool at most 4 messages a second, where Cloudflare's Free plan allows 100,000 requests a day and
// may count each WebSocket message as one (relay-spec "Control messages"). Replaying a busy `claude attach`'s 11 writes
// a second to one viewer over `memoryRelay` on anyhost-a, the Pool took 11.0 messages a second at 20 ms and 4.7 at
// 250 ms, the viewer's acknowledgements included: 2.5 and 5.9 hours of such viewing a day at one request per message.
// Output after a quiet OUTPUT_MS goes at once, so a key typed at a quiet screen echoed in 15 ms at the median there,
// against 36 ms at 20 ms, while one typed into a busy screen waits for the next frame: 172 ms against 29 ms. A direct
// connection and this machine's own socket carry output at once.
const OUTPUT_MS = 250
// A viewer whose link is gone keeps its place for the longest wait between its tries to attach again.
const LINGER_MS = 60_000
// Claude Code rewrites a running session's record in `sessions/` under its folder at each change of its status, once
// each, so the records of the sessions shown are read again STATE_MS after the folder changed, once for the events of
// one rewrite. One read of 3 sessions' records took 5.3 ms of CPU on a test machine, and one `claude agents --json`,
// which reads the same records, 468 times as long.
const STATE_MS = 200
// Claude Code renames a new record into `sessions/` at each change of a session's status, and removes it as the
// session ends, once each, so whatever waits on the records reads them again at each change of the folder the watcher
// heard. A watcher drops a change with no word of it, as Bun 1.4.4's on macOS does, which would leave the wait on it
// waiting, so the records are read every READ_MS too while anything waits on them, whatever the watcher's state, and
// while no ready watcher hears the folder, for the status of the sessions shown: one read a second, of 5.3 ms of CPU for
// 3 records (STATE_MS), and none on a machine where nothing waits and a watcher hears. Reading the records themselves,
// as `claude agents --json` does, takes no process: one `claude agents --json` took 1.2 to 4 s on anyhost-b while a
// session started there, on the CPU that session needs.
const READ_MS = 1000
// Bun 1.4.4's `fs.watch` on macOS runs every watch of a process through one FSEvents thread, which holds the lock that
// each `watch()` and `close()` takes across `FSEventStreamStart`, and that waits on macOS's fseventsd, which takes no
// new watcher for minutes at a time while OrbStack Helper holds its 512 (Bun issue #43870). The process's JavaScript
// then waits on the lock, which no signal ends, and so does its exit, as Bun's exit joins that thread. So the program
// never watches in its own process: WATCHER is the program of the one process that holds its watches, run as bun, as
// `personEnvironment` runs it. It prints the path of each change within its folder's `depth`, `null` for every level,
// as a JSON string on a line of its own, so no write deeper in a scratchpad's checkout crosses the pipe, and `ready`
// once its watches hear, which a write of `probe` says: it writes the probe every 100 ms until its watch of the probe
// heard one, as a stream that waits on fseventsd hears nothing though each `watch()` returned. A change its watch gives
// no name, as Bun's recursive watch on Linux gives the removal of the watched folder itself, and an inotify overflow
// to every watch of the process, is `unnamed` and that watch's folder as a JSON string. A folder it cannot watch, as
// one gone since the program found it, which `watch()` throws at, or one it may not list, which Bun's recursive watch
// on Linux fails with EACCES, costs only that folder, and the log names it. It ends by SIGKILL once its input closes,
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
  const failed = (error) => console.error(new Date().toISOString() + ' anyhost hears no change in a folder under ' + folder + ': ' + error.message)
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
// A new viewer of a session already shown gets a redraw: the terminal a row shorter until Claude Code clears the screen
// to paint it at that size, then back. On a test machine Claude Code set only its modes again when the size came back
// within 50 ms, and 1 of 7 redraws with the size back after 300 ms painted nothing, so the size comes back once the
// screen was cleared, or after REDRAW_MS when it never is. The paint goes on after the clear, which can come in a read
// of its own, so the size comes back PAINT_MS after the clear, the longest a clear waited while every viewer's output
// went out once per OUTPUT_MS.
const REDRAW_MS = 2000
const PAINT_MS = 20
const CLEAR = '\x1b[2J'
// A `claude attach` that ends QUICK_ENDS times in a row within QUICK_END_MS of its start fails at its start, and the
// host stops starting it again. A person who presses `←` and leaves the agents view takes longer than that.
const QUICK_END_MS = 2000
const QUICK_ENDS = 3
// systemd stopping `anyhost-claude.slice` signals each `claude attach` and session in the same moment, and Claude Code
// removed the session's record 0.35 to 0.53 s after the attach ended in 4 stops of the daemon's scope on anyhost-d, at
// a Mac load average of 140 to 237.
const STOPPING_MS = 3000
// Claude Code 2.1.319 respawns a session whose process crashed 10 s later ("restarting this session in 10 seconds",
// `ht` of its worker), and one it killed because a `claude attach` stalled 5 s at most 6 s after its signal (`Br`):
// 2.2 and 3.1 s on anyhost-d at a Mac load average of 257. The new process writes the session's record as it starts:
// 12.5 s after a crash at a load of 250, where the attach went on, and 41 s after one stalled respawn at 257.
const RESPAWN_MS = 10_000
// A running program answers /status in milliseconds over its socket.
const RUNNING_MS = 2000
// What the program's 404 names, every route it serves.
const ROUTES = 'anyhost serves GET /status, /machines and /claims/<session>, POST /connect, /connect/account, /connect/r2, /join, /machines/invite, /machines/remove, /move, /move/keep and /new, and a WebSocket at /attach'
// A redraw repaints the screen and sets every terminal mode again but the alternate screen.
const ALTERNATE_SCREEN = '\x1b[?1049h'
const MAIN_SCREEN = '\x1b[?1049l'
// the bytes of the output kept from one read to the next, all but one of the longest sequence looked for
const TAIL_BYTES = ALTERNATE_SCREEN.length - 1

// Where `sequence` last begins in a terminal's `output`, its latest read after the `kept` bytes of the read before,
// counted from the latest read's first byte, so below 0 when it begins in the kept bytes, and -Infinity when no
// sequence ends in the latest read.
function lastAt(output: Buffer, kept: number, sequence: string): number {
  const at = output.lastIndexOf(sequence)
  return at >= 0 && at + sequence.length > kept ? at - kept : -Infinity
}

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
  // why Claude Code starts with the program's own environment, not the person's shell's, until the program restarts
  readonly shellProblem?: string
  // why macOS refused the last anyhost attach here a dial to the local network, until one goes through
  readonly localNetworkProblem?: string
  // why the program could not update a relay that needs its upload, which it tries once a run, until this machine joins
  // again or a relay that needs no upload welcomes it
  readonly updateProblem?: string
  // why the program offers viewers on other machines no direct connection, until the program restarts
  readonly directProblem?: string
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

  // Drains what of the session is queued or goes up as it is called, and again the paths those uploads left for a later
  // drain, as a line still being written or code pieces. A write after the call waits for the next drain the queue runs
  // itself, so the flush of a session that keeps writing ends. Answers once that is up, or rejects with the failure of
  // an upload, or with the signal's reason once it aborts.
  async flush(session: string, signal: AbortSignal): Promise<void> {
    // whether the queue holds paths the flush waits for, and whether the upload it waits for next is the one in flight
    // as it was called, which carries none of them
    let isOwed = this.queued.has(session)
    let isInFlight = this.uploading.has(session)
    while (isOwed || isInFlight) {
      signal.throwIfAborted()
      if (!this.isReady()) throw new Error('anyhost is not connected to the relay, so it uploads nothing.')
      if (!this.uploading.has(session)) this.drainSessions([session])
      // nothing of the session waits or goes up
      if (!this.uploading.has(session)) return
      const end = await this.uploadEnd(session, signal)
      if ('error' in end) throw end.error
      isOwed = (isOwed && isInFlight) || end.left.size > 0
      isInFlight = false
    }
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
  // service starts it again on that relay.
  const capture = openCapture(relay, device, roots, {
    db,
    onCode: (session, tool, folder) => queue.add(session, tool, `${folder}/`),
    onOtherRelay: (url, bucket) => {
      console.error(`${new Date().toISOString()} This machine connects to the relay at ${url}, whose bucket is ${bucket}, not to the one its database counts, so anyhost exits, and its service starts it again on that relay.`)
      process.exit(0)
    },
  })
  const heartbeat = join(stateFolder(), 'heartbeat')
  const current = new Map<string, string>()
  let shellProblem: string | undefined
  let localNetworkProblem: string | undefined
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
  // Claude Code's records of the sessions it runs, in `sessions/` under its folder, the lock of its daemon beside them,
  // as `recordedSessions` takes a background session's record only while the lock names a running daemon, and what waits
  // on their changes. A Claude Code update leaves no lock for 1.8 to 2 s while its sessions run on, so a read in that
  // gap, as a change in `sessions/` starts, reads again as the lock comes back.
  const records = join(roots.claudeHome, 'sessions')
  const daemonLock = join(roots.claudeHome, 'daemon.lock')
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
    statesChanged()
  }
  // every folder the watcher watches once it is there, with the levels of folders in it that a listing reads
  const watchable: readonly { readonly folder: string; readonly depth: number }[] = [...watchedFolders(roots), { folder: records, depth: 1 }]
  const heard = (path: string): void => {
    if (watchable.some(({ folder }) => folder === path)) void watchFolders()
    if (dirname(path) === records || path === daemonLock) return recordsChanged()
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
  // `ready` is the one that hears, with the folders it watches and when it got ready, and `starting` the newest one,
  // from its start until it is ready or ended, while the one before goes on hearing, as a new watcher can wait minutes
  // on fseventsd.
  const watched = new Map<string, string>()
  const probe = join(stateFolder(), 'watcher')
  let ready: { readonly child: Subprocess; readonly folders: ReadonlySet<string>; readonly at: number } | undefined
  let starting: Subprocess | undefined
  let watcherFailures = 0
  let nextWatcher: ReturnType<typeof setTimeout> | undefined
  const hears = (folder: string): boolean => ready?.folders.has(folder) === true && watched.has(folder)
  // Reads Claude Code's records every READ_MS while anything waits on them or no ready watcher hears `sessions/`, and
  // runs no timer otherwise.
  let pollingRecords: ReturnType<typeof setInterval> | undefined
  const followRecords = (): void => {
    if (recordsHeard.size > 0 || !hears(records)) pollingRecords ??= setInterval(recordsChanged, READ_MS)
    else {
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
    unheardFrom(Date.now(), [...ready.folders])
    ready = undefined
    followRecords()
  }
  // When each folder's last listing started, which heard every file written there before it.
  const listedAt = new Map<string, number>()
  // A change the ready watcher could not name in `folder` may be of any file written there since the watcher got
  // ready, or since the folder's last listing after that, so the next listing hears each of those, as Watchman crawls
  // again after an overflow. Bun gives an inotify overflow to every watch, so each folder whose writes it dropped says
  // so.
  const unnamed = (folder: string): void => {
    unheardFrom(Math.max(listedAt.get(folder) ?? 0, ready?.at ?? Date.now()), [folder])
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
    const folders = watchable.flatMap(({ folder, depth }) => (watched.has(folder) ? [{ folder, depth: Number.isFinite(depth) ? depth : null }] : []))
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
    const gotReady = (): void => {
      clearTimeout(limit)
      starting = undefined
      const before = ready
      ready = { child, folders: new Set(folders.map(({ folder }) => folder)), at: Date.now() }
      before?.child.kill('SIGKILL')
      watcherFailures = 0
      problems.clear('watcher')
      followRecords()
      void listWritten()
      settled.resolve()
    }
    // A watcher's changes count from its `ready` on: the ready watcher before it hears them until then.
    void (async () => {
      const decoder = new TextDecoder()
      let left = ''
      for await (const chunk of child.stdout) {
        const lines = (left + decoder.decode(chunk, { stream: true })).split('\n')
        left = lines.pop() ?? ''
        for (const line of lines) {
          if (child === starting) {
            if (line === 'ready') gotReady()
          } else if (child !== ready?.child) return
          else if (line.startsWith('unnamed ')) unnamed(JSON.parse(line.slice('unnamed '.length)) as string)
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
  // `problems` holds what the program tries again by itself, and the rest each has its own key: a span R2 lost, the
  // relay update, which runs once a run, and the listener of direct connections, which starts once.
  const statusOf = (): Status => {
    const { state, url } = relay
    const updateProblem = current.get('relay update')
    const directProblem = current.get('direct')
    return {
      device,
      relay: { url, state: state.is, message: 'message' in state ? state.message : '', bucket: state.is === 'connected' ? state.welcome.bucket : (countedRelay(capture.db)?.bucket ?? '') },
      pending: queue.pending,
      uploadEvery: queue.uploadEvery,
      capturedAt,
      problems: [...current].filter(([key]) => !key.startsWith('journal ') && key !== 'relay update' && key !== 'direct').map(([, line]) => line),
      journalGaps: [...current].filter(([key]) => key.startsWith('journal ')).map(([, line]) => line),
      ...(shellProblem === undefined ? {} : { shellProblem }),
      ...(localNetworkProblem === undefined ? {} : { localNetworkProblem }),
      ...(updateProblem === undefined ? {} : { updateProblem }),
      ...(directProblem === undefined ? {} : { directProblem }),
      ...(connecting === undefined ? {} : { connecting: connecting.view }),
      ...(joining === undefined ? {} : { joining }),
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
  // What the mod's Step, /machines and /move send, and anyhost move, anyhost new and anyhost connect, as JSON. `apiToken`
  // is the CLOUDFLARE_API_TOKEN of anyhost connect's environment, which only the run it starts uses. `folder` is the
  // absolute folder anyhost new starts a session for.
  type Asked = { readonly id?: string; readonly link?: string; readonly session?: string; readonly machine?: string; readonly folder?: string; readonly apiToken?: string }
  const act = async (pathname: string, { id = '', link = '', session = '', machine = '', folder = '', apiToken }: Asked): Promise<Response> => {
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
        return await startNew(capture, machine, folder).then(
          (session) => Response.json({ session }),
          (error: unknown) => failed(400, error),
        )
      default:
        return failed(404, `${ROUTES}, not POST ${pathname}.`)
    }
  }

  // The sessions this machine shows to viewers, on other machines and on this one: one `claude attach` per session, at
  // the smallest size of the viewers linked now, as tmux's `window-size smallest`, so every viewer draws it whole, and
  // its output goes to every viewer's stream. A second `claude attach` would draw the session at its own size and break
  // the other viewers' screens (worker-spec W9). A viewer whose link is gone keeps its stream for LINGER_MS, so its next
  // attach with the same stream goes on where both sides' bytes reached, and one forgotten attaches as a new viewer.
  // `carrier` reaches the viewer: through the relay, or the WebSocket of an `anyhost attach` on this machine. A viewer
  // on another machine that reaches this one directly has its stream on `direct` while that connection lasts,
  // `pending` holds the output that waits for the relay's next message, and `flushedAt` is when the last one went.
  // `attached` answers the viewer's attach with `hostStream`, the random id this program drew for its end of the
  // viewer's stream as it opened it, so a viewer that hears another id than the one it linked with last starts its
  // stream over, whichever `attached` it missed.
  type Carrier = { readonly attached: (hostStream: number) => void; readonly link: Link; readonly isRelay: boolean }
  type Viewer = {
    readonly session: string
    readonly stream: Stream
    readonly hostStream: number
    size: Size
    isLinked: boolean
    carrier: Carrier
    direct?: DirectLink | undefined
    pending: Uint8Array[]
    flushedAt: number
    flush?: ReturnType<typeof setTimeout> | undefined
    forget?: ReturnType<typeof setTimeout>
  }
  // `cleared` runs at the next screen Claude Code clears, while a redraw waits for it. `wasRecorded` says Claude Code's
  // record said the session runs since this program showed it, as a stopped one it opens has none at first.
  // `recordCheck` answers whether the session runs, from Claude Code's records followed for a while, and is the one
  // check of the session that runs, which every end of its attach and every change of the records shares. `held` keeps
  // the keys typed while no attach drew yet: from the start of an attach, or the end of the one before it, until its
  // first output, as a closed terminal takes none, and a terminal still cooked takes Enter in as a newline.
  type Shown = { terminal: AttachedTerminal; size: Size; isAlternateScreen: boolean; state: SessionState; wasRecorded: boolean; cleared?: (() => void) | undefined; recordCheck?: Promise<boolean> | undefined; held?: Uint8Array[] | undefined }
  const viewers = new Map<number, Viewer>()
  const shown = new Map<string, Promise<Shown>>()
  // Every `claude attach` this program runs. Bun's terminal gives them no controlling terminal, so no hangup ends them
  // when this program goes, and a stopped program closes each first, then ends by the signal that stopped it. Every end
  // of the program, by a signal or by `process.exit`, ends each watcher by SIGKILL first, which no wait on fseventsd
  // holds up.
  const terminals = new Set<AttachedTerminal>()
  const killWatchers = (): void => {
    ready?.child.kill('SIGKILL')
    starting?.kill('SIGKILL')
  }
  process.once('exit', killWatchers)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, () => {
      killWatchers()
      for (const terminal of terminals) terminal.close()
      process.kill(process.pid, signal)
    })
  }
  const viewersOf = (session: string): Viewer[] => [...viewers.values()].filter((viewer) => viewer.session === session)
  // a viewer whose size counts: one the relay, this machine's socket or a direct connection reaches now
  const isReached = (viewer: Viewer): boolean => viewer.isLinked || viewer.direct !== undefined
  const stoppedOn = (session: string): string => `The session ${session} stopped running on ${device.name}.`
  // Whether Claude Code runs the session here: its record says so now, or again within RESPAWN_MS, as Claude Code
  // respawns a session whose process crashed or that it killed.
  const keepsRunning = (session: string): Promise<boolean> =>
    whenSessions(roots.claudeHome, (sessions) => sessions.some((entry) => entry.sessionId === session) || undefined, RESPAWN_MS, onRecordsChange).then((found) => found === true)
  // The record check of a shown session that runs already, or `check` as the new one.
  const checkRecord = (view: Shown, check: () => Promise<boolean>): Promise<boolean> =>
    (view.recordCheck ??= check().finally(() => (view.recordCheck = undefined)))
  // A viewer on another machine, which the relay reaches, and whose `attached` offers the addresses it dials: from then on
  // a direct connection under its key becomes its stream's link. The stream is held for a connection only once
  // `attached` went, as one before it would carry a new stream before the viewer heard that this program holds a new
  // one, as a viewer whose host restarted dials before it attaches again.
  const throughRelayTo = (stream: number, key: string, offer: DirectOffer, listener: DirectListener | undefined): Carrier => ({
    attached(hostStream) {
      relay.send({ t: 'attached', stream, hostStream, ...offer })
      listener?.hold(stream, key, (frame) => viewers.get(stream)?.stream.receive(frame), (link) => reached(stream, link))
    },
    link: { send: (frame) => void relay.send(encodeStream(stream, frame)) },
    isRelay: true,
  })
  // The port and addresses viewers on other machines reach this machine at directly. A machine whose listener failed
  // offers none, and its viewers stay on the relay.
  const direct = listenDirect(stateFolder(), problems).catch((error: unknown) => void problems.set('direct', error))
  const noOffer: DirectOffer = { port: 0, addresses: [] }
  // A viewer's output goes at once over a direct connection or this machine's own socket, and through the relay in one
  // frame at most once per OUTPUT_MS: at once after a quiet OUTPUT_MS, as the first output of a turn of the event loop,
  // and else OUTPUT_MS after the frame before.
  const flushOutput = (viewer: Viewer): void => {
    clearTimeout(viewer.flush)
    viewer.flush = undefined
    if (viewer.pending.length === 0) return
    const bytes = Buffer.concat(viewer.pending)
    viewer.pending = []
    viewer.flushedAt = Date.now()
    viewer.stream.write('output', bytes)
  }
  const output = (viewer: Viewer, bytes: Uint8Array): void => {
    if (viewer.direct === undefined && viewer.carrier.isRelay) {
      viewer.pending.push(bytes)
      viewer.flush ??= setTimeout(() => flushOutput(viewer), Math.max(0, viewer.flushedAt + OUTPUT_MS - Date.now()))
      return
    }
    flushOutput(viewer)
    viewer.stream.write('output', bytes)
  }
  // The one end of showing a session, after its `claude attach` ended or before it closes: every viewer gets `exit`.
  const stopShowing = (session: string, exit: Exit): void => {
    shown.delete(session)
    console.error(`${new Date().toISOString()} ${exit.message}`)
    for (const viewer of viewersOf(session)) {
      flushOutput(viewer)
      viewer.stream.write('exit', exit)
    }
  }
  // the environment Claude Code starts with, the person's own, read once at the program's start
  const environment = personEnvironment().then(({ environment: found, problem }) => {
    shellProblem = problem
    return found
  })
  const fit = (session: string, view: Shown): boolean => {
    const sizes = viewersOf(session).filter(isReached).map(({ size }) => size)
    if (sizes.length === 0) return false
    const size = { cols: Math.min(...sizes.map(({ cols }) => cols)), rows: Math.min(...sizes.map(({ rows }) => rows)) }
    if (size.cols === view.size.cols && size.rows === view.size.rows) return false
    view.size = size
    view.terminal.resize(size.cols, size.rows)
    return true
  }
  const fitShown = (session: string): void => void shown.get(session)?.then((view) => fit(session, view), () => undefined)
  // A viewer's keys go once into the session's attach, or wait in `held` until it drew. No key reaches a closed
  // terminal: an attach's terminal closes only as its `exited` resolves, and `ended` holds the keys from then on in the
  // same turn of the event loop, while each key comes in a turn of its own.
  const typeInto = (view: Shown, keys: Uint8Array): void => {
    if (view.held !== undefined) return void view.held.push(keys)
    view.terminal.write(keys)
  }
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
  // The id `claude attach` takes for a session this machine holds, and the folder it runs in, as `backgroundJobOf`
  // answers it, starting it in Claude Code's background in the folder this machine knows it in when Claude Code keeps no
  // job of it.
  const runHere = async (session: string): Promise<{ readonly id: string; readonly cwd: string }> => {
    const holder = journalOf(capture.db, session)?.holder ?? ''
    if (holder !== '') throw new Error(`The session ${session} continues on ${holder}.`)
    return await backgroundJobOf(roots.claudeHome, session, workingFolderOf(capture.db, session), await environment, device.name)
  }
  const startShowing = (session: string, size: Size): Promise<Shown> => {
    // the output's last bytes, in which a sequence the next read ends can begin
    let tail = Buffer.alloc(0)
    let quickEnds = 0
    // The view once it resolved. A terminal's output comes in a later turn of the event loop than the one that opened
    // it, and the view resolves in the same turn as its first terminal opens, so every read finds it.
    let ready: Shown | undefined
    // the attach that has not drawn yet, whose first output lets the held keys in
    let undrawn: AttachedTerminal | undefined
    const isCurrent = (): boolean => shown.get(session) === view
    const took = (from: AttachedTerminal, bytes: Uint8Array): void => {
      const current = ready
      if (!isCurrent() || current === undefined) return
      const joined = Buffer.concat([tail, bytes])
      const [on, off] = [lastAt(joined, tail.length, ALTERNATE_SCREEN), lastAt(joined, tail.length, MAIN_SCREEN)]
      if (on !== off) current.isAlternateScreen = on > off
      if (lastAt(joined, tail.length, CLEAR) > -Infinity) setTimeout(() => current.cleared?.(), PAINT_MS)
      tail = Buffer.from(joined.subarray(-TAIL_BYTES))
      for (const viewer of viewersOf(session)) output(viewer, bytes)
      if (from !== undrawn) return
      // the keys held for this attach go in after its first frame, as an attach that drew is up, while one not up yet may
      // still have its terminal cooked, which takes Enter in as a newline
      undrawn = undefined
      const held = current.held ?? []
      current.held = undefined
      for (const keys of held) typeInto(current, keys)
    }
    // in the session's folder, where Claude Code's agents view, which `←` opens in it, has the folder's trust. An attach
    // that cannot start rejects, which `ended` tells the viewers.
    const open = async (id: string, cwd: string, env: Record<string, string>, at: Size): Promise<AttachedTerminal> => {
      const terminal: AttachedTerminal = attachTerminal(id, cwd, env, at, (bytes) => took(terminal, bytes))
      undrawn = terminal
      const started = Date.now()
      terminals.add(terminal)
      void terminal.exited.then((signal) => {
        terminals.delete(terminal)
        if (undrawn === terminal) undrawn = undefined
        return ended(id, cwd, started, signal)
      })
      return terminal
    }
    // `claude attach` ends by itself when a viewer leaves Claude Code's agents view, which `←` opens, or once the
    // session ended, as after `claude stop`. A signal ends it from outside: the OOM killer, a `kill`, or systemd stopping
    // `anyhost-claude.slice`, which signals the daemon and its sessions in the same moment, so the session still runs as
    // its attach ends. So Claude Code's record of the session decides: followed for STOPPING_MS after a signal, then read
    // once more, and for an attach that ended by itself, as `keepsRunning` reads it. While the session runs, this
    // program starts the attach again, which paints the whole screen for every viewer, so no viewer's keys end the
    // others'.
    const ended = async (id: string, cwd: string, started: number, signal: Subprocess['signalCode']): Promise<void> => {
      if (!isCurrent()) return
      const lived = Date.now() - started
      const current = await view
      // the keys typed from now on wait for the attach after this one to draw
      current.held ??= []
      const isGone = (sessions: readonly RunningSession[]): true | undefined => (sessions.some((entry) => entry.sessionId === session) ? undefined : true)
      const isRecorded = async (): Promise<boolean> => isGone(await recordedSessions(roots.claudeHome)) === undefined
      const stopping = async (): Promise<boolean> => (await whenSessions(roots.claudeHome, isGone, STOPPING_MS, onRecordsChange)) === undefined && (await isRecorded())
      const isRunning = await checkRecord(current, signal === null ? () => keepsRunning(session) : stopping)
      if (!isCurrent()) return
      quickEnds = lived < QUICK_END_MS ? quickEnds + 1 : 0
      if (isRunning && quickEnds < QUICK_ENDS) {
        console.error(`${new Date().toISOString()} claude attach ${id} ended${signal === null ? '' : ` by ${signal}`} while ${session} runs, so anyhost starts it again for its viewers.`)
        const terminal = await open(id, cwd, await environment, current.size).catch((error: unknown) => new Error(`anyhost could not start claude attach ${id} again: ${error instanceof Error ? error.message : String(error)}`))
        if (terminal instanceof Error) return isCurrent() ? stopShowing(session, { code: 1, message: terminal.message }) : undefined
        // the viewers left meanwhile
        if (!isCurrent()) return terminal.close()
        Object.assign(current, { isAlternateScreen: false, terminal })
        tail = Buffer.alloc(0)
        return
      }
      stopShowing(session, isRunning ? { code: 1, message: `claude attach ${id} ended ${QUICK_ENDS} times within ${QUICK_END_MS / 1000} s of its start, so ${device.name} stops showing ${session}.` } : { code: 0, message: stoppedOn(session) })
    }
    const view = (async (): Promise<Shown> => {
      const { id, cwd } = await runHere(session)
      const terminal = await open(id, cwd, await environment, size)
      statesChanged()
      ready = { terminal, size, isAlternateScreen: false, state: { session, status: 'unknown' }, wasRecorded: false, held: [] }
      return ready
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
    clearTimeout(viewer.flush)
    const link = viewer.direct
    viewer.direct = undefined
    link?.close()
    void direct.then((listener) => listener?.release(stream))
    viewer.stream.close()
    if (viewersOf(viewer.session).length > 0) return fitShown(viewer.session)
    const showing = shown.get(viewer.session)
    shown.delete(viewer.session)
    void showing?.then((view) => view.terminal.close(), () => undefined)
  }
  // No way reaches the viewer, so its size counts no more and its stream waits for it.
  const linkGone = (stream: number, viewer: Viewer): void => {
    viewer.stream.use(undefined)
    viewer.forget = setTimeout(() => forget(stream), LINGER_MS)
    fitShown(viewer.session)
  }
  // The viewer's relay or socket is gone, and a direct connection still carries its stream.
  const unlink = (stream: number): void => {
    const viewer = viewers.get(stream)
    if (viewer === undefined || !viewer.isLinked) return
    viewer.isLinked = false
    if (viewer.direct === undefined) linkGone(stream, viewer)
  }
  // A viewer on another machine reached this one directly: the connection carries its stream from now on, and the
  // relay again once the connection ends.
  const reached = (stream: number, link: DirectLink): void => {
    const viewer = viewers.get(stream)
    if (viewer === undefined) return link.close()
    viewer.direct?.close()
    flushOutput(viewer)
    viewer.direct = link
    clearTimeout(viewer.forget)
    viewer.stream.use(link)
    fitShown(viewer.session)
    console.error(`${new Date().toISOString()} A viewer of ${viewer.session} reaches ${device.name} directly at ${link.address}.`)
    void link.ended.then((why) => {
      if (viewer.direct !== link) return
      viewer.direct = undefined
      console.error(`${new Date().toISOString()} The direct connection of a viewer of ${viewer.session} at ${link.address} ended, as ${why}, so its stream goes through the relay.`)
      if (viewers.get(stream) !== viewer) return
      if (viewer.isLinked) viewer.stream.use(viewer.carrier.link)
      else linkGone(stream, viewer)
    })
  }
  const show = async ({ stream, session, cols, rows }: Pick<Extract<Routed, { readonly t: 'attach' }>, 'stream' | 'session' | 'cols' | 'rows'>, carrier: Carrier): Promise<void> => {
    const known = viewers.get(stream)
    if (known !== undefined) {
      clearTimeout(known.forget)
      Object.assign(known, { size: { cols, rows }, isLinked: true, carrier })
      carrier.attached(known.hostStream)
      if (known.direct === undefined) known.stream.use(carrier.link)
      return fitShown(known.session)
    }
    const viewer: Viewer = { session, stream: openStream(), hostStream: randomStreamId(), size: { cols, rows }, isLinked: true, carrier, pending: [], flushedAt: 0 }
    viewers.set(stream, viewer)
    viewer.stream.on('input', (keys) => void shown.get(session)?.then((view) => typeInto(view, keys), () => undefined))
    viewer.stream.on('resize', (size) => {
      viewer.size = size
      fitShown(session)
    })
    viewer.stream.on('lost', (why) => {
      console.error(`${new Date().toISOString()} anyhost stops showing ${session} to a viewer: ${why}`)
      forget(stream)
    })
    const isShown = shown.has(session)
    const showing = shown.get(session) ?? startShowing(session, { cols, rows })
    // The new viewer hears `attached` and links before the session is ready, which takes seconds at a start, so each
    // attach is answered in the order it came, and its dial during the start is taken. The keys wait for the session
    // meanwhile, and a start that fails reaches the viewer as `exit`.
    carrier.attached(viewer.hostStream)
    viewer.stream.use(carrier.link)
    const view = await showing.catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
    if (view instanceof Error) return viewer.stream.write('exit', { code: 1, message: view.message })
    viewer.stream.write('state', view.state)
    if (!isShown) return
    if (view.isAlternateScreen) viewer.stream.write('output', new TextEncoder().encode(ALTERNATE_SCREEN))
    if (!fit(session, view)) redraw(view)
  }
  // Claude Code's own status of each session shown, which each viewer hears as it changes.
  let reading: ReturnType<typeof setTimeout> | undefined
  const statesChanged = (): void => {
    clearTimeout(reading)
    reading = setTimeout(() => void readStates(), STATE_MS)
  }
  const readStates = async (): Promise<void> => {
    if (shown.size === 0) return
    const running = await recordedSessions(roots.claudeHome)
    for (const [session, showing] of shown) {
      const entry = running.find((recorded) => recorded.sessionId === session)
      void showing.then((view) => {
        if (entry === undefined && view.wasRecorded) return void stoppedRunning(session, showing, view)
        view.wasRecorded ||= entry !== undefined
        const status = entry?.status ?? 'unknown'
        if (view.state.status === status) return
        view.state = { session, status }
        for (const viewer of viewersOf(session)) viewer.stream.write('state', view.state)
      }, () => undefined)
    }
  }
  // A session whose record is gone ends its `claude attach` and its viewers, unless the record comes back within
  // RESPAWN_MS, as Claude Code writes it again when it respawns the session. A record check that runs already, this
  // one's or the one an end of the attach started, decides alone.
  const stoppedRunning = async (session: string, showing: Promise<Shown>, view: Shown): Promise<void> => {
    if (view.recordCheck !== undefined) return
    console.error(`${new Date().toISOString()} Claude Code's record of ${session} is gone, so ${device.name} waits ${RESPAWN_MS / 1000} s for Claude Code to write it again, as it does when it respawns a session.`)
    if ((await checkRecord(view, () => keepsRunning(session))) || shown.get(session) !== showing) return
    stopShowing(session, { code: 0, message: stoppedOn(session) })
    view.terminal.close()
  }
  // The session moved to `to` and stops here: each viewer hears where it went, and attaches to it there, before its
  // `claude attach` here closes, so none of them sees it end.
  const movedAway = (session: string, to: string): void => {
    const showing = shown.get(session)
    shown.delete(session)
    for (const viewer of viewersOf(session)) {
      flushOutput(viewer)
      viewer.stream.write('moved', { to })
    }
    void showing?.then((view) => view.terminal.close(), () => undefined)
  }
  const mover: MoveHere = { moves, problems, environment, queue: (session, tool, path) => queue.add(session, tool, path), flush: (session, signal) => queue.flush(session, signal), movedAway, onRecordsChange }
  // Another machine moves a session here, or starts a new one here, and hears whether it runs.
  relay.on('move', (message) => void receiveMove(capture, message, { environment, checkouts, onRecordsChange }))
  relay.on('start', (message) => void receiveStart(capture, message, { environment, checkouts, onRecordsChange }))
  // Another machine took a session, and its background job here stops: at the `released` this socket takes, and at
  // each welcome of it for every job of a session the database names another holder of, as every program process here
  // writes the `released` it takes into the database, a command's connect too, whose `heard` ends the Pool's. The
  // database keeps the holder's name alone, which is all `receiveReleased` takes. Each job stops once, whichever comes.
  const releasing = new Set<string>()
  const release = (session: string, holder: string): void => {
    if (releasing.has(session)) return
    releasing.add(session)
    void receiveReleased(capture, session, holder, mover).finally(() => releasing.delete(session))
  }
  relay.on('released', ({ session, to }) => release(session, to.name))
  relay.on('welcome', async () => {
    for (const { sessionId, kind } of await recordedSessions(roots.claudeHome)) {
      const holder = journalOf(db, sessionId)?.holder ?? ''
      if (kind === 'background' && holder !== '') release(sessionId, holder)
    }
  })

  // Each `anyhost attach` on this machine. Its first text message is its attach, and so is each later one, with the
  // same stream, but `localNetwork`, which says what its last direct dial found of its terminal app's Local Network
  // access. A session this machine holds, this program shows it as it shows any viewer. Any other goes through
  // this program's one socket to the relay, to the machine that holds the session, and what the relay answers about
  // the stream goes back as it came. `isHere` says this program shows the leg's stream.
  type Leg = ServerWebSocket<{ stream?: number; isHere?: boolean }>
  const legs = new Map<number, Leg>()
  const toLeg = (stream: number, message: object | Uint8Array): void => void legs.get(stream)?.send(message instanceof Uint8Array ? message : JSON.stringify(message))
  const attachFrom = async (leg: Leg, asked: Omit<Extract<Routed, { readonly t: 'attach' }>, 'to'>): Promise<void> => {
    const { stream } = asked
    // a viewer whose session moved attaches again with a new stream, and the old one ends where it was
    const previous = leg.data.stream
    if (previous !== undefined && previous !== stream && legs.get(previous) === leg) {
      legs.delete(previous)
      if (leg.data.isHere === true) unlink(previous)
      else relay.send({ t: 'detach', stream: previous })
    }
    leg.data = { stream, isHere: false }
    legs.set(stream, leg)
    const showHere = async (session: string): Promise<void> => {
      leg.data.isHere = true
      const carrier: Carrier = { attached: (hostStream) => toLeg(stream, { t: 'attached', stream, hostStream, ...noOffer }), link: { send: (frame) => toLeg(stream, frame) }, isRelay: false }
      await show({ ...asked, session }, carrier)
    }
    // With no relay to say which machine holds the session, one Claude Code runs in this machine's background still
    // shows here, as `claude attach` shows it with no relay. Any other waits for the relay.
    const unanswered = async (reply: object): Promise<void> => {
      const here = (await recordedSessions(roots.claudeHome)).filter((entry) => entry.id !== undefined && entry.sessionId.startsWith(asked.session))
      if (legs.get(stream) !== leg) return
      const [only, ...more] = here
      if (only !== undefined && more.length === 0) return await showHere(only.sessionId)
      toLeg(stream, reply)
    }
    const offline = { t: 'offline', stream, to: '' }
    const { state } = relay
    if (state.is === 'connecting' || state.is === 'offline') return await unanswered(offline)
    if (state.is !== 'connected') return await unanswered({ t: 'invalid', message: state.message })
    const claims = await claimsOf(relay, asked.session).catch((error: unknown) => {
      console.error(`${new Date().toISOString()} anyhost could not read from the relay which machine holds ${asked.session}, so it answers that machine offline: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })
    // an `anyhost attach` that ended meanwhile attaches nothing
    if (legs.get(stream) !== leg) return
    if (claims === undefined) return await unanswered(offline)
    const exact = claims.get(asked.session)
    const matches = exact === undefined ? [...claims] : [[asked.session, exact] as const]
    const [found, ...more] = matches
    if (found === undefined || more.length > 0) {
      const message = found === undefined ? `No machine holds the session ${asked.session}. anyhost list shows every session.` : `${matches.length} sessions' ids begin with ${asked.session}. Give more of it.`
      return toLeg(stream, { t: 'invalid', message })
    }
    const [session, holder] = found
    if (holder.id === device.id) return await showHere(session)
    if (!relay.send({ ...asked, session, to: holder.id })) toLeg(stream, { t: 'offline', stream, to: holder.id })
  }

  relay.on('attach', (message) => {
    void direct.then(async (listener) => await show(message, throughRelayTo(message.stream, message.key, (await listener?.offer()) ?? noOffer, listener)))
  })
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
  // A new socket holds none of the streams the last one carried. The Pool tells a viewer so only once this machine's
  // last socket closed, while it still lists a half-open one, as this machine's after a sleep, so each viewer the relay
  // reached hears `detach` from here and attaches again, which links its stream again under the same `hostStream`. Each
  // `anyhost attach` here that views another machine's session hears `detach` too.
  relay.on('welcome', () => {
    for (const [stream, viewer] of viewers) {
      if (!viewer.carrier.isRelay || !viewer.isLinked) continue
      unlink(stream)
      relay.send({ t: 'detach', stream })
    }
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
      if (request.method !== 'POST') return failed(404, `${ROUTES}, not ${request.method} ${pathname}.`)
      const body = await request.json().catch((error: unknown) => new Error(`anyhost takes a JSON object at POST ${pathname}, and this body is none: ${error instanceof Error ? error.message : String(error)}`))
      if (body instanceof Error) return failed(400, body)
      return await act(pathname, body as Asked)
    },
    websocket: {
      message(leg, message) {
        if (typeof message === 'string') {
          const sent = JSON.parse(message) as Omit<Extract<Routed, { readonly t: 'attach' }>, 'to'> | { readonly t: 'localNetwork'; readonly problem: string }
          if (sent.t !== 'localNetwork') return void attachFrom(leg, sent)
          localNetworkProblem = sent.problem === '' ? undefined : sent.problem
          return
        }
        const { stream, isHere } = leg.data
        if (stream === undefined) return
        const frame = new Uint8Array(message)
        if (isHere === true) viewers.get(stream)?.stream.receive(frame)
        // A frame the relay refused, as while this machine's socket is down, went nowhere, so `anyhost attach` hears
        // `offline` with its offset and counts no frame from there on as carried, nor the keys it takes until it links
        // again: a new host stream gets them all.
        else if (!relay.send(encodeStream(stream, frame))) toLeg(stream, { t: 'offline', stream, to: '', at: offsetOf(frame) })
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
