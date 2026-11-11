import { expect, test } from 'bun:test'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isAlive } from '../src/claude.ts'
import { memoryRelay, until } from './memory.ts'
import { HOST, isUploaded, isWatcherProblem, machineFor, OTHER_SESSION, problemsOn, ranAnHourAgo, serveOn, SESSION } from './program.ts'

test("a program whose watcher hangs at its start names the stall in /status, backs up a captured session's line and a new session within one backup pass, and ends at SIGTERM within 5 s", async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  const transcriptOf = (session: string): string => join(host.env['HOME'] ?? '', '.claude', 'projects', '-work', `${session}.jsonl`)
  const line = (session: string, text: string): string => `{"type":"user","message":{"role":"user","content":"${text}"},"sessionId":"${session}"}\n`
  ranAnHourAgo(host)
  mkdirSync(dirname(transcriptOf(SESSION)), { recursive: true })
  writeFileSync(transcriptOf(SESSION), line(SESSION, 'Plan the trip'))

  const served = await serveOn({ ...host.env, ANYHOST_WATCHER_HANGS: '1' })
  await until(async () => (await problemsOn(host.socket)).some((problem) => problem.includes(" watcher: Error: anyhost's watcher heard none of its watches 10 s after its start, as while macOS's fseventsd takes no new watcher")), 'the stall in /status', 30_000)
  await until(() => isUploaded(relay, SESSION, 'Plan the trip'), 'the session the start captured uploaded', 30_000)
  appendFileSync(transcriptOf(SESSION), line(SESSION, 'Book the train'))
  writeFileSync(transcriptOf(OTHER_SESSION), line(OTHER_SESSION, 'Pack the bags'))
  await until(() => isUploaded(relay, SESSION, 'Book the train') && isUploaded(relay, OTHER_SESSION, 'Pack the bags'), 'the line and the new session uploaded', 75_000)

  const watchersOf = (pid: number): number[] => Bun.spawnSync(['pgrep', '-P', String(pid), '-f', 'ANYHOST_WATCHER_HANGS']).stdout.toString().split('\n').filter((found) => found !== '').map(Number)
  await until(() => watchersOf(served.child.pid).length > 0, 'a hung watcher')
  const [watcher = 0] = watchersOf(served.child.pid)
  const signalled = Date.now()
  served.child.kill('SIGTERM')
  await served.child.exited
  expect(Date.now() - signalled).toBeLessThan(5000)
  expect(served.child.signalCode).toBe('SIGTERM')
  await until(() => !isAlive(watcher), 'the hung watcher ending with the program', 5000)
}, 150_000)

test('a watcher that exits is a problem in /status until the one started after it is ready, which hears a new session', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  const transcript = join(host.env['HOME'] ?? '', '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  const probe = join(host.env['XDG_STATE_HOME'] ?? '', 'anyhost', 'watcher')
  const watcherPid = (): number => (existsSync(probe) ? Number(readFileSync(probe, 'utf8')) || 0 : 0)
  const served = await serveOn(host.env)
  await until(() => watcherPid() > 0, 'the watcher')
  const first = watcherPid()
  expect(Bun.spawnSync(['pgrep', '-P', String(served.child.pid)]).stdout.toString().split('\n')).toContain(String(first))

  process.kill(first, 'SIGKILL')
  await until(async () => (await problemsOn(host.socket)).some((problem) => problem.includes(" watcher: Error: anyhost's watcher exited with SIGKILL, so each backup pass lists the watched folders")), 'the exit in /status')
  await until(async () => !(await problemsOn(host.socket)).some((problem) => problem.includes(' watcher: ')), 'the problem leaving')
  expect(watcherPid()).not.toBe(first)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
  await until(() => isUploaded(relay, SESSION, 'Plan the trip'), 'the new session uploaded', 30_000)
}, 60_000)


test('a watched folder removed and made again while the program runs is watched again: a file written in the new one uploads within one backup pass, and /status names no watcher problem', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  const tempRoot = join(realpathSync(host.env['CLAUDE_CODE_TMPDIR'] ?? ''), `claude-${process.getuid?.() ?? 0}`)
  mkdirSync(tempRoot, { recursive: true })
  await serveOn(host.env)
  const transcript = join(host.env['HOME'] ?? '', '.claude', 'projects', '-work', `${OTHER_SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${OTHER_SESSION}"}\n`)
  await until(() => isUploaded(relay, OTHER_SESSION, 'Plan the trip'), 'the session the watcher heard uploaded', 30_000)

  rmSync(tempRoot, { recursive: true })
  await Bun.sleep(1000)
  const output = join(tempRoot, '-work', SESSION, 'tasks', 'trip.output')
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, 'Booked the train\n')
  const watcherProblems = new Set<string>()
  await until(
    async () => {
      for (const problem of (await problemsOn(host.socket)).filter(isWatcherProblem)) watcherProblems.add(problem)
      return isUploaded(relay, SESSION, 'Booked the train')
    },
    'the output in the new folder uploaded',
    75_000,
  )
  expect([...watcherProblems]).toEqual([])
}, 120_000)

test('a watched folder the watcher cannot watch at its start, as one removed after the program found it, costs only that folder, and the watcher gets ready and hears a new session', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  const plans = join(host.env['HOME'] ?? '', '.claude', 'plans')
  mkdirSync(plans)
  chmodSync(plans, 0)
  try {
    await serveOn(host.env)
    await Bun.sleep(3000)
    const transcript = join(host.env['HOME'] ?? '', '.claude', 'projects', '-work', `${SESSION}.jsonl`)
    mkdirSync(dirname(transcript), { recursive: true })
    writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
    await until(() => isUploaded(relay, SESSION, 'Plan the trip'), 'the new session uploaded', 30_000)
    expect((await problemsOn(host.socket)).filter(isWatcherProblem)).toEqual([])
  } finally {
    chmodSync(plans, 0o755)
  }
}, 60_000)
