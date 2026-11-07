// A session moves to another machine, which runs it in Claude Code's background from then on, and a new session
// starts on another machine. The program of the machine that runs a session holds the session's upload queue, so `move`
// runs there: it waits for the session's turn to end, drains, seals and sends `move`, and the machine it goes to takes
// the claim, restores the session and starts it in `receiveMove`. A move that fails leaves the session running where it
// was, with its claim taken back. `startNew` and `receiveStart` start a new session on another machine in the same
// repository.
import { mkdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Delivered, Offline, Routed } from '../../relay/protocol.ts'
import { attachTerminal, isAlive, keptSessions, recordedSessions, run, startInBackground, stopInBackground, whenSessions, type RunningSession } from './background.ts'
import { captureAgainFrom, changedFiles, checkoutOf, holdHere, journalOf, seal, startCode, writeIndex, type Capture, type Problems } from './capture.ts'
import { HeldElsewhere, takeClaim } from './claims.ts'
import { devicesOf, machinesOf } from './device.ts'
import type { Relay } from './relay.ts'
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
// How often a move asks the relay whether the machine it waits for still has a socket open.
const CONNECTED_MS = 10_000
// Claude Code locks its global config as proper-lockfile does: it makes the folder `<config>.lock`, which counts as
// left behind 10 s after it last changed, and waits these times between tries, in 2.1.319.
const LOCK_STALE_MS = 10_000
const LOCK_WAITS_MS = [200, 400, 800, 1600, 3200, 4000]

export type MoveStep = 'waiting' | 'uploading' | 'moving' | 'moved' | 'failed'
// A move this program runs, as the mod and `anyhost move` show it: its step and the line that says it. `keep` takes
// the session back from a machine that answers nothing while the move waits for it.
export type Moving = { readonly session: string; readonly to: string; step: MoveStep; line: string; readonly keep: () => void }
// What a move needs of the program that runs it.
export type MoveHere = {
  readonly moves: Map<string, Moving>
  readonly problems: Problems
  readonly environment: Promise<Record<string, string>>
  // a path of the session for its next drain, and the drain of the session now, as the upload queue runs them
  readonly queue: (session: string, tool: Tool, path: string) => void
  readonly flush: (session: string) => Promise<void>
  // ends every viewer of a session this program shows, telling each the machine it runs on now
  readonly movedAway: (session: string, to: string) => void
}
// What a machine that receives a session or starts one needs of its program.
export type ReceiveHere = { readonly environment: Promise<Record<string, string>>; readonly checkouts: string }

type Answer = Extract<Delivered, { readonly t: 'moved' | 'started' }> | Offline
type MovedAnswer = Extract<Routed, { readonly t: 'moved' }>
type StartedAnswer = Extract<Routed, { readonly t: 'started' }>

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
// a reason inside a sentence of its own, without the period it may end with
const reasonOf = (error: unknown): string => messageOf(error).replace(/\.+$/, '')
const stamp = (): string => new Date().toISOString()

