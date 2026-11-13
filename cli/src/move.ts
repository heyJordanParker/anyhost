import { mkdir, readFile, readlink, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { AgentStatus, Delivered, Device, Message, Offline, Routed } from '../../relay/protocol.ts'
import { captureAgainFrom, chainOf, changedFiles, checkoutOf, framesOf, holdHere, isDeleted, journalOf, journalPrefix, sealJournal, startCode, workingFolderOf, writeIndex, type Capture, type Problems } from './capture.ts'
import { claimsOf, HeldElsewhere, takeClaim } from './claims.ts'
import { commandOf, pauseCopy, recordedSessions, resumeCopy, run, runOf, runSessions, runTerminalOf, statusOf, statusOfRecord, stopCopy, whenSessions, type OnRecordsChange, type RunningSession } from './claude.ts'
import { devicesOf, otherMachine } from './device.ts'
import { killTerminal, labelledTerminals, openTerminal, pressKeys, readTerminal, sendTo } from './hc.ts'
import type { Relay } from './relay.ts'
import { cloneMissing, localFolder, restore } from './resume.ts'
import { sharedOf } from './shared.ts'
import { messagesOf, ownerOf, type Tool } from './transcript.ts'

const RUNNING_MS = 60_000
const IDLE_SETTLES_MS = 2000
const TRUST_ANSWER_MS = 86_400_000
const CONNECTED_MS = 10_000
const TELL_MS = 25_000
const TURN_STARTS_MS = 10_000
const LIST_MS = 5000
const FORGET_MS = 120_000
const LOCK_STALE_MS = 10_000
const LOCK_WAITS_MS = [200, 400, 800, 1600, 3200, 4000]

type MoveStep = 'waiting' | 'uploading' | 'moving' | 'moved' | 'failed'
export type Moving = { readonly session: string; readonly to: string; step: MoveStep; line: string; readonly keep: () => boolean }
export type MoveHere = {
  readonly moves: Map<string, Moving>
  readonly answers: Map<string, Reply | undefined>
  readonly problems: Problems
  readonly checkouts: string
  readonly queue: (session: string, tool: Tool, path: string) => void
  readonly flush: (session: string, signal: AbortSignal, onRelay: (isConnected: boolean) => void) => Promise<void>
  readonly onRecordsChange: OnRecordsChange
  readonly opening: Map<string, Promise<string>>
}

type Reply = Extract<Routed, { readonly t: 'moved' | 'started' | 'told' | 'listed' | 'deleted' }>
const ANSWER = { move: 'moved', start: 'started', tell: 'told', list: 'listed', delete: 'deleted' } as const
type Asked = Extract<Routed, { readonly t: keyof typeof ANSWER }>
type AnswerTo<A extends Asked> = Extract<Delivered, { readonly t: (typeof ANSWER)[A['t']] }> | Offline

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const reasonOf = (error: unknown): string => messageOf(error).replace(/\.+$/, '')
const stamp = (): string => new Date().toISOString()

async function ask<A extends Asked>(
  relay: Relay,
  message: A,
  { signal, keepsWaiting }: { readonly signal?: AbortSignal; readonly keepsWaiting: () => Promise<boolean> },
): Promise<AnswerTo<A>> {
  const offline: Offline = { t: 'offline', id: message.id, to: message.to }
  signal?.throwIfAborted()
  const listed = (await devicesOf(relay)).get(message.to)
  const isUp = (now: Device | undefined): now is Device => now !== undefined && now.removedAt === undefined && now.connected
  if (!isUp(listed)) return offline
  const isGone = (now: Device | undefined): boolean => !isUp(now)
  signal?.throwIfAborted()
  const answered = new AbortController()
  const until = signal === undefined ? answered.signal : AbortSignal.any([signal, answered.signal])
  const stops: (() => void)[] = []
  try {
    return await new Promise<AnswerTo<A>>((resolve, reject) => {
      const atOffline = async (): Promise<void> => {
        if (!until.aborted && !(await keepsWaiting())) resolve(offline)
      }
      stops.push(
        relay.on(ANSWER[message.t], (answer) => (answer.id === message.id ? resolve(answer as AnswerTo<A>) : undefined)),
        relay.on('offline', (answer) => (answer.id === message.id ? void atOffline().catch(reject) : undefined)),
      )
      until.addEventListener('abort', () => reject(until.reason), { once: true })
      if (!relay.send(message)) return reject(new Error(`This machine is not connected to the relay at ${relay.url}, so anyhost sent nothing.`))
      void (async () => {
        while (await sleep(CONNECTED_MS, true, { signal: until }).catch(() => false)) {
          if (isGone((await devicesOf(relay)).get(message.to))) await atOffline()
          else if (!until.aborted) relay.send(message)
        }
      })().catch(reject)
    })
  } finally {
    for (const stop of stops) stop()
    answered.abort()
  }
}

type Config = { readonly projects?: Record<string, { readonly hasTrustDialogAccepted?: boolean } | undefined> }
const configOf = (capture: Capture): string => join(process.env['CLAUDE_CONFIG_DIR'] ? capture.roots.claudeHome : capture.roots.home, '.claude.json')
const unlessMissing =
  <T>(missing: T) =>
  (error: NodeJS.ErrnoException): T => {
    if (error.code !== 'ENOENT') throw error
    return missing
  }
const configAt = async (file: string): Promise<Config> => JSON.parse(await readFile(file, 'utf8').catch(unlessMissing('{}'))) as Config
async function fileOf(path: string): Promise<string> {
  const found = await realpath(path).catch(unlessMissing(undefined))
  if (found !== undefined) return found
  const target = await readlink(path).catch(unlessMissing(undefined))
  return target === undefined ? path : await fileOf(resolve(dirname(path), target))
}
const isTrusted = (config: Config, records: readonly string[]): boolean => records.some((record) => config.projects?.[record]?.hasTrustDialogAccepted === true)

async function trustRecordsOf(cwd: string): Promise<readonly [string, ...string[]]> {
  const folder = await realpath(cwd)
  const [top, common]: (string | undefined)[] = await run(['git', '-C', folder, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']).then(
    (printed) => Promise.all(printed.trim().split('\n').map((path) => realpath(path))),
    () => [],
  )
  const key = top === undefined ? folder : common !== undefined && basename(common) === '.git' ? dirname(common) : top
  const walked: string[] = []
  for (let at = folder; ; at = dirname(at)) {
    walked.push(at)
    if (at === top || dirname(at) === at) break
  }
  return [key, ...walked]
}

async function trusts(capture: Capture, cwd: string): Promise<boolean> {
  return isTrusted(await configAt(configOf(capture)), await trustRecordsOf(cwd).catch(unlessMissing([])))
}

async function lockedConfig<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`
  for (let tries = 0; ; ) {
    const error = await mkdir(lock).then(() => undefined, (failure: NodeJS.ErrnoException) => failure)
    if (error === undefined) break
    if (error.code !== 'EEXIST') throw error
    const changedAt = await stat(lock).then((found) => found.mtimeMs, () => 0)
    if (Date.now() - changedAt > LOCK_STALE_MS) {
      await rmdir(lock).catch(unlessMissing(undefined)).catch((failure: unknown) => {
        throw new Error(`${lock} is left behind, unchanged for ${LOCK_STALE_MS / 1000} s, and anyhost could not remove it, so it could not trust the folder: ${messageOf(failure)}`)
      })
      continue
    }
    const wait = LOCK_WAITS_MS[tries++]
    if (wait === undefined) throw new Error(`another program held ${lock} through ${LOCK_WAITS_MS.length} tries over ${LOCK_WAITS_MS.reduce((sum, ms) => sum + ms, 0) / 1000} s, so anyhost could not trust the folder`)
    await Bun.sleep(wait * (1 + Math.random()))
  }
  try {
    return await work()
  } finally {
    await rmdir(lock).catch(() => undefined)
  }
}

async function trustHere(capture: Capture, cwd: string, from: string): Promise<void> {
  const records = await trustRecordsOf(cwd)
  const [key] = records
  const config = configOf(capture)
  const isWritten = await lockedConfig(config, async () => {
    const file = await fileOf(config)
    const read = await configAt(file)
    if (isTrusted(read, records)) return false
    const written = { ...read, projects: { ...read.projects, [key]: { ...read.projects?.[key], hasTrustDialogAccepted: true } } }
    const mode = await stat(file).then((found) => found.mode & 0o777, unlessMissing(0o600))
    const temporary = `${file}.anyhost-${crypto.randomUUID().slice(0, 8)}`
    try {
      await writeFile(temporary, JSON.stringify(written, null, 2), { mode })
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true })
    }
    return true
  })
  if (isWritten) console.error(`${stamp()} ${capture.device.name} trusts ${key} in Claude Code, as ${from} trusts the session's folder there.`)
}

async function upload(capture: Capture, session: string, tool: Tool, here: MoveHere, signal: AbortSignal, onRelay: (isConnected: boolean) => void): Promise<void> {
  const aborted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  aborted.catch(() => undefined)
  const drained = async (paths: Iterable<string> = []): Promise<void> => {
    for (const path of paths) here.queue(session, tool, path)
    await here.flush(session, signal, onRelay)
    const stopped = journalOf(capture.db, session)?.stopped ?? ''
    if (stopped !== '') throw new Error(`${capture.device.name} uploads no more of ${session.slice(0, 8)}: ${stopped}`)
  }
  const send = async (paths: Iterable<string>): Promise<void> => {
    await drained(paths)
    await Promise.race([capture.codeRuns.get(session), aborted])
    await drained()
    if (!capture.codeRuns.has(session) && !capture.codeWaiting.has(session)) startCode(capture, session, tool, here.problems, true)
    const failure = await Promise.race([capture.codeRuns.get(session), aborted])
    if (failure !== undefined) throw new Error(`anyhost could not read the code of ${session.slice(0, 8)}: ${failure.message}`)
    await drained()
  }
  await send((await changedFiles(capture, 0, session)).get(session) ?? [])
  const again = await sealJournal(capture, session, tool, here.problems)
  if (again.size > 0) {
    await send(again)
    const lost = await sealJournal(capture, session, tool, here.problems)
    if (lost.size > 0) {
      for (const path of lost) here.queue(session, tool, path)
      throw new Error(`the journal of ${session} in R2 still ends short of what ${capture.device.name} counted after it uploaded the session's files whole again`)
    }
  }
  await writeIndex(capture)
}

async function continueHere(capture: Capture, session: string, tool: Tool, here: MoveHere): Promise<void> {
  const { relay, db } = capture
  const end = journalOf(db, session)?.end ?? 0
  const { frames } = framesOf(session, await relay.list(journalPrefix(session)))
  let at = end
  for await (const { end: reached } of chainOf(relay, frames.filter((frame) => frame.start >= end), end)) at = reached
  if (at === end) return holdHere(db, session)
  for (const path of captureAgainFrom(capture, session, tool, at, end, here.problems)) here.queue(session, tool, path)
}

const isIdleIn = (sessions: readonly RunningSession[], session: string): boolean => !sessions.some((entry) => entry.sessionId === session && statusOfRecord(entry.status) !== 'idle')

async function untilSettledIdle(capture: Capture, session: string, here: MoveHere, signal?: AbortSignal): Promise<void> {
  const isIdle = (sessions: readonly RunningSession[]): boolean => isIdleIn(sessions, session)
  for (;;) {
    await whenSessions(capture.roots.claudeHome, (sessions) => (isIdle(sessions) ? true : undefined), Infinity, here.onRecordsChange, signal)
    await sleep(IDLE_SETTLES_MS, undefined, signal === undefined ? {} : { signal })
    if (isIdle(await recordedSessions(capture.roots.claudeHome))) return
  }
}

const recordOf = async (capture: Capture, session: string): Promise<RunningSession | undefined> => (await recordedSessions(capture.roots.claudeHome)).find((entry) => entry.sessionId === session)

export async function move(capture: Capture, asked: string, machine: string, here: MoveHere): Promise<Moving> {
  const { relay, db, device } = capture
  if (relay.state.is !== 'connected') throw new Error('message' in relay.state ? relay.state.message : `anyhost connects to the relay at ${relay.url}.`)
  const held = db.query<{ session: string }, [string]>('select session from journals where session like ?').all(`${asked}%`).map(({ session }) => session)
  const isWhole = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(asked)
  const [session, ...more] = held.length === 0 && isWhole ? [asked] : held
  if (session === undefined) throw new Error(`${device.name} holds no session ${asked}. anyhost list shows every session.`)
  if (more.length > 0) throw new Error(`${held.length} sessions' ids begin with ${asked}. Give more of it.`)
  const { holder = '', tool = 'claude' } = journalOf(db, session) ?? {}
  if (holder !== '') throw new Error(`This session continues on ${holder}.`)
  if (tool !== 'claude') throw new Error(`anyhost moves Claude Code sessions, and ${session.slice(0, 8)} is a Codex session.`)
  const target = await otherMachine(relay, device, machine, 'The session runs here already.')
  const running = here.moves.get(session)
  if (running !== undefined && running.step !== 'moved' && running.step !== 'failed') throw new Error(`This session is moving to ${running.to} already.`)

  const id = session.slice(0, 8)
  const isBusy = ((await recordOf(capture, session))?.status ?? 'idle') !== 'idle'
  const keeping = new AbortController()
  const kept = new Error(`Kept ${id} here, so it does not move to ${machine}.`)
  const keep = (): boolean => {
    if (keeping.signal.aborted) return false
    keeping.abort(kept)
    return true
  }
  const moving: Moving = { session, to: machine, step: 'waiting', line: '', keep }
  here.moves.set(session, moving)
  const say = (step: MoveStep, line: string): void => {
    Object.assign(moving, { step, line })
    if (step === 'moved' || step === 'failed') keeping.abort()
    console.error(`${stamp()} ${line}`)
  }
  if (isBusy) say('waiting', `Waiting for ${id} to finish its turn.`)
  else say('uploading', `Uploading ${id}.`)
  const { claudeHome } = capture.roots
  let isPausing = false
  let paused = 0
  let isAsked = false
  const resumed = async (line: string): Promise<string> => {
    if (!isPausing || (await resumeCopy(claudeHome, session)) > 0 || paused === 0) return line
    return await openHere(capture, session, here).then(
      () => line,
      (error: unknown) => `${line} anyhost could not open it here again: ${messageOf(error)}`,
    )
  }
  const takenOver = async (holder: string): Promise<void> => {
    if (isPausing) await stopCopy(claudeHome, session).catch((error: unknown) => console.error(`${stamp()} anyhost could not stop the paused copy of ${session}: ${messageOf(error)}`))
    say('failed', `${holder} took ${id} over during the move, so it continues there.`)
  }
  const fail = async (line: string): Promise<void> => {
    const holder = journalOf(db, session)?.holder ?? ''
    if (holder !== '' && !(isAsked && holder === machine)) return await takenOver(holder)
    if (!isAsked) return say('failed', await resumed(line))
    try {
      await takeClaim(relay, session, { take: true })
      await continueHere(capture, session, tool, here)
      say('failed', await resumed(line))
    } catch (error) {
      say('failed', `${line} anyhost could not take it back here: ${messageOf(error)}`)
    }
  }
  const untilIdle = (signal: AbortSignal): Promise<void> => untilSettledIdle(capture, session, here, signal)
  const keepsWaiting = async (): Promise<boolean> => {
    if ((await claimsOf(relay, session)).get(session)?.id !== target.id) return false
    const line = `${machine} took ${id} and does not answer. Keep it here takes the session back.`
    if (!keeping.signal.aborted && moving.line !== line) say('moving', line)
    return true
  }
  void (async () => {
    const { signal } = keeping
    if (isBusy) {
      await untilIdle(signal)
      say('uploading', `Uploading ${id}.`)
    }
    const uploading = (isConnected: boolean): void => say('uploading', isConnected ? `Uploading ${id}.` : `Uploading ${id} once the relay at ${relay.url} connects.`)
    await upload(capture, session, tool, here, signal, uploading)
    for (;;) {
      await untilIdle(signal)
      signal.throwIfAborted()
      isPausing = true
      paused = await pauseCopy(claudeHome, session)
      if (isIdleIn(await recordedSessions(claudeHome), session)) break
      await resumeCopy(claudeHome, session)
      isPausing = false
    }
    await upload(capture, session, tool, here, signal, uploading)
    signal.throwIfAborted()
    say('moving', `Paused ${id} here and sealed it. ${machine} restores it.`)
    const cwd = workingFolderOf(db, session)
    const trusted = cwd !== '' && (await trusts(capture, cwd))
    signal.throwIfAborted()
    const { at: claimedAt } = await takeClaim(relay, session, { take: false })
    signal.throwIfAborted()
    const started = Date.now()
    isAsked = true
    const answer = await ask(relay, { t: 'move', id: moveId(session), to: target.id, session, trusted, claimedAt, command: [...commandOf(session)] }, { signal, keepsWaiting })
    keeping.abort()
    if (answer.t === 'offline') return await fail(`${machine} is offline, so the session keeps running here.`)
    if ('error' in answer) return await fail(`${machine} could not take the session: ${reasonOf(answer.error)}. It keeps running here.`)
    const restored = `${machine} restored ${id} in ${((Date.now() - started) / 1000).toFixed(1)} s and runs it.`
    say('moved', await stopCopy(claudeHome, session).then(() => restored, (error: unknown) => `${restored} anyhost could not end its paused copy here: ${messageOf(error)}`))
  })().catch((error: unknown) => {
    if (error instanceof HeldElsewhere) return takenOver(error.holder.name)
    if (error !== kept) return fail(`anyhost could not move the session to ${machine}: ${reasonOf(error)}. It keeps running here.`)
    return fail(isAsked ? `${machine} did not answer, so the session keeps running here.` : kept.message)
  })
  return moving
}

const moveId = (session: string): string => `${session}/${crypto.randomUUID()}`

export async function receiveMoved(capture: Capture, answer: Extract<Delivered, { readonly t: 'moved' }>, here: MoveHere): Promise<void> {
  const session = answer.id.split('/')[0] ?? ''
  const journal = journalOf(capture.db, session)
  if (!('error' in answer) || here.moves.has(session) || journal === undefined) return
  if ((await claimsOf(capture.relay, session)).get(session)?.id !== answer.from.id) return
  here.moves.set(session, { session, to: capture.device.name, step: 'moving', line: '', keep: () => false })
  try {
    await takeClaim(capture.relay, session, { take: true })
    await continueHere(capture, session, journal.tool, here)
    await openHere(capture, session, here)
    console.error(`${stamp()} ${answer.from.name} could not take ${session} in a move this program forgot, so ${capture.device.name} took it back and runs it: ${reasonOf(answer.error)}.`)
  } catch (error) {
    console.error(`${stamp()} ${answer.from.name} could not take ${session} in a move this program forgot, and ${capture.device.name} could not take it back: ${messageOf(error)}`)
  } finally {
    here.moves.delete(session)
  }
}

async function answerOnce(relay: Relay, known: Map<string, Reply | undefined>, asked: { readonly id: string; readonly from: { readonly name: string } }, work: () => Promise<Reply>, forgetMs = Infinity): Promise<void> {
  const answer = (reply: Reply): void => {
    if (!relay.send(reply)) console.error(`${stamp()} anyhost sent ${asked.from.name} no answer, as this machine is not connected to the relay.`)
  }
  if (known.has(asked.id)) {
    const before = known.get(asked.id)
    if (before === undefined) return
    console.error(`${stamp()} ${asked.from.name} asked again for its answer, as it may have missed it, so anyhost sends it again.`)
    return answer(before)
  }
  known.set(asked.id, undefined)
  const reply = await work()
  known.set(asked.id, reply)
  if (Number.isFinite(forgetMs)) setTimeout(() => known.delete(asked.id), forgetMs).unref()
  answer(reply)
}

export const receiveMove = (capture: Capture, asked: Extract<Delivered, { readonly t: 'move' }>, here: MoveHere): Promise<void> =>
  answerOnce(capture.relay, here.answers, asked, () => takeSession(capture, asked, here))

async function takeSession(capture: Capture, asked: Extract<Delivered, { readonly t: 'move' }>, here: MoveHere): Promise<Reply> {
  const { device, roots } = capture
  let isOpened = false
  try {
    if ((await statusOf(roots.claudeHome, asked.session)) !== undefined && (await claimsOf(capture.relay, asked.session)).get(asked.session)?.id === device.id) {
      console.error(`${stamp()} ${asked.from.name} asked again for its move of ${asked.session}, which ${device.name} holds and runs, so anyhost answers that it moved.`)
      return { t: 'moved', id: asked.id, to: asked.from.id }
    }
    console.error(`${stamp()} ${asked.from.name} moves ${asked.session} here.`)
    await stopCopy(roots.claudeHome, asked.session)
    const { session, cwd } = await restore(capture, asked.session, { take: true, if: { at: asked.claimedAt }, checkouts: here.checkouts })
    if (asked.trusted) await trustHere(capture, cwd, asked.from.name)
    await openTerminal(cwd, session.id, ['claude', ...asked.command.slice(1)], { isResumed: true })
    isOpened = true
    const running = await whenSessions(roots.claudeHome, (sessions) => sessions.find((entry) => entry.sessionId === session.id), RUNNING_MS, here.onRecordsChange)
    if (running === undefined) throw new Error(`Claude Code listed the session ${session.id.slice(0, 8)} running on ${device.name} no ${RUNNING_MS / 1000} s after its start`)
    await takeClaim(capture.relay, session.id, { take: false }).catch((error: unknown) => {
      throw error instanceof HeldElsewhere ? new Error(`${error.holder.name} took the session back`) : error
    })
    console.error(`${stamp()} ${device.name} runs ${session.id} in a terminal of herdr-core in ${cwd}.`)
    return { t: 'moved', id: asked.id, to: asked.from.id }
  } catch (error) {
    console.error(`${stamp()} ${device.name} could not take ${asked.session} from ${asked.from.name}: ${messageOf(error)}`)
    if (isOpened) await stopCopy(roots.claudeHome, asked.session).catch((failure: unknown) => console.error(`${stamp()} ${device.name} could not stop the copy it started of ${asked.session}: ${messageOf(failure)}`))
    return { t: 'moved', id: asked.id, to: asked.from.id, error: messageOf(error) }
  }
}

export async function startNew(capture: Capture, machine: string, cwd: string, prompt: string, here: MoveHere, parent = ''): Promise<string> {
  if (machine === '' || machine === capture.device.name) return await startIn(capture, cwd, prompt, here, { session: parent, machine: capture.device.name })
  const target = await otherMachine(capture.relay, capture.device, machine, 'Run claude here.')
  const { repo, folder: inside } = await checkoutOf(cwd)
  const branch = repo === '' ? '' : (await run(['git', '-C', cwd, 'branch', '--show-current'])).trim()
  const trusted = await trusts(capture, cwd)
  const answer = await ask(
    capture.relay,
    { t: 'start', id: crypto.randomUUID(), to: target.id, repo, branch, folder: repo === '' ? cwd : inside, trusted, prompt, sender: parent },
    { keepsWaiting: async () => false },
  )
  if (answer.t === 'offline') throw new Error(`${machine} went offline before it answered. anyhost list shows whether a session started there.`)
  if ('error' in answer) throw new Error(`${machine} could not start a session: ${reasonOf(answer.error)}.`)
  return answer.session
}

export const receiveStart = (capture: Capture, asked: Extract<Delivered, { readonly t: 'start' }>, here: MoveHere): Promise<void> =>
  answerOnce(capture.relay, here.answers, asked, () => startSession(capture, asked, here))

async function startSession(capture: Capture, asked: Extract<Delivered, { readonly t: 'start' }>, here: MoveHere): Promise<Reply> {
  const { relay, roots, device } = capture
  try {
    if ((await statusOf(roots.claudeHome, asked.id)) !== undefined || (await labelledTerminals(asked.id)).length > 0) {
      console.error(`${stamp()} ${asked.from.name} asked again for the session ${asked.id} it started here, which runs, so anyhost answers that it started.`)
      return { t: 'started', id: asked.id, to: asked.from.id, session: asked.id }
    }
    const writer = (await devicesOf(relay)).get(asked.from.id)?.roots
    if (writer === undefined) throw new Error(`the relay knows no machine ${asked.from.name}`)
    const place = asked.repo === '' ? { repo: '', repoFolder: '', cwd: asked.folder } : { repo: asked.repo, repoFolder: asked.folder, cwd: '' }
    const cwd = await localFolder(capture, place, writer, here.checkouts)
    await cloneMissing(place, cwd, roots.home, asked.branch)
    await mkdir(cwd, { recursive: true })
    if (asked.trusted) await trustHere(capture, cwd, asked.from.name)
    const session = await startIn(capture, cwd, asked.prompt, here, { session: asked.sender ?? '', machine: asked.from.name }, asked.id)
    console.error(`${stamp()} ${device.name} started ${session} in ${cwd} for ${asked.from.name}.`)
    return { t: 'started', id: asked.id, to: asked.from.id, session }
  } catch (error) {
    console.error(`${stamp()} ${device.name} could not start a session for ${asked.from.name}: ${messageOf(error)}`)
    return { t: 'started', id: asked.id, to: asked.from.id, error: messageOf(error) }
  }
}

async function startIn(capture: Capture, cwd: string, prompt: string, here: MoveHere, parent: { readonly session: string; readonly machine: string }, session: string = crypto.randomUUID()): Promise<string> {
  const { relay, roots, device } = capture
  const begin = async (running: RunningSession | undefined): Promise<void> => {
    if (running === undefined) throw new Error(`Claude Code listed the new session ${session.slice(0, 8)} running on ${device.name} no ${RUNNING_MS / 1000} s after its start, or no day after it in a folder it asked the person to trust.`)
    await takeClaim(relay, session, { take: false })
    if (prompt !== '') await tellHere(capture, session, { text: prompt, keys: [], lines: 0, sender: parent.session }, here, parent.machine)
  }
  let isOpened = false
  try {
    const isTrusted = await trusts(capture, cwd)
    await openTerminal(cwd, session, ['claude', '--session-id', session], { isResumed: false })
    isOpened = true
    const running = whenSessions(roots.claudeHome, (sessions) => (runOf(session)?.terminal === undefined ? undefined : sessions.find((entry) => entry.sessionId === session)), isTrusted ? RUNNING_MS : TRUST_ANSWER_MS, here.onRecordsChange)
    if (!isTrusted) {
      void running.then(begin).catch((error: unknown) => console.error(`${stamp()} ${device.name} could not give ${session} its first message: ${messageOf(error)}`))
      return session
    }
    await begin(await running)
    return session
  } catch (error) {
    if (isOpened) await stopCopy(roots.claudeHome, session).catch((failure: unknown) => console.error(`${stamp()} ${device.name} could not stop the session ${session} it started: ${messageOf(failure)}`))
    throw error
  }
}

export async function sessionOf(capture: Capture, asked: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(asked)) return asked
  const local = capture.db.query<{ session: string }, [string]>('select session from journals where session like ?').all(`${asked}%`).map(({ session }) => session)
  const known = [...new Set([...(await claimsOf(capture.relay, asked)).keys(), ...local])].filter((id) => !id.includes('@'))
  const [session, ...more] = known
  if (session === undefined) throw new Error(`No session's id begins with ${asked}. anyhost list shows every session.`)
  if (more.length > 0) throw new Error(`${known.length} sessions' ids begin with ${asked}. Give more of it.`)
  return session
}

