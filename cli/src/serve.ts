import type { Subprocess } from 'bun'
import { rmSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { changedFiles, countedRelay, journalOf, openCapture, readSummariesAgain, relistSessions, openDatabase, QUIET_MS, sealQuiet, sessionsOf, startLineOffsets, takeUntold, uploadSessions, writeIndex, type Changed, type Problems } from './capture.ts'
import { loginEnvironment, nestRuns, recordedSessions, runSessions, saveLoginEnvironment, type OnRecordsChange } from './claude.ts'
import { connectForStep, join as joinRelay, needsUpload, updateRelay, type Cloudflare, type ConnectRun, type Connecting, type RelayNames } from './connect.ts'
import { cmod, forgetRelayLogin, inviteMachine, machinesOf, personOptions, relayLogin, removeMachine, rootsHere, stateFolder, type Device } from './device.ts'
import { hcPath, machinesReached } from './hc.ts'
import { installHerdr } from './herdr.ts'
import { addMachine, candidatesOf, keepHerdrReaching, reachedAt } from './machines.ts'
import { deleteHere, sessionOf, move, receiveList, receiveMove, receiveMoved, receiveReleased, receiveStart, receiveTell, openHere, startNew, statusesOf, tell, type MoveHere, type Moving } from './move.ts'
import { connectRelay, isRowsLimit, ROWS_LIMIT, waitAfter, type RelayState } from './relay.ts'
import { closeStopped } from './runner.ts'
import { agentsOf } from './sessions.ts'
import { archive, archiveSettled, sharedOf, updateShared, visit } from './shared.ts'
import { codexState, filesUnder, watchedFolders, type Tool } from './transcript.ts'

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
const ROUTES = 'anyhost serves GET /status, /machines, /agents and /claims/<session>, POST /connect, /connect/account, /connect/r2, /join, /machines/add, /machines/invite, /machines/remove, /move, /move/keep, /new, /agents/tell, /agents/open, /agents/archive, /agents/visit, /agents/delete and /settings'

export const serveSocket = (): string => join(stateFolder(), 'serve.sock')

export const uploadEveryOf = (chosen: number | undefined): number => chosen ?? 5

export type Status = {
  readonly device: Device
  readonly relay: { readonly url: string; readonly state: RelayState['is']; readonly message: string; readonly bucket: string }
  readonly pending: number
  readonly uploadEvery: number
  readonly capturedAt: string
  readonly problems: readonly string[]
  readonly journalGaps: readonly string[]
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
    for (const wake of [...this.relayWaits]) wake()
    this.drainSessions([...this.queued.keys()])
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
          if (this.every === 0) this.drainSessions([session])
          this.uploaded(session, { left })
        },
        (error: unknown) => {
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

export async function serve(device: Device, names?: RelayNames, cloudflare?: Cloudflare): Promise<void> {
  const socket = serveSocket()
  const running = await fetch('http://localhost/status', { unix: socket, signal: AbortSignal.timeout(RUNNING_MS) }).then(
    async (answer) => (await answer.json()) as Status,
    () => undefined,
  )
  if (running !== undefined) throw new Error(`The anyhost program of ${running.device.name} already answers at ${socket}, so this one does not start. Two programs on one state folder would both write its database.`)
  const roots = rootsHere()
  const relay = connectRelay({ login: relayLogin, forget: forgetRelayLogin, device, roots, isPatient: true })
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
  const queue = new UploadQueue(
    uploadEveryOf(undefined),
    (sessions) =>
      uploadSessions(capture, sessions, problems, queue.uploadEvery === 0).map(([changed, upload]) => [
        changed,
        upload.then((left) => {
          problems.clear(`upload ${changed.session}`)
          problems.clear('relay')
          capturedAt = new Date().toISOString()
          return left
        }),
      ]),
    (session, error) => problems.set(`upload ${session}`, error),
    () => relay.state.is === 'connected',
  )
  let isTidied = false
  relay.on('welcome', () => {
    joining = undefined
    queue.drain()
    void settle('archive', () => archiveSettled(relay))
    if (isTidied) return
    isTidied = true
    void settle('tidy', async () => {
      await readSummariesAgain(capture)
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
  const recordsChanged = (): void => {
    for (const read of recordsHeard) read()
  }
  const watchable: readonly { readonly folder: string; readonly depth: number }[] = [...watchedFolders(roots), { folder: records, depth: 1 }]
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
    if (isAll) unheardFrom(sweptAllAt > 0 ? sweptAllAt : lastRanAt)
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
    queueFiles(await sealQuiet(capture, problems))
    await settle('herdr machines', () => keepHerdrReaching(relay, device))
  }
  const moves = new Map<string, Moving>()
  const shownMove = ({ to, step, line }: Moving): Pick<Moving, 'to' | 'step' | 'line'> => ({ to, step, line })
  const holderOf = (session: string): { machine?: string; problem?: string; untold?: string; move?: Pick<Moving, 'to' | 'step' | 'line'> } => {
    const moving = moves.get(session)
    const move = moving === undefined ? {} : { move: shownMove(moving) }
    const { state } = relay
    if (state.is === 'refused' || state.is === 'outdated') return { problem: state.message, ...move }
    const holder = journalOf(capture.db, session)?.holder ?? ''
    const untold = takeUntold(capture.db, session)
    return { ...(holder === '' ? {} : { machine: holder }), ...(untold === '' ? {} : { untold }), ...move }
  }
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
  const adding = new Map<string, { readonly error?: string }>()
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
    readonly sender?: string
    readonly apiToken?: string
    readonly target?: string
    readonly archived?: boolean
    readonly archiveAfterDays?: number | null
    readonly at?: string
  }
  const act = async (pathname: string, { id = '', link = '', session = '', machine = '', folder = '', prompt = '', parent = '', text = '', keys = [], lines = 0, sender = '', apiToken, target = '', archived = true, archiveAfterDays, at = '' }: Asked): Promise<Response> => {
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
        return await throughRelay(async () => void (await archive(relay, await sessionOf(capture, session), archived)))
      case '/agents/visit':
        if (Number.isNaN(Date.parse(at))) return failed(400, `/agents/visit takes at, an ISO time, not ${at}.`)
        return await throughRelay(async () => void (await visit(relay, await sessionOf(capture, session), at)))
      case '/agents/delete':
        return await deleteHere(capture, session, mover).then(
          (deleted) => Response.json({ session: deleted }),
          (error: unknown) => failed(400, error),
        )
      case '/settings':
        return await throughRelay(async () => void (await updateShared(relay, (shared) => ({ ...shared, archiveAfterDays: archiveAfterDays ?? null }))))
      case '/move':
        return await move(capture, session, machine, mover).then(
          (moving) => Response.json({ session: moving.session, ...shownMove(moving) }),
          (error: unknown) => failed(400, error),
        )
      case '/move/keep':
        if (moves.get(session)?.keep() !== true) return failed(400, `No move of ${session} can keep it here now: none runs, or its machine answered already.`)
        return Response.json({})
      case '/new':
        return await startNew(capture, machine, folder, prompt, mover).then(
          async (started) => {
            await updateShared(relay, (shared) => ({ ...shared, lastMachine: machine || device.name, parents: parent === '' ? shared.parents : { ...shared.parents, [started]: parent } }))
            return Response.json({ session: started, machine: machine || device.name })
          },
          (error: unknown) => failed(400, error),
        )
      case '/agents/tell':
        return await tell(capture, session, { text, keys, lines, sender }, mover).then(
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
  relay.on('move', (message) => void receiveMove(capture, message, mover))
  relay.on('start', (message) => void receiveStart(capture, message, mover))
  relay.on('tell', (message) => void receiveTell(capture, message, mover))
  relay.on('list', (message) => void receiveList(capture, message, mover))
  relay.on('moved', (message) => void receiveMoved(capture, message, mover))
  const releasing = new Set<string>()
  release = (session, holder) => {
    if (releasing.has(session)) return
    releasing.add(session)
    void receiveReleased(capture, session, holder, mover).finally(() => releasing.delete(session))
  }
  const releaseHeld = async (): Promise<void> => {
    for (const session of new Set([...(await recordedSessions(roots.claudeHome)).map(({ sessionId }) => sessionId), ...runSessions()])) {
      const holder = journalOf(db, session)?.holder ?? ''
      if (holder !== '') release(session, holder)
    }
  }
  relay.on('welcome', releaseHeld)
  void releaseHeld()
  void settle('herdr', () => installHerdr())
  nestRuns(device.name)
  void settle('environment', () => saveLoginEnvironment())
  if (hcPath() !== undefined) void settle('stopped', () => closeStopped())

  await startLineOffsets(capture)
  rmSync(socket, { force: true })
  Bun.serve({
    unix: socket,
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (request.method === 'GET' && pathname === '/status') return Response.json(statusOf())
      if (request.method === 'GET' && pathname === '/machines')
        return await throughRelay(async () => {
          const [machines, shared, reached, candidates] = await Promise.all([machinesOf(relay), sharedOf(relay), hcPath() === undefined ? [] : machinesReached(), candidatesOf()])
          const joined = new Set([...machines.map(({ name }) => name), ...Object.values(shared.reach)])
          for (const machine of machines) if (machine.connected && shared.reach[machine.id] !== undefined) adding.delete(shared.reach[machine.id] ?? '')
          return {
            here: device.id,
            machines: machines.map((machine) => ({ ...machine, herdr: reachedAt(reached, shared.reach[machine.id])?.name ?? null })),
            candidates: candidates.filter(({ target }) => !joined.has(target) && !machines.some(({ name }) => name.toLowerCase() === target.toLowerCase())),
            adding: [...adding].map(([target, { error }]) => ({ target, ...(error === undefined ? {} : { error }) })),
          }
        })
      if (request.method === 'GET' && pathname === '/agents')
        return await throughRelay(async () => await agentsOf(capture, await statusesOf(capture)))
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
