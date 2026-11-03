import { expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureFiles, merge, mergeQuiet, openDatabase, segmentPrefix, uploadFile, type Capture } from '../src/capture.ts'
import { takeClaim } from '../src/claims.ts'
import { chainOf, downloadSession } from '../src/sessions.ts'
import { summarize, type Root, type Summary } from '../src/transcript.ts'
import { memoryStore, temporaryFolder } from './memory.ts'

const SESSION = '11111111-2222-3333-4444-555555555555'
const device = { id: 'device-a', name: 'anyhost-a', os: 'linux', arch: 'arm64' }
const lines = [
  `{"type":"custom-title","customTitle":"Plan the trip","sessionId":"${SESSION}"}\n`,
  `{"parentUuid":null,"type":"user","message":{"role":"user","content":"Book a train to Sofia 🚆, ще пътувам утре"},"cwd":"/nowhere/trip","sessionId":"${SESSION}"}\n`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Booked the 08:15 — seat 42."}]},"cwd":"/nowhere/trip","sessionId":"${SESSION}"}\n`,
]

const emptySummary: Summary = { title: '', titleRank: 0, firstPrompt: '', cwd: '', repo: '' }

const failTest =(error: unknown): never => {
  throw error
}

function transcript() {
  const folder = temporaryFolder()
  const root: Root = { tool: 'claude', folder: join(folder, 'projects') }
  const path = join(root.folder, '-nowhere-trip', `${SESSION}.jsonl`)
  mkdirSync(join(root.folder, '-nowhere-trip'), { recursive: true })
  const store = memoryStore()
  const capture: Capture = { store, db: openDatabase(join(folder, 'state')), device }
  return { root, path, store, capture }
}

test('offset capture never re-uploads a byte', async () => {
  const { root, path, store, capture } = transcript()
  writeFileSync(path, lines[0] ?? '')
  await uploadFile(capture, root, path)
  appendFileSync(path, `${lines[1]}${lines[2]?.slice(0, 20)}`)
  await uploadFile(capture, root, path)
  await uploadFile(capture, root, path)
  appendFileSync(path, lines[2]?.slice(20) ?? '')
  await uploadFile(capture, root, path)
  await uploadFile(capture, root, path)

  const sizes = lines.map((line) => Buffer.byteLength(line))
  const [first = 0, second = 0, third = 0] = sizes
  const segments = store.puts.filter(({ key }) => key.endsWith('.jsonl'))
  expect(segments.map(({ key }) => key)).toEqual([
    `sessions/device-a/${SESSION}/0-${first}.jsonl`,
    `sessions/device-a/${SESSION}/${first}-${first + second}.jsonl`,
    `sessions/device-a/${SESSION}/${first + second}-${first + second + third}.jsonl`,
  ])
  expect(segments.map(({ body }) => new TextDecoder().decode(body))).toEqual(lines)
  expect(segments.reduce((total, { body }) => total + body.length, 0)).toBe(Bun.file(path).size)
})

test('a segment holds exact bytes, and so does the merge of a quiet session', async () => {
  const { root, path, store, capture } = transcript()
  for (const line of lines) {
    appendFileSync(path, line)
    await uploadFile(capture, root, path)
  }
  const written = new Uint8Array(await Bun.file(path).arrayBuffer())
  expect(Buffer.from((await downloadSession(store, [device.id], SESSION)).get(SESSION) ?? []).equals(written)).toBe(true)

  await mergeQuiet(capture, Date.now())
  expect((await store.list(segmentPrefix(device.id, SESSION))).length).toBe(3)
  await mergeQuiet(capture, Date.now() + 10 * 60_000 + 1)
  expect((await store.list(segmentPrefix(device.id, SESSION))).map(({ key }) => key)).toEqual([`sessions/device-a/${SESSION}/0-${written.length}.jsonl`])
  expect(Buffer.from(store.objects.get(`sessions/device-a/${SESSION}/0-${written.length}.jsonl`)?.body ?? []).equals(written)).toBe(true)
})

