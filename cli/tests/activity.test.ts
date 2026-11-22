import { expect } from 'bun:test'
import { test } from './test.ts'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentStatus, HookEvent } from '../../relay/protocol.ts'
import { Activity } from '../src/activity.ts'
import type { RunningSession } from '../src/claude.ts'
import { lastTurnOf } from '../src/transcript.ts'
import { memoryRelay, until } from './memory.ts'
import { hookOn, runningOn, serveOn, SESSION, temporaryFolder, workerOn } from './program.ts'

const recordAt = (status: string, at: number): RunningSession => ({ pid: 1, sessionId: SESSION, cwd: '/work', status, statusSince: at })

type Agent = { readonly id: string; readonly status: string; readonly background: boolean }
const listedOn = async (socket: string): Promise<Agent | undefined> => ((await (await fetch('http://localhost/agents', { unix: socket })).json()) as { readonly agents: readonly Agent[] }).agents.find(({ id }) => id === SESSION)
const endTurnIn = (transcript: string): void =>
  appendFileSync(
    transcript,
    [
      { type: 'assistant', isSidechain: false, sessionId: SESSION, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Two agents book the trains while I wait.' }] } },
      { type: 'system', subtype: 'turn_duration', isSidechain: false, sessionId: SESSION, timestamp: new Date().toISOString(), durationMs: 4000 },
    ]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join(''),
  )

test('the newest of a hook and Claude Code’s record decides a session’s activity, and the main agent shows apart from its background work', () => {
  const steps: readonly (readonly [string, HookEvent | RunningSession, AgentStatus, AgentStatus, boolean])[] = [
    ['a prompt, before the record changes', 'turnStart', 'working', 'working', false],
    ['the record catching up', recordAt('busy', 2000), 'working', 'working', false],
    ['a permission dialog', 'asked', 'waiting', 'waiting', false],
    ['the person answers it', recordAt('busy', 4000), 'working', 'working', false],
    ['the turn ends with background agents running', 'turnEnd', 'working', 'idle', true],
    ['the main agent asks a question while they run', 'asked', 'waiting', 'waiting', true],
    ['the person answers and its turn ends', 'turnEnd', 'working', 'idle', true],
    ['the agents finish', recordAt('idle', 8000), 'idle', 'idle', false],
    ['a background command after a turn', recordAt('shell', 9000), 'working', 'idle', true],
    ['a prompt again', 'turnStart', 'working', 'working', false],
    ['the session ends', 'ended', 'working', 'idle', true],
  ]
  const activity = new Activity()
  let record = recordAt('idle', 0)
  const seen = steps.map(([, step], at) => {
    if (typeof step === 'string') activity.hear(SESSION, step, at * 1000 + 500)
    else record = step
    return [activity.of(record), activity.mainOf(record), activity.isBackground(record)]
  })

  expect(seen).toEqual(steps.map(([, , status, main, background]) => [status, main, background]))
})

test('a prompt turns its session Working in the list within 500 ms of its hook, through list reads that wait for each change', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  type Listed = { readonly version: string; readonly agents: readonly { readonly id: string; readonly status: string }[] }
  const listed = async (after?: string): Promise<Listed> => (await (await fetch(`http://localhost/agents${after === undefined ? '' : `?after=${encodeURIComponent(after)}`}`, { unix: laptop.socket })).json()) as Listed
  const statusIn = (list: Listed): string | undefined => list.agents.find(({ id }) => id === SESSION)?.status
  const before = await listed()
  let answered = await listed()

  const started = Date.now()
  await hookOn(laptop.socket, 'turnStart', laptop.cwd)
  while (statusIn(answered) !== 'working' && Date.now() - started < 10_000) answered = await listed(answered.version)
  const tookMs = Date.now() - started
  await hookOn(laptop.socket, 'asked', laptop.cwd)
  const asked = statusIn(await listed())
  laptop.status('busy')
  await hookOn(laptop.socket, 'turnEnd', laptop.cwd)
  laptop.status('idle')
  const ended = statusIn(await listed())

  expect(statusIn(before)).toBe('idle')
  expect(statusIn(answered)).toBe('working')
  expect(tookMs).toBeLessThan(500)
  expect([asked, ended]).toEqual(['waiting', 'idle'])
}, 60_000)

test("a prompt on one machine turns its session Working in another machine's waiting list read within a second", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  type Listed = { readonly version: string; readonly agents: readonly { readonly id: string; readonly status: string }[] }
  const listOn = async (after?: string): Promise<Listed> => (await (await fetch(`http://localhost/agents${after === undefined ? '' : `?after=${encodeURIComponent(after)}`}`, { unix: worker.socket })).json()) as Listed
  const statusIn = (list: Listed): string | undefined => list.agents.find(({ id }) => id === SESSION)?.status
  await until(async () => statusIn(await listOn()) === 'idle', 'the worker listing the session idle')
  let listed = await listOn()

  await hookOn(laptop.socket, 'turnStart', laptop.cwd)
  const started = Date.now()
  while (statusIn(listed) !== 'working' && Date.now() - started < 10_000) listed = await listOn(listed.version)

  expect(statusIn(listed)).toBe('working')
  expect(Date.now() - started).toBeLessThan(1000)
}, 60_000)

