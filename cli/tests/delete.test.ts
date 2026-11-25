import { expect } from 'bun:test'
import { test } from './test.ts'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { memoryRelay, until } from './memory.ts'
import { hookOn, killMachine, LAPTOP, OTHER_SESSION, postTo, runningOn, SESSION, spawnForTest, workerOn } from './program.ts'

test('a delete stops the session and removes its files, every machine lists it as deleted, and opening it brings its conversation back', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const listed = async (): Promise<{ readonly deleted: boolean } | undefined> =>
    ((await (await fetch('http://localhost/agents', { unix: laptop.socket })).json()) as { agents: { id: string; deleted: boolean }[] }).agents.find(({ id }) => id === SESSION)

  const deleted = await postTo(laptop.socket, '/agents/delete', { session: SESSION.slice(0, 8) })
  const whileDeleted = { transcript: existsSync(laptop.transcript), stopped: laptop.claude.signalCode, listed: await listed() }
  const opened = await postTo(laptop.socket, '/agents/open', { session: SESSION.slice(0, 8) })

  expect(deleted).toEqual({ status: 200, body: { session: SESSION } })
  expect(whileDeleted).toMatchObject({ transcript: false, stopped: 'SIGTERM', listed: { deleted: true } })
  expect(opened.status).toBe(200)
  expect(readFileSync(laptop.transcript, 'utf8')).toContain('Plan the trip')
  expect(await listed()).toMatchObject({ deleted: false })
}, 60_000)

test('a session whose machine is gone, or that no machine here ever held, is deleted from any machine, and every machine lists it as deleted', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  killMachine(laptop)
  type Machines = { readonly machines: readonly { readonly id: string; readonly connected: boolean }[] }
  const isLaptopGone = async (): Promise<boolean> => !((await (await fetch('http://localhost/machines', { unix: worker.socket })).json()) as Machines).machines.some(({ id, connected }) => id === LAPTOP.id && connected)
  await until(isLaptopGone, 'the Pool counting the laptop gone', 60_000)

  const deleted = await postTo(worker.socket, '/agents/delete', { session: SESSION.slice(0, 8) })
  const listed = ((await (await fetch('http://localhost/agents', { unix: worker.socket })).json()) as { agents: { id: string; deleted: boolean }[] }).agents.find(({ id }) => id === SESSION)

  expect(deleted).toEqual({ status: 200, body: { session: SESSION } })
  expect(listed).toMatchObject({ deleted: true })
}, 120_000)

test("deleting a session deletes its subagents too, so none outlives it on its own in the list", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const subagentTranscript = join(dirname(laptop.transcript), `${OTHER_SESSION}.jsonl`)
  writeFileSync(subagentTranscript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${OTHER_SESSION}","message":{"role":"user","content":"Book the hotel"}}\n`)
  const subagent = spawnForTest(['sleep', '600'])
  writeFileSync(join(laptop.env['HOME'] ?? '', '.claude', 'sessions', `${subagent.pid}.json`), JSON.stringify({ pid: subagent.pid, sessionId: OTHER_SESSION, kind: 'interactive', cwd: laptop.cwd, status: 'idle', statusUpdatedAt: Date.now() }))
  await hookOn(laptop.socket, 'started', laptop.cwd, OTHER_SESSION)
  await postTo(laptop.socket, '/organize', { changes: [{ op: 'parentSession', session: OTHER_SESSION, parent: SESSION }] })

  const deleted = await postTo(laptop.socket, '/agents/delete', { session: SESSION })
  const listed = ((await (await fetch('http://localhost/agents', { unix: laptop.socket })).json()) as { agents: { id: string; deleted: boolean }[] }).agents.filter(({ id }) => id === SESSION || id === OTHER_SESSION)

  expect(deleted).toEqual({ status: 200, body: { session: SESSION } })
  expect({ transcript: existsSync(subagentTranscript), stopped: subagent.signalCode }).toEqual({ transcript: false, stopped: 'SIGTERM' })
  expect(listed.map(({ id, deleted }) => ({ id, deleted })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: SESSION, deleted: true }, { id: OTHER_SESSION, deleted: true }])
}, 60_000)
