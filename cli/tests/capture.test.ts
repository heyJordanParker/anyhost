import { Database } from 'bun:sqlite'
import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { MAX_MESSAGE_BYTES } from '../../relay/protocol.ts'
import {
  chainOf, changedFiles, CODE_PIECE_BYTES, CODE_PIECES, compressHot, continueJournal, decompress, encodeRecord, framesOf, hotKey, isCodePart, isDeleted, journalOf, markUntold, openCapture, openDatabase, QUIET_MS, seal,
  sealJournal, sealQuiet, sessionsOf, spoolOf, startLineOffsets, untoldOf, uploadSessions, type Problems, type RecordHeader,
} from '../src/capture.ts'
import type { Device, MachineRoots } from '../src/device.ts'
import { UploadQueue, uploadEveryOf } from '../src/serve.ts'
import { downloadJournal } from '../src/sessions.ts'
import { codexState, summarize, type Tool } from '../src/transcript.ts'
import { MEMORY, failTest, memoryRelay, noCode, temporaryFolder, welcomed, type MemoryRelay } from './memory.ts'

const SESSION = '11111111-2222-3333-4444-555555555555'
const OTHER = '99999999-2222-3333-4444-555555555555'
const TRIP = join(temporaryFolder(), 'trip')
mkdirSync(TRIP)
const deviceA: Device = { id: 'device-a', name: 'anyhost-a', os: 'linux', arch: 'arm64' }
const deviceB: Device = { id: 'device-b', name: 'anyhost-b', os: 'linux', arch: 'arm64' }
const lines = [
  `{"type":"custom-title","customTitle":"Plan the trip","sessionId":"${SESSION}"}\n`,
  `{"parentUuid":null,"type":"user","message":{"role":"user","content":"Book a train to Sofia 🚆, ще пътувам утре"},"cwd":${JSON.stringify(TRIP)},"entrypoint":"cli","sessionId":"${SESSION}"}\n`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Booked the 08:15 — seat 42."}]},"cwd":${JSON.stringify(TRIP)},"sessionId":"${SESSION}"}\n`,
]
const decoded = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const rootsUnder = (folder: string): MachineRoots => ({ home: join(folder, 'home'), claudeHome: join(folder, 'home', '.claude'), claudeTmp: join(folder, 'tmp', 'claude-1000'), codexHome: join(folder, 'home', '.codex') })