test("a session's state counts from the hook that set it, else from the record's own change", () => {
  const activity = new Activity()
  const record = recordAt('busy', 1000)
  const before = activity.mainSince(record)
  activity.hear(SESSION, 'asked', 5000)

  expect([before, activity.mainSince(record), activity.mainSince(recordAt('idle', 9000))]).toEqual([1000, 5000, 9000])
})

test("a turn's end heard after the record changed for a newer turn leaves that turn open", () => {
  const activity = new Activity()
  const record = recordAt('busy', 5000)
  activity.hear(SESSION, 'turnStart', 5000)
  activity.hear(SESSION, 'asked', 6000)
  activity.hear(SESSION, 'turnEnd', 4000)

  expect([activity.of(record), activity.mainOf(record), activity.isBackground(record)]).toEqual(['waiting', 'waiting', false])
})

test("a transcript's last turn is open from its prompt, a task's notification or a reply, and closed at its turn_duration line, an interruption or Claude Code's own answer, whatever local commands and subagents write after", async () => {
  const at = (second: number): string => `2026-11-18T10:00:0${second}.000Z`
  const said = (text: string, second: number, more: object = {}): object => ({ type: 'user', isSidechain: false, timestamp: at(second), message: { role: 'user', content: text }, ...more })
  const answered = (text: string, second: number, model = 'claude-opus-5-5', more: object = {}): object => ({ type: 'assistant', isSidechain: false, timestamp: at(second), message: { role: 'assistant', model, content: [{ type: 'text', text }] }, ...more })
  const prompt = said('Book the trains', 1)
  const ended = { type: 'system', subtype: 'turn_duration', isSidechain: false, timestamp: at(3) }
  const command = said('<command-name>/model</command-name>', 4)
  const output = said('<local-command-stdout>Set model to opus</local-command-stdout>', 5)
  const subagent = answered('Found two trains.', 6, 'claude-opus-5-5', { isSidechain: true })
  const transcripts = [
    [prompt],
    [prompt, answered('Booking.', 2)],
    [prompt, answered('Booking.', 2), ended, command, output, subagent],
    [prompt, said('[Request interrupted by user]', 3), command],
    [prompt, answered('API Error: 529 Overloaded', 3, '<synthetic>')],
    [prompt, answered('Booking.', 2), ended, said('<task-notification><summary>The agent booked both trains.</summary></task-notification>', 4), said('Summary of the trip so far', 5, { isMeta: true })],
    [],
  ]
  const folder = temporaryFolder()

  const turns = await Promise.all(
    transcripts.map(async (lines, index) => {
      const path = join(folder, `${index}.jsonl`)
      writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
      return await lastTurnOf(path)
    }),
  )

  expect(turns).toEqual([
    { isOpen: true, at: Date.parse(at(1)) },
    { isOpen: true, at: Date.parse(at(2)) },
    { isOpen: false, at: Date.parse(at(3)) },
    { isOpen: false, at: Date.parse(at(3)) },
    { isOpen: false, at: Date.parse(at(3)) },
    { isOpen: true, at: Date.parse(at(4)) },
    undefined,
  ])
})

test('a session whose turn ended while its agents run lists its tasks running, and stays so as their dialogs change its record, until they finish', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await hookOn(laptop.socket, 'turnStart', laptop.cwd)
  laptop.status('busy')
  const working = await listedOn(laptop.socket)
  endTurnIn(laptop.transcript)
  await hookOn(laptop.socket, 'turnEnd', laptop.cwd)
  const ended = await listedOn(laptop.socket)
  laptop.status('waiting')
  const asking = await listedOn(laptop.socket)
  laptop.status('busy')
  const answered = await listedOn(laptop.socket)
  laptop.status('idle')
  const done = await listedOn(laptop.socket)

  expect([working, ended, asking, answered, done].map((listed) => [listed?.status, listed?.background])).toEqual([
    ['working', false],
    ['idle', true],
    ['waiting', false],
    ['idle', true],
    ['idle', false],
  ])
}, 60_000)

test('after the program restarts, a session whose turn ended while its agents run lists its tasks running, from its transcript', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await hookOn(laptop.socket, 'turnStart', laptop.cwd)
  laptop.status('busy')
  endTurnIn(laptop.transcript)

  laptop.child.kill('SIGKILL')
  await laptop.child.exited
  await serveOn(laptop.env)
  const listed = await listedOn(laptop.socket)

  expect([listed?.status, listed?.background]).toEqual(['idle', true])
}, 60_000)

test('a session whose turn ended with no hook heard while a background command runs lists its tasks running, never done', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await hookOn(laptop.socket, 'turnStart', laptop.cwd)
  laptop.status('busy')
  endTurnIn(laptop.transcript)
  laptop.status('shell')
  const listed = await listedOn(laptop.socket)

  expect([listed?.status, listed?.background]).toEqual(['idle', true])
}, 60_000)