// Each message a relay sent that waits for its answer, by its id: the other machine's `moved` or `started`, or the
// Pool's `offline` for a machine with no socket open. Each relay hears them with one listener of each kind.
const waiting = new WeakMap<Relay, Map<string, (answer: Answer) => void>>()
function ask(relay: Relay, message: Extract<Routed, { readonly t: 'move' | 'start' }>): Promise<Answer> {
  let pending = waiting.get(relay)
  if (pending === undefined) {
    const known = new Map<string, (answer: Answer) => void>()
    const answered = (answer: Answer): void => {
      if (answer.id === undefined) return
      known.get(answer.id)?.(answer)
      known.delete(answer.id)
    }
    relay.on('moved', answered)
    relay.on('started', answered)
    relay.on('offline', answered)
    waiting.set(relay, known)
    pending = known
  }
  const answers = pending
  return new Promise((resolve, reject) => {
    answers.set(message.id, resolve)
    if (relay.send(message)) return
    answers.delete(message.id)
    reject(new Error(`This machine is not connected to the relay at ${relay.url}, so anyhost sent nothing.`))
  })
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
async function paneOf(session: string, env: Record<string, string>): Promise<{ readonly herdr: string; readonly pane: string } | undefined> {
  const herdr = Bun.which('herdr', { PATH: env['PATH'] ?? '' })
  if (herdr === null) return undefined
  const listed = await run([herdr, 'agent', 'list'], { env }).catch(() => undefined)
  if (listed === undefined) return undefined
  const { result } = JSON.parse(listed) as { result: { agents: readonly { pane_id: string; agent_session?: { value: string } }[] } }
  const pane = result.agents.find((agent) => agent.agent_session?.value === session)?.pane_id
  return pane === undefined ? undefined : { herdr, pane }
}

// Claude Code keeps each folder's trust in `projects[<folder>].hasTrustDialogAccepted` of its global config, `.claude.json`
// in CLAUDE_CONFIG_DIR, else in the home folder.
type Projects = Record<string, { readonly hasTrustDialogAccepted?: boolean } | undefined>
const configOf = (capture: Capture): string => join(process.env['CLAUDE_CONFIG_DIR'] ? capture.roots.claudeHome : capture.roots.home, '.claude.json')
const projectsOf = async (config: string): Promise<Projects> => ((await Bun.file(config).json().catch(() => ({}))) as { projects?: Projects }).projects ?? {}

// The records Claude Code 2.1.319 reads to trust `cwd`, the one its trust dialog writes first. Inside a git checkout
// that is the root of the repository's main checkout, then each folder from `cwd` up to the root of its own checkout, a
// worktree's included, and never a folder above it. Outside git it is `cwd`, then each folder above it up to `/`.
async function trustRecordsOf(cwd: string): Promise<readonly string[]> {
  const folder = await realpath(cwd)
  const asked = (what: string): Promise<string | undefined> =>
    run(['git', '-C', folder, 'rev-parse', '--path-format=absolute', what]).then((printed) => realpath(printed.trim()), () => undefined)
  const top = await asked('--show-toplevel')
  const common = await asked('--git-common-dir')
  const key = top === undefined ? folder : common !== undefined && basename(common) === '.git' ? dirname(common) : top
  const walked: string[] = []
  for (let at = folder; ; at = dirname(at)) {
    walked.push(at)
    if (at === top || dirname(at) === at) break
  }
  return [key, ...walked]
}

// Whether Claude Code here trusts `cwd`, as it decides it before it starts a session there.
async function trusts(capture: Capture, cwd: string): Promise<boolean> {
  const projects = await projectsOf(configOf(capture))
  return (await trustRecordsOf(cwd).catch(() => [])).some((record) => projects[record]?.hasTrustDialogAccepted === true)
}

// Runs `work` holding Claude Code's lock of `file`, as Claude Code itself takes it: a lock left behind goes, and one
// another process holds is tried again after each of Claude Code's waits.
async function lockedConfig<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`
  for (let tries = 0; ; ) {
    const error = await mkdir(lock).then(() => undefined, (failure: NodeJS.ErrnoException) => failure)
    if (error === undefined) break
    if (error.code !== 'EEXIST') throw error
    const changedAt = await stat(lock).then((found) => found.mtimeMs, () => 0)
    if (Date.now() - changedAt > LOCK_STALE_MS) {
      await rmdir(lock).catch(() => undefined)
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
// dotfiles is, stays one: the new file replaces the file it points to. Claude Code locks at the path it names the config
// by, `<config>.lock` beside the link, which proper-lockfile takes as given, so the lock stays there.
async function trustHere(capture: Capture, cwd: string, from: string): Promise<void> {
  if (await trusts(capture, cwd)) return
  const [key = cwd] = await trustRecordsOf(cwd)
  const config = configOf(capture)
  await lockedConfig(config, async () => {
    const real = await realpath(config).catch(() => config)
    const read = JSON.parse(await Bun.file(real).text().catch(() => '{}')) as { projects?: Projects }
    const written = { ...read, projects: { ...read.projects, [key]: { ...read.projects?.[key], hasTrustDialogAccepted: true } } }
    const mode = await stat(real).then((found) => found.mode & 0o777, () => 0o600)
    const temporary = `${real}.anyhost-${crypto.randomUUID().slice(0, 8)}`
    try {
      await writeFile(temporary, JSON.stringify(written, null, 2), { mode })
      await rename(temporary, real)
    } finally {
      await rm(temporary, { force: true })
    }
  })
  console.error(`${stamp()} ${capture.device.name} trusts ${key} in Claude Code, as ${from} trusts the session's folder there.`)
}