export type Tell = { readonly text: string; readonly keys: readonly string[]; readonly lines: number; readonly sender: string; readonly messages?: number }
export type Told = { readonly machine: string; readonly session: string; readonly status: AgentStatus; readonly screen: string; readonly messages?: readonly Message[] }

async function messagesHere(capture: Capture, session: string, count: number): Promise<Message[]> {
  if ((journalOf(capture.db, session)?.tool ?? 'claude') !== 'claude') throw new Error(`anyhost reads the messages of Claude Code sessions, and ${session.slice(0, 8)} is a Codex session.`)
  const projects = join(capture.roots.claudeHome, 'projects')
  const found = await Promise.all([...new Bun.Glob(`*/${session}.jsonl`).scanSync({ cwd: projects })].map(async (path) => ({ path: join(projects, path), at: (await stat(join(projects, path))).mtimeMs })))
  const newest = found.sort((a, b) => b.at - a.at)[0]
  if (newest === undefined) throw new Error(`${session.slice(0, 8)} has no transcript on ${capture.device.name}.`)
  return messagesOf(await Bun.file(newest.path).text(), count)
}

const tagged = (told: Tell, machine: string): string => {
  if (told.sender === '') return told.text
  const sender = told.sender.slice(0, 8)
  return `<anyhost from="${sender} on ${machine}" reach="tell_agent ${sender} when done or stuck">${told.text}</anyhost>`
}

