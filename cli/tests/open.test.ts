import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryRelay, until } from './memory.ts'
import { anyhostOn, copiesOn, LAPTOP, machineFor, postTo, roots, runnerOn, runningOn, runsOn, serveOn, SESSION, trustedIn, WORKER, workerOn } from './program.ts'

test("an open of a session whose live Claude Code is not its run's own, as the Herdr pane's Move it here asks, leaves exactly one copy: the one in the new terminal", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const runner = runnerOn(laptop, 'opened-before', '0.6.0')
  mkdirSync(join(laptop.folder, 'terminals'), { recursive: true })
  writeFileSync(join(laptop.folder, 'terminals', 'opened-before'), `${SESSION} ${runner.pid}\n`)

  const opened = await postTo(laptop.socket, '/agents/open', { session: SESSION })

  expect(opened.status).toBe(200)
  expect(opened.body['terminal']).not.toBe('opened-before')
  expect([laptop.claude.signalCode, runner.signalCode === null]).toEqual(['SIGTERM', false])
  expect(copiesOn(laptop.folder).filter(({ isRunning }) => isRunning)).toHaveLength(1)
}, 60_000)

test("a runner placing its own session stops the copy that runs outside it, keeps itself, opens no terminal, and answers the folder to continue in", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const runner = runnerOn(laptop, 't9', '')

  const placed = await postTo(laptop.socket, '/agents/place', { session: SESSION.slice(0, 8), take: false })

  expect(placed.status).toBe(200)
  expect(placed.body).toEqual({ session: SESSION, cwd: expect.any(String) })
  expect([laptop.claude.signalCode, runner.signalCode]).toEqual(['SIGTERM', null])
  expect(existsSync(join(laptop.folder, 'hc.log'))).toBe(false)
}, 60_000)

test("a session placed to continue in the folder it last ran in has that folder trusted in Claude Code, so a resume never asks whether to trust it", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)

  const placed = await postTo(laptop.socket, '/agents/place', { session: SESSION.slice(0, 8), take: false })

  expect(placed.body).toEqual({ session: SESSION, cwd: laptop.cwd })
  expect(trustedIn(laptop)).toEqual([realpathSync(laptop.cwd)])
}, 60_000)

test('a session working in another terminal, as in tmux, moves into one terminal of herdr-core only once its turn and its background commands ended, however many opens ask for it meanwhile', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  laptop.status('busy')

  const opens = [postTo(laptop.socket, '/agents/open', { session: SESSION }), postTo(laptop.socket, '/agents/open', { session: SESSION.slice(0, 8) })]
  await Bun.sleep(1500)
  const whileWorking = { stopped: laptop.claude.signalCode, terminals: runsOn(laptop.folder).length }
  laptop.status('shell')
  await Bun.sleep(1500)
  const whileItsCommandRuns = { stopped: laptop.claude.signalCode, terminals: runsOn(laptop.folder).length }
  laptop.status('idle')
  const [first, second] = await Promise.all(opens)

  expect(whileWorking).toEqual({ stopped: null, terminals: 0 })
  expect(whileItsCommandRuns).toEqual({ stopped: null, terminals: 0 })
  expect([first?.status, second?.status]).toEqual([200, 200])
  expect(second?.body['terminal']).toBe(first?.body['terminal'])
  expect(laptop.claude.signalCode).toBe('SIGTERM')
  expect(runsOn(laptop.folder).map(({ session }) => session)).toEqual([SESSION])
}, 60_000)

test("an open of a session whose transcript is on this machine resumes it in the folder it last worked in, with no row of it in anyhost.db and nothing of it in R2", async () => {
  const relay = await memoryRelay()
  const worker = await machineFor(relay, WORKER, { uploadEvery: 3600 })
  await serveOn(worker.env)
  await until(() => relay.isConnected(WORKER.id), 'the machine connecting')
  const cwd = join(worker.env['HOME'] ?? '', 'plans')
  mkdirSync(cwd, { recursive: true })
  const transcript = join(worker.env['HOME'] ?? '', '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`)
  mkdirSync(join(transcript, '..'), { recursive: true })
  writeFileSync(transcript, `{"type":"user","cwd":"${cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"Plan the trip"}}\n`)

  const opened = await postTo(worker.socket, '/agents/open', { session: SESSION })

  expect(opened.status).toBe(200)
  expect(runsOn(worker.folder).map(({ cwd: folder, session }) => ({ folder, session }))).toEqual([{ folder: cwd, session: SESSION }])
  expect(await relay.keys(`journals/${SESSION}/`)).toEqual([])
}, 60_000)

test('each worktree of a repository opens its sessions in a Herdr space of its own, keyed by its root folder, while sessions outside git and in a temporary folder keep their one space each', async () => {
  const relay = await memoryRelay()
  const worker = await machineFor(relay, WORKER, { uploadEvery: 3600 })
  await serveOn(worker.env)
  await until(() => relay.isConnected(WORKER.id), 'the machine connecting')
  const home = worker.env['HOME'] ?? ''
  const main = join(home, 'app')
  const fix = join(home, 'app-fix')
  const git = (...args: string[]): void => void Bun.spawnSync(['git', '-c', 'user.name=Me', '-c', 'user.email=me@example.com', ...args], { stdout: 'ignore', stderr: 'ignore' })
  mkdirSync(join(main, 'src'), { recursive: true })
  git('-C', main, 'init', '--initial-branch', 'main')
  git('-C', main, 'remote', 'add', 'origin', 'git@github.com:me/app.git')
  git('-C', main, 'commit', '--allow-empty', '-m', 'Start')
  git('-C', main, 'worktree', 'add', '-b', 'fix', fix)
  const sessions = [
    { id: '11111111-1111-4111-8111-111111111111', cwd: join(main, 'src') },
    { id: '22222222-2222-4222-8222-222222222222', cwd: main },
    { id: '33333333-3333-4333-8333-333333333333', cwd: fix },
    { id: '44444444-4444-4444-8444-444444444444', cwd: join(home, 'notes') },
    { id: '55555555-5555-4555-8555-555555555555', cwd: join(worker.folder, 'tmp', 'scratch') },
  ]
  for (const { id, cwd } of sessions) {
    mkdirSync(cwd, { recursive: true })
    const transcript = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)
    mkdirSync(join(transcript, '..'), { recursive: true })
    writeFileSync(transcript, `{"type":"user","cwd":"${cwd}","sessionId":"${id}","message":{"role":"user","content":"Plan the trip"}}\n`)
  }

  for (const { id } of sessions) expect((await postTo(worker.socket, '/agents/open', { session: id })).status).toBe(200)

  const spaceOf = new Map(readFileSync(join(worker.folder, 'spaces.log'), 'utf8').trim().split('\n').map((line) => line.split(' ') as [string, string]))
  const keyOf = (checkout: string): string => `anyhost-w-${new Bun.CryptoHasher('sha256').update(checkout).digest('hex').slice(0, 12)}`
  expect(sessions.map(({ id }) => spaceOf.get(id))).toEqual([keyOf(main), keyOf(main), keyOf(fix), 'anyhost-none', 'anyhost-temporary'])
}, 60_000)

