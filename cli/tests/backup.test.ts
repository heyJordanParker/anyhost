import { expect, onTestFinished, setSystemTime, test } from 'bun:test'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { decompress, hotKey, journalOf, openCapture, openDatabase, uploadSessions } from '../src/capture.ts'
import { failTest, memoryRelay, noCode, until, welcomed } from './memory.ts'
import { CLI, decoder, HOST, hookOn, isUploaded, isWatcherProblem, LAPTOP, machineFor, OTHER_SESSION, PASS_MS, problemsOn, ranAnHourAgo, roots, serveOn, SESSION, spawnForTest } from './program.ts'

test("a session whose first capture is over 1 MiB uploads in a job, and its working folder's code goes up after it with no later change", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const home = laptop.env['HOME'] ?? ''
  const cwd = join(home, 'work')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'notes.txt'), 'the plan for the trip\n')
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the machine connecting')
  const transcript = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  const progress = Array.from({ length: 2000 }, (_, at) => `{"type":"progress","cwd":"${cwd}","sessionId":"${SESSION}","line":${at},"text":"${'x'.repeat(1100)}"}\n`).join('')
  writeFileSync(transcript, `{"type":"user","cwd":"${cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"Plan the trip"}}\n${progress}`)
  await hookOn(laptop.socket, 'started', cwd)
  const paths = async (): Promise<string[]> => {
    const found: string[] = []
    for (const key of await relay.keys(`journals/${SESSION}/hot/`)) {
      const body = await decompress((await relay.read(key)) ?? new Uint8Array())
      for (let at = 0; at < body.length; ) {
        const newline = body.indexOf(10, at)
        const header = JSON.parse(decoder.decode(body.subarray(at, newline))) as { path: string; size: number }
        found.push(header.path)
        at = newline + 1 + header.size
      }
    }
    return found
  }

  await until(async () => (await paths()).includes(transcript), 'the transcript going up', 30_000)
  expect(Buffer.byteLength(progress)).toBeGreaterThan(2 * 2 ** 20)
  await until(async () => (await paths()).includes(`${cwd}/`), "the working folder's code going up", 30_000)
}, 60_000)

test('a job whose service stopped reading ends quietly as it reports, as its report has no reader', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  const job = { login: { url: relay.url, token: host.token }, dataFolders: [], isEveryWrite: false, upload: { session: SESSION, tool: 'claude', paths: [] } }
  const child = spawnForTest([process.execPath, CLI, 'work'], { env: host.env, stdin: new Blob([JSON.stringify(job)]), stdout: 'pipe', stderr: 'pipe' })
  await child.stdout.cancel()

  expect(await Promise.race([child.exited.then(() => 'ended'), Bun.sleep(10_000).then(() => 'running')])).toBe('ended')
  expect(await new Response(child.stderr).text()).not.toContain('EPIPE')
})

test("the program's start stats every captured file, and uploads a line a quiet session gained while the program did not run", async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  const home = host.env['HOME'] ?? ''
  const transcript = join(home, '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  const line = (text: string): string => `{"type":"user","message":{"role":"user","content":"${text}"},"sessionId":"${SESSION}"}\n`
  writeFileSync(transcript, line('Plan the trip'))
  const db = openDatabase(join(host.env['XDG_STATE_HOME'] ?? '', 'anyhost'))
  const capture = openCapture(relay.connect(HOST, roots(home)), HOST, roots(home), { db, code: noCode })
  await welcomed(capture.relay)
  setSystemTime(new Date(Date.now() - 60 * 60_000))
  await Promise.all(uploadSessions(capture, [{ session: SESSION, tool: 'claude', paths: new Set([transcript]) }], failTest).map(([, left]) => left))
  setSystemTime()
  const end = journalOf(db, SESSION)?.end ?? 0
  capture.relay.close()
  db.close()
  appendFileSync(transcript, line('Book the train'))

  await serveOn(host.env)
  await until(() => relay.puts.some(({ key }) => key === hotKey(SESSION, end)), 'the line uploaded')
  const frame = relay.puts.find(({ key }) => key === hotKey(SESSION, end))?.body ?? new Uint8Array()
  expect(decoder.decode(await decompress(frame))).toEndWith(line('Book the train'))
}, 20_000)

