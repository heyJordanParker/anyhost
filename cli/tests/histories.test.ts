import { expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { decompress, type RecordHeader } from '../src/capture.ts'
import type { Agents } from '../src/sessions.ts'
import { ownerOf } from '../src/transcript.ts'
import { memoryRelay, until } from './memory.ts'
import { anyhostOn, dataFolderOn, decoder, HOST, isUploaded, LAPTOP, machineFor, roots, serveOn, SESSION } from './program.ts'

const MOD = 'diary'
const FIRST = '{"said":"Plan the trip"}\n'
const SECOND = '{"said":"Book the train"}\n'

const recordsOf = (body: Uint8Array): { readonly header: RecordHeader; readonly text: string }[] => {
  const records: { header: RecordHeader; text: string }[] = []
  for (let at = 0, bytes = decompress(body); at < bytes.length; ) {
    const newline = bytes.indexOf(10, at)
    const header = JSON.parse(decoder.decode(bytes.subarray(at, newline))) as RecordHeader
    records.push({ header, text: decoder.decode(bytes.subarray(newline + 1, newline + 1 + header.size)) })
    at = newline + 1 + header.size
  }
  return records
}

test("a data folder's rebuildable patterns read as .gitignore lines: a name matches at any depth, a slash anchors it, a trailing slash matches folders alone, and ! keeps a file again", () => {
  const data = { mod: MOD, folder: '/data/diary', rebuildable: ['*.index', '!keep.index', '/top.db', 'cache/', 'index/**/*.bin', '# a comment', ''] }
  const isKept = (path: string): boolean => ownerOf(join(data.folder, path), roots('/home/ada'), [data]) !== undefined

  expect(['a.index', 'deep/b.index', 'top.db', 'cache/x', 'deep/cache/y', 'index/a/b/c.bin', 'index/c.bin'].filter(isKept)).toEqual([])
  const kept = ['keep.index', 'deep/keep.index', 'deep/top.db', 'cache', 'deep/index/c.bin', 'day/2026-11-13.jsonl', '# a comment']
  expect(kept.filter(isKept)).toEqual(kept)
  expect(ownerOf(join(data.folder, 'notes.md'), roots('/home/ada'), [data])).toEqual({ mod: MOD })
})

test("a mod's data folder is this machine's history: every file but the rebuildable ones goes up, and an append uploads only its new bytes", async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, { uploadEvery: 0 })
  const folder = dataFolderOn(host, MOD, ['main.index'])
  const history = `${MOD}@${HOST.id}`
  const day = join(folder, 'day', '2026-11-13.jsonl')
  mkdirSync(dirname(day), { recursive: true })
  writeFileSync(join(folder, 'main.index'), 'an index the mod rebuilds\n')
  await serveOn(host.env)
  await until(() => relay.isConnected(HOST.id), 'the machine connecting')

  writeFileSync(day, FIRST)
  writeFileSync(join(folder, 'main.index'), 'the index, rebuilt\n')
  await until(() => isUploaded(relay, history, 'Plan the trip'), 'the day file uploaded', 30_000)
  appendFileSync(day, SECOND)
  await until(() => isUploaded(relay, history, 'Book the train'), 'the appended line uploaded', 30_000)
  const frames = relay.puts.filter(({ key }) => key.startsWith(`journals/${history}/hot/`)).map(({ body }) => recordsOf(body))

  expect(frames.flat().map(({ header }) => header.path)).toEqual([day, day])
  expect(frames.at(-1)?.map(({ header, text }) => ({ path: header.path, checkout: header.checkout, at: header.at, size: header.size, text }))).toEqual([
    { path: day, checkout: folder, at: FIRST.length, size: SECOND.length, text: SECOND },
  ])
  expect((await relay.keys(`journals/${history}/`)).length).toBeGreaterThan(0)
  expect((await relay.claims()).get(history)).toBe(HOST.id)
}, 60_000)

