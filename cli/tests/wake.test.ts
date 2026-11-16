import { expect, test } from 'bun:test'
import { appendFileSync } from 'node:fs'
import { LIVE_MS, PING_MS } from '../../relay/protocol.ts'
import { memoryRelay, until, welcomed } from './memory.ts'
import { claimOn, DESKTOP, LAPTOP, listedConnected, roots, runningOn, SESSION } from './program.ts'

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
