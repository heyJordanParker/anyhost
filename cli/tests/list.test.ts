import { expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { statusOf } from '../src/claude.ts'
import { memoryRelay, until } from './memory.ts'
import { anyhostOn, isUploaded, LAPTOP, machineFor, postTo, runningOn, serveOn, SESSION, spawnForTest, temporaryFolder, WORKER, workerOn } from './program.ts'

test('a session whose record says busy after its turn ended, as while its background agents run, reads working from /agents and from statusOf', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const claudeHome = laptop.env['CLAUDE_CONFIG_DIR'] ?? ''
  writeFileSync(join(claudeHome, 'sessions', `${laptop.claude.pid}.json`), JSON.stringify({ pid: laptop.claude.pid, sessionId: SESSION, kind: 'interactive', cwd: laptop.cwd, status: 'busy', statusUpdatedAt: Date.now() - 60_000 }))
  const statusOfSession = async (): Promise<string | undefined> =>
    ((await (await fetch('http://localhost/agents', { unix: laptop.socket })).json()) as { agents: { id: string; status: string }[] }).agents.find(({ id }) => id === SESSION)?.status
  await until(async () => (await statusOfSession()) !== undefined, 'the session listed')

  await postTo(laptop.socket, '/sessions/changed', { session: SESSION, folder: laptop.cwd })

  expect(await statusOfSession()).toBe('working')
  expect(await statusOf(claudeHome, SESSION)).toBe('working')
}, 60_000)

test('a record that says shell, as while a background command or Monitor runs after the turn, reads working, and one Claude Code handed to the background reads idle', async () => {
  const claudeHome = join(temporaryFolder(), '.claude')
  mkdirSync(join(claudeHome, 'sessions'), { recursive: true })
  const recorded = (session: string, record: Record<string, unknown>): void => {
    const copy = spawnForTest(['sleep', '600'])
    writeFileSync(join(claudeHome, 'sessions', `${copy.pid}.json`), JSON.stringify({ pid: copy.pid, sessionId: session, kind: 'interactive', cwd: '/', ...record }))
  }
  const handedOff = 'b0000000-0000-4000-8000-000000000000'
  recorded(SESSION, { status: 'shell', statusUpdatedAt: Date.now() })
  recorded(handedOff, { status: 'busy', statusUpdatedAt: Date.now(), parkedJobId: 'a1b2c3d4' })

  expect([await statusOf(claudeHome, SESSION), await statusOf(claudeHome, handedOff)]).toEqual(['working', 'idle'])
})

test("one anyhost list carries this machine, every machine, and the status another machine reports for its session, so the sidebar reads all three in one call", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  laptop.status('busy')

  const listed = await anyhostOn(worker.env, ['list', '--json', '--brief'])
  const { here, machines, agents } = JSON.parse(listed.out) as { here: string; machines: { id: string; connected: boolean; herdr: string | null }[]; agents: { id: string; status: string }[] }

  expect(here).toBe(WORKER.id)
  expect(machines.map(({ id, connected, herdr }) => ({ id, connected, herdr })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([LAPTOP, WORKER].map(({ id }) => ({ id, connected: true, herdr: null })).sort((a, b) => a.id.localeCompare(b.id)))
  expect(agents.find(({ id }) => id === SESSION)?.status).toBe('working')
}, 60_000)

test("a change Claude Code reports, a new session, a /rename and a /cd alike, reaches a list read that waits for it at once, long before the next upload", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP, { uploadEvery: 3600 })
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const home = laptop.env['HOME'] ?? ''
  const cwd = join(home, 'work')
  const moved = join(home, 'elsewhere')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(moved, { recursive: true })
  const transcript = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","cwd":"${cwd}","sessionId":"${SESSION}","timestamp":"2026-11-14T10:00:00.000Z","message":{"role":"user","content":"Plan the trip"}}\n`)
  type Listed = { readonly version: string; readonly agents: readonly { readonly id: string; readonly title: string; readonly cwd: string }[] }
  const listed = async (after?: string): Promise<Listed> => (await (await fetch(`http://localhost/agents${after === undefined ? '' : `?after=${after}`}`, { unix: laptop.socket })).json()) as Listed
  const session = async (): Promise<Listed['agents'][number] | undefined> => (await listed()).agents.find(({ id }) => id === SESSION)

  const before = await listed()
  expect(before.agents.map(({ id }) => id)).toEqual([])
  const waiting = listed(before.version)
  expect(await Promise.race([waiting.then(() => 'answered'), Bun.sleep(500).then(() => 'waiting')])).toBe('waiting')

  await postTo(laptop.socket, '/sessions/changed', { session: SESSION, folder: cwd })
  expect((await waiting).version).not.toBe(before.version)
  await until(async () => (await session())?.title === 'Plan the trip', 'the new session listed', 3000)

  appendFileSync(transcript, `{"type":"custom-title","customTitle":"Trip to Lisbon","sessionId":"${SESSION}"}\n`)
  await postTo(laptop.socket, '/sessions/changed', { session: SESSION, folder: cwd })
  await until(() => isUploaded(relay, SESSION, 'Trip to Lisbon'), 'the rename uploaded', 3000)
  await until(async () => (await session())?.title === 'Trip to Lisbon', 'the rename listed', 3000)

  await postTo(laptop.socket, '/sessions/changed', { session: SESSION, folder: moved })
  expect((await session())?.cwd).toBe(moved)
}, 60_000)

test('a list read reads the machines no second time, so it costs the relay one round trip of reads', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP, { uploadEvery: 3600 })
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const agents = async (): Promise<void> => void (await (await fetch('http://localhost/agents', { unix: laptop.socket })).text())
  await agents()
  const asked: string[] = []
  relay.before = (op) => {
    asked.push(op.op)
    return undefined
  }

  await agents()

  expect(asked.filter((op) => op === 'devices')).toEqual([])
}, 60_000)

test('a list read that waits with the version of a program since restarted answers at once, so the sidebar follows the new program without waiting out each read', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP, { uploadEvery: 3600 })
  const first = await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const versionOf = async (after?: string): Promise<string> => ((await (await fetch(`http://localhost/agents${after === undefined ? '' : `?after=${encodeURIComponent(after)}`}`, { unix: laptop.socket })).json()) as { version: string }).version
  for (let n = 0; n < 3; n += 1) await postTo(laptop.socket, '/sessions/changed', { session: SESSION, folder: laptop.env['HOME'] ?? '' })
  const before = await versionOf()

  first.child.kill('SIGKILL')
  await first.child.exited
  await serveOn(laptop.env)
  const started = Date.now()
  await versionOf(before)

  expect(Date.now() - started).toBeLessThan(5000)
}, 60_000)