function machine(device: Device, relay: MemoryRelay, folder = temporaryFolder(), code = noCode, onCode?: (session: string, tool: Tool, folder: string) => void, compactLagMs?: number) {
  const roots = rootsUnder(folder)
  const transcript = join(roots.home, '.claude', 'projects', '-work-trip', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  const capture = openCapture(relay.connect(device, roots), device, roots, {
    db: openDatabase(join(folder, 'state')),
    code,
    codeEveryMs: 0,
    ...(onCode === undefined ? {} : { onCode }),
    ...(compactLagMs === undefined ? {} : { compactLagMs }),
  })
  const upload = (...paths: string[]): Promise<Set<string>[]> => Promise.all(uploadSessions(capture, [{ session: SESSION, tool: 'claude', paths: new Set(paths) }], failTest).map(([, left]) => left))
  return { roots, transcript, capture, upload }
}

function recordsOf(body: Uint8Array): { header: RecordHeader; text: string }[] {
  const records: { header: RecordHeader; text: string }[] = []
  for (let at = 0; at < body.length; ) {
    const newline = body.indexOf(10, at)
    const header = JSON.parse(decoded(body.subarray(at, newline))) as RecordHeader
    records.push({ header, text: decoded(body.subarray(newline + 1, newline + 1 + header.size)) })
    at = newline + 1 + header.size
  }
  return records
}

const hotFrames = (relay: MemoryRelay, session = SESSION): Promise<string[]> => relay.keys(`journals/${session}/hot/`)
const frameOf = async (relay: MemoryRelay, key: string): Promise<Uint8Array> => decompress((await relay.read(key)) ?? new Uint8Array())
const journalBytes = async (relay: MemoryRelay): Promise<Uint8Array> => Buffer.concat(await Promise.all((await hotFrames(relay)).map((key) => frameOf(relay, key))))

test('offset capture never re-uploads a byte', async () => {
  const relay = await memoryRelay()
  const { transcript, upload } = machine(deviceA, relay)
  writeFileSync(transcript, lines[0] ?? '')
  await upload(transcript)
  appendFileSync(transcript, `${lines[1]}${lines[2]?.slice(0, 20)}`)
  await upload(transcript)
  await upload(transcript)
  appendFileSync(transcript, lines[2]?.slice(20) ?? '')
  await upload(transcript)

  const records = recordsOf(await journalBytes(relay)).filter(({ header }) => header.path === transcript)
  expect(records.map(({ text }) => text)).toEqual(lines)
  expect(records.map(({ header }) => header.at)).toEqual([0, Buffer.byteLength(lines[0] ?? ''), Buffer.byteLength(`${lines[0]}${lines[1]}`)])
  expect(records.at(-1)?.header.after).toEqual({ size: Bun.file(transcript).size, sha256: new Bun.CryptoHasher('sha256').update(readFileSync(transcript)).digest('hex') })
  expect(await hotFrames(relay)).toHaveLength(3)
})

test("a background command's output uploads whole lines, as a transcript does", async () => {
  const relay = await memoryRelay()
  const { roots, transcript, upload } = machine(deviceA, relay)
  const output = join(roots.claudeTmp, '-work-trip', SESSION, 'tasks', 'b1.output')
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(transcript, lines[0] ?? '')
  writeFileSync(output, 'building /home/ada/work/trip\nlinking /home/ada/wo')
  await upload(transcript, output)
  appendFileSync(output, 'rk/trip\n')
  await upload(output)

  expect(recordsOf(await journalBytes(relay)).filter(({ header }) => header.path === output).map(({ text }) => text)).toEqual(['building /home/ada/work/trip\n', 'linking /home/ada/work/trip\n'])
})

test('a line still being written waits for its end', async () => {
  const relay = await memoryRelay()
  const { transcript, upload } = machine(deviceA, relay)
  writeFileSync(transcript, lines[0]?.slice(0, 10) ?? '')
  await upload(transcript)
  expect([relay.puts, relay.requests]).toEqual([[], []])
})

test("a session's subagents, tool results, plan, pasted text, history lines and background output enter its journal", async () => {
  const relay = await memoryRelay()
  const { roots, transcript, upload } = machine(deviceA, relay)
  const claude = join(roots.home, '.claude')
  const plan = join(claude, 'plans', 'trip-plan.md')
  const files = {
    subagent: join(dirname(transcript), SESSION, 'subagents', 'agent-a1.jsonl'),
    meta: join(dirname(transcript), SESSION, 'subagents', 'agent-a1.meta.json'),
    toolResult: join(dirname(transcript), SESSION, 'tool-results', 'b1.txt'),
    checkpoint: join(claude, 'file-history', SESSION, 'abc@v1'),
    task: join(claude, 'tasks', SESSION, '1.json'),
    environment: join(claude, 'session-env', SESSION, 'sessionstart-hook-1.sh'),
    output: join(roots.claudeTmp, '-work-trip', SESSION, 'tasks', 'b2.output'),
    paste: join(claude, 'paste-cache', '2d31b27c874ade1a.txt'),
    plan,
  }
  for (const [name, path] of Object.entries(files)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${name}\n`)
  }
  const atomicWrite = join(dirname(transcript), SESSION, 'custom-title.json.tmp.2cbcf23f')
  writeFileSync(atomicWrite, '{}')
  writeFileSync(transcript, `${lines[0]}{"type":"attachment","attachment":{"type":"plan_mode","planFilePath":${JSON.stringify(plan)}},"sessionId":"${SESSION}"}\n`)
  const mine = `{"display":"book it","pastedContents":{"1":{"id":1,"type":"text","contentHash":"2d31b27c874ade1a"}},"project":"/work/trip","sessionId":"${SESSION}"}\n`
  writeFileSync(join(claude, 'history.jsonl'), `{"display":"other","pastedContents":{},"project":"/work","sessionId":"${OTHER}"}\n${mine}`)
  await upload(transcript)

  const records = recordsOf(await journalBytes(relay))
  for (const [name, path] of Object.entries(files)) expect(records.find(({ header }) => header.path === path)?.text).toBe(`${name}\n`)
  expect(records.find(({ header }) => header.path === join(claude, 'history.jsonl'))?.text).toBe(mine)
  expect(records.some(({ header }) => header.path === atomicWrite)).toBe(false)
})

test('replay of append, write-once and rewrite records', async () => {
  const relay = await memoryRelay()
  const { capture } = machine(deviceA, relay)
  const record = (device: string, path: string, at: number, text: string): Uint8Array[] =>
    encodeRecord({ device, path, at, size: Buffer.byteLength(text), after: { size: at + Buffer.byteLength(text), sha256: '' } }, new TextEncoder().encode(text))
  const first = Buffer.concat([...record('a', '/h/log.jsonl', 0, 'one\n'), ...record('a', '/h/once.txt', 0, 'written once'), ...record('a', '/h/state.json', 0, '{"step":"first, and longer"}')])
  const second = Buffer.concat([...record('b', '/h/log.jsonl', 4, 'two\n'), ...record('b', '/h/state.json', 0, '{"step":2}')])
  await relay.objects.put(hotKey(SESSION, 0), compressHot(first))
  await relay.objects.put(hotKey(SESSION, first.length), compressHot(second.subarray(0, 30)))
  await relay.objects.put(hotKey(SESSION, first.length + 30), compressHot(second.subarray(30)))

  const replayed = await downloadJournal(capture.relay, SESSION, temporaryFolder(), ({ path }) => path)
  const text = (path: string): string => readFileSync(replayed.files.get(path)?.staged ?? '', 'utf8')
  expect([text('/h/log.jsonl'), text('/h/once.txt'), text('/h/state.json')]).toEqual(['one\ntwo\n', 'written once', '{"step":2}'])
  expect(replayed.files.get('/h/log.jsonl')?.segments).toEqual([
    { device: 'a', path: '/h/log.jsonl', offset: 0, size: 4 },
    { device: 'b', path: '/h/log.jsonl', offset: 4, size: 4 },
  ])
  expect(replayed.files.get('/h/state.json')?.segments).toEqual([{ device: 'b', path: '/h/state.json', offset: 0, size: 10 }])
  expect(replayed.end).toBe(first.length + second.length)
})

test('a drain of several sessions goes up in one request, and the first frame of each session no machine holds leaves its claim with this machine, with no claim sent', async () => {
  const relay = await memoryRelay()
  const { roots, transcript, capture } = machine(deviceA, relay)
  const other = join(roots.home, '.claude', 'projects', '-work-trip', `${OTHER}.jsonl`)
  writeFileSync(transcript, lines[0] ?? '')
  writeFileSync(other, `{"type":"user","message":{"role":"user","content":"Pack"},"sessionId":"${OTHER}"}\n`)
  const sessions = [
    { session: SESSION, tool: 'claude' as const, paths: new Set([transcript]) },
    { session: OTHER, tool: 'claude' as const, paths: new Set([other]) },
  ]
  await Promise.all(uploadSessions(capture, sessions, failTest).map(([, left]) => left))

  expect(relay.requests[0]?.map((op) => (op.op === 'put' ? `put ${op.key}` : op.op))).toEqual([`put ${hotKey(SESSION, 0)}`, `put ${hotKey(OTHER, 0)}`])
  expect(await relay.claims()).toEqual(new Map([[SESSION, deviceA.id], [OTHER, deviceA.id]]))
  expect(relay.requests.flat().filter(({ op }) => op === 'claim')).toEqual([])
})

test('a frame over 1 MiB goes up by HTTP beside the request, and the journal reads it back byte for byte', async () => {
  const relay = await memoryRelay()
  const { transcript, upload, capture } = machine(deviceA, relay)
  const toolResult = join(dirname(transcript), SESSION, 'tool-results', 'big.txt')
  mkdirSync(dirname(toolResult), { recursive: true })
  const incompressible = Buffer.from(crypto.getRandomValues(new Uint8Array(3 * MAX_MESSAGE_BYTES / 2))).toString('base64')
  writeFileSync(toolResult, incompressible)
  writeFileSync(transcript, lines[0] ?? '')
  await upload(transcript, toolResult)

  const [frame = ''] = await hotFrames(relay)
  expect((await relay.read(frame))?.length).toBeGreaterThan(MAX_MESSAGE_BYTES)
  expect(relay.requests.flat().some((op) => op.op === 'put' && op.key === frame)).toBe(false)
  const replayed = await downloadJournal(capture.relay, SESSION, temporaryFolder(), ({ path }) => path)
  expect(readFileSync(replayed.files.get(toolResult)?.staged ?? '', 'utf8')).toBe(incompressible)
})

test("a drain never waits on git: the files go up at once, the code follows in its own frame, and a part goes up once", async () => {
  const relay = await memoryRelay()
  const part = { path: `anyhost:code/${SESSION}/parts/aa11`, bytes: new TextEncoder().encode('a large binary diff') }
  const releases: (() => void)[] = []
  const heard: string[] = []
  const { transcript, capture, upload } = machine(
    deviceA,
    relay,
    temporaryFolder(),
    {
      captureCode: (_folder, _session) => new Promise((resolve) => releases.push(() => resolve({ header: new TextEncoder().encode(`{"head":"${releases.length}"}`), parts: [part] }))),
      restoreCode: async (_header, _readPart, at) => at,
    },
    (_session, _tool, at) => void heard.push(at),
  )
  writeFileSync(transcript, lines[1] ?? '')

  const gitAsked = async (count: number): Promise<void> => {
    while (releases.length < count) await Bun.sleep(1)
  }
  await upload(transcript)
  expect(recordsOf(await journalBytes(relay)).map(({ header }) => header.path)).not.toContain(`${TRIP}/`)
  await gitAsked(1)
  releases[0]?.()
  await capture.codeRuns.get(SESSION)
  expect(heard).toEqual([TRIP])
  await upload(`${TRIP}/`)
  appendFileSync(transcript, lines[2] ?? '')
  await upload(transcript)
  await gitAsked(2)
  releases[1]?.()
  await capture.codeRuns.get(SESSION)
  await upload(`${TRIP}/`)

  const frames = await Promise.all((await hotFrames(relay)).map(async (key) => recordsOf(await frameOf(relay, key)).map(({ header, text }) => `${header.path} ${text}`)))
  expect(frames.slice(1)).toEqual([
    [`${part.path} a large binary diff`, `${TRIP}/ {"head":"1"}`],
    [`${transcript} ${lines[2]}`],
    [`${TRIP}/ {"head":"2"}`],
  ])
})

test('a code record whose upload failed goes up with the next drain, since captureCode counts its parts as written', async () => {
  const relay = await memoryRelay()
  let isOffline = false
  relay.refuse = (op) => (isOffline && op.op === 'put' ? 'connect ECONNREFUSED' : undefined)
  const bundle = { path: `anyhost:code/${SESSION}/parts/cc33`, bytes: new TextEncoder().encode('a bundle') }
  const captures = [
    { header: new TextEncoder().encode('header 1'), parts: [bundle] },
    { header: new TextEncoder().encode('header 2'), parts: [] },
  ]
  const { transcript, capture, upload } = machine(deviceA, relay, temporaryFolder(), { captureCode: async () => captures.shift(), restoreCode: async (_header, _readPart, at) => at })
  writeFileSync(transcript, lines[1] ?? '')
  await upload(transcript)
  await capture.codeRuns.get(SESSION)
  isOffline = true
  await expect(upload(`${TRIP}/`)).rejects.toThrow('ECONNREFUSED')
  isOffline = false
  appendFileSync(transcript, lines[2] ?? '')
  await upload(transcript)
  await capture.codeRuns.get(SESSION)
  await upload(`${TRIP}/`)

  const code = recordsOf(await journalBytes(relay))
    .filter(({ header }) => isCodePart(header.path) || header.path.endsWith('/'))
    .map(({ header, text }) => `${header.path} ${text}`)
  expect(code).toEqual([`${bundle.path} a bundle`, `${TRIP}/ header 1`, `${TRIP}/ header 2`])
})

test('at uploadEvery 0 a line goes up alone, and a long code part in pieces, several frames at once', async () => {
  const relay = await memoryRelay()
  const bundle = { path: `anyhost:code/${SESSION}/parts/dd44`, bytes: crypto.getRandomValues(new Uint8Array((CODE_PIECES + 1) * CODE_PIECE_BYTES + 5)) }
  let reads = 0
  const { transcript, capture } = machine(deviceA, relay, temporaryFolder(), {
    captureCode: async () => ({ header: new TextEncoder().encode(`header ${++reads}`), parts: reads === 1 ? [bundle] : [] }),
    restoreCode: async (_header, _readPart, at) => at,
  })
  const upload = (...paths: string[]): Promise<Set<string>[]> => Promise.all(uploadSessions(capture, [{ session: SESSION, tool: 'claude', paths: new Set(paths) }], failTest, true).map(([, left]) => left))
  writeFileSync(transcript, lines[1] ?? '')
  await upload(transcript)
  await capture.codeRuns.get(SESSION)
  expect(await upload(`${TRIP}/`)).toEqual([new Set([`${TRIP}/`])])
  appendFileSync(transcript, lines[2] ?? '')
  expect(await upload(transcript, `${TRIP}/`)).toEqual([new Set([`${TRIP}/`])])
  await upload(`${TRIP}/`)
  await upload(`${TRIP}/`)
  await capture.codeRuns.get(SESSION)
  await upload(`${TRIP}/`)

  const frames = await Promise.all(
    (await hotFrames(relay)).map(async (key) => recordsOf(await frameOf(relay, key)).map(({ header, text }) => (header.path === transcript ? text : `${header.path} ${header.at} ${header.size}`))),
  )
  const piece = (index: number): string[] => [`${bundle.path} ${index * CODE_PIECE_BYTES} ${CODE_PIECE_BYTES}`]
  expect(frames.slice(1)).toEqual([
    ...Array.from({ length: CODE_PIECES }, (_, index) => piece(index)),
    [lines[2] ?? ''],
    piece(CODE_PIECES),
    [`${bundle.path} ${(CODE_PIECES + 1) * CODE_PIECE_BYTES} 5`, `${TRIP}/ 0 8`],
    [`${TRIP}/ 0 8`],
  ])
  expect(relay.requests.filter((ops) => ops.filter(({ op }) => op === 'put').length === CODE_PIECES)).toHaveLength(1)
  const replayed = await downloadJournal(capture.relay, SESSION, temporaryFolder(), ({ path }) => path)
  expect(Buffer.from(readFileSync(replayed.files.get(bundle.path)?.staged ?? '')).equals(Buffer.from(bundle.bytes))).toBe(true)
  expect(replayed.files.get(bundle.path)?.last.after).toEqual({ size: bundle.bytes.length, sha256: new Bun.CryptoHasher('sha256').update(bundle.bytes).digest('hex') })
  expect(reads).toBe(2)
})

test('a refused position stops the machine that lost it, and its lines from there are a fork', async () => {
  const relay = await memoryRelay()
  const a = machine(deviceA, relay)
  const b = machine(deviceB, relay)
  const bytes = new TextEncoder().encode(lines[0])
  await relay.objects.put(hotKey(SESSION, 0), compressHot(Buffer.concat(encodeRecord({ device: deviceA.id, path: a.transcript, at: 0, size: bytes.length, after: { size: bytes.length, sha256: '' } }, bytes))))
  writeFileSync(b.transcript, lines[1] ?? '')
  await welcomed(a.capture.relay)
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)

  expect(await b.upload(b.transcript)).toEqual([new Set()])
  appendFileSync(b.transcript, lines[2] ?? '')
  await b.upload(b.transcript)

  expect(await hotFrames(relay)).toEqual([hotKey(SESSION, 0)])
  expect(recordsOf(await journalBytes(relay)).map(({ text }) => text)).toEqual([lines[0] ?? ''])
  expect(journalOf(b.capture.db, SESSION)).toMatchObject({
    holder: 'anyhost-a',
    stopped: expect.stringContaining(`Another machine wrote byte 0 of the session ${SESSION}'s journal first, so anyhost-b stops capturing it`),
  })
  expect(logged).toHaveBeenCalledTimes(1)
  logged.mockRestore()
})

