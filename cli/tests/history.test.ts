import { expect, onTestFinished, spyOn, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import zlib from 'node:zlib'
import { chunkKey, compressHot, decompress, encodeRecord, hotKey, indexForkStarts, journalOf, openCapture, openDatabase, piecesOf, QUIET_MS, relistSessions, REWRITE_OPS_PER_DAY, rewriteJournal, rewriteNext, rewriteProgress, seal, sealQuiet, sha256, UNREAD_FLEET, writeIndex, type Capture, type IndexedSession, type RecordHeader } from '../src/capture.ts'
import { machinesOf, type Device, type MachineRoots } from '../src/device.ts'
import { forkAgent, type MoveHere } from '../src/move.ts'
import { restore } from '../src/resume.ts'
import { agentsOf, downloadJournal } from '../src/sessions.ts'
import { forkedTranscript } from '../src/transcript.ts'
import { sharedOf } from '../src/shared.ts'
import { eventLoopDuring, failTest, memoryRelay, noCode, until, type MemoryRelay } from './memory.ts'
import { anyhostOn, captureOn, HOST, isUploaded, machineFor, serveOn, SESSION, temporaryFolder, uploadFiles } from './program.ts'

const mac: Device = { id: 'device-mac', name: 'mac', os: 'darwin', arch: 'arm64' }
const server: Device = { id: 'device-server', name: 'server', os: 'linux', arch: 'x64' }
const PARENT = 'f0f0f0f0-0000-4000-8000-000000000000'

function moverOf(capture: Capture): MoveHere {
  const queued = new Map<string, Set<string>>()
  return {
    moves: new Map(),
    answers: new Map(),
    problems: failTest,
    checkouts: '',
    opening: new Map(),
    onRecordsChange: () => () => undefined,
    queue: (session, _tool, path) => void queued.set(session, (queued.get(session) ?? new Set()).add(path)),
    flush: async (session) => {
      const paths = queued.get(session) ?? new Set()
      queued.delete(session)
      await uploadFiles(capture, session, ...paths)
    },
  }
}

function conversation(session: string, cwd: string, turns: number, saidBytes = 600): string {
  let parentUuid: string | null = null
  const lines = [JSON.stringify({ type: 'custom-title', customTitle: 'Plan the trip', sessionId: session })]
  for (let turn = 0; turn < turns; turn += 1) {
    const uuid = crypto.randomUUID()
    const role = turn % 2 === 0 ? 'user' : 'assistant'
    const said = Buffer.from(crypto.getRandomValues(new Uint8Array(saidBytes))).toString('hex')
    lines.push(JSON.stringify({ parentUuid, isSidechain: false, cwd, sessionId: session, version: '2.1.300', type: role, message: { role, content: said }, uuid, timestamp: new Date(Date.UTC(2026, 10, 14, 9, turn)).toISOString() }))
    parentUuid = uuid
  }
  return `${lines.join('\n')}\n`
}

const turnOf = (session: string, said: string, parentUuid: string | null = null): string =>
  `${JSON.stringify({ parentUuid, type: 'user', message: { role: 'user', content: said }, uuid: crypto.randomUUID(), sessionId: session })}\n`

const messagesIn = (text: string): string[] => text.split('\n').filter((line) => line.includes('"type":"user"') || line.includes('"type":"assistant"')).map((line) => (JSON.parse(line) as { uuid: string }).uuid)

const bucketBytes = async (relay: MemoryRelay): Promise<number> => {
  let total = 0
  for (let cursor: string | undefined, listed; (listed = await relay.objects.list({ ...(cursor === undefined ? {} : { cursor }) })); ) {
    for (const { key, size } of listed.objects) if (key.startsWith('journals/') || key.startsWith('chunks/') || key.startsWith('bases/')) total += size
    if (!listed.truncated) break
    cursor = listed.cursor
  }
  return total
}

async function headersOf(relay: MemoryRelay, session: string): Promise<RecordHeader[]> {
  const headers: RecordHeader[] = []
  for (const key of (await relay.keys(`journals/${session}/`)).sort()) {
    const body = await decompress((await relay.read(key)) ?? new Uint8Array())
    for (let at = 0; at < body.length; ) {
      const newline = body.indexOf(10, at)
      const header = JSON.parse(new TextDecoder().decode(body.subarray(at, newline))) as RecordHeader
      headers.push(header)
      at = newline + 1 + header.size
    }
  }
  return headers
}

async function parentOn(relay: MemoryRelay, turns = 900, home = join(temporaryFolder(), 'home'), saidBytes = 600) {
  const a = captureOn(mac, relay, home)
  const cwd = join(home, 'work')
  mkdirSync(cwd, { recursive: true })
  const folder = join(a.roots.claudeHome, 'projects', '-work')
  mkdirSync(folder, { recursive: true })
  const history = conversation(PARENT, cwd, turns, saidBytes)
  const parent = join(folder, `${PARENT}.jsonl`)
  writeFileSync(parent, history)
  await uploadFiles(a.capture, PARENT, parent)
  await writeIndex(a.capture)
  return { a, home, cwd, folder, parent, history }
}

test('30 forks of one parent at 30 different points upload the parent once, and each adds only its own lines', async () => {
  const relay = await memoryRelay()
  const { a, folder, history } = await parentOn(relay)
  const parentBytes = await bucketBytes(relay)
  const chunks = await relay.keys('chunks/')
  const messages = messagesIn(history)
  const points = Array.from({ length: 30 }, (_, index) => messages[Math.floor(((index + 1) * (messages.length - 1)) / 30)] ?? '')

  let ownLines = 0
  for (const point of points) {
    const { session } = await forkAgent(a.capture, PARENT, point, moverOf(a.capture))
    const line = turnOf(session, `Only in the fork at ${point}`, point)
    appendFileSync(join(folder, `${session}.jsonl`), line)
    ownLines += Buffer.byteLength(line)
    await uploadFiles(a.capture, session, join(folder, `${session}.jsonl`))
  }

  expect(Buffer.byteLength(history)).toBeGreaterThan(2 ** 20)
  expect(chunks.length).toBeGreaterThan(0)
  expect(await relay.keys('chunks/')).toEqual(chunks)
  expect(await relay.keys('bases/')).toEqual([])
  expect(await bucketBytes(relay)).toBeLessThan(1.2 * parentBytes + ownLines)
}, 60_000)

test('a fork, a split at an earlier message and a duplicate each restore byte-exact on another machine where the source is neither held nor present', async () => {
  const relay = await memoryRelay()
  const { a, home, folder, history } = await parentOn(relay, 300)
  const messages = messagesIn(history)
  const mover = moverOf(a.capture)
  const fork = (await forkAgent(a.capture, PARENT, '', mover)).session
  appendFileSync(join(folder, `${fork}.jsonl`), turnOf(fork, 'Go on in the fork', messages.at(-1)))
  await uploadFiles(a.capture, fork, join(folder, `${fork}.jsonl`))
  const split = (await forkAgent(a.capture, PARENT, messages[100] ?? '', mover)).session
  const duplicate = (await forkAgent(a.capture, PARENT, '', mover)).session
  const written = new Map([fork, split, duplicate].map((session) => [session, readFileSync(join(folder, `${session}.jsonl`), 'utf8')]))
  await writeIndex(a.capture)

  rmSync(a.roots.claudeHome, { recursive: true })
  const b = captureOn(server, relay, home)
  for (const session of [fork, split, duplicate]) await restore(b.capture, session, { take: true })

  for (const [session, text] of written) expect(readFileSync(join(folder, `${session}.jsonl`), 'utf8')).toBe(text)
  expect(written.get(split)?.split('\n').filter((line) => line.includes('"forkedFrom"'))).toHaveLength(101)
  expect(written.get(duplicate)).toContain(`"forkedFrom":{"sessionId":"${PARENT}","messageUuid":"${messages.at(-1)}"}`)
  expect(readFileSync(join(folder, `${fork}.jsonl`), 'utf8')).toContain('Go on in the fork')
  expect((await relay.claims()).get(PARENT)).toBe(mac.id)
  expect((await sharedOf(b.capture.relay)).parents).toEqual({})
  expect([fork, split, duplicate].map((session) => b.capture.db.query<{ source: string }, [string]>('select source from sessions where id = ?').get(session)?.source)).toEqual([PARENT, PARENT, PARENT])
}, 60_000)

test('a fork lists at once, titled after its source, and its first record names the source chunks it derives from', async () => {
  const relay = await memoryRelay()
  const { a, folder } = await parentOn(relay, 300)
  const { session } = await forkAgent(a.capture, PARENT.slice(0, 8), '', moverOf(a.capture))

  const [first] = await headersOf(relay, session)
  expect(first).toMatchObject({ path: join(folder, `${session}.jsonl`), at: 0, size: 0, fork: { session, source: PARENT, title: 'Plan the trip (fork)' } })
  expect(first?.chunks?.every(([name]) => name.length === 64)).toBe(true)
  expect(a.capture.db.query<{ title: string }, [string]>('select title from sessions where id = ?').get(session)?.title).toBe('Plan the trip (fork)')
})

test('anyhost fork asks the program, which forks the session it holds into one that lists at once, titled after it, with it as source and no parent', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  await serveOn(host.env)
  const folder = join(host.env['HOME'] ?? '', '.claude', 'projects', '-work')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, `${SESSION}.jsonl`), conversation(SESSION, join(host.env['HOME'] ?? '', 'work'), 20))
  await until(() => isUploaded(relay, SESSION, 'Plan the trip'), 'The source went up')

  const forked = await anyhostOn(host.env, ['fork', SESSION.slice(0, 8)])
  const session = /into ([0-9a-f-]{36}) on anyhost-a\.$/m.exec(forked.out)?.[1] ?? ''
  const listed = JSON.parse((await anyhostOn(host.env, ['list', '--json'])).out) as { readonly agents: readonly { readonly id: string; readonly title: string; readonly parent: string; readonly source: string }[] }
  const brief = JSON.parse((await anyhostOn(host.env, ['list', '--json', '--brief'])).out) as { readonly agents: readonly { readonly id: string; readonly source: string }[] }
  const shared = JSON.parse(new TextDecoder().decode((await relay.read('shared.json')) ?? new TextEncoder().encode('{}'))) as { readonly parents?: Readonly<Record<string, string>> }

  expect([forked.code, forked.err]).toEqual([0, ''])
  expect(readFileSync(join(folder, `${session}.jsonl`), 'utf8')).toContain(`"forkedFrom":{"sessionId":"${SESSION}"`)
  expect(listed.agents.find(({ id }) => id === session)).toMatchObject({ title: 'Plan the trip (fork)', parent: '', source: SESSION })
  expect(listed.agents.find(({ id }) => id === SESSION)).toMatchObject({ parent: '', source: '' })
  expect(brief.agents.find(({ id }) => id === session)?.source).toBe(SESSION)
  expect(shared.parents?.[session]).toBeUndefined()
}, 60_000)

