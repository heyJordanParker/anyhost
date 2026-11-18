import { mkdir, readFile, readlink, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { AgentStatus, Delivered, DeviceRef, Message, Offline, Routed } from '../../relay/protocol.ts'
import type { Activity, Shown } from './activity.ts'
import { captureAgainFrom, chainOf, changedFiles, checkoutOf, checkoutOfEntry, framesOf, holdHere, journalOf, journalPrefix, sealJournal, startCode, workingFolderOf, writeIndex, type Capture, type Problems } from './capture.ts'
import { claimsOf, HeldElsewhere, takeClaim, type Placement } from './claims.ts'
import { claudeStart, pauseCopy, pausedSessions, recordedSessions, resumeArgv, resumedOf, resumeCopy, run, statusOf, statusOfRecord, stopCopy, whenSessions, type OnRecordsChange, type RunningSession } from './claude.ts'
import { devicesOf, otherMachine } from './device.ts'
import { askToSleep, hcPath, labelledTerminals, openTerminal, pressKeys, readTerminal, sendTo } from './hc.ts'
import { showTerminal, type Place } from './herdr.ts'
import type { Relay } from './relay.ts'
import { cloneMissing, localFolder, restore } from './resume.ts'
import { agentsOf, titleOfPrompt } from './sessions.ts'
import { sharedOf } from './shared.ts'
import { FORK_VERSION, forkedTranscript, lastFolderOf, lastMessageIn, lastTurnOf, messagesOf, ownerOf, transcriptOf, transcriptTailOf, type Tool } from './transcript.ts'

const RUNNING_MS = 60_000
const IDLE_SETTLES_MS = 2000
const TRUST_ANSWER_MS = 86_400_000
const CONNECTED_MS = 10_000
const TELL_MS = 25_000
const TURN_STARTS_MS = 10_000
const LIST_MS = 5000
const LOCK_STALE_MS = 10_000
const LOCK_WAITS_MS = [200, 400, 800, 1600, 3200, 4000]

type MoveStep = 'waiting' | 'uploading' | 'moving' | 'moved' | 'failed'
export type Moving = { readonly session: string; readonly to: string; readonly wanted: string; step: MoveStep; line: string; readonly keeping: AbortController; handedAt: number }
export type MoveHere = {
  readonly moves: Map<string, Moving>
  readonly placing: Map<string, Promise<void>>
  readonly placed: Set<(session: string) => void>
  readonly problems: Problems
  readonly checkouts: string
  readonly queue: (session: string, tool: Tool, path: string) => void
  readonly flush: (session: string, signal: AbortSignal, onRelay: (isConnected: boolean) => void) => Promise<void>
  readonly onRecordsChange: OnRecordsChange
  readonly opening: Map<string, Promise<string>>
  readonly touched: Map<string, number>
  readonly activity: Activity
  readonly onStatusElsewhere: (machine: string, session: string, status: AgentStatus) => void
}

type Reply = Extract<Routed, { readonly t: 'told' | 'listed' | 'deleted' | 'forked' }>
const ANSWER = { tell: 'told', list: 'listed', delete: 'deleted', fork: 'forked' } as const
type Asked = Extract<Routed, { readonly t: keyof typeof ANSWER }>
type AnswerTo<A extends Asked> = Extract<Delivered, { readonly t: (typeof ANSWER)[A['t']] }> | Offline

type MoveSpec = { readonly kind: 'move'; readonly trusted: boolean }
type StartSpec = { readonly kind: 'start'; readonly from: DeviceRef; readonly repo: string; readonly branch: string; readonly folder: string; readonly trusted: boolean; readonly prompt: string; readonly sender: string }
type Spec = MoveSpec | StartSpec
const specOf = ({ spec }: Placement): Spec | undefined => spec as Spec | undefined

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const reasonOf = (error: unknown): string => messageOf(error).replace(/\.+$/, '')
const stamp = (): string => new Date().toISOString()
const isFinal = (moving: Moving | undefined): boolean => moving === undefined || moving.step === 'moved' || moving.step === 'failed'

async function ask<A extends Asked>(relay: Relay, message: A, signal: AbortSignal): Promise<AnswerTo<A>> {
  signal.throwIfAborted()
  const stops: (() => void)[] = []
  try {
    return await new Promise<AnswerTo<A>>((resolve, reject) => {
      stops.push(
        relay.on(ANSWER[message.t], (answer) => (answer.id === message.id ? resolve(answer as AnswerTo<A>) : undefined)),
        relay.on('offline', (answer) => (answer.id === message.id ? resolve(answer) : undefined)),
      )
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      if (!relay.send(message)) reject(new Error(`This machine is not connected to the relay at ${relay.url}, so anyhost sent nothing.`))
    })
  } finally {
    for (const stop of stops) stop()
  }
}

const replyTo = (relay: Relay, asked: { readonly from: { readonly name: string } }, reply: Reply): void => {
  if (!relay.send(reply)) console.error(`${stamp()} anyhost sent ${asked.from.name} no answer, as this machine is not connected to the relay.`)
}

async function want(relay: Relay, session: string, device: string, { spec, error, if: wanted }: { readonly spec?: Spec; readonly error?: string; readonly if?: string } = {}): Promise<void> {
  await relay.runOne({ op: 'want', session, device, ...(spec === undefined ? {} : { spec }), ...(error === undefined ? {} : { error }), ...(wanted === undefined ? {} : { if: { wanted } }) })
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

type TrustRecords = readonly [string, ...string[]]

async function trustRecordsOf(cwd: string): Promise<TrustRecords> {
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

async function trustToWrite(capture: Capture, cwd: string): Promise<TrustRecords | undefined> {
  const [records, found] = await Promise.all([trustRecordsOf(cwd), configAt(configOf(capture)).catch(() => undefined)])
  return found !== undefined && isTrusted(found, records) ? undefined : records
}

async function trustHere(capture: Capture, records: TrustRecords | undefined, because: string): Promise<void> {
  if (records === undefined) return
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
  if (isWritten) console.error(`${stamp()} ${capture.device.name} trusts ${key} in Claude Code, as ${because}.`)
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
  if (running !== undefined && !isFinal(running)) throw new Error(`This session is moving to ${running.to} already.`)
  if (!target.connected) throw new Error(`${machine} is offline, so the session keeps running here.`)
  const cwd = workingFolderOf(db, session)
  const trusted = cwd !== '' && (await trusts(capture, cwd).catch((error: unknown) => {
    throw new Error(`anyhost could not move the session to ${machine}: ${reasonOf(error)}. It keeps running here.`)
  }))
  await want(relay, session, target.id, { spec: { kind: 'move', trusted } })
  return await drainTo(capture, session, target, here)
}

export async function keepHere(capture: Capture, session: string, here: MoveHere): Promise<boolean> {
  const moving = here.moves.get(session)
  if (moving === undefined || isFinal(moving)) return false
  moving.keeping.abort()
  await want(capture.relay, session, capture.device.id)
  return true
}

async function resumedHere(capture: Capture, session: string, here: MoveHere, line: string): Promise<string> {
  if (!pausedSessions().includes(session) || (await resumeCopy(capture.roots.claudeHome, session)) > 0) return line
  return await openHere(capture, session, here).then(
    () => line,
    (error: unknown) => `${line} anyhost could not open it here again: ${messageOf(error)}`,
  )
}

const sayOn = (moving: Moving | undefined, step: MoveStep, line: string): void => {
  if (moving !== undefined) Object.assign(moving, { step, line })
  console.error(`${stamp()} ${line}`)
}

async function drainTo(capture: Capture, session: string, target: DeviceRef, here: MoveHere): Promise<Moving> {
  const running = here.moves.get(session)
  if (running !== undefined && !isFinal(running)) return running
  const { relay, roots } = capture
  const id = session.slice(0, 8)
  const moving: Moving = { session, to: target.name, wanted: target.id, step: 'waiting', line: '', keeping: new AbortController(), handedAt: 0 }
  here.moves.set(session, moving)
  const say = (step: MoveStep, line: string): void => sayOn(moving, step, line)
  const { signal } = moving.keeping
  const tool = journalOf(capture.db, session)?.tool ?? 'claude'
  const isBusy = ((await recordOf(capture, session))?.status ?? 'idle') !== 'idle'
  if (isBusy) say('waiting', `Waiting for ${id} to finish its turn.`)
  else say('uploading', `Uploading ${id}.`)
  void (async () => {
    if (isBusy) {
      await untilSettledIdle(capture, session, here, signal)
      say('uploading', `Uploading ${id}.`)
    }
    const uploading = (isConnected: boolean): void => say('uploading', isConnected ? `Uploading ${id}.` : `Uploading ${id} once the relay at ${relay.url} connects.`)
    await upload(capture, session, tool, here, signal, uploading)
    for (;;) {
      await untilSettledIdle(capture, session, here, signal)
      signal.throwIfAborted()
      await pauseCopy(roots.claudeHome, session)
      if (isIdleIn(await recordedSessions(roots.claudeHome), session)) break
      await resumeCopy(roots.claudeHome, session)
    }
    await upload(capture, session, tool, here, signal, uploading)
    signal.throwIfAborted()
    const forgot = await relay.runOne({ op: 'forget', session })
    if (forgot.status === 409 && forgot.holder.id !== target.id) throw new HeldElsewhere(forgot.holder)
    moving.handedAt = Date.now()
    say('moving', `Paused ${id} here and sealed it. ${target.name} restores it.`)
    await placeSession(capture, session, here)
  })().catch(async (error: unknown) => {
    const holder = error instanceof HeldElsewhere ? error.holder.name : (journalOf(capture.db, session)?.holder ?? '')
    if (holder !== '') {
      await want(relay, session, '', { if: target.id }).catch((failure: unknown) => console.error(`${stamp()} anyhost could not drop the move of ${session}: ${messageOf(failure)}`))
      await stopCopy(roots.claudeHome, session).catch((failure: unknown) => console.error(`${stamp()} anyhost could not stop the paused copy of ${session}: ${messageOf(failure)}`))
      return say('failed', `${holder} took ${id} over during the move, so it continues there.`)
    }
    const isKept = signal.aborted
    if (!isKept) await want(relay, session, '', { error: reasonOf(error), if: target.id }).catch((failure: unknown) => console.error(`${stamp()} anyhost could not drop the move of ${session}: ${messageOf(failure)}`))
    const line = isKept ? `Kept ${id} here, so it does not move to ${target.name}.` : `anyhost could not move the session to ${target.name}: ${reasonOf(error)}. It keeps running here.`
    say('failed', await resumedHere(capture, session, here, line))
  })
  return moving
}

export function placeSession(capture: Capture, session: string, here: MoveHere): Promise<void> {
  for (const placed of here.placed) placed(session)
  const next = (here.placing.get(session) ?? Promise.resolve()).then(() => reconcile(capture, session, here)).catch((error: unknown) => console.error(`${stamp()} anyhost could not place ${session}: ${messageOf(error)}`))
  here.placing.set(session, next)
  void next.finally(() => {
    if (here.placing.get(session) === next) here.placing.delete(session)
  })
  return next
}

async function reconcile(capture: Capture, session: string, here: MoveHere): Promise<void> {
  const { relay, device, roots } = capture
  const placement = capture.holders.placementOf(session)
  const moving = here.moves.get(session)
  const isPaused = pausedSessions().includes(session)
  const isHere = (id: string): boolean => id === '' || id === device.id
  const id = session.slice(0, 8)
  if (moving !== undefined && !isFinal(moving) && moving.step !== 'moving' && placement.wanted !== moving.wanted) moving.keeping.abort()
  if (placement.device === device.id && !isHere(placement.wanted)) {
    if (moving !== undefined && (!isFinal(moving) || (moving.wanted === placement.wanted && moving.keeping.signal.aborted))) return
    const target = (await devicesOf(relay)).get(placement.wanted)
    if (target === undefined || !target.connected || target.removedAt !== undefined) return await want(relay, session, '', { error: `${target?.name ?? placement.wanted} is offline`, if: placement.wanted })
    await drainTo(capture, session, target, here)
    return
  }
  if (!isPaused) {
    if (placement.wanted === device.id) await placeWanted(capture, session, placement, here)
    return
  }
  if (moving !== undefined && !isFinal(moving) && moving.step !== 'moving') return
  const to = moving?.to ?? 'The other machine'
  if (!isHere(placement.device) && placement.wanted === '') {
    await stopCopy(roots.claudeHome, session)
    const took = moving === undefined || moving.handedAt === 0 ? '' : ` in ${((Date.now() - moving.handedAt) / 1000).toFixed(1)} s`
    here.onStatusElsewhere(placement.device, session, 'idle')
    return sayOn(moving, 'moved', `${(await devicesOf(relay)).get(placement.device)?.name ?? placement.device} restored ${id}${took} and runs it.`)
  }
  if (!isHere(placement.wanted)) {
    if (!isHere(placement.device)) sayOn(moving, 'moving', `${to} took ${id} and restores it. Keep it here takes the session back.`)
    return
  }
  const isTaken = !isHere(placement.device)
  const line = isTaken
    ? `${to} did not answer, so the session keeps running here.`
    : placement.error === undefined
      ? `Kept ${id} here, so it does not move to ${to}.`
      : `${to} could not take the session: ${reasonOf(placement.error)}. It keeps running here.`
  try {
    if (placement.device !== device.id) {
      await takeClaim(relay, session, isTaken ? { take: true, if: { gone: true } } : { take: false })
      await continueHere(capture, session, journalOf(capture.db, session)?.tool ?? 'claude', here)
    }
    sayOn(moving, 'failed', await resumedHere(capture, session, here, line))
    if (placement.wanted !== '' || placement.error !== undefined) await want(relay, session, '', { if: placement.wanted })
  } catch (error) {
    if (!(error instanceof HeldElsewhere)) sayOn(moving, 'failed', `${line} anyhost could not take it back here: ${messageOf(error)}`)
  }
}

async function placeWanted(capture: Capture, session: string, placement: Placement, here: MoveHere): Promise<void> {
  const { relay, device, roots } = capture
  const spec = specOf(placement)
  try {
    if (placement.device !== device.id || (await statusOf(roots.claudeHome, session)) === undefined) {
      if (spec?.kind === 'start') await startSession(capture, session, spec, here)
      else await takeSession(capture, session, spec?.trusted ?? false, here)
    }
    await want(relay, session, '', { if: device.id })
  } catch (error) {
    if (error instanceof HeldElsewhere) return
    console.error(`${stamp()} ${device.name} could not place ${session} here: ${messageOf(error)}`)
    await Promise.all(relay.run([{ op: 'forget', session }, { op: 'want', session, device: '', error: messageOf(error), if: { wanted: device.id } }]))
  }
}

async function takeSession(capture: Capture, session: string, trusted: boolean, here: MoveHere): Promise<void> {
  const { device, roots } = capture
  let isOpened = false
  try {
    console.error(`${stamp()} ${device.name} takes ${session} over.`)
    await stopCopy(roots.claudeHome, session)
    const { session: listed, cwd } = await restore(capture, session, { take: true, if: { gone: true }, checkouts: here.checkouts, isMove: true })
    if (trusted) await trustHere(capture, await trustToWrite(capture, cwd), "the machine it moved from trusts the session's folder")
    const [tail, checkout] = await Promise.all([newestTail(capture, listed.id), checkoutAt(capture, listed.id, cwd)])
    await openTerminal(cwd, listed.id, claudeOf(capture, listed.id, tail), checkout)
    isOpened = true
    const running = await whenSessions(roots.claudeHome, (sessions) => sessions.find((entry) => entry.sessionId === listed.id), RUNNING_MS, here.onRecordsChange)
    if (running === undefined) throw new Error(`Claude Code listed the session ${listed.id.slice(0, 8)} running on ${device.name} no ${RUNNING_MS / 1000} s after its start`)
    console.error(`${stamp()} ${device.name} runs ${listed.id} in a terminal of herdr-core in ${cwd}.`)
  } catch (error) {
    if (isOpened) await stopCopy(roots.claudeHome, session).catch((failure: unknown) => console.error(`${stamp()} ${device.name} could not stop the copy it started of ${session}: ${messageOf(failure)}`))
    throw error
  }
}

export async function startNew(capture: Capture, machine: string, cwd: string, prompt: string, here: MoveHere, parent = ''): Promise<string> {
  const { relay, device, holders } = capture
  if (machine === '' || machine === device.name) return await startIn(capture, cwd, prompt, here, { session: parent, machine: device.name })
  const target = await otherMachine(relay, device, machine, 'Run claude here.')
  if (!target.connected) throw new Error(`${machine} is offline, so no session starts there.`)
  const { repo, folder: inside } = await checkoutOf(cwd)
  const branch = repo === '' ? '' : (await run(['git', '-C', cwd, 'branch', '--show-current'])).trim()
  const spec: StartSpec = { kind: 'start', from: { id: device.id, name: device.name }, repo, branch, folder: repo === '' ? cwd : inside, trusted: await trusts(capture, cwd), prompt, sender: parent }
  const session = crypto.randomUUID()
  return await new Promise<string>((resolve, reject) => {
    const stop = (): void => {
      here.placed.delete(placed)
      clearInterval(watching)
    }
    const placed = (changed: string): void => {
      const now = holders.placementOf(changed)
      if (changed !== session || now.wanted !== '') return
      stop()
      if (now.error !== undefined) reject(new Error(`${machine} could not start a session: ${reasonOf(now.error)}.`))
      else if (now.device === target.id) resolve(session)
      else reject(new Error(`The start of a session on ${machine} was called off.`))
    }
    const watching = setInterval(() => {
      void devicesOf(relay).then(async (devices) => {
        if (devices.get(target.id)?.connected === true || !here.placed.has(placed)) return
        stop()
        await want(relay, session, '', { if: target.id })
        reject(new Error(`${machine} went offline before it answered. anyhost list shows whether a session started there.`))
      }, () => undefined)
    }, CONNECTED_MS)
    here.placed.add(placed)
    want(relay, session, target.id, { spec }).catch((error: unknown) => {
      stop()
      reject(error)
    })
  })
}

async function startSession(capture: Capture, session: string, spec: StartSpec, here: MoveHere): Promise<void> {
  const { relay, roots, device } = capture
  if ((await statusOf(roots.claudeHome, session)) !== undefined || (await labelledTerminals(session)).length > 0) return
  const writer = (await devicesOf(relay)).get(spec.from.id)?.roots
  if (writer === undefined) throw new Error(`the relay knows no machine ${spec.from.name}`)
  const place = spec.repo === '' ? { repo: '', repoFolder: '', cwd: spec.folder } : { repo: spec.repo, repoFolder: spec.folder, cwd: '' }
  const cwd = await localFolder(capture, place, writer, here.checkouts)
  await cloneMissing(place, cwd, roots.home, spec.branch)
  await mkdir(cwd, { recursive: true })
  if (spec.trusted) await trustHere(capture, await trustToWrite(capture, cwd), `${spec.from.name} trusts the session's folder there`)
  await takeClaim(relay, session, { take: false })
  await startIn(capture, cwd, spec.prompt, here, { session: spec.sender, machine: spec.from.name }, session)
  console.error(`${stamp()} ${device.name} started ${session} in ${cwd} for ${spec.from.name}.`)
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
    const [isTrusted, checkout] = await Promise.all([trusts(capture, cwd), checkoutAt(capture, session, cwd)])
    await openTerminal(cwd, session, claudeStart(['claude', '--session-id', session], false), checkout)
    isOpened = true
    const running = whenSessions(roots.claudeHome, (sessions) => sessions.find((entry) => entry.sessionId === session), isTrusted ? RUNNING_MS : TRUST_ANSWER_MS, here.onRecordsChange)
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
  const known = (await agentsOf(capture)).agents.map(({ id }) => id).filter((id) => id.startsWith(asked))
  const [session, ...more] = known
  if (session === undefined) throw new Error(`No session's id begins with ${asked}. anyhost list shows every session.`)
  if (more.length > 0) throw new Error(`${known.length} sessions' ids begin with ${asked}. Give more of it.`)
  return session
}

export type Tell = { readonly text: string; readonly keys: readonly string[]; readonly lines: number; readonly sender: string; readonly messages?: number; readonly skip?: number; readonly sleep?: boolean }
export type Told = { readonly machine: string; readonly session: string; readonly status: AgentStatus; readonly screen: string; readonly messages?: readonly Message[]; readonly terminal?: string }

async function newestTranscript(capture: Capture, session: string): Promise<string | undefined> {
  const projects = join(capture.roots.claudeHome, 'projects')
  const paths = await Array.fromAsync(new Bun.Glob(`*/${session}.jsonl`).scan({ cwd: projects })).catch(() => [])
  const found = await Promise.all(paths.map(async (path) => ({ path: join(projects, path), at: (await stat(join(projects, path))).mtimeMs })))
  return found.sort((a, b) => b.at - a.at)[0]?.path
}

async function checkoutAt(capture: Capture, session: string, cwd: string): Promise<string> {
  const row = capture.db.query<{ cwd: string; repo: string; repo_folder: string }, [string]>('select cwd, repo, repo_folder from sessions where id = ?').get(session)
  const { repo, folder } = row?.cwd === cwd ? { repo: row.repo, folder: row.repo_folder } : await checkoutOf(cwd)
  return repo === '' ? '' : checkoutOfEntry({ cwd, repo, repoFolder: folder }, '')
}

async function messagesHere(capture: Capture, session: string, count: number, skip: number): Promise<Message[]> {
  if ((journalOf(capture.db, session)?.tool ?? 'claude') !== 'claude') throw new Error(`anyhost reads the messages of Claude Code sessions, and ${session.slice(0, 8)} is a Codex session.`)
  const newest = await newestTranscript(capture, session)
  if (newest === undefined) throw new Error(`${session.slice(0, 8)} has no transcript on ${capture.device.name}.`)
  return messagesOf(await Bun.file(newest).text(), count, skip)
}

const tagged = (told: Tell, machine: string): string => {
  if (told.sender === '') return told.text
  const sender = told.sender.slice(0, 8)
  return `<anyhost from="${sender} on ${machine}" reach="tell_agent ${sender} when done or stuck">${told.text}</anyhost>`
}

const labelledHere = async (session: string): Promise<string | undefined> => (hcPath() === undefined ? undefined : (await labelledTerminals(session))[0])

async function newestTail(capture: Capture, session: string): Promise<string | undefined> {
  const transcript = await newestTranscript(capture, session)
  return transcript === undefined ? undefined : await transcriptTailOf(transcript)
}

function claudeOf(capture: Capture, session: string, tail: string | undefined): string[] {
  if (tail === undefined) throw new Error(`${session.slice(0, 8)} has no transcript on ${capture.device.name}, so anyhost resumes nothing and starts no new conversation in its place.`)
  return claudeStart(resumeArgv(session, resumedOf(tail)), true)
}

const shellWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)

export async function resumeInPlace(capture: Capture, session: string, address: string): Promise<void> {
  await sendTo(address, `exec ${claudeOf(capture, session, await newestTail(capture, session)).map(shellWord).join(' ')}`)
}

class RunsOutside extends Error {
  constructor(capture: Capture, session: string) {
    super(`${session.slice(0, 8)} runs on ${capture.device.name} outside herdr-core, as in tmux, so anyhost cannot type into it or read it, and leaves it where the person runs it. Opening it in the Herdr app moves it into herdr-core.`)
  }
}

async function terminalHere(capture: Capture, session: string): Promise<string | undefined> {
  const address = await labelledHere(session)
  if (address !== undefined) return address
  if ((await statusOf(capture.roots.claudeHome, session)) === undefined) return undefined
  throw new RunsOutside(capture, session)
}

function terminalOf(capture: Capture, session: string, here: MoveHere, { movesCopy }: { readonly movesCopy: boolean }): Promise<string> {
  here.touched.set(session, Date.now())
  const opening = here.opening.get(session)
  const movedLater = (error: unknown): Promise<string> => {
    if (error instanceof RunsOutside) return terminalOf(capture, session, here, { movesCopy })
    throw error
  }
  if (opening !== undefined) return movesCopy ? opening.catch(movedLater) : opening
  const opened = placeInTerminal(capture, session, here, movesCopy).finally(() => here.opening.delete(session))
  here.opening.set(session, opened)
  return opened
}

type LastRun = { readonly tail: string | undefined; readonly cwd: string; readonly trust: TrustRecords | undefined }

async function lastRunHere(capture: Capture, session: string): Promise<LastRun> {
  const tail = await newestTail(capture, session)
  const known = tail === undefined ? '' : lastFolderOf(tail) || workingFolderOf(capture.db, session)
  const cwd = known !== '' && (await stat(known).then((found) => found.isDirectory(), () => false)) ? known : ''
  return { tail, cwd, trust: cwd === '' ? undefined : await trustToWrite(capture, cwd) }
}

async function placeInTerminal(capture: Capture, session: string, here: MoveHere, movesCopy: boolean): Promise<string> {
  const reading = Promise.all([statusOf(capture.roots.claudeHome, session), lastRunHere(capture, session)])
  const ran = await labelledHere(session).catch(() => undefined)
  if (ran !== undefined) {
    void reading.catch(() => undefined)
    return ran
  }
  const [status, run] = await reading
  if (status !== undefined && !movesCopy) throw new RunsOutside(capture, session)
  const placed = await placeHere(capture, session, here, status, run)
  const argv = claudeOf(capture, session, placed.tail)
  const [checkout] = await Promise.all([checkoutAt(capture, session, placed.cwd), trustHere(capture, placed.trust, 'the session ran there')])
  return await openTerminal(placed.cwd, session, argv, checkout)
}

async function placeHere(capture: Capture, session: string, here: MoveHere, status: AgentStatus | undefined, read: LastRun): Promise<LastRun> {
  const { db, roots } = capture
  const id = session.slice(0, 8)
  if ((journalOf(db, session)?.tool ?? 'claude') !== 'claude') throw new Error(`anyhost runs Claude Code sessions in herdr-core, and ${id} is a Codex session.`)
  if (status !== undefined) {
    await untilSettledIdle(capture, session, here)
    await stopCopy(roots.claudeHome, session)
  }
  const run = status === undefined ? read : await lastRunHere(capture, session)
  const holder = capture.holders.known().get(session)
  if (run.tail !== undefined && run.cwd !== '' && (holder === undefined || holder === capture.device.id)) return run
  const placed = await restore(capture, session, { take: true, if: { gone: true }, checkouts: here.checkouts }).catch((error: unknown) => {
    throw error instanceof HeldElsewhere ? new Error(`${error.holder.name} runs ${id} and is connected, so ${id} opens there and not on ${capture.device.name}.`) : error
  })
  return { tail: await newestTail(capture, session), cwd: placed.cwd, trust: undefined }
}

async function tellHere(capture: Capture, session: string, told: Tell, here: MoveHere, sender = capture.device.name): Promise<Omit<Told, 'machine' | 'session'>> {
  const { db, device, roots } = capture
  const id = session.slice(0, 8)
  const holder = journalOf(db, session)?.holder ?? ''
  if (holder !== '') throw new Error(`${id} continues on ${holder}.`)
  if ((told.messages ?? 0) > 0) return { status: (await activityOf(capture, here.activity, session)) ?? 'idle', screen: '', messages: await messagesHere(capture, session, told.messages ?? 0, told.skip ?? 0) }
  if (told.sleep === true) {
    if ((journalOf(db, session)?.tool ?? 'claude') !== 'claude') throw new Error(`anyhost puts Claude Code sessions to sleep, and ${id} is a Codex session.`)
    const running = await terminalHere(capture, session)
    if (running !== undefined) await askToSleep(running)
    return { status: (await activityOf(capture, here.activity, session)) ?? 'idle', screen: running === undefined ? '' : await readTerminal(running, 0) }
  }
  const isRead = told.text === '' && told.keys.length === 0
  if (!isRead) here.touched.set(session, Date.now())
  const address = isRead ? await terminalHere(capture, session) : await terminalOf(capture, session, here, { movesCopy: false })
  if (address === undefined) throw new Error(`${id} runs in no terminal of herdr-core on ${device.name}. Tell it something to start it again.`)
  if (told.keys.length > 0) await pressKeys(address, told.keys)
  if (told.text !== '') {
    await sendTo(address, tagged(told, sender))
    await whenSessions(roots.claudeHome, (sessions) => sessions.find((entry) => entry.sessionId === session)?.status === 'busy' || undefined, TURN_STARTS_MS, here.onRecordsChange)
  }
  return { status: (await activityOf(capture, here.activity, session)) ?? 'idle', screen: await readTerminal(address, told.lines), terminal: address }
}

export async function tell(capture: Capture, asked: string, told: Tell, here: MoveHere): Promise<Told> {
  const { relay, device } = capture
  const session = await sessionOf(capture, asked)
  const holder = (await claimsOf(relay, session)).get(session)
  if (holder === undefined || holder.id === device.id) return { machine: device.name, session, ...(await tellHere(capture, session, told, here)) }
  const answer = await ask(relay, { t: 'tell', id: crypto.randomUUID(), to: holder.id, session, ...told }, AbortSignal.timeout(TELL_MS)).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new Error(`${holder.name}, which holds ${session.slice(0, 8)}, did not answer within ${TELL_MS / 1000} s. An anyhost older than 0.4.0 there does not answer at all.`)
    throw error
  })
  if (answer.t === 'offline') throw new Error(`${holder.name}, which holds ${session.slice(0, 8)}, is offline. open_agent continues it on another machine.`)
  if ('error' in answer) throw new Error(`${holder.name}: ${answer.error}`)
  here.onStatusElsewhere(holder.id, session, answer.status)
  return { machine: holder.name, session, status: answer.status, screen: answer.screen, ...(answer.messages === undefined ? {} : { messages: answer.messages }), ...(answer.terminal === undefined ? {} : { terminal: answer.terminal }) }
}

