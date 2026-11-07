// A session moves to another machine, which runs it in Claude Code's background from then on, and a new session
// starts on another machine. The program of the machine that runs a session holds the session's upload queue, so `move`
// runs there: it waits for the session's turn to end, drains, seals and sends `move`, and the machine it goes to takes
// the claim, restores the session and starts it in `receiveMove`. A move that fails leaves the session running where it
// was, with its claim, its journal going on past whatever the other machine wrote, and no job of it on that machine,
// unless another machine took the session meanwhile. `startNew` and `receiveStart` start a new session on another
// machine in the same repository. Only the program sends `move` and `start` and waits for their answers.
import { mkdir, readFile, readlink, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Delivered, Device, Offline, Released, Routed } from '../../relay/protocol.ts'
import { attachTerminal, backgroundJobOf, isAlive, keptSessions, recordedSessions, run, startInBackground, stopInBackground, whenSessions, type OnRecordsChange, type RunningSession } from './background.ts'
import { captureAgainFrom, chainOf, changedFiles, checkoutOf, framesOf, holdHere, journalOf, journalPrefix, sealJournal, startCode, workingFolderOf, writeIndex, type Capture, type Problems } from './capture.ts'
import { HeldElsewhere, takeClaim } from './claims.ts'
import { devicesOf, otherMachine } from './device.ts'
import { waitAfter, type Relay } from './relay.ts'
import { cloneMissing, localFolder, restore } from './resume.ts'
import type { Tool } from './transcript.ts'

// The longest wait measured for a session's record after its start was 18.4 s: a kept job `claude attach` reopened on
// anyhost-a with no daemon running, while the Mac that runs the machines had a load average of 45. It took 8.6 s on
// anyhost-b, and a new `claude --bg` session's record came 12 s after `claude --bg` returned. So a session with no
// record a minute after its start failed to start.
const RUNNING_MS = 60_000
// Claude Code shuts down on SIGTERM once it wrote what it holds: on anyhost-b in 2.4 s once it had settled, and in
// 9.5 s while it still started.
const EXIT_MS = 60_000
// How often a move or a start asks the relay whether the machine it waits for still runs the program it sent to.
const CONNECTED_MS = 10_000
// Claude Code locks its global config as proper-lockfile does: it makes the folder `<config>.lock`, which counts as
// left behind 10 s after it last changed, and waits these times between tries, in 2.1.319.
const LOCK_STALE_MS = 10_000
const LOCK_WAITS_MS = [200, 400, 800, 1600, 3200, 4000]

type MoveStep = 'waiting' | 'uploading' | 'moving' | 'moved' | 'failed'
// A move this program runs, as the mod and `anyhost move` show it: its step and the line that says it. `keep` ends the
// move and keeps the session here, taking it back from a machine that answers nothing while the move waits for it, and
// answers whether it did, as it does only until the other machine answered.
export type Moving = { readonly session: string; readonly to: string; step: MoveStep; line: string; readonly keep: () => boolean }
// What a move needs of the program that runs it.
export type MoveHere = {
  readonly moves: Map<string, Moving>
  readonly problems: Problems
  readonly environment: Promise<Record<string, string>>
  // a path of the session for its next drain, and the drain of what the session holds now, as the upload queue runs them
  readonly queue: (session: string, tool: Tool, path: string) => void
  readonly flush: (session: string, signal: AbortSignal) => Promise<void>
  // ends every viewer of a session this program shows, telling each the machine it runs on now
  readonly movedAway: (session: string, to: string) => void
  readonly onRecordsChange: OnRecordsChange
}
// What a machine that receives a session or starts one needs of its program.
type ReceiveHere = { readonly environment: Promise<Record<string, string>>; readonly checkouts: string; readonly onRecordsChange: OnRecordsChange }

