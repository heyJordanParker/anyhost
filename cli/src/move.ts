import { mkdir, readFile, readlink, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { AgentStatus, Delivered, Device, Offline, Routed } from '../../relay/protocol.ts'
import { captureAgainFrom, chainOf, changedFiles, checkoutOf, framesOf, holdHere, journalOf, journalPrefix, sealJournal, startCode, workingFolderOf, writeIndex, type Capture, type Problems } from './capture.ts'
import { claimsOf, HeldElsewhere, takeClaim } from './claims.ts'
import { commandOf, recordedSessions, run, runOf, runSessions, statusOf, stopCopy, whenSessions, type OnRecordsChange, type RunningSession } from './claude.ts'
import { devicesOf, otherMachine } from './device.ts'
import { killTerminal, labelledTerminals, openTerminal, pressKeys, readTerminal, sendTo } from './hc.ts'
import type { Relay } from './relay.ts'
import { cloneMissing, localFolder, restore } from './resume.ts'
import type { Tool } from './transcript.ts'

const RUNNING_MS = 60_000
// how long a new session in a folder Claude Code asks the person to trust waits for their answer before its first message
const TRUST_ANSWER_MS = 86_400_000
const CONNECTED_MS = 10_000
// a tell answers within a tool call of Claude Code's, and a woken session starts its turn within 3 s
const TELL_MS = 25_000
const TURN_STARTS_MS = 10_000
const LIST_MS = 5000
// an asker repeats a tell or a list only while it waits for its answer
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
}

type Reply = Extract<Routed, { readonly t: 'moved' | 'started' | 'told' | 'listed' }>
const ANSWER = { move: 'moved', start: 'started', tell: 'told', list: 'listed' } as const
type Asked = Extract<Routed, { readonly t: keyof typeof ANSWER }>
type AnswerTo<A extends Asked> = Extract<Delivered, { readonly t: (typeof ANSWER)[A['t']] }> | Offline

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const reasonOf = (error: unknown): string => messageOf(error).replace(/\.+$/, '')
const stamp = (): string => new Date().toISOString()