async function terminalHere(capture: Capture, session: string): Promise<string | undefined> {
  const address = await runTerminalOf(capture.roots.claudeHome, session)
  if (address !== undefined) return address
  if ((await statusOf(capture.roots.claudeHome, session)) === undefined) return undefined
  throw new Error(`${session.slice(0, 8)} runs on ${capture.device.name} outside herdr-core, so anyhost cannot type into it or read it.`)
}

function terminalOf(capture: Capture, session: string, here: MoveHere): Promise<string> {
  const opening = here.opening.get(session)
  if (opening !== undefined) return opening
  const opened = placeInTerminal(capture, session, here).finally(() => here.opening.delete(session))
  here.opening.set(session, opened)
  return opened
}

async function placeInTerminal(capture: Capture, session: string, here: MoveHere): Promise<string> {
  const { db, roots } = capture
  const id = session.slice(0, 8)
  const ran = await runTerminalOf(roots.claudeHome, session)
  if (ran !== undefined) return ran
  if ((journalOf(db, session)?.tool ?? 'claude') !== 'claude') throw new Error(`anyhost runs Claude Code sessions in herdr-core, and ${id} is a Codex session.`)
  if ((await statusOf(roots.claudeHome, session)) !== undefined) {
    await untilSettledIdle(capture, session, here)
    await stopCopy(roots.claudeHome, session)
  }
  const known = workingFolderOf(db, session)
  const journal = journalOf(db, session)
  const isHeld = journal !== undefined && journal.holder === '' && journal.stopped === '' && !isDeleted(db, session)
  const isThere = known !== '' && (await stat(known).then((found) => found.isDirectory(), () => false))
  const restored = async (): Promise<string> => {
    const placed = await restore(capture, session, { take: true, if: { gone: true }, checkouts: here.checkouts }).catch((error: unknown) => {
      throw error instanceof HeldElsewhere ? new Error(`${error.holder.name} runs ${id} and is connected, so ${id} opens there and not on ${capture.device.name}.`) : error
    })
    return placed.cwd
  }
  const cwd = isHeld && isThere ? known : await restored()
  for (const stale of await labelledTerminals(session)) await killTerminal(stale)
  return await openTerminal(cwd, session, commandOf(session), { isResumed: true })
}