type MovedAnswer = Extract<Routed, { readonly t: 'moved' }>
type StartedAnswer = Extract<Routed, { readonly t: 'started' }>
type Answer = Extract<Delivered, { readonly t: 'moved' | 'started' }> | Offline
// The answer each message a machine asks with waits for: `moved` to a `move`, and `started` to a `start`.
const ANSWER = { move: 'moved', start: 'started' } as const
type Asked = Extract<Routed, { readonly t: keyof typeof ANSWER }>
// the other machine's answer to the message `A`, or the Pool's `offline`
type AnswerTo<A extends Asked> = Extract<Delivered, { readonly t: (typeof ANSWER)[A['t']] }> | Offline

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
// a reason inside a sentence of its own, without the period it may end with
const reasonOf = (error: unknown): string => messageOf(error).replace(/\.+$/, '')
const stamp = (): string => new Date().toISOString()

// What waits for the answer to each message a relay sent, by the message's id: the other machine's `moved` to a `move`
// and `started` to a `start`, or the Pool's `offline` for a machine with no socket open. Each relay hears them with one
// listener of each kind, and each answer goes to what waits for it once, until the function `hear` answers is called.
const waiting = new WeakMap<Relay, Map<string, (answer: Answer) => void>>()
function hear(relay: Relay, id: string, heard: (answer: Answer) => void): () => void {
  const known = waiting.get(relay) ?? new Map<string, (answer: Answer) => void>()
  if (!waiting.has(relay)) {
    const answered = (answer: Answer): void => {
      if (answer.id === undefined) return
      known.get(answer.id)?.(answer)
      known.delete(answer.id)
    }
    relay.on('moved', answered)
    relay.on('started', answered)
    relay.on('offline', answered)
    waiting.set(relay, known)
  }
  known.set(id, heard)
  return () => void known.delete(id)
}

// The `move` and `start` each relay's asks wait on answers to, by id, which go again at each welcome of that relay's
// socket, until the function `askAgain` answers is called. The Pool counts a socket alive until LIVE_MS after its last
// ping, so an answer it sent to a socket that died just before counts as delivered though the asker never heard it, and
// only the same message asked again brings it: the other machine answers a repeated id again (`answerOnce`).
const asking = new WeakMap<Relay, Map<string, Asked>>()
function askAgain(relay: Relay, message: Asked): () => void {
  const known = asking.get(relay) ?? new Map<string, Asked>()
  if (!asking.has(relay)) {
    relay.on('welcome', () => {
      for (const each of known.values()) relay.send(each)
    })
    asking.set(relay, known)
  }
  known.set(message.id, message)
  return () => void known.delete(message.id)
}

// Sends a `move` or `start` to the machine it names, and answers that machine's answer to it, or `offline` once the
// Pool answers that, or once the relay's `devices`, read as the message goes and every CONNECTED_MS after, lists the
// machine not connected, removed, or seen since the message went. The Pool writes a machine's `seenAt` at each connect
// and close of its sockets, so a program that restarted between two reads, whose wait for the message ended with it,
// reads as gone, as does a command of that machine that opened or closed a socket of its own meanwhile. The message goes
// again at each welcome of this machine's socket while it waits (`askAgain`). A signal that aborts first, as Keep it
// here, rejects with its reason, and so does a read of `devices` that fails.
async function ask<A extends Asked>(relay: Relay, message: A, signal?: AbortSignal): Promise<AnswerTo<A>> {
  const offline: Offline = { t: 'offline', id: message.id, to: message.to }
  signal?.throwIfAborted()
  const listed = (await devicesOf(relay)).get(message.to)
  // the machine as the relay lists it now, no longer the one the message went to
  const isGone = (now: Device | undefined): boolean => now === undefined || now.removedAt !== undefined || !now.connected || now.seenAt !== listed?.seenAt
  if (isGone(listed)) return offline
  signal?.throwIfAborted()
  const answered = new AbortController()
  const until = signal === undefined ? answered.signal : AbortSignal.any([signal, answered.signal])
  const forgetAsk = askAgain(relay, message)
  try {
    return await new Promise<AnswerTo<A>>((resolve, reject) => {
      // an answer to this message's id is of the kind it waits for, unless another machine answered it wrongly
      const forget = hear(relay, message.id, (answer) => (answer.t === 'offline' || answer.t === ANSWER[message.t] ? resolve(answer as AnswerTo<A>) : undefined))
      until.addEventListener(
        'abort',
        () => {
          forget()
          reject(until.reason)
        },
        { once: true },
      )
      if (!relay.send(message)) return reject(new Error(`This machine is not connected to the relay at ${relay.url}, so anyhost sent nothing.`))
      void (async () => {
        while (await sleep(CONNECTED_MS, true, { signal: until }).catch(() => false)) {
          if (isGone((await devicesOf(relay)).get(message.to))) return resolve(offline)
        }
      })().catch(reject)
    })
  } finally {
    forgetAsk()
    answered.abort()
  }
}

