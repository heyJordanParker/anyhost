import { Database } from 'bun:sqlite'
import { expect, onTestFinished, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { journalOf, openCapture, openDatabase, QUIET_MS, recordSummary, relistSessions, seal, sealQuiet, untoldOf, uploadSessions, writeIndex, type Capture } from '../src/capture.ts'
import { followHolders, HeldElsewhere, takeClaim } from '../src/claims.ts'
import type { Relay } from '../src/relay.ts'
import { devicesOf, type Device, type MachineRoots } from '../src/device.ts'
import { restore } from '../src/resume.ts'
import { agentsOf, downloadJournal, listSessions } from '../src/sessions.ts'
import { archive } from '../src/shared.ts'
import { archiveSettledInT3 } from '../src/t3.ts'
import { failTest, memoryRelay, noCode, temporaryFolder, until, type MemoryRelay } from './memory.ts'

const mac: Device = { id: 'device-mac', name: 'mac', os: 'darwin', arch: 'arm64' }
const server: Device = { id: 'device-server', name: 'server', os: 'linux', arch: 'x64' }
const upload = (capture: Capture, session: string, ...paths: string[]): Promise<Set<string>[]> =>
  Promise.all(uploadSessions(capture, [{ session, tool: 'claude', paths: new Set(paths) }], failTest).map(([, left]) => left))

function machine(device: Device, relay: MemoryRelay, home = join(temporaryFolder(), 'home'), state = join(temporaryFolder(), 'state'), code = noCode, compactLagMs?: number) {
  const roots: MachineRoots = { home, claudeHome: join(home, '.claude'), claudeTmp: join(home, 'tmp', 'claude-1000'), codexHome: join(home, '.codex') }
  return { roots, capture: openCapture(relay.connect(device, roots), device, roots, { db: openDatabase(state), code, codeEveryMs: 0, ...(compactLagMs === undefined ? {} : { compactLagMs }) }) }
}

async function captured(relay: MemoryRelay, device: Device, session: string, prompt: string, cwd = '/work'): Promise<Capture> {
  const { roots, capture } = machine(device, relay)
  const transcript = join(roots.home, '.claude', 'projects', '-work', `${session}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":${JSON.stringify(prompt)}},"cwd":"${cwd}","sessionId":"${session}"}\n`)
  await upload(capture, session, transcript)
  await writeIndex(capture)
  return capture
}

function transcriptOf(roots: MachineRoots, session: string, prompt: string): string {
  const transcript = join(roots.home, '.claude', 'projects', '-work', `${session}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":${JSON.stringify(prompt)}},"cwd":"/work","sessionId":"${session}"}\n`)
  return transcript
}

const listedOf = async (capture: Capture): Promise<{ id: string; firstPrompt: string; deleted: boolean }[]> =>
  (await listSessions(capture)).map(({ id, firstPrompt, deleted }) => ({ id, firstPrompt, deleted })).sort((a, b) => a.id.localeCompare(b.id))

test('a machine whose database starts over, as one an older anyhost dropped, keeps every session its index listed', async () => {
  const relay = await memoryRelay()
  const home = join(temporaryFolder(), 'home')
  const first = 'aaaaaaaa-0000-0000-0000-000000000001'
  const second = 'bbbbbbbb-0000-0000-0000-000000000002'
  const before = machine(mac, relay, home)
  await upload(before.capture, first, transcriptOf(before.roots, first, 'Plan the release'))
  await writeIndex(before.capture)

  const after = machine(mac, relay, home)
  await upload(after.capture, second, transcriptOf(after.roots, second, 'Fix the deploy'))
  await writeIndex(after.capture)

  expect(await listedOf(after.capture)).toEqual([
    { id: first, firstPrompt: 'Plan the release', deleted: false },
    { id: second, firstPrompt: 'Fix the deploy', deleted: false },
  ])
})

test('a session with a journal in R2 and a transcript here that no index lists is listed again, and a transcript R2 holds no journal of is not', async () => {
  const relay = await memoryRelay()
  const home = join(temporaryFolder(), 'home')
  const backedUp = 'aaaaaaaa-0000-0000-0000-000000000001'
  const never = 'bbbbbbbb-0000-0000-0000-000000000002'
  const before = machine(mac, relay, home)
  await upload(before.capture, backedUp, transcriptOf(before.roots, backedUp, 'Plan the release'))
  transcriptOf(before.roots, never, 'Never backed up')
  const after = machine(mac, relay, home)
  await after.capture.relay.runOne({ op: 'put', key: `sessions/${mac.id}/index.json`, bytes: new TextEncoder().encode('[]') })

  expect(await relistSessions(after.capture)).toBe(1)
  await writeIndex(after.capture)

  expect(await listedOf(after.capture)).toEqual([{ id: backedUp, firstPrompt: 'Plan the release', deleted: false }])
})

test('the index lists sessions of two devices, each held by the machine that holds it', async () => {
  const relay = await memoryRelay()
  await captured(relay, mac, 'aaaaaaaa-0000-0000-0000-000000000001', 'Plan the release')
  const onServer = await captured(relay, server, 'bbbbbbbb-0000-0000-0000-000000000002', 'Fix the deploy')
  await takeClaim(onServer.relay, 'aaaaaaaa-0000-0000-0000-000000000001', { take: true })

  const listed = (await listSessions(onServer)).map(({ id, tool, machine, holder, firstPrompt, cwd }) => ({ id, tool, machine, holder, firstPrompt, cwd }))
  expect(listed.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
    { id: 'aaaaaaaa-0000-0000-0000-000000000001', tool: 'claude', machine: 'mac', holder: 'server', firstPrompt: 'Plan the release', cwd: '/work' },
    { id: 'bbbbbbbb-0000-0000-0000-000000000002', tool: 'claude', machine: 'server', holder: 'server', firstPrompt: 'Fix the deploy', cwd: '/work' },
  ])
})