async function ask<A extends Asked>(
  relay: Relay,
  message: A,
  { signal, keepsWaiting, countsGone }: { readonly signal?: AbortSignal; readonly keepsWaiting: () => Promise<boolean>; readonly countsGone: (asked: Device, now: Device) => boolean },
): Promise<AnswerTo<A>> {
  const offline: Offline = { t: 'offline', id: message.id, to: message.to }
  signal?.throwIfAborted()
  const listed = (await devicesOf(relay)).get(message.to)
  const isUp = (now: Device | undefined): now is Device => now !== undefined && now.removedAt === undefined && now.connected
  if (!isUp(listed)) return offline
  const isGone = (now: Device | undefined): boolean => !isUp(now) || countsGone(listed, now)
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
    if (!capture.codeRuns.has(session) && !capture.codeWaiting.has(session)) startCode(capture, session, tool, here.problems)
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
  for await (const { bytes } of chainOf(relay, frames.filter((frame) => frame.start >= end), end)) at += bytes.length
  if (at === end) return holdHere(db, session)
  for (const path of captureAgainFrom(capture, session, tool, at, end, here.problems)) here.queue(session, tool, path)
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
  let isAsked = false
  const fail = async (line: string): Promise<void> => {
    const holder = journalOf(db, session)?.holder ?? ''
    if (holder !== '' && !(isAsked && holder === machine)) return say('failed', `${holder} took ${id} over during the move, so it continues there.`)
    if (!isAsked) return say('failed', line)
    try {
      await takeClaim(relay, session, { take: true })
      await continueHere(capture, session, tool, here)
      say('failed', line)
    } catch (error) {
      say('failed', `${line} anyhost could not take it back here: ${messageOf(error)}`)
    }
  }
  const keepsWaiting = async (): Promise<boolean> => {
    if ((await claimsOf(relay, session)).get(session)?.id !== target.id) return false
    const line = `${machine} took ${id} and does not answer. Keep it here takes the session back.`
    if (!keeping.signal.aborted && moving.line !== line) say('moving', line)
    return true
  }
  void (async () => {
    const { signal } = keeping
    if (isBusy) {
      await whenSessions(capture.roots.claudeHome, (sessions) => (sessions.find((listed) => listed.sessionId === session)?.status ?? 'idle') === 'idle' || undefined, Infinity, here.onRecordsChange, signal)
      say('uploading', `Uploading ${id}.`)
    }
    await upload(capture, session, tool, here, signal, (isConnected) => say('uploading', isConnected ? `Uploading ${id}.` : `Uploading ${id} once the relay at ${relay.url} connects.`))
    signal.throwIfAborted()
    say('moving', `Uploaded and sealed ${id}. ${machine} restores it.`)
    const cwd = workingFolderOf(db, session)
    const trusted = cwd !== '' && (await trusts(capture, cwd))
    signal.throwIfAborted()
    const { at: claimedAt } = await takeClaim(relay, session, { take: false })
    signal.throwIfAborted()
    const started = Date.now()
    isAsked = true
    const answer = await ask(relay, { t: 'move', id: moveId(session), to: target.id, session, trusted, claimedAt, command: [...commandOf(session)] }, { signal, keepsWaiting, countsGone: () => false })
    keeping.abort()
    if (answer.t === 'offline') return await fail(`${machine} is offline, so the session keeps running here.`)
    if ('error' in answer) return await fail(`${machine} could not take the session: ${reasonOf(answer.error)}. It keeps running here.`)
    const took = ((Date.now() - started) / 1000).toFixed(1)
    say('moving', `${machine} runs ${id}, and anyhost stops its copy here.`)
    const stopped = await stopCopy(capture.roots.claudeHome, session).then(
      () => undefined,
      (error: unknown) => error,
    )
    if (stopped !== undefined) return say('failed', `${machine} runs ${id} now, and anyhost could not stop its copy here: ${reasonOf(stopped)}.`)
    say('moved', `${machine} restored ${id} in ${took} s and runs it.`)
  })().catch((error: unknown) => {
    if (error instanceof HeldElsewhere) return say('failed', `${error.holder.name} took ${id} over during the move, so it continues there.`)
    if (error !== kept) return fail(`anyhost could not move the session to ${machine}: ${reasonOf(error)}. It keeps running here.`)
    return isAsked ? fail(`${machine} did not answer, so the session keeps running here.`) : say('failed', kept.message)
  })
  return moving
}

// A move's id starts with its session, so the answer names it to a program that forgot the move.
const moveId = (session: string): string => `${session}/${crypto.randomUUID()}`