test('a fork moves to another machine and back, and its later turns append as ordinary records', async () => {
  const relay = await memoryRelay()
  const { a, home, folder } = await parentOn(relay, 300)
  const { session } = await forkAgent(a.capture, PARENT, '', moverOf(a.capture))
  const path = join(folder, `${session}.jsonl`)
  const forked = readFileSync(path, 'utf8')
  const b = captureOn(server, relay)
  const there = join(b.roots.claudeHome, 'projects', '-work', `${session}.jsonl`)

  await restore(b.capture, session, { take: true, isMove: true })
  expect(readFileSync(there, 'utf8')).toBe(forked.replaceAll(home, b.roots.home))
  appendFileSync(there, turnOf(session, 'Continue on server'))
  await uploadFiles(b.capture, session, there)
  await writeIndex(b.capture)
  await restore(a.capture, session, { take: true, isMove: true })

  expect(readFileSync(path, 'utf8')).toBe(readFileSync(there, 'utf8').replaceAll(b.roots.home, home))
  const headers = (await headersOf(relay, session)).filter((header) => header.path.endsWith(`${session}.jsonl`))
  expect(headers.map(({ device, at, fork }) => ({ device, at, isDerived: fork !== undefined }))).toEqual([
    { device: mac.id, at: 0, isDerived: true },
    { device: server.id, at: Buffer.byteLength(forked), isDerived: false },
  ])
}, 60_000)

const rewrittenFork = (history: string, fork: string, said: string): string =>
  `{"type":"history-suppression","sessionId":"${fork}","cause":"fork_inherit"}\n${history.replaceAll(PARENT, fork).replaceAll('"version":"2.1.300"', '"version":"2.1.322"')}${turnOf(fork, said)}`

test("a fork Claude Code wrote itself goes up as deltas against the parent's chunks that hold its lines, and restores byte-exact", async () => {
  const relay = await memoryRelay()
  const { a, home, folder, history } = await parentOn(relay)
  const parentBytes = await bucketBytes(relay)
  const fork = 'f0f0f0f0-0000-4000-8000-000000000001'
  const path = join(folder, `${fork}.jsonl`)
  const text = rewrittenFork(history, fork, 'Only in the fork')
  writeFileSync(path, text)
  await uploadFiles(a.capture, fork, path)
  await writeIndex(a.capture)

  const [first] = await headersOf(relay, fork)
  expect(first).toMatchObject({ at: 0, size: 0, after: { size: Buffer.byteLength(text) } })
  expect(first?.fork).toBeUndefined()
  expect((await bucketBytes(relay)) - parentBytes).toBeLessThan(parentBytes * 0.1)
  rmSync(a.roots.claudeHome, { recursive: true })
  const b = captureOn(server, relay, home)
  await restore(b.capture, fork, { take: true })
  expect(readFileSync(path, 'utf8')).toBe(text)
}, 60_000)

async function branchedOn(relay: MemoryRelay) {
  const on = await parentOn(relay, 20)
  const fork = 'f0f0f0f0-0000-4000-8000-000000000001'
  const path = join(on.folder, `${fork}.jsonl`)
  const copied = on.history.split('\n').filter((line) => line.includes('"uuid"')).map((line) => {
    const entry = JSON.parse(line) as { readonly uuid: string }
    return `${JSON.stringify({ ...entry, sessionId: fork, forkedFrom: { sessionId: PARENT, messageUuid: entry.uuid } })}\n`
  })
  const reply = `${JSON.stringify({ parentUuid: null, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Booked the train in the branch.' }] }, uuid: crypto.randomUUID(), sessionId: fork, timestamp: '2026-11-14T10:00:00.000Z' })}\n`
  writeFileSync(path, `${copied.join('')}${JSON.stringify({ type: 'custom-title', customTitle: 'Plan the trip (Branch)', sessionId: fork })}\n${reply}`)
  await uploadFiles(on.a.capture, fork, path)
  await writeIndex(on.a.capture)
  return { ...on, fork }
}