// Sends this machine's answer to another machine's `move` or `start` until the Pool delivers it, as that machine waits
// for it: an answer that finds this machine's socket down goes at the next welcome, and one the Pool answers `offline`,
// as while the asking machine's socket is down, goes again after `waitAfter` its tries, until the relay lists that
// machine removed. The Pool answers `offline` before it answers a request this machine sent after the message, so a
// `devices` answered on the same socket with no `offline` heard says the Pool delivered it. A socket that dropped
// meanwhile may have lost the `offline`, so the answer goes again, and the asking machine takes it once.
async function deliver(relay: Relay, message: MovedAnswer | StartedAnswer, asker: string): Promise<void> {
  let wasOffline = false
  for (let tries = 1; ; tries += 1) {
    const sentOn = relay.state
    let isOffline = false
    const forget = hear(relay, message.id, () => void (isOffline = true))
    const isSent = relay.send(message)
    const devices = await devicesOf(relay).catch(() => undefined)
    forget()
    const to = devices?.get(message.to)
    if (devices !== undefined && (to === undefined || to.removedAt !== undefined)) return console.error(`${stamp()} The relay lists ${asker} removed, so anyhost sends it no answer to its ${message.t === 'moved' ? 'move' : 'start'}.`)
    if (isSent && devices !== undefined && !isOffline && relay.state === sentOn) return
    if (isOffline && !wasOffline) console.error(`${stamp()} The relay could not reach ${asker}, so anyhost sends its answer again until it does.`)
    wasOffline ||= isOffline
    // an answer this machine could not send waited in `devicesOf` for the next welcome
    if (isSent || devices === undefined) await Bun.sleep(waitAfter(tries))
  }
}

// Waits for the process to end, as Claude Code does once it wrote what it holds after a SIGTERM.
async function exited(pid: number): Promise<void> {
  const started = Date.now()
  while (isAlive(pid)) {
    if (Date.now() - started > EXIT_MS) throw new Error(`Claude Code, pid ${pid}, still runs ${EXIT_MS / 1000} s after its SIGTERM.`)
    await Bun.sleep(50)
  }
}

// The herdr pane that runs the session, as `herdr agent list` names its Claude Code session id, or none when no herdr
// server runs here. The service's own PATH lacks the person's folders, so herdr is found on the PATH of their shell.
// Each reason `herdr agent list` failed for is logged once, as no herdr server running fails it at every move.
const herdrFailures = new Set<string>()
async function paneOf(session: string, env: Record<string, string>): Promise<{ readonly herdr: string; readonly pane: string } | undefined> {
  const herdr = Bun.which('herdr', { PATH: env['PATH'] ?? '' })
  if (herdr === null) return undefined
  try {
    const { result } = JSON.parse(await run([herdr, 'agent', 'list'], { env })) as { result?: { agents?: readonly { pane_id: string; agent_session?: { value: string } }[] } }
    const pane = result?.agents?.find((agent) => agent.agent_session?.value === session)?.pane_id
    return pane === undefined ? undefined : { herdr, pane }
  } catch (error) {
    const reason = messageOf(error)
    if (!herdrFailures.has(reason)) console.error(`${stamp()} anyhost finds no herdr pane of a session it moves, as ${herdr} agent list failed: ${reason}`)
    herdrFailures.add(reason)
    return undefined
  }
}

// Claude Code keeps each folder's trust in `projects[<folder>].hasTrustDialogAccepted` of its global config, `.claude.json`
// in CLAUDE_CONFIG_DIR, else in the home folder.
type Config = { readonly projects?: Record<string, { readonly hasTrustDialogAccepted?: boolean } | undefined> }
const configOf = (capture: Capture): string => join(process.env['CLAUDE_CONFIG_DIR'] ? capture.roots.claudeHome : capture.roots.home, '.claude.json')
// A file that is missing answers `missing`, and any other failure, as EACCES, rejects with its reason.
const unlessMissing =
  <T>(missing: T) =>
  (error: NodeJS.ErrnoException): T => {
    if (error.code !== 'ENOENT') throw error
    return missing
  }
