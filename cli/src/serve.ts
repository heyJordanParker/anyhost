import type { Subprocess } from 'bun'
import type { CmodInterfaces } from 'claude-code'
import { once } from 'node:events'
import { rmSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { provide, providers, type Usage } from '@cmodjs/core/mod.js'
import { connect, NotHeld } from '@cmodjs/core/rpc.js'
import { Activity, type Shown } from './activity.ts'
import { changedFiles, countedRelay, forgetUnstarted, indexForkStarts, recordName, isHeavyUpload, isUpkeepDue, journalOf, openCapture, recordFolder, recordSource, recordSummaryFrom, relistSessions, openDatabase, QUIET_MS, rewriteNext, readsKeptIn, keptAnswer, rewriteProgress, sealQuiet, sessionsOf, startCode, startLineOffsets, untoldOf, uploadSessions, writeIndex, type Capture, type Changed, type Fleet, type Problems } from './capture.ts'
import { loginEnvironment, markersIn, pausedSessions, recordedSessions, saveLoginEnvironment, stopCopy, type OnRecordsChange } from './claude.ts'
import { connectForStep, join as joinRelay, LoginNeeded, needsUpload, updateRelay, type Cloudflare, type ConnectRun, type Connecting, type RelayNames } from './connect.ts'
import { cmod, dataFolders, dataRoot, devicesOf, forgetRelayLogin, inviteMachine, personOptions, relayLogin, removeMachine, rootsHere, stateFolder, type DataFolder, type Device } from './device.ts'
import { coreEnvironment, followTerminals, hcPath, isKeptShell, isShown, killTerminal, shownAt, label, machinesReached, SESSION_LABEL, shellsOf, SHOWN_LABEL, SHOWN_MS, SLEEP_LABEL, type Terminal, type TerminalChange } from './hc.ts'
import { PLACES, type Place } from './herdr.ts'
import { addMachine, candidatesOf, keepHerdrReaching, reachedAt } from './machines.ts'
import { activityOf, deleteAgent, deleteOrphans, forkAgent, keepHere, sessionOf, move, noteWaiting, placeSession, receiveDelete, receiveFork, receiveList, receiveReleased, receiveTell, openHere, resumeInPlace, showAgent, startNew, statusesElsewhere, statusesHere, tell, type MoveHere, type Moving } from './move.ts'
import { connectRelay, isRowsLimit, ROWS_LIMIT, waitAfter, type Login, type Relay, type RelayState, type Written } from './relay.ts'
import { readSession } from './resume.ts'
import { HOOK_EVENTS, type AgentStatus, type DeviceRef, type HookEvent, type Routed } from '../../relay/protocol.ts'
import { agentsOf, indexesIn, indexKeyOf, type Agent, type ListRead } from './sessions.ts'
import { archive, isArchived, moveWindowPreferences, nameProject, organize, pin, settle as settleSession, SETTLE_MOST_DAYS, SHARED_KEY, sharedIn, sharedOf, snooze, updateShared, visit, windowsIn, windowsKeyOf, type Attention, type Organize } from './shared.ts'
import { copyT3Marks } from './t3.ts'
import { codexSessionOf, codexState, familyOf, filesUnder, isCodexRun, transcriptOf, watchedFolders, type Tool } from './transcript.ts'

const BACKUP_MS = Number(process.env['ANYHOST_BACKUP_MS'] ?? 60_000)
const SWEEP_ALL_MS = 60 * 60_000
const READ_MS = 1000
const CORE_MARKERS = 'herdr-core markers'
export const WATCHER = `
const { join, sep } = require('node:path')
const { watch, writeFileSync } = require('node:fs')
const { probe, folders } = JSON.parse(process.argv.at(-1))
if (process.env.ANYHOST_WATCHER_HANGS === '1') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
const isDropping = process.env.ANYHOST_WATCHER_DROPS === '1'
const end = () => process.kill(process.pid, 'SIGKILL')
const endAtClosedOutput = (error) => {
  if (error.code !== 'EPIPE') throw error
  end()
}
const say = (line) => {
  try {
    process.stdout.write(line + '\\n')
  } catch (error) {
    endAtClosedOutput(error)
  }
}
process.stdout.on('error', endAtClosedOutput)
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
process.stdin.on('end', end).resume()
`
const WATCHER_MS = 10_000
const RUNNING_MS = 2000
const STATUSES_FRESH_MS = 10_000
const LIST_FRESH_MS = 5000
const LIST_WAIT_MS = 25_000
const STOP_MS = Number(process.env['ANYHOST_STOP_MS'] ?? 24 * 60 * 60_000)
const DISCARD_EVERY_MS = Number(process.env['ANYHOST_DISCARD_EVERY_MS'] ?? Math.min(30_000, STOP_MS / 4))
const RESUME_IN_PLACE_MS = 60_000
const UPDATE_FIRST_MS = 60_000
const UPDATE_MOST_MS = 60 * 60_000
const SHOWN_EVERY_MS = 30_000
const ROUTES = 'anyhost serves GET /status, /machines, /agents and /claims/<session>, POST /connect, /connect/account, /connect/r2, /join, /machines/add, /machines/invite, /machines/remove, /move, /move/keep, /new, /agents/tell, /agents/open, /agents/archive, /agents/settle, /agents/snooze, /agents/visit, /agents/pin, /agents/delete, /agents/fork, /agents/show, /organize, /projects/name, /settings, /sessions/changed and /shown'

export const serveSocket = (): string => join(stateFolder(), 'serve.sock')

export const PROGRAM_RESTART_MS = 45_000
const PROGRAM_AGAIN_MS = 250
const NO_PROGRAM = new Set(['ENOENT', 'ECONNREFUSED'])

export async function askProgram<T>(path: string, body?: object, waitMs = 0): Promise<T | undefined> {
  const unix = serveSocket()
  const started = Date.now()
  for (;;) {
    let lost: Error | undefined
    const answer = await fetch(`http://localhost${path}`, { unix, timeout: false, ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }).catch((error: unknown) => {
      if (!NO_PROGRAM.has((error as NodeJS.ErrnoException).code ?? '')) lost = new Error(`The anyhost program at ${unix} gave no answer to ${path}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })
    if (answer !== undefined) {
      const read = (await answer.json()) as T & { readonly message?: string }
      if (!answer.ok) throw new Error(read.message ?? `The anyhost program at ${unix} answered ${path} with ${answer.status}.`)
      return read
    }
    if (Date.now() - started >= waitMs) {
      if (lost !== undefined) throw lost
      return undefined
    }
    await Bun.sleep(PROGRAM_AGAIN_MS)
  }
}

export const uploadEveryOf = (chosen: number | undefined): number => chosen ?? 5

export type Status = {
  readonly device: Device
  readonly relay: { readonly url: string; readonly state: RelayState['is']; readonly message: string; readonly bucket: string }
  readonly pending: number
  readonly uploadEvery: number
  readonly capturedAt: string
  readonly problems: readonly string[]
  readonly journalGaps: readonly string[]
  readonly rewritten?: { readonly done: number; readonly journals: number }
  readonly updateProblem?: string
  readonly needsLogin?: true
  readonly coreProblem?: string
  readonly connecting?: Connecting
  readonly joining?: { readonly is: 'running' } | { readonly is: 'failed'; readonly error: string }
}
export type JoinedRelay = { readonly url: string }
type Upload = (sessions: readonly Changed[]) => readonly (readonly [Changed, Promise<Set<string>>])[]
type Uploaded = { readonly left: ReadonlySet<string> } | { readonly error: unknown }

export class UploadQueue {
  private readonly queued = new Map<string, { tool: Tool; paths: Set<string> }>()
  private readonly uploading = new Set<string>()
  private readonly asked = new Set<string>()
  private readonly failures = new Map<string, number>()
  private readonly ended = new Map<string, ((end: Uploaded) => void)[]>()
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

  drain(): void {
    for (const wake of this.relayWaits) wake()
    this.drainSessions([...this.queued.keys()])
  }

  uploadNow(session: string): void {
    if (this.uploading.has(session)) this.asked.add(session)
    else this.drainSessions([session])
  }

  async flush(session: string, signal: AbortSignal, onRelay: (isConnected: boolean) => void): Promise<void> {
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
      if (!this.uploading.has(session)) return
      const end = await this.uploadEnd(session, signal)
      if ('error' in end) throw end.error
      isOwed = (isOwed && isInFlight) || end.left.size > 0
      isInFlight = false
    }
  }

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
          const now = this.queued.get(session) ?? { tool: queued.tool, paths: new Set<string>() }
          for (const path of left) now.paths.add(path)
          if (now.paths.size > 0) this.queued.set(session, now)
          if (this.asked.delete(session) || this.every === 0) this.drainSessions([session])
          this.uploaded(session, { left })
        },
        (error: unknown) => {
          this.uploading.delete(session)
          const now = this.queued.get(session) ?? { tool: queued.tool, paths: new Set() }
          this.queued.set(session, { tool: now.tool, paths: new Set([...queued.paths, ...now.paths]) })
          this.onFailure(session, error)
          const failures = (this.failures.get(session) ?? 0) + 1
          this.failures.set(session, failures)
          if (this.asked.delete(session) || this.every === 0) setTimeout(() => this.drainSessions([session]), waitAfter(failures))
          this.uploaded(session, { error })
        },
      )
    }
  }
}

type Upkeep = {
  readonly sealWaits: readonly (readonly [string, { readonly failures: number; readonly passes: number }])[]
  readonly fleet: Omit<Fleet, 'removed'> & { readonly removed: readonly string[] }
  readonly journalsInR2: { readonly readAt: number; readonly isRewritten: readonly (readonly [string, boolean])[] }
}
type Work = { readonly upload: { readonly session: string; readonly tool: Tool; readonly paths: readonly string[] } } | { readonly upkeep: Upkeep & { readonly codeBusy: readonly string[] } }
type Job = { readonly login: Login; readonly dataFolders: readonly DataFolder[]; readonly isEveryWrite: boolean } & Work
type JobLine = {
  readonly problem?: string
  readonly message?: string
  readonly clear?: string
  readonly released?: readonly [string, string]
  readonly left?: readonly string[]
  readonly again?: readonly (readonly [string, readonly string[]])[]
  readonly upkeep?: Upkeep
  readonly rewrote?: boolean
  readonly written?: Written
  readonly error?: string
}

const upkeepOf = (capture: Capture): Upkeep => ({
  sealWaits: [...capture.sealWaits],
  fleet: { ...capture.fleet, removed: [...capture.fleet.removed] },
  journalsInR2: { readAt: capture.journalsInR2.readAt, isRewritten: [...capture.journalsInR2.isRewritten] },
})

function keepUpkeep(capture: Capture, upkeep: Upkeep): void {
  capture.sealWaits.clear()
  for (const [session, wait] of upkeep.sealWaits) capture.sealWaits.set(session, { ...wait })
  capture.fleet = { ...upkeep.fleet, removed: new Set(upkeep.fleet.removed) }
  capture.journalsInR2 = { readAt: upkeep.journalsInR2.readAt, isRewritten: new Map(upkeep.journalsInR2.isRewritten) }
}

const ownCommand = (): string[] => (import.meta.dir.startsWith('/$bunfs/') ? [process.execPath] : [process.execPath, join(import.meta.dir, 'main.ts')])

export async function work(device: Device): Promise<void> {
  let relay: Relay | undefined
  const end = (): never => {
    relay?.close()
    process.exit(1)
  }
  const program = createInterface({ input: process.stdin }).once('close', end)
  const [line] = (await once(program, 'line')) as [string]
  const job = JSON.parse(line) as Job
  const endAtClosedOutput = (error: NodeJS.ErrnoException): void => {
    if (error.code !== 'EPIPE') throw error
    end()
  }
  process.stdout.on('error', endAtClosedOutput)
  const say = (line: JobLine): void => {
    try {
      process.stdout.write(`${JSON.stringify(line)}\n`)
    } catch (error) {
      endAtClosedOutput(error as NodeJS.ErrnoException)
    }
  }
  const roots = rootsHere()
  relay = connectRelay({ login: async () => job.login, forget: async () => undefined, device, roots, isPatient: true })
  relay.on('written', (written) => say({ written }))
  const capture = openCapture(relay, device, roots, { readsCode: false, onReleased: (session, holder) => say({ released: [session, holder] }) })
  capture.dataFolders = job.dataFolders
  const problems: Problems = { set: (key, error) => say({ problem: key, message: error instanceof Error ? error.message : String(error) }), clear: (key) => say({ clear: key }) }
  try {
    if ('upload' in job) {
      const { session, tool, paths } = job.upload
      const left = await uploadSessions(capture, [{ session, tool, paths: new Set(paths) }], problems, job.isEveryWrite)[0]?.[1]
      say({ left: [...(left ?? [])] })
      return
    }
    keepUpkeep(capture, job.upkeep)
    for (const session of job.upkeep.codeBusy) capture.codeRuns.set(session, new Promise(() => undefined))
    const again = await sealQuiet(capture, problems)
    const rewrote = (await rewriteNext(capture, problems)) !== undefined
    say({ again: [...again].map(([session, files]) => [session, [...files]] as const), upkeep: upkeepOf(capture), rewrote })
  } catch (error) {
    say({ error: error instanceof Error ? error.message : String(error) })
  } finally {
    program.off('close', end).close()
    relay.close()
  }
}

export async function serve(device: Device, names?: RelayNames, cloudflare?: Cloudflare): Promise<void> {
  const socket = serveSocket()
  const running = await fetch('http://localhost/status', { unix: socket, signal: AbortSignal.timeout(RUNNING_MS) }).then(
    async (answer) => (await answer.json()) as Status,
    () => undefined,
  )
  if (running !== undefined) throw new Error(`The anyhost program of ${running.device.name} already answers at ${socket}, so this one does not start. Two programs on one state folder would both write its database.`)
  rmSync(join(stateFolder(), 'compact'), { recursive: true, force: true })
  const roots = rootsHere()
  const db = openDatabase()
  const relay = connectRelay({
    login: relayLogin,
    forget: forgetRelayLogin,
    device,
    roots,
    isPatient: true,
    readsKept: readsKeptIn(db),
    onOlderProgram: (message) => {
      console.error(`${new Date().toISOString()} ${message} So anyhost exits, and its service starts it again from the anyhost cmod links.`)
      process.exit(1)
    },
  })
  let release =(_session: string, _holder: string): void => undefined
  let place = (_session: string): void => undefined
  const capture = openCapture(relay, device, roots, {
    db,
    onCode: (session, tool, folder) => queue.add(session, tool, `${folder}/`),
    onReleased: (session, holder) => release(session, holder),
    onPlaced: (changes) => {
      sessionsChanged()
      for (const { session } of changes) place(session)
      void releaseHeld(new Set(changes.map(({ session }) => session))).catch(readFailed('the sessions another machine took'))
    },
    onOtherRelay: (url, bucket) => {
      console.error(`${new Date().toISOString()} This machine connects to the relay at ${url}, whose bucket is ${bucket}, not to the one its database counts, so anyhost exits, and its service starts it again on that relay.`)
      process.exit(0)
    },
  })
  const heartbeat = join(stateFolder(), 'heartbeat')
  const current = new Map<string, string>()
  let joining: Status['joining'] = { is: 'running' }
  let capturedAt = ''
  let sweptAllAt = 0
  let checkouts = ''

  const problems: Problems = {
    set(key, error) {
      const reason = error instanceof AggregateError ? error.errors.map(String).join(', ') : String(error)
      const limited = isRowsLimit(reason)
      const said = limited ? `relay: ${ROWS_LIMIT}` : `${key}: ${reason}`
      const name = limited ? 'relay' : key
      if (current.get(name)?.endsWith(` ${said}`) === true || (limited && current.has('relay'))) return
      const message = `${new Date().toISOString()} ${said}`
      current.set(name, message)
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
  const run = crypto.randomUUID().slice(0, 8)
  let sessionsChanges = 0
  const sessionsVersion = (): string => `${run}.${sessionsChanges}`
  const versionWaits = new Set<() => void>()
  const sessionsChanged = (): void => {
    sessionsChanges += 1
    for (const wake of versionWaits) wake()
  }
  let activityChanged = (): void => undefined
  let announceWrite: (written: Written) => void = () => undefined
  const changedAfter = (version: string): Promise<void> =>
    version !== sessionsVersion()
      ? Promise.resolve()
      : new Promise((resolve) => {
          const wake = (): void => {
            versionWaits.delete(wake)
            clearTimeout(timer)
            resolve()
          }
          const timer = setTimeout(wake, LIST_WAIT_MS)
          versionWaits.add(wake)
        })
  const runJob = async (work: Work, what: string): Promise<JobLine> => {
    const login = await relayLogin()
    if (login === undefined) throw new Error('This machine is not joined to your relay, so anyhost uploads nothing.')
    const job: Job = { login, dataFolders: capture.dataFolders, isEveryWrite: queue.uploadEvery === 0, ...work }
    const child = Bun.spawn([...ownCommand(), 'work'], { env: process.env, stdin: new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode(`${JSON.stringify(job)}\n`)) }), stdout: 'pipe', stderr: 'inherit' })
    let answer: JobLine | undefined
    let failure = ''
    const heard = (line: string): void => {
      const said = JSON.parse(line) as JobLine
      if (said.problem !== undefined) problems.set(said.problem, said.message)
      if (said.clear !== undefined) problems.clear(said.clear)
      if (said.released !== undefined) capture.onReleased(...said.released)
      if (said.written !== undefined) announceWrite(said.written)
      if (said.left !== undefined || said.upkeep !== undefined) answer = said
      if (said.error !== undefined) failure = said.error
    }
    const decoder = new TextDecoder()
    let rest = ''
    for await (const chunk of child.stdout) {
      const lines = (rest + decoder.decode(chunk, { stream: true })).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) if (line.startsWith('{')) heard(line)
    }
    await child.exited
    if (answer === undefined) throw new Error(failure || `anyhost work for ${what} exited with ${child.exitCode} and answered nothing.`)
    return answer
  }
  let jobs: Promise<unknown> = Promise.resolve()
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const ran = jobs.then(run)
    jobs = ran.catch(() => undefined)
    return ran
  }
  const uploadInJob = (changed: Changed): Promise<Set<string>> =>
    inTurn(async () => {
      const { left = [] } = await runJob({ upload: { session: changed.session, tool: changed.tool, paths: [...changed.paths] } }, changed.session)
      startCode(capture, changed.session, changed.tool, problems)
      return new Set(left)
    })
  let isRewriting = true
  const upkeepInJob = (): Promise<void> =>
    inTurn(async () => {
      if (!isRewriting && !isUpkeepDue(capture)) return
      const codeBusy = [...new Set([...capture.codeRuns.keys(), ...capture.codeWaiting.keys()])]
      const { again = [], upkeep, rewrote = false } = await runJob({ upkeep: { ...upkeepOf(capture), codeBusy } }, 'the seals and rewrites')
      if (upkeep !== undefined) keepUpkeep(capture, upkeep)
      isRewriting = rewrote
      queueFiles(new Map(again.map(([session, files]) => [session, new Set(files)])))
    })
  const sourcesWaiting = new Map<string, string>()
  const placeSource = (session: string): void => {
    const source = sourcesWaiting.get(session)
    if (source === undefined || capture.db.query('select 1 from sessions where id = ?').get(session) === null) return
    sourcesWaiting.delete(session)
    if (recordSource(capture.db, session, source)) sessionsChanged()
  }
  const uploaded = (changed: Changed, upload: Promise<Set<string>>): readonly [Changed, Promise<Set<string>>] => [
    changed,
    upload.then((left) => {
      problems.clear(`upload ${changed.session}`)
      problems.clear('relay')
      capturedAt = new Date().toISOString()
      placeSource(changed.session)
      sessionsChanged()
      return left
    }),
  ]
  const queue = new UploadQueue(
    uploadEveryOf(undefined),
    (sessions) => {
      const heavy = Promise.all(sessions.map((changed) => isHeavyUpload(capture, changed)))
      const light = heavy.then((isHeavy) => {
        const each = sessions.filter((_, at) => isHeavy[at] !== true)
        return new Map(each.length === 0 ? [] : uploadSessions(capture, each, problems, queue.uploadEvery === 0))
      })
      return sessions.map((changed, at) => uploaded(changed, heavy.then(async (isHeavy) => (isHeavy[at] === true ? await uploadInJob(changed) : await ((await light).get(changed) ?? Promise.resolve(new Set<string>()))))))
    },
    (session, error) => problems.set(`upload ${session}`, error),
    () => relay.state.is === 'connected',
  )
  let isTidied = false
  relay.on('welcome', () => {
    joining = undefined
    queue.drain()
    if (isTidied) return
    isTidied = true
    void settle('tidy', async () => {
      const relisted = await relistSessions(capture)
      if (relisted > 0) console.error(`${new Date().toISOString()} anyhost listed ${relisted} sessions again from their transcripts here and their journals in R2.`)
      await writeIndex(capture)
    })
  })
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
  const othersStatuses = new Map<string, { readonly shown: Shown; readonly at: number }>()
  const moves = new Map<string, Moving>()
  const mover: MoveHere = {
    moves,
    placing: new Map(),
    placed: new Set(),
    problems,
    get checkouts() {
      return checkouts
    },
    queue: (session, tool, path) => queue.add(session, tool, path),
    flush: (session, signal, onRelay) => queue.flush(session, signal, onRelay),
    onRecordsChange,
    opening: new Map(),
    touched: new Map(),
    activity: new Activity(),
    onStatusElsewhere: (machine, session, status) => {
      const { statuses, since, background } = othersStatuses.get(machine)?.shown ?? { statuses: {}, since: {}, background: [] }
      if (statuses[session] === status || (status === 'working' && background.includes(session))) return
      othersStatuses.set(machine, { shown: { statuses: { ...statuses, [session]: status }, since: Object.fromEntries(Object.entries(since).filter(([id]) => id !== session)), background: background.filter((id) => id !== session) }, at: Date.now() })
      sessionsChanged()
    },
    terminalNow: (session) => sessionTerminals().get(session),
  }
  const noteChildren = noteWaiting(capture, mover)
  const archivedBusy = new Set<string>()
  let closingSettled = Promise.resolve()
  const closeSettled = async (): Promise<void> => {
    for (const session of archivedBusy) {
      const status = await activityOf(capture, mover.activity, session)
      if (status === 'working' || status === 'waiting') continue
      archivedBusy.delete(session)
      await stopCopy(capture.roots.claudeHome, session)
    }
  }
  const recordsChanged = (): void => {
    activityChanged()
    noteChildren()
    labelNow()
    if (archivedBusy.size > 0) closingSettled = closingSettled.then(() => settle('archived', () => closeSettled()))
    sessionsChanged()
    for (const read of recordsHeard) read()
  }
  const archiveSession = async (asked: string, archived: boolean): Promise<void> => {
    const id = await sessionOf(capture, asked)
    const status = await activityOf(capture, mover.activity, id)
    const isBusy = status === 'working' || status === 'waiting'
    if (archived && isBusy) archivedBusy.add(id)
    else archivedBusy.delete(id)
    if (archived && !isBusy) await stopCopy(capture.roots.claudeHome, id)
    await archive(relay, id, archived)
  }
  const attentionHere = (session: string): Attention | undefined => {
    const row = capture.db.query<{ last_activity: string; last_prompt_at: string }, [string]>('select last_activity, last_prompt_at from sessions where id = ?').get(session)
    return row === null || row.last_activity === '' ? undefined : { id: session, lastActivity: row.last_activity, lastPromptAt: row.last_prompt_at, waitingSince: '' }
  }
  const restoreOpened = (session: string): void => {
    const attention = attentionHere(session)
    if (attention === undefined) return
    void sharedOf(relay)
      .then(async (shared) => (isArchived(shared, attention) ? await archive(relay, session, false) : undefined))
      .catch((error: unknown) => console.error(`${new Date().toISOString()} anyhost could not restore ${session.slice(0, 8)}, which an open brought back: ${error instanceof Error ? error.message : String(error)}`))
  }

  let terminals: ReadonlyMap<string, Terminal> = new Map()
  const isHere = (address: string): boolean => !address.includes('/')
  const sessionIn = (address: string): string => terminals.get(address)?.labels[SESSION_LABEL] ?? ''
  const sessionTerminals = (): Map<string, string> => {
    const running = new Map<string, string>()
    for (const [address, terminal] of terminals) if (isHere(address) && terminal.state === 'live' && sessionIn(address) !== '') running.set(sessionIn(address), address)
    return running
  }
  const labelledAs = new Map<string, string>()
  const labelOwnRuns = async (): Promise<void> => {
    const sessionOfPid = new Map((await recordedSessions(roots.claudeHome)).map(({ pid, sessionId }) => [pid, sessionId]))
    for (const [address, terminal] of terminals) {
      if (!isHere(address) || terminal.state !== 'live') continue
      const codex = terminal.foreground !== null && sessionIn(address) === '' && isCodexRun(terminal.foreground.argv) ? codexSessionOf(terminal.foreground.pid) : undefined
      const pid = [terminal.pid, terminal.foreground?.pid].find((each): each is number => typeof each === 'number' && sessionOfPid.has(each))
      const session = codex ?? (pid === undefined ? undefined : sessionOfPid.get(pid))
      const run = `${session}\0${pid ?? terminal.foreground?.pid ?? ''}`
      if (session === undefined || sessionIn(address) === session || labelledAs.get(address) === run) continue
      await label(address, SESSION_LABEL, session)
      labelledAs.set(address, run)
    }
  }
  const unlabelShellsOf = async (session: string): Promise<void> => {
    for (const address of shellsOf(terminals, session)) await label(address, SESSION_LABEL, '')
  }
  let labelling = Promise.resolve()
  const labelNow = (): void => void (labelling = labelling.then(() => settle('labelled', labelOwnRuns)))
  const isAsleepRunner = (terminal: Terminal, record: { readonly pid: number } | undefined): boolean => {
    const [program = '', command] = terminal.foreground?.argv ?? []
    if (basename(program) !== 'anyhost' || command !== 'run' || terminal.foreground === null) return false
    return record === undefined || !familyOf(terminal.foreground.pid).includes(record.pid)
  }
  const resumedIn = new Map<string, number>()
  const keepSessionIn = async (address: string, session: string): Promise<void> => {
    if (Date.now() - (resumedIn.get(address) ?? 0) < RESUME_IN_PLACE_MS) return
    const attention = attentionHere(session)
    const isHeldHere = (journalOf(capture.db, session)?.holder ?? '') === ''
    const isGone = !isHeldHere || (attention !== undefined && isArchived(await sharedOf(relay), attention))
    if (isGone) return void (await killTerminal(address))
    resumedIn.set(address, Date.now())
    await resumeInPlace(capture, session, address).catch(async (error: unknown) => {
      console.error(`${new Date().toISOString()} anyhost closes ${address}, as ${session.slice(0, 8)} could not resume in it: ${error instanceof Error ? error.message : String(error)}`)
      await killTerminal(address)
    })
  }
  const discardIdle = async (): Promise<void> => {
    const records = new Map((await recordedSessions(roots.claudeHome)).map((record) => [record.sessionId, record]))
    const now = Date.now()
    for (const [address, terminal] of terminals) {
      const session = sessionIn(address)
      if (!isHere(address) || session === '' || terminal.state !== 'live') continue
      const record = records.get(session)
      if (isKeptShell(terminal)) {
        await keepSessionIn(address, session)
        continue
      }
      if (isAsleepRunner(terminal, record)) {
        await killTerminal(address)
        continue
      }
      if (record === undefined || mover.activity.of(record) !== 'idle') continue
      const since = record.statusSince ?? now
      const isAsked = Number(terminal.labels[SLEEP_LABEL] ?? 0) > (Date.parse(attentionHere(session)?.lastPromptAt ?? '') || 0)
      const lastActive = Math.max(since, shownAt(terminal.labels), mover.touched.get(session) ?? 0)
      if (!isAsked && (isShown(terminal.labels, now) || now - lastActive < STOP_MS)) continue
      await stopIfStillIdle(session, record.statusSince, now, isAsked)
    }
  }
  const stopIfStillIdle = async (session: string, since: number | undefined, decidedAt: number, isAsked: boolean): Promise<void> => {
    const isTouched = (): boolean => mover.opening.has(session) || (mover.touched.get(session) ?? 0) >= decidedAt
    if (isTouched()) return
    const record = (await recordedSessions(roots.claudeHome)).find((entry) => entry.sessionId === session)
    if (record === undefined || record.statusSince !== since || mover.activity.of(record) !== 'idle' || isTouched()) return
    if (!isAsked && (await sharedOf(relay).catch(() => sharedIn(relay.cached([SHARED_KEY])[0]))).pinned[session] !== undefined) return
    await stopCopy(roots.claudeHome, session)
  }
  let isDiscarding = false
  const discardNow = (): void => {
    if (isDiscarding) return
    isDiscarding = true
    void settle('discard', discardIdle).finally(() => (isDiscarding = false))
  }
  setInterval(discardNow, DISCARD_EVERY_MS)
  const isClosedByPerson = (terminal: Terminal | undefined): boolean => terminal !== undefined && (terminal.reason === 'killed' || (terminal.reason === 'exited' && terminal.exitCode === 0))
  const archiveClosed = (change: TerminalChange): void => {
    const session = sessionIn(change.address)
    if ((change.type !== 'finished' && change.type !== 'lost') || !isHere(change.address) || session === '' || !isClosedByPerson(terminals.get(change.address))) return
    void settle('closed', async () => {
      await archiveSession(session, true)
      sessionsChanged()
    })
  }

  const shownKey = `${SHOWN_LABEL}${device.id}`
  const windows = new Map<string, { readonly terminals: readonly string[]; readonly at: number }>()
  const labelledShown = new Map<string, number>()
  const unvisited = new Set<string>()
  let shownSessions = new Set<string>()
  const sessionTerminalsOf = (addresses: ReadonlySet<string>): Map<string, string> => {
    const shown = new Map<string, string>()
    for (const address of addresses) if (terminals.get(address)?.state === 'live' && sessionIn(address) !== '') shown.set(address, sessionIn(address))
    return shown
  }
  const visitedAt = (session: string): string => {
    const lastActivity = capture.db.query<{ last_activity: string }, [string]>('select last_activity from sessions where id = ?').get(session)?.last_activity ?? ''
    return new Date(Math.max(Date.now(), Date.parse(lastActivity) || 0)).toISOString()
  }
  const showTerminals = async (): Promise<void> => {
    const now = Date.now()
    for (const [id, window] of windows) if (now - window.at > SHOWN_MS) windows.delete(id)
    const shown = sessionTerminalsOf(new Set([...windows.values()].flatMap((window) => window.terminals)))
    for (const address of shown.keys()) {
      if (now - (labelledShown.get(address) ?? 0) < SHOWN_EVERY_MS) continue
      await label(address, shownKey, String(now))
      labelledShown.set(address, now)
    }
    for (const address of labelledShown.keys()) if (!shown.has(address)) labelledShown.delete(address)
    const sessions = new Set(shown.values())
    for (const session of sessions) if (!shownSessions.has(session)) unvisited.add(session)
    shownSessions = sessions
    for (const session of unvisited) {
      await visit(relay, session, visitedAt(session))
      unvisited.delete(session)
      sessionsChanged()
    }
  }
  let isShowing = false
  let isShowStale = false
  const showNow = async (): Promise<void> => {
    if (isShowing) return void (isShowStale = true)
    isShowing = true
    try {
      do {
        isShowStale = false
        await settle('shown', showTerminals)
      } while (isShowStale)
    } finally {
      isShowing = false
    }
  }
  const SHOWN_CHANGES = new Set(['created', 'restarted', 'labels', 'finished', 'removed'])
  const checkCoreMarkers = async (): Promise<void> => {
    const markers = markersIn(await coreEnvironment())
    if (markers.length === 0) return problems.clear(CORE_MARKERS)
    problems.set(CORE_MARKERS, `herdr-core gives every terminal it starts ${markers.join(', ')}, which it took from the Claude Code session that started it, so a claude typed into one of its shells saves no transcript and anyhost backs up nothing of that session.`)
  }
  const stopFollowing = followTerminals((now, change) => {
    terminals = now
    if (change === undefined) void settle('herdr-core environment', checkCoreMarkers)
    if (change === undefined || change.type === 'created' || change.type === 'restarted' || (change.type === 'foreground' && isCodexRun(now.get(change.address)?.foreground?.argv ?? []))) labelNow()
    if (change === undefined || (change.type === 'labels' && (now.get(change.address)?.labels[SLEEP_LABEL] ?? '') !== '')) discardNow()
    if (change !== undefined) archiveClosed(change)
    if (change?.type === 'turn' && labelledShown.has(change.address) && sessionIn(change.address) !== '') unvisited.add(sessionIn(change.address))
    if (change === undefined || change.type === 'turn' || SHOWN_CHANGES.has(change.type)) void showNow()
  })
  setInterval(() => void showNow(), SHOWN_EVERY_MS)
  const watchable: readonly { readonly folder: string; readonly depth: number }[] = [...watchedFolders(roots), { folder: records, depth: 1 }, { folder: dataRoot(), depth: Infinity }]
  const heard = (path: string): void => {
    if (watchable.some(({ folder }) => folder === path)) void watchFolders()
    if (dirname(path) === records) return recordsChanged()
    if (path.startsWith(`${join(roots.codexHome, 'sessions')}/`) && [...terminals].some(([address, terminal]) => isHere(address) && sessionIn(address) === '' && isCodexRun(terminal.foreground?.argv ?? []))) labelNow()
    const changed = path.startsWith(codexState(roots)) ? codexState(roots) : path
    void sessionsOf(capture, path).then(
      (owners) => {
        for (const { session, tool } of owners) queue.add(session, tool, changed)
      },
      (error: unknown) => problems.set(path, error),
    )
  }
  const watched = new Map<string, string>()
  const probe = join(stateFolder(), 'watcher')
  let ready: { readonly child: Subprocess; readonly folders: ReadonlyMap<string, string>; readonly at: number } | undefined
  let starting: Subprocess | undefined
  let watcherFailures = 0
  let nextWatcher: ReturnType<typeof setTimeout> | undefined
  const hears = (folder: string): boolean => watched.has(folder) && ready?.folders.get(folder) === watched.get(folder)
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
  const lastRanAt = await stat(heartbeat).then((found) => found.mtimeMs, () => Date.now())
  const unheard = new Map<string, number>()
  const unheardFrom = (since: number, folders: readonly string[] = watchable.map(({ folder }) => folder)): void => {
    for (const folder of folders) unheard.set(folder, Math.min(unheard.get(folder) ?? Infinity, since))
  }
  unheardFrom(lastRanAt)
  const endReady = (): void => {
    if (ready === undefined) return
    ready.child.kill('SIGKILL')
    unheardFrom(Date.now(), [...ready.folders.keys()])
    ready = undefined
    followRecords()
  }
  const listedAt = new Map<string, number>()
  const unnamed = (folder: string, readyAt: number): void => {
    unheardFrom(Math.max(listedAt.get(folder) ?? 0, readyAt), [folder])
    void watchFolders()
    void listWritten()
  }
  const startWatcher = (): Promise<void> => {
    starting?.kill('SIGKILL')
    clearTimeout(nextWatcher)
    const settled = Promise.withResolvers<void>()
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
    let readyAt: number | undefined
    const gotReady = (): void => {
      clearTimeout(limit)
      starting = undefined
      const before = ready
      readyAt = Date.now()
      ready = { child, folders: hearing, at: readyAt }
      before?.child.kill('SIGKILL')
      unheardFrom(readyAt, folders.map(({ folder }) => folder).filter((folder) => !hearing.has(folder)))
      watcherFailures = 0
      problems.clear('watcher')
      followRecords()
      void listWritten()
      settled.resolve()
    }
    const lose = (folder: string): void => {
      hearing.delete(folder)
      if (child !== ready?.child || readyAt === undefined) return
      followRecords()
      unnamed(folder, readyAt)
    }
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
  const listOnce = async (): Promise<void> => {
    const [started, listing] = [Date.now(), new Map(unheard)]
    unheard.clear()
    for (const { folder, depth } of watchable) {
      const since = listing.get(folder)
      if (since === undefined || !watched.has(folder)) continue
      listedAt.set(folder, started)
      for (const { path, mtimeMs } of await filesUnder(folder, depth)) if (mtimeMs >= since) heard(path)
    }
    const isHeard = (folder: string): boolean => (ready?.at ?? Infinity) <= started && hears(folder)
    unheardFrom(started, watchable.map(({ folder }) => folder).filter((folder) => !isHeard(folder)))
  }
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
  let updateAt = 0
  let updateWait = UPDATE_FIRST_MS
  let isLoginNeeded = false
  const updateDone = (): void => {
    problems.clear('relay update')
    updateAt = 0
    updateWait = UPDATE_FIRST_MS
    isLoginNeeded = false
  }
  const joined = (): void => {
    joining = undefined
    updateDone()
    relay.reconnect()
  }
  let connecting: ConnectRun | undefined
  const keepRelayCurrent = async (): Promise<void> => {
    const { state } = relay
    if (Date.now() < updateAt || !(state.is === 'outdated' || (state.is === 'connected' && needsUpload(state.welcome)))) return
    updateAt = Infinity
    try {
      const isUploaded = await updateRelay(names, cloudflare)
      updateDone()
      if (!isUploaded) updateAt = Date.now() + updateWait
      relay.reconnect()
    } catch (error) {
      problems.set('relay update', error)
      isLoginNeeded = error instanceof LoginNeeded
      updateAt = Date.now() + updateWait
      updateWait = Math.min(updateWait * 2, UPDATE_MOST_MS)
    }
  }
  relay.on('welcome', (welcome) => {
    if (needsUpload(welcome)) void keepRelayCurrent()
    else updateDone()
  })
  const queueFiles = (files: ReadonlyMap<string, ReadonlySet<string>>): void => {
    for (const [session, paths] of files) {
      const tool = journalOf(capture.db, session)?.tool ?? 'claude'
      for (const path of paths) queue.add(session, tool, path)
    }
  }
  const sweepsAgain = new Map<string, boolean>()
  const sweepSoon = (session: string): void => {
    if (sweepsAgain.has(session)) return void sweepsAgain.set(session, true)
    sweepsAgain.set(session, true)
    void settle('backup', async () => {
      try {
        while (sweepsAgain.get(session) === true) {
          sweepsAgain.set(session, false)
          queueFiles(await changedFiles(capture, 0, session))
          queue.uploadNow(session)
        }
      } finally {
        sweepsAgain.delete(session)
      }
    })
  }
  let dataFailure = ''
  const readDataFolders = async (): Promise<void> => {
    try {
      capture.dataFolders = await dataFolders()
      dataFailure = ''
    } catch (error) {
      capture.dataFolders = []
      const reason = error instanceof Error ? error.message : String(error)
      if (reason !== dataFailure) console.error(`${new Date().toISOString()} anyhost keeps no mod's data folder, as cmod data --json, which names each folder, failed: ${reason}`)
      dataFailure = reason
    }
  }
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
        await cmod(['options', 'set', 'anyhost', 'join', ''])
      }
      joined()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`${new Date().toISOString()} The link of the option join joined no relay: ${message}`)
      joining = relay.state.is === 'connected' ? undefined : { is: 'failed', error: message }
    }
  }
  const closeArchived = async (): Promise<void> => {
    const settled = []
    for (const [session, address] of sessionTerminals()) {
      const status = await activityOf(capture, mover.activity, session)
      if (status !== 'working' && status !== 'waiting' && !isShown(terminals.get(address)?.labels ?? {})) settled.push(session)
    }
    if (settled.length === 0) return
    const archived = new Set((await listedAgents()).filter((agent) => agent.archived).map(({ id }) => id))
    for (const session of settled) if (archived.has(session)) await stopCopy(capture.roots.claudeHome, session)
  }
  const listedAgents = async (): Promise<readonly Agent[]> => {
    const { devices } = await machinesForList()
    return (await agentsOf(capture, await statusesHere(capture, mover.activity), sessionTerminals(), await listOf(new Map(devices.map((each) => [each.id, each]))))).agents
  }
  const deleteOrphansHere = async (): Promise<void> => await deleteOrphans(capture, await listedAgents(), mover)
  const backup = async (): Promise<void> => {
    await watchFolders()
    await Bun.write(heartbeat, '')
    const started = Date.now()
    const isAll = started - sweptAllAt >= SWEEP_ALL_MS
    if (isAll) unheardFrom(sweptAllAt > 0 ? sweptAllAt : lastRanAt)
    await readDataFolders()
    await listWritten()
    await readOptions()
    await settle('environment', () => loginEnvironment())
    await settle('backup', async () => {
      queueFiles(await changedFiles(capture, isAll ? 0 : started - QUIET_MS))
      if (isAll) sweptAllAt = started
    })
    void keepRelayCurrent()
    if (relay.state.is !== 'connected') return
    if (queue.uploadEvery === 0) queue.drain()
    await settle('index', () => writeIndex(capture))
    await settle('asleep', () => closeArchived())
    await settle('orphans', () => deleteOrphansHere())
    await settle('t3', () => copyT3Marks(relay, capture.db))
    noteChildren()
    await settle('upkeep', upkeepInJob)
    await settle('herdr machines', () => keepHerdrReaching(relay, device))
  }
  const shownMove = ({ to, step, line }: Moving): Pick<Moving, 'to' | 'step' | 'line'> => ({ to, step, line })
  const holderOf = async (session: string): Promise<{ machine?: string; problem?: string; untold?: string; move?: Pick<Moving, 'to' | 'step' | 'line'> }> => {
    const { state } = relay
    if (state.is === 'connected') await capture.holders.current()
    const moving = moves.get(session)
    const move = moving === undefined ? {} : { move: shownMove(moving) }
    if (state.is === 'refused' || state.is === 'outdated') return { problem: state.message, ...move }
    const holder = journalOf(capture.db, session)?.holder ?? ''
    const untold = untoldOf(capture.db, session)
    return { ...(holder === '' ? {} : { machine: holder }), ...(untold === '' ? {} : { untold }), ...move }
  }
  const statusOf = (): Status => {
    const { state, url } = relay
    const updateProblem = current.get('relay update')
    const coreProblem = current.get(CORE_MARKERS)
    const rewritten = rewriteProgress(capture)
    return {
      device,
      relay: { url, state: state.is, message: 'message' in state ? state.message : '', bucket: state.is === 'connected' ? state.welcome.bucket : (countedRelay(capture.db)?.bucket ?? '') },
      pending: queue.pending,
      uploadEvery: queue.uploadEvery,
      capturedAt,
      problems: [...current].filter(([key]) => !key.startsWith('journal ') && key !== 'relay update' && key !== CORE_MARKERS).map(([, line]) => line),
      journalGaps: [...current].filter(([key]) => key.startsWith('journal ')).map(([, line]) => line),
      ...(rewritten === undefined ? {} : { rewritten }),
      ...(updateProblem === undefined ? {} : { updateProblem }),
      ...(isLoginNeeded ? { needsLogin: true } : {}),
      ...(coreProblem === undefined ? {} : { coreProblem }),
      ...(connecting === undefined ? {} : { connecting: connecting.view }),
      ...(joining === undefined ? {} : { joining }),
    }
  }
  const adding = new Map<string, { readonly error?: string }>()
  const machinesListed = async () => {
    const [devices, shared, reached] = await Promise.all([devicesOf(relay), sharedOf(relay), hcPath() === undefined ? [] : machinesReached()])
    const machines = [...devices.values()].filter((device) => device.removedAt === undefined)
    return { devices: [...devices.values()], machines: machines.map((machine) => ({ ...machine, herdr: reachedAt(reached, shared.reach[machine.id])?.name ?? null })) }
  }
  const readFailed = (what: string) => (error: unknown) => console.error(`${new Date().toISOString()} anyhost could not read ${what}: ${error instanceof Error ? error.message : String(error)}`)
  type Revalidated<T> = { readonly last?: T | undefined; readonly keep?: (value: T) => void; readonly unknown?: T }
  const revalidating = <T,>(read: () => Promise<T>, what: string, signatureOf: (value: T) => string, { last, keep = () => undefined, unknown }: Revalidated<T> = {}): (() => Promise<T>) => {
    let kept: { readonly value: T; readonly at: number } | undefined = last === undefined ? undefined : { value: last, at: 0 }
    let reading: Promise<T> | undefined
    const again = (): Promise<T> =>
      (reading ??= read()
        .then((value) => {
          const isChanged = kept !== undefined && signatureOf(kept.value) !== signatureOf(value)
          if (kept === undefined || isChanged) keep(value)
          kept = { value, at: Date.now() }
          if (isChanged) sessionsChanged()
          return value
        })
        .finally(() => (reading = undefined)))
    return async () => {
      if (kept === undefined && unknown !== undefined) {
        again().catch(readFailed(what))
        return unknown
      }
      if (kept === undefined) return await again()
      if (Date.now() - kept.at > STATUSES_FRESH_MS) again().catch(readFailed(what))
      return kept.value
    }
  }
  const machinesKept = keptAnswer<Awaited<ReturnType<typeof machinesListed>>>(db, 'machines')
  const machinesForList = revalidating(machinesListed, 'the machines', ({ devices, machines }) => JSON.stringify([devices, machines]), { last: machinesKept.last, keep: machinesKept.keep })
  const statusesOfOthers = revalidating(
    async () => {
      const started = Date.now()
      const answered = await statusesElsewhere(capture)
      for (const [id, kept] of othersStatuses) if (!answered.has(id) && kept.at < started) othersStatuses.delete(id)
      for (const [id, shown] of answered) if ((othersStatuses.get(id)?.at ?? 0) < started) othersStatuses.set(id, { shown, at: started })
      return answered
    },
    "the other machines' sessions",
    (answered) => JSON.stringify([...answered]),
    { unknown: new Map() },
  )
  const statusesElsewhereNow = async (): Promise<Shown> => {
    await statusesOfOthers()
    const shown = [...othersStatuses.values()].map((kept) => kept.shown)
    return { statuses: Object.assign({}, ...shown.map(({ statuses }) => statuses)) as Record<string, AgentStatus>, since: Object.assign({}, ...shown.map(({ since }) => since)) as Record<string, number>, background: shown.flatMap(({ background }) => background) }
  }
  let listKeys: readonly string[] = []
  let listReadAt = 0
  let listReading: Promise<void> | undefined
  let isListReadAgain = false
  const readList = (keys: readonly string[]): Promise<void> => {
    if (listReading !== undefined) {
      isListReadAgain = true
      return listReading
    }
    listReading = (async () => {
      do {
        isListReadAgain = false
        const before = relay.cached(keys)
        await relay.read(keys)
        listReadAt = Date.now()
        if (relay.cached(keys).some((read, at) => before[at] !== undefined && read !== before[at])) sessionsChanged()
      } while (isListReadAgain)
    })().finally(() => (listReading = undefined))
    return listReading
  }
  const listOf = async (devices: ListRead['devices']): Promise<ListRead> => {
    const others = [...devices.keys()].filter((id) => id !== device.id)
    const keys = [SHARED_KEY, windowsKeyOf(device.id), ...others.map(indexKeyOf)]
    listKeys = keys
    if (relay.cached(keys).some((read) => read === undefined)) await readList(keys)
    else if (Date.now() - listReadAt > LIST_FRESH_MS) readList(keys).catch(readFailed('the session lists'))
    const [shared, windows, ...indexes] = relay.cached(keys)
    return { devices, indexes: indexesIn(others, indexes), shared: sharedIn(shared), windows: windowsIn(windows), holders: capture.holders.known() }
  }
  let isWindowsMoved = false
  relay.on('welcome', () => {
    if (isWindowsMoved) return
    isWindowsMoved = true
    void moveWindowPreferences(relay, device.id).catch(readFailed('the window layouts kept as preferences'))
  })
  const heardFrom = new Set<string>()
  const tellOthers = (message: (to: string) => Routed): void =>
    void machinesForList()
      .then(({ machines }) => {
        for (const id of new Set([...machines.map((machine) => machine.id), ...heardFrom])) if (id !== device.id) relay.send(message(id))
      })
      .catch(readFailed('the machines'))
  for (const kind of ['list', 'stored', 'statuses'] as const) relay.on(kind, ({ from }) => void heardFrom.add(from.id))
  relay.on('presence', ({ device: { id }, connected }) => void (connected && heardFrom.add(id)))
  let toldStatuses = ''
  const tellStatuses = async (): Promise<void> => {
    const shown = await statusesHere(capture, mover.activity)
    const told = JSON.stringify(shown)
    if (told === toldStatuses) return
    toldStatuses = told
    tellOthers((to) => ({ t: 'statuses', to, ...shown }))
  }
  activityChanged = () => void tellStatuses().catch(readFailed('the sessions here'))
  announceWrite = ({ key, etag }) => {
    if (key === SHARED_KEY || key === indexKeyOf(device.id)) tellOthers((to) => ({ t: 'stored', to, key, etag }))
  }
  relay.on('written', (written) => announceWrite(written))
  relay.on('stored', ({ key, etag }) => {
    const kept = relay.cached([key])[0]
    if ((kept !== undefined && 'etag' in kept && kept.etag === etag) || !listKeys.includes(key)) return
    readList(listKeys).catch(readFailed('the session lists'))
  })
  relay.on('statuses', ({ from, statuses, since, background }) => {
    othersStatuses.set(from.id, { shown: { statuses: { ...statuses }, since: { ...since }, background: [...(background ?? [])] }, at: Date.now() })
    sessionsChanged()
  })
  const failed = (status: number, error: unknown): Response => Response.json({ message: error instanceof Error ? error.message : String(error) }, { status })
  const listNow = async (): Promise<object> => {
    const version = sessionsVersion()
    const [elsewhere, here, { devices, machines }] = await Promise.all([statusesElsewhereNow(), statusesHere(capture, mover.activity), machinesForList()])
    const known = new Map(devices.map((machine) => [machine.id, machine]))
    return { ...(await agentsOf(capture, { statuses: { ...elsewhere.statuses, ...here.statuses }, since: { ...elsewhere.since, ...here.since }, background: [...elsewhere.background, ...here.background] }, sessionTerminals(), await listOf(known))), here: device.id, machines, version }
  }
  const throughRelay = async (work: () => Promise<unknown>): Promise<Response> => {
    const { state } = relay
    if (state.is === 'unjoined' || state.is === 'refused' || state.is === 'outdated') return failed(503, state.message)
    return Response.json((await work()) ?? {})
  }
  const connectRun = (): ConnectRun => {
    if (connecting === undefined) throw new Error('No Connect Cloudflare runs on this machine.')
    return connecting
  }
  type Asked = {
    readonly id?: string
    readonly link?: string
    readonly session?: string
    readonly machine?: string
    readonly folder?: string
    readonly prompt?: string
    readonly parent?: string
    readonly text?: string
    readonly keys?: readonly string[]
    readonly lines?: number
    readonly messages?: number
    readonly skip?: number
    readonly sleep?: boolean
    readonly place?: string
    readonly sender?: string
    readonly apiToken?: string
    readonly target?: string
    readonly archived?: boolean
    readonly settled?: boolean
    readonly until?: string | null
    readonly pinned?: boolean
    readonly settleAfterDays?: number | null
    readonly project?: string
    readonly name?: string | null
    readonly at?: string
    readonly changes?: readonly Organize[]
    readonly window?: string
    readonly terminals?: readonly string[]
    readonly event?: string
    readonly source?: string
    readonly title?: string
  }
  const act = async (pathname: string, { id = '', link = '', session = '', machine = '', folder = '', prompt = '', parent = '', text = '', keys = [], lines = 0, messages = 0, skip = 0, sleep = false, place = 'focus', sender = '', apiToken, target = '', archived = true, settled = true, until, pinned = true, settleAfterDays, project = '', name, at = '', changes = [], window = '', terminals: onScreen = [], event = '', source = '', title = '' }: Asked): Promise<Response> => {
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
      case '/machines/add':
        if (target === '') return failed(400, 'Name the machine to add as ssh reaches it, such as devbox or me@10.0.0.7.')
        if (adding.get(target)?.error === undefined && adding.has(target)) return Response.json({ target })
        adding.set(target, {})
        void addMachine(relay, target).then(
          () => adding.delete(target),
          (error: unknown) => adding.set(target, { error: error instanceof Error ? error.message : String(error) }),
        )
        return Response.json({ target })
      case '/agents/archive':
        return await throughRelay(() => archiveSession(session, archived))
      case '/shown':
        if (window === '' || !Array.isArray(onScreen) || onScreen.some((terminal) => typeof terminal !== 'string')) return failed(400, '/shown takes window, the id of the Herdr pane that reports, and terminals, the list of terminal addresses its window shows.')
        windows.set(window, { terminals: onScreen, at: Date.now() })
        void showNow()
        return Response.json({})
      case '/agents/show':
        if (!PLACES.some((each) => each === place)) return failed(400, `/agents/show takes place, one of ${PLACES.join(', ')}, not ${place}.`)
        return await throughRelay(async () => {
          const shown = await showAgent(capture, session, place as Place, mover, async (id) => (await machinesListed()).machines.find((machine) => machine.id === id)?.herdr ?? null)
          if (place !== 'peek' && place !== 'hide') restoreOpened(shown.session)
          return shown
        }).catch((error: unknown) => failed(400, error))
      case '/sessions/changed': {
        if (!(HOOK_EVENTS as readonly string[]).includes(event)) return failed(400, `/sessions/changed takes event, one of ${HOOK_EVENTS.join(', ')}, not ${JSON.stringify(event)}.`)
        if (Number.isNaN(Date.parse(at))) return failed(400, `/sessions/changed takes at, the ISO time its hook fired, not ${JSON.stringify(at)}.`)
        if (mover.activity.hear(session, event as HookEvent, Date.parse(at))) {
          sessionsChanged()
          activityChanged()
        }
        const transcript = transcriptOf(capture.roots.claudeHome, session)
        if (transcript !== undefined) {
          if (await recordSummaryFrom(capture, session, 'claude', [transcript])) void settle('index', () => writeIndex(capture))
          sessionsChanged()
        }
        if (event === 'asked') noteChildren()
        if (event === 'quit')
          void settle('closed', async () => {
            await unlabelShellsOf(session)
            await archiveSession(session, true)
            if (transcript === undefined) forgetUnstarted(capture.db, session)
            sessionsChanged()
          })
        const isMoved = await recordFolder(capture.db, session, folder, at)
        if ((event === 'renamed' && recordName(capture.db, session, title)) || isMoved) {
          void settle('index', () => writeIndex(capture))
          sessionsChanged()
        }
        if (source !== '') sourcesWaiting.set(session, source)
        placeSource(session)
        if (transcript !== undefined && journalOf(capture.db, session) === undefined) queue.add(session, 'claude', transcript)
        sweepSoon(session)
        return Response.json({})
      }
      case '/agents/pin':
        return await throughRelay(async () => void (await pin(relay, await sessionOf(capture, session), pinned)))
      case '/organize':
        return await throughRelay(async () => {
          const resolved = await Promise.all(changes.map(async (change) => ('session' in change ? { ...change, session: await sessionOf(capture, change.session) } : change)))
          await organize(relay, device.id, resolved)
        }).catch((error: unknown) => failed(400, error))
      case '/agents/visit':
        if (Number.isNaN(Date.parse(at))) return failed(400, `/agents/visit takes at, an ISO time, not ${at}.`)
        return await throughRelay(async () => void (await visit(relay, await sessionOf(capture, session), at)))
      case '/agents/delete':
        return await deleteAgent(capture, session, mover).then(
          async (deleted) => {
            await settle('orphans', () => deleteOrphansHere())
            return Response.json({ session: deleted })
          },
          (error: unknown) => failed(400, error),
        )
      case '/agents/fork':
        return await forkAgent(capture, session, at, mover).then(
          (forked) => Response.json(forked),
          (error: unknown) => failed(400, error),
        )
      case '/agents/settle':
        return await throughRelay(async () => void (await settleSession(relay, await sessionOf(capture, session), settled)))
      case '/agents/snooze':
        if (until === undefined || (until !== null && Number.isNaN(Date.parse(until)))) return failed(400, `/agents/snooze takes until, the ISO time the session wakes, or null to wake it now, not ${String(until)}.`)
        return await throughRelay(async () => void (await snooze(relay, await sessionOf(capture, session), until === null ? null : new Date(until).toISOString())))
      case '/projects/name':
        if (project === '' || name === undefined) return failed(400, '/projects/name takes project, the key of a project, and name, its new name, or null to drop the custom name.')
        return await throughRelay(async () => void (await nameProject(relay, project, name))).catch((error: unknown) => failed(400, error))
      case '/settings':
        if (settleAfterDays === undefined || (settleAfterDays !== null && !(Number.isInteger(settleAfterDays) && settleAfterDays >= 1 && settleAfterDays <= SETTLE_MOST_DAYS)))
          return failed(400, `/settings takes settleAfterDays, a whole number of days from 1 to ${SETTLE_MOST_DAYS}, or null to settle nothing by itself, not ${String(settleAfterDays)}.`)
        return await throughRelay(async () => void (await updateShared(relay, (shared) => ({ ...shared, settleAfterDays }))))
      case '/move':
        return await move(capture, session, machine, mover).then(
          (moving) => Response.json({ session: moving.session, ...shownMove(moving) }),
          (error: unknown) => failed(400, error),
        )
      case '/move/keep':
        if (!(await keepHere(capture, session, mover))) return failed(400, `No move of ${session} can keep it here now: none runs, or its machine runs it already.`)
        return Response.json({})
      case '/new':
        return await startNew(capture, machine, folder, prompt, mover, parent).then(
          async (started) => {
            await updateShared(relay, (shared) => ({ ...shared, lastMachine: machine || device.name }))
            return Response.json({ session: started, machine: machine || device.name })
          },
          (error: unknown) => failed(400, error),
        )
      case '/agents/tell':
        return await tell(capture, session, { text, keys, lines, sender, messages, skip, sleep }, mover).then(
          (told) => Response.json(told),
          (error: unknown) => failed(400, error),
        )
      case '/agents/open':
        return await openHere(capture, session, mover).then(
          (opened) => (restoreOpened(opened.session), Response.json({ ...opened, machine: device.name })),
          (error: unknown) => failed(400, error),
        )
      default:
        return failed(404, `${ROUTES}, not POST ${pathname}.`)
    }
  }

  const killChildren = (): void => {
    ready?.child.kill('SIGKILL')
    starting?.kill('SIGKILL')
    stopFollowing()
  }
  process.once('exit', killChildren)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, () => {
      killChildren()
      process.kill(process.pid, signal)
    })
  }
  relay.on('tell', (message) => void receiveTell(capture, message, mover))
  relay.on('delete', (message) => void receiveDelete(capture, message, mover))
  relay.on('fork', (message) => void receiveFork(capture, message, mover))
  relay.on('list', (message) => void receiveList(capture, message, mover))
  const releasing = new Set<string>()
  release = (session, holder) => {
    if (releasing.has(session)) return
    releasing.add(session)
    void receiveReleased(capture, session, holder, mover).finally(() => releasing.delete(session))
  }
  const releaseHeld = async (among?: ReadonlySet<string>): Promise<void> => {
    const holders = await capture.holders.current()
    const taken = [...new Set([...(await recordedSessions(roots.claudeHome)).map(({ sessionId }) => sessionId), ...sessionTerminals().keys()])].filter((session) => {
      const holder = holders.get(session)
      return holder !== undefined && holder !== device.id && (among === undefined || among.has(session))
    })
    if (taken.length === 0) return
    const devices = await devicesOf(relay)
    for (const session of taken) release(session, devices.get(holders.get(session) ?? '')?.name ?? holders.get(session) ?? '')
  }
  place = (session) => void placeSession(capture, session, mover)
  const placeAll = async (): Promise<void> => {
    await capture.holders.current()
    for (const session of new Set([...capture.holders.wanted().keys(), ...pausedSessions()])) place(session)
  }
  relay.on('welcome', () => void releaseHeld().then(placeAll).catch(readFailed('the sessions to place')))
  void releaseHeld().then(placeAll).catch(readFailed('the sessions to place'))
  void settle('environment', () => saveLoginEnvironment())
  void settle('fork starts', () => indexForkStarts(capture))
  void connect().then(
    (connection) => {
      const devices = provide('cmod/Devices', {
        devices: () => relay.connectedMachines(),
        send: (to: string, message: unknown) => {
          if (!relay.send({ t: 'cmod', to, message })) throw new Error('message' in relay.state ? relay.state.message : `${device.name} is still connecting to its relay.`)
        },
      })
      relay.on('presence', (presence) => devices.tell('Change', { device: presence.device.id }))
      relay.on('cmod', ({ from, message }) => devices.tell('Message', { device: from.id, message }))
      const isJoined = (): boolean => relay.state.is !== 'unjoined' && relay.state.is !== 'refused' && relay.state.is !== 'outdated'
      const heldSessions = async (): Promise<{ readonly agent: Agent; readonly machine: DeviceRef }[]> => {
        const { devices } = await machinesForList()
        const { agents } = await agentsOf(capture, undefined, undefined, await listOf(new Map(devices.map((each) => [each.id, each]))))
        const holders = capture.holders.known()
        const names = new Map(devices.map(({ id, name }) => [id, name]))
        return agents.flatMap((agent) => {
          const holder = holders.get(agent.id)
          return holder === undefined || agent.tool !== 'claude' || agent.deleted ? [] : [{ agent, machine: { id: holder, name: names.get(holder) ?? holder } }]
        })
      }
      const offSessions = async (): Promise<{ readonly agent: Agent; readonly machine: DeviceRef }[]> => {
        if (!isJoined()) return []
        const on = new Set([device.id, ...relay.connectedMachines().map(({ id }) => id)])
        return (await heldSessions()).filter(({ machine }) => !on.has(machine.id))
      }
      const offSession = async (session: string): Promise<{ readonly agent: Agent; readonly machine: DeviceRef }> => {
        const found = (await offSessions()).find(({ agent }) => agent.id === session)
        if (found === undefined) throw new NotHeld(session)
        return found
      }
      const readOff = async (session: string, part: string, options: Readonly<Record<string, unknown>>): Promise<unknown> => await readSession(capture, (await offSession(session)).agent, part, options)
      const sessions = provide('cmod/Sessions', {
        sessions: async ({ project, everyProject = false, running = false, since = '' } = {}) =>
          running
            ? []
            : (await offSessions())
                .filter(({ agent }) => (everyProject || project === undefined || agent.cwd === project) && agent.lastActivity >= since)
                .map(({ agent, machine }) => ({
                  id: agent.id,
                  title: agent.title,
                  project: agent.cwd,
                  cwd: agent.cwd,
                  model: '',
                  startedAt: '',
                  lastAt: agent.lastActivity,
                  ...(agent.source === '' ? {} : { forkedFrom: agent.source }),
                  isRunning: false,
                  ...(agent.visitedAt === '' ? {} : { visitedAt: agent.visitedAt }),
                  device: machine,
                })),
        search: () => {
          throw new Error('anyhost keeps the sessions of machines that are off as journals in R2, with no index of their messages, so it searches none of them.')
        },
        read: async (session, part, options = {}) => await readOff(session, part, options),
        send: async (session, { type, text, as }, { caller = '' } = {}) => {
          const { machine } = await offSession(session)
          if (type === 'note') throw new Error(`anyhost types prompts into a session's terminal and keeps no note for its next prompt, so ${session.slice(0, 8)} of ${machine.name} gets none.`)
          await tell(capture, session, { text, keys: [], lines: 0, sender: as === 'session' ? caller : '' }, mover)
        },
        abort: async (session) => {
          await offSession(session)
          await tell(capture, session, { text: '', keys: ['esc'], lines: 0, sender: '' }, mover)
        },
        end: async (session) => {
          await offSession(session)
          await tell(capture, session, { text: '', keys: [], lines: 0, sender: '', sleep: true }, mover)
        },
        fork: async (session, { prompt, title, at = '' }, { caller = '' } = {}) => {
          await offSession(session)
          const forked = await forkAgent(capture, session, at, mover)
          await tell(capture, forked.session, { text: prompt, keys: [], lines: 0, sender: caller }, mover)
          return { id: forked.session, title, openedBy: caller, openedAt: new Date().toISOString(), forkedFrom: session }
        },
        startTask: async (session, { prompt, title, cwd = '', device: named }, { caller = '' } = {}) => {
          const target = isJoined() ? (await machinesForList()).devices.find(({ id, name }) => id === named || name === named) : undefined
          if (target === undefined || target.id === device.id || relay.connectedMachines().some(({ id }) => id === target.id)) throw new NotHeld(session)
          const started = await startNew(capture, target.name, cwd, prompt, mover, caller)
          return { id: started, title, openedBy: caller, openedAt: new Date().toISOString() }
        },
        callTool: async (session) => {
          const { machine } = await offSession(session)
          throw new Error(`${session.slice(0, 8)} is a session of ${machine.name}, which is off, and anyhost calls no tool in a session.`)
        },
        usage: async (session, _input, { project, task } = {}) => (await readOff(session, 'usage', { project, task })) as Usage,
        surfaces: async (session) => {
          await offSession(session)
          return []
        },
        visit: async (session, at = new Date().toISOString()) => {
          await offSession(session)
          await visit(relay, session, at)
          sessions.tell('Change', { session, part: 'visit' })
        },
        delete: async (session) => {
          await offSession(session)
          await deleteAgent(capture, session, mover)
          await settle('orphans', () => deleteOrphansHere())
          sessions.tell('Change', { session, part: 'deleted' })
        },
      })
      relay.on('presence', ({ device: changed }) =>
        void heldSessions().then((held) => {
          for (const { agent, machine } of held) if (machine.id === changed.id) sessions.tell('Change', { session: agent.id, part: 'running' })
        }, readFailed(`the sessions of ${changed.name}`)),
      )
      const listenedTerminals = new Set<string>()
      const listenToTerminals = (): void =>
        void providers('cmod/Terminal').then((terminals) => {
          for (const terminal of terminals) {
            const program = terminal.program ?? terminal.mod
            if (terminal.mod !== 'cmod' || terminal.device.id !== device.id || listenedTerminals.has(program)) continue
            listenedTerminals.add(program)
            terminal.onPressed(({ session }) => void mover.touched.set(session, Date.now()))
            terminal.onShown(({ session, place }) => {
              mover.touched.set(session, Date.now())
              if (place !== 'peek' && place !== 'hide') restoreOpened(session)
            })
          }
        }, readFailed("cmod serve's providers of cmod/Terminal"))
      connection.listen('cmod/Providers', 'Change', (told) => {
        const change = told as CmodInterfaces['cmod/Providers']['events']['Change']
        if (change.interface === 'cmod/Terminal' && change.device.id === device.id) listenToTerminals()
      })
      listenToTerminals()
    },
    (error: unknown) => console.error(`${new Date().toISOString()} anyhost provides nothing to cmod, as connect() failed: ${error instanceof Error ? error.message : String(error)}`),
  )

  await startLineOffsets(capture)
  rmSync(socket, { force: true })
  // @ts-expect-error bun-types 1.4.4 leaves idleTimeout off a unix socket's options, which Bun 1.4.4 honors
  Bun.serve({
    unix: socket,
    idleTimeout: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (request.method === 'GET' && pathname === '/status') return Response.json(statusOf())
      if (request.method === 'GET' && pathname === '/machines')
        return await throughRelay(async () => {
          const [{ machines }, shared, candidates] = await Promise.all([machinesListed(), sharedOf(relay), candidatesOf()])
          const joined = new Set([...machines.map(({ name }) => name), ...Object.values(shared.reach)])
          for (const machine of machines) if (machine.connected && shared.reach[machine.id] !== undefined) adding.delete(shared.reach[machine.id] ?? '')
          return {
            here: device.id,
            machines,
            candidates: candidates.filter(({ target }) => !joined.has(target) && !machines.some(({ name }) => name.toLowerCase() === target.toLowerCase())),
            adding: [...adding].map(([target, { error }]) => ({ target, ...(error === undefined ? {} : { error }) })),
          }
        })
      if (request.method === 'GET' && pathname === '/agents') {
        const after = new URL(request.url).searchParams.get('after')
        if (after !== null) await changedAfter(after)
        return await throughRelay(listNow)
      }
      const claim = /^\/claims\/([\w-]+)$/.exec(pathname)?.[1]
      if (request.method === 'GET' && claim !== undefined) return Response.json(await holderOf(claim))
      if (request.method !== 'POST') return failed(404, `${ROUTES}, not ${request.method} ${pathname}.`)
      const body = await request.json().catch((error: unknown) => new Error(`anyhost takes a JSON object at POST ${pathname}, and this body is none: ${error instanceof Error ? error.message : String(error)}`))
      if (body instanceof Error) return failed(400, body)
      const answer = await act(pathname, body as Asked)
      if (pathname !== '/shown') sessionsChanged()
      return answer
    },
    error: (error) => failed(500, error),
  })
  console.log(`unix:${socket}`)
  const firstOptions = readOptions()
  await readDataFolders()
  await watchFolders(true)
  await firstOptions
  const loop = async (): Promise<void> => {
    const started = Date.now()
    await backup().catch((error: unknown) => problems.set('backup', error))
    setTimeout(() => void loop(), Math.max(0, started + BACKUP_MS - Date.now()))
  }
  await loop()
}
