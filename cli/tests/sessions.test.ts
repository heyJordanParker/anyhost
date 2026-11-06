import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { journalOf, openCapture, openDatabase, recordSummary, seal, takeUntold, uploadSession, writeIndex, type Capture, type Problems } from '../src/capture.ts'
import { HeldElsewhere, takeClaim } from '../src/claims.ts'
import type { Device, MachineRoots } from '../src/device.ts'
import { restore } from '../src/resume.ts'
import { downloadJournal, listSessions } from '../src/sessions.ts'
import { memoryRelay, noCode, stopRelays, temporaryFolder, type MemoryRelay } from './memory.ts'

afterEach(stopRelays)

const mac: Device = { id: 'device-mac', name: 'mac', os: 'darwin', arch: 'arm64' }
const server: Device = { id: 'device-server', name: 'server', os: 'linux', arch: 'x64' }
const failTest: Problems = {
  set: (_key, error) => {
    throw error
  },
  clear: () => undefined,
}

function machine(device: Device, relay: MemoryRelay, home = join(temporaryFolder(), 'home'), state = join(temporaryFolder(), 'state'), code = noCode) {
  const roots: MachineRoots = { home, claudeHome: join(home, '.claude'), claudeTmp: join(home, 'tmp', 'claude-1000'), codexHome: join(home, '.codex') }
  // the same roots on both machines, where relocate places every byte as its writer wrote it
  return { roots, capture: openCapture(relay.connect(device, roots), device, roots, openDatabase(state), code) }
}

async function captured(relay: MemoryRelay, device: Device, session: string, prompt: string, cwd = '/work'): Promise<Capture> {
  const { roots, capture } = machine(device, relay)
  const transcript = join(roots.home, '.claude', 'projects', '-work', `${session}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":${JSON.stringify(prompt)}},"cwd":"${cwd}","sessionId":"${session}"}\n`)
  await uploadSession(capture, session, 'claude', new Set([transcript]), failTest)
  await writeIndex(capture)
  return capture
}

// waits for what the relay tells a machine, which comes on its own socket
async function until(isTrue: () => boolean): Promise<void> {
  for (const started = Date.now(); !isTrue(); await Bun.sleep(2)) if (Date.now() - started > 5000) throw new Error('The relay told the machine nothing within 5 s.')
}

test('the index lists sessions of two devices, each held by the machine that holds it', async () => {
  const relay = memoryRelay()
  await captured(relay, mac, 'aaaaaaaa-0000-0000-0000-000000000001', 'Plan the release')
  const onServer = await captured(relay, server, 'bbbbbbbb-0000-0000-0000-000000000002', 'Fix the deploy')
  await takeClaim(onServer.relay, 'aaaaaaaa-0000-0000-0000-000000000001', { take: true })

  const listed = (await listSessions(onServer.relay)).map(({ id, tool, machine, holder, firstPrompt, cwd }) => ({ id, tool, machine, holder, firstPrompt, cwd }))
  expect(listed.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
    { id: 'aaaaaaaa-0000-0000-0000-000000000001', tool: 'claude', machine: 'mac', holder: 'server', firstPrompt: 'Plan the release', cwd: '/work' },
    { id: 'bbbbbbbb-0000-0000-0000-000000000002', tool: 'claude', machine: 'server', holder: 'server', firstPrompt: 'Fix the deploy', cwd: '/work' },
  ])
})

test("a claimed session lists the holder's entry, even when the old holder wrote later", async () => {
  const relay = memoryRelay()
  const session = 'aaaaaaaa-0000-0000-0000-000000000001'
  const entry = { id: session, tool: 'claude', title: '', firstPrompt: 'Plan the release', cwd: '/work', repo: '', repoFolder: '', entrypoint: 'cli', size: 10 }
  machine(mac, relay)
  const onServer = machine(server, relay)
  relay.put(`sessions/${mac.id}/index.json`, new TextEncoder().encode(JSON.stringify([{ ...entry, lastActivity: '2026-11-03T12:45:00.000Z' }])))
  relay.put(`sessions/${server.id}/index.json`, new TextEncoder().encode(JSON.stringify([{ ...entry, cwd: '/home/server/work', lastActivity: '2026-11-03T12:44:00.000Z' }])))
  await takeClaim(onServer.capture.relay, session, { take: false })

  expect((await listSessions(onServer.capture.relay)).map(({ machine, holder, cwd, entrypoint }) => ({ machine, holder, cwd, entrypoint }))).toEqual([{ machine: 'server', holder: 'server', cwd: '/home/server/work', entrypoint: 'cli' }])
})