// Claude Code's global config at `file`, as Claude Code reads it: a missing file holds no project.
const configAt = async (file: string): Promise<Config> => JSON.parse(await readFile(file, 'utf8').catch(unlessMissing('{}'))) as Config
// The file the config at `path` is, through every symlink, a dangling one's target included, as a write through the
// link makes that file.
async function fileOf(path: string): Promise<string> {
  const found = await realpath(path).catch(unlessMissing(undefined))
  if (found !== undefined) return found
  const target = await readlink(path).catch(unlessMissing(undefined))
  return target === undefined ? path : await fileOf(resolve(dirname(path), target))
}
const isTrusted = (config: Config, records: readonly string[]): boolean => records.some((record) => config.projects?.[record]?.hasTrustDialogAccepted === true)

// The records Claude Code 2.1.319 reads to trust `cwd`, the one its trust dialog writes first. Inside a git checkout
// that is the root of the repository's main checkout, then each folder from `cwd` up to the root of its own checkout, a
// worktree's included, and never a folder above it. Outside git it is `cwd`, then each folder above it up to `/`.
async function trustRecordsOf(cwd: string): Promise<readonly [string, ...string[]]> {
  const folder = await realpath(cwd)
  // outside git, no root of a checkout and no repository
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

// Whether Claude Code here trusts `cwd`, as it decides it before it starts a session there. A missing config trusts
// nothing, and so does a missing folder, while a config or folder that cannot be read, as at EACCES, rejects with the
// reason, as `trustHere` does, so no move or start goes untrusted for a failure that says nothing of the trust.
async function trusts(capture: Capture, cwd: string): Promise<boolean> {
  return isTrusted(await configAt(configOf(capture)), await trustRecordsOf(cwd).catch(unlessMissing([])))
}

// Runs `work` holding Claude Code's lock of `file`, as Claude Code itself takes it: a lock left behind goes, and one
// another process holds is tried again after each of Claude Code's waits. A lock left behind that cannot go, as a file
// at its path, fails with the reason.
async function lockedConfig<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`
  for (let tries = 0; ; ) {
    const error = await mkdir(lock).then(() => undefined, (failure: NodeJS.ErrnoException) => failure)
    if (error === undefined) break
    if (error.code !== 'EEXIST') throw error
    const changedAt = await stat(lock).then((found) => found.mtimeMs, () => 0)
    if (Date.now() - changedAt > LOCK_STALE_MS) {
      // one another process removed meanwhile is gone too
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

// Trusts `cwd` here as Claude Code's trust dialog does, unless Claude Code here trusts it already: under Claude Code's
// own lock of its config, it reads the file, sets the one key, and renames a new file over it, so a Claude Code that
// saves its config next reads the key under the same lock and keeps it. A config that is a symlink, as one kept in
// dotfiles is, stays one: the new file replaces the file it points to, or makes it when it is missing. Claude Code
// locks at the path it names the config by, `<config>.lock` beside the link, which proper-lockfile takes as given, so
// the lock stays there. A config that is there but cannot be read fails the trust and stays as it is.
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

// Every file of the session up, its working folder's code read once more and up, and its journal sealed, so the
// machine it goes to restores all of it. What the session writes meanwhile goes up in the queue's own drains, past the
// end the seal covers. A journal whose chain in R2 ends short of the end this machine counted, as after R2 lost a
// frame, goes on from there with every file whole, as `sealQuiet` does, and is sealed again. A journal still short
// after that fails the move, as the other machine would restore the session without the lost span. A session whose
// journal stopped meanwhile, as another machine took it, uploads nothing more, and fails the move. A signal that
// aborts, as Keep it here, ends the upload with its reason.
async function upload(capture: Capture, session: string, tool: Tool, here: MoveHere, signal: AbortSignal): Promise<void> {
  const aborted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  aborted.catch(() => undefined)
  // the paths and what the session holds now up, which leaves a stopped journal's paths and code undone
  const drained = async (paths: Iterable<string> = []): Promise<void> => {
    for (const path of paths) here.queue(session, tool, path)
    await here.flush(session, signal)
    const stopped = journalOf(capture.db, session)?.stopped ?? ''
    if (stopped !== '') throw new Error(`${capture.device.name} uploads no more of ${session.slice(0, 8)}: ${stopped}`)
  }
  // The paths up, then one read of the working folder's code that starts once they are up, and its code. A read that
  // runs already may have started before the turn's last change, so its code goes up first, and the move starts a read
  // of its own unless an upload started one since. The read the move waits on fails the move with its reason, whichever
  // started it. A read that ends puts its code on the queue (`onCode`).
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
      // the session runs on here, and its journal goes on from where R2's chain ends
      for (const path of lost) here.queue(session, tool, path)
      throw new Error(`the journal of ${session} in R2 still ends short of what ${capture.device.name} counted after it uploaded the session's files whole again`)
    }
  }
  // the machine it goes to finds the session and its folder in this machine's index
  await writeIndex(capture)
}

