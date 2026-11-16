import { expect, test } from 'bun:test'
import type { AgentStatus, HookEvent } from '../../relay/protocol.ts'
import { Activity } from '../src/activity.ts'
import type { RunningSession } from '../src/claude.ts'
import { memoryRelay, until } from './memory.ts'
import { hookOn, runningOn, SESSION, workerOn } from './program.ts'

const recordAt = (status: string, at: number): RunningSession => ({ pid: 1, sessionId: SESSION, cwd: '/work', status, statusSince: at })

test('the newest of a hook and Claude Code’s record decides a session’s activity, and a turn’s end hands it back to the record', () => {
  const steps: readonly (readonly [string, HookEvent | RunningSession, AgentStatus])[] = [
    ['a prompt, before the record changes', 'turnStart', 'working'],
    ['the record catching up', recordAt('busy', 2000), 'working'],
    ['a permission dialog', 'asked', 'waiting'],
    ['the person answers it', recordAt('busy', 4000), 'working'],
    ['the turn ends with background agents running', 'turnEnd', 'working'],
    ['the agents finish', recordAt('idle', 6000), 'idle'],
    ['a prompt again', 'turnStart', 'working'],
    ['a record write older than the prompt', recordAt('idle', 6000), 'working'],
    ['the session ends', 'ended', 'idle'],
  ]
  const activity = new Activity()
  let record = recordAt('idle', 0)
  const seen = steps.map(([, step], at) => {
    if (typeof step === 'string') activity.hear(SESSION, step, at * 1000 + 500)
    else record = step
    return activity.of(record)
  })

  expect(seen).toEqual(steps.map(([, , status]) => status))
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