async function tellHere(capture: Capture, session: string, told: Tell, here: MoveHere, sender = capture.device.name): Promise<Omit<Told, 'machine' | 'session'>> {
  const { db, device, roots } = capture
  const id = session.slice(0, 8)
  const holder = journalOf(db, session)?.holder ?? ''
  if (holder !== '') throw new Error(`${id} continues on ${holder}.`)
  if ((told.messages ?? 0) > 0) return { status: (await statusOf(roots.claudeHome, session)) ?? 'idle', screen: '', messages: await messagesHere(capture, session, told.messages ?? 0) }
  const isRead = told.text === '' && told.keys.length === 0
  const address = isRead ? await terminalHere(capture, session) : await terminalOf(capture, session, here)
  if (address === undefined) throw new Error(`${id} runs in no terminal of herdr-core on ${device.name}. Tell it something to start it again.`)
  if (told.keys.length > 0) await pressKeys(address, told.keys)
  if (told.text !== '') {
    await sendTo(address, tagged(told, sender))
    await whenSessions(roots.claudeHome, (sessions) => sessions.find((entry) => entry.sessionId === session)?.status === 'busy' || undefined, TURN_STARTS_MS, here.onRecordsChange)
  }
  return { status: (await statusOf(roots.claudeHome, session)) ?? 'idle', screen: await readTerminal(address, told.lines) }
}