// Captures the session here again once a move that failed took its claim back. The other machine may have run the
// session meanwhile and written frames past the end this machine counted, as `claude --bg --resume` re-appends the
// session's metadata to its transcript, where this machine's next frame would meet them as a fork. So the journal goes
// on from where R2's chain ends, with every file whole (`captureAgainFrom`), and its next state is this machine's. A
// chain that ends at this machine's end goes on from there (`holdHere`).
async function continueHere(capture: Capture, session: string, tool: Tool, here: MoveHere): Promise<void> {
  const { relay, db } = capture
  const end = journalOf(db, session)?.end ?? 0
  const { frames } = framesOf(session, await relay.list(journalPrefix(session)))
  let at = end
  for await (const { bytes } of chainOf(relay, frames.filter((frame) => frame.start >= end), end)) at += bytes.length
  if (at === end) return holdHere(db, session)
  for (const path of captureAgainFrom(capture, session, tool, at, end, here.problems)) here.queue(session, tool, path)
}

// Starts moving the session, named by its id or the start of it, to the machine named `machine`, once it checked
// both, and answers the move, which goes on while its step and line change.
export async function move(capture: Capture, asked: string, machine: string, here: MoveHere): Promise<Moving> {
  const { relay, db, device } = capture
  if (relay.state.is !== 'connected') throw new Error('message' in relay.state ? relay.state.message : `anyhost connects to the relay at ${relay.url}.`)
  const held = db.query<{ session: string }, [string]>('select session from journals where session like ?').all(`${asked}%`).map(({ session }) => session)
  const isWhole = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(asked)
  // a session that has written nothing yet is in no journal, and the mod names it whole
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
  const recorded = async (): Promise<RunningSession | undefined> => (await recordedSessions(capture.roots.claudeHome)).find((entry) => entry.sessionId === session)
  // Claude Code's own record of the session: busy during a turn, which the move waits out
  const isBusy = ((await recorded())?.status ?? 'idle') !== 'idle'
  // Keep it here aborts every wait and upload of the move, until the other machine answered or the move ended, with
  // `kept` as the reason.
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
  // A move that fails keeps the session here. Once it asked the other machine, which may have taken the claim and run
  // the session, it takes the claim back and captures the session here again past whatever that machine wrote, so its
  // prompts go through. A session another machine took meanwhile stays with that machine.
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
  // The copy here stops once the session runs there, as Claude Code's record of the session names it now. One Claude
  // Code runs in its own background stops as a background session, and its viewers follow it. One in a herdr pane
  // ends, and the pane shows the session where it runs now. Any other stays open and refuses each prompt, as only the
  // person can type into its terminal.
  const stopHere = async (env: Record<string, string>): Promise<void> => {
    const copy = await recorded()
    if (copy?.kind === 'background' && copy.id !== undefined) {
      here.movedAway(session, machine)
      return await stopInBackground(copy.id, env)
    }
    const pane = copy === undefined ? undefined : await paneOf(session, env)
    // read again as the signal goes, so it reaches only a process that runs the session
    const pid = pane === undefined ? undefined : (await recorded())?.pid
    if (pane === undefined || pid === undefined) return
    process.kill(pid, 'SIGTERM')
    await exited(pid)
    await run([pane.herdr, 'pane', 'run', pane.pane, `anyhost attach ${id}`], { env })
  }
  void (async () => {
    const { signal } = keeping
    const env = await here.environment
    if (isBusy) {
      await whenSessions(capture.roots.claudeHome, (sessions) => (sessions.find((listed) => listed.sessionId === session)?.status ?? 'idle') === 'idle' || undefined, Infinity, here.onRecordsChange, signal)
      say('uploading', `Uploading ${id}.`)
    }
    await upload(capture, session, tool, here, signal)
    signal.throwIfAborted()
    say('moving', `Uploaded and sealed ${id}. ${machine} restores it.`)
    const cwd = workingFolderOf(db, session)
    const trusted = cwd !== '' && (await trusts(capture, cwd))
    signal.throwIfAborted()
    const started = Date.now()
    isAsked = true
    const answer = await ask(relay, { t: 'move', id: crypto.randomUUID(), to: target.id, session, trusted }, signal)
    keeping.abort()
    if (answer.t === 'offline') return await fail(`${machine} is offline, so the session keeps running here.`)
    if ('error' in answer) return await fail(`${machine} could not take the session: ${reasonOf(answer.error)}. It keeps running here.`)
    const took = ((Date.now() - started) / 1000).toFixed(1)
    say('moving', `${machine} runs ${id}, and anyhost stops its copy here.`)
    const stopped = await stopHere(env).then(
      () => undefined,
      (error: unknown) => error,
    )
    if (stopped !== undefined) return say('failed', `${machine} runs ${id} now, and anyhost could not stop its copy here: ${reasonOf(stopped)}.`)
    say('moved', `${machine} restored ${id} in ${took} s and runs it.`)
  })().catch((error: unknown) => {
    if (error !== kept) return fail(`anyhost could not move the session to ${machine}: ${reasonOf(error)}. It keeps running here.`)
    return isAsked ? fail(`${machine} did not answer, so the session keeps running here.`) : say('failed', kept.message)
  })
  return moving
}