test('an open continues a session here from R2 while the machine that ran it is gone, and answers its terminal', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  laptop.child.kill('SIGKILL')
  await until(() => !relay.isConnected(LAPTOP.id), 'the laptop going away', 60_000)

  const opened = await postTo(worker.socket, '/agents/open', { session: SESSION.slice(0, 8) })
  const again = await postTo(worker.socket, '/agents/open', { session: SESSION.slice(0, 8) })

  expect(opened.status).toBe(200)
  expect([opened.body['session'], opened.body['machine'], typeof opened.body['terminal']]).toEqual([SESSION, WORKER.name, 'string'])
  expect(again.body).toEqual(opened.body)
  expect(runsOn(worker.folder).map(({ session, command }) => ({ session, command }))).toEqual([{ session: SESSION, command: 'claude' }])
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
}, 90_000)

test('an open of a session a connected machine runs, as a click on a list read before that machine connected again asks, takes nothing and leaves its copy running there', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)

  const opened = await postTo(worker.socket, '/agents/open', { session: SESSION.slice(0, 8) })

  expect(opened.status).toBe(400)
  expect(opened.body['message']).toBe(`${LAPTOP.name} runs ${SESSION.slice(0, 8)} and is connected, so ${SESSION.slice(0, 8)} opens there and not on ${WORKER.name}.`)
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect(runsOn(worker.folder)).toEqual([])
  expect(laptop.claude.exitCode).toBeNull()
}, 60_000)

test("anyhost open with a session's first 8 characters continues a session another machine's index lists and no machine claims, as the one-time import leaves one", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  laptop.child.kill('SIGKILL')
  await relay.connect(LAPTOP, roots(laptop.env['HOME'] ?? '')).runOne({ op: 'forget', session: SESSION })
  const worker = await workerOn(relay)
  const claimedBefore = (await relay.claims()).has(SESSION)

  const opened = await anyhostOn(worker.env, ['open', SESSION.slice(0, 8)])

  expect(claimedBefore).toBe(false)
  expect(opened).toMatchObject({ code: 0, err: '' })
  expect(opened.out).toStartWith(`${SESSION.slice(0, 8)} runs on ${WORKER.name} in terminal `)
  expect(runsOn(worker.folder).map(({ session }) => session)).toEqual([SESSION])
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
}, 90_000)

test("a short id two listed sessions' ids begin with names neither, and asks for more of the id", async () => {
  const relay = await memoryRelay()
  const listed = (id: string): object => ({ id, tool: 'claude', title: '', firstPrompt: 'Plan the trip', cwd: '/home/laptop/work', repo: '', repoFolder: '', entrypoint: 'cli', lastActivity: '2026-11-15T09:00:00.000Z', size: 120, deleted: false })
  const index = [listed('abcd1234-0000-4000-8000-000000000001'), listed('abcd1234-0000-4000-8000-000000000002')]
  await relay.connect(LAPTOP, roots('/home/laptop')).runOne({ op: 'put', key: `sessions/${LAPTOP.id}/index.json`, bytes: new TextEncoder().encode(JSON.stringify(index)) })
  const worker = await workerOn(relay)

  const opened = await anyhostOn(worker.env, ['open', 'abcd'])

  expect(opened.code).toBe(1)
  expect(opened.err).toContain("2 sessions' ids begin with abcd. Give more of it.")
  expect(runsOn(worker.folder)).toEqual([])
}, 60_000)

test("a session this machine holds wakes here while the relay answers nothing, as after a reboot before it connects", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  relay.stalled = true

  const placed = await Promise.race([postTo(laptop.socket, '/agents/place', { session: SESSION }), Bun.sleep(8000).then(() => 'still waiting')])

  expect(placed).toEqual({ status: 200, body: { session: SESSION, cwd: laptop.cwd } })
}, 60_000)
