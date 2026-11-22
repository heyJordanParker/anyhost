import { expect } from 'bun:test'
import { test } from './test.ts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { memoryRelay, type MemoryRelay } from './memory.ts'
import { cmodServeOf, hookOn, isUploaded, LAPTOP, logOf, machineFor, OTHER_SESSION, runningOn, serveOn, SESSION, transcriptsReadOn, withCmod, WORKER } from './program.ts'

type Listed = { readonly id: string; readonly title: string; readonly cwd: string; readonly isRunning: boolean; readonly visitedAt?: string; readonly device?: { readonly id: string; readonly name: string } }
type Refused = { readonly code: number; readonly message: string }
type Change = { readonly session: string; readonly part: string }

const NOT_HELD = -32098
const laptopMachine = { id: LAPTOP.id, name: LAPTOP.name }
const MESSAGES = [{ id: 'm1', role: 'user', text: 'Plan the trip' }]
const USAGE = { model: 'claude-opus-5-5', contextWindow: { tokenCount: 1200 } }
const transcriptsOf = (line: string): string => line.split(' ')[line.split(' ').indexOf('--transcripts') + 1] ?? ''

type Agents = { readonly agents: readonly { readonly id: string; readonly deleted: boolean }[]; readonly version: string }

async function watchList(socket: string, isDone: (agents: Agents['agents']) => boolean | Promise<boolean>): Promise<void> {
  for (let version = ''; ; ) {
    const listed = (await (await fetch(`http://localhost/agents?after=${version}`, { unix: socket })).json()) as Agents
    if (await isDone(listed.agents)) return
    version = listed.version
  }
}

async function ownSessionOn(relay: MemoryRelay, worker: { readonly env: Record<string, string>; readonly socket: string }): Promise<void> {
  const cwd = join(worker.env['HOME'] ?? '', 'notes')
  mkdirSync(cwd, { recursive: true })
  const transcript = join(worker.env['HOME'] ?? '', '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${OTHER_SESSION}.jsonl`)
  mkdirSync(join(transcript, '..'), { recursive: true })
  writeFileSync(transcript, `{"type":"user","cwd":"${cwd}","sessionId":"${OTHER_SESSION}","message":{"role":"user","content":"Write the notes"}}\n`)
  await hookOn(worker.socket, 'started', cwd, OTHER_SESSION)
  await watchList(worker.socket, async () => (await relay.claims()).get(OTHER_SESSION) === WORKER.id)
}

async function laptopOff() {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay, LAPTOP, { uploadEvery: 0 })
  const worker = await machineFor(relay, WORKER, { uploadEvery: 0 })
  const cmod = cmodServeOf(worker)
  await serveOn(withCmod(worker.env))
  await cmod.provides('cmod/Sessions')
  await ownSessionOn(relay, worker)
  await hookOn(laptop.socket, 'renamed', laptop.cwd, SESSION, '', 'Plan the trip')
  await watchList(worker.socket, (agents) => agents.some(({ id, deleted }) => id === SESSION && !deleted) && isUploaded(relay, SESSION, 'Plan the trip'))
  await cmod.listen('cmod/Sessions', 'Change')
  const listed = async (): Promise<Listed[]> => (await cmod.call('cmod/Sessions', 'sessions', { everyProject: true })) as Listed[]
  const changes = (): Change[] => cmod.heard.filter(({ event }) => event === 'Change').map(({ payload }) => payload as Change)
  const listedOnChange = async (isDone: (sessions: readonly Listed[]) => boolean): Promise<Listed[]> => {
    for (;;) {
      const told = changes().length
      const next = cmod.once(() => changes().length > told)
      const now = await listed()
      if (isDone(now)) return now
      await next
    }
  }
  const reconnect = relay.disconnect(LAPTOP.id)
  const whileOff = await listedOnChange((sessions) => sessions.some(({ id }) => id === SESSION))
  const refusal = (method: string, ...params: readonly unknown[]): Promise<Refused> =>
    cmod.call('cmod/Sessions', method, ...params).then(
      () => ({ code: 0, message: `${method} answered` }),
      (error: unknown) => ({ code: (error as Refused).code, message: (error as Refused).message }),
    )
  return { relay, laptop, worker, cmod, listed, changes, listedOnChange, whileOff, reconnect, refusal }
}

test("cmod/Sessions lists the session of a machine that is off with that machine as its device and none of this machine's, tells it stopped running, refuses this machine's sessions as not held, and lists it no more once its machine connects again", async () => {
  const { relay, laptop, changes, listedOnChange, whileOff, reconnect, refusal } = await laptopOff()

  const ownSession = await refusal('read', OTHER_SESSION, 'messages', {})
  const toldWhileOff = changes().filter(({ session }) => session === SESSION)
  reconnect()
  const whileOn = await listedOnChange((sessions) => !sessions.some(({ id }) => id === SESSION))

  expect(whileOff.map(({ id, title, cwd, isRunning, device }) => ({ id, title, cwd, isRunning, device }))).toEqual([{ id: SESSION, title: 'Plan the trip', cwd: laptop.cwd, isRunning: false, device: laptopMachine }])
  expect((await relay.claims()).get(OTHER_SESSION)).toBe(WORKER.id)
  expect(toldWhileOff).toContainEqual({ session: SESSION, part: 'running' })
  expect(ownSession).toEqual({ code: NOT_HELD, message: `This provider holds no session ${OTHER_SESSION}.` })
  expect(whileOn.map(({ id }) => id)).toEqual([])
}, 120_000)