test("a transcript whose lines carry Claude Code's own forkedFrom lists with that session as its source and no parent", async () => {
  const relay = await memoryRelay()
  const { a, fork } = await branchedOn(relay)

  const { agents } = await agentsOf(a.capture, {}, new Map())

  expect(agents.find(({ id }) => id === fork)).toMatchObject({ title: 'Plan the trip (Branch)', source: PARENT, parent: '' })
  expect(agents.find(({ id }) => id === PARENT)).toMatchObject({ source: '', parent: '' })
})

test('a row read with the rules before the source was read gains its source at the next relist, and a row read with these rules is not read again', async () => {
  const relay = await memoryRelay()
  const { a, fork } = await branchedOn(relay)
  a.capture.db.query("update sessions set source = '', titled = 1 where id = ?").run(fork)

  await relistSessions(a.capture)
  const relisted = a.capture.db.query<{ source: string }, [string]>('select source from sessions where id = ?').get(fork)?.source
  a.capture.db.query("update sessions set source = '' where id = ?").run(fork)
  await relistSessions(a.capture)

  expect(relisted).toBe(PARENT)
  expect(a.capture.db.query<{ source: string }, [string]>('select source from sessions where id = ?').get(fork)?.source).toBe('')
})

test("forks of a parent over 16 MiB, one anyhost's and one Claude Code wrote, go up as references to its several chunks and as deltas against them, and restore byte-exact", async () => {
  const relay = await memoryRelay()
  const { a, home, folder, history } = await parentOn(relay, 2200, undefined, 6000)
  const parentBytes = await bucketBytes(relay)
  const messages = messagesIn(history)
  const derived = (await forkAgent(a.capture, PARENT, messages[1500] ?? '', moverOf(a.capture))).session
  const fork = 'f0f0f0f0-0000-4000-8000-000000000001'
  const text = rewrittenFork(history, fork, 'Only in the big fork')
  writeFileSync(join(folder, `${fork}.jsonl`), text)
  await uploadFiles(a.capture, fork, join(folder, `${fork}.jsonl`))
  await writeIndex(a.capture)
  const split = readFileSync(join(folder, `${derived}.jsonl`), 'utf8')

  expect(Buffer.byteLength(history)).toBeGreaterThan(16 * 2 ** 20)
  expect((await headersOf(relay, derived))[0]?.chunks?.length).toBeGreaterThan(1)
  expect((await headersOf(relay, fork))[0]?.chunks?.length).toBeGreaterThan(1)
  expect((await bucketBytes(relay)) - parentBytes).toBeLessThan(parentBytes * 0.05)
  rmSync(a.roots.claudeHome, { recursive: true })
  const b = captureOn(server, relay, home)
  await restore(b.capture, derived, { take: true })
  await restore(b.capture, fork, { take: true })
  expect(readFileSync(join(folder, `${derived}.jsonl`), 'utf8')).toBe(split)
  expect(readFileSync(join(folder, `${fork}.jsonl`), 'utf8')).toBe(text)
}, 120_000)

test("a fork Claude Code wrote from its parent's compact boundary, of a parent this program never uploaded, finds it once the start's index read every transcript here, and restores byte-exact", async () => {
  const relay = await memoryRelay()
  const home = join(temporaryFolder(), 'home')
  const a = captureOn(mac, relay, home)
  const cwd = join(home, 'work')
  const folder = join(a.roots.claudeHome, 'projects', '-work')
  mkdirSync(folder, { recursive: true })
  const before = conversation(PARENT, cwd, 400)
  const boundary = crypto.randomUUID()
  const compacted = `${JSON.stringify({ parentUuid: null, logicalParentUuid: messagesIn(before).at(-1), isSidechain: false, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', cwd, sessionId: PARENT, version: '2.1.300', uuid: boundary })}\n`
  const since = `${compacted}${conversation(PARENT, cwd, 900).split('\n').slice(1).join('\n')}`
  writeFileSync(join(folder, `${PARENT}.jsonl`), `${before}${since}`)
  const indexed = [await indexForkStarts(a.capture), await indexForkStarts(a.capture)]
  const fork = 'f0f0f0f0-0000-4000-8000-000000000001'
  const text = `{"type":"history-suppression","sessionId":"${fork}","cause":"fork_inherit"}\n${since.replaceAll(PARENT, fork)}${turnOf(fork, 'Only in the fork')}`
  writeFileSync(join(folder, `${fork}.jsonl`), text)
  await uploadFiles(a.capture, fork, join(folder, `${fork}.jsonl`))
  await writeIndex(a.capture)

  const deltas: string[] = []
  for (const key of await relay.keys('chunks/')) if (new TextDecoder().decode((await relay.read(key))?.subarray(0, 8)) === '{"base":') deltas.push(key)
  expect(indexed).toEqual([1, 0])
  expect((await headersOf(relay, fork))[0]?.chunks).toBeDefined()
  expect(deltas.length).toBeGreaterThan(0)
  rmSync(a.roots.claudeHome, { recursive: true })
  const b = captureOn(server, relay, home)
  await restore(b.capture, fork, { take: true })
  expect(readFileSync(join(folder, `${fork}.jsonl`), 'utf8')).toBe(text)
}, 60_000)

test('a fork whose parent is on no machine it is captured on goes up as plain chunks, and restores byte-exact', async () => {
  const relay = await memoryRelay()
  const { history, home } = await parentOn(relay)
  const b = captureOn(server, relay)
  const other = 'f0f0f0f0-0000-4000-8000-000000000003'
  const path = join(b.roots.claudeHome, 'projects', '-work', `${other}.jsonl`)
  mkdirSync(dirname(path), { recursive: true })
  const text = rewrittenFork(history, other, 'Only here')
  writeFileSync(path, text)
  const before = new Set(await relay.keys('chunks/'))
  await uploadFiles(b.capture, other, path)
  await writeIndex(b.capture)

  const added = (await relay.keys('chunks/')).filter((key) => !before.has(key))
  expect(added.length).toBeGreaterThan(0)
  for (const key of added) expect(new TextDecoder().decode((await relay.read(key))?.subarray(0, 3))).toBe('{}\n')
  const c = captureOn(mac, relay, home)
  await restore(c.capture, other, { take: true })
  expect(readFileSync(join(c.roots.claudeHome, 'projects', '-work', `${other}.jsonl`), 'utf8')).toBe(text.replaceAll(b.roots.home, home))
}, 60_000)

test('a chunk whose delta does not round-trip goes up whole, and still restores byte-exact', async () => {
  const relay = await memoryRelay()
  const { a, home, folder, history } = await parentOn(relay)
  const parentBytes = await bucketBytes(relay)
  const decompressed = zlib.zstdDecompress
  const spied = spyOn(zlib, 'zstdDecompress').mockImplementation(((bytes: zlib.InputType, options: zlib.ZstdOptions, done: zlib.CompressCallback) =>
    decompressed(bytes, options, (error, out) => {
      if ('dictionary' in options) out[0] = (out[0] ?? 0) ^ 1
      done(error, out)
    })) as typeof zlib.zstdDecompress)
  onTestFinished(() => spied.mockRestore())
  const fork = 'f0f0f0f0-0000-4000-8000-000000000001'
  const path = join(folder, `${fork}.jsonl`)
  const text = rewrittenFork(history, fork, 'Only in the fork')
  writeFileSync(path, text)
  await uploadFiles(a.capture, fork, path)
  await writeIndex(a.capture)
  spied.mockRestore()

  for (const key of await relay.keys('chunks/')) expect(new TextDecoder().decode((await relay.read(key))?.subarray(0, 3))).toBe('{}\n')
  expect((await bucketBytes(relay)) - parentBytes).toBeGreaterThan(parentBytes * 0.5)
  rmSync(a.roots.claudeHome, { recursive: true })
  const b = captureOn(server, relay, home)
  await restore(b.capture, fork, { take: true })
  expect(readFileSync(path, 'utf8')).toBe(text)
}, 60_000)