test('a frame another machine wrote at this machine\'s position after this machine took the session, as a write the relay let through as it restarted, is written over, and capture goes on', async () => {
  const relay = await memoryRelay()
  const a = machine(deviceA, relay)
  writeFileSync(a.transcript, lines[0] ?? '')
  await a.upload(a.transcript)
  const start = journalOf(a.capture.db, SESSION)?.end ?? 0
  const late = new TextEncoder().encode(lines[1])
  await relay.objects.put(hotKey(SESSION, start), compressHot(Buffer.concat(encodeRecord({ device: deviceB.id, path: a.transcript, at: start, size: late.length, after: { size: late.length, sha256: '' } }, late))))
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)

  appendFileSync(a.transcript, lines[2] ?? '')
  await a.upload(a.transcript)

  expect(recordsOf(await journalBytes(relay)).map(({ text }) => text)).toEqual([lines[0] ?? '', lines[2] ?? ''])
  expect(journalOf(a.capture.db, SESSION)).toMatchObject({ holder: '', stopped: '' })
  expect(logged).toHaveBeenCalledWith(expect.stringContaining(`writes its own frame over it`))
  logged.mockRestore()
})

test('a session another machine holds refuses this machine\'s frames, and it stops capturing the session', async () => {
  const relay = await memoryRelay()
  const a = machine(deviceA, relay)
  const b = machine(deviceB, relay)
  writeFileSync(a.transcript, lines[0] ?? '')
  writeFileSync(b.transcript, lines[1] ?? '')
  await a.upload(a.transcript)

  expect(await b.upload(b.transcript)).toEqual([new Set()])
  expect(await hotFrames(relay)).toEqual([hotKey(SESSION, 0)])
  expect(journalOf(b.capture.db, SESSION)).toMatchObject({ holder: 'anyhost-a', stopped: expect.stringContaining('anyhost-a took the session') })
})

