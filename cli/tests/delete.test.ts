import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { memoryRelay } from './memory.ts'
import { postTo, runningOn, SESSION } from './program.ts'

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