test('a session another machine resumed refuses resume without --take, and --take takes it back', async () => {
  const relay = memoryRelay()
  const session = 'aaaaaaaa-0000-0000-0000-000000000001'
  const onMac = await captured(relay, mac, session, 'Plan the release', temporaryFolder())
  const onServer = machine(server, relay)
  // a session only its writer wrote goes to the machine that resumes it
  await restore(onServer.capture, session, { take: false })

  await expect(restore(onMac, session, { take: false })).rejects.toThrow(`This session continues on server. Run anyhost resume ${session} --take to continue it here.`)
  await expect(takeClaim(onMac.relay, session, { take: false })).rejects.toBeInstanceOf(HeldElsewhere)
  await restore(onMac, session, { take: true })
  expect(relay.claims.get(session)).toBe(mac.id)
})

test("a session's upload holds no job record of Claude Code's, and a restore places, checks or deletes none an earlier version uploaded", async () => {
  const relay = memoryRelay()
  const session = 'abababab-0000-4000-8000-00000000000a'
  const jobOf = (roots: MachineRoots): string => join(roots.claudeHome, 'jobs', session.slice(0, 8), 'state.json')
  const writer = machine(mac, relay)
  const transcript = join(writer.roots.claudeHome, 'projects', '-work', `${session}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  mkdirSync(dirname(jobOf(writer.roots)), { recursive: true })
  const cwd = join(writer.roots.home, 'work')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"cwd":"${cwd}","sessionId":"${session}"}\n`)
  writeFileSync(jobOf(writer.roots), `{"state":"done","cwd":"${cwd}"}`)
  // the first upload of a session takes every file it has
  await uploadSession(writer.capture, session, 'claude', new Set([transcript]), failTest)
  const paths = async (): Promise<string[]> => [...(await downloadJournal(relay.connect(server, writer.roots), session, temporaryFolder(), ({ path }) => path)).files.keys()]
  expect(await paths()).toEqual([transcript])

  // what an earlier version uploaded: the job record, then its deletion
  await uploadSession(writer.capture, session, 'claude', new Set([jobOf(writer.roots)]), failTest)
  rmSync(jobOf(writer.roots))
  await uploadSession(writer.capture, session, 'claude', new Set([jobOf(writer.roots)]), failTest)
  await writeIndex(writer.capture)
  const restorer = machine(server, relay)
  mkdirSync(dirname(jobOf(restorer.roots)), { recursive: true })
  writeFileSync(jobOf(restorer.roots), '{"state":"stopped"}')
  await restore(restorer.capture, session, { take: true })

  expect(readFileSync(jobOf(restorer.roots), 'utf8')).toBe('{"state":"stopped"}')
  expect(existsSync(join(restorer.roots.claudeHome, 'projects', '-work', `${session}.jsonl`))).toBe(true)
})