test('a refused position that holds the same bytes counts as uploaded, as a retry after a lost answer does', async () => {
  const relay = await memoryRelay()
  const { transcript, upload, capture } = machine(deviceA, relay)
  writeFileSync(transcript, lines[0] ?? '')
  const bytes = new TextEncoder().encode(lines[0])
  const after = { size: bytes.length, sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex') }
  await relay.objects.put(hotKey(SESSION, 0), compressHot(Buffer.concat(encodeRecord({ device: deviceA.id, path: transcript, at: 0, size: bytes.length, after }, bytes))))

  await upload(transcript)
  expect(journalOf(capture.db, SESSION)).toMatchObject({ end: (await frameOf(relay, hotKey(SESSION, 0))).length, stopped: '' })
  expect(relay.puts.map(({ key }) => key)).toEqual([`sessions/${deviceA.id}/index.json`])
  expect(relay.requests.flat().some((op) => op.op === 'get' && op.key.startsWith('journals/'))).toBe(false)
})

test("a frame this machine put up that its journal never counted is written over, and a restore never reads one off the journal's chain", async () => {
  const relay = await memoryRelay()
  const { transcript, upload, capture } = machine(deviceA, relay)
  writeFileSync(transcript, lines[0] ?? '')
  const old = new TextEncoder().encode('old')
  const stray = compressHot(Buffer.concat(encodeRecord({ device: deviceA.id, path: transcript, at: 0, size: old.length, after: { size: old.length, sha256: '' } }, old)))
  await relay.objects.put(hotKey(SESSION, 0), stray)
  await relay.objects.put(hotKey(SESSION, 100_000), stray)

  await upload(transcript)
  expect(journalOf(capture.db, SESSION)?.stopped).toBe('')
  const replayed = await downloadJournal(capture.relay, SESSION, temporaryFolder(), ({ path }) => path)
  expect(readFileSync(replayed.files.get(transcript)?.staged ?? '', 'utf8')).toBe(lines[0] ?? '')
  expect(replayed.end).toBe(journalOf(capture.db, SESSION)?.end ?? -1)
})

test("a take that lands between a frame's 412 and the put over this machine's uncounted frame leaves the taker's journal whole", async () => {
  const relay = await memoryRelay()
  const a = machine(deviceA, relay)
  const b = machine(deviceB, relay)
  writeFileSync(a.transcript, lines[0] ?? '')
  expect(await a.capture.relay.runOne({ op: 'claim', session: SESSION, take: false })).toEqual({ status: 200, told: true, at: expect.any(String) })
  const old = new TextEncoder().encode(lines[1])
  const stray = Buffer.concat(encodeRecord({ device: deviceA.id, path: a.transcript, at: 0, size: old.length, after: { size: old.length, sha256: '' } }, old))
  await relay.objects.put(hotKey(SESSION, 0), compressHot(stray))
  const first = hotKey(SESSION, 0)
  let isRead = false
  const writing = Promise.withResolvers<void>()
  const taken = Promise.withResolvers<void>()
  relay.before = (op) => {
    if (op.op === 'get' && op.key === first) isRead = true
    const isWrite = (op.op === 'put' && op.key === first) || (op.op === 'delete' && op.keys.includes(first))
    if (!isRead || !isWrite) return undefined
    writing.resolve()
    return taken.promise
  }
  const uploading = a.upload(a.transcript)
  await writing.promise
  expect(await b.capture.relay.runOne({ op: 'claim', session: SESSION, take: true })).toMatchObject({ status: 200 })
  continueJournal(b.capture.db, { session: SESSION, tool: 'claude', end: stray.length, sealed: 0 }, [])
  writeFileSync(b.transcript, lines[2] ?? '')
  await b.upload(b.transcript)
  taken.resolve()

  expect(await uploading).toEqual([new Set()])
  expect(Buffer.from(await frameOf(relay, first)).equals(stray)).toBe(true)
  const replayed = await downloadJournal(b.capture.relay, SESSION, temporaryFolder(), ({ path }) => path)
  expect(readFileSync(replayed.files.get(b.transcript)?.staged ?? '', 'utf8')).toBe(lines[2] ?? '')
  expect(replayed.end).toBe(journalOf(b.capture.db, SESSION)?.end ?? -1)
  expect(journalOf(a.capture.db, SESSION)).toMatchObject({ holder: 'anyhost-b', stopped: expect.stringContaining('anyhost-b took the session') })
})

test('a code frame that fails leaves the journal at the frames before it, and the next drain writes the rest', async () => {
  const relay = await memoryRelay()
  let failing = 0
  let puts = 0
  relay.refuse = (op) => (op.op === 'put' && (puts += 1) === failing ? 'connect ECONNREFUSED' : undefined)
  const bundle = { path: `anyhost:code/${SESSION}/parts/ee55`, bytes: crypto.getRandomValues(new Uint8Array(3 * CODE_PIECE_BYTES)) }
  const { transcript, capture } = machine(deviceA, relay, temporaryFolder(), {
    captureCode: async () => ({ header: new TextEncoder().encode('header'), parts: [bundle] }),
    restoreCode: async (_header, _readPart, at) => at,
  })
  const upload = (...paths: string[]): Promise<Set<string>[]> => Promise.all(uploadSessions(capture, [{ session: SESSION, tool: 'claude', paths: new Set(paths) }], failTest, true).map(([, left]) => left))
  writeFileSync(transcript, lines[1] ?? '')
  await upload(transcript)
  await capture.codeRuns.get(SESSION)
  const lineEnd = journalOf(capture.db, SESSION)?.end ?? 0
  failing = puts + 2
  await expect(upload(`${TRIP}/`)).rejects.toThrow('ECONNREFUSED')

  const counted = journalOf(capture.db, SESSION)?.end ?? 0
  expect(counted).toBe(lineEnd + (await frameOf(relay, hotKey(SESSION, lineEnd))).length)
  expect((await hotFrames(relay)).at(-1)).not.toBe(hotKey(SESSION, lineEnd))
  expect((await downloadJournal(capture.relay, SESSION, temporaryFolder(), ({ path }) => path)).end).toBe(counted)
  await upload(`${TRIP}/`)
  const replayed = await downloadJournal(capture.relay, SESSION, temporaryFolder(), ({ path }) => path)
  expect(Buffer.from(readFileSync(replayed.files.get(bundle.path)?.staged ?? '')).equals(Buffer.from(bundle.bytes))).toBe(true)
  expect([...replayed.code.keys()]).toEqual([`${TRIP}/`])
  expect(replayed.end).toBe(journalOf(capture.db, SESSION)?.end ?? -1)
})

test('a file the session deleted goes up as a deletion record, heard from the watcher or found by the backup', async () => {
  const relay = await memoryRelay()
  const { roots, transcript, upload, capture } = machine(deviceA, relay)
  const task = join(roots.home, '.claude', 'tasks', SESSION, '1.json')
  const plan = join(roots.home, '.claude', 'plans', 'trip-plan.md')
  for (const path of [task, plan]) mkdirSync(dirname(path), { recursive: true })
  writeFileSync(task, '{"subject":"book the train"}')
  writeFileSync(plan, '# Trip\n')
  writeFileSync(transcript, `${lines[1]}{"type":"attachment","attachment":{"planFilePath":${JSON.stringify(plan)}},"sessionId":"${SESSION}"}\n`)
  await upload(transcript, task)
  rmSync(task)
  await upload(task)
  rmSync(plan)
  expect(await changedFiles(capture)).toEqual(new Map([[SESSION, new Set([plan])]]))
  await upload(plan)
  expect(await changedFiles(capture)).toEqual(new Map())

  const deletions = recordsOf(await journalBytes(relay)).filter(({ header }) => header.after === null)
  expect(deletions.map(({ header }) => [header.path, header.at, header.size])).toEqual([
    [task, 0, 0],
    [plan, 0, 0],
  ])
  const replayed = await downloadJournal(capture.relay, SESSION, temporaryFolder(), ({ path }) => path)
  expect([replayed.files.has(task), replayed.files.has(plan), [...replayed.deleted]]).toEqual([false, false, [task, plan]])
  writeFileSync(task, '{"subject":"pack the bag"}')
  await upload(task)
  const again = await downloadJournal(capture.relay, SESSION, temporaryFolder(), ({ path }) => path)
  expect([readFileSync(again.files.get(task)?.staged ?? '', 'utf8'), [...again.deleted]]).toEqual(['{"subject":"pack the bag"}', [plan]])
})

test('a session whose working folder this machine lacks uploads its lines, keeps no code, and says so once', async () => {
  const relay = await memoryRelay()
  const folder = temporaryFolder()
  let reads = 0
  const { roots, capture } = machine(deviceA, relay, folder, { captureCode: async () => ((reads += 1), undefined), restoreCode: async (_header, _readPart, at) => at })
  const transcript = join(roots.home, '.claude', 'projects', '-gone', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  const gone = join(folder, 'gone')
  const line = (text: string): string => `{"type":"user","message":{"role":"user","content":"${text}"},"cwd":${JSON.stringify(gone)},"sessionId":"${SESSION}"}\n`
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)
  for (const text of ['one', 'two']) {
    appendFileSync(transcript, line(text))
    await Promise.all(uploadSessions(capture, [{ session: SESSION, tool: 'claude', paths: new Set([transcript]) }], failTest, true).map(([, left]) => left))
    await capture.codeRuns.get(SESSION)
  }

  expect(reads).toBe(0)
  expect(logged.mock.calls.map(([message]) => String(message).slice(25))).toEqual([`${gone} is no folder on anyhost-a, so anyhost keeps no code of the sessions that work in it.`])
  logged.mockRestore()
  expect(recordsOf(await journalBytes(relay)).map(({ text }) => text)).toEqual([line('one'), line('two')])
})

test('a quiet session seals its hot frames into one sealed frame, and the journal reads the same', async () => {
  const relay = await memoryRelay()
  const { transcript, upload, capture } = machine(deviceA, relay)
  for (const line of lines) {
    appendFileSync(transcript, line)
    await upload(transcript)
  }
  const before = await journalBytes(relay)

  expect(await seal(capture, SESSION)).toBe(before.length)
  expect(await relay.keys(`journals/${SESSION}/`)).toEqual([`journals/${SESSION}/sealed/${'0'.padStart(16, '0')}-${String(before.length).padStart(16, '0')}.zst`])
  appendFileSync(transcript, lines[0] ?? '')
  await upload(transcript)
  const replayed = await downloadJournal(capture.relay, SESSION, temporaryFolder(), ({ path }) => path)
  expect(readFileSync(replayed.files.get(transcript)?.staged ?? '', 'utf8')).toBe(`${lines.join('')}${lines[0]}`)
  expect(replayed.sealedEnd).toBe(before.length)
})

test('a session that keeps writing has its code read once within a minute, however many drains carry its lines', async () => {
  const relay = await memoryRelay()
  const folder = temporaryFolder()
  const roots = rootsUnder(folder)
  const transcript = join(roots.home, '.claude', 'projects', '-work-trip', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  let reads = 0
  const capture = openCapture(relay.connect(deviceA, roots), deviceA, roots, { db: openDatabase(join(folder, 'state')), code: { ...noCode, captureCode: async () => void (reads += 1) }, codeEveryMs: 60_000 })
  for (const line of [...lines, ...lines]) {
    appendFileSync(transcript, line)
    await Promise.all(uploadSessions(capture, [{ session: SESSION, tool: 'claude', paths: new Set([transcript]) }], failTest).map(([, left]) => left))
    await capture.codeRuns.get(SESSION)
  }

  expect(reads).toBe(1)
  expect(capture.codeStale.has(SESSION)).toBe(true)
})

test('a seal of frames this machine wrote reads none of them back from R2, and seals every byte', async () => {
  const relay = await memoryRelay()
  const { transcript, upload, capture } = machine(deviceA, relay)
  for (const line of lines) {
    appendFileSync(transcript, line)
    await upload(transcript)
  }
  const before = await journalBytes(relay)
  const asked = relay.requests.length

  expect(await seal(capture, SESSION)).toBe(before.length)
  expect(relay.requests.slice(asked).flat().filter((op) => op.op === 'get')).toEqual([])
  expect(await hotFrames(relay)).toEqual([])
  const [sealed, ...more] = await relay.keys(`journals/${SESSION}/sealed/`)
  expect(more).toEqual([])
  expect(Buffer.from(await frameOf(relay, sealed ?? '')).equals(Buffer.from(before))).toBe(true)
})

test('a seal reads small frames many to a request, and at most 16 requests at once', async () => {
  const relay = await memoryRelay()
  const { transcript, capture } = machine(deviceA, relay)
  const bodies: Uint8Array[] = []
  let at = 0
  for (let index = 0; index < 40; index += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(600 * 1024))
    const body = Buffer.concat(encodeRecord({ device: deviceA.id, path: transcript, at, size: bytes.length, after: { size: at + bytes.length, sha256: '' } }, bytes))
    await relay.objects.put(hotKey(SESSION, bodies.reduce((total, frame) => total + frame.length, 0)), compressHot(body))
    bodies.push(body)
    at += bytes.length
  }
  for (let index = 0; index < 40; index += 1) {
    const bytes = new TextEncoder().encode(`{"line":${index}}\n`)
    const body = Buffer.concat(encodeRecord({ device: deviceA.id, path: `${transcript}.small`, at: index * bytes.length, size: bytes.length, after: { size: (index + 1) * bytes.length, sha256: '' } }, bytes))
    await relay.objects.put(hotKey(SESSION, bodies.reduce((total, frame) => total + frame.length, 0)), compressHot(body))
    bodies.push(body)
  }
  const before = Buffer.concat(bodies)
  continueJournal(capture.db, { session: SESSION, tool: 'claude', end: before.length, sealed: 0 }, [])
  await welcomed(capture.relay)
  relay.delayMs = 20
  const asked = relay.requests.length

  expect(await seal(capture, SESSION)).toBe(before.length)
  expect(relay.mostAtOnce).toBe(16)
  expect(relay.requests.slice(asked).filter((ops) => ops[0]?.op === 'get').map((ops) => ops.length)).toEqual([...Array.from({ length: 39 }, () => 1), 41])
  const sealed = await relay.keys(`journals/${SESSION}/`)
  expect(sealed).toEqual([`journals/${SESSION}/sealed/${'0'.padStart(16, '0')}-${String(before.length).padStart(16, '0')}.zst`])
  expect(Buffer.from(await frameOf(relay, sealed[0] ?? '')).equals(before)).toBe(true)
}, 60_000)

const position = (at: number): string => String(at).padStart(16, '0')

const rewritten = lines.join('').replace('Plan the trip', 'Plan the long trip')

async function rewrittenAndSealed(relay: MemoryRelay, { transcript, upload, capture }: ReturnType<typeof machine>): Promise<number> {
  writeFileSync(transcript, lines[1] ?? '')
  await upload(transcript)
  writeFileSync(transcript, `${lines[2]}${lines[1]}`)
  await upload(transcript)
  appendFileSync(transcript, lines[0] ?? '')
  await upload(transcript)
  writeFileSync(transcript, rewritten)
  await upload(transcript)
  const records = recordsOf(await journalBytes(relay)).map(({ header }) => [header.at, header.checkout ?? ''])
  expect(records).toEqual([[0, ''], [0, TRIP], [Buffer.byteLength(`${lines[2]}${lines[1]}`), TRIP], [0, TRIP]])
  await sealJournal(capture, SESSION, 'claude', failTest)
  return journalOf(capture.db, SESSION)?.end ?? 0
}

test('a restore that listed the journal before a compaction reads it whole after it, and the next seal deletes the sealed frame the compaction replaced', async () => {
  const relay = await memoryRelay()
  const writer = machine(deviceA, relay, temporaryFolder(), noCode, undefined, 0)
  const end = await rewrittenAndSealed(relay, writer)
  const sealedKey = `journals/${SESSION}/sealed/${position(0)}-${position(end)}.zst`
  const compactedKey = `journals/${SESSION}/compacted/${position(0)}-${position(end)}.zst`
  const listed = framesOf(SESSION, await writer.capture.relay.list(`journals/${SESSION}/`)).frames
  const journal = await frameOf(relay, sealedKey)

  await sealQuiet(writer.capture, failTest, Date.now() + 1)
  expect(await relay.keys(`journals/${SESSION}/`)).toEqual([compactedKey, sealedKey])
  expect(recordsOf(await frameOf(relay, compactedKey)).map(({ header, text }) => [header.at, text])).toEqual([
    [0, lines[1] ?? ''],
    [0, rewritten],
  ])
  const read: Uint8Array[] = []
  for await (const { bytes } of chainOf(writer.capture.relay, listed, 0)) read.push(bytes)
  expect(Buffer.concat(read).equals(Buffer.from(journal))).toBe(true)

  await sealQuiet(writer.capture, failTest, Date.now() + 2)
  expect(await relay.keys(`journals/${SESSION}/`)).toEqual([compactedKey])
  const replayed = await downloadJournal(writer.capture.relay, SESSION, temporaryFolder(), ({ path }) => path)
  expect([readFileSync(replayed.files.get(writer.transcript)?.staged ?? '', 'utf8'), replayed.end, replayed.sealedEnd]).toEqual([rewritten, end, end])
})

test("a compaction keeps a whole copy that another machine's append to the same file builds on, so the journal still replays", async () => {
  const relay = await memoryRelay()
  const { capture } = machine(deviceA, relay, temporaryFolder(), noCode, undefined, 0)
  const record = (device: string, path: string, at: number, text: string): Uint8Array[] =>
    encodeRecord({ device, path, at, size: Buffer.byteLength(text), after: { size: at + Buffer.byteLength(text), sha256: '' } }, new TextEncoder().encode(text))
  const journal = Buffer.concat([
    ...record('mac', '/Users/ada/log.jsonl', 0, 'one\n'),
    ...record('devbox', '/home/ada/log.jsonl', 4, 'two\n'),
    ...record('mac', '/Users/ada/state.json', 0, '{"step":1}'),
    ...record('mac', '/Users/ada/log.jsonl', 0, 'three\n'),
    ...record('mac', '/Users/ada/state.json', 0, '{"step":2}'),
  ])
  await relay.objects.put(`journals/${SESSION}/sealed/${position(0)}-${position(journal.length)}.zst`, compressHot(journal))
  continueJournal(capture.db, { session: SESSION, tool: 'claude', end: journal.length, sealed: journal.length }, [])
  await welcomed(capture.relay)

  await sealQuiet(capture, failTest, Date.now() + 1)
  const compacted = await frameOf(relay, `journals/${SESSION}/compacted/${position(0)}-${position(journal.length)}.zst`)
  expect(recordsOf(compacted).map(({ header, text }) => `${header.path} ${text}`)).toEqual(['/Users/ada/log.jsonl one\n', '/home/ada/log.jsonl two\n', '/Users/ada/log.jsonl three\n', '/Users/ada/state.json {"step":2}'])
  const replayed = await downloadJournal(capture.relay, SESSION, temporaryFolder(), ({ path }) => `/here/${basename(path)}`)
  expect([...replayed.files].map(([path, { staged }]) => `${path} ${readFileSync(staged, 'utf8')}`)).toEqual(['/here/log.jsonl three\n', '/here/state.json {"step":2}'])
})

test('a sealed frame younger than the lag is never compacted, and its journal is not listed again until it ages past the lag', async () => {
  const relay = await memoryRelay()
  const writer = machine(deviceA, relay)
  const end = await rewrittenAndSealed(relay, writer)
  const sealedKey = `journals/${SESSION}/sealed/${position(0)}-${position(end)}.zst`
  const asked = relay.requests.length

  await sealQuiet(writer.capture, failTest, Date.now() + 1)
  const checked = relay.requests.length
  await sealQuiet(writer.capture, failTest, Date.now() + 2)
  expect(await relay.keys(`journals/${SESSION}/`)).toEqual([sealedKey])
  expect(relay.requests.slice(asked, checked).flat().map(({ op }) => op)).toEqual(['claim', 'list', 'list'])
  expect(relay.requests.slice(checked)).toEqual([])

  await sealQuiet(writer.capture, failTest, Date.now() + 7 * 24 * 60 * 60_000 + 1)
  expect(await relay.keys(`journals/${SESSION}/`)).toEqual([`journals/${SESSION}/compacted/${position(0)}-${position(end)}.zst`, sealedKey])
})

test('a Codex rollout that Codex compresses starts no session when anyhost never captured it, and stays the transcript of one it did', async () => {
  const relay = await memoryRelay()
  const { roots, capture } = machine(deviceA, relay)
  const upload = (session: string, path: string): Promise<Set<string>[]> => Promise.all(uploadSessions(capture, [{ session, tool: 'codex', paths: new Set([path]) }], failTest).map(([, left]) => left))
  const old = '01a07f21-07a8-70f0-a8e9-f7d92c6c7694'
  const compressedOld = join(roots.codexHome, 'sessions', '2026', '09', '08', `rollout-2026-09-08T06-47-46-${old}.jsonl`)
  mkdirSync(dirname(compressedOld), { recursive: true })
  writeFileSync(`${compressedOld}.zst`, new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0]))
  await upload(old, compressedOld)
  expect(journalOf(capture.db, old)).toBeUndefined()

  const rollout = join(roots.codexHome, 'sessions', '2026', '11', '04', `rollout-2026-11-04T14-54-13-${SESSION}.jsonl`)
  mkdirSync(dirname(rollout), { recursive: true })
  writeFileSync(rollout, `{"type":"session_meta","payload":{"id":"${SESSION}","cwd":${JSON.stringify(TRIP)}}}\n`)
  await upload(SESSION, rollout)
  const compressed = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3])
  writeFileSync(`${rollout}.zst`, compressed)
  rmSync(rollout)
  await upload(SESSION, rollout)
  await upload(SESSION, `${rollout}.zst`)

  const replayed = await downloadJournal(capture.relay, SESSION, temporaryFolder(), ({ path }) => path)
  expect([...replayed.files.keys()].filter((path) => path.includes('rollout-'))).toEqual([`${rollout}.zst`])
  expect([...replayed.deleted]).toEqual([rollout])
  expect(isDeleted(capture.db, SESSION)).toBe(false)
})