// The answer this program gave each `move` and `start` it received, by the message's id, for as long as it runs, or
// undefined while it works on one. An asker sends its message again after each welcome of its own socket (`askAgain`),
// as it may have missed the answer: a repeated id gets the same answer again, and one still in progress gets nothing
// more, as its first run answers it once it ends.
const answers = new WeakMap<Relay, Map<string, MovedAnswer | StartedAnswer | undefined>>()
async function answerOnce(relay: Relay, asked: { readonly id: string; readonly from: { readonly name: string } }, work: () => Promise<MovedAnswer | StartedAnswer>): Promise<void> {
  const known = answers.get(relay) ?? new Map<string, MovedAnswer | StartedAnswer | undefined>()
  answers.set(relay, known)
  if (known.has(asked.id)) {
    const before = known.get(asked.id)
    if (before === undefined) return
    console.error(`${stamp()} ${asked.from.name} asked again for its answer, as it may have missed it, so anyhost sends it again.`)
    return await deliver(relay, before, asked.from.name)
  }
  known.set(asked.id, undefined)
  const reply = await work()
  known.set(asked.id, reply)
  await deliver(relay, reply, asked.from.name)
}

// The machine side of `move`, once for each move's id (`answerOnce`).
export const receiveMove = (capture: Capture, asked: Extract<Delivered, { readonly t: 'move' }>, here: ReceiveHere): Promise<void> =>
  answerOnce(capture.relay, asked, () => takeSession(capture, asked, here))

