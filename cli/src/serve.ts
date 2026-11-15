import type { Subprocess } from 'bun'
import { rmSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { changedFiles, countedRelay, indexForkStarts, isHeavyUpload, isUpkeepDue, journalOf, openCapture, recordFolder, relistSessions, openDatabase, QUIET_MS, rewriteNext, rewriteProgress, sealQuiet, sessionsOf, startCode, startLineOffsets, untoldOf, uploadSessions, writeIndex, type Capture, type Changed, type Fleet, type Problems } from './capture.ts'
import { loginEnvironment, pausedSessions, recordedSessions, resumeCopy, saveLoginEnvironment, statusOf as sessionStatusOf, statusOfRecord, stopCopy, type OnRecordsChange } from './claude.ts'
import { connectForStep, join as joinRelay, needsUpload, updateRelay, type Cloudflare, type ConnectRun, type Connecting, type RelayNames } from './connect.ts'
import { cmod, dataFolders, dataRoot, forgetRelayLogin, inviteMachine, machinesOf, personOptions, relayLogin, removeMachine, rootsHere, stateFolder, type DataFolder, type Device } from './device.ts'
import { followTerminals, hcPath, isKeptShell, isShown, killTerminal, label, machinesReached, SESSION_LABEL, SHOWN_LABEL, SHOWN_MS, SLEEP_LABEL, type Terminal, type TerminalChange } from './hc.ts'
import { installHerdr, PLACES, type Place } from './herdr.ts'
import { addMachine, candidatesOf, keepHerdrReaching, reachedAt } from './machines.ts'
import { deleteAgent, forkAgent, sessionOf, move, noteWaiting, receiveDelete, receiveFork, receiveList, receiveMove, receiveMoved, receiveReleased, receiveStart, receiveTell, openHere, showAgent, startNew, statusesElsewhere, statusesHere, tell, type MoveHere, type Moving } from './move.ts'
import { connectRelay, isRowsLimit, ROWS_LIMIT, waitAfter, type Login, type RelayState } from './relay.ts'
import { agentsOf } from './sessions.ts'
import { archive, isArchived, nameProject, organize, pin, settle as settleSession, SETTLE_MOST_DAYS, sharedOf, snooze, updateShared, visit, type Organize } from './shared.ts'
import { copyT3Marks } from './t3.ts'
import { codexState, filesUnder, transcriptOf, watchedFolders, type Tool } from './transcript.ts'

const BACKUP_MS = 60_000
const SWEEP_ALL_MS = 60 * 60_000
const READ_MS = 1000
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
const WATCHER_MS = 10_000
const RUNNING_MS = 2000
const STATUSES_FRESH_MS = 10_000
const STATUSES_KEPT_MS = 120_000
const LIST_WAIT_MS = 25_000
const STOP_MS = Number(process.env['ANYHOST_STOP_MS'] ?? 8 * 60 * 60_000)
const DISCARD_EVERY_MS = Math.min(30_000, STOP_MS / 4)
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
  readonly rewritten?: { readonly done: number; readonly journals: number; readonly olderMachines: readonly string[] }
  readonly updateProblem?: string
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
  const job = (await Bun.stdin.json()) as Job
  const say = (line: JobLine): void => void process.stdout.write(`${JSON.stringify(line)}\n`)
  const roots = rootsHere()
  const relay = connectRelay({ login: async () => job.login, forget: async () => undefined, device, roots, isPatient: true })
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
  const relay = connectRelay({
    login: relayLogin,
    forget: forgetRelayLogin,
    device,
    roots,
    isPatient: true,
    onOlderProgram: (message) => {
      console.error(`${new Date().toISOString()} ${message} So anyhost exits, and its service starts it again from the anyhost cmod links.`)
      process.exit(1)
    },
  })
  const db = openDatabase()
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
  let joining: Status['joining'] = { is: 'running' }
  let capturedAt = ''
  let sweptAllAt = 0
  let checkouts = ''

  const problems: Problems = {
    set(key, error) {
      const reason = error instanceof AggregateError ? error.errors.map(String).join(', ') : String(error)
      const limited = isRowsLimit(reason)
      const message = `${new Date().toISOString()} ${limited ? `relay: ${ROWS_LIMIT}` : `${key}: ${reason}`}`
      if (limited && current.has('relay')) return
      current.set(limited ? 'relay' : key, message)
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
  let sessionsVersion = 0
  const versionWaits = new Set<() => void>()
  const sessionsChanged = (): void => {
    sessionsVersion += 1
    for (const wake of versionWaits) wake()
  }
  const changedAfter = (version: number): Promise<void> =>
    version < sessionsVersion
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
    const child = Bun.spawn([...ownCommand(), 'work'], { env: process.env, stdin: new TextEncoder().encode(JSON.stringify(job)), stdout: 'pipe', stderr: 'inherit' })
    let answer: JobLine | undefined
    let failure = ''
    const heard = (line: string): void => {
      const said = JSON.parse(line) as JobLine
      if (said.problem !== undefined) problems.set(said.problem, said.message)
      if (said.clear !== undefined) problems.clear(said.clear)
      if (said.released !== undefined) capture.onReleased(...said.released)
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
  const uploaded = (changed: Changed, upload: Promise<Set<string>>): readonly [Changed, Promise<Set<string>>] => [
    changed,
    upload.then((left) => {
      problems.clear(`upload ${changed.session}`)
      problems.clear('relay')
      capturedAt = new Date().toISOString()
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
  const moves = new Map<string, Moving>()
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
    opening: new Map(),
  }
  const noteChildren = noteWaiting(capture, mover)
  const archivedBusy = new Set<string>()
  let closingSettled = Promise.resolve()
  const closeSettled = async (): Promise<void> => {
    for (const session of archivedBusy) {
      const status = await sessionStatusOf(capture.roots.claudeHome, session)
      if (status === 'working' || status === 'waiting') continue
      archivedBusy.delete(session)
      await stopCopy(capture.roots.claudeHome, session)
    }
  }
  const recordsChanged = (): void => {
    noteChildren()
    labelNow()
    if (archivedBusy.size > 0) closingSettled = closingSettled.then(() => settle('archived', () => closeSettled()))
    sessionsChanged()
    for (const read of recordsHeard) read()
  }
  const archiveSession = async (asked: string, archived: boolean): Promise<void> => {
    const id = await sessionOf(capture, asked)
    const status = await sessionStatusOf(capture.roots.claudeHome, id)
    const isBusy = status === 'working' || status === 'waiting'
    if (archived && isBusy) archivedBusy.add(id)
    else archivedBusy.delete(id)
    if (archived && !isBusy) await stopCopy(capture.roots.claudeHome, id)
    await archive(relay, id, archived)
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
      const session = terminal.pid === null ? undefined : sessionOfPid.get(terminal.pid)
      if (!isHere(address) || terminal.state !== 'live' || session === undefined || sessionIn(address) === session || labelledAs.get(address) === session) continue
      await label(address, SESSION_LABEL, session)
      labelledAs.set(address, session)
    }
  }
  let labelling = Promise.resolve()
  const labelNow = (): void => void (labelling = labelling.then(() => settle('labelled', labelOwnRuns)))
  const isRunner = (terminal: Terminal): boolean => {
    const [program = '', command] = terminal.foreground?.argv ?? []
    return basename(program) === 'anyhost' && command === 'run'
  }
  const discardIdle = async (): Promise<void> => {
    const records = new Map((await recordedSessions(roots.claudeHome)).map((record) => [record.sessionId, record]))
    const now = Date.now()
    for (const [address, terminal] of terminals) {
      const session = sessionIn(address)
      if (!isHere(address) || session === '' || terminal.state !== 'live') continue
      const record = records.get(session)
      if (isKeptShell(terminal) || (isRunner(terminal) && record === undefined)) {
        await killTerminal(address)
        continue
      }
      if (record === undefined || statusOfRecord(record.status) !== 'idle') continue
      const since = record.statusSince ?? now
      const isAsked = Number(terminal.labels[SLEEP_LABEL] ?? 0) > since
      if (isAsked || (!isShown(terminal.labels, now) && now - since >= STOP_MS)) await stopCopy(roots.claudeHome, session)
    }
  }
  let isDiscarding = false
  const discardNow = (): void => {
    if (isDiscarding) return
    isDiscarding = true
    void settle('discard', discardIdle).finally(() => (isDiscarding = false))
  }
  setInterval(discardNow, DISCARD_EVERY_MS)
  const archiveClosed = (change: TerminalChange): void => {
    const session = sessionIn(change.address)
    if (change.type !== 'finished' || !isHere(change.address) || session === '' || terminals.get(change.address)?.reason !== 'killed') return
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
    for (const address of labelledShown.keys()) {
      if (shown.has(address)) continue
      await label(address, shownKey, '')
      labelledShown.delete(address)
    }
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
  const stopFollowing = followTerminals((now, change) => {
    terminals = now
    if (change === undefined || change.type === 'created' || change.type === 'restarted') labelNow()
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
  const joined = (): void => {
    joining = undefined
    problems.clear('relay update')
    relay.reconnect()
  }
  let connecting: ConnectRun | undefined
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
  relay.on('welcome', (welcome) => {
    if (needsUpload(welcome)) void keepRelayCurrent()
    else problems.clear('relay update')
  })
  const queueFiles = (files: ReadonlyMap<string, ReadonlySet<string>>): void => {
    for (const [session, paths] of files) {
      const tool = journalOf(capture.db, session)?.tool ?? 'claude'
      for (const path of paths) queue.add(session, tool, path)
    }
  }
  let dataFailure = ''
  const readDataFolders = async (): Promise<void> => {
    try {
      capture.dataFolders = await dataFolders()
      dataFailure = ''
    } catch (error) {
      capture.dataFolders = []
      const reason = error instanceof Error ? error.message : String(error)
      if (reason !== dataFailure) console.error(`${new Date().toISOString()} anyhost keeps no mod's data folder, as cmod data --json, which names each folder and the files its mod rebuilds by itself, failed: ${reason}`)
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
        await cmod(['option', 'anyhost', 'join', ''])
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
    for (const session of sessionTerminals().keys()) {
      const status = await sessionStatusOf(capture.roots.claudeHome, session)
      if (status !== 'working' && status !== 'waiting') settled.push(session)
    }
    if (settled.length === 0) return
    const shared = await sharedOf(relay)
    for (const session of settled) {
      const lastActivity = capture.db.query<{ last_activity: string }, [string]>('select last_activity from sessions where id = ?').get(session)?.last_activity ?? ''
      if (lastActivity !== '' && isArchived(shared, { id: session, lastActivity })) await stopCopy(capture.roots.claudeHome, session)
    }
  }
  const backup = async (): Promise<void> => {
    await watchFolders()
    await Bun.write(heartbeat, '')
    const started = Date.now()
    const isAll = started - sweptAllAt >= SWEEP_ALL_MS
    if (isAll) unheardFrom(sweptAllAt > 0 ? sweptAllAt : lastRanAt)
    await readDataFolders()
    await listWritten()
    await readOptions()
    await settle('herdr', () => installHerdr())
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
    await settle('t3', () => copyT3Marks(relay, capture.db))
    noteChildren()
    await settle('upkeep', upkeepInJob)
    await settle('herdr machines', () => keepHerdrReaching(relay, device))
  }
  const shownMove = ({ to, step, line }: Moving): Pick<Moving, 'to' | 'step' | 'line'> => ({ to, step, line })
  const holderOf = (session: string): { machine?: string; problem?: string; untold?: string; move?: Pick<Moving, 'to' | 'step' | 'line'> } => {
    const moving = moves.get(session)
    const move = moving === undefined ? {} : { move: shownMove(moving) }
    const { state } = relay
    if (state.is === 'refused' || state.is === 'outdated') return { problem: state.message, ...move }
    const holder = journalOf(capture.db, session)?.holder ?? ''
    const untold = untoldOf(capture.db, session)
    return { ...(holder === '' ? {} : { machine: holder }), ...(untold === '' ? {} : { untold }), ...move }
  }
  const statusOf = (): Status => {
    const { state, url } = relay
    const updateProblem = current.get('relay update')
    const rewritten = rewriteProgress(capture)
    return {
      device,
      relay: { url, state: state.is, message: 'message' in state ? state.message : '', bucket: state.is === 'connected' ? state.welcome.bucket : (countedRelay(capture.db)?.bucket ?? '') },
      pending: queue.pending,
      uploadEvery: queue.uploadEvery,
      capturedAt,
      problems: [...current].filter(([key]) => !key.startsWith('journal ') && key !== 'relay update').map(([, line]) => line),
      journalGaps: [...current].filter(([key]) => key.startsWith('journal ')).map(([, line]) => line),
      ...(rewritten === undefined ? {} : { rewritten }),
      ...(updateProblem === undefined ? {} : { updateProblem }),
      ...(connecting === undefined ? {} : { connecting: connecting.view }),
      ...(joining === undefined ? {} : { joining }),
    }
  }
  const adding = new Map<string, { readonly error?: string }>()
  const machinesListed = async () => {
    const [machines, shared, reached] = await Promise.all([machinesOf(relay), sharedOf(relay), hcPath() === undefined ? [] : machinesReached()])
    return { shared, machines: machines.map((machine) => ({ ...machine, herdr: reachedAt(reached, shared.reach[machine.id])?.name ?? null })) }
  }
  const revalidating = <T,>(read: () => Promise<T>, what: string): (() => Promise<T>) => {
    let kept: { readonly value: T; readonly at: number } | undefined
    let reading: Promise<T> | undefined
    const again = (): Promise<T> =>
      (reading ??= read()
        .then((value) => (kept = { value, at: Date.now() }).value)
        .finally(() => (reading = undefined)))
    return async () => {
      if (kept === undefined || Date.now() - kept.at > STATUSES_KEPT_MS) return await again()
      if (Date.now() - kept.at > STATUSES_FRESH_MS) again().catch((error: unknown) => console.error(`anyhost could not read ${what}: ${error instanceof Error ? error.message : String(error)}`))
      return kept.value
    }
  }
  const machinesForList = revalidating(machinesListed, 'the machines')
  const statusesOfOthers = revalidating(() => statusesElsewhere(capture), "the other machines' sessions")
  const failed = (status: number, error: unknown): Response => Response.json({ message: error instanceof Error ? error.message : String(error) }, { status })
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
  }
  const act = async (pathname: string, { id = '', link = '', session = '', machine = '', folder = '', prompt = '', parent = '', text = '', keys = [], lines = 0, messages = 0, skip = 0, sleep = false, place = 'focus', sender = '', apiToken, target = '', archived = true, settled = true, until, pinned = true, settleAfterDays, project = '', name, at = '', changes = [], window = '', terminals: onScreen = [] }: Asked): Promise<Response> => {
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
        return await throughRelay(() =>
          showAgent(capture, session, place as Place, mover, async (id) => (await machinesListed()).machines.find((machine) => machine.id === id)?.herdr ?? null),
        ).catch((error: unknown) => failed(400, error))
      case '/sessions/changed': {
        await recordFolder(capture.db, session, folder)
        queueFiles(await changedFiles(capture, 0, session))
        const transcript = journalOf(capture.db, session) === undefined ? transcriptOf(capture.roots.claudeHome, session) : undefined
        if (transcript !== undefined) queue.add(session, 'claude', transcript)
        queue.uploadNow(session)
        return Response.json({})
      }
      case '/agents/pin':
        return await throughRelay(async () => void (await pin(relay, await sessionOf(capture, session), pinned)))
      case '/organize':
        return await throughRelay(async () => {
          const resolved = await Promise.all(changes.map(async (change) => ('session' in change ? { ...change, session: await sessionOf(capture, change.session) } : change)))
          await organize(relay, resolved)
        }).catch((error: unknown) => failed(400, error))
      case '/agents/visit':
        if (Number.isNaN(Date.parse(at))) return failed(400, `/agents/visit takes at, an ISO time, not ${at}.`)
        return await throughRelay(async () => void (await visit(relay, await sessionOf(capture, session), at)))
      case '/agents/delete':
        return await deleteAgent(capture, session, mover).then(
          (deleted) => Response.json({ session: deleted }),
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
        if (moves.get(session)?.keep() !== true) return failed(400, `No move of ${session} can keep it here now: none runs, or its machine answered already.`)
        return Response.json({})
      case '/new':
        return await startNew(capture, machine, folder, prompt, mover, parent).then(
          async (started) => {
            await updateShared(relay, (shared) => ({ ...shared, lastMachine: machine || device.name, parents: parent === '' ? shared.parents : { ...shared.parents, [started]: parent } }))
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
          (opened) => Response.json({ ...opened, machine: device.name }),
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
  relay.on('move', (message) => void receiveMove(capture, message, mover))
  relay.on('start', (message) => void receiveStart(capture, message, mover))
  relay.on('tell', (message) => void receiveTell(capture, message, mover))
  relay.on('delete', (message) => void receiveDelete(capture, message, mover))
  relay.on('fork', (message) => void receiveFork(capture, message, mover))
  relay.on('list', (message) => void receiveList(capture, message, mover))
  relay.on('moved', (message) => void receiveMoved(capture, message, mover))
  const releasing = new Set<string>()
  release = (session, holder) => {
    if (releasing.has(session)) return
    releasing.add(session)
    void receiveReleased(capture, session, holder, mover).finally(() => releasing.delete(session))
  }
  const releaseHeld = async (): Promise<void> => {
    for (const session of new Set([...(await recordedSessions(roots.claudeHome)).map(({ sessionId }) => sessionId), ...sessionTerminals().keys()])) {
      const holder = journalOf(db, session)?.holder ?? ''
      if (holder !== '') release(session, holder)
    }
  }
  const resumeHeld = async (): Promise<void> => {
    for (const session of pausedSessions()) {
      const moving = mover.moves.get(session)
      const isMoving = moving !== undefined && moving.step !== 'moved' && moving.step !== 'failed'
      if (!isMoving && (journalOf(db, session)?.holder ?? '') === '') await resumeCopy(roots.claudeHome, session)
    }
  }
  relay.on('welcome', () => void releaseHeld().then(resumeHeld))
  void releaseHeld()
  void settle('herdr', () => installHerdr())
  void settle('environment', () => saveLoginEnvironment())
  void settle('fork starts', () => indexForkStarts(capture))

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
          const [{ machines, shared }, candidates] = await Promise.all([machinesListed(), candidatesOf()])
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
        const after = Number(new URL(request.url).searchParams.get('after') ?? -1)
        await changedAfter(after)
        return await throughRelay(async () => {
          const version = sessionsVersion
          const [elsewhere, here, { machines }] = await Promise.all([statusesOfOthers(), statusesHere(capture), machinesForList()])
          return { ...(await agentsOf(capture, { ...elsewhere, ...here }, sessionTerminals())), here: device.id, machines, version }
        })
      }
      const claim = /^\/claims\/([\w-]+)$/.exec(pathname)?.[1]
      if (request.method === 'GET' && claim !== undefined) return Response.json(holderOf(claim))
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