export async function tell(capture: Capture, asked: string, told: Tell, here: MoveHere): Promise<Told> {
  const { relay, device } = capture
  const session = await sessionOf(capture, asked)
  const holder = (await claimsOf(relay, session)).get(session)
  if (holder === undefined || holder.id === device.id) return { machine: device.name, session, ...(await tellHere(capture, session, told, here)) }
  const answer = await ask(relay, { t: 'tell', id: crypto.randomUUID(), to: holder.id, session, ...told }, { signal: AbortSignal.timeout(TELL_MS), keepsWaiting: async () => false }).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new Error(`${holder.name}, which holds ${session.slice(0, 8)}, did not answer within ${TELL_MS / 1000} s. An anyhost older than 0.4.0 there does not answer at all.`)
    throw error
  })
  if (answer.t === 'offline') throw new Error(`${holder.name}, which holds ${session.slice(0, 8)}, is offline. open_agent continues it on another machine.`)
  if ('error' in answer) throw new Error(`${holder.name}: ${answer.error}`)
  return { machine: holder.name, session, status: answer.status, screen: answer.screen, ...(answer.messages === undefined ? {} : { messages: answer.messages }) }
}

export function noteWaiting(capture: Capture, here: MoveHere): () => void {
  let waiting: ReadonlySet<string> | undefined
  let isAsked = false
  let reading = Promise.resolve()
  const read = async (): Promise<void> => {
    isAsked = false
    const now = new Set((await recordedSessions(capture.roots.claudeHome)).filter(({ status }) => status === 'waiting').map(({ sessionId }) => sessionId))
    const fresh = waiting === undefined ? [] : [...now].filter((session) => !waiting?.has(session))
    waiting = now
    if (fresh.length === 0) return
    const { parents } = await sharedOf(capture.relay)
    for (const session of fresh) {
      const parent = parents[session]
      if (parent === undefined) continue
      const id = session.slice(0, 8)
      const note = `${id} waits at a permission prompt on ${capture.device.name}. read_agent ${id} shows it, and press_keys ${id} answers it.`
      void tell(capture, parent, { text: note, keys: [], lines: 0, sender: session }, here).catch((error: unknown) => console.error(`${stamp()} anyhost could not tell ${parent} that ${id} waits at a permission prompt: ${messageOf(error)}`))
    }
  }
  const readAgain = (): void => {
    if (isAsked) return
    isAsked = true
    reading = reading.then(read).catch((error: unknown) => console.error(`${stamp()} anyhost could not read which sessions wait at a permission prompt: ${messageOf(error)}`))
  }
  readAgain()
  return readAgain
}