// Every file of the session up, its working folder's code read once more and up, and its journal sealed, so the
// machine it goes to restores all of it. A journal whose chain in R2 ends short of the end this machine counted, as
// after R2 lost a frame, goes on from there with every file whole, as `sealQuiet` does, and is sealed again. A journal
// still short after that fails the move, as the other machine would restore the session without the lost span.
async function upload(capture: Capture, session: string, tool: Tool, here: MoveHere): Promise<void> {
  // the paths up, then the working folder's code read once more and up
  const send = async (paths: Iterable<string>): Promise<void> => {
    for (const path of paths) here.queue(session, tool, path)
    await here.flush(session)
    let failure: unknown
    const reading: Problems = {
      set(key, error) {
        failure = error
        here.problems.set(key, error)
      },
      clear: (key) => here.problems.clear(key),
    }
    let isRead = false
    for (;;) {
      const running = capture.codeRuns.get(session)
      const waiting = capture.codeWaiting.get(session)
      if (running !== undefined) await running
      else if (waiting !== undefined) {
        here.queue(session, tool, `${waiting.folder}/`)
        await here.flush(session)
      } else if (!isRead || capture.codeStale.has(session)) {
        isRead = true
        startCode(capture, session, tool, reading)
        if (!capture.codeRuns.has(session)) break
      } else break
      if (failure !== undefined) throw new Error(`anyhost could not read the code of ${session.slice(0, 8)}: ${messageOf(failure)}`)
    }
  }
  await send((await changedFiles(capture)).get(session) ?? [])
  const end = journalOf(capture.db, session)?.end ?? 0
  const at = await seal(capture, session)
  if (at !== end) {
    await send(captureAgainFrom(capture, session, tool, at, end, here.problems))
    const healed = journalOf(capture.db, session)?.end ?? 0
    const again = await seal(capture, session)
    if (again !== healed) throw new Error(`the journal of ${session} in R2 reaches byte ${again} after ${capture.device.name} uploaded its files again from byte ${at}, and it counted ${healed}`)
  }
  // the machine it goes to finds the session and its folder in this machine's index
  await writeIndex(capture)
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
  const holder = journalOf(db, session)?.holder ?? ''
  if (holder !== '') throw new Error(`This session continues on ${holder}.`)
  const tool = journalOf(db, session)?.tool ?? 'claude'
  if (tool !== 'claude') throw new Error(`anyhost moves Claude Code sessions, and ${session.slice(0, 8)} is a Codex session.`)
  const target = (await machinesOf(relay)).find(({ name }) => name === machine)
  if (target === undefined) throw new Error(`No machine joined to your relay is named ${machine}. anyhost machines lists them.`)
  if (target.id === device.id) throw new Error(`${machine} is this machine.`)
  const running = here.moves.get(session)
  if (running !== undefined && running.step !== 'moved' && running.step !== 'failed') throw new Error(`This session is moving to ${running.to} already.`)

  const id = session.slice(0, 8)
  // Claude Code's own record of the session: busy during a turn, which the move waits out
  const entry = (await recordedSessions(capture.roots.claudeHome)).find((recorded) => recorded.sessionId === session)
  const isBusy = entry?.status !== undefined && entry.status !== 'idle'
  let keep = (): void => undefined
  const kept = new Promise<'kept'>((resolve) => (keep = () => resolve('kept')))
  const moving: Moving = { session, to: machine, step: isBusy ? 'waiting' : 'uploading', line: isBusy ? `Waiting for ${id} to finish its turn.` : `Uploading ${id}.`, keep: () => keep() }
  here.moves.set(session, moving)
  const say = (step: MoveStep, line: string): void => {
    Object.assign(moving, { step, line })
    console.error(`${stamp()} ${line}`)
  }
  console.error(`${stamp()} ${moving.line}`)
  // A failed move takes the claim back, as the machine it went to may have taken it, and captures the session here
  // again, so it keeps running here with its prompts going through.
  const keepHere = async (line: string): Promise<void> => {
    try {
      await takeClaim(relay, session, { take: true })
      holdHere(db, session)
      say('failed', line)
    } catch (error) {
      say('failed', `${line} anyhost could not take its claim back: ${messageOf(error)}`)
    }
  }
  // the machine's socket closed while the move waits for its answer
  let isWaiting = true
  const gone = async (): Promise<'gone' | undefined> => {
    while (isWaiting) {
      await Bun.sleep(CONNECTED_MS)
      const listed = await machinesOf(relay).catch(() => undefined)
      if (isWaiting && listed?.find((each) => each.id === target.id)?.connected === false) return 'gone'
    }
    return undefined
  }
  void (async () => {
    const env = await here.environment
    if (isBusy) {
      await whenSessions(capture.roots.claudeHome, (sessions) => (sessions.find((listed) => listed.sessionId === session)?.status ?? 'idle') === 'idle' || undefined, Infinity, '')
      say('uploading', `Uploading ${id}.`)
    }
    await upload(capture, session, tool, here)
    say('moving', `Uploaded and sealed ${id}. ${machine} restores it.`)
    const cwd = db.query<{ cwd: string }, [string]>('select cwd from sessions where id = ?').get(session)?.cwd ?? ''
    const trusted = cwd !== '' && (await trusts(capture, cwd))
    const started = Date.now()
    const answer = await Promise.race([ask(relay, { t: 'move', id: crypto.randomUUID(), to: target.id, session, t3: false, trusted }), kept, gone()]).finally(() => (isWaiting = false))
    if (answer === 'kept') return await keepHere(`${machine} did not answer, so the session keeps running here.`)
    if (answer === 'gone' || answer?.t === 'offline') return await keepHere(`${machine} is offline, so the session keeps running here.`)
    if (answer?.t !== 'moved' || !answer.ok) return await keepHere(`${machine} could not take the session: ${reasonOf((answer?.t === 'moved' && answer.error) || 'it gave no reason')}. It keeps running here.`)
    say('moved', `${machine} restored ${id} in ${((Date.now() - started) / 1000).toFixed(1)} s and runs it.`)
    // The copy here stops once the session runs there. One Claude Code runs in its own background stops as a
    // background session, and its viewers follow it. One in a herdr pane ends, and the pane shows the session where it
    // runs now. Any other stays open and refuses each prompt, as only the person can type into its terminal.
    if (entry?.kind === 'background' && entry.id !== undefined) {
      here.movedAway(session, machine)
      await stopInBackground(entry.id, env)
      return
    }
    const pane = entry?.pid === undefined ? undefined : await paneOf(session, env)
    if (entry?.pid === undefined || pane === undefined) return
    process.kill(entry.pid, 'SIGTERM')
    await exited(entry.pid)
    await run([pane.herdr, 'pane', 'run', pane.pane, `anyhost attach ${id}`], { env })
  })().catch(async (error: unknown) => {
    here.problems.set(`move ${session}`, error)
    if (moving.step !== 'moved') await keepHere(`anyhost could not move the session to ${machine}: ${reasonOf(error)}. It keeps running here.`)
  })
  return moving
}