test("cmod/Sessions reads the messages and usage of a session of a machine that is off from its journal in R2, through cmod's --transcripts on a Claude Code folder that holds the session's transcript while cmod runs and is gone after", async () => {
  const { laptop, worker, cmod } = await laptopOff()
  const seen = transcriptsReadOn(worker, { messages: MESSAGES, usage: USAGE })

  const messages = await cmod.call('cmod/Sessions', 'read', SESSION, 'messages', { last: 2 })
  const usage = await cmod.call('cmod/Sessions', 'usage', SESSION, null, { task: 'agent-1' })
  const [readMessages = '', readUsage = ''] = logOf(seen, 'argv.log')

  expect(readMessages).toBe(`sessions read messages ${SESSION} --transcripts ${transcriptsOf(readMessages)} --last 2 --json`)
  expect(readUsage).toBe(`sessions read usage ${SESSION} --transcripts ${transcriptsOf(readUsage)} --task agent-1 --json`)
  expect(readFileSync(join(seen, 'messages', basename(dirname(laptop.transcript)), `${SESSION}.jsonl`), 'utf8')).toBe(readFileSync(laptop.transcript, 'utf8'))
  expect([readMessages, readUsage].map((line) => existsSync(dirname(transcriptsOf(line))))).toEqual([false, false])
  expect(messages).toEqual(MESSAGES)
  expect(usage).toEqual(USAGE)
}, 120_000)

test("cmod/Sessions answers each action on a session of a machine that is off as anyhost's own routes do: running it is refused with why, a visit marks it, a delete takes it over and deletes it, and a task on that machine is refused while a task on a machine that is on is not held", async () => {
  const { relay, worker, cmod, listed, changes, refusal } = await laptopOff()
  const offline = `${LAPTOP.name}, which holds ${SESSION.slice(0, 8)}, is offline. open_agent continues it on another machine.`
  const visitedAt = '2026-11-20T10:00:00.000Z'
  const isTold = (part: string): boolean => changes().some((change) => change.session === SESSION && change.part === part)

  const refused = {
    send: await refusal('send', SESSION, { type: 'prompt', text: 'Go on', as: 'session' }, { caller: OTHER_SESSION }),
    note: await refusal('send', SESSION, { type: 'note', text: 'Go on' }, {}),
    abort: await refusal('abort', SESSION, null, {}),
    end: await refusal('end', SESSION, null, {}),
    fork: await refusal('fork', SESSION, { prompt: 'Try Porto first', title: 'Porto' }, {}),
    callTool: await refusal('callTool', SESSION, { name: 'Read', input: {} }, {}),
    search: await refusal('search', 'trip', { everyProject: true }),
    startTask: await refusal('startTask', OTHER_SESSION, { prompt: 'Plan the return', title: 'Return', device: LAPTOP.id }, { caller: OTHER_SESSION }),
    startTaskHere: await refusal('startTask', OTHER_SESSION, { prompt: 'Plan the return', title: 'Return', device: WORKER.id }, { caller: OTHER_SESSION }),
  }
  const surfaces = await cmod.call('cmod/Sessions', 'surfaces', SESSION, null, {})
  await cmod.call('cmod/Sessions', 'visit', SESSION, visitedAt)
  await cmod.once(() => isTold('visit'))
  const visited = (await listed()).find(({ id }) => id === SESSION)?.visitedAt
  await cmod.call('cmod/Sessions', 'delete', SESSION, null, {})
  await cmod.once(() => isTold('deleted'))
  await watchList(worker.socket, async () => !(await listed()).some(({ id }) => id === SESSION))
  const claims = await relay.claims()

  expect(Object.fromEntries(Object.entries(refused).map(([method, { message }]) => [method, message]))).toEqual({
    send: offline,
    note: `anyhost types prompts into a session's terminal and keeps no note for its next prompt, so ${SESSION.slice(0, 8)} of ${LAPTOP.name} gets none.`,
    abort: offline,
    end: offline,
    fork: `${LAPTOP.name}, which holds ${SESSION.slice(0, 8)}, is offline, so fork it once ${LAPTOP.name} connects, or open it here first.`,
    callTool: `${SESSION.slice(0, 8)} is a session of ${LAPTOP.name}, which is off, and anyhost calls no tool in a session.`,
    search: 'anyhost keeps the sessions of machines that are off as journals in R2, with no index of their messages, so it searches none of them.',
    startTask: `${LAPTOP.name} is offline, so no session starts there.`,
    startTaskHere: `This provider holds no session ${OTHER_SESSION}.`,
  })
  expect(Object.entries(refused).flatMap(([method, { code }]) => (code === NOT_HELD ? [method] : []))).toEqual(['startTaskHere'])
  expect(surfaces).toEqual([])
  expect(visited).toBe(visitedAt)
  expect(claims.get(SESSION)).toBe(WORKER.id)
}, 120_000)