test('a whole copy under 1 MiB stays in its record, and one of 1 MiB or more goes up as chunks that a second machine reads back', async () => {
  const relay = await memoryRelay()
  const { a, home, parent, history } = await parentOn(relay, 120)
  const small = (await headersOf(relay, PARENT))[0]
  appendFileSync(parent, conversation(PARENT, join(home, 'work'), 900).split('\n').slice(1).join('\n'))
  await uploadFiles(a.capture, PARENT, parent)
  const grown = readFileSync(parent, 'utf8')
  await writeIndex(a.capture)

  const [, big] = await headersOf(relay, PARENT)
  expect(small).toMatchObject({ at: 0, size: Buffer.byteLength(history) })
  expect(small?.chunks).toBeUndefined()
  expect(big).toMatchObject({ at: Buffer.byteLength(history), size: 0 })
  expect(big?.chunks?.length).toBeGreaterThan(0)
  rmSync(a.roots.claudeHome, { recursive: true })
  const b = captureOn(server, relay, home)
  await restore(b.capture, PARENT, { take: true })
  expect(readFileSync(parent, 'utf8')).toBe(grown)
  expect(dirname(parent)).toBe(join(b.roots.claudeHome, 'projects', '-work'))
}, 60_000)

const position = (at: number): string => String(at).padStart(16, '0')
const C = zlib.constants

function oldDelta(bytes: Uint8Array, base: Uint8Array): Uint8Array {
  const compressed = zlib.zstdCompressSync(bytes, { params: { [C.ZSTD_c_compressionLevel]: 3, [C.ZSTD_c_windowLog]: 24 }, dictionary: base } as zlib.ZstdOptions)
  return Buffer.concat([Buffer.from(`${JSON.stringify({ size: compressed.length, from: 0, to: base.length })}\n`), compressed])
}

async function replayedOf(relay: MemoryRelay, session: string): Promise<Map<string, string>> {
  const reader: Device = { id: 'device-reader', name: 'reader', os: 'linux', arch: 'x64' }
  const replayed = await downloadJournal(relay.connect(reader, { home: '/x', claudeHome: '/x/.claude', claudeTmp: '/x/tmp', codexHome: '/x/.codex' }), session, temporaryFolder(), ({ path }) => path)
  const texts = new Map<string, string>()
  for (const [path, file] of replayed.files) {
    const bytes = readFileSync(file.staged)
    expect({ path, size: bytes.length, sha256: sha256(bytes) }).toEqual({ path, size: file.last.after.size, sha256: file.last.after.sha256 })
    texts.set(path, bytes.toString('utf8'))
  }
  return texts
}

async function oldFormOn(relay: MemoryRelay, home: string) {
  const writer = captureOn(mac, relay, home)
  await writer.capture.relay.runOne({ op: 'devices' })
  const fork = 'f0f0f0f0-0000-4000-8000-000000000001'
  const folder = join(writer.roots.claudeHome, 'projects', '-work')
  const transcript = join(folder, `${fork}.jsonl`)
  const output = join(folder, fork, 'tool-results', 'b1.txt')
  const history = conversation(PARENT, join(home, 'work'), 900)
  const base = Buffer.from(history.slice(history.indexOf('\n') + 1))
  const forked = rewrittenFork(history, fork, 'Only in the fork')
  const turn = turnOf(fork, 'Book the train')
  const at = (header: Omit<RecordHeader, 'device'>, body: string | Uint8Array): Uint8Array[] => encodeRecord({ device: mac.id, ...header }, typeof body === 'string' ? Buffer.from(body) : body)
  const after = (text: string) => ({ size: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)) })
  const baseName = sha256(base)
  const compacted = Buffer.concat([
    ...at({ path: output, at: 0, size: Buffer.byteLength('the first output\n'), after: after('the first output\n') }, 'the first output\n'),
    ...((delta) => at({ path: transcript, at: 0, size: delta.length, after: after(forked), base: baseName }, delta))(oldDelta(Buffer.from(forked), base)),
  ])
  const sealed = Buffer.concat([
    ...at({ path: output, at: 0, size: Buffer.byteLength('the second output\n'), after: after('the second output\n') }, 'the second output\n'),
    ...at({ path: transcript, at: Buffer.byteLength(forked), size: Buffer.byteLength(turn), after: after(`${forked}${turn}`) }, turn),
  ])
  const end = compacted.length + sealed.length
  await relay.objects.put(`bases/${baseName}`, zlib.zstdCompressSync(base))
  await relay.objects.put(`journals/${fork}/compacted/${position(0)}-${position(compacted.length)}.zst`, await compressHot(compacted))
  await relay.objects.put(`journals/${fork}/sealed/${position(compacted.length)}-${position(end)}.zst`, await compressHot(sealed))
  const entry: IndexedSession = { id: fork, tool: 'claude', title: 'Plan the trip', firstPrompt: 'Only in the fork', cwd: join(home, 'work'), repo: '', repoFolder: '', entrypoint: 'cli', lastSaid: '', lastActivity: '2026-11-14T09:00:00.000Z', lastPromptAt: '', source: '', size: end, deleted: false }
  await relay.objects.put(`sessions/${mac.id}/index.json`, JSON.stringify([entry]))
  return { fork, transcript, output, written: new Map([[transcript, `${forked}${turn}`], [output, 'the second output\n']]) }
}

test('the transition rewrites a journal of plain records, a base record and a compacted frame into chunks, a crash between its upload and the old frames going loses nothing, and a second run changes nothing', async () => {
  const relay = await memoryRelay()
  const home = join(temporaryFolder(), 'home')
  const { fork, transcript, output, written } = await oldFormOn(relay, home)
  expect(await replayedOf(relay, fork)).toEqual(written)
  const before = captureOn(server, relay, home)
  await restore(before.capture, fork, { take: true })
  const placed = [written.get(transcript) ?? '', written.get(output) ?? '']
  expect([readFileSync(transcript, 'utf8'), readFileSync(output, 'utf8')]).toEqual(placed)

  rmSync(join(home, '.claude'), { recursive: true })
  const holder = captureOn(mac, relay, home)
  await restore(holder.capture, fork, { take: true })
  const oldKeys = await relay.keys(`journals/${fork}/`)
  relay.before = (op) => (op.op === 'get' && /\/next\/\d{16}-\d{16}-\d{16}\.zst$/.test(op.key) ? new Promise<void>(() => undefined) : undefined)
  void rewriteJournal(holder.capture, fork, 'claude', Date.now(), { lagMs: 0, isForced: true }).catch(() => undefined)
  await until(async () => (await relay.keys(`journals/${fork}/`)).length > oldKeys.length, 'The rewrite uploaded its frame')
  relay.before = () => undefined
  expect(await replayedOf(relay, fork)).toEqual(written)

  const resumed = await rewriteJournal(holder.capture, fork, 'claude', Date.now() + 1, { lagMs: 0, isForced: true })
  await sealQuiet(holder.capture, failTest, Date.now() + QUIET_MS + 1)
  const keys = await relay.keys(`journals/${fork}/`)
  const again =await rewriteJournal(holder.capture, fork, 'claude', Date.now() + 2, { lagMs: 0, isForced: true })

  expect(resumed?.isCurrent).toBe(true)
  expect(again?.isCurrent).toBe(true)
  expect(keys).toHaveLength(1)
  expect(keys[0]).toMatch(new RegExp(`^journals/${fork}/compacted/${position(0)}-${position(journalOf(holder.capture.db, fork)?.end ?? -1)}-\\d{16}\\.zst$`))
  expect(await relay.keys(`journals/${fork}/`)).toEqual(keys)
  const headers = (await headersOf(relay, fork)).map(({ path, at, base, chunks }) => ({ path, at, isBase: base !== undefined, isChunked: chunks !== undefined }))
  expect(headers).toEqual([
    { path: output, at: 0, isBase: false, isChunked: false },
    { path: transcript, at: 0, isBase: false, isChunked: true },
  ])
  expect(await replayedOf(relay, fork)).toEqual(written)
  rmSync(join(home, '.claude'), { recursive: true })
  const after = captureOn(server, relay, home)
  await restore(after.capture, fork, { take: true })
  expect([readFileSync(transcript, 'utf8'), readFileSync(output, 'utf8')]).toEqual(placed)
}, 60_000)