// Runs the session in Claude Code's background here and answers once Claude Code lists it running. `kept` is the
// background job Claude Code here keeps of it, which starts again with `claude attach`, which reopens it under its own
// id, as `claude --bg --resume` would start a copy under a new one.
async function runInBackground(capture: Capture, session: string, kept: RunningSession | undefined, cwd: string, env: Record<string, string>): Promise<void> {
  // a session that never ran says what Claude Code lists of its job
  const running = (): Promise<RunningSession> =>
    whenSessions(capture.roots.claudeHome, (sessions) => sessions.find((entry) => entry.sessionId === session && entry.pid !== undefined), RUNNING_MS, `Claude Code listed the session ${session.slice(0, 8)} running on ${capture.device.name} no ${RUNNING_MS / 1000} s after its start`).catch(async (error: unknown) => {
      const job = (await keptSessions().catch(() => [])).find((entry) => entry.sessionId === session)
      throw new Error(`${messageOf(error)}, and ${job === undefined ? 'lists no job of it' : `lists its job ${job.id ?? ''} as ${job.state ?? 'neither running nor stopped'}`}`)
    })
  if (kept?.id === undefined) {
    await startInBackground(session, cwd, env)
    await running()
    return
  }
  console.error(`${stamp()} ${capture.device.name} starts the job Claude Code keeps of ${session} again with claude attach ${kept.id}.`)
  const terminal = attachTerminal(kept.id, kept.cwd, env, { cols: 80, rows: 24 }, () => undefined)
  try {
    await running()
  } finally {
    terminal.close()
  }
}