export const receiveTell = (capture: Capture, asked: Extract<Delivered, { readonly t: 'tell' }>, here: MoveHere): Promise<void> =>
  answerOnce(
    capture.relay,
    here.answers,
    asked,
    () =>
      tellHere(capture, asked.session, asked, here, asked.from.name).then(
        ({ status, screen, messages }): Reply => ({ t: 'told', id: asked.id, to: asked.from.id, status, screen, ...(messages === undefined ? {} : { messages }) }),
        (error: unknown): Reply => ({ t: 'told', id: asked.id, to: asked.from.id, error: messageOf(error) }),
      ),
    FORGET_MS,
  )

async function statusesHere(capture: Capture): Promise<Record<string, AgentStatus>> {
  const statuses: Record<string, AgentStatus> = Object.fromEntries(runSessions().map((session) => [session, 'idle']))
  for (const { sessionId, status } of await recordedSessions(capture.roots.claudeHome)) statuses[sessionId] = statusOfRecord(status)
  return statuses
}

export const receiveList = (capture: Capture, asked: Extract<Delivered, { readonly t: 'list' }>, here: MoveHere): Promise<void> =>
  answerOnce(capture.relay, here.answers, asked, async () => ({ t: 'listed', id: asked.id, to: asked.from.id, statuses: await statusesHere(capture) }), FORGET_MS)