test('a list reads where each session lives from the changes the relay pushed, and asks the relay for no holder', async () => {
  const relay = await memoryRelay()
  const session = 'aaaaaaaa-0000-0000-0000-000000000001'
  const onMac = await captured(relay, mac, session, 'Plan the release')
  const onServer = machine(server, relay).capture
  expect((await listSessions(onMac)).map(({ holder }) => holder)).toEqual(['mac'])

  await takeClaim(onServer.relay, session, { take: true })
  await until(async () => (await onMac.holders.current()).get(session) === server.id, 'the take reaching the mac')

  expect((await listSessions(onMac)).map(({ holder }) => holder)).toEqual(['server'])
  expect(relay.requests.flat().filter(({ op }) => op === 'claims')).toEqual([])
})

test('a machine that missed a change, as when its socket lost the message, reads every change since its last one', async () => {
  const relay = await memoryRelay()
  const first = 'aaaaaaaa-0000-0000-0000-000000000001'
  const second = 'bbbbbbbb-0000-0000-0000-000000000002'
  const onMac = await captured(relay, mac, first, 'Plan the release')
  const onServer = machine(server, relay).capture
  await onServer.holders.current()

  const lost = relay.dropNext(server.id, 'claimed')
  await takeClaim(onMac.relay, second, { take: false })
  await lost
  await takeClaim(onMac.relay, first, { take: true })
  await until(async () => (await onServer.holders.current()).size === 2, 'the server reading the change it missed')

  expect(Object.fromEntries(await onServer.holders.current())).toEqual({ [first]: mac.id, [second]: mac.id })
})

test('a read of the holders that a closed connection cuts off fails that read alone, with no error left unhandled', async () => {
  const welcomes: ((welcome: { readonly changed: number }) => void)[] = []
  const closed = {
    on: (kind: string, listener: (welcome: { readonly changed: number }) => void) => (kind === 'welcome' && welcomes.push(listener), () => undefined),
    runOne: async () => {
      throw new Error('anyhost closed its connection to the relay.')
    },
  } as unknown as Relay
  const holders = followHolders(closed, openDatabase(temporaryFolder()))
  const unhandled: unknown[] = []
  const heard = (reason: unknown): void => void unhandled.push(reason)
  process.on('unhandledRejection', heard)
  onTestFinished(() => void process.off('unhandledRejection', heard))

  for (const welcome of welcomes) welcome({ changed: 5 })

  await expect(holders.current()).rejects.toThrow('anyhost closed its connection to the relay.')
  await Bun.sleep(100)
  expect(unhandled).toEqual([])
})

test("a session with a transcript in two project folders lists its prompt and folder from both", async () => {
  const relay = await memoryRelay()
  const session = 'aaaaaaaa-0000-0000-0000-000000000001'
  const { roots, capture } = machine(mac, relay)
  const moved = join(roots.home, '.claude', 'projects', '-design', `${session}.jsonl`)
  const main = join(roots.home, '.claude', 'projects', '-work', `${session}.jsonl`)
  mkdirSync(dirname(moved), { recursive: true })
  mkdirSync(dirname(main), { recursive: true })
  writeFileSync(moved, `{"type":"history-suppression","sessionId":"${session}"}\n`)
  writeFileSync(main, `{"type":"user","message":{"role":"user","content":"Ship the release"},"cwd":"/work","sessionId":"${session}"}\n`)

  await upload(capture, session, moved, main)
  await writeIndex(capture)

  expect((await listSessions(capture)).map(({ firstPrompt, cwd }) => ({ firstPrompt, cwd }))).toEqual([{ firstPrompt: 'Ship the release', cwd: '/work' }])
})

test("a claimed session lists the holder's entry, even when the old holder wrote later", async () => {
  const relay = await memoryRelay()
  const session = 'aaaaaaaa-0000-0000-0000-000000000001'
  const entry = { id: session, tool: 'claude', title: '', firstPrompt: 'Plan the release', cwd: '/work', repo: '', repoFolder: '', entrypoint: 'cli', size: 10 }
  machine(mac, relay)
  const onServer = machine(server, relay)
  await relay.objects.put(`sessions/${mac.id}/index.json`, new TextEncoder().encode(JSON.stringify([{ ...entry, lastActivity: '2026-11-03T12:45:00.000Z' }])))
  await relay.objects.put(`sessions/${server.id}/index.json`, new TextEncoder().encode(JSON.stringify([{ ...entry, cwd: '/home/server/work', lastActivity: '2026-11-03T12:44:00.000Z' }])))
  await takeClaim(onServer.capture.relay, session, { take: false })

  expect((await listSessions(onServer.capture)).map(({ machine, holder, cwd, entrypoint }) => ({ machine, holder, cwd, entrypoint }))).toEqual([{ machine: 'server', holder: 'server', cwd: '/home/server/work', entrypoint: 'cli' }])
})

