import { expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { memoryRelay, temporaryFolder, until } from './memory.ts'
import { CLI, configOf, killAfterTest, LAPTOP, machineFor, postTo, runningOn, serveOn, SESSION, startedOn, stepsOf, tripOn, trust, trustedIn, WORKER, workerOn } from './program.ts'

test('a move carries the trust of the session\'s folder: the worker trusts the folder it continues in, keeping the rest of its config and its config\'s symlink', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  trust(laptop, laptop.env['HOME'] ?? '')
  const kept = { numStartups: 3, projects: { '/elsewhere': { allowedTools: [], hasTrustDialogAccepted: true } } }
  const dotfile = join(temporaryFolder(), 'dotfiles', 'claude.json')
  mkdirSync(dirname(dotfile), { recursive: true })
  writeFileSync(dotfile, JSON.stringify(kept))
  symlinkSync(dotfile, configOf(worker))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  const workerCwd = realpathSync(join(worker.env['HOME'] ?? '', 'work'))
  expect(JSON.parse(readFileSync(dotfile, 'utf8'))).toEqual({ ...kept, projects: { ...kept.projects, [workerCwd]: { hasTrustDialogAccepted: true } } })
  expect(readlinkSync(configOf(worker))).toBe(dotfile)
  expect(readdirSync(dirname(dotfile))).toEqual(['claude.json'])
  expect(existsSync(`${configOf(worker)}.lock`)).toBe(false)
}, 60_000)

test('a worker whose Claude Code config it cannot read fails the move with the reason, and the config stays as it was', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  trust(laptop, laptop.env['HOME'] ?? '')
  const config = JSON.stringify({ numStartups: 3, oauthAccount: { emailAddress: 'ada@example.com' } })
  writeFileSync(configOf(worker), config)
  chmodSync(configOf(worker), 0o000)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)
  chmodSync(configOf(worker), 0o600)

  expect(last.step).toBe('failed')
  expect(last.line).toStartWith(`${WORKER.name} could not take the session: EACCES`)
  expect(last.line).toEndWith('. It keeps running here.')
  expect(readFileSync(configOf(worker), 'utf8')).toBe(config)
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
}, 60_000)

test("a laptop whose Claude Code config it cannot read fails the move with the reason before it asks the worker", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  trust(laptop, laptop.env['HOME'] ?? '')
  chmodSync(configOf(laptop), 0o000)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)
  chmodSync(configOf(laptop), 0o600)

  expect(last.line).toStartWith(`anyhost could not move the session to ${WORKER.name}: EACCES`)
  expect(last.line).toEndWith('. It keeps running here.')
  expect(worker.logged()).not.toContain(`${LAPTOP.name} moves ${SESSION} here.`)
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
}, 60_000)

test('a worker whose Claude Code config is a symlink to a missing file trusts the folder in that file, and the config stays a symlink', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  trust(laptop, laptop.env['HOME'] ?? '')
  const dotfile = join(temporaryFolder(), 'dotfiles', 'claude.json')
  mkdirSync(dirname(dotfile), { recursive: true })
  symlinkSync(dotfile, configOf(worker))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  expect(lstatSync(configOf(worker)).isSymbolicLink()).toBe(true)
  expect(readlinkSync(configOf(worker))).toBe(dotfile)
  const workerCwd = realpathSync(join(worker.env['HOME'] ?? '', 'work'))
  expect(JSON.parse(readFileSync(dotfile, 'utf8'))).toEqual({ projects: { [workerCwd]: { hasTrustDialogAccepted: true } } })
}, 60_000)

test("a worker whose Claude Code config's lock is a file left behind fails the move with the reason within 5 s, and the file stays", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  trust(laptop, laptop.env['HOME'] ?? '')
  const lock = `${configOf(worker)}.lock`
  writeFileSync(lock, '')
  const leftAt = new Date(Date.now() - 60_000)
  utimesSync(lock, leftAt, leftAt)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { steps } = await stepsOf(laptop.socket, new Set(['moving', 'failed']))
  const askedAt = Date.now()
  const { last } = await stepsOf(laptop.socket, undefined, steps)

  expect(Date.now() - askedAt).toBeLessThan(5000)
  expect(last.step).toBe('failed')
  expect(last.line).toStartWith(`${WORKER.name} could not take the session: ${lock} is left behind, unchanged for 10 s, and anyhost could not remove it, so it could not trust the folder: ENOTDIR`)
  expect(last.line).toEndWith('. It keeps running here.')
  expect(lstatSync(lock).isFile()).toBe(true)
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
}, 60_000)

test('anyhost new trusts nothing on the worker when the laptop trusts only a folder above the checkout, which Claude Code never counts', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)
  trust(laptop, laptop.env['HOME'] ?? '')

  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  killAfterTest(started)
  await until(async () => (await relay.claims()).get(startedOn(worker)) === WORKER.id, 'the session starting on the worker', 30_000)

  expect(trustedIn(worker)).toEqual([])
}, 60_000)