test("a Codex thread on a machine with no Codex database gets its name into the row Codex makes, as Codex writes it", async () => {
  const relay = await memoryRelay()
  const { roots, capture } = machine(deviceA, relay)
  const upload = (path: string): Promise<Set<string>[]> => Promise.all(uploadSessions(capture, [{ session: SESSION, tool: 'codex', paths: new Set([path]) }], failTest).map(([, left]) => left))
  const rollout = join(roots.codexHome, 'sessions', '2026', '11', '04', `rollout-2026-11-04T14-54-13-${SESSION}.jsonl`)
  mkdirSync(dirname(rollout), { recursive: true })
  writeFileSync(rollout, `{"type":"session_meta","payload":{"id":"${SESSION}","cwd":${JSON.stringify(TRIP)}}}\n`)
  const index = (name: string): string => `{"id":"${SESSION}","thread_name":"${name}","updated_at":"2026-11-04T13:15:48Z"}\n`
  writeFileSync(join(roots.codexHome, 'session_index.jsonl'), `${index('Trip notes')}${index('Osprey sighting notes')}`)
  await upload(rollout)
  const wal = `${codexState(roots)}-wal`
  expect(await sessionsOf(capture, wal)).toEqual([{ session: SESSION, tool: 'codex' }])

  const codex = new Database(codexState(roots))
  codex.run('create table threads (id text primary key, title text not null, name text)')
  codex.query('insert into threads values (?, ?, null)').run(SESSION, 'What bird is named in notes.md?')
  await upload(codexState(roots))

  expect(codex.query<{ name: string }, [string]>('select name from threads where id = ?').get(SESSION)?.name).toBe('Osprey sighting notes')
  codex.close()
  const replayed = await downloadJournal(capture.relay, SESSION, temporaryFolder(), ({ path }) => path)
  expect(JSON.parse(readFileSync(replayed.files.get(codexState(roots))?.staged ?? '', 'utf8'))).toEqual({ id: SESSION, title: 'What bird is named in notes.md?', name: 'Osprey sighting notes' })
  expect(await sessionsOf(capture, wal)).toEqual([])
})