test('restore gives restoreCode the last code header and its parts, places no part as a file, and continues in the folder it answers', async () => {
  const relay = memoryRelay()
  const session = 'eeeeeeee-0000-4000-8000-000000000005'
  const home = join(temporaryFolder(), 'home')
  const cwd = join(home, 'work', 'shop')
  const transcript = join(home, '.claude', 'projects', '-work-shop', `${session}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const part = { path: `anyhost:code/${session}/parts/bb22`, bytes: new TextEncoder().encode('a bundle') }
  let captures = 0
  const writer = machine(mac, relay, home, undefined, { captureCode: async () => ({ header: new TextEncoder().encode(`header ${(captures += 1)}`), parts: [part] }), restoreCode: async () => '' }).capture
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Ship it"},"cwd":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`)
  await uploadSession(writer, session, 'claude', new Set([transcript]), failTest)
  await writer.codeRuns.get(session)
  await uploadSession(writer, session, 'claude', new Set([`${cwd}/`]), failTest)
  appendFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Again"},"cwd":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`)
  await uploadSession(writer, session, 'claude', new Set([transcript]), failTest)
  await writer.codeRuns.get(session)
  await uploadSession(writer, session, 'claude', new Set([`${cwd}/`]), failTest)
  await writeIndex(writer)

  const worktree = join(home, 'work', 'shop-eeeeeeee')
  const given: string[] = []
  const restorer = machine(server, relay, home, undefined, {
    captureCode: async () => undefined,
    restoreCode: async (header, readPart, folder) => {
      given.push(new TextDecoder().decode(header), new TextDecoder().decode(await readPart(part.path)), folder)
      return worktree
    },
  }).capture
  const { cwd: continued } = await restore(restorer, session, { take: false })

  expect(given).toEqual(['header 2', 'a bundle', cwd])
  expect(continued).toBe(worktree)
  expect(existsSync(join(cwd, 'anyhost:code'))).toBe(false)
  expect(existsSync(join(home, 'anyhost:code'))).toBe(false)
})

test('a new session is listed with its working folder by its first upload, so a takeover right after restores its code there', async () => {
  const relay = memoryRelay()
  const session = '99999999-0000-4000-8000-000000000009'
  const home = join(temporaryFolder(), 'home')
  const cwd = join(home, 'work', 'anyhost')
  const transcript = join(home, '.claude', 'projects', '-work-anyhost', `${session}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const writer = machine(mac, relay, home, undefined, { captureCode: async () => ({ header: new TextEncoder().encode('header'), parts: [] }), restoreCode: async () => '' }).capture
  writeFileSync(transcript, `{"type":"permission-mode","permissionMode":"default","sessionId":"${session}"}\n`)
  await uploadSession(writer, session, 'claude', new Set([transcript]), failTest)
  appendFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Ship it"},"cwd":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`)
  await uploadSession(writer, session, 'claude', new Set([transcript]), failTest)
  await writer.codeRuns.get(session)
  await uploadSession(writer, session, 'claude', new Set([`${cwd}/`]), failTest)

  expect((await listSessions(writer.relay)).map(({ id, cwd: listed }) => ({ id, cwd: listed }))).toEqual([{ id: session, cwd }])
  const given: string[] = []
  const restorer = machine(server, relay, home, undefined, { captureCode: async () => undefined, restoreCode: async (_header, _readPart, folder) => (given.push(folder), folder) }).capture
  await restore(restorer, session, { take: true })
  expect(given).toEqual([cwd])
})

test("restore onto another home rewrites the writer's paths, and a /rewind backup of a plan as its plan, while a working folder backup keeps its bytes", async () => {
  const relay = memoryRelay()
  const session = 'ffffffff-0000-4000-8000-000000000006'
  const first = join(temporaryFolder(), 'alice')
  const second = join(temporaryFolder(), 'bob')
  const encoded = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-')
  const a = machine(mac, relay, first)
  const b = machine(server, relay, second)
  const at = (home: string) => ({
    transcript: join(home, '.claude', 'projects', encoded(join(home, 'work', 'shop')), `${session}.jsonl`),
    plan: join(home, '.claude', 'plans', 'shop.md'),
    planBackup: join(home, '.claude', 'file-history', session, 'aaaa1111@v1'),
    notesBackup: join(home, '.claude', 'file-history', session, 'bbbb2222@v1'),
  })
  const there = at(first)
  for (const path of Object.values(there)) mkdirSync(dirname(path), { recursive: true })
  const plan = `# Shop\n\nRead ${join(first, '.claude', 'plans', 'shop.md')} again.\n`
  const tracked = { [there.plan]: { backupFileName: 'aaaa1111@v1', version: 1 }, 'notes.md': { backupFileName: 'bbbb2222@v1', version: 1 } }
  writeFileSync(
    there.transcript,
    `{"type":"user","message":{"role":"user","content":"Plan the shop"},"cwd":${JSON.stringify(join(first, 'work', 'shop'))},"sessionId":"${session}"}\n` +
      `{"type":"file-history-snapshot","messageId":"m1","snapshot":{"messageId":"m1","trackedFileBackups":${JSON.stringify(tracked)}},"isSnapshotUpdate":false}\n`,
  )
  writeFileSync(there.plan, plan)
  writeFileSync(there.planBackup, plan)
  writeFileSync(there.notesBackup, `notes kept at ${first}/work/shop\n`)
  await uploadSession(a.capture, session, 'claude', new Set(Object.values(there)), failTest)
  await writeIndex(a.capture)

  await restore(b.capture, session, { take: false })

  const here = at(second)
  const moved = `# Shop\n\nRead ${join(second, '.claude', 'plans', 'shop.md')} again.\n`
  expect([readFileSync(here.plan, 'utf8'), readFileSync(here.planBackup, 'utf8')]).toEqual([moved, moved])
  expect(readFileSync(here.notesBackup, 'utf8')).toBe(`notes kept at ${first}/work/shop\n`)
  expect(readFileSync(here.transcript, 'utf8')).toContain(`"cwd":${JSON.stringify(join(second, 'work', 'shop'))}`)
})