// A failed move's answer that no move of this program waits for: this program restarted during the move, as when cmod
// set the program up again, and the other machine took the session and then could not run it, so it holds the session
// and runs it nowhere. This machine takes it back and opens it, as the move's own failure does: a move to mac-studio
// stranded a session this way.
export async function receiveMoved(capture: Capture, answer: Extract<Delivered, { readonly t: 'moved' }>, here: MoveHere): Promise<void> {
  const session = answer.id.split('/')[0] ?? ''
  const journal = journalOf(capture.db, session)
  if (!('error' in answer) || here.moves.has(session) || journal === undefined) return
  if ((await claimsOf(capture.relay, session)).get(session)?.id !== answer.from.id) return
  here.moves.set(session, { session, to: capture.device.name, step: 'moving', line: '', keep: () => false })
  try {
    await takeClaim(capture.relay, session, { take: true })
    await continueHere(capture, session, journal.tool, here)
    await takeHere(capture, session, here)
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
    // the asking machine's flags, with this machine's own Claude Code
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

// Starts a new session in a terminal of herdr-core on `machine`, this one too, and types `prompt` into it once it runs.
export async function startNew(capture: Capture, machine: string, cwd: string, prompt: string, here: MoveHere): Promise<string> {
  if (machine === '' || machine === capture.device.name) return await startIn(capture, cwd, prompt, here)
  const target = await otherMachine(capture.relay, capture.device, machine, 'Run claude here.')
  const { repo, folder: inside } = await checkoutOf(cwd)
  const branch = repo === '' ? '' : (await run(['git', '-C', cwd, 'branch', '--show-current'])).trim()
  const trusted = await trusts(capture, cwd)
  const answer = await ask(
    capture.relay,
    { t: 'start', id: crypto.randomUUID(), to: target.id, repo, branch, folder: repo === '' ? cwd : inside, trusted, prompt },
    { keepsWaiting: async () => false, countsGone: (asked, now) => now.seenAt !== asked.seenAt },
  )
  if (answer.t === 'offline') throw new Error(`${machine} is offline or its program restarted before it answered. anyhost list shows whether a session started there.`)
  if ('error' in answer) throw new Error(`${machine} could not start a session: ${reasonOf(answer.error)}.`)
  return answer.session
}

export const receiveStart = (capture: Capture, asked: Extract<Delivered, { readonly t: 'start' }>, here: MoveHere): Promise<void> =>
  answerOnce(capture.relay, here.answers, asked, () => startSession(capture, asked, here))

async function startSession(capture: Capture, asked: Extract<Delivered, { readonly t: 'start' }>, here: MoveHere): Promise<Reply> {
  const { relay, roots, device } = capture
  try {
    const writer = (await devicesOf(relay)).get(asked.from.id)?.roots
    if (writer === undefined) throw new Error(`the relay knows no machine ${asked.from.name}`)
    const place = asked.repo === '' ? { repo: '', repoFolder: '', cwd: asked.folder } : { repo: asked.repo, repoFolder: asked.folder, cwd: '' }
    const cwd = await localFolder(capture, place, writer, here.checkouts)
    await cloneMissing(place, cwd, roots.home, asked.branch)
    await mkdir(cwd, { recursive: true })
    if (asked.trusted) await trustHere(capture, cwd, asked.from.name)
    const session = await startIn(capture, cwd, asked.prompt, here)
    console.error(`${stamp()} ${device.name} started ${session} in ${cwd} for ${asked.from.name}.`)
    return { t: 'started', id: asked.id, to: asked.from.id, session }
  } catch (error) {
    console.error(`${stamp()} ${device.name} could not start a session for ${asked.from.name}: ${messageOf(error)}`)
    return { t: 'started', id: asked.id, to: asked.from.id, error: messageOf(error) }
  }
}

// A new session in a terminal of herdr-core here, which this machine holds once Claude Code runs it, with `prompt` typed
// into it. A start that fails once the terminal opened stops its copy. In a folder Claude Code does not trust here, Claude
// Code first asks the person in that terminal, as it does when they run it there themselves, so the start answers once
// the terminal opened, and the session takes its first message whenever they answer.
async function startIn(capture: Capture, cwd: string, prompt: string, here: MoveHere): Promise<string> {
  const { relay, roots, device } = capture
  const session = crypto.randomUUID()
  const begin = async (running: RunningSession | undefined): Promise<void> => {
    if (running === undefined) throw new Error(`Claude Code listed the new session ${session.slice(0, 8)} running on ${device.name} no ${RUNNING_MS / 1000} s after its start, or no day after it in a folder it asked the person to trust.`)
    await takeClaim(relay, session, { take: false })
    if (prompt !== '') await tellHere(capture, session, { text: prompt, keys: [], lines: 0, sender: '' }, here)
  }
  let isOpened = false
  try {
    const isTrusted = await trusts(capture, cwd)
    await openTerminal(cwd, session, ['claude', '--session-id', session], { isResumed: false })
    isOpened = true
    // the runner writes its run, which names the terminal a message goes to, within a second of Claude Code's record
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

// The whole id of the session `asked` names, or begins.
async function sessionOf(capture: Capture, asked: string): Promise<string> {
  const local = capture.db.query<{ session: string }, [string]>('select session from journals where session like ?').all(`${asked}%`).map(({ session }) => session)
  const known = [...new Set([...(await claimsOf(capture.relay, asked)).keys(), ...local])]
  const [session, ...more] = known
  if (session === undefined) throw new Error(`No session's id begins with ${asked}. anyhost list shows every session.`)
  if (more.length > 0) throw new Error(`${known.length} sessions' ids begin with ${asked}. Give more of it.`)
  return session
}

// What a tell does: types `text` and presses Enter, presses `keys`, or only reads the screen with `lines` lines of
// history when both are empty. `sender` is the session of the agent that sends it, which the text names, as herdr-core
// tags a message one agent sends another.
export type Tell = { readonly text: string; readonly keys: readonly string[]; readonly lines: number; readonly sender: string }
export type Told = { readonly machine: string; readonly session: string; readonly status: AgentStatus; readonly screen: string }

const tagged = (told: Tell, machine: string): string => {
  if (told.sender === '') return told.text
  const sender = told.sender.slice(0, 8)
  return `<anyhost from="${sender} on ${machine}" reach="tell_agent ${sender} when done or stuck">${told.text}</anyhost>`
}

// The terminal of herdr-core the session's runner runs in here. One the session runs in outside herdr-core, as under
// `anyhost resume` in another terminal, holds Claude Code's input itself, so nothing types into it.
async function terminalHere(capture: Capture, session: string): Promise<string | undefined> {
  const run = runOf(session)
  if (run?.terminal !== undefined) return run.terminal
  if ((await statusOf(capture.roots.claudeHome, session)) === undefined) return undefined
  throw new Error(`${session.slice(0, 8)} runs on ${capture.device.name} outside herdr-core, so anyhost cannot type into it or read it.`)
}

// Tells the session here, opening a terminal that resumes it when its runner runs in none, which wakes it, and waits
// for the turn a text starts. A kept terminal of herdr-core whose runner it lost, as after a reboot, holds a shell with
// the session's label, which goes first.
async function tellHere(capture: Capture, session: string, told: Tell, here: MoveHere, sender = capture.device.name): Promise<{ readonly status: AgentStatus; readonly screen: string }> {
  const { db, device, roots } = capture
  const id = session.slice(0, 8)
  const { holder = '', tool = 'claude' } = journalOf(db, session) ?? {}
  if (holder !== '') throw new Error(`${id} continues on ${holder}.`)
  let address = await terminalHere(capture, session)
  if (address === undefined) {
    if (told.text === '') throw new Error(`${id} runs in no terminal of herdr-core on ${device.name}. Tell it something to start it again.`)
    if (tool !== 'claude') throw new Error(`anyhost runs Claude Code sessions, and ${id} is a Codex session.`)
    const cwd = workingFolderOf(db, session)
    if (cwd === '') throw new Error(`${device.name} knows no working folder of ${id}.`)
    for (const stale of await labelledTerminals(session)) await killTerminal(stale)
    await openTerminal(cwd, session, commandOf(session), { isResumed: true })
    for (const started = Date.now(); (address = runOf(session)?.terminal) === undefined; await sleep(100)) {
      if (Date.now() - started > RUNNING_MS) throw new Error(`The runner of ${id} named no terminal of herdr-core on ${device.name} ${RUNNING_MS / 1000} s after it opened one.`)
    }
  }
  if (told.keys.length > 0) await pressKeys(address, told.keys)
  if (told.text !== '') {
    await sendTo(address, tagged(told, sender))
    await whenSessions(roots.claudeHome, (sessions) => sessions.find((entry) => entry.sessionId === session)?.status === 'busy' || undefined, TURN_STARTS_MS, here.onRecordsChange)
  }
  return { status: (await statusOf(roots.claudeHome, session)) ?? 'idle', screen: await readTerminal(address, told.lines) }
}

// Tells the session wherever it runs: here, or through the relay on the machine that holds it.
export async function tell(capture: Capture, asked: string, told: Tell, here: MoveHere): Promise<Told> {
  const { relay, device } = capture
  const session = await sessionOf(capture, asked)
  const holder = (await claimsOf(relay, session)).get(session)
  if (holder === undefined || holder.id === device.id) return { machine: device.name, session, ...(await tellHere(capture, session, told, here)) }
  const answer = await ask(relay, { t: 'tell', id: crypto.randomUUID(), to: holder.id, session, ...told }, { signal: AbortSignal.timeout(TELL_MS), keepsWaiting: async () => false, countsGone: () => false }).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new Error(`${holder.name}, which holds ${session.slice(0, 8)}, did not answer within ${TELL_MS / 1000} s. An anyhost older than 0.4.0 there does not answer at all.`)
    throw error
  })
  if (answer.t === 'offline') throw new Error(`${holder.name}, which holds ${session.slice(0, 8)}, is offline. take_agent continues it on another machine.`)
  if ('error' in answer) throw new Error(`${holder.name}: ${answer.error}`)
  return { machine: holder.name, session, status: answer.status, screen: answer.screen }
}

export const receiveTell = (capture: Capture, asked: Extract<Delivered, { readonly t: 'tell' }>, here: MoveHere): Promise<void> =>
  answerOnce(
    capture.relay,
    here.answers,
    asked,
    () =>
      tellHere(capture, asked.session, asked, here, asked.from.name).then(
        ({ status, screen }): Reply => ({ t: 'told', id: asked.id, to: asked.from.id, status, screen }),
        (error: unknown): Reply => ({ t: 'told', id: asked.id, to: asked.from.id, error: messageOf(error) }),
      ),
    FORGET_MS,
  )

// What every session that runs here does now.
async function statusesHere(capture: Capture): Promise<Record<string, AgentStatus>> {
  const sessions = new Set([...(await recordedSessions(capture.roots.claudeHome)).map(({ sessionId }) => sessionId), ...runSessions()])
  const statuses: Record<string, AgentStatus> = {}
  for (const session of sessions) {
    const status = await statusOf(capture.roots.claudeHome, session)
    if (status !== undefined) statuses[session] = status
  }
  return statuses
}

export const receiveList = (capture: Capture, asked: Extract<Delivered, { readonly t: 'list' }>, here: MoveHere): Promise<void> =>
  answerOnce(capture.relay, here.answers, asked, async () => ({ t: 'listed', id: asked.id, to: asked.from.id, statuses: await statusesHere(capture) }), FORGET_MS)

// What every session of every connected machine does now: this machine's own, and each other's as it answers within
// LIST_MS. A machine that does not answer in time adds nothing.
export async function statusesOf(capture: Capture): Promise<Record<string, AgentStatus>> {
  const { relay, device } = capture
  const others = [...(await devicesOf(relay)).values()].filter((machine) => machine.id !== device.id && machine.connected && machine.removedAt === undefined)
  const answers = await Promise.all(
    others.map((machine) =>
      ask(relay, { t: 'list', id: crypto.randomUUID(), to: machine.id }, { signal: AbortSignal.timeout(LIST_MS), keepsWaiting: async () => false, countsGone: () => false }).then(
        (answer) => (answer.t === 'listed' ? answer.statuses : {}),
        () => ({}),
      ),
    ),
  )
  return Object.assign({}, ...answers, await statusesHere(capture)) as Record<string, AgentStatus>
}

// Continues a session here, in a terminal of herdr-core, from R2 when another machine holds it, which then stops its
// copy, so an agent on a machine that sleeps or died goes on here.
export async function takeHere(capture: Capture, asked: string, here: MoveHere): Promise<string> {
  const { relay, device, roots } = capture
  const session = await sessionOf(capture, asked)
  const id = session.slice(0, 8)
  if ((await statusOf(roots.claudeHome, session)) !== undefined) throw new Error(`${id} runs on ${device.name} already.`)
  const held = (await claimsOf(relay, session)).get(session)?.id === device.id
  const cwd = held ? workingFolderOf(capture.db, session) : (await restore(capture, session, { take: true, checkouts: here.checkouts })).cwd
  if (cwd === '') throw new Error(`${device.name} knows no working folder of ${id}.`)
  await openTerminal(cwd, session, ['claude'], { isResumed: true })
  const running = await whenSessions(roots.claudeHome, (sessions) => sessions.find((entry) => entry.sessionId === session), RUNNING_MS, here.onRecordsChange)
  if (running === undefined) throw new Error(`Claude Code listed ${id} running on ${device.name} no ${RUNNING_MS / 1000} s after its start.`)
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