test('the minute sweep stats no file of a session quiet for QUIET_MS, and the full sweep finds the write no event named and uploads it', async () => {
  const relay = await memoryRelay()
  const { transcript, upload, capture } = machine(deviceA, relay)
  writeFileSync(transcript, lines[0] ?? '')
  await upload(transcript)
  expect(await changedFiles(capture)).toEqual(new Map())
  appendFileSync(transcript, lines[1] ?? '')
  const writtenAt = journalOf(capture.db, SESSION)?.writtenAt ?? 0
  const minuteSweep = (now: number): Promise<Map<string, Set<string>>> => changedFiles(capture, now - QUIET_MS)
  const statted = spyOn(fs, 'statSync')

  expect(await minuteSweep(writtenAt + 60_000)).toEqual(new Map([[SESSION, new Set([transcript])]]))
  expect(statted).toHaveBeenCalled()
  statted.mockClear()
  expect(await minuteSweep(writtenAt + QUIET_MS + 60_000)).toEqual(new Map())
  expect(statted).not.toHaveBeenCalled()
  statted.mockRestore()

  const missed = await changedFiles(capture)
  expect(missed).toEqual(new Map([[SESSION, new Set([transcript])]]))
  await upload(...(missed.get(SESSION) ?? []))
  const replayed = await downloadJournal(capture.relay, SESSION, temporaryFolder(), ({ path }) => path)
  expect(readFileSync(replayed.files.get(transcript)?.staged ?? '', 'utf8')).toBe(`${lines[0]}${lines[1]}`)
})

async function lostFrame(relay: MemoryRelay) {
  const { roots, transcript, upload, capture } = machine(deviceA, relay)
  const toolResult = join(dirname(transcript), SESSION, 'tool-results', 'b1.txt')
  mkdirSync(dirname(toolResult), { recursive: true })
  for (const line of lines) {
    appendFileSync(transcript, line)
    appendFileSync(toolResult, `ran ${line.length}\n`)
    await upload(transcript, toolResult)
  }
  const [, lost] = await hotFrames(relay)
  await relay.objects.delete(lost ?? '')
  const end = journalOf(capture.db, SESSION)?.end ?? 0
  const quiet = (journalOf(capture.db, SESSION)?.writtenAt ?? 0) + QUIET_MS + 60_000
  return { roots, transcript, toolResult, upload, capture, lostAt: Number(/(\d+)\.zst$/.exec(lost ?? '')?.[1]), end, quiet }
}

test("a seal of a journal R2 lost a frame of seals up to the lost frame, and the journal goes on from there with every file whole, once", async () => {
  const relay = await memoryRelay()
  const { roots, transcript, toolResult, upload, capture, lostAt, end, quiet } = await lostFrame(relay)
  const problems: string[] = []
  const recording: Problems = { set: (key, error) => void problems.push(`${key}: ${String(error)}`), clear: () => undefined }
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)

  const again = await sealQuiet(capture, recording, quiet)
  expect(again).toEqual(new Map([[SESSION, new Set([transcript, toolResult, join(roots.claudeHome, 'history.jsonl')])]]))
  expect(logged.mock.calls.map(([message]) => String(message).slice(25))).toEqual([
    `The journal of ${SESSION} in R2 reaches byte ${lostAt}, and anyhost-a counted ${end}, so it uploads the files of ${SESSION} whole again from byte ${lostAt}.`,
  ])
  logged.mockRestore()
  expect(problems).toEqual([])
  expect(journalOf(capture.db, SESSION)).toMatchObject({ end: lostAt, sealed: lostAt })
  expect(await relay.keys(`journals/${SESSION}/`)).toEqual([`journals/${SESSION}/sealed/${'0'.padStart(16, '0')}-${String(lostAt).padStart(16, '0')}.zst`])

  await upload(...(again.get(SESSION) ?? []))
  const replayed = await downloadJournal(capture.relay, SESSION, temporaryFolder(), ({ path }) => path)
  for (const path of [transcript, toolResult]) expect(readFileSync(replayed.files.get(path)?.staged ?? '', 'utf8')).toBe(readFileSync(path, 'utf8'))
  expect(replayed.end).toBe(journalOf(capture.db, SESSION)?.end ?? -1)

  const later = Date.now() + QUIET_MS + 60_000
  expect(await sealQuiet(capture, recording, later)).toEqual(new Map())
  expect(journalOf(capture.db, SESSION)?.sealed).toBe(replayed.end)
  const asked = relay.requests.length
  expect(await sealQuiet(capture, recording, later + 60_000)).toEqual(new Map())
  expect(relay.requests.length).toBe(asked)
})

test('a journal R2 lost a frame of, whose transcript is gone here, names the lost span once as a problem, and no seal reads it each minute', async () => {
  const relay = await memoryRelay()
  const { transcript, toolResult, capture, lostAt, end, quiet } = await lostFrame(relay)
  rmSync(transcript)
  const problems: string[] = []
  const recording: Problems = { set: (key, error) => void problems.push(`${key}: ${String(error)}`), clear: () => undefined }

  expect((await sealQuiet(capture, recording, quiet)).get(SESSION)).toContain(toolResult)
  expect(problems).toEqual([
    `journal ${SESSION}: The journal of ${SESSION} in R2 reaches byte ${lostAt}, and anyhost-a counted ${end}, and holds no transcript of the session to upload again, so a restore of the session lacks what the journal held from byte ${lostAt}.`,
  ])
  const asked = relay.requests.length
  expect(await sealQuiet(capture, recording, quiet + 60_000)).toEqual(new Map())
  const checked = relay.requests.length
  for (const minute of [2, 3]) expect(await sealQuiet(capture, recording, quiet + minute * 60_000)).toEqual(new Map())
  expect(relay.requests.slice(asked).flat().filter(({ op }) => op === 'get')).toEqual([])
  expect([relay.requests.length, problems.length]).toEqual([checked, 1])
})