// The machine side of `move`: takes the claim and restores the session as `anyhost resume --take` does, runs it in
// Claude Code's background, and answers whether it runs here. A machine that took the session back meanwhile keeps
// it, and the copy here stops.
export async function receiveMove(capture: Capture, asked: Extract<Delivered, { readonly t: 'move' }>, here: ReceiveHere): Promise<MovedAnswer> {
  const answer = (outcome: { readonly ok: true } | { readonly ok: false; readonly error: string }): MovedAnswer => ({ t: 'moved', id: asked.id, to: asked.from.id, ...outcome })
  try {
    if (asked.t3) throw new Error('anyhost moves no session into T3 Code yet')
    console.error(`${stamp()} ${asked.from.name} moves ${asked.session} here.`)
    const env = await here.environment
    // What Claude Code here runs or keeps of the session, read once: a copy that runs here still holds the conversation
    // as it was, so it stops before the restore, and a kept job opens again after it.
    const kept = (await keptSessions()).find((entry) => entry.sessionId === asked.session)
    if (kept?.kind === 'interactive') throw new Error(`${capture.device.name} runs the session in a terminal of its own`)
    if (kept?.id !== undefined && kept.pid !== undefined) await stopInBackground(kept.id, env)
    const { session, cwd } = await restore(capture, asked.session, { take: true, checkouts: here.checkouts })
    if (session.tool !== 'claude') throw new Error(`${session.id.slice(0, 8)} is a Codex session, which runs in no background`)
    if (asked.trusted) await trustHere(capture, cwd, asked.from.name)
    await runInBackground(capture, session.id, kept, cwd, env)
    await takeClaim(capture.relay, session.id, { take: false }).catch(async (error: unknown) => {
      if (!(error instanceof HeldElsewhere)) throw error
      const id = (await recordedSessions(capture.roots.claudeHome)).find((entry) => entry.sessionId === session.id)?.id
      if (id !== undefined) await stopInBackground(id, env)
      throw new Error(`${error.holder.name} took the session back`)
    })
    console.error(`${stamp()} ${capture.device.name} runs ${session.id} in Claude Code's background in ${cwd}.`)
    return answer({ ok: true })
  } catch (error) {
    console.error(`${stamp()} ${capture.device.name} could not take ${asked.session} from ${asked.from.name}: ${messageOf(error)}`)
    return answer({ ok: false, error: messageOf(error) })
  }
}

// Starts a new session on the machine named `machine`, in its checkout of the repository `folder` is in, else in the
// folder there that `folder` is here, and answers the session.
export async function startNew(capture: Capture, machine: string, folder: string): Promise<string> {
  const target = (await machinesOf(capture.relay)).find(({ name }) => name === machine)
  if (target === undefined) throw new Error(`No machine joined to your relay is named ${machine}. anyhost machines lists them.`)
  if (target.id === capture.device.id) throw new Error(`${machine} is this machine. Run claude here.`)
  const cwd = resolve(folder)
  const { repo, folder: inside } = await checkoutOf(cwd)
  const branch = repo === '' ? '' : (await run(['git', '-C', cwd, 'branch', '--show-current'])).trim()
  const trusted = await trusts(capture, cwd)
  const answer = await ask(capture.relay, { t: 'start', id: crypto.randomUUID(), to: target.id, repo, branch, folder: repo === '' ? cwd : inside, trusted })
  if (answer.t === 'offline') throw new Error(`${machine} is offline, so anyhost started no session there.`)
  if (answer.t !== 'started') throw new Error(`${machine} answered no start.`)
  if ('error' in answer) throw new Error(`${machine} could not start a session: ${reasonOf(answer.error)}.`)
  return answer.session
}

// The machine side of `start`: finds or clones the checkout as a restore does, starts a new session in Claude Code's
// background there, claims it, and answers it once Claude Code lists it running.
export async function receiveStart(capture: Capture, asked: Extract<Delivered, { readonly t: 'start' }>, here: ReceiveHere): Promise<StartedAnswer> {
  const { relay, roots, device } = capture
  try {
    const writer = (await devicesOf(relay)).get(asked.from.id)?.roots
    if (writer === undefined) throw new Error(`the relay knows no machine ${asked.from.name}`)
    const place = asked.repo === '' ? { repo: '', repoFolder: '', cwd: asked.folder } : { repo: asked.repo, repoFolder: asked.folder, cwd: '' }
    const cwd = await localFolder(capture, place, { ...writer, checkout: writer.home }, here.checkouts)
    await cloneMissing(place, cwd, roots.home, asked.branch)
    await mkdir(cwd, { recursive: true })
    if (asked.trusted) await trustHere(capture, cwd, asked.from.name)
    const id = await startInBackground(undefined, cwd, await here.environment)
    const { sessionId } = await whenSessions(capture.roots.claudeHome, (sessions) => sessions.find((entry) => entry.id === id && entry.pid !== undefined), RUNNING_MS, `Claude Code listed the new session ${id} running on ${device.name} no ${RUNNING_MS / 1000} s after its start.`)
    await takeClaim(relay, sessionId, { take: false })
    console.error(`${stamp()} ${device.name} started ${sessionId} in ${cwd} for ${asked.from.name}.`)
    return { t: 'started', id: asked.id, to: asked.from.id, session: sessionId }
  } catch (error) {
    console.error(`${stamp()} ${device.name} could not start a session for ${asked.from.name}: ${messageOf(error)}`)
    return { t: 'started', id: asked.id, to: asked.from.id, error: messageOf(error) }
  }
}
