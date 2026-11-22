import { expect } from 'bun:test'
import { test } from './test.ts'
import { appendFileSync } from 'node:fs'
import { memoryRelay, until, welcomed } from './memory.ts'
import { claimOn, DESKTOP, LAPTOP, listedConnected, roots, runningOn, SESSION } from './program.ts'
import { LIVE_MS, PING_MS } from './times.ts'

test('a program whose socket outlives a sleep past LIVE_MS while another machine takes its session has that socket closed by the relay, connects again, reads the new holder and stores no frame of the session', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await welcomed(desktop)
  await until(() => relay.puts.some(({ key }) => key === `sessions/${LAPTOP.id}/index.json`), 'the laptop putting its index')
  await Bun.sleep(1000)
  let stored = 0
  process.kill(laptop.child.pid, 'SIGSTOP')
  try {
    for (const started = Date.now(); (await listedConnected(desktop, LAPTOP.id)) !== false; await Bun.sleep(250)) {
      if (Date.now() - started > PING_MS + LIVE_MS + 5000) throw new Error(`The relay still lists ${LAPTOP.name} connected ${PING_MS + LIVE_MS + 5000} ms after it slept.`)
    }
    expect(await desktop.runOne({ op: 'claim', session: SESSION, take: true })).toEqual({ status: 200, previous: { id: LAPTOP.id, name: LAPTOP.name }, told: false })
    stored = relay.puts.length
    appendFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`)
  } finally {
    process.kill(laptop.child.pid, 'SIGCONT')
  }
  await until(async () => (await claimOn(laptop.socket)).machine === DESKTOP.name, 'the laptop reading the new holder', 70_000)

  expect(laptop.logged()).toContain(`closed the connection with 1000: The relay heard nothing on this socket for ${LIVE_MS / 1000} seconds`)
  await Bun.sleep(7000)
  expect(relay.puts.slice(stored).filter(({ key }) => key.startsWith(`journals/${SESSION}/`))).toEqual([])
}, 180_000)