test('the agents list leaves out a session nobody wrote a prompt in, and names the session whose agent started each one', async () => {
  const relay = await memoryRelay()
  const entry = { tool: 'claude', title: '', cwd: '/work', repo: '', repoFolder: '', entrypoint: 'cli', size: 10, lastActivity: new Date().toISOString() }
  const { capture } = machine(mac, relay)
  await relay.objects.put(`sessions/${mac.id}/index.json`, new TextEncoder().encode(JSON.stringify([
    { ...entry, id: 'aaaaaaaa-0000-0000-0000-000000000001', firstPrompt: 'You are the CTO.' },
    { ...entry, id: 'bbbbbbbb-0000-0000-0000-000000000002', firstPrompt: 'Fix the login' },
    { ...entry, id: 'cccccccc-0000-0000-0000-000000000003', firstPrompt: '' },
  ])))
  await relay.objects.put('shared.json', new TextEncoder().encode(JSON.stringify({ parents: { 'bbbbbbbb-0000-0000-0000-000000000002': 'aaaaaaaa-0000-0000-0000-000000000001' } })))

  const { agents } = await agentsOf(capture)

  expect(agents.map(({ id, parent }) => [id.slice(0, 8), parent.slice(0, 8)]).sort()).toEqual([['aaaaaaaa', ''], ['bbbbbbbb', 'aaaaaaaa']])
})

test('a session whose transcript an agent deleted lists as deleted, and one whose transcript is there does not', async () => {
  const relay = await memoryRelay()
  const { roots, capture } = machine(mac, relay)
  const transcript = join(roots.home, '.claude', 'projects', '-work', 'aaaaaaaa-0000-0000-0000-000000000001.jsonl')
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, '{"type":"user","message":{"role":"user","content":"Run the eval worker"},"cwd":"/work","sessionId":"aaaaaaaa-0000-0000-0000-000000000001"}\n')
  await upload(capture, 'aaaaaaaa-0000-0000-0000-000000000001', transcript)
  await writeIndex(capture)
  const before = (await listSessions(capture)).map(({ deleted }) => deleted)

  rmSync(transcript)
  await upload(capture, 'aaaaaaaa-0000-0000-0000-000000000001', transcript)
  await writeIndex(capture)

  expect([before, (await listSessions(capture)).map(({ deleted }) => deleted)]).toEqual([[false], [true]])
})

test('a restore of a deleted session brings its transcript back as it was before the deletion, so it lists as a session again', async () => {
  const relay = await memoryRelay()
  const session = 'aaaaaaaa-0000-0000-0000-000000000001'
  const { roots, capture } = machine(mac, relay)
  const transcript = join(roots.home, '.claude', 'projects', '-work', `${session}.jsonl`)
  const line = (home: string): string => `{"type":"user","message":{"role":"user","content":"Run the eval worker"},"cwd":"${home}/work","sessionId":"${session}"}\n`
  mkdirSync(dirname(transcript), { recursive: true })
  mkdirSync(join(roots.home, 'work'))
  writeFileSync(transcript, line(roots.home))
  await upload(capture, session, transcript)
  rmSync(transcript)
  await upload(capture, session, transcript)
  await writeIndex(capture)
  const restorer = machine(server, relay)

  await restore(restorer.capture, session, { take: true })

  expect(readFileSync(join(restorer.roots.home, '.claude', 'projects', '-work', `${session}.jsonl`), 'utf8')).toBe(line(restorer.roots.home))
  expect((await listSessions(restorer.capture)).find(({ id, device }) => id === session && device === server.id)?.deleted).toBe(false)
})

test('a session another machine resumed refuses resume without --take, and --take takes it back', async () => {
  const relay = await memoryRelay()
  const session = 'aaaaaaaa-0000-0000-0000-000000000001'
  const onMac = await captured(relay, mac, session, 'Plan the release', temporaryFolder())
  const onServer = machine(server, relay)
  await restore(onServer.capture, session, { take: false })

  await expect(restore(onMac, session, { take: false })).rejects.toThrow(`This session continues on server. Run anyhost resume ${session} --take to continue it here.`)
  await expect(takeClaim(onMac.relay, session, { take: false })).rejects.toBeInstanceOf(HeldElsewhere)
  await restore(onMac, session, { take: true })
  expect((await relay.claims()).get(session)).toBe(mac.id)
})

test("a session's upload holds no job record of Claude Code's, and a restore places, checks or deletes none an earlier version uploaded", async () => {
  const relay = await memoryRelay()
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
  await upload(writer.capture, session, transcript)
  const paths = async (): Promise<string[]> => [...(await downloadJournal(relay.connect(server, writer.roots), session, temporaryFolder(), ({ path }) => path)).files.keys()]
  expect(await paths()).toEqual([transcript])

  await upload(writer.capture, session, jobOf(writer.roots))
  rmSync(jobOf(writer.roots))
  await upload(writer.capture, session, jobOf(writer.roots))
  await writeIndex(writer.capture)
  const restorer = machine(server, relay)
  mkdirSync(dirname(jobOf(restorer.roots)), { recursive: true })
  writeFileSync(jobOf(restorer.roots), '{"state":"stopped"}')
  await restore(restorer.capture, session, { take: true })

  expect(readFileSync(jobOf(restorer.roots), 'utf8')).toBe('{"state":"stopped"}')
  expect(existsSync(join(restorer.roots.claudeHome, 'projects', '-work', `${session}.jsonl`))).toBe(true)
})