export async function showAgent(capture: Capture, asked: string, place: Place, here: MoveHere, reachOf: (machine: string) => Promise<string | null>): Promise<{ readonly session: string; readonly machine: string; readonly terminal: string }> {
  const session = await sessionOf(capture, asked)
  const holder = (await claimsOf(capture.relay, session)).get(session)
  if (holder === undefined || holder.id === capture.device.id) {
    const terminal = await terminalOf(capture, session, here, { movesCopy: true })
    await showTerminal(session, terminal, place)
    return { session, machine: capture.device.name, terminal }
  }
  const reach = await reachOf(holder.id)
  if (reach === null) throw new Error(`${holder.name} holds ${session.slice(0, 8)}, and the Herdr app here does not reach ${holder.name}. Add it with add_machine, or move_agent brings the agent here.`)
  const told = await tell(capture, session, { text: '', keys: [], lines: 0, sender: '' }, here)
  if (told.terminal === undefined) throw new Error(`${holder.name} answered no terminal of ${session.slice(0, 8)}: it runs there in none, or its anyhost is older than this one.`)
  const terminal = `${reach}/${told.terminal}`
  await showTerminal(session, terminal, place)
  return { session, machine: holder.name, terminal }
}

export function noteWaiting(capture: Capture, here: MoveHere): () => void {
  let waiting: ReadonlySet<string> | undefined
  let isAsked = false
  let reading = Promise.resolve()
  const read = async (): Promise<void> => {
    isAsked = false
    const now = new Set((await recordedSessions(capture.roots.claudeHome)).filter((record) => here.activity.of(record) === 'waiting').map(({ sessionId }) => sessionId))
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

export const receiveTell = async (capture: Capture, asked: Extract<Delivered, { readonly t: 'tell' }>, here: MoveHere): Promise<void> =>
  replyTo(
    capture.relay,
    asked,
    await tellHere(capture, asked.session, asked, here, asked.from.name).then(
      ({ status, screen, messages, terminal }): Reply => ({ t: 'told', id: asked.id, to: asked.from.id, status, screen, ...(messages === undefined ? {} : { messages }), ...(terminal === undefined ? {} : { terminal }) }),
      (error: unknown): Reply => ({ t: 'told', id: asked.id, to: asked.from.id, error: messageOf(error) }),
    ),
  )

export const statusesHere = async (capture: Capture, activity: Activity): Promise<Shown> =>
  activity.shownOf(await recordedSessions(capture.roots.claudeHome), async (session) => {
    const transcript = await newestTranscript(capture, session)
    return transcript === undefined ? undefined : await lastTurnOf(transcript)
  })

export const activityOf = async (capture: Capture, activity: Activity, session: string): Promise<AgentStatus | undefined> => activity.of((await recordedSessions(capture.roots.claudeHome)).find((record) => record.sessionId === session))

export const receiveList = async (capture: Capture, asked: Extract<Delivered, { readonly t: 'list' }>, here: MoveHere): Promise<void> =>
  replyTo(capture.relay, asked, { t: 'listed', id: asked.id, to: asked.from.id, ...(await statusesHere(capture, here.activity)) })

export async function statusesElsewhere(capture: Capture): Promise<Map<string, Shown>> {
  const { relay, device } = capture
  const others = [...(await devicesOf(relay)).values()].filter((machine) => machine.id !== device.id && machine.connected && machine.removedAt === undefined)
  const answers = await Promise.all(
    others.map((machine) =>
      ask(relay, { t: 'list', id: crypto.randomUUID(), to: machine.id }, AbortSignal.timeout(LIST_MS)).then(
        (answer) => (answer.t === 'listed' ? [[machine.id, { statuses: { ...answer.statuses }, since: { ...answer.since }, background: [...(answer.background ?? [])] }] as const] : []),
        () => [],
      ),
    ),
  )
  return new Map(answers.flat())
}

export async function openHere(capture: Capture, asked: string, here: MoveHere): Promise<{ readonly session: string; readonly terminal: string }> {
  const session = await sessionOf(capture, asked)
  return { session, terminal: await terminalOf(capture, session, here, { movesCopy: true }) }
}

export async function deleteAgent(capture: Capture, asked: string, here: MoveHere): Promise<string> {
  const { relay, device } = capture
  const session = await sessionOf(capture, asked)
  const holder = (await claimsOf(relay, session)).get(session)
  if (holder === undefined || holder.id === device.id) return await deleteHere(capture, session, here)
  const answer = await ask(relay, { t: 'delete', id: crypto.randomUUID(), to: holder.id, session }, AbortSignal.timeout(TELL_MS)).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new Error(`${holder.name}, which holds ${session.slice(0, 8)}, did not answer within ${TELL_MS / 1000} s. An anyhost older than 0.7.3 there does not answer at all.`)
    throw error
  })
  if (answer.t === 'offline') return await deleteHere(capture, session, here)
  if ('error' in answer) throw new Error(`${holder.name}: ${answer.error}`)
  return answer.session
}