// The other restore tests keep the working folder under the home, the one place restore moved a folder outside git to.
test("a session that worked in macOS's temp root continues in this machine's, and every path in it names this machine's", async () => {
  const relay = memoryRelay()
  const session = '44444444-0000-4000-8000-000000000004'
  const encoded = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-')
  const home = join(temporaryFolder(), 'home')
  // the temp root as rootsHere records it on macOS, where Claude Code writes it with /private and the model without
  const roots: MachineRoots = { home, claudeHome: join(home, '.claude'), claudeTmp: '/private/tmp/claude-501', codexHome: join(home, '.codex') }
  const writer = openCapture(relay.connect(mac, roots), mac, roots, openDatabase(join(temporaryFolder(), 'state')), noCode)
  const scratchpad = (tmp: string, at: string): string => `${tmp}/${encoded(join(at, 'dotfiles'))}/${session}/scratchpad`
  const line = (cwd: string, read: string): string => `{"type":"user","message":{"role":"user","content":"Sum up ${read}/notes.md"},"cwd":"${cwd}","sessionId":"${session}"}\n`
  const there = scratchpad(roots.claudeTmp, roots.home)
  const transcript = join(roots.claudeHome, 'projects', encoded(there), `${session}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, line(there, scratchpad('/tmp/claude-501', roots.home)))
  await uploadSession(writer, session, 'claude', new Set([transcript]), failTest)
  await writeIndex(writer)

  const b = machine(server, relay)
  const { cwd } = await restore(b.capture, session, { take: false })

  const here = scratchpad(b.roots.claudeTmp, b.roots.home)
  expect(cwd).toBe(here)
  expect(existsSync(here)).toBe(true)
  expect(readFileSync(join(b.roots.claudeHome, 'projects', encoded(here), `${session}.jsonl`), 'utf8')).toBe(line(here, here))
})

test('a session restores on another machine byte for byte from the bucket alone, and that machine continues its journal', async () => {
  const relay = memoryRelay()
  const session = 'cccccccc-0000-4000-8000-000000000003'
  const other = 'dddddddd-0000-4000-8000-000000000004'
  const home = join(temporaryFolder(), 'home')
  const a = machine(mac, relay, home)
  const claude = join(home, '.claude')
  const cwd = join(home, 'work', 'trip')
  const transcript = join(claude, 'projects', '-work-trip', `${session}.jsonl`)
  const plan = join(claude, 'plans', 'trip.md')
  const task = join(claude, 'tasks', session, '1.json')
  const toolResult = join(claude, 'projects', '-work-trip', session, 'tool-results', 'b1.txt')
  const output = join(a.roots.claudeTmp, '-work-trip', session, 'tasks', 'b2.output')
  const history = join(claude, 'history.jsonl')
  for (const path of [transcript, plan, task, toolResult, output]) mkdirSync(dirname(path), { recursive: true })
  const line = (text: string): string => `{"type":"user","message":{"role":"user","content":${JSON.stringify(text)}},"cwd":${JSON.stringify(cwd)},"entrypoint":"cli","sessionId":"${session}"}\n`
  const upload = (...paths: string[]): Promise<Set<string>> => uploadSession(a.capture, session, 'claude', new Set(paths), failTest)

  writeFileSync(transcript, `${line('Plan the trip')}{"type":"attachment","attachment":{"planFilePath":${JSON.stringify(plan)}},"sessionId":"${session}"}\n`)
  writeFileSync(plan, '# Trip\n')
  writeFileSync(task, '{"status":"pending","subject":"book the train"}')
  writeFileSync(history, `{"display":"elsewhere","project":"/work","sessionId":"${other}"}\n{"display":"Plan the trip","project":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`)
  await upload(transcript, history)
  writeFileSync(toolResult, 'a long Bash output\n'.repeat(1000))
  writeFileSync(output, 'started\n')
  const silent = join(dirname(output), 'b3.output')
  writeFileSync(silent, '')
  appendFileSync(transcript, line('Run the build'))
  await upload(transcript, toolResult, output, silent)
  await seal(a.capture.relay, session)
  writeFileSync(task, '{"status":"done"}')
  appendFileSync(output, 'finished\n')
  writeFileSync(plan, '# Trip\n\n1. Book the 08:15 train\n')
  appendFileSync(transcript, line('Book it'))
  await upload(transcript, task, output, plan)
  await writeIndex(a.capture)
  const originals = new Map([transcript, plan, task, toolResult, output, silent].map((path) => [path, readFileSync(path)]))

  // the second machine has the same home and none of the session's files
  rmSync(claude, { recursive: true })
  rmSync(a.roots.claudeTmp, { recursive: true })
  writeFileSync(join(home, 'unrelated'), '')
  mkdirSync(claude)
  writeFileSync(history, `{"display":"here before","project":"/work","sessionId":"${other}"}\n`)
  const b = machine(server, relay, home)
  const { cwd: continued } = await restore(b.capture, session, { take: false })

  expect(continued).toBe(cwd)
  for (const [path, bytes] of originals) expect(readFileSync(path).equals(bytes)).toBe(true)
  expect(readFileSync(history, 'utf8')).toBe(`{"display":"here before","project":"/work","sessionId":"${other}"}\n{"display":"Plan the trip","project":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`)
  const end = journalOf(b.capture.db, session)?.end ?? 0
  expect(end).toBeGreaterThan(0)

  appendFileSync(transcript, line('Continue on server'))
  await uploadSession(b.capture, session, 'claude', new Set([transcript]), failTest)
  expect(relay.objects.has(`journals/${session}/hot/${String(end).padStart(16, '0')}.zst`)).toBe(true)
  const replayed = await downloadJournal(b.capture.relay, session, temporaryFolder(), ({ path }) => path)
  expect(readFileSync(replayed.files.get(transcript)?.staged ?? '').equals(readFileSync(transcript))).toBe(true)
  expect(replayed.files.get(transcript)?.segments.map(({ device }) => device)).toEqual([mac.id, mac.id, mac.id, server.id])
})

test("a session comes back to a machine that kept a longer copy, although the history its last writer had holds a prompt the journal never got", async () => {
  const relay = memoryRelay()
  const session = '88888888-0000-4000-8000-000000000008'
  const a = machine(mac, relay)
  const b = machine(server, relay)
  const at = (home: string) => ({ transcript: join(home, '.claude', 'projects', '-work', `${session}.jsonl`), history: join(home, '.claude', 'history.jsonl') })
  const prompt = (text: string): string => `{"display":"${text}","project":"/work","sessionId":"${session}"}\n`
  const there = at(a.roots.home)
  mkdirSync(dirname(there.transcript), { recursive: true })
  writeFileSync(there.transcript, `{"type":"user","message":{"role":"user","content":"Plan the release"},"cwd":${JSON.stringify(join(a.roots.home, 'work'))},"sessionId":"${session}"}\n`)
  writeFileSync(there.history, prompt('Plan the release'))
  await uploadSession(a.capture, session, 'claude', new Set(Object.values(there)), failTest)
  await writeIndex(a.capture)
  // server refused this prompt while mac held the session, and its history keeps it
  const here = at(b.roots.home)
  mkdirSync(dirname(here.history), { recursive: true })
  writeFileSync(here.history, prompt('Refused on server'))
  await restore(b.capture, session, { take: true })
  appendFileSync(here.history, prompt('Ship it'))
  await uploadSession(b.capture, session, 'claude', new Set([here.history]), failTest)
  await writeIndex(b.capture)

  // mac took one more prompt before it heard of the takeover: its transcript runs longer than the journal's
  const journaled = readFileSync(there.transcript)
  appendFileSync(there.transcript, `{"type":"user","message":{"role":"user","content":"${'one more prompt '.repeat(20)}"},"sessionId":"${session}"}\n`)
  await restore(a.capture, session, { take: true })
  expect(readFileSync(there.history, 'utf8')).toBe(`${prompt('Plan the release')}${prompt('Ship it')}`)
  expect(readFileSync(there.transcript).equals(journaled)).toBe(true)
})

test('a plan and a task the session deleted stay gone after a restore, also on a machine that kept them', async () => {
  const relay = memoryRelay()
  const session = '66666666-0000-4000-8000-000000000006'
  const a = machine(mac, relay)
  const b = machine(server, relay)
  const at = (home: string) => ({
    transcript: join(home, '.claude', 'projects', '-work', `${session}.jsonl`),
    task: join(home, '.claude', 'tasks', session, '1.json'),
    plan: join(home, '.claude', 'plans', 'trip.md'),
  })
  const there = at(a.roots.home)
  for (const path of Object.values(there)) mkdirSync(dirname(path), { recursive: true })
  writeFileSync(there.transcript, `{"type":"attachment","attachment":{"planFilePath":${JSON.stringify(there.plan)}},"cwd":${JSON.stringify(a.roots.home)},"sessionId":"${session}"}\n`)
  writeFileSync(there.task, '{"subject":"book the train"}')
  writeFileSync(there.plan, '# Trip\n')
  await uploadSession(a.capture, session, 'claude', new Set(Object.values(there)), failTest)
  await writeIndex(a.capture)
  await restore(b.capture, session, { take: true })
  const here = at(b.roots.home)
  expect([existsSync(here.task), existsSync(here.plan)]).toEqual([true, true])
  // server's /rewind takes the plan back and Claude Code deletes the task
  rmSync(here.plan)
  rmSync(here.task)
  await uploadSession(b.capture, session, 'claude', new Set([here.plan, here.task]), failTest)
  await writeIndex(b.capture)

  await restore(a.capture, session, { take: true })
  expect([existsSync(there.task), existsSync(there.plan), existsSync(there.transcript)]).toEqual([false, false, true])
  const c = machine({ id: 'device-c', name: 'laptop', os: 'linux', arch: 'arm64' }, relay)
  await restore(c.capture, session, { take: true })
  const third = at(c.roots.home)
  expect([existsSync(third.task), existsSync(third.plan), existsSync(third.transcript)]).toEqual([false, false, true])
})

test('resume puts a repository this machine lacks beside the checkouts it has, or in the checkouts folder the person chose', async () => {
  const relay = memoryRelay()
  const session = '55555555-0000-4000-8000-000000000005'
  const home = join(temporaryFolder(), 'home')
  const writer = machine(mac, relay, home, undefined, { captureCode: async () => ({ header: new TextEncoder().encode('header'), parts: [] }), restoreCode: async () => '' }).capture
  const cwd = join(home, 'work', 'shop')
  const transcript = join(home, '.claude', 'projects', '-work-shop', `${session}.jsonl`)
  for (const folder of [cwd, dirname(transcript)]) mkdirSync(folder, { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Ship it"},"cwd":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`)
  await uploadSession(writer, session, 'claude', new Set([transcript]), failTest)
  await writer.codeRuns.get(session)
  await uploadSession(writer, session, 'claude', new Set([`${cwd}/`]), failTest)
  // the shop repository, as an index that read its remote lists it
  const index = JSON.parse(new TextDecoder().decode(relay.objects.get(`sessions/${mac.id}/index.json`)?.body)) as Record<string, unknown>[]
  relay.put(`sessions/${mac.id}/index.json`, new TextEncoder().encode(JSON.stringify(index.map((entry) => ({ ...entry, repo: 'git@github.com:alice/shop.git', repoFolder: '' })))))

  const restoredInto = async (setUp: (folder: string, capture: Capture) => Promise<void>, checkouts?: string): Promise<string> => {
    const folder = join(temporaryFolder(), 'bob')
    const given: string[] = []
    // restoreCode leaves the checkout with its remote, which this machine's index then names
    const restoreCode = async (_header: Uint8Array, _readPart: unknown, at: string): Promise<string> => {
      given.push(at)
      mkdirSync(at, { recursive: true })
      Bun.spawnSync(['git', 'init', '-q', at])
      Bun.spawnSync(['git', '-C', at, 'remote', 'add', 'origin', 'git@github.com:alice/shop.git'])
      return at
    }
    const restorer = machine(server, relay, folder, undefined, { captureCode: async () => undefined, restoreCode }).capture
    await setUp(folder, restorer)
    await restore(restorer, session, { take: true, ...(checkouts === undefined ? {} : { checkouts: checkouts.replace('<home>', folder) }) })
    return (given[0] ?? '').replace(folder, '<home>')
  }
  // two checkouts of other repositories this machine wrote sessions in
  const withCheckouts = async (folder: string, capture: Capture): Promise<void> => {
    for (const name of ['blog', 'docs']) {
      const repo = join(folder, 'code', name)
      mkdirSync(repo, { recursive: true })
      Bun.spawnSync(['git', 'init', '-q', repo])
      Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', `git@github.com:bob/${name}.git`])
      await recordSummary(capture, crypto.randomUUID(), 'claude', `{"type":"user","cwd":${JSON.stringify(repo)}}\n`, 1, new Date().toISOString())
    }
  }
  expect(await restoredInto(withCheckouts)).toBe('<home>/code/shop')
  expect(await restoredInto(async () => undefined)).toBe('<home>/shop')
  expect(await restoredInto(withCheckouts, '<home>/src')).toBe('<home>/src/shop')
})

// The session mac captures, which server then takes over. `isOffline` closes mac's connection first.
async function takenOver(isOffline: boolean) {
  const relay = memoryRelay()
  const session = '77777777-0000-4000-8000-000000000007'
  const state = join(temporaryFolder(), 'state')
  const old = machine(mac, relay, undefined, state)
  const line = (text: string): string => `{"type":"user","message":{"role":"user","content":"${text}"},"cwd":${JSON.stringify(join(old.roots.home, 'work'))},"sessionId":"${session}"}\n`
  const transcript = join(old.roots.home, '.claude', 'projects', '-work', `${session}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, line('Plan the release'))
  await uploadSession(old.capture, session, 'claude', new Set([transcript]), failTest)
  await writeIndex(old.capture)
  if (isOffline) {
    old.capture.relay.close()
    await until(() => !relay.isConnected(mac.id))
  }
  const taker = machine(server, relay)
  await restore(taker.capture, session, { take: true })
  appendFileSync(transcript, line('Keep going'))
  return { relay, session, old, state, transcript, taker }
}

test('a takeover tells the old machine at once, which refuses its next prompt and uploads nothing, with the relay stalled', async () => {
  const { relay, session, old, transcript, taker } = await takenOver(false)
  await until(() => journalOf(old.capture.db, session)?.holder === 'server')
  expect(takeUntold(taker.capture.db, session)).toBe('')
  relay.stalled = true

  const asked = performance.now()
  expect(await uploadSession(old.capture, session, 'claude', new Set([transcript]), failTest)).toEqual(new Set())
  expect(performance.now() - asked).toBeLessThan(100)
  expect(journalOf(old.capture.db, session)?.stopped).toContain('server took the session')
})

test('a machine offline during a takeover learns it in its next welcome, before it captures, and the session opened says so once', async () => {
  const { relay, session, old, state, taker } = await takenOver(true)
  expect(journalOf(old.capture.db, session)?.holder).toBe('')
  expect([takeUntold(taker.capture.db, session), takeUntold(taker.capture.db, session)]).toEqual(['mac', ''])

  const back = machine(mac, relay, old.roots.home, state)
  await until(() => back.capture.relay.state.is === 'connected')
  expect(journalOf(back.capture.db, session)).toMatchObject({ holder: 'server', stopped: expect.stringContaining('server took the session') })
})
