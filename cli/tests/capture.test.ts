import { Database } from 'bun:sqlite'
import { expect, spyOn, test } from 'bun:test'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  changedFiles, CODE_PIECE_BYTES, CODE_PIECES, compressHot, decompress, encodeRecord, hotKey, isCodePart, journalOf, openCapture, openDatabase, seal, sessionsOf, startLineOffsets, uploadSession,
  type Problems, type RecordHeader,
} from '../src/capture.ts'
import type { Device, MachineRoots } from '../src/device.ts'
import { UploadQueue } from '../src/serve.ts'
import { downloadJournal } from '../src/sessions.ts'
import type { Store } from '../src/store.ts'
import { codexState, summarize } from '../src/transcript.ts'
import { memoryStore, noCode, temporaryFolder, type MemoryStore } from './memory.ts'

const SESSION = '11111111-2222-3333-4444-555555555555'
const OTHER = '99999999-2222-3333-4444-555555555555'
// the session's working folder, which captureCode reads only when it exists
const TRIP = join(temporaryFolder(), 'trip')
mkdirSync(TRIP)
const deviceA: Device = { id: 'device-a', name: 'anyhost-a', os: 'linux', arch: 'arm64' }
const deviceB: Device = { id: 'device-b', name: 'anyhost-b', os: 'linux', arch: 'arm64' }
const lines = [
  `{"type":"custom-title","customTitle":"Plan the trip","sessionId":"${SESSION}"}\n`,
  `{"parentUuid":null,"type":"user","message":{"role":"user","content":"Book a train to Sofia 🚆, ще пътувам утре"},"cwd":${JSON.stringify(TRIP)},"entrypoint":"cli","sessionId":"${SESSION}"}\n`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Booked the 08:15 — seat 42."}]},"cwd":${JSON.stringify(TRIP)},"sessionId":"${SESSION}"}\n`,
]
const failTest: Problems = {
  set: (_key, error) => {
    throw error
  },
  clear: () => undefined,
}
const decoded = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