test('a watched folder the watcher cannot watch at its start, as one removed after the program found it, costs only that folder: the watcher gets ready and hears a new session, and the next backup pass lists that folder and uploads a session written there', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  const sessionEnv = join(host.env['HOME'] ?? '', '.claude', 'session-env')
  mkdirSync(sessionEnv)
  chmodSync(sessionEnv, 0)
  try {
    const served = await serveOn({ ...host.env, ANYHOST_BACKUP_MS: PASS_MS })
    await until(() => served.logged().includes(`anyhost hears no change in a folder under ${sessionEnv}`), 'the watch failing')
    const transcript = join(host.env['HOME'] ?? '', '.claude', 'projects', '-work', `${SESSION}.jsonl`)
    mkdirSync(dirname(transcript), { recursive: true })
    writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
    await until(() => isUploaded(relay, SESSION, 'Plan the trip'), 'the new session uploaded', 30_000)
    expect((await problemsOn(host.socket)).filter(isWatcherProblem)).toEqual([])
  } finally {
    chmodSync(sessionEnv, 0o755)
  }
  const hook = join(sessionEnv, SESSION, 'sessionstart-hook-0.sh')
  mkdirSync(dirname(hook))
  writeFileSync(hook, 'export TRIP=train\n')
  await until(() => isUploaded(relay, SESSION, 'export TRIP=train'), 'the file in the lost folder uploaded', 75_000)
}, 120_000)

test('a file written in a watched folder while the watcher hears nothing is uploaded by the next full sweep', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  const cmod = join(host.env['XDG_DATA_HOME'] ?? '', 'cmod', 'programs', 'cmod')
  const release = join(host.folder, 'release')
  writeFileSync(cmod, readFileSync(cmod, 'utf8').replace('"options anyhost")', `"options anyhost") while [ ! -e '${release}' ]; do sleep 0.1; done;`))
  ranAnHourAgo(host)
  await serveOn({ ...host.env, ANYHOST_WATCHER_DROPS: '1' })
  await Bun.sleep(3000)
  expect((await problemsOn(host.socket)).filter(isWatcherProblem)).toEqual([])
  const transcript = join(host.env['HOME'] ?? '', '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
  await Bun.sleep(1000)
  writeFileSync(release, '')
  await until(() => isUploaded(relay, SESSION, 'Plan the trip'), 'the session the full sweep found uploaded', 30_000)
}, 60_000)

test('a listing of the watched folders and of a session\'s files follows no symlink, so a cycle leaves the other files listed, and the log names a folder it cannot read once', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  const home = host.env['HOME'] ?? ''
  const sessionFolder = join(realpathSync(host.env['CLAUDE_CODE_TMPDIR'] ?? ''), `claude-${process.getuid?.() ?? 0}`, '-work', SESSION)
  mkdirSync(join(sessionFolder, 'tasks'), { recursive: true })
  mkdirSync(join(sessionFolder, 'scratchpad'), { recursive: true })
  symlinkSync('loop', join(sessionFolder, 'scratchpad', 'loop'))
  const locked = join(sessionFolder, 'locked')
  mkdirSync(locked)
  chmodSync(locked, 0)
  onTestFinished(() => chmodSync(locked, 0o755))
  const subagents = join(home, '.claude', 'projects', '-work', SESSION, 'subagents')
  mkdirSync(subagents, { recursive: true })
  symlinkSync('loop', join(subagents, 'loop'))
  const subagent = join(subagents, 'agent-a1.jsonl')
  writeFileSync(subagent, `{"type":"user","message":{"role":"user","content":"Find the trains"},"sessionId":"${SESSION}"}\n`)
  const transcript = join(home, '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000)
  utimesSync(subagent, twoHoursAgo, twoHoursAgo)
  utimesSync(transcript, twoHoursAgo, twoHoursAgo)
  mkdirSync(join(home, '.codex'), { recursive: true })
  ranAnHourAgo(host)
  writeFileSync(join(sessionFolder, 'tasks', 'trip.output'), 'Booked the train\n')
  const served = await serveOn(host.env)
  await until(() => isUploaded(relay, SESSION, 'Booked the train'), 'the output the start listed uploaded', 30_000)
  await until(() => isUploaded(relay, SESSION, 'Find the trains'), "the subagent's transcript the session's first capture found uploaded", 30_000)
  const rollout = join(home, '.codex', 'sessions', '2026', '11', '07', `rollout-2026-11-07T09-00-00-${OTHER_SESSION}.jsonl`)
  mkdirSync(dirname(rollout), { recursive: true })
  writeFileSync(rollout, `{"type":"session_meta","payload":{"id":"${OTHER_SESSION}","cwd":"/work"}}\n`)
  await until(() => isUploaded(relay, OTHER_SESSION, 'session_meta'), 'the rollout in the new folder uploaded', 30_000)

  expect(served.logged().split('\n').filter((logged) => logged.includes(`anyhost lists no file in ${locked}: EACCES`))).toHaveLength(1)
}, 60_000)
