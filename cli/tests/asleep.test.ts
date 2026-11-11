import { expect, test } from 'bun:test'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LIVE_MS, PING_MS } from '../../relay/protocol.ts'
import { journalOf, openCapture, openDatabase } from '../src/capture.ts'
import { memoryRelay, noCode, statusOn, temporaryFolder, until, welcomed } from './memory.ts'
import { claimOn, DESKTOP, LAPTOP, listedConnected, roots, runningOn, SESSION } from './program.ts'

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
  expect(taken).toEqual({ status: 200, previous: { id: LAPTOP.id, name: LAPTOP.name }, told: false, at: expect.any(String) })
  const stored = relay.puts.length
  wake()
  await until(async () => (await statusOn(laptop.socket)).relay.state === 'connected', 'the laptop connecting again', 70_000)

  expect((await claimOn(laptop.socket)).machine).toBe(DESKTOP.name)
  await Bun.sleep(3000)
  expect(relay.puts.slice(stored).filter(({ key }) => key.startsWith(`journals/${SESSION}/`))).toEqual([])
}, 180_000)

test("a take of a session whose holder went silent 5 s after the Pool last heard it answers told false, and the holder's next welcome carries released, which it confirms", async () => {
  const relay = await memoryRelay()
  const home = join(temporaryFolder(), 'home')
  const laptop = openCapture(relay.connect(LAPTOP, roots(home)), LAPTOP, roots(home), { db: openDatabase(join(temporaryFolder(), 'state')), code: noCode })
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await Promise.all([welcomed(laptop.relay), welcomed(desktop)])
  expect(await laptop.relay.runOne({ op: 'claim', session: SESSION, take: false })).toEqual({ status: 200, told: true, at: expect.any(String) })
  await Bun.sleep(5000)
  const wake = relay.silence(LAPTOP.id)
  expect(await listedConnected(desktop, LAPTOP.id)).toBe(true)

  expect(await desktop.runOne({ op: 'claim', session: SESSION, take: true })).toEqual({ status: 200, previous: { id: LAPTOP.id, name: LAPTOP.name }, told: false, at: expect.any(String) })
  wake()
  await until(() => journalOf(laptop.db, SESSION)?.holder === DESKTOP.name, 'the laptop hearing it lost the session')
  await until(async () => (await relay.waiting()).length === 0, 'the Pool hearing the laptop confirm it')
}, 30_000)

test('a program whose socket outlives a sleep past LIVE_MS while another machine takes its session connects again before it sends anything more, and confirms the released before its next frame', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await welcomed(desktop)
  await until(() => relay.puts.some(({ key }) => key === `sessions/${LAPTOP.id}/index.json`), 'the laptop putting its index')
  await Bun.sleep(1000)
  let asked = 0
  let stored = 0
  const heard = relay.holdNext('heard')
  process.kill(laptop.child.pid, 'SIGSTOP')
  try {
    for (const started = Date.now(); (await listedConnected(desktop, LAPTOP.id)) !== false; await Bun.sleep(250)) {
      if (Date.now() - started > PING_MS + LIVE_MS + 5000) throw new Error(`The relay still lists ${LAPTOP.name} connected ${PING_MS + LIVE_MS + 5000} ms after it slept.`)
    }
    expect(await desktop.runOne({ op: 'claim', session: SESSION, take: true })).toEqual({ status: 200, previous: { id: LAPTOP.id, name: LAPTOP.name }, told: false, at: expect.any(String) })
    asked = relay.requests.length
    stored = relay.puts.length
    appendFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`)
  } finally {
    process.kill(laptop.child.pid, 'SIGCONT')
  }
  const release = await heard

  expect(relay.requests.slice(asked).flat().filter((op) => op.op === 'put' && op.key.startsWith(`journals/${SESSION}/`))).toEqual([])
  expect(laptop.logged()).toContain('seconds ago, as before this machine slept, so it connects again before it sends anything more.')
  release()
  await until(async () => (await relay.waiting()).length === 0, 'the Pool hearing the laptop confirm the released')
  expect((await claimOn(laptop.socket)).machine).toBe(DESKTOP.name)
  await Bun.sleep(7000)
  expect(relay.puts.slice(stored).filter(({ key }) => key.startsWith(`journals/${SESSION}/`))).toEqual([])
}, 180_000)