const rewrittenIn = async (relay: MemoryRelay): Promise<string[]> => (await relay.keys('journals/')).filter((key) => key.endsWith('/rewritten')).map((key) => key.split('/')[1] ?? '').sort()

test('the transition takes one sealed journal it holds each pass, marks it rewritten in R2, never takes it again, and stops for the day at its budget', async () => {
  const relay = await memoryRelay()
  const { a, folder, cwd } = await parentOn(relay, 300)
  const other = 'f0f0f0f0-0000-4000-8000-000000000002'
  writeFileSync(join(folder, `${other}.jsonl`), conversation(other, cwd, 900))
  await uploadFiles(a.capture, other, join(folder, `${other}.jsonl`))
  const sealed = await rewriteNext(a.capture, failTest)
  await sealQuiet(a.capture, failTest, Date.now() + QUIET_MS + 1)

  const passes = [sealed, await rewriteNext(a.capture, failTest), await rewriteNext(a.capture, failTest), await rewriteNext(a.capture, failTest)]

  expect(passes.slice(0, 1)).toEqual([undefined])
  expect(new Set(passes.slice(1, 3))).toEqual(new Set([PARENT, other]))
  expect(passes[3]).toBeUndefined()
  expect(rewriteProgress(a.capture)).toEqual({ done: 2, journals: 2, olderMachines: [] })
  expect(await rewrittenIn(relay)).toEqual([PARENT, other].sort())

  a.capture.db.run('delete from rewrites')
  a.capture.db.query('insert into rewrites (session, done, at, ops) values (?, 0, ?, ?)').run('spent', Date.now(), REWRITE_OPS_PER_DAY)
  expect(await rewriteNext(a.capture, failTest)).toBeUndefined()
}, 60_000)

test('the transition rewrites a journal this machine holds whose local row is gone, as after its database dropped, once and without a row', async () => {
  const relay = await memoryRelay()
  const { a, home, parent, history } = await parentOn(relay, 300)
  await sealQuiet(a.capture, failTest, Date.now() + QUIET_MS + 1)
  const again = captureOn(mac, relay, home)

  const passes = [await rewriteNext(again.capture, failTest), await rewriteNext(again.capture, failTest)]

  expect(passes).toEqual([PARENT, undefined])
  expect(journalOf(again.capture.db, PARENT)).toBeUndefined()
  expect(rewriteProgress(again.capture)).toEqual({ done: 1, journals: 1, olderMachines: [] })
  expect((await relay.claims()).get(PARENT)).toBe(mac.id)
  expect((await replayedOf(relay, PARENT)).get(parent)).toBe(history)
}, 60_000)

test('a rewrite the program stopped in the middle of waits a day as a failed one does, instead of starting over at the next start', async () => {
  const relay = await memoryRelay()
  const { a, parent, history } = await parentOn(relay, 4)
  await sealQuiet(a.capture, failTest, Date.now() + QUIET_MS + 1)
  let isListing = false
  relay.before = (op) => (op.op === 'list' && op.prefix === `journals/${PARENT}/` ? ((isListing = true), new Promise<void>(() => undefined)) : undefined)
  void rewriteNext(a.capture, failTest).catch(() => undefined)
  await until(() => isListing, 'the rewrite listing the journal')
  relay.before = () => undefined
  const restarted = openCapture(relay.connect(mac, a.roots), mac, a.roots, { db: openDatabase(dirname(a.capture.db.filename)), code: noCode, codeEveryMs: 0 })

  const passes = [await rewriteNext(restarted, failTest), await rewriteNext(restarted, failTest, Date.now() + 86_400_000 + 1)]

  expect(passes).toEqual([undefined, PARENT])
  expect(rewriteProgress(restarted)).toEqual({ done: 1, journals: 1, olderMachines: [] })
  expect((await replayedOf(relay, PARENT)).get(parent)).toBe(history)
}, 60_000)

const gone: Device = { id: 'device-gone', name: 'gone', os: 'linux', arch: 'x64' }
const third: Device = { id: 'device-third', name: 'third', os: 'linux', arch: 'x64' }
const isChunkForm = async (relay: MemoryRelay, session: string): Promise<boolean> => (await headersOf(relay, session)).every(({ base }) => base === undefined)

test("a live machine rewrites the old-form journal a removed machine holds, every file replays byte for byte, nobody holds it after, and another machine then takes and restores it", async () => {
  const relay = await memoryRelay()
  const home = join(temporaryFolder(), 'home')
  const { fork, transcript, output, written } = await oldFormOn(relay, home)
  const lender = relay.connect(gone, rootsAt(join(temporaryFolder(), 'gone')))
  await lender.runOne({ op: 'claim', session: fork, take: false })
  lender.close()
  const b = captureOn(server, relay)
  await b.capture.relay.runOne({ op: 'remove', device: gone.id })
  const before = (await relay.claims()).get(fork)

  const passes = [await rewriteNext(b.capture, failTest), await rewriteNext(b.capture, failTest)]

  expect(before).toBe(gone.id)
  expect(passes).toEqual([fork, undefined])
  expect(await replayedOf(relay, fork)).toEqual(written)
  expect(await isChunkForm(relay, fork)).toBe(true)
  expect((await relay.claims()).has(fork)).toBe(false)
  expect(await relay.keys(`journals/${fork}/`)).toEqual([expect.stringMatching(new RegExp(`^journals/${fork}/compacted/\\d{16}-\\d{16}-0000000000000001\\.zst$`)), `journals/${fork}/rewritten`])
  expect(b.capture.db.query('select * from borrowed_claims').all()).toEqual([])
  const c = captureOn(third, relay, home)
  await restore(c.capture, fork, { take: true })
  expect(new Map([transcript, output].map((path) => [path, readFileSync(path, 'utf8')]))).toEqual(written)
  expect((await relay.claims()).get(fork)).toBe(third.id)
}, 60_000)