export const receiveDelete = async (capture: Capture, asked: Extract<Delivered, { readonly t: 'delete' }>, here: MoveHere): Promise<void> =>
  replyTo(
    capture.relay,
    asked,
    await deleteHere(capture, asked.session, here).then(
      (session): Reply => ({ t: 'deleted', id: asked.id, to: asked.from.id, session }),
      (error: unknown): Reply => ({ t: 'deleted', id: asked.id, to: asked.from.id, error: messageOf(error) }),
    ),
  )

async function deleteHere(capture: Capture, asked: string, here: MoveHere): Promise<string> {
  const { db, device, roots } = capture
  const session = await sessionOf(capture, asked)
  if (journalOf(db, session)?.holder !== '') {
    await restore(capture, session, { take: true, if: { gone: true }, checkouts: here.checkouts }).catch((error: unknown) => {
      throw error instanceof HeldElsewhere ? new Error(`${error.holder.name} runs ${session.slice(0, 8)} and is connected, so delete it there.`) : error
    })
  }
  const journal = journalOf(db, session)
  if (journal === undefined) throw new Error(`${session.slice(0, 8)} has no files on ${device.name}.`)
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

export async function forkAgent(capture: Capture, asked: string, message: string, here: MoveHere): Promise<{ readonly session: string; readonly machine: string }> {
  const { relay, device } = capture
  const source = await sessionOf(capture, asked)
  const holder = (await claimsOf(relay, source)).get(source)
  if (holder === undefined || holder.id === device.id) return { session: await forkHere(capture, source, message, here), machine: device.name }
  const answer = await ask(relay, { t: 'fork', id: crypto.randomUUID(), to: holder.id, session: source, message }, AbortSignal.timeout(TELL_MS)).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new Error(`${holder.name}, which holds ${source.slice(0, 8)}, did not answer within ${TELL_MS / 1000} s. An anyhost older than 0.9.0 there does not answer at all.`)
    throw error
  })
  if (answer.t === 'offline') throw new Error(`${holder.name}, which holds ${source.slice(0, 8)}, is offline, so fork it once ${holder.name} connects, or open it here first.`)
  if ('error' in answer) throw new Error(`${holder.name}: ${answer.error}`)
  return { session: answer.session, machine: holder.name }
}