function machine(device: Device, store: Store, folder = temporaryFolder()) {
  const roots: MachineRoots = { home: join(folder, 'home'), claudeTmp: join(folder, 'tmp', 'claude-1000'), codexHome: join(folder, 'home', '.codex') }
  const transcript = join(roots.home, '.claude', 'projects', '-work-trip', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  const capture = openCapture(store, device, roots, openDatabase(join(folder, 'state')), noCode)
  const upload = (...paths: string[]): Promise<Set<string>> => uploadSession(capture, SESSION, 'claude', new Set(paths), failTest)
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

const hotFrames = (store: MemoryStore, session = SESSION): string[] => [...store.objects.keys()].filter((key) => key.startsWith(`journals/${session}/hot/`)).sort()
const journalBytes = (store: MemoryStore): Uint8Array => Buffer.concat(hotFrames(store).map((key) => decompress(store.objects.get(key)?.body ?? new Uint8Array())))

test('offset capture never re-uploads a byte', async () => {
  const store = memoryStore()
  const { transcript, upload } = machine(deviceA, store)
  writeFileSync(transcript, lines[0] ?? '')
  await upload(transcript)
  appendFileSync(transcript, `${lines[1]}${lines[2]?.slice(0, 20)}`)
  await upload(transcript)
  await upload(transcript)
  appendFileSync(transcript, lines[2]?.slice(20) ?? '')
  await upload(transcript)

  const records = recordsOf(journalBytes(store)).filter(({ header }) => header.path === transcript)
  expect(records.map(({ text }) => text)).toEqual(lines)
  expect(records.map(({ header }) => header.at)).toEqual([0, Buffer.byteLength(lines[0] ?? ''), Buffer.byteLength(`${lines[0]}${lines[1]}`)])
  expect(records.at(-1)?.header.after).toEqual({ size: Bun.file(transcript).size, sha256: new Bun.CryptoHasher('sha256').update(readFileSync(transcript)).digest('hex') })
  expect(hotFrames(store).length).toBe(3)
})

test("a background command's output uploads whole lines, as a transcript does", async () => {
  const store = memoryStore()
  const { roots, transcript, upload } = machine(deviceA, store)
  const output = join(roots.claudeTmp, '-work-trip', SESSION, 'tasks', 'b1.output')
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(transcript, lines[0] ?? '')
  writeFileSync(output, 'building /home/ada/work/trip\nlinking /home/ada/wo')
  await upload(transcript, output)
  appendFileSync(output, 'rk/trip\n')
  await upload(output)

  expect(recordsOf(journalBytes(store)).filter(({ header }) => header.path === output).map(({ text }) => text)).toEqual(['building /home/ada/work/trip\n', 'linking /home/ada/work/trip\n'])
})

test('a line still being written waits for its end', async () => {
  const store = memoryStore()
  const { transcript, upload } = machine(deviceA, store)
  writeFileSync(transcript, lines[0]?.slice(0, 10) ?? '')
  await upload(transcript)
  expect(store.puts).toEqual([])
})

test("a session's subagents, tool results, plan, pasted text, history lines and background output enter its journal", async () => {
  const store = memoryStore()
  const { roots, transcript, upload } = machine(deviceA, store)
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

  const records = recordsOf(journalBytes(store))
  for (const [name, path] of Object.entries(files)) expect(records.find(({ header }) => header.path === path)?.text).toBe(`${name}\n`)
  expect(records.find(({ header }) => header.path === join(claude, 'history.jsonl'))?.text).toBe(mine)
  expect(records.some(({ header }) => header.path === atomicWrite)).toBe(false)
})

test('replay of append, write-once and rewrite records', async () => {
  const store = memoryStore()
  const record = (device: string, path: string, at: number, text: string): Uint8Array[] =>
    encodeRecord({ device, path, at, size: Buffer.byteLength(text), after: { size: at + Buffer.byteLength(text), sha256: '' } }, new TextEncoder().encode(text))
  const first = Buffer.concat([...record('a', '/h/log.jsonl', 0, 'one\n'), ...record('a', '/h/once.txt', 0, 'written once'), ...record('a', '/h/state.json', 0, '{"step":"first, and longer"}')])
  const second = Buffer.concat([...record('b', '/h/log.jsonl', 4, 'two\n'), ...record('b', '/h/state.json', 0, '{"step":2}')])
  // a record may span two frames
  await store.put(hotKey(SESSION, 0), compressHot(first))
  await store.put(hotKey(SESSION, first.length), compressHot(second.subarray(0, 30)))
  await store.put(hotKey(SESSION, first.length + 30), compressHot(second.subarray(30)))

  const replayed = await downloadJournal(store, SESSION, temporaryFolder(), ({ path }) => path)
  const text = (path: string): string => readFileSync(replayed.files.get(path)?.staged ?? '', 'utf8')
  expect([text('/h/log.jsonl'), text('/h/once.txt'), text('/h/state.json')]).toEqual(['one\ntwo\n', 'written once', '{"step":2}'])
  expect(replayed.files.get('/h/log.jsonl')?.segments).toEqual([
    { device: 'a', path: '/h/log.jsonl', offset: 0, size: 4 },
    { device: 'b', path: '/h/log.jsonl', offset: 4, size: 4 },
  ])
  expect(replayed.files.get('/h/state.json')?.segments).toEqual([{ device: 'b', path: '/h/state.json', offset: 0, size: 10 }])
  expect(replayed.end).toBe(first.length + second.length)
})

test("a drain never waits on git: the files go up at once, the code follows in its own frame, and a part goes up once", async () => {
  const store = memoryStore()
  const folder = temporaryFolder()
  const roots: MachineRoots = { home: join(folder, 'home'), claudeTmp: join(folder, 'tmp', 'claude-1000'), codexHome: join(folder, 'home', '.codex') }
  const transcript = join(roots.home, '.claude', 'projects', '-work-trip', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  const part = { path: `anyhost:code/${SESSION}/parts/aa11`, bytes: new TextEncoder().encode('a large binary diff') }
  const releases: (() => void)[] = []
  const heard: string[] = []
  const capture = openCapture(
    store,
    deviceA,
    roots,
    openDatabase(join(folder, 'state')),
    {
      captureCode: (_folder, _session) => new Promise((resolve) => releases.push(() => resolve({ header: new TextEncoder().encode(`{"head":"${releases.length}"}`), parts: [part] }))),
      restoreCode: async (_header, _readPart, at) => at,
    },
    (_session, _tool, at) => void heard.push(at),
  )
  const upload = (...paths: string[]): Promise<Set<string>> => uploadSession(capture, SESSION, 'claude', new Set(paths), failTest)
  writeFileSync(transcript, lines[1] ?? '')

  // git answers only when the test says, and the upload has returned before it
  const gitAsked = async (count: number): Promise<void> => {
    while (releases.length < count) await Bun.sleep(1)
  }
  await upload(transcript)
  expect(recordsOf(journalBytes(store)).map(({ header }) => header.path)).not.toContain(`${TRIP}/`)
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

  const frames = hotFrames(store).map((key) => recordsOf(decompress(store.objects.get(key)?.body ?? new Uint8Array())).map(({ header, text }) => `${header.path} ${text}`))
  expect(frames.slice(1)).toEqual([
    [`${part.path} a large binary diff`, `${TRIP}/ {"head":"1"}`],
    [`${transcript} ${lines[2]}`],
    [`${TRIP}/ {"head":"2"}`],
  ])
})

test('a code record whose upload failed goes up with the next drain, since captureCode counts its parts as written', async () => {
  const store = memoryStore()
  let isOffline = false
  const flaky: Store = { ...store, put: (key, body, condition) => (isOffline ? Promise.reject(new Error('connect ECONNREFUSED')) : store.put(key, body, condition)) }
  const folder = temporaryFolder()
  const roots: MachineRoots = { home: join(folder, 'home'), claudeTmp: join(folder, 'tmp', 'claude-1000'), codexHome: join(folder, 'home', '.codex') }
  const transcript = join(roots.home, '.claude', 'projects', '-work-trip', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  const bundle = { path: `anyhost:code/${SESSION}/parts/cc33`, bytes: new TextEncoder().encode('a bundle') }
  const captures = [
    { header: new TextEncoder().encode('header 1'), parts: [bundle] },
    { header: new TextEncoder().encode('header 2'), parts: [] },
  ]
  const capture = openCapture(flaky, deviceA, roots, openDatabase(join(folder, 'state')), {
    captureCode: async () => captures.shift(),
    restoreCode: async (_header, _readPart, at) => at,
  })
  const upload = (...paths: string[]): Promise<Set<string>> => uploadSession(capture, SESSION, 'claude', new Set(paths), failTest)
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

  const code = recordsOf(journalBytes(store))
    .filter(({ header }) => isCodePart(header.path) || header.path.endsWith('/'))
    .map(({ header, text }) => `${header.path} ${text}`)
  expect(code).toEqual([`${bundle.path} a bundle`, `${TRIP}/ header 1`, `${TRIP}/ header 2`])
})

test('at uploadEvery 0 a line goes up alone, and a long code part in pieces, several frames at once', async () => {
  const store = memoryStore()
  const folder = temporaryFolder()
  const roots: MachineRoots = { home: join(folder, 'home'), claudeTmp: join(folder, 'tmp', 'claude-1000'), codexHome: join(folder, 'home', '.codex') }
  const transcript = join(roots.home, '.claude', 'projects', '-work-trip', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  const bundle = { path: `anyhost:code/${SESSION}/parts/dd44`, bytes: crypto.getRandomValues(new Uint8Array((CODE_PIECES + 1) * CODE_PIECE_BYTES + 5)) }
  let reads = 0
  const capture = openCapture(store, deviceA, roots, openDatabase(join(folder, 'state')), {
    captureCode: async () => ({ header: new TextEncoder().encode(`header ${++reads}`), parts: reads === 1 ? [bundle] : [] }),
    restoreCode: async (_header, _readPart, at) => at,
  })
  const upload = (...paths: string[]): Promise<Set<string>> => uploadSession(capture, SESSION, 'claude', new Set(paths), failTest, true)
  writeFileSync(transcript, lines[1] ?? '')
  await upload(transcript)
  await capture.codeRuns.get(SESSION)
  expect(await upload(`${TRIP}/`)).toEqual(new Set([`${TRIP}/`]))
  appendFileSync(transcript, lines[2] ?? '')
  expect(await upload(transcript, `${TRIP}/`)).toEqual(new Set([`${TRIP}/`]))
  await upload(`${TRIP}/`)
  // the line changed the session while its code went up, so the code is read again once it is up
  await upload(`${TRIP}/`)
  await capture.codeRuns.get(SESSION)
  await upload(`${TRIP}/`)

  const frames = hotFrames(store).map((key) =>
    recordsOf(decompress(store.objects.get(key)?.body ?? new Uint8Array())).map(({ header, text }) => (header.path === transcript ? text : `${header.path} ${header.at} ${header.size}`)),
  )
  const piece = (index: number): string[] => [`${bundle.path} ${index * CODE_PIECE_BYTES} ${CODE_PIECE_BYTES}`]
  expect(frames.slice(1)).toEqual([
    ...Array.from({ length: CODE_PIECES }, (_, index) => piece(index)),
    [lines[2] ?? ''],
    piece(CODE_PIECES),
    [`${bundle.path} ${(CODE_PIECES + 1) * CODE_PIECE_BYTES} 5`, `${TRIP}/ 0 8`],
    [`${TRIP}/ 0 8`],
  ])
  const replayed = await downloadJournal(store, SESSION, temporaryFolder(), ({ path }) => path)
  expect(Buffer.from(readFileSync(replayed.files.get(bundle.path)?.staged ?? '')).equals(Buffer.from(bundle.bytes))).toBe(true)
  expect(replayed.files.get(bundle.path)?.last.after).toEqual({ size: bundle.bytes.length, sha256: new Bun.CryptoHasher('sha256').update(bundle.bytes).digest('hex') })
  expect(reads).toBe(2)
})

test('a refused position stops the machine that lost it, and its lines from there are a fork', async () => {
  const store = memoryStore()
  const a = machine(deviceA, store)
  const b = machine(deviceB, store)
  writeFileSync(a.transcript, lines[0] ?? '')
  writeFileSync(b.transcript, lines[1] ?? '')
  await a.upload(a.transcript)
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)

  expect(await b.upload(b.transcript)).toEqual(new Set())
  appendFileSync(b.transcript, lines[2] ?? '')
  await b.upload(b.transcript)

  expect(hotFrames(store)).toEqual([hotKey(SESSION, 0)])
  expect(recordsOf(journalBytes(store)).map(({ text }) => text)).toEqual([lines[0] ?? ''])
  expect(journalOf(b.capture.db, SESSION)?.stopped).toContain(`Another machine wrote byte 0 of the session ${SESSION}'s journal first, so anyhost-b stops capturing it`)
  expect(logged).toHaveBeenCalledTimes(1)
  logged.mockRestore()
})

test('a refused position that holds the same bytes counts as uploaded, as a retry after a lost answer does', async () => {
  const store = memoryStore()
  const { transcript, upload, capture } = machine(deviceA, store)
  writeFileSync(transcript, lines[0] ?? '')
  const bytes = new TextEncoder().encode(lines[0])
  const after = { size: bytes.length, sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex') }
  await store.put(hotKey(SESSION, 0), compressHot(Buffer.concat(encodeRecord({ device: deviceA.id, path: transcript, at: 0, size: bytes.length, after }, bytes))))

  await upload(transcript)
  expect(journalOf(capture.db, SESSION)).toMatchObject({ end: decompress(store.objects.get(hotKey(SESSION, 0))?.body ?? new Uint8Array()).length, stopped: '' })
})

test("a frame this machine put up that its journal never counted is written over, and a restore never reads one off the journal's chain", async () => {
  const store = memoryStore()
  const { transcript, upload, capture } = machine(deviceA, store)
  writeFileSync(transcript, lines[0] ?? '')
  const old = new TextEncoder().encode('old')
  const stray = compressHot(Buffer.concat(encodeRecord({ device: deviceA.id, path: transcript, at: 0, size: old.length, after: { size: old.length, sha256: '' } }, old)))
  // one where the next upload goes, as before a crash, and one past a position that failed
  await store.put(hotKey(SESSION, 0), stray)
  await store.put(hotKey(SESSION, 100_000), stray)

  await upload(transcript)
  expect(journalOf(capture.db, SESSION)?.stopped).toBe('')
  const replayed = await downloadJournal(store, SESSION, temporaryFolder(), ({ path }) => path)
  expect(readFileSync(replayed.files.get(transcript)?.staged ?? '', 'utf8')).toBe(lines[0] ?? '')
  expect(replayed.end).toBe(journalOf(capture.db, SESSION)?.end ?? -1)
})

test('a code frame that fails leaves the journal at the frames before it, and the next drain writes the rest', async () => {
  const store = memoryStore()
  let failing = 0
  let puts = 0
  const flaky: Store = {
    ...store,
    put: (key, body, condition) => ((puts += 1) === failing ? Promise.reject(new Error('connect ECONNREFUSED')) : store.put(key, body, condition)),
  }
  const folder = temporaryFolder()
  const roots: MachineRoots = { home: join(folder, 'home'), claudeTmp: join(folder, 'tmp', 'claude-1000'), codexHome: join(folder, 'home', '.codex') }
  const transcript = join(roots.home, '.claude', 'projects', '-work-trip', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  const bundle = { path: `anyhost:code/${SESSION}/parts/ee55`, bytes: crypto.getRandomValues(new Uint8Array(3 * CODE_PIECE_BYTES)) }
  const capture = openCapture(flaky, deviceA, roots, openDatabase(join(folder, 'state')), {
    captureCode: async () => ({ header: new TextEncoder().encode('header'), parts: [bundle] }),
    restoreCode: async (_header, _readPart, at) => at,
  })
  const upload = (...paths: string[]): Promise<Set<string>> => uploadSession(capture, SESSION, 'claude', new Set(paths), failTest, true)
  writeFileSync(transcript, lines[1] ?? '')
  await upload(transcript)
  await capture.codeRuns.get(SESSION)
  const lineEnd = journalOf(capture.db, SESSION)?.end ?? 0
  // the second of the drain's three code frames fails
  failing = puts + 2
  await expect(upload(`${TRIP}/`)).rejects.toThrow('ECONNREFUSED')

  const counted = journalOf(capture.db, SESSION)?.end ?? 0
  expect(hotFrames(store).at(-1)).toBe(hotKey(SESSION, lineEnd))
  expect(counted).toBe(lineEnd + decompress(store.objects.get(hotKey(SESSION, lineEnd))?.body ?? new Uint8Array()).length)
  await upload(`${TRIP}/`)
  const replayed = await downloadJournal(store, SESSION, temporaryFolder(), ({ path }) => path)
  expect(Buffer.from(readFileSync(replayed.files.get(bundle.path)?.staged ?? '')).equals(Buffer.from(bundle.bytes))).toBe(true)
  expect([...replayed.code.keys()]).toEqual([`${TRIP}/`])
  expect(replayed.end).toBe(journalOf(capture.db, SESSION)?.end ?? -1)
})

test('a file the session deleted goes up as a deletion record, heard from the watcher or found by the backup', async () => {
  const store = memoryStore()
  const { roots, transcript, upload, capture } = machine(deviceA, store)
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

  const deletions = recordsOf(journalBytes(store)).filter(({ header }) => header.after === null)
  expect(deletions.map(({ header }) => [header.path, header.at, header.size])).toEqual([
    [task, 0, 0],
    [plan, 0, 0],
  ])
  const replayed = await downloadJournal(store, SESSION, temporaryFolder(), ({ path }) => path)
  expect([replayed.files.has(task), replayed.files.has(plan), [...replayed.deleted]]).toEqual([false, false, [task, plan]])
  writeFileSync(task, '{"subject":"pack the bag"}')
  await upload(task)
  const again = await downloadJournal(store, SESSION, temporaryFolder(), ({ path }) => path)
  expect([readFileSync(again.files.get(task)?.staged ?? '', 'utf8'), [...again.deleted]]).toEqual(['{"subject":"pack the bag"}', [plan]])
})

test('a session whose working folder this machine lacks uploads its lines, keeps no code, and says so once', async () => {
  const store = memoryStore()
  const folder = temporaryFolder()
  const roots: MachineRoots = { home: join(folder, 'home'), claudeTmp: join(folder, 'tmp', 'claude-1000'), codexHome: join(folder, 'home', '.codex') }
  const transcript = join(roots.home, '.claude', 'projects', '-gone', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  const gone = join(folder, 'gone')
  let reads = 0
  const capture = openCapture(store, deviceA, roots, openDatabase(join(folder, 'state')), {
    captureCode: async () => ((reads += 1), undefined),
    restoreCode: async (_header, _readPart, at) => at,
  })
  const line = (text: string): string => `{"type":"user","message":{"role":"user","content":"${text}"},"cwd":${JSON.stringify(gone)},"sessionId":"${SESSION}"}\n`
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)
  for (const text of ['one', 'two']) {
    appendFileSync(transcript, line(text))
    await uploadSession(capture, SESSION, 'claude', new Set([transcript]), failTest, true)
    await capture.codeRuns.get(SESSION)
  }

  expect(reads).toBe(0)
  expect(logged.mock.calls.map(([message]) => String(message).slice(25))).toEqual([`${gone} is no folder on anyhost-a, so anyhost keeps no code of the sessions that work in it.`])
  logged.mockRestore()
  expect(recordsOf(journalBytes(store)).map(({ text }) => text)).toEqual([line('one'), line('two')])
})

test('a quiet session seals its hot frames into one sealed frame, and the journal reads the same', async () => {
  const store = memoryStore()
  const { transcript, upload } = machine(deviceA, store)
  for (const line of lines) {
    appendFileSync(transcript, line)
    await upload(transcript)
  }
  const before = journalBytes(store)

  expect(await seal(store, SESSION)).toBe(before.length)
  expect([...store.objects.keys()].filter((key) => key.startsWith(`journals/${SESSION}/`))).toEqual([`journals/${SESSION}/sealed/${'0'.padStart(16, '0')}-${String(before.length).padStart(16, '0')}.zst`])
  appendFileSync(transcript, lines[0] ?? '')
  await upload(transcript)
  const replayed = await downloadJournal(store, SESSION, temporaryFolder(), ({ path }) => path)
  expect(readFileSync(replayed.files.get(transcript)?.staged ?? '', 'utf8')).toBe(`${lines.join('')}${lines[0]}`)
  expect(replayed.sealedEnd).toBe(before.length)
})

test('a seal of a session of many frames reads at most 16 of them at once, as a restore does', async () => {
  const store = memoryStore()
  let reading = 0
  let most = 0
  const counting: Store = {
    ...store,
    get: async (key) => {
      most = Math.max(most, (reading += 1))
      return await store.get(key).finally(() => (reading -= 1))
    },
  }
  const { transcript, upload } = machine(deviceA, store)
  for (let index = 0; index < 40; index += 1) {
    appendFileSync(transcript, `{"type":"user","message":{"role":"user","content":"line ${index}"},"sessionId":"${SESSION}"}\n`)
    await upload(transcript)
  }
  expect(hotFrames(store)).toHaveLength(40)
  const before = journalBytes(store)

  expect(await seal(counting, SESSION)).toBe(before.length)
  expect(most).toBe(16)
  const sealed = [...store.objects.keys()].filter((key) => key.startsWith(`journals/${SESSION}/`))
  expect(sealed).toEqual([`journals/${SESSION}/sealed/${'0'.padStart(16, '0')}-${String(before.length).padStart(16, '0')}.zst`])
  expect(Buffer.from(decompress(store.objects.get(sealed[0] ?? '')?.body ?? new Uint8Array())).equals(Buffer.from(before))).toBe(true)
})

test("a Codex thread on a machine with no Codex database gets its name into the row Codex makes, as Codex writes it", async () => {
  const store = memoryStore()
  const { roots, capture } = machine(deviceA, store)
  const rollout = join(roots.codexHome, 'sessions', '2026', '11', '04', `rollout-2026-11-04T14-54-13-${SESSION}.jsonl`)
  mkdirSync(dirname(rollout), { recursive: true })
  writeFileSync(rollout, `{"type":"session_meta","payload":{"id":"${SESSION}","cwd":${JSON.stringify(TRIP)}}}\n`)
  const index = (name: string): string => `{"id":"${SESSION}","thread_name":"${name}","updated_at":"2026-11-04T13:15:48Z"}\n`
  writeFileSync(join(roots.codexHome, 'session_index.jsonl'), `${index('Trip notes')}${index('Osprey sighting notes')}`)
  await uploadSession(capture, SESSION, 'codex', new Set([rollout]), failTest)
  const wal = `${codexState(roots)}-wal`
  expect(await sessionsOf(capture, wal)).toEqual([{ session: SESSION, tool: 'codex' }])

  // Codex's first start here makes the database and the thread's row, with no name
  const codex = new Database(codexState(roots))
  codex.run('create table threads (id text primary key, title text not null, name text)')
  codex.query('insert into threads values (?, ?, null)').run(SESSION, 'What bird is named in notes.md?')
  await uploadSession(capture, SESSION, 'codex', new Set([codexState(roots)]), failTest)

  expect(codex.query<{ name: string }, [string]>('select name from threads where id = ?').get(SESSION)?.name).toBe('Osprey sighting notes')
  codex.close()
  const replayed = await downloadJournal(store, SESSION, temporaryFolder(), ({ path }) => path)
  expect(JSON.parse(readFileSync(replayed.files.get(codexState(roots))?.staged ?? '', 'utf8'))).toEqual({ id: SESSION, title: 'What bird is named in notes.md?', name: 'Osprey sighting notes' })
  expect(await sessionsOf(capture, wal)).toEqual([])
})

test('the backup finds a file that grew without an event', async () => {
  const store = memoryStore()
  const { transcript, upload, capture } = machine(deviceA, store)
  writeFileSync(transcript, lines[0] ?? '')
  await upload(transcript)
  expect(await changedFiles(capture)).toEqual(new Map())
  appendFileSync(transcript, lines[1] ?? '')
  expect(await changedFiles(capture)).toEqual(new Map([[SESSION, new Set([transcript])]]))
})

test('a lines file names the sessions that wrote new lines, and never the lines before the first start', async () => {
  const store = memoryStore()
  const { roots, capture } = machine(deviceA, store)
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
    (session, _tool, paths) => {
      uploads.push({ session, paths: [...paths] })
      return new Promise((resolve) => ends.push(() => resolve(new Set())))
    },
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
    async (_session, _tool, paths) => {
      tries.push(Date.now() - started)
      if (tries.length < 3) throw new Error('connect ECONNREFUSED')
      expect([...paths]).toEqual(['/a'])
      return new Set()
    },
    (session) => void failures.push(session),
  )
  queue.add(SESSION, 'claude', '/a')
  await Bun.sleep(3200)
  expect(tries.map((at) => Math.round(at / 1000))).toEqual([0, 1, 3])
  expect(failures).toEqual([SESSION, SESSION])
  expect(queue.pending).toBe(0)
})

test('the queue at N uploads each session once per N seconds while it writes', async () => {
  const uploads: { session: string; paths: string[]; at: number }[] = []
  const started = Date.now()
  const queue = new UploadQueue(
    0.3,
    async (session, _tool, paths) => {
      uploads.push({ session, paths: [...paths], at: Date.now() - started })
      return new Set()
    },
    (_session, error) => {
      throw error
    },
  )
  for (const path of ['/a', '/b', '/c']) {
    queue.add(SESSION, 'claude', path)
    await Bun.sleep(50)
  }
  await Bun.sleep(350 - (Date.now() - started))
  expect(uploads.map(({ paths }) => paths)).toEqual([['/a', '/b', '/c']])
  for (const path of ['/d', '/e']) {
    queue.add(SESSION, 'claude', path)
    await Bun.sleep(50)
  }
  await Bun.sleep(700 - (Date.now() - started))
  queue.uploadEvery = 0
  expect(uploads.map(({ paths }) => paths)).toEqual([
    ['/a', '/b', '/c'],
    ['/d', '/e'],
  ])
  expect(uploads.map(({ at }) => Math.round(at / 300))).toEqual([1, 2])
})

test("the working folder is the session's own, never a folder a tool call names", () => {
  const empty = { title: '', titleRank: 0, firstPrompt: '', cwd: '', repo: '', entrypoint: '' }
  const claude = summarize(empty, `{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"cwd":"/elsewhere"}}]},"cwd":"/work/app"}\n`, 'claude')
  const codex = summarize(
    empty,
    `{"timestamp":"2026-10-27T20:02:13.653Z","type":"session_meta","payload":{"id":"x","cwd":"/Users/ada","source":"cli"}}\n{"timestamp":"2026-10-27T20:02:20.000Z","type":"response_item","payload":{"arguments":{"cwd":"file:///Users/ada/other"}}}\n`,
    'codex',
  )
  expect([claude.cwd, codex.cwd, codex.entrypoint]).toEqual(['/work/app', '/Users/ada', 'cli'])
})

test("the index entry holds the session's title, first prompt, working folder and entrypoint", async () => {
  const store = memoryStore()
  const { transcript, upload, capture } = machine(deviceA, store)
  writeFileSync(transcript, lines.join(''))
  await upload(transcript)
  const row = capture.db.query<{ title: string; first_prompt: string; cwd: string; entrypoint: string }, []>('select title, first_prompt, cwd, entrypoint from sessions').get()
  expect(row).toEqual({ title: 'Plan the trip', first_prompt: 'Book a train to Sofia 🚆, ще пътувам утре', cwd: TRIP, entrypoint: 'cli' })
})