test('two machines race for one journal nobody holds, and exactly one of them rewrites it', async () => {
  const relay = await memoryRelay()
  const { fork, written } = await oldFormOn(relay, join(temporaryFolder(), 'home'))
  const [b, c] = [captureOn(server, relay), captureOn(third, relay)]

  const passes = await Promise.all([rewriteNext(b.capture, failTest), rewriteNext(c.capture, failTest)])

  expect(passes).toEqual([fork, fork])
  expect(relay.puts.filter(({ key }) => key.startsWith(`journals/${fork}/next/`))).toHaveLength(1)
  expect(relay.puts.filter(({ key }) => key.startsWith(`journals/${fork}/compacted/`))).toHaveLength(1)
  expect(await relay.keys(`journals/${fork}/`)).toEqual([expect.stringMatching(/\/compacted\/\d{16}-\d{16}-0000000000000001\.zst$/), `journals/${fork}/rewritten`])
  expect((await relay.claims()).has(fork)).toBe(false)
  expect(await replayedOf(relay, fork)).toEqual(written)
  expect(await Promise.all([rewriteNext(b.capture, failTest), rewriteNext(c.capture, failTest)])).toEqual([undefined, undefined])
}, 60_000)

test('an open on the same machine during a rewrite of a journal it borrowed keeps that machine its claim after the rewrite, and the journal still replays byte for byte', async () => {
  const relay = await memoryRelay()
  const home = join(temporaryFolder(), 'home')
  const { fork, transcript, output, written } = await oldFormOn(relay, home)
  const b = captureOn(server, relay, home)
  let release = (): void => undefined
  let isHeld = false
  relay.before = (op) => (!isHeld && op.op === 'get' && op.key.startsWith(`journals/${fork}/next/`) ? ((isHeld = true), new Promise<void>((resolve) => (release = resolve))) : undefined)
  const rewriting = rewriteNext(b.capture, failTest)
  await until(() => isHeld, 'the rewrite reading its frame back')

  await restore(b.capture, fork, { take: true, if: { gone: true } })
  release()
  const pass = await rewriting

  expect(pass).toBe(fork)
  expect((await relay.claims()).get(fork)).toBe(server.id)
  expect(b.capture.db.query('select * from borrowed_claims').all()).toEqual([])
  expect(new Map([transcript, output].map((path) => [path, readFileSync(path, 'utf8')]))).toEqual(written)
  expect(await relay.keys(`journals/${fork}/rewritten`)).toEqual([`journals/${fork}/rewritten`])
  expect(await replayedOf(relay, fork)).toEqual(written)
}, 60_000)

test('a rewrite of a journal nobody holds that the program stopped in the middle of leaves the chain sound, gives the claim back at the next pass, and the pass after its day finishes it', async () => {
  const relay = await memoryRelay()
  const { fork, written } = await oldFormOn(relay, join(temporaryFolder(), 'home'))
  const b = captureOn(server, relay)
  let isHeld = false
  relay.before = (op) => (!isHeld && op.op === 'get' && op.key.startsWith(`journals/${fork}/next/`) ? ((isHeld = true), new Promise<void>(() => undefined)) : undefined)
  void rewriteNext(b.capture, failTest).catch(() => undefined)
  await until(() => isHeld, 'the rewrite reading its frame back')
  const stopped = { holder: (await relay.claims()).get(fork), replayed: await replayedOf(relay, fork) }
  const restarted = openCapture(relay.connect(server, b.roots), server, b.roots, { db: openDatabase(dirname(b.capture.db.filename)), code: noCode, codeEveryMs: 0 })

  const first = await rewriteNext(restarted, failTest)
  const given = (await relay.claims()).has(fork)
  const finished = await rewriteNext(restarted, failTest, Date.now() + 86_400_000 + 1)

  expect(stopped).toEqual({ holder: server.id, replayed: written })
  expect([first, given, finished]).toEqual([undefined, false, fork])
  expect((await relay.claims()).has(fork)).toBe(false)
  expect(await isChunkForm(relay, fork)).toBe(true)
  expect(await relay.keys(`journals/${fork}/`)).toEqual([expect.stringMatching(/\/compacted\/\d{16}-\d{16}-0000000000000001\.zst$/), `journals/${fork}/rewritten`])
  expect(await replayedOf(relay, fork)).toEqual(written)
}, 60_000)

test('every machine reads not yet while one journal nobody holds keeps its old form, and done once one machine rewrote it', async () => {
  const relay = await memoryRelay()
  const { fork } = await oldFormOn(relay, join(temporaryFolder(), 'home'))
  const [b, c] = [captureOn(server, relay), captureOn(third, relay)]
  b.capture.db.query('insert into rewrites (session, done, at, ops) values (?, 0, ?, ?)').run('spent', Date.now(), REWRITE_OPS_PER_DAY)

  const spent = [await rewriteNext(b.capture, failTest), rewriteProgress(b.capture)]
  b.capture.db.run("delete from rewrites where session = 'spent'")
  const rewritten = [await rewriteNext(b.capture, failTest), rewriteProgress(b.capture)]
  const elsewhere = [await rewriteNext(c.capture, failTest), rewriteProgress(c.capture)]

  expect(spent).toEqual([undefined, { done: 0, journals: 1, olderMachines: [] }])
  expect(rewritten).toEqual([fork, { done: 1, journals: 1, olderMachines: [] }])
  expect(elsewhere).toEqual([undefined, { done: 1, journals: 1, olderMachines: [] }])
}, 60_000)

test("the program deletes a rewrite's staging it left behind as it starts", async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  const compact = join(host.env['XDG_STATE_HOME'] ?? '', 'anyhost', 'compact')
  mkdirSync(join(compact, `${SESSION}.check`, 'before'), { recursive: true })
  writeFileSync(join(compact, SESSION), 'a staged journal')
  writeFileSync(join(compact, `${SESSION}.check`, 'before', 'transcript'), 'a replayed file')

  await serveOn(host.env)

  expect(existsSync(compact)).toBe(false)
}, 60_000)

test("a rewrite folds a parent's appends into one chunked record, and a fork restores byte-exact after its parent's journal was rewritten and after its parent was deleted", async () => {
  const relay = await memoryRelay()
  const { a, home, folder, parent, cwd } = await parentOn(relay, 300)
  const { session } = await forkAgent(a.capture, PARENT, '', moverOf(a.capture))
  const forked = readFileSync(join(folder, `${session}.jsonl`), 'utf8')
  for (let turn = 0; turn < 3; turn += 1) {
    appendFileSync(parent, conversation(PARENT, cwd, 300).split('\n').slice(1).join('\n'))
    await uploadFiles(a.capture, PARENT, parent)
  }
  const grown = readFileSync(parent, 'utf8')
  await sealQuiet(a.capture, failTest, Date.now() + QUIET_MS + 1)
  const compacted = await rewriteJournal(a.capture, PARENT, 'claude', Date.now(), { lagMs: 0, isForced: true })
  await sealQuiet(a.capture, failTest, Date.now() + QUIET_MS + 2)

  expect(compacted?.isCurrent).toBe(true)
  expect((await headersOf(relay, PARENT)).filter(({ path }) => path === parent).map(({ at, chunks }) => ({ at, isChunked: chunks !== undefined }))).toEqual([{ at: 0, isChunked: true }])
  expect((await replayedOf(relay, PARENT)).get(parent)).toBe(grown)
  rmSync(parent)
  await uploadFiles(a.capture, PARENT, parent)
  await writeIndex(a.capture)
  rmSync(a.roots.claudeHome, { recursive: true })
  const b = captureOn(server, relay, home)
  await restore(b.capture, session, { take: true })
  expect(readFileSync(join(folder, `${session}.jsonl`), 'utf8')).toBe(forked)
}, 60_000)