export async function statusesOf(capture: Capture): Promise<Record<string, AgentStatus>> {
  const { relay, device } = capture
  const others = [...(await devicesOf(relay)).values()].filter((machine) => machine.id !== device.id && machine.connected && machine.removedAt === undefined)
  const answers = await Promise.all(
    others.map((machine) =>
      ask(relay, { t: 'list', id: crypto.randomUUID(), to: machine.id }, { signal: AbortSignal.timeout(LIST_MS), keepsWaiting: async () => false }).then(
        (answer) => (answer.t === 'listed' ? answer.statuses : {}),
        () => ({}),
      ),
    ),
  )
  return Object.assign({}, ...answers, await statusesHere(capture)) as Record<string, AgentStatus>
}

export async function openHere(capture: Capture, asked: string, here: MoveHere): Promise<{ readonly session: string; readonly terminal: string }> {
  const session = await sessionOf(capture, asked)
  return { session, terminal: await terminalOf(capture, session, here) }
}

export async function deleteAgent(capture: Capture, asked: string, here: MoveHere): Promise<string> {
  const { relay, device } = capture
  const session = await sessionOf(capture, asked)
  const holder = (await claimsOf(relay, session)).get(session)
  if (holder === undefined || holder.id === device.id) return await deleteHere(capture, session, here)
  const answer = await ask(relay, { t: 'delete', id: crypto.randomUUID(), to: holder.id, session }, { signal: AbortSignal.timeout(TELL_MS), keepsWaiting: async () => false }).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new Error(`${holder.name}, which holds ${session.slice(0, 8)}, did not answer within ${TELL_MS / 1000} s. An anyhost older than 0.7.3 there does not answer at all.`)
    throw error
  })
  if (answer.t === 'offline') throw new Error(`${holder.name}, which holds ${session.slice(0, 8)}, is offline, so delete it once ${holder.name} connects.`)
  if ('error' in answer) throw new Error(`${holder.name}: ${answer.error}`)
  return answer.session
}