// Takes the claim and restores the session as `anyhost resume --take` does, runs it in Claude Code's background, and
// answers whether it runs here. A move that fails here once it started the session's job, as when the asking machine
// took the session back meanwhile, stops the job at once. A take of the session after the answer stops it in
// `receiveReleased`.
async function takeSession(capture: Capture, asked: Extract<Delivered, { readonly t: 'move' }>, here: ReceiveHere): Promise<MovedAnswer> {
  const { device, roots } = capture
  let reply: MovedAnswer
  // the stop of the job this move started here
  let stopJob: (() => Promise<void>) | undefined
  try {
    console.error(`${stamp()} ${asked.from.name} moves ${asked.session} here.`)
    const env = await here.environment
    // A copy that runs here still holds the conversation as it was, so it stops before the restore, and Claude Code
    // keeps its job. Only the person ends one in a terminal of its own.
    const copy = (await recordedSessions(roots.claudeHome)).find((entry) => entry.sessionId === asked.session)
    if (copy?.kind === 'interactive') throw new Error(`${device.name} runs the session in a terminal of its own, so close that terminal or exit that Claude Code there, then move the session again`)
    if (copy?.id !== undefined) await stopInBackground(copy.id, env)
    const { session, cwd } = await restore(capture, asked.session, { take: true, checkouts: here.checkouts })
    if (asked.trusted) await trustHere(capture, cwd, asked.from.name)
    // A job Claude Code kept, the copy's or one stopped before, starts again with `claude attach`, while a new job runs
    // from its start. The session runs once its record names its process.
    const job = copy?.id === undefined ? await backgroundJobOf(roots.claudeHome, session.id, cwd, env, device.name) : { id: copy.id, cwd, isKept: true }
    stopJob = () => stopInBackground(job.id, env)
    const terminal = job.isKept ? attachTerminal(job.id, job.cwd, env, { cols: 80, rows: 24 }, () => undefined) : undefined
    const running = await whenSessions(roots.claudeHome, (sessions) => sessions.find((entry) => entry.sessionId === session.id), RUNNING_MS, here.onRecordsChange).finally(() => terminal?.close())
    if (running === undefined) {
      const kept = (await keptSessions().catch(() => [])).find((entry) => entry.sessionId === session.id)
      throw new Error(`Claude Code listed the session ${session.id.slice(0, 8)} running on ${device.name} no ${RUNNING_MS / 1000} s after its start, and ${kept === undefined ? 'lists no job of it' : `lists its job ${kept.id ?? ''} as ${kept.state ?? 'neither running nor stopped'}`}`)
    }
    await takeClaim(capture.relay, session.id, { take: false }).catch((error: unknown) => {
      throw error instanceof HeldElsewhere ? new Error(`${error.holder.name} took the session back`) : error
    })
    console.error(`${stamp()} ${device.name} runs ${session.id} in Claude Code's background in ${cwd}.`)
    reply = { t: 'moved', id: asked.id, to: asked.from.id }
  } catch (error) {
    console.error(`${stamp()} ${device.name} could not take ${asked.session} from ${asked.from.name}: ${messageOf(error)}`)
    await stopJob?.().catch((failure: unknown) => console.error(`${stamp()} ${device.name} could not stop the background job it started for ${asked.session}: ${messageOf(failure)}`))
    reply = { t: 'moved', id: asked.id, to: asked.from.id, error: messageOf(error) }
  }
  return reply
}

// Starts a new session on the machine named `machine`, in its checkout of the repository the folder `cwd` is in, else
// in the folder there that `cwd` is here, and answers the session. `cwd` is absolute, as the program that runs this
// works in a folder of its own, not in the one of the command that asked for it.
export async function startNew(capture: Capture, machine: string, cwd: string): Promise<string> {
  const target = await otherMachine(capture.relay, capture.device, machine, 'Run claude here.')
  const { repo, folder: inside } = await checkoutOf(cwd)
  const branch = repo === '' ? '' : (await run(['git', '-C', cwd, 'branch', '--show-current'])).trim()
  const trusted = await trusts(capture, cwd)
  const answer = await ask(capture.relay, { t: 'start', id: crypto.randomUUID(), to: target.id, repo, branch, folder: repo === '' ? cwd : inside, trusted })
  if (answer.t === 'offline') throw new Error(`${machine} is offline, so anyhost started no session there.`)
  if ('error' in answer) throw new Error(`${machine} could not start a session: ${reasonOf(answer.error)}.`)
  return answer.session
}