test("anyhost resume --data places another machine's copy of a mod's data folder into this machine's empty one byte for byte, which this machine keeps as its own history, and refuses a folder that holds a file", async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, { uploadEvery: 0 })
  const folder = dataFolderOn(host, MOD, ['main.index'])
  const files = { [join('day', '2026-11-13.jsonl')]: `${FIRST}${SECOND}`, 'notes.md': 'Lisbon, then Porto\n', [join('items', 'trip.bin')]: '\u0000\u0001 seat 42' }
  await serveOn(host.env)
  await until(() => relay.isConnected(HOST.id), 'the host connecting')
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, name)), { recursive: true })
    writeFileSync(join(folder, name), text)
  }
  writeFileSync(join(folder, 'main.index'), 'an index the mod rebuilds\n')
  await until(() => isUploaded(relay, `${MOD}@${HOST.id}`, 'Lisbon, then Porto') && isUploaded(relay, `${MOD}@${HOST.id}`, 'seat 42') && isUploaded(relay, `${MOD}@${HOST.id}`, 'Book the train'), "the host's data uploaded", 30_000)
  const laptop = await machineFor(relay, LAPTOP, { uploadEvery: 0 })
  const there = dataFolderOn(laptop, MOD, ['main.index'])
  mkdirSync(there, { recursive: true })
  writeFileSync(join(there, 'kept.txt'), 'the laptop wrote this\n')
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')

  const refused = await anyhostOn(laptop.env, ['resume', '--data', MOD, '--from', HOST.name])
  const keptAfterRefusal = readdirSync(there)
  rmSync(join(there, 'kept.txt'))
  const placed = await anyhostOn(laptop.env, ['resume', '--data', MOD, '--from', HOST.name])
  await until(() => isUploaded(relay, `${MOD}@${LAPTOP.id}`, 'Lisbon, then Porto'), "the laptop's own history of the placed folder uploaded", 30_000)

  expect(refused.code).toBe(1)
  expect(refused.err).toContain(`${there} holds files already`)
  expect(keptAfterRefusal).toEqual(['kept.txt'])
  expect(placed).toMatchObject({ code: 0, err: '' })
  for (const name of Object.keys(files)) expect(readFileSync(join(there, name))).toEqual(readFileSync(join(folder, name)))
  expect(existsSync(join(there, 'main.index'))).toBe(false)
  expect((await relay.claims()).get(`${MOD}@${HOST.id}`)).toBe(HOST.id)
  expect((await relay.claims()).get(`${MOD}@${LAPTOP.id}`)).toBe(LAPTOP.id)
}, 90_000)

test('a cmod that answers cmod data with a nonzero exit keeps no data folder', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, { uploadEvery: 0 })
  const day = join(host.env['XDG_DATA_HOME'] ?? '', 'cmod', 'data', MOD, 'day', '2026-11-13.jsonl')
  mkdirSync(dirname(day), { recursive: true })
  const served = await serveOn(host.env)
  await until(() => relay.isConnected(HOST.id), 'the machine connecting')

  writeFileSync(day, FIRST)
  const transcript = join(host.env['HOME'] ?? '', '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
  await until(() => isUploaded(relay, SESSION, 'Plan the trip'), 'the session written after the day file uploaded', 30_000)
  await Bun.sleep(1000)

  expect(await relay.keys(`journals/${MOD}@`)).toEqual([])
  expect(served.logged()).toContain('anyhost keeps no mod\'s data folder, as cmod data --json, which names each folder and the files its mod rebuilds by itself, failed: ')
}, 60_000)

test('/agents, anyhost list and the index list no mod history, and no session id prefix names one', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, { uploadEvery: 0 })
  const folder = dataFolderOn(host, MOD, [])
  const home = host.env['HOME'] ?? ''
  await serveOn(host.env)
  await until(() => relay.isConnected(HOST.id), 'the machine connecting')

  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'notes.md'), 'Lisbon, then Porto\n')
  const transcript = join(home, '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","cwd":${JSON.stringify(join(home, 'work'))},"message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
  await until(() => isUploaded(relay, `${MOD}@${HOST.id}`, 'Lisbon, then Porto') && isUploaded(relay, SESSION, 'Plan the trip'), 'the history and the session uploaded', 30_000)
  await until(async () => (await relay.read(`sessions/${HOST.id}/index.json`)) !== undefined, 'the index written', 30_000)
  const agents = (await (await fetch('http://localhost/agents', { unix: host.socket })).json()) as Agents
  const listed = await anyhostOn(host.env, ['list', '--json'])
  const index = JSON.parse(decoder.decode((await relay.read(`sessions/${HOST.id}/index.json`)) ?? new Uint8Array())) as { readonly id: string }[]
  const opened = await anyhostOn(host.env, ['open', MOD.slice(0, 3)])

  expect(opened.code).toBe(1)
  expect(opened.err).toContain(`No session's id begins with ${MOD.slice(0, 3)}.`)
  expect(agents.agents.map(({ id }) => id)).toEqual([SESSION])
  expect((JSON.parse(listed.out) as Agents).agents.map(({ id }) => id)).toEqual([SESSION])
  expect(index.map(({ id }) => id)).toEqual([SESSION])
}, 60_000)