export const receiveDelete = (capture: Capture, asked: Extract<Delivered, { readonly t: 'delete' }>, here: MoveHere): Promise<void> =>
  answerOnce(
    capture.relay,
    here.answers,
    asked,
    () =>
      deleteHere(capture, asked.session, here).then(
        (session): Reply => ({ t: 'deleted', id: asked.id, to: asked.from.id, session }),
        (error: unknown): Reply => ({ t: 'deleted', id: asked.id, to: asked.from.id, error: messageOf(error) }),
      ),
    FORGET_MS,
  )

async function deleteHere(capture: Capture, asked: string, here: MoveHere): Promise<string> {
  const { db, device, roots } = capture
  const session = await sessionOf(capture, asked)
  const journal = journalOf(db, session)
  if (journal === undefined) throw new Error(`${session.slice(0, 8)} has no files on ${device.name}.`)
  if (journal.holder !== '') throw new Error(`${session.slice(0, 8)} continues on ${journal.holder}, so delete it there.`)
  await stopCopy(roots.claudeHome, session)
  const owned = db.query<{ path: string }, [string]>("select path from files where session = ? and sha256 != ''").all(session).map(({ path }) => path).filter((path) => {
    const owner = ownerOf(path, roots)
    return owner !== undefined && 'session' in owner && owner.session === session
  })
  for (const path of owned) {
    await rm(path, { force: true })
    here.queue(session, journal.tool, path)
  }
  await here.flush(session, new AbortController().signal, () => undefined)
  await writeIndex(capture)
  return session
}

export async function receiveReleased(capture: Capture, session: string, holder: string, here: MoveHere): Promise<void> {
  const moving = here.moves.get(session)
  if (moving !== undefined && moving.step !== 'moved' && moving.step !== 'failed') return
  const { db, device, roots } = capture
  await whenSessions(roots.claudeHome, (sessions) => (sessions.find((entry) => entry.sessionId === session)?.status === 'busy' ? undefined : true), Infinity, here.onRecordsChange)
  if ((journalOf(db, session)?.holder ?? '') === '') return
  await stopCopy(roots.claudeHome, session).then(
    () => console.error(`${stamp()} ${holder} took ${session} over, so ${device.name} stopped its copy here.`),
    (error: unknown) => console.error(`${stamp()} ${holder} took ${session} over, and ${device.name} could not stop its copy: ${messageOf(error)}`),
  )
}
