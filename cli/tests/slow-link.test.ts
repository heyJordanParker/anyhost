import { expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MAX_MESSAGE_BYTES } from '../../relay/protocol.ts'
import { journalOf, QUIET_MS, sealQuiet, spoolOf } from '../src/capture.ts'
import { failTest, memoryRelay } from './memory.ts'
import { captureOn, HOST, SESSION, uploadFiles } from './program.ts'

test('a seal over a link paced both ways, whose 16 answers queued ahead of any pong take past 70 seconds, finishes on its one socket, asking for each frame once', async () => {
  const relay = await memoryRelay()
  const { roots, capture } = captureOn(HOST, relay)
  const transcript = join(roots.claudeHome, 'projects', '-work-trip', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  const frames = 17
  for (let frame = 0; frame < frames; frame += 1) {
    const text = Buffer.from(crypto.getRandomValues(new Uint8Array(700 * 1024))).toString('base64')
    appendFileSync(transcript, `{"type":"user","message":{"role":"user","content":"${text}"},"sessionId":"${SESSION}"}\n`)
    await uploadFiles(capture, SESSION, transcript)
  }
  const hotFrames = (): Promise<string[]> => relay.keys(`journals/${SESSION}/hot/`)
  const sizes = (await Promise.all((await hotFrames()).map(async (key) => (await relay.read(key))?.length ?? 0))).sort((a, b) => b - a)
  expect(sizes).toHaveLength(frames)
  expect(sizes[0]).toBeLessThan(MAX_MESSAGE_BYTES)
  expect((sizes.at(-1) ?? 0) * 2).toBeGreaterThan(MAX_MESSAGE_BYTES)
  rmSync(spoolOf(capture.db, SESSION), { recursive: true, force: true })
  const quiet = (journalOf(capture.db, SESSION)?.writtenAt ?? 0) + QUIET_MS + 60_000
  relay.downloadBytesPerMs = 150
  relay.uploadBytesPerMs = 150
  expect(sizes.slice(1).reduce((sum, size) => sum + size, 0) / relay.downloadBytesPerMs).toBeGreaterThan(70_000)
  let welcomes = 0
  capture.relay.on('welcome', () => (welcomes += 1))
  const asked = relay.requests.length

  expect(await sealQuiet(capture, failTest, quiet)).toEqual(new Map())
  expect(welcomes).toBe(0)
  expect(journalOf(capture.db, SESSION)?.sealed).toBe(journalOf(capture.db, SESSION)?.end ?? -1)
  expect(await hotFrames()).toEqual([])
  expect(relay.requests.slice(asked).filter((ops) => ops.some(({ op }) => op === 'get'))).toHaveLength(frames)
}, 240_000)