test('restore gives restoreCode the last code header and its parts, places no part as a file, and continues in the folder it answers', async () => {
  const relay = await memoryRelay()
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
  await upload(writer, session, transcript)
  await writer.codeRuns.get(session)
  await upload(writer, session, `${cwd}/`)
  appendFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Again"},"cwd":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`)
  await upload(writer, session, transcript)
  await writer.codeRuns.get(session)
  await upload(writer, session, `${cwd}/`)
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

test('a journal compacted after its transcript went up whole twice and its code changed restores the same files and code from fewer bytes, once the next seal deleted what it replaced', async () => {
  const relay = await memoryRelay()
  const session = 'abababab-0000-4000-8000-00000000000c'
  const home = join(temporaryFolder(), 'home')
  const cwd = join(home, 'work', 'shop')
  const transcript = join(home, '.claude', 'projects', '-work-shop', `${session}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  const partOf = (hash: string): string => `anyhost:code/${session}/parts/${hash}`
  const codeOf = (bytes: Uint8Array): { header: Uint8Array; parts: { path: string; bytes: Uint8Array }[] } => ({
    header: new TextEncoder().encode(`${JSON.stringify({ session, parts: [[sha256(bytes), bytes.length, 'record']] })}\n`),
    parts: [{ path: partOf(sha256(bytes)), bytes }],
  })
  const uncommitted = 256 * 1024
  let code = codeOf(crypto.getRandomValues(new Uint8Array(uncommitted)))
  const writer = machine(mac, relay, home, undefined, { captureCode: async () => code, restoreCode: async () => '' }).capture
  const line = (text: string): string => `{"type":"user","message":{"role":"user","content":${JSON.stringify(text)}},"cwd":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`
  const uploaded = async (): Promise<void> => {
    await upload(writer, session, transcript)
    await writer.codeRuns.get(session)
    await upload(writer, session, `${cwd}/`)
  }
  writeFileSync(transcript, line('Ship it'))
  await uploaded()
  writeFileSync(transcript, `${line('Ship it, with its tests')}${line('Again')}`)
  await uploaded()
  appendFileSync(transcript, line('Once more'))
  code = codeOf(crypto.getRandomValues(new Uint8Array(uncommitted)))
  await uploaded()
  writeFileSync(transcript, `${line('Ship it, with its tests and docs')}${line('Again')}${line('Once more')}`)
  await uploaded()
  await writeIndex(writer)

  const journalBytes = async (): Promise<number> => (await relay.objects.list({ prefix: `journals/${session}/` })).objects.reduce((total, { size }) => total + size, 0)
  const restoredHome = join(temporaryFolder(), 'home')
  const restoredBy = async (device: Device): Promise<{ capture: Capture; files: Record<string, string>; code: string[] }> => {
    rmSync(restoredHome, { recursive: true, force: true })
    const given: string[] = []
    const restoreCode = async (header: Uint8Array, readPart: (path: string) => Promise<Uint8Array>, folder: string): Promise<string> => {
      const { parts } = JSON.parse(new TextDecoder().decode(header)) as { parts: [string, number, string][] }
      given.push(new TextDecoder().decode(header), folder)
      for (const [hash] of parts) given.push(sha256(await readPart(partOf(hash))))
      return folder
    }
    const { capture } = machine(device, relay, restoredHome, undefined, { captureCode: async () => undefined, restoreCode }, 0)
    await restore(capture, session, { take: true })
    const files = readdirSync(restoredHome, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    return { capture, files: Object.fromEntries(files.map((entry) => [relative(restoredHome, join(entry.parentPath, entry.name)), readFileSync(join(entry.parentPath, entry.name), 'utf8')])), code: given }
  }
  const before = await restoredBy(server)
  const bytesBefore = await journalBytes()

  await sealQuiet(before.capture, failTest, Date.now() + QUIET_MS + 1)
  await sealQuiet(before.capture, failTest, Date.now() + QUIET_MS + 2)
  const keys = await relay.keys(`journals/${session}/`)
  expect(keys.map((key) => key.split('/')[2])).toEqual(['compacted'])
  const after = await restoredBy({ id: 'device-c', name: 'laptop', os: 'linux', arch: 'arm64' })

  expect(after.files).toEqual(before.files)
  expect(Object.values(after.files)).toContain(`${line('Ship it, with its tests and docs').replaceAll(home, restoredHome)}${line('Again').replaceAll(home, restoredHome)}${line('Once more').replaceAll(home, restoredHome)}`)
  expect(after.code).toEqual(before.code)
  expect(after.code).toEqual([new TextDecoder().decode(code.header), join(restoredHome, 'work', 'shop'), sha256(code.parts[0]?.bytes ?? new Uint8Array())])
  expect(journalOf(after.capture.db, session)?.end).toBe(journalOf(before.capture.db, session)?.end)
  expect(await journalBytes()).toBeLessThan(bytesBefore - uncommitted)
})

test('a new session is listed with its working folder by its first upload, so a takeover right after restores its code there', async () => {
  const relay = await memoryRelay()
  const session = '99999999-0000-4000-8000-000000000009'
  const home = join(temporaryFolder(), 'home')
  const cwd = join(home, 'work', 'anyhost')
  const transcript = join(home, '.claude', 'projects', '-work-anyhost', `${session}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const writer = machine(mac, relay, home, undefined, { captureCode: async () => ({ header: new TextEncoder().encode('header'), parts: [] }), restoreCode: async () => '' }).capture
  writeFileSync(transcript, `{"type":"permission-mode","permissionMode":"default","sessionId":"${session}"}\n`)
  await upload(writer, session, transcript)
  appendFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Ship it"},"cwd":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`)
  await upload(writer, session, transcript)
  await writer.codeRuns.get(session)
  await upload(writer, session, `${cwd}/`)

  expect((await listSessions(writer)).map(({ id, cwd: listed }) => ({ id, cwd: listed }))).toEqual([{ id: session, cwd }])
  const given: string[] = []
  const restorer = machine(server, relay, home, undefined, { captureCode: async () => undefined, restoreCode: async (_header, _readPart, folder) => (given.push(folder), folder) }).capture
  await restore(restorer, session, { take: true })
  expect(given).toEqual([cwd])
})

test("restore onto another home rewrites the writer's paths, and a /rewind backup of a plan as its plan, while a working folder backup keeps its bytes", async () => {
  const relay = await memoryRelay()
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
  await upload(a.capture, session, ...Object.values(there))
  await writeIndex(a.capture)

  await restore(b.capture, session, { take: false })

  const here = at(second)
  const moved = `# Shop\n\nRead ${join(second, '.claude', 'plans', 'shop.md')} again.\n`
  expect([readFileSync(here.plan, 'utf8'), readFileSync(here.planBackup, 'utf8')]).toEqual([moved, moved])
  expect(readFileSync(here.notesBackup, 'utf8')).toBe(`notes kept at ${first}/work/shop\n`)
  expect(readFileSync(here.transcript, 'utf8')).toContain(`"cwd":${JSON.stringify(join(second, 'work', 'shop'))}`)
})

test("a session that worked in macOS's temp root continues in this machine's, and every path in it names this machine's", async () => {
  const relay = await memoryRelay()
  const session = '44444444-0000-4000-8000-000000000004'
  const encoded = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-')
  const home = join(temporaryFolder(), 'home')
  const roots: MachineRoots = { home, claudeHome: join(home, '.claude'), claudeTmp: '/private/tmp/claude-501', codexHome: join(home, '.codex') }
  const writer = openCapture(relay.connect(mac, roots), mac, roots, { db: openDatabase(join(temporaryFolder(), 'state')), code: noCode })
  const scratchpad = (tmp: string, at: string): string => `${tmp}/${encoded(join(at, 'dotfiles'))}/${session}/scratchpad`
  const line = (cwd: string, read: string): string => `{"type":"user","message":{"role":"user","content":"Sum up ${read}/notes.md"},"cwd":"${cwd}","sessionId":"${session}"}\n`
  const there = scratchpad(roots.claudeTmp, roots.home)
  const transcript = join(roots.claudeHome, 'projects', encoded(there), `${session}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, line(there, scratchpad('/tmp/claude-501', roots.home)))
  await upload(writer, session, transcript)
  await writeIndex(writer)

  const b = machine(server, relay)
  const { cwd } = await restore(b.capture, session, { take: false })

  const here = scratchpad(b.roots.claudeTmp, b.roots.home)
  expect(cwd).toBe(here)
  expect(existsSync(here)).toBe(true)
  expect(readFileSync(join(b.roots.claudeHome, 'projects', encoded(here), `${session}.jsonl`), 'utf8')).toBe(line(here, here))
})

test('a session restores on another machine byte for byte from the bucket alone, and that machine continues its journal', async () => {
  const relay = await memoryRelay()
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
  const uploadA = (...paths: string[]): Promise<Set<string>[]> => upload(a.capture, session, ...paths)

  writeFileSync(transcript, `${line('Plan the trip')}{"type":"attachment","attachment":{"planFilePath":${JSON.stringify(plan)}},"sessionId":"${session}"}\n`)
  writeFileSync(plan, '# Trip\n')
  writeFileSync(task, '{"status":"pending","subject":"book the train"}')
  writeFileSync(history, `{"display":"elsewhere","project":"/work","sessionId":"${other}"}\n{"display":"Plan the trip","project":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`)
  await uploadA(transcript, history)
  writeFileSync(toolResult, 'a long Bash output\n'.repeat(1000))
  writeFileSync(output, 'started\n')
  const silent = join(dirname(output), 'b3.output')
  writeFileSync(silent, '')
  appendFileSync(transcript, line('Run the build'))
  await uploadA(transcript, toolResult, output, silent)
  await seal(a.capture, session)
  writeFileSync(task, '{"status":"done"}')
  appendFileSync(output, 'finished\n')
  writeFileSync(plan, '# Trip\n\n1. Book the 08:15 train\n')
  appendFileSync(transcript, line('Book it'))
  await uploadA(transcript, task, output, plan)
  await writeIndex(a.capture)
  const originals = new Map([transcript, plan, task, toolResult, output, silent].map((path) => [path, readFileSync(path)]))

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
  await upload(b.capture, session, transcript)
  expect(await relay.read(`journals/${session}/hot/${String(end).padStart(16, '0')}.zst`)).toBeDefined()
  const replayed = await downloadJournal(b.capture.relay, session, temporaryFolder(), ({ path }) => path)
  expect(readFileSync(replayed.files.get(transcript)?.staged ?? '').equals(readFileSync(transcript))).toBe(true)
  expect(replayed.files.get(transcript)?.segments.map(({ device }) => device)).toEqual([mac.id, mac.id, mac.id, server.id])
})

test("a session comes back to a machine that kept a longer copy, although the history its last writer had holds a prompt the journal never got", async () => {
  const relay = await memoryRelay()
  const session = '88888888-0000-4000-8000-000000000008'
  const a = machine(mac, relay)
  const b = machine(server, relay)
  const at = (home: string) => ({ transcript: join(home, '.claude', 'projects', '-work', `${session}.jsonl`), history: join(home, '.claude', 'history.jsonl') })
  const prompt = (text: string): string => `{"display":"${text}","project":"/work","sessionId":"${session}"}\n`
  const there = at(a.roots.home)
  mkdirSync(dirname(there.transcript), { recursive: true })
  writeFileSync(there.transcript, `{"type":"user","message":{"role":"user","content":"Plan the release"},"cwd":${JSON.stringify(join(a.roots.home, 'work'))},"sessionId":"${session}"}\n`)
  writeFileSync(there.history, prompt('Plan the release'))
  await upload(a.capture, session, ...Object.values(there))
  await writeIndex(a.capture)
  const here = at(b.roots.home)
  mkdirSync(dirname(here.history), { recursive: true })
  writeFileSync(here.history, prompt('Refused on server'))
  await restore(b.capture, session, { take: true })
  appendFileSync(here.history, prompt('Ship it'))
  await upload(b.capture, session, here.history)
  await writeIndex(b.capture)

  const journaled = readFileSync(there.transcript)
  appendFileSync(there.transcript, `{"type":"user","message":{"role":"user","content":"${'one more prompt '.repeat(20)}"},"sessionId":"${session}"}\n`)
  await restore(a.capture, session, { take: true })
  expect(readFileSync(there.history, 'utf8')).toBe(`${prompt('Plan the release')}${prompt('Ship it')}`)
  expect(readFileSync(there.transcript).equals(journaled)).toBe(true)
})

test('a plan and a task the session deleted stay gone after a restore, also on a machine that kept them', async () => {
  const relay = await memoryRelay()
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
  await upload(a.capture, session, ...Object.values(there))
  await writeIndex(a.capture)
  await restore(b.capture, session, { take: true })
  const here = at(b.roots.home)
  expect([existsSync(here.task), existsSync(here.plan)]).toEqual([true, true])
  rmSync(here.plan)
  rmSync(here.task)
  await upload(b.capture, session, here.plan, here.task)
  await writeIndex(b.capture)

  await restore(a.capture, session, { take: true })
  expect([existsSync(there.task), existsSync(there.plan), existsSync(there.transcript)]).toEqual([false, false, true])
  const c = machine({ id: 'device-c', name: 'laptop', os: 'linux', arch: 'arm64' }, relay)
  await restore(c.capture, session, { take: true })
  const third = at(c.roots.home)
  expect([existsSync(third.task), existsSync(third.plan), existsSync(third.transcript)]).toEqual([false, false, true])
})

test('resume puts a repository this machine lacks beside the checkouts it has, or in the checkouts folder the person chose', async () => {
  const relay = await memoryRelay()
  const session = '55555555-0000-4000-8000-000000000005'
  const home = join(temporaryFolder(), 'home')
  const writer = machine(mac, relay, home, undefined, { captureCode: async () => ({ header: new TextEncoder().encode('header'), parts: [] }), restoreCode: async () => '' }).capture
  const cwd = join(home, 'work', 'shop')
  const transcript = join(home, '.claude', 'projects', '-work-shop', `${session}.jsonl`)
  for (const folder of [cwd, dirname(transcript)]) mkdirSync(folder, { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Ship it"},"cwd":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`)
  await upload(writer, session, transcript)
  await writer.codeRuns.get(session)
  await upload(writer, session, `${cwd}/`)
  const index = JSON.parse(new TextDecoder().decode(await relay.read(`sessions/${mac.id}/index.json`))) as Record<string, unknown>[]
  await relay.objects.put(`sessions/${mac.id}/index.json`,new TextEncoder().encode(JSON.stringify(index.map((entry) => ({ ...entry, repo: 'git@github.com:alice/shop.git', repoFolder: '' })))))

  const restoredInto = async (setUp: (folder: string, capture: Capture) => Promise<void>, checkouts?: string): Promise<string> => {
    const folder = join(temporaryFolder(), 'bob')
    const given: string[] = []
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
  const withCheckouts = async (folder: string, capture: Capture): Promise<void> => {
    for (const name of ['blog', 'docs']) {
      const repo = join(folder, 'code', name)
      mkdirSync(repo, { recursive: true })
      Bun.spawnSync(['git', 'init', '-q', repo])
      Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', `git@github.com:bob/${name}.git`])
      await recordSummary(capture, crypto.randomUUID(), 'claude', `{"type":"user","cwd":${JSON.stringify(repo)}}\n`, 1, new Date().toISOString())
    }
  }
  const ranInElsewhere = async (folder: string, capture: Capture): Promise<void> => {
    for (const [name, id] of [['code/shop', crypto.randomUUID()], ['elsewhere/shop', session]] as const) {
      const repo = join(folder, name)
      mkdirSync(repo, { recursive: true })
      Bun.spawnSync(['git', 'init', '-q', repo])
      Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', 'git@github.com:alice/shop.git'])
      await recordSummary(capture, id, 'claude', `{"type":"user","cwd":${JSON.stringify(repo)}}\n`, 1, new Date().toISOString())
    }
  }
  expect(await restoredInto(withCheckouts)).toBe('<home>/code/shop')
  expect(await restoredInto(async () => undefined)).toBe('<home>/shop')
  expect(await restoredInto(withCheckouts, '<home>/src')).toBe('<home>/src/shop')
  expect(await restoredInto(ranInElsewhere)).toBe('<home>/elsewhere/shop')
  const onDesktop = async (folder: string): Promise<void> => {
    const desktop = join(folder, 'Desktop')
    mkdirSync(desktop, { recursive: true })
    Bun.spawnSync(['git', 'init', '-q', desktop])
    Bun.spawnSync(['git', '-C', desktop, 'remote', 'add', 'origin', 'git@github.com:alice/shop.git'])
  }
  expect(await restoredInto(onDesktop)).toBe(process.platform === 'darwin' ? '<home>/shop' : '<home>/Desktop')
})

test('a session that ran on one machine in a checkout and then a worktree beside it restores whole on the other, and the old copy there goes', async () => {
  const relay = await memoryRelay()
  const session = '99999999-0000-4000-8000-000000000009'
  const remote = 'git@github.com:alice/shop.git'
  const encoded = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-')
  const checkout = (folder: string): string => {
    mkdirSync(folder, { recursive: true })
    Bun.spawnSync(['git', 'init', '-q', folder])
    Bun.spawnSync(['git', '-C', folder, 'remote', 'add', 'origin', remote])
    return folder
  }
  let diverted = ''
  const code = {
    captureCode: async () => ({ header: new TextEncoder().encode('header'), parts: [] }),
    restoreCode: async (_header: Uint8Array, _readPart: unknown, at: string): Promise<string> => {
      const target = diverted === '' ? at : diverted
      diverted = ''
      return checkout(target)
    },
  }
  const a = machine(mac, relay, join(temporaryFolder(), 'alice'), undefined, code)
  const b = machine(server, relay, join(temporaryFolder(), 'bob'), undefined, code)
  const transcriptIn = (roots: MachineRoots, cwd: string): string => join(roots.claudeHome, 'projects', encoded(cwd), `${session}.jsonl`)
  const say = async (on: ReturnType<typeof machine>, cwd: string, text: string): Promise<void> => {
    const transcript = transcriptIn(on.roots, cwd)
    mkdirSync(dirname(transcript), { recursive: true })
    appendFileSync(transcript, `{"type":"user","message":{"role":"user","content":"${text}"},"cwd":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`)
    await upload(on.capture, session, transcript)
    await on.capture.codeRuns.get(session)
    await upload(on.capture, session, `${cwd}/`)
    await writeIndex(on.capture)
  }
  const onA = checkout(join(a.roots.home, 'work', 'shop'))
  await say(a, onA, 'Plan the shop')

  const { cwd: first } = await restore(b.capture, session, { take: true, checkouts: join(b.roots.home, 'src') })
  await say(b, first, 'Book the train')
  await restore(a.capture, session, { take: true })
  await say(a, onA, 'Book the hotel')
  diverted = `${first}-0a1b2c3d`
  const { cwd: second } = await restore(b.capture, session, { take: true })
  await say(b, second, 'Pack the bags')
  await restore(a.capture, session, { take: true })

  expect(second).toBe(`${first}-0a1b2c3d`)
  expect(existsSync(transcriptIn(b.roots, first))).toBe(false)
  const lines = readFileSync(transcriptIn(a.roots, onA), 'utf8').split('\n').filter((line) => line !== '')
  expect(lines.map((line) => (JSON.parse(line) as { message: { content: string } }).message.content)).toEqual(['Plan the shop', 'Book the train', 'Book the hotel', 'Pack the bags'])
  expect(lines.every((line) => line.includes(`"cwd":${JSON.stringify(onA)}`))).toBe(true)
})

async function takenOver(isOffline: boolean) {
  const relay = await memoryRelay()
  const session = '77777777-0000-4000-8000-000000000007'
  const state = join(temporaryFolder(), 'state')
  const old = machine(mac, relay, undefined, state)
  const line = (text: string): string => `{"type":"user","message":{"role":"user","content":"${text}"},"cwd":${JSON.stringify(join(old.roots.home, 'work'))},"sessionId":"${session}"}\n`
  const transcript = join(old.roots.home, '.claude', 'projects', '-work', `${session}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, line('Plan the release'))
  await upload(old.capture, session, transcript)
  await writeIndex(old.capture)
  if (isOffline) old.capture.relay.close()
  const taker = machine(server, relay)
  if (isOffline) await until(async () => (await devicesOf(taker.capture.relay)).get(mac.id)?.connected === false)
  await restore(taker.capture, session, { take: true })
  appendFileSync(transcript, line('Keep going'))
  return { relay, session, old, state, transcript, taker }
}

test('a takeover tells the old machine at once, which refuses its next prompt and uploads nothing, with the relay stalled', async () => {
  const { relay, session, old, transcript, taker } = await takenOver(false)
  await until(() => journalOf(old.capture.db, session)?.holder === 'server')
  expect(untoldOf(taker.capture.db, session)).toBe('')
  relay.stalled = true

  const asked = performance.now()
  expect(await upload(old.capture, session, transcript)).toEqual([new Set()])
  expect(performance.now() - asked).toBeLessThan(100)
  expect(journalOf(old.capture.db, session)?.stopped).toContain('server took the session')
})

test('a restore over a turn only this machine holds, as one a sleeping machine took after another took the session, keeps that turn as a conflicted copy, once', async () => {
  const { relay, session, old, state, transcript } = await takenOver(true)
  appendFileSync(transcript, `{"type":"assistant","uuid":"only-on-mac","message":{"role":"assistant","content":"Kept going here"},"sessionId":"${session}"}\n`)
  const back = machine(mac, relay, old.roots.home, state)
  await until(() => back.capture.relay.state.is === 'connected')

  await restore(back.capture, session, { take: true })
  await restore(back.capture, session, { take: true })

  const copies = readdirSync(dirname(transcript)).filter((name) => name !== `${session}.jsonl`)
  expect(copies).toHaveLength(1)
  const copy = readFileSync(join(dirname(transcript), copies[0] ?? ''), 'utf8')
  expect(copy).toContain('Kept going here')
  expect(copy).not.toContain(`"sessionId":"${session}"`)
  expect(copy).toContain(`"customTitle":"Conflicted copy of ${session.slice(0, 8)} from mac"`)
  expect(readFileSync(transcript, 'utf8')).not.toContain('Kept going here')
})

test('a machine offline during a takeover learns it in its next welcome, before it captures, and the session opened says so once', async () => {
  const { relay, session, old, state, taker } = await takenOver(true)
  expect(journalOf(old.capture.db, session)?.holder).toBe('')
  expect([untoldOf(taker.capture.db, session), untoldOf(taker.capture.db, session)]).toEqual(['mac', 'mac'])

  const back = machine(mac, relay, old.roots.home, state)
  await until(() => back.capture.relay.state.is === 'connected')
  expect(journalOf(back.capture.db, session)).toMatchObject({ holder: 'server', stopped: expect.stringContaining('server took the session') })
})

test('a session T3 Code settled lists as archived on every machine, and one restored after that settle stays restored', async () => {
  const relay = await memoryRelay()
  const settled = 'aaaaaaaa-0000-0000-0000-00000000000a'
  const open = 'aaaaaaaa-0000-0000-0000-00000000000b'
  const { roots, capture } = machine(mac, relay)
  await upload(capture, settled, transcriptOf(roots, settled, 'Plan the trip'))
  await upload(capture, open, transcriptOf(roots, open, 'Book the train'))
  await writeIndex(capture)
  const t3 = join(temporaryFolder(), 'statev2.sqlite')
  const state = new Database(t3)
  state.run('create table orchestration_v2_projection_threads (thread_id text primary key, archived_at text, deleted_at text, updated_at text not null, payload_json text not null)')
  state.run('create table orchestration_v2_projection_provider_threads (provider_thread_id text primary key, thread_id text, payload_json text not null)')
  const thread = (id: string, session: string, settledOverride: string | null): void => {
    state.query('insert into orchestration_v2_projection_threads values (?, null, null, ?, ?)').run(id, '2026-11-10T08:00:00.000Z', JSON.stringify({ settledOverride, settledAt: settledOverride === null ? null : '2026-11-10T08:00:00.000Z' }))
    state.query('insert into orchestration_v2_projection_provider_threads values (?, ?, ?)').run(`provider-${id}`, id, JSON.stringify({ nativeThreadRef: { nativeId: session } }))
  }
  thread('thread-settled', settled, 'settled')
  thread('thread-open', open, null)
  const archivedOf = async (): Promise<Record<string, boolean>> => Object.fromEntries((await agentsOf(capture)).agents.map(({ id, archived }) => [id, archived]))

  await archiveSettledInT3(capture.relay, capture.db, t3)
  const synced = await archivedOf()
  await archive(capture.relay, settled, false)
  state.run("update orchestration_v2_projection_threads set updated_at = '2026-11-10T09:00:00.000Z' where thread_id = 'thread-open'")
  state.close()
  await archiveSettledInT3(capture.relay, capture.db, t3)

  expect(synced).toEqual({ [settled]: true, [open]: false })
  expect(await archivedOf()).toEqual({ [settled]: false, [open]: false })
})