test('the repair of a journal R2 lost a frame of keeps the warning a takeover left for the next prompt', async () => {
  const relay = await memoryRelay()
  const { capture, quiet } = await lostFrame(relay)
  markUntold(capture.db, SESSION, 'anyhost-b')
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)

  expect((await sealQuiet(capture, failTest, quiet)).has(SESSION)).toBe(true)
  logged.mockRestore()
  expect(untoldOf(capture.db, SESSION)).toBe('anyhost-b')
})

test('a seal that keeps failing is tried again after 1, 2, 4 and 8 minutes, and a seal that succeeds ends the wait', async () => {
  const relay = await memoryRelay()
  const { transcript, upload, capture } = machine(deviceA, relay)
  writeFileSync(transcript, lines[0] ?? '')
  await upload(transcript)
  const quiet = (journalOf(capture.db, SESSION)?.writtenAt ?? 0) + QUIET_MS + 60_000
  let isFailing = true
  relay.refuse = (op) => (isFailing && op.op === 'list' ? 'R2 answered 500' : undefined)
  const problems: string[] = []
  const recording: Problems = { set: (key, error) => void problems.push(`${key}: ${String(error)}`), clear: () => undefined }
  const pass = async (minute: number): Promise<boolean> => {
    const asked = relay.requests.length
    await sealQuiet(capture, recording, quiet + minute * 60_000)
    return relay.requests.slice(asked).some((ops) => ops.some(({ op }) => op === 'list'))
  }

  const tried: number[] = []
  for (let minute = 0; minute <= 15; minute += 1) if (await pass(minute)) tried.push(minute)
  expect(tried).toEqual([0, 1, 3, 7, 15])
  expect(problems).toHaveLength(5)
  isFailing = false
  let sealedAt = 16
  while (!(await pass(sealedAt))) sealedAt += 1
  expect(sealedAt).toBe(31)
  expect(journalOf(capture.db, SESSION)?.sealed).toBe(journalOf(capture.db, SESSION)?.end ?? -1)
  appendFileSync(transcript, lines[1] ?? '')
  await upload(transcript)
  isFailing = true
  const later = (journalOf(capture.db, SESSION)?.writtenAt ?? 0) + QUIET_MS + 60_000 - quiet
  const minute = Math.ceil(later / 60_000)
  expect([await pass(minute), await pass(minute + 1)]).toEqual([true, true])
})

async function bigFrames(relay: MemoryRelay) {
  const { transcript, capture, upload } = machine(deviceA, relay)
  const frames = 17
  for (let frame = 0; frame < frames; frame += 1) {
    const text = Buffer.from(crypto.getRandomValues(new Uint8Array(700 * 1024))).toString('base64')
    appendFileSync(transcript, `{"type":"user","message":{"role":"user","content":"${text}"},"sessionId":"${SESSION}"}\n`)
    await upload(transcript)
  }
  const sizes = (await Promise.all((await hotFrames(relay)).map(async (key) => (await relay.read(key))?.length ?? 0))).sort((a, b) => b - a)
  expect(sizes).toHaveLength(frames)
  expect(sizes[0]).toBeLessThan(MAX_MESSAGE_BYTES)
  expect((sizes.at(-1) ?? 0) * 2).toBeGreaterThan(MAX_MESSAGE_BYTES)
  rmSync(spoolOf(capture.db, SESSION), { recursive: true, force: true })
  return { capture, frames, sizes, quiet: (journalOf(capture.db, SESSION)?.writtenAt ?? 0) + QUIET_MS + 60_000 }
}

test('a seal over a link whose answers take past 40 seconds in all finishes on its one socket, asking for each frame once', async () => {
  const relay = await memoryRelay()
  const { capture, frames, sizes, quiet } = await bigFrames(relay)
  relay.downloadBytesPerMs = 240
  expect(sizes.slice(1).reduce((sum, size) => sum + size, 0) / relay.downloadBytesPerMs).toBeGreaterThan(40_000)
  const asked = relay.requests.length

  expect(await sealQuiet(capture, failTest, quiet)).toEqual(new Map())
  expect(journalOf(capture.db, SESSION)?.sealed).toBe(journalOf(capture.db, SESSION)?.end ?? -1)
  expect(await hotFrames(relay)).toEqual([])
  expect(relay.requests.slice(asked).filter((ops) => ops.some(({ op }) => op === 'get'))).toHaveLength(frames)
}, 180_000)

test('a seal over a link paced both ways, whose 16 answers queued ahead of any pong take past 70 seconds, keeps its one socket', async () => {
  const relay = await memoryRelay()
  const { capture, frames, sizes, quiet } = await bigFrames(relay)
  relay.downloadBytesPerMs = 150
  relay.uploadBytesPerMs = 150
  expect(sizes.slice(1).reduce((sum, size) => sum + size, 0) / relay.downloadBytesPerMs).toBeGreaterThan(70_000)
  let welcomes = 0
  capture.relay.on('welcome', () => (welcomes += 1))
  const asked = relay.requests.length

  expect(await sealQuiet(capture, failTest, quiet)).toEqual(new Map())
  expect(welcomes).toBe(0)
  expect(journalOf(capture.db, SESSION)?.sealed).toBe(journalOf(capture.db, SESSION)?.end ?? -1)
  expect(relay.requests.slice(asked).filter((ops) => ops.some(({ op }) => op === 'get'))).toHaveLength(frames)
}, 240_000)

test('a lines file names the sessions that wrote new lines, and never the lines before the first start', async () => {
  const relay = await memoryRelay()
  const { roots, capture } = machine(deviceA, relay)
  const history = join(roots.home, '.claude', 'history.jsonl')
  writeFileSync(history, `{"display":"old","project":"/work","sessionId":"${OTHER}"}\n`)
  await startLineOffsets(capture)
  appendFileSync(history, `{"display":"new","project":"/work","sessionId":"${SESSION}"}\n`)
  expect(await sessionsOf(capture, history)).toEqual([{ session: SESSION, tool: 'claude' }])
  expect(await sessionsOf(capture, history)).toEqual([])
})

test('the queue at 0 uploads on every write, one upload in flight per session', async () => {
  const uploads: { session: string; paths: string[] }[] = []
  const ends: (() => void)[] = []
  const queue = new UploadQueue(
    0,
    (sessions) =>
      sessions.map((changed) => {
        uploads.push({ session: changed.session, paths: [...changed.paths] })
        return [changed, new Promise<Set<string>>((resolve) => ends.push(() => resolve(new Set())))] as const
      }),
    (_session, error) => {
      throw error
    },
  )
  queue.add(SESSION, 'claude', '/a')
  queue.add(OTHER, 'claude', '/x')
  queue.add(SESSION, 'claude', '/b')
  queue.add(SESSION, 'claude', '/c')
  expect(uploads).toEqual([
    { session: SESSION, paths: ['/a'] },
    { session: OTHER, paths: ['/x'] },
  ])
  ends.shift()?.()
  await Bun.sleep(1)
  expect(uploads.at(-1)).toEqual({ session: SESSION, paths: ['/b', '/c'] })
  expect(queue.pending).toBe(0)
})

test('the queue at 0 tries a failed upload again by itself, 1 second later and then twice as long each time', async () => {
  const tries: number[] = []
  const failures: string[] = []
  const started = Date.now()
  const queue = new UploadQueue(
    0,
    (sessions) =>
      sessions.map((changed) => {
        tries.push(Date.now() - started)
        if (tries.length < 3) return [changed, Promise.reject(new Error('connect ECONNREFUSED'))] as const
        expect([...changed.paths]).toEqual(['/a'])
        return [changed, Promise.resolve(new Set<string>())] as const
      }),
    (session) => void failures.push(session),
  )
  queue.add(SESSION, 'claude', '/a')
  await Bun.sleep(3200)
  expect(tries.map((at) => Math.round(at / 1000))).toEqual([0, 1, 3])
  expect(failures).toEqual([SESSION, SESSION])
  expect(queue.pending).toBe(0)
})

test('the queue at N uploads every session written meanwhile in one drain, once per N seconds', async () => {
  const uploads: { sessions: string[]; paths: string[][]; at: number }[] = []
  const started = Date.now()
  const queue = new UploadQueue(
    0.3,
    (sessions) => {
      uploads.push({ sessions: sessions.map(({ session }) => session), paths: sessions.map(({ paths }) => [...paths]), at: Date.now() - started })
      return sessions.map((changed) => [changed, Promise.resolve(new Set<string>())] as const)
    },
    (_session, error) => {
      throw error
    },
  )
  for (const path of ['/a', '/b', '/c']) {
    queue.add(SESSION, 'claude', path)
    await Bun.sleep(50)
  }
  queue.add(OTHER, 'claude', '/x')
  await Bun.sleep(350 - (Date.now() - started))
  expect(uploads.map(({ sessions, paths }) => [sessions, paths])).toEqual([[[SESSION, OTHER], [['/a', '/b', '/c'], ['/x']]]])
  for (const path of ['/d', '/e']) {
    queue.add(SESSION, 'claude', path)
    await Bun.sleep(50)
  }
  await Bun.sleep(700 - (Date.now() - started))
  queue.uploadEvery = 0
  expect(uploads.map(({ paths }) => paths)).toEqual([[['/a', '/b', '/c'], ['/x']], [['/d', '/e']]])
  expect(uploads.map(({ at }) => Math.round(at / 300))).toEqual([1, 2])
})