test('a session R2 holds whose local database lost its row restores with its new lines right after the first upload, and uploads it whole at most once', async () => {
  const relay = await memoryRelay()
  const { a, home, parent } = await parentOn(relay, 300)
  await sealQuiet(a.capture, failTest, Date.now() + QUIET_MS + 1)
  appendFileSync(parent, turnOf(PARENT, 'Sent before the database went'))
  await uploadFiles(a.capture, PARENT, parent)
  const before = journalOf(a.capture.db, PARENT)?.end ?? 0
  const wholeCopies = async (): Promise<number> => (await headersOf(relay, PARENT)).filter(({ path, at }) => path === parent && at === 0).length

  const again = captureOn(mac, relay, home)
  const line = turnOf(PARENT, 'Sent after the database went')
  appendFileSync(parent, line.slice(0, 20))
  await uploadFiles(again.capture, PARENT, parent)
  appendFileSync(parent, line.slice(20))
  await uploadFiles(again.capture, PARENT, parent)
  const afterFirst = readFileSync(parent, 'utf8')
  const restoredFirst = (await replayedOf(relay, PARENT)).get(parent)
  appendFileSync(parent, turnOf(PARENT, 'Sent once the journal went on'))
  await uploadFiles(again.capture, PARENT, parent)

  expect(before).toBeGreaterThan(0)
  expect(journalOf(again.capture.db, PARENT)?.end).toBeGreaterThan(before)
  expect(restoredFirst).toBe(afterFirst)
  expect(await wholeCopies()).toBe(2)
  expect((await replayedOf(relay, PARENT)).get(parent)).toBe(readFileSync(parent, 'utf8'))
}, 60_000)

test("a session whose sealed journal R2 holds and no machine claims gets its first capture on another machine from the journal's end, so a restore right after that first upload holds its new line", async () => {
  const relay = await memoryRelay()
  const { a, history } = await parentOn(relay, 300)
  await sealQuiet(a.capture, failTest, Date.now() + QUIET_MS + 1)
  expect(await a.capture.relay.runOne({ op: 'forget', session: PARENT })).toMatchObject({ status: 200 })
  const sealed = journalOf(a.capture.db, PARENT)?.sealed ?? 0
  const b = captureOn(server, relay)
  const parent = join(b.roots.claudeHome, 'projects', '-work', `${PARENT}.jsonl`)
  mkdirSync(dirname(parent), { recursive: true })
  writeFileSync(parent, `${history}${turnOf(PARENT, 'Sent on the server')}`)
  const unclaimed = (await relay.claims()).get(PARENT) ?? ''

  await uploadFiles(b.capture, PARENT, parent)

  expect([unclaimed, sealed > 0]).toEqual(['', true])
  expect(await relay.keys(`journals/${PARENT}/hot/`)).toEqual([hotKey(PARENT, sealed)])
  expect((await replayedOf(relay, PARENT)).get(parent)).toBe(readFileSync(parent, 'utf8'))
  expect((await relay.claims()).get(PARENT)).toBe(server.id)
})

test("a first capture whose first frame meets a frame another machine wrote at its position meanwhile goes on from the journal's end in R2, and is not stopped", async () => {
  const relay = await memoryRelay()
  const b = captureOn(server, relay)
  const parent = join(b.roots.claudeHome, 'projects', '-work', `${PARENT}.jsonl`)
  mkdirSync(dirname(parent), { recursive: true })
  writeFileSync(parent, turnOf(PARENT, 'Sent on the server'))
  const earlier = new TextEncoder().encode(turnOf(PARENT, 'Sent on the mac'))
  const frame = Buffer.concat(encodeRecord({ device: mac.id, path: parent, at: 0, size: earlier.length, after: { size: earlier.length, sha256: sha256(earlier) } }, earlier))
  relay.before = async (op) => {
    if (op.op === 'put' && op.key === hotKey(PARENT, 0)) await relay.objects.put(op.key, await compressHot(frame))
  }
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)

  expect(await uploadFiles(b.capture, PARENT, parent)).toEqual([new Set([parent])])
  relay.before = () => undefined
  await uploadFiles(b.capture, PARENT, parent)
  logged.mockRestore()

  expect(journalOf(b.capture.db, PARENT)).toMatchObject({ stopped: '', holder: '' })
  expect(await relay.keys(`journals/${PARENT}/hot/`)).toEqual([hotKey(PARENT, 0), hotKey(PARENT, frame.length)])
  expect((await replayedOf(relay, PARENT)).get(parent)).toBe(readFileSync(parent, 'utf8'))
  expect((await relay.claims()).get(PARENT)).toBe(server.id)
})

const rootsAt =(home: string): MachineRoots => ({ home, claudeHome: join(home, '.claude'), claudeTmp: join(home, 'tmp', 'claude-1000'), codexHome: join(home, '.codex') })

test('while a machine that is not removed has not connected with anyhost 0.9.0 or newer, capture, forks and compaction write only what anyhost 0.8 reads, and chunks come back once it is removed', async () => {
  const relay = await memoryRelay()
  await relay.join(server, rootsAt(join(temporaryFolder(), 'home')))
  const { a, folder, parent, history } = await parentOn(relay)
  const { session } = await forkAgent(a.capture, PARENT, '', moverOf(a.capture))
  for (const title of ['Plan the long trip', 'Plan the longer trip']) {
    writeFileSync(parent, history.replace('Plan the trip', title))
    await uploadFiles(a.capture, PARENT, parent)
  }
  await sealQuiet(a.capture, failTest, Date.now() + QUIET_MS + 1)
  const compacted = await rewriteJournal(a.capture, PARENT, 'claude', Date.now(), { lagMs: 0, isForced: true })
  const closed = { chunks: await relay.keys('chunks/'), parent: await headersOf(relay, PARENT), fork: await headersOf(relay, session), frames: await relay.keys(`journals/${PARENT}/compacted/`) }
  const programs = (await machinesOf(a.capture.relay)).map(({ name, program }) => `${name} ${program ?? 'none'}`)

  await a.capture.relay.runOne({ op: 'remove', device: server.id })
  a.capture.fleet = UNREAD_FLEET
  writeFileSync(parent, history)
  await uploadFiles(a.capture, PARENT, parent)

  expect(programs.sort()).toEqual(['mac 0.9.0', 'server '])
  expect(closed.chunks).toEqual([])
  expect(closed.parent.every(({ chunks }) => chunks === undefined)).toBe(true)
  expect(closed.fork.every(({ chunks, fork }) => chunks === undefined && fork === undefined)).toBe(true)
  expect(compacted?.isCurrent).toBe(false)
  expect(closed.frames).toEqual([expect.stringMatching(new RegExp(`/compacted/${position(0)}-\\d{16}\\.zst$`))])
  expect((await headersOf(relay, PARENT)).some(({ path, chunks }) => path === parent && chunks !== undefined)).toBe(true)
  expect(readFileSync(join(folder, `${session}.jsonl`), 'utf8')).toContain('(fork)')
}, 60_000)

const filler = (session: string, lines: number, bytes: number): string =>
  Array.from({ length: lines }, () => `${JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), sessionId: session, message: { role: 'user', content: 'x'.repeat(bytes) } })}\n`).join('')