test('a merge that stopped between its write and its deletes is finished by the next merge', async () => {
  const { root, path, store, capture } = transcript()
  for (const line of lines) {
    appendFileSync(path, line)
    await uploadFile(capture, root, path)
  }
  const prefix = segmentPrefix(device.id, SESSION)
  const parts = await store.list(prefix)
  const whole = Buffer.concat(parts.map(({ key }) => store.objects.get(key)?.body ?? new Uint8Array()))
  await store.put(`${prefix}0-${whole.length}.jsonl`, whole)

  expect(Buffer.from((await downloadSession(store, [device.id], SESSION)).get(SESSION) ?? []).equals(whole)).toBe(true)
  await merge(store, prefix)
  expect((await store.list(prefix)).map(({ key }) => key)).toEqual([`${prefix}0-${whole.length}.jsonl`])
})

test('a device whose session another device claimed uploads nothing more of it', async () => {
  const { root, path, store, capture } = transcript()
  writeFileSync(path, lines[0] ?? '')
  await captureFiles(capture, new Map([[path, root]]), failTest)
  await takeClaim(store, SESSION, 'device-b', { take: false })
  appendFileSync(path, lines[1] ?? '')

  expect(await captureFiles(capture, new Map([[path, root]]), failTest)).toEqual(new Map())
  expect(store.puts.filter(({ key }) => key.endsWith('.jsonl')).map(({ key }) => key)).toEqual([`sessions/device-a/${SESSION}/0-${Buffer.byteLength(lines[0] ?? '')}.jsonl`])
})

test('a backlog file the pass has no time left for waits for the next pass', async () => {
  const { root, path, store, capture } = transcript()
  writeFileSync(path, lines.join(''))

  expect(await captureFiles(capture, new Map([[path, root]]), failTest, { parallel: 4, until: Date.now() - 1 })).toEqual(new Map([[path, root]]))
  expect(store.puts).toEqual([])
})

test("the transcript follows the longest chain, past bytes the old holder wrote after the move", () => {
  const session = (device: string, start: number, end: number) => ({ key: `sessions/${device}/${SESSION}/${start}-${end}.jsonl`, start, end })
  const chain = chainOf([session('a', 0, 100), session('a', 100, 150), session('a', 150, 170), session('b', 100, 130), session('b', 130, 400)])

  expect(chain.map(({ key }) => key)).toEqual([`sessions/a/${SESSION}/0-100.jsonl`, `sessions/b/${SESSION}/100-130.jsonl`, `sessions/b/${SESSION}/130-400.jsonl`])
})

test('a line still being written waits for its end', async () => {
  const { root, path, store, capture } = transcript()
  writeFileSync(path, lines[0]?.slice(0, 10) ?? '')
  await uploadFile(capture, root, path)
  expect(store.puts).toEqual([])
})

test("the working folder is the session's own, never a folder a tool call names", () => {
  const claude = summarize(emptySummary, `{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"cwd":"/elsewhere"}}]},"cwd":"/work/app"}\n`, 'claude')
  const codex = summarize(
    emptySummary,
    `{"timestamp":"2026-10-27T20:02:13.653Z","type":"session_meta","payload":{"id":"x","cwd":"/Users/jordan"}}\n{"timestamp":"2026-10-27T20:02:20.000Z","type":"response_item","payload":{"arguments":{"cwd":"file:///Users/jordan/other"}}}\n`,
    'codex',
  )
  expect([claude.cwd, codex.cwd]).toEqual(['/work/app', '/Users/jordan'])
})

test("the index entry holds the session's title, first prompt and working folder", async () => {
  const { root, path, capture } = transcript()
  writeFileSync(path, lines.join(''))
  await uploadFile(capture, root, path)
  const row = capture.db.query<{ title: string; first_prompt: string; cwd: string }, []>('select title, first_prompt, cwd from sessions').get()
  expect(row).toEqual({ title: 'Plan the trip', first_prompt: 'Book a train to Sofia 🚆, ще пътувам утре', cwd: '/nowhere/trip' })
})
