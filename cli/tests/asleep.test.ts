import { expect } from 'bun:test'
import { test } from './test.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openCapture, openDatabase } from '../src/capture.ts'
import { memoryRelay, noCode, statusOn, until, welcomed } from './memory.ts'
import { claimOn, DESKTOP, LAPTOP, listedConnected, roots, runningOn, SESSION, temporaryFolder } from './program.ts'
import { LIVE_MS } from './times.ts'

test('a laptop gone silent with a drain in flight while the desktop takes its session refuses that session\'s next prompt once it connects again, and the Pool stores no frame of it after the take', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await welcomed(desktop)
  await until(() => relay.puts.some(({ key }) => key === `sessions/${LAPTOP.id}/index.json`), 'the laptop putting its index')
  await Bun.sleep(1000)
  const wake = relay.silence(LAPTOP.id)
  writeFileSync(laptop.transcript,`{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`, { flag: 'a' })
  for (const started = Date.now(); (await listedConnected(desktop, LAPTOP.id)) !== false; await Bun.sleep(250)) {
    if (Date.now() - started > LIVE_MS + 15_000) throw new Error(`The relay still lists ${LAPTOP.name} connected ${LIVE_MS + 15_000} ms after it went silent.`)
  }

  const [taken] = await Promise.all(desktop.run([{ op: 'claim', session: SESSION, take: true }]))
  expect(taken).toEqual({ status: 200, previous: { id: LAPTOP.id, name: LAPTOP.name }, told: false })
  const stored = relay.puts.length
  wake()
  await until(async () => (await statusOn(laptop.socket)).relay.state === 'connected', 'the laptop connecting again', 70_000)

  expect((await claimOn(laptop.socket)).machine).toBe(DESKTOP.name)
  await Bun.sleep(3000)
  expect(relay.puts.slice(stored).filter(({ key }) => key.startsWith(`journals/${SESSION}/`))).toEqual([])
}, 180_000)

test('a take of a session whose holder went silent moments after the Pool last heard it answers told true, as the Pool counts that holder live, and the holder reads the new holder as it wakes', async () => {
  const relay = await memoryRelay()
  const home = join(temporaryFolder(), 'home')
  const laptop = openCapture(relay.connect(LAPTOP, roots(home)), LAPTOP, roots(home), { db: openDatabase(join(temporaryFolder(), 'state')), code: noCode })
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await Promise.all([welcomed(laptop.relay), welcomed(desktop)])
  expect(await laptop.relay.runOne({ op: 'claim', session: SESSION, take: false })).toEqual({ status: 200, told: true })
  const wake = relay.silence(LAPTOP.id)
  expect(await listedConnected(desktop, LAPTOP.id)).toBe(true)

  expect(await desktop.runOne({ op: 'claim', session: SESSION, take: true })).toEqual({ status: 200, told: true })
  wake()
  await until(() => laptop.holders.known().get(SESSION) === DESKTOP.id, 'the laptop reading the new holder')
}, 30_000)