// The machine side of `start`, once for each start's id (`answerOnce`).
export const receiveStart = (capture: Capture, asked: Extract<Delivered, { readonly t: 'start' }>, here: ReceiveHere): Promise<void> =>
  answerOnce(capture.relay, asked, () => startSession(capture, asked, here))

// Finds or clones the checkout as a restore does, starts a new session in Claude Code's background there, claims it,
// and answers it once Claude Code lists it running. A start that fails once its job started stops the job at once.
async function startSession(capture: Capture, asked: Extract<Delivered, { readonly t: 'start' }>, here: ReceiveHere): Promise<StartedAnswer> {
  const { relay, roots, device } = capture
  let reply: StartedAnswer
  // the stop of the job this start started here
  let stopJob: (() => Promise<void>) | undefined
  try {
    const writer = (await devicesOf(relay)).get(asked.from.id)?.roots
    if (writer === undefined) throw new Error(`the relay knows no machine ${asked.from.name}`)
    const place = asked.repo === '' ? { repo: '', repoFolder: '', cwd: asked.folder } : { repo: asked.repo, repoFolder: asked.folder, cwd: '' }
    const cwd = await localFolder(capture, place, writer, here.checkouts)
    await cloneMissing(place, cwd, roots.home, asked.branch)
    await mkdir(cwd, { recursive: true })
    if (asked.trusted) await trustHere(capture, cwd, asked.from.name)
    const env = await here.environment
    const id = await startInBackground(undefined, cwd, env)
    stopJob = () => stopInBackground(id, env)
    const running = await whenSessions(roots.claudeHome, (sessions) => sessions.find((entry) => entry.id === id), RUNNING_MS, here.onRecordsChange)
    if (running === undefined) throw new Error(`Claude Code listed the new session ${id} running on ${device.name} no ${RUNNING_MS / 1000} s after its start.`)
    const { sessionId } = running
    await takeClaim(relay, sessionId, { take: false })
    console.error(`${stamp()} ${device.name} started ${sessionId} in ${cwd} for ${asked.from.name}.`)
    reply = { t: 'started', id: asked.id, to: asked.from.id, session: sessionId }
  } catch (error) {
    console.error(`${stamp()} ${device.name} could not start a session for ${asked.from.name}: ${messageOf(error)}`)
    await stopJob?.().catch((failure: unknown) => console.error(`${stamp()} ${device.name} could not stop the background job it started for ${asked.from.name}: ${messageOf(failure)}`))
    reply = { t: 'started', id: asked.id, to: asked.from.id, error: messageOf(error) }
  }
  return reply
}

// This machine's side of another machine's take of a session, as the relay's `released` or a welcome's `waiting` says
// it: Claude Code's background job of the session here stops, so no copy runs here that refuses every prompt, as after
// a move that failed took the session back from this machine, by whichever program started the job. A job in a turn
// stops once its record says `idle`, so no turn is cut off, as the relay refuses that turn's frames anyway. Its viewers
// hear where the session went. A move of the session from here leaves its copy alone, as the move stops it itself once
// the session runs there, and a session this machine holds again by then keeps its job.
export async function receiveReleased(capture: Capture, { session, to }: Released, here: MoveHere): Promise<void> {
  const moving = here.moves.get(session)
  if (moving !== undefined && moving.step !== 'moved' && moving.step !== 'failed') return
  const { db, device, roots } = capture
  const job = await whenSessions(
    roots.claudeHome,
    (sessions) => {
      const copy = sessions.find((entry) => entry.sessionId === session)
      if (copy?.kind !== 'background' || copy.id === undefined) return { id: undefined }
      return (copy.status ?? 'idle') === 'idle' ? { id: copy.id } : undefined
    },
    Infinity,
    here.onRecordsChange,
  )
  if (job?.id === undefined || (journalOf(db, session)?.holder ?? '') === '') return
  here.movedAway(session, to.name)
  await stopInBackground(job.id, await here.environment).then(
    () => console.error(`${stamp()} ${to.name} took ${session} over, so ${device.name} stopped its background job ${job.id}.`),
    (error: unknown) => console.error(`${stamp()} ${to.name} took ${session} over, and ${device.name} could not stop its background job ${job.id}: ${messageOf(error)}`),
  )
}