export const receiveFork = async (capture: Capture, asked: Extract<Delivered, { readonly t: 'fork' }>, here: MoveHere): Promise<void> =>
  replyTo(
    capture.relay,
    asked,
    await forkHere(capture, asked.session, asked.message, here).then(
      (session): Reply => ({ t: 'forked', id: asked.id, to: asked.from.id, session }),
      (error: unknown): Reply => ({ t: 'forked', id: asked.id, to: asked.from.id, error: messageOf(error) }),
    ),
  )

async function forkHere(capture: Capture, source: string, message: string, here: MoveHere): Promise<string> {
  const { db, device, roots } = capture
  const tool = journalOf(db, source)?.tool ?? 'claude'
  if (tool !== 'claude') throw new Error(`anyhost forks Claude Code sessions, and ${source.slice(0, 8)} is ${tool === 'codex' ? 'a Codex session' : 'a mod history'}.`)
  const path = transcriptOf(roots.claudeHome, source)
  if (path === undefined) throw new Error(`${source.slice(0, 8)} has no transcript on ${device.name}.`)
  const read = await Bun.file(path).bytes()
  const whole = read.subarray(0, read.lastIndexOf(10) + 1)
  const leaf = message === '' ? lastMessageIn(whole) : message
  if (leaf === undefined) throw new Error(`${source.slice(0, 8)} holds no message to fork from yet.`)
  const row = db.query<{ title: string; first_prompt: string }, [string]>('select title, first_prompt from sessions where id = ?').get(source)
  const session = crypto.randomUUID()
  const title = `${row?.title || titleOfPrompt(row?.first_prompt ?? '') || source.slice(0, 8)} (fork)`
  const { bytes } = await forkedTranscript(whole, { version: FORK_VERSION, session, source, message: leaf, title, time: new Date().toISOString() })
  const forked = join(dirname(path), `${session}.jsonl`)
  await writeFile(forked, bytes, { flag: 'wx' })
  here.queue(session, 'claude', forked)
  await here.flush(session, new AbortController().signal, () => undefined)
  await writeIndex(capture)
  return session
}

export async function receiveReleased(capture: Capture, session: string, holder: string, here: MoveHere): Promise<void> {
  if (!isFinal(here.moves.get(session)) || pausedSessions().includes(session)) return
  const { device, roots } = capture
  await whenSessions(roots.claudeHome, (sessions) => (sessions.find((entry) => entry.sessionId === session)?.status === 'busy' ? undefined : true), Infinity, here.onRecordsChange)
  const held = capture.holders.known().get(session)
  if (held === undefined || held === device.id) return
  await stopCopy(roots.claudeHome, session).then(
    () => console.error(`${stamp()} ${holder} took ${session} over, so ${device.name} stopped its copy here.`),
    (error: unknown) => console.error(`${stamp()} ${holder} took ${session} over, and ${device.name} could not stop its copy: ${messageOf(error)}`),
  )
}