test('the queue drains every 5 seconds until the person sets Upload every, and their 0 uploads every write', () => {
  expect([uploadEveryOf(undefined), uploadEveryOf(0), uploadEveryOf(30)]).toEqual([5, 0, 30])
})

test("the working folder is the session's own, never a folder a tool call names", () => {
  const empty = { title: '', titleRank: 0, firstPrompt: '', cwd: '', repo: '', entrypoint: '' }
  const claude = summarize(empty, `{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"cwd":"/elsewhere"}}]},"cwd":"/work/app"}\n`, 'claude')
  const codex = summarize(
    empty,
    `{"timestamp":"2026-10-27T20:02:13.653Z","type":"session_meta","payload":{"id":"x","cwd":"/Users/ada","originator":"codex_cli_rs","source":"cli"}}\n{"timestamp":"2026-10-27T20:02:20.000Z","type":"response_item","payload":{"arguments":{"cwd":"file:///Users/ada/other"}}}\n`,
    'codex',
  )
  expect([claude.cwd, codex.cwd, codex.entrypoint]).toEqual(['/work/app', '/Users/ada', 'codex_cli_rs'])
})

test('a Codex session T3 Code runs names T3 Code as its app, though Codex calls every app client vscode', () => {
  const empty = { title: '', titleRank: 0, firstPrompt: '', cwd: '', repo: '', entrypoint: '' }
  const meta = '{"timestamp":"2026-11-10T09:00:00.000Z","type":"session_meta","payload":{"id":"x","cwd":"/Users/ada","originator":"T3 Code","source":"vscode"}}\n'
  expect(summarize(empty, meta, 'codex').entrypoint).toBe('T3 Code')
})

test('a Claude Code session T3 Code started and a terminal continued names the terminal as its app', () => {
  const empty = { title: '', titleRank: 0, firstPrompt: '', cwd: '', repo: '', entrypoint: '' }
  const inT3 = summarize(empty, '{"type":"user","entrypoint":"t3-code","cwd":"/work/app"}\n', 'claude')
  expect(summarize(inT3, '{"type":"user","entrypoint":"cli","cwd":"/work/app"}\n', 'claude').entrypoint).toBe('cli')
})

test('a session that begins with a slash command names it as its first prompt', () => {
  const empty = { title: '', titleRank: 0, firstPrompt: '', cwd: '', repo: '', entrypoint: '' }
  const loop = JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>2m Reply with tick.</command-args>' } })
  expect(summarize(empty, `${loop}\n`, 'claude').firstPrompt).toBe('/loop 2m Reply with tick.')
})

test("a session whose first message another agent sent with tell_agent names that message as its first prompt, without the agent's tag", () => {
  const empty = { title: '', titleRank: 0, firstPrompt: '', cwd: '', repo: '', entrypoint: '' }
  const told = JSON.stringify({ type: 'user', message: { role: 'user', content: '<anyhost from="2f115ce2 on mac" reach="tell_agent 2f115ce2 when done or stuck">Fix the login</anyhost>' } })
  expect(summarize(empty, `${told}\n`, 'claude').firstPrompt).toBe('Fix the login')
})

test("the index entry holds the session's title, first prompt, working folder and entrypoint", async () => {
  const relay = await memoryRelay()
  const { transcript, upload, capture } = machine(deviceA, relay)
  writeFileSync(transcript, lines.join(''))
  await upload(transcript)
  const row = capture.db.query<{ title: string; first_prompt: string; cwd: string; entrypoint: string }, []>('select title, first_prompt, cwd, entrypoint from sessions').get()
  expect(row).toEqual({ title: 'Plan the trip', first_prompt: 'Book a train to Sofia 🚆, ще пътувам утре', cwd: TRIP, entrypoint: 'cli' })
})

test('the database keeps what one relay holds, and a welcome from another relay starts it over with the code parts it named, though its bucket has the same name', async () => {
  const folder = temporaryFolder()
  const parts = join(folder, 'state', 'code', SESSION, 'repo.json')
  const journals = (db: Database): number => db.query<{ count: number }, []>('select count(*) as count from journals').get()?.count ?? -1
  const uploaded = async ({ transcript, upload }: ReturnType<typeof machine>): Promise<void> => {
    writeFileSync(transcript, lines.join(''))
    await upload(transcript)
    mkdirSync(dirname(parts), { recursive: true })
    writeFileSync(parts, '{}')
  }
  const relay = await memoryRelay()
  const first = machine(deviceA, relay, folder)
  await uploaded(first)

  await welcomed(machine(deviceA, relay, folder).capture.relay)
  expect([journals(first.capture.db), existsSync(parts)]).toEqual([1, true])
  first.capture.db.run("update bucket set url = ''")
  await welcomed(machine(deviceA, relay, folder).capture.relay)
  expect([journals(first.capture.db), existsSync(parts)]).toEqual([1, true])
  expect(first.capture.db.query<{ url: string; name: string }, []>('select url, name from bucket').get()).toEqual({ url: relay.url, name: MEMORY })

  const another = machine(deviceA, await memoryRelay(), folder)
  await welcomed(another.capture.relay)
  expect([journals(another.capture.db), existsSync(parts)]).toEqual([0, false])
  await uploaded(another)
  const otherBucket = machine(deviceA, await memoryRelay('anyhost-other'), folder)
  await welcomed(otherBucket.capture.relay)
  expect([journals(otherBucket.capture.db), existsSync(parts)]).toEqual([0, false])
})

test('a database of a newer anyhost is refused whole, so an older anyhost drops none of its sessions', async () => {
  const relay = await memoryRelay()
  const folder = temporaryFolder()
  const { transcript, upload, capture } = machine(deviceA, relay, folder)
  writeFileSync(transcript, lines.join(''))
  await upload(transcript)
  capture.db.run('pragma user_version = 99')
  capture.db.close()

  expect(() => openDatabase(join(folder, 'state'))).toThrow(`${join(folder, 'state', 'anyhost.db')} is a database of a newer anyhost, at version 99, and this anyhost reads version 5, so it changes nothing there. Update anyhost on this machine.`)
  const kept = new Database(join(folder, 'state', 'anyhost.db'))
  expect(kept.query<{ count: number }, []>('select count(*) as count from sessions').get()?.count).toBe(1)
})

test('a database of version 4 opens at version 5 with every row it held, one stamped 5 without its columns gains them, and one older than version 4 starts over', () => {
  const databaseAt = (version: number): string => {
    const folder = join(temporaryFolder(), 'state')
    mkdirSync(folder)
    const db = new Database(join(folder, 'anyhost.db'))
    db.run(`create table journals (
      session text primary key, tool text not null, end integer not null default 0, sealed integer not null default 0,
      written_at integer not null default 0, stopped text not null default '', holder text not null default '', untold text not null default '')`)
    db.run(`create table files (
      session text not null, path text not null, journal_size integer not null default 0, local_size integer not null default 0,
      tail blob not null default x'', sha256 text not null default '', mtime integer not null default 0, primary key (session, path))`)
    db.query("insert into journals (session, tool, end, sealed, written_at) values (?, 'claude', 900, 600, 1700000000000)").run(SESSION)
    db.query('insert into files (session, path, journal_size, local_size) values (?, ?, 900, 900)').run(SESSION, '/home/ada/.claude/projects/-work-trip/s.jsonl')
    db.run(`pragma user_version = ${version}`)
    db.close()
    return folder
  }
  const rowsOf = (db: Database): unknown[] => [
    db.query('pragma user_version').get(),
    db.query('select session, end, sealed, written_at, compacted_end, compacted_kept, compact_after, replaced from journals').all(),
    db.query('select session, path, journal_size from files').all(),
  ]

  expect(rowsOf(openDatabase(databaseAt(4)))).toEqual([
    { user_version: 5 },
    [{ session: SESSION, end: 900, sealed: 600, written_at: 1700000000000, compacted_end: 0, compacted_kept: 0, compact_after: 0, replaced: 0 }],
    [{ session: SESSION, path: '/home/ada/.claude/projects/-work-trip/s.jsonl', journal_size: 900 }],
  ])
  expect(rowsOf(openDatabase(databaseAt(5)))).toEqual(rowsOf(openDatabase(databaseAt(4))))
  expect(rowsOf(openDatabase(databaseAt(3)))).toEqual([{ user_version: 5 }, [], []])
})