test('a rewrite of a journal over 64 MiB that crashes between its two compacted puts, followed by a seal, still restores byte for byte, and the next rewrite finishes it, each frame one past the frames it replaces', async () => {
  const relay = await memoryRelay()
  const { a, parent } = await parentOn(relay, 4)
  const results = join(dirname(parent), PARENT, 'tool-results')
  mkdirSync(results, { recursive: true })
  for (let batch = 0; batch < 76; batch += 1) {
    writeFileSync(join(results, `r${batch}.txt`), `${batch}`.repeat(900_000))
    appendFileSync(parent, filler(PARENT, 1, 100))
    await uploadFiles(a.capture, PARENT, parent, join(results, `r${batch}.txt`))
  }
  await sealQuiet(a.capture, failTest, Date.now() + QUIET_MS + 1)
  for (let batch = 0; batch < 3; batch += 1) {
    appendFileSync(parent, filler(PARENT, 1, 100))
    await uploadFiles(a.capture, PARENT, parent)
  }
  await sealQuiet(a.capture, failTest, Date.now() + QUIET_MS + 2)
  const text = readFileSync(parent, 'utf8')
  const end = journalOf(a.capture.db, PARENT)?.end ?? 0
  let compactedPuts = 0
  relay.refuse = (op) => (op.op === 'put' && op.key.includes('/compacted/') && (compactedPuts += 1) === 2 ? 'R2 failed the put' : undefined)

  const crashed = await rewriteJournal(a.capture, PARENT, 'claude', Date.now(), { lagMs: 0, isForced: true }).then(
    () => 'finished',
    (error: unknown) => String(error),
  )
  relay.refuse = () => undefined
  await seal(a.capture, PARENT)
  const between = await relay.keys(`journals/${PARENT}/`)
  const restoredBetween = (await replayedOf(relay, PARENT)).get(parent)
  const finished = await rewriteJournal(a.capture, PARENT, 'claude', Date.now(), { lagMs: 0, isForced: true })
  await seal(a.capture, PARENT)

  expect(end).toBeGreaterThan(64 * 2 ** 20)
  expect(crashed).toContain('R2 failed the put')
  expect(between).toEqual([expect.stringMatching(/\/compacted\/\d{16}-\d{16}-0000000000000001\.zst$/), expect.stringMatching(/\/sealed\//)])
  expect(restoredBetween).toBe(text)
  expect(finished?.isCurrent).toBe(true)
  expect(await relay.keys(`journals/${PARENT}/`)).toEqual([expect.stringMatching(/\/compacted\/0{16}-\d{16}-0000000000000002\.zst$/)])
  expect((await replayedOf(relay, PARENT)).get(parent)).toBe(text)
}, 120_000)

test('a fork of version 1 derives exactly these bytes from this source, so every fork record keeps restoring as later versions come', async () => {
  const source = [
    '{"type":"custom-title","customTitle":"Plan","sessionId":"s"}',
    '{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"Book a train"},"uuid":"u1","sessionId":"s"}',
    '{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"Not \\q JSON"},"uuid":"u1","sessionId":"s"}',
    '{"parentUuid":"u1","isSidechain":false,"type":"assistant","message":{"role":"assistant","content":"Booked"},"uuid":"a1","sessionId":"s"}',
    '{"type":"content-replacement","sessionId":"s","replacements":[{"kind":"tool-result","id":"t1"}]}',
    '{"parentUuid":"a1","isSidechain":false,"type":"user","message":{"role":"user","content":"And a hotel"},"uuid":"u2","sessionId":"s"}',
    '',
  ].join('\n')
  const fork = { version: 1, session: 'f', source: 's', message: 'a1', title: 'Plan (fork)', time: '2026-11-15T00:00:00.000Z' }

  expect(new TextDecoder().decode((await forkedTranscript(new TextEncoder().encode(source), fork)).bytes)).toBe(
    [
      '{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"Book a train"},"uuid":"u1","sessionId":"f","forkedFrom":{"sessionId":"s","messageUuid":"u1"}}',
      '{"parentUuid":"u1","isSidechain":false,"type":"assistant","message":{"role":"assistant","content":"Booked"},"uuid":"a1","sessionId":"f","forkedFrom":{"sessionId":"s","messageUuid":"a1"}}',
      '{"type":"custom-title","customTitle":"Plan (fork)","sessionId":"f"}',
      '',
    ].join('\n'),
  )
  await expect(forkedTranscript(new TextEncoder().encode(source), { ...fork, version: 2 })).rejects.toThrow('of version 2, which a newer anyhost wrote')
})

test("a fork's derivation over a 37 MB source lets timers run while it reads", async () => {
  const history = conversation(PARENT, '/work', 20_000, 800)
  const fork = { version: 1, session: SESSION, source: PARENT, message: messagesIn(history).at(-1) ?? '', title: 'Plan the trip (fork)', time: '2026-11-15T00:00:00.000Z' }

  const loop = await eventLoopDuring(async () => await forkedTranscript(new TextEncoder().encode(history), fork))

  expect(messagesIn(new TextDecoder().decode(loop.value.bytes))).toEqual(messagesIn(history))
  expect(loop.ticks).toBeGreaterThan(0)
})

test('a chunk whose key already holds other bytes is written over once read, and a file of 1 MiB or more that is no log or transcript stays in its record', async () => {
  const relay = await memoryRelay()
  const { a, home, parent, history } = await parentOn(relay, 4)
  const grown = `${history}${conversation(PARENT, join(home, 'work'), 900).split('\n').slice(1).join('\n')}`
  const [first] = piecesOf(new TextEncoder().encode(grown).subarray(Buffer.byteLength(history)))
  await relay.objects.put(chunkKey(sha256(first ?? new Uint8Array())), new TextEncoder().encode('{}\nnot zstd'))
  const result = join(dirname(parent), PARENT, 'tool-results', 'big.txt')
  mkdirSync(dirname(result), { recursive: true })
  writeFileSync(result, 'y'.repeat(2 * 2 ** 20))
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)
  onTestFinished(() => logged.mockRestore())
  writeFileSync(parent, grown)
  await uploadFiles(a.capture, PARENT, parent, result)

  const headers = await headersOf(relay, PARENT)
  expect(headers.find(({ path }) => path === result)).toMatchObject({ at: 0, size: 2 * 2 ** 20 })
  expect(headers.find(({ path }) => path === result)?.chunks).toBeUndefined()
  expect(logged).toHaveBeenCalledWith(expect.stringContaining('holds other bytes'))
  expect((await replayedOf(relay, PARENT)).get(parent)).toBe(grown)
}, 60_000)

test("a seal deletes the next/ frames a rewrite left, and another machine's delete of them is refused while this machine holds the session", async () => {
  const relay = await memoryRelay()
  const { a } = await parentOn(relay, 4)
  const left = `journals/${PARENT}/next/${position(0)}-${position(10)}-${position(1)}.zst`
  await relay.objects.put(left, await compressHot(new Uint8Array()))
  const b = captureOn(server, relay)

  const refused = await b.capture.relay.runOne({ op: 'delete', keys: [left], holder: PARENT })
  const kept = await relay.keys(`journals/${PARENT}/next/`)
  await seal(a.capture, PARENT)

  expect(refused).toMatchObject({ status: 409, holder: { id: mac.id } })
  expect(kept).toEqual([left])
  expect(await relay.keys(`journals/${PARENT}/next/`)).toEqual([])
})
