import { Database } from 'bun:sqlite'
import { expect, onTestFinished, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { Activity } from '../src/activity.ts'
import { compressHot, journalOf, openCapture, openDatabase, QUIET_MS, recordSummary, relistSessions, seal, sealQuiet, untoldOf, writeIndex, type Capture } from '../src/capture.ts'
import { followHolders, HeldElsewhere, takeClaim } from '../src/claims.ts'
import type { Relay } from '../src/relay.ts'
import { devicesOf, type Device, type MachineRoots } from '../src/device.ts'
import { restore } from '../src/resume.ts'
import { agentsOf, downloadJournal, listSessions } from '../src/sessions.ts'
import type { AgentStatus } from '../../relay/protocol.ts'
import { pin, settle, snooze, type Shared } from '../src/shared.ts'
import { copyT3Marks } from '../src/t3.ts'
import { statusesHere } from '../src/move.ts'
import { eventLoopDuring, failTest, memoryRelay, noCode, until, type MemoryRelay } from './memory.ts'
import { captureOn, temporaryFolder, uploadFiles } from './program.ts'

const mac: Device = { id: 'device-mac', name: 'mac', os: 'darwin', arch: 'arm64' }
const server: Device = { id: 'device-server', name: 'server', os: 'linux', arch: 'x64' }
async function captured(relay: MemoryRelay, device: Device, session: string, prompt: string, cwd = '/work'): Promise<Capture> {
  const { roots, capture } = captureOn(device, relay)
  const transcript = join(roots.home, '.claude', 'projects', '-work', `${session}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":${JSON.stringify(prompt)}},"cwd":"${cwd}","sessionId":"${session}"}\n`)
  await uploadFiles(capture, session, transcript)
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
  const before = captureOn(mac, relay, home)
  await uploadFiles(before.capture, first, transcriptOf(before.roots, first, 'Plan the release'))
  await writeIndex(before.capture)

  const after = captureOn(mac, relay, home)
  await uploadFiles(after.capture, second, transcriptOf(after.roots, second, 'Fix the deploy'))
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
  const before = captureOn(mac, relay, home)
  await uploadFiles(before.capture, backedUp, transcriptOf(before.roots, backedUp, 'Plan the release'))
  transcriptOf(before.roots, never, 'Never backed up')
  const after = captureOn(mac, relay, home)
  await after.capture.relay.runOne({ op: 'put', key: `sessions/${mac.id}/index.json`, bytes: new TextEncoder().encode('[]') })

  expect(await relistSessions(after.capture)).toBe(1)
  await writeIndex(after.capture)

  expect(await listedOf(after.capture)).toEqual([{ id: backedUp, firstPrompt: 'Plan the release', deleted: false }])
})

test("a session the index alone lists, or whose row predates its last reply, is summarized once from its transcript's head and tail, and a Codex journal that never held its rollout stays unlisted", async () => {
  const relay = await memoryRelay()
  const [home, state] = [join(temporaryFolder(), 'home'), join(temporaryFolder(), 'state')]
  const { roots, capture: before } = captureOn(mac, relay, home, state)
  const kept = 'aaaaaaaa-0000-0000-0000-000000000001'
  const older = 'bbbbbbbb-0000-0000-0000-000000000002'
  const codex = '01a184d3-0f52-7951-bfb3-87495207e7d0'
  const line = (value: object): string => `${JSON.stringify(value)}\n`
  const prompt = (session: string, text: string): string => line({ type: 'user', timestamp: '2026-11-01T09:00:00.000Z', message: { role: 'user', content: text }, cwd: '/work', sessionId: session })
  const reply = (session: string, text: string, at: string): string => line({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text }] }, cwd: '/work', sessionId: session })
  const keptTranscript = transcriptOf(roots, kept, 'Plan the release')
  writeFileSync(keptTranscript, prompt(kept, 'Plan the release'))
  const olderTranscript = transcriptOf(roots, older, 'Fix the deploy')
  writeFileSync(olderTranscript, `${prompt(older, 'Fix the deploy')}${reply(older, 'The deploy works again.', '2026-11-02T10:00:00.000Z')}`)
  await uploadFiles(before, kept, keptTranscript)
  await uploadFiles(before, older, olderTranscript)
  await writeIndex(before)
  before.db.query('delete from sessions where id = ?').run(kept)
  before.db.query("update sessions set last_said = '' where id = ?").run(older)
  const filler = line({ type: 'progress', data: 'x'.repeat(1000) }).repeat(1500)
  appendFileSync(keptTranscript, `${filler}{"type":"assistant","message":{"content":[{"type":"text","text":"cut off\n${filler}${reply(kept, 'Released 1.2.0.', '2026-11-03T11:00:00.000Z')}`)
  const rollout = join(roots.codexHome, 'sessions', '2026', '10', '29', `rollout-2026-10-29T01-23-06-${codex}.jsonl.zst`)
  mkdirSync(dirname(rollout), { recursive: true })
  writeFileSync(rollout, await compressHot(new TextEncoder().encode(line({ type: 'session_meta', payload: { id: codex, cwd: '/work', originator: 'codex_exec' } }))))
  const index = JSON.parse(new TextDecoder().decode(await relay.read(`sessions/${mac.id}/index.json`))) as object[]
  const codexEntry = { id: codex, tool: 'codex', title: '', firstPrompt: '', cwd: '', repo: '', repoFolder: '', entrypoint: '', lastActivity: '2026-11-11T08:00:00.000Z', size: 120, deleted: false }
  await before.relay.runOne({ op: 'put', key: `sessions/${mac.id}/index.json`, bytes: new TextEncoder().encode(JSON.stringify([...index, codexEntry])) })
  await before.relay.runOne({ op: 'put', key: `journals/${codex}/hot/0000000000000000.zst`, bytes: await compressHot(new TextEncoder().encode('{}\n')) })
  const { capture } = captureOn(mac, relay, home, state)

  expect(await relistSessions(capture)).toBe(2)
  await writeIndex(capture)

  const listed = (await listSessions(capture)).map(({ id, firstPrompt, lastSaid, lastActivity }) => ({ id, firstPrompt, lastSaid, lastActivity }))
  expect(listed.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
    { id: kept, firstPrompt: 'Plan the release', lastSaid: 'Released 1.2.0.', lastActivity: '2026-11-03T11:00:00.000Z' },
    { id: older, firstPrompt: 'Fix the deploy', lastSaid: 'The deploy works again.', lastActivity: '2026-11-02T10:00:00.000Z' },
  ])
  expect(await relistSessions(capture)).toBe(0)
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
  const onServer = captureOn(server, relay).capture
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
  const onServer = captureOn(server, relay).capture
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
  const { roots, capture } = captureOn(mac, relay)
  const moved = join(roots.home, '.claude', 'projects', '-design', `${session}.jsonl`)
  const main = join(roots.home, '.claude', 'projects', '-work', `${session}.jsonl`)
  mkdirSync(dirname(moved), { recursive: true })
  mkdirSync(dirname(main), { recursive: true })
  writeFileSync(moved, `{"type":"history-suppression","sessionId":"${session}"}\n`)
  writeFileSync(main, `{"type":"user","message":{"role":"user","content":"Ship the release"},"cwd":"/work","sessionId":"${session}"}\n`)

  await uploadFiles(capture, session, moved, main)
  await writeIndex(capture)

  expect((await listSessions(capture)).map(({ firstPrompt, cwd }) => ({ firstPrompt, cwd }))).toEqual([{ firstPrompt: 'Ship the release', cwd: '/work' }])
})

test("a claimed session lists the holder's entry, even when the old holder wrote later", async () => {
  const relay = await memoryRelay()
  const session = 'aaaaaaaa-0000-0000-0000-000000000001'
  const entry = { id: session, tool: 'claude', title: '', firstPrompt: 'Plan the release', cwd: '/work', repo: '', repoFolder: '', entrypoint: 'cli', size: 10 }
  captureOn(mac, relay)
  const onServer = captureOn(server, relay)
  await relay.objects.put(`sessions/${mac.id}/index.json`, new TextEncoder().encode(JSON.stringify([{ ...entry, lastActivity: '2026-11-03T12:45:00.000Z' }])))
  await relay.objects.put(`sessions/${server.id}/index.json`, new TextEncoder().encode(JSON.stringify([{ ...entry, cwd: '/home/server/work', lastActivity: '2026-11-03T12:44:00.000Z' }])))
  await takeClaim(onServer.capture.relay, session, { take: false })

  expect((await listSessions(onServer.capture)).map(({ machine, holder, cwd, entrypoint }) => ({ machine, holder, cwd, entrypoint }))).toEqual([{ machine: 'server', holder: 'server', cwd: '/home/server/work', entrypoint: 'cli' }])
})

test('the agents list leaves out a session nobody wrote a prompt in, and names the session whose agent started each one', async () => {
  const relay = await memoryRelay()
  const entry = { tool: 'claude', title: '', cwd: '/work', repo: '', repoFolder: '', entrypoint: 'cli', size: 10, lastActivity: new Date().toISOString() }
  const { capture } = captureOn(mac, relay)
  await relay.objects.put(`sessions/${mac.id}/index.json`, new TextEncoder().encode(JSON.stringify([
    { ...entry, id: 'aaaaaaaa-0000-0000-0000-000000000001', firstPrompt: 'You are the CTO.' },
    { ...entry, id: 'bbbbbbbb-0000-0000-0000-000000000002', firstPrompt: 'Fix the login' },
    { ...entry, id: 'cccccccc-0000-0000-0000-000000000003', firstPrompt: '' },
  ])))
  await relay.objects.put('shared.json', new TextEncoder().encode(JSON.stringify({ parents: { 'bbbbbbbb-0000-0000-0000-000000000002': 'aaaaaaaa-0000-0000-0000-000000000001' } })))

  const { agents } = await agentsOf(capture)

  expect(agents.map(({ id, parent }) => [id.slice(0, 8), parent.slice(0, 8)]).sort()).toEqual([['aaaaaaaa', ''], ['bbbbbbbb', 'aaaaaaaa']])
})

test('a session nobody named is named by the first line of its first prompt, with each file path in it as its file name', async () => {
  const relay = await memoryRelay()
  const { capture } = captureOn(mac, relay)
  const entry = { tool: 'claude', cwd: '/work', repo: '', repoFolder: '', entrypoint: 'cli', size: 10, lastActivity: new Date().toISOString() }
  await relay.objects.put(`sessions/${mac.id}/index.json`, new TextEncoder().encode(JSON.stringify([
    { ...entry, id: 'aaaaaaaa-0000-0000-0000-000000000001', title: '', firstPrompt: '/private/tmp/claude-501/-Users-jordan-app/28781b46/scratchpad/handoff-cmod-link.md read this & propose\nthe rest' },
    { ...entry, id: 'bbbbbbbb-0000-0000-0000-000000000002', title: 'MCP speed fixes', firstPrompt: 'Fix ~/app/src/x.ts' },
  ])))

  const { agents } = await agentsOf(capture)

  expect(agents.map(({ title }) => title).sort()).toEqual(['MCP speed fixes', 'handoff-cmod-link.md read this & propose'])
})

const NOW = Date.parse('2026-11-15T12:00:00.000Z')
const hoursAgo = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString()
const idOf = (n: number): string => `aaaaaaaa-0000-0000-0000-00000000000${n}`

async function listedWith(sessions: readonly { readonly lastActivity: string; readonly lastPromptAt?: string }[], shared: object, statuses: Readonly<Record<string, AgentStatus>> = {}) {
  const relay = await memoryRelay()
  const { capture } = captureOn(mac, relay)
  const entry = { tool: 'claude', title: '', firstPrompt: 'Plan the trip', cwd: '/work', repo: '', repoFolder: '', entrypoint: 'cli', size: 10, lastPromptAt: '' }
  await relay.objects.put(`sessions/${mac.id}/index.json`, new TextEncoder().encode(JSON.stringify(sessions.map((session, at) => ({ ...entry, id: idOf(at + 1), ...session })))))
  await relay.objects.put('shared.json', new TextEncoder().encode(JSON.stringify(shared)))
  const listed = await agentsOf(capture, { statuses, since: {}, background: [] }, new Map(), undefined, NOW)
  const byId = (field: 'settled' | 'settledAt' | 'snoozedUntil' | 'archived') => sessions.map((_, at) => listed.agents.find(({ id }) => id === idOf(at + 1))?.[field])
  return { capture, relay, listed, byId }
}

test('the list of 50 sessions with 50 live terminals never holds the thread for 100 ms, and names each terminal', async () => {
  const relay = await memoryRelay()
  const { capture } = captureOn(mac, relay)
  const sessions = Array.from({ length: 50 }, (_, at) => `aaaaaaaa-0000-0000-0000-${String(at).padStart(12, '0')}`)
  const entry = { tool: 'claude', title: '', firstPrompt: 'Plan the trip', cwd: '/work', repo: '', repoFolder: '', entrypoint: 'cli', size: 10, lastActivity: new Date().toISOString(), lastPromptAt: '' }
  await relay.objects.put(`sessions/${mac.id}/index.json`, new TextEncoder().encode(JSON.stringify(sessions.map((id) => ({ ...entry, id })))))
  const terminals = new Map(sessions.map((session, at) => [session, `t${at}`]))

  const loop = await eventLoopDuring(async () => await agentsOf(capture, await statusesHere(capture, new Activity()), terminals))

  expect(loop.value.agents.map(({ terminal }) => terminal).sort()).toEqual(sessions.map((_, at) => `t${at}`).sort())
  expect(loop.longestStallMs).toBeLessThan(100)
})

test('a session idle past settleAfterDays reads settled, and a pinned, snoozed, working or waiting one does not', async () => {
  const idle = { lastActivity: hoursAgo(8 * 24) }

  const { byId } = await listedWith([idle, idle, idle, idle, idle], { pinned: { [idOf(2)]: hoursAgo(1) }, snoozed: { [idOf(3)]: { until: hoursAgo(-24), at: hoursAgo(1) } } }, { [idOf(4)]: 'working', [idOf(5)]: 'waiting' })

  expect(byId('settled')).toEqual([true, false, false, false, false])
})

test('a settle mark holds until the next message, which un-settles the session, and an unsettle mark keeps an idle session out of Settled until then', async () => {
  const { byId } = await listedWith(
    [{ lastActivity: hoursAgo(1) }, { lastActivity: hoursAgo(1) }, { lastActivity: hoursAgo(10 * 24) }, { lastActivity: hoursAgo(10 * 24) }],
    {
      settled: {
        [idOf(1)]: { settled: true, at: hoursAgo(0.5) },
        [idOf(2)]: { settled: true, at: hoursAgo(2) },
        [idOf(3)]: { settled: false, at: hoursAgo(9 * 24) },
        [idOf(4)]: { settled: false, at: hoursAgo(11 * 24) },
      },
    },
  )

  expect(byId('settled')).toEqual([true, false, false, true])
  expect(byId('settledAt')).toEqual([hoursAgo(0.5), '', '', hoursAgo(3 * 24)])
})

test('a session settles settleAfterDays after the later of its last message and the end of a snooze, and the list says when', async () => {
  const quiet = { lastActivity: hoursAgo(20 * 24) }

  const { byId } = await listedWith([quiet, quiet, quiet], { snoozed: { [idOf(2)]: { until: hoursAgo(10 * 24), at: hoursAgo(19 * 24) }, [idOf(3)]: { until: hoursAgo(2 * 24), at: hoursAgo(19 * 24) } } })

  expect(byId('settled')).toEqual([true, true, false])
  expect(byId('settledAt')).toEqual([hoursAgo(13 * 24), hoursAgo(3 * 24), ''])
})

test('settleAfterDays null settles nothing by itself, and a shared list that still carries archiveAfterDays reads as settleAfterDays 7, archives nothing by idle time, and loses the key at its next write', async () => {
  const old = { lastActivity: hoursAgo(30 * 24) }
  const off = await listedWith([old], { settleAfterDays: null })
  const migrated = await listedWith([old], { archiveAfterDays: 1 })

  await pin(migrated.capture.relay, idOf(1), true)
  const stored = JSON.parse(new TextDecoder().decode((await migrated.relay.read('shared.json')) ?? new Uint8Array())) as Record<string, unknown>

  expect([off.listed.settleAfterDays, off.byId('settled')]).toEqual([null, [false]])
  expect([migrated.listed.settleAfterDays, migrated.byId('archived'), migrated.byId('settled')]).toEqual([7, [false], [true]])
  expect(Object.keys(stored)).not.toContain('archiveAfterDays')
  expect(stored['settleAfterDays']).toBe(7)
})

test('a snoozed session wakes at its time, at a prompt after the snooze, and once it waits for the person, and a finished turn never wakes it', async () => {
  const until = hoursAgo(-24)
  const snoozedAt = hoursAgo(5)
  const { byId } = await listedWith(
    [
      { lastActivity: hoursAgo(1), lastPromptAt: hoursAgo(6) },
      { lastActivity: hoursAgo(1), lastPromptAt: hoursAgo(1) },
      { lastActivity: hoursAgo(6), lastPromptAt: hoursAgo(6) },
      { lastActivity: hoursAgo(6), lastPromptAt: hoursAgo(6) },
    ],
    { snoozed: { [idOf(1)]: { until, at: snoozedAt }, [idOf(2)]: { until, at: snoozedAt }, [idOf(3)]: { until, at: snoozedAt }, [idOf(4)]: { until: hoursAgo(1), at: snoozedAt } } },
    { [idOf(3)]: 'waiting' },
  )

  expect(byId('snoozedUntil')).toEqual([until, '', '', ''])
})

test('a pin clears a settle and a snooze, and a settle clears a pin and a snooze', async () => {
  const relay = await memoryRelay()
  const { capture } = captureOn(mac, relay)
  const session = idOf(1)
  const stateOf = (shared: Shared) => ({ pinned: shared.pinned[session] !== undefined, settled: shared.settled[session]?.settled, snoozed: shared.snoozed[session] !== undefined })

  await pin(capture.relay, session, true)
  const pinnedAndSnoozed = stateOf(await snooze(capture.relay, session, hoursAgo(-24)))
  const settled = stateOf(await settle(capture.relay, session, true))
  await snooze(capture.relay, session, hoursAgo(-24))
  const pinned = stateOf(await pin(capture.relay, session, true))

  expect(pinnedAndSnoozed).toEqual({ pinned: true, settled: false, snoozed: true })
  expect(settled).toEqual({ pinned: false, settled: true, snoozed: false })
  expect(pinned).toEqual({ pinned: true, settled: false, snoozed: false })
})

test('a session whose transcript an agent deleted lists as deleted, and one whose transcript is there does not', async () => {
  const relay = await memoryRelay()
  const { roots, capture } = captureOn(mac, relay)
  const transcript = join(roots.home, '.claude', 'projects', '-work', 'aaaaaaaa-0000-0000-0000-000000000001.jsonl')
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, '{"type":"user","message":{"role":"user","content":"Run the eval worker"},"cwd":"/work","sessionId":"aaaaaaaa-0000-0000-0000-000000000001"}\n')
  await uploadFiles(capture, 'aaaaaaaa-0000-0000-0000-000000000001', transcript)
  await writeIndex(capture)
  const before = (await listSessions(capture)).map(({ deleted }) => deleted)

  rmSync(transcript)
  await uploadFiles(capture, 'aaaaaaaa-0000-0000-0000-000000000001', transcript)
  await writeIndex(capture)

  expect([before, (await listSessions(capture)).map(({ deleted }) => deleted)]).toEqual([[false], [true]])
})

test('a restore of a deleted session brings its transcript back as it was before the deletion, so it lists as a session again', async () => {
  const relay = await memoryRelay()
  const session = 'aaaaaaaa-0000-0000-0000-000000000001'
  const { roots, capture } = captureOn(mac, relay)
  const transcript = join(roots.home, '.claude', 'projects', '-work', `${session}.jsonl`)
  const line = (home: string): string => `{"type":"user","message":{"role":"user","content":"Run the eval worker"},"cwd":"${home}/work","sessionId":"${session}"}\n`
  mkdirSync(dirname(transcript), { recursive: true })
  mkdirSync(join(roots.home, 'work'))
  writeFileSync(transcript, line(roots.home))
  await uploadFiles(capture, session, transcript)
  rmSync(transcript)
  await uploadFiles(capture, session, transcript)
  await writeIndex(capture)
  const restorer = captureOn(server, relay)

  await restore(restorer.capture, session, { take: true })

  expect(readFileSync(join(restorer.roots.home, '.claude', 'projects', '-work', `${session}.jsonl`), 'utf8')).toBe(line(restorer.roots.home))
  expect((await listSessions(restorer.capture)).find(({ id, device }) => id === session && device === server.id)?.deleted).toBe(false)
})

test('a session another machine resumed refuses resume without --take, and --take takes it back', async () => {
  const relay = await memoryRelay()
  const session = 'aaaaaaaa-0000-0000-0000-000000000001'
  const onMac = await captured(relay, mac, session, 'Plan the release', temporaryFolder())
  const onServer = captureOn(server, relay)
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
  const writer = captureOn(mac, relay)
  const transcript = join(writer.roots.claudeHome, 'projects', '-work', `${session}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  mkdirSync(dirname(jobOf(writer.roots)), { recursive: true })
  const cwd = join(writer.roots.home, 'work')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"cwd":"${cwd}","sessionId":"${session}"}\n`)
  writeFileSync(jobOf(writer.roots), `{"state":"done","cwd":"${cwd}"}`)
  await uploadFiles(writer.capture, session, transcript)
  const paths = async (): Promise<string[]> => [...(await downloadJournal(relay.connect(server, writer.roots), session, temporaryFolder(), ({ path }) => path)).files.keys()]
  expect(await paths()).toEqual([transcript])

  await uploadFiles(writer.capture, session, jobOf(writer.roots))
  rmSync(jobOf(writer.roots))
  await uploadFiles(writer.capture, session, jobOf(writer.roots))
  await writeIndex(writer.capture)
  const restorer = captureOn(server, relay)
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
  const writer = captureOn(mac, relay, home, undefined, { captureCode: async () => ({ header: new TextEncoder().encode(`header ${(captures += 1)}`), parts: [part] }), restoreCode: async () => '' }).capture
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Ship it"},"cwd":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`)
  await uploadFiles(writer, session, transcript)
  await writer.codeRuns.get(session)
  await uploadFiles(writer, session, `${cwd}/`)
  appendFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Again"},"cwd":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`)
  await uploadFiles(writer, session, transcript)
  await writer.codeRuns.get(session)
  await uploadFiles(writer, session, `${cwd}/`)
  await writeIndex(writer)

  const answered = join(home, 'work', 'answered')
  const given: unknown[] = []
  const restorer = captureOn(server, relay, home, undefined, {
    captureCode: async () => undefined,
    restoreCode: async (header, readPart, folder, isMove) => {
      given.push(new TextDecoder().decode(header), new TextDecoder().decode(await readPart(part.path)), folder, isMove)
      return answered
    },
  }).capture
  const { cwd: continued } = await restore(restorer, session, { take: false })

  expect(given).toEqual(['header 2', 'a bundle', cwd, false])
  expect(continued).toBe(answered)
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
  const writer = captureOn(mac, relay, home, undefined, { captureCode: async () => code, restoreCode: async () => '' }).capture
  const line = (text: string): string => `{"type":"user","message":{"role":"user","content":${JSON.stringify(text)}},"cwd":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`
  const uploaded = async (): Promise<void> => {
    await uploadFiles(writer, session, transcript)
    await writer.codeRuns.get(session)
    await uploadFiles(writer, session, `${cwd}/`)
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
    const { capture } = captureOn(device, relay, restoredHome, undefined, { captureCode: async () => undefined, restoreCode }, 0)
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
  const writer = captureOn(mac, relay, home, undefined, { captureCode: async () => ({ header: new TextEncoder().encode('header'), parts: [] }), restoreCode: async () => '' }).capture
  writeFileSync(transcript, `{"type":"permission-mode","permissionMode":"default","sessionId":"${session}"}\n`)
  await uploadFiles(writer, session, transcript)
  appendFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Ship it"},"cwd":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`)
  await uploadFiles(writer, session, transcript)
  await writer.codeRuns.get(session)
  await uploadFiles(writer, session, `${cwd}/`)

  expect((await listSessions(writer)).map(({ id, cwd: listed }) => ({ id, cwd: listed }))).toEqual([{ id: session, cwd }])
  const given: string[] = []
  const restorer = captureOn(server, relay, home, undefined, { captureCode: async () => undefined, restoreCode: async (_header, _readPart, folder) => (given.push(folder), folder) }).capture
  await restore(restorer, session, { take: true })
  expect(given).toEqual([cwd])
})

test("restore onto another home rewrites the writer's paths, and a /rewind backup of a plan as its plan, while a working folder backup keeps its bytes", async () => {
  const relay = await memoryRelay()
  const session = 'ffffffff-0000-4000-8000-000000000006'
  const first = join(temporaryFolder(), 'alice')
  const second = join(temporaryFolder(), 'bob')
  const encoded = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-')
  const a = captureOn(mac, relay, first)
  const b = captureOn(server, relay, second)
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
  await uploadFiles(a.capture, session, ...Object.values(there))
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
  await uploadFiles(writer, session, transcript)
  await writeIndex(writer)

  const b = captureOn(server, relay)
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
  const a = captureOn(mac, relay, home)
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
  const uploadA = (...paths: string[]): Promise<Set<string>[]> => uploadFiles(a.capture, session, ...paths)

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
  const b = captureOn(server, relay, home)
  const { cwd: continued } = await restore(b.capture, session, { take: false })

  expect(continued).toBe(cwd)
  for (const [path, bytes] of originals) expect(readFileSync(path).equals(bytes)).toBe(true)
  expect(readFileSync(history, 'utf8')).toBe(`{"display":"here before","project":"/work","sessionId":"${other}"}\n{"display":"Plan the trip","project":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`)
  const end = journalOf(b.capture.db, session)?.end ?? 0
  expect(end).toBeGreaterThan(0)

  appendFileSync(transcript, line('Continue on server'))
  await uploadFiles(b.capture, session, transcript)
  expect(await relay.read(`journals/${session}/hot/${String(end).padStart(16, '0')}.zst`)).toBeDefined()
  const replayed = await downloadJournal(b.capture.relay, session, temporaryFolder(), ({ path }) => path)
  expect(readFileSync(replayed.files.get(transcript)?.staged ?? '').equals(readFileSync(transcript))).toBe(true)
  expect(replayed.files.get(transcript)?.segments.map(({ device }) => device)).toEqual([mac.id, mac.id, mac.id, server.id])
})

test("a session comes back to a machine that kept a longer copy, although the history its last writer had holds a prompt the journal never got", async () => {
  const relay = await memoryRelay()
  const session = '88888888-0000-4000-8000-000000000008'
  const a = captureOn(mac, relay)
  const b = captureOn(server, relay)
  const at = (home: string) => ({ transcript: join(home, '.claude', 'projects', '-work', `${session}.jsonl`), history: join(home, '.claude', 'history.jsonl') })
  const prompt = (text: string): string => `{"display":"${text}","project":"/work","sessionId":"${session}"}\n`
  const there = at(a.roots.home)
  mkdirSync(dirname(there.transcript), { recursive: true })
  writeFileSync(there.transcript, `{"type":"user","message":{"role":"user","content":"Plan the release"},"cwd":${JSON.stringify(join(a.roots.home, 'work'))},"sessionId":"${session}"}\n`)
  writeFileSync(there.history, prompt('Plan the release'))
  await uploadFiles(a.capture, session, ...Object.values(there))
  await writeIndex(a.capture)
  const here = at(b.roots.home)
  mkdirSync(dirname(here.history), { recursive: true })
  writeFileSync(here.history, prompt('Refused on server'))
  await restore(b.capture, session, { take: true })
  appendFileSync(here.history, prompt('Ship it'))
  await uploadFiles(b.capture, session, here.history)
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
  const a = captureOn(mac, relay)
  const b = captureOn(server, relay)
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
  await uploadFiles(a.capture, session, ...Object.values(there))
  await writeIndex(a.capture)
  await restore(b.capture, session, { take: true })
  const here = at(b.roots.home)
  expect([existsSync(here.task), existsSync(here.plan)]).toEqual([true, true])
  rmSync(here.plan)
  rmSync(here.task)
  await uploadFiles(b.capture, session, here.plan, here.task)
  await writeIndex(b.capture)

  await restore(a.capture, session, { take: true })
  expect([existsSync(there.task), existsSync(there.plan), existsSync(there.transcript)]).toEqual([false, false, true])
  const c = captureOn({ id: 'device-c', name: 'laptop', os: 'linux', arch: 'arm64' }, relay)
  await restore(c.capture, session, { take: true })
  const third = at(c.roots.home)
  expect([existsSync(third.task), existsSync(third.plan), existsSync(third.transcript)]).toEqual([false, false, true])
})

test('resume puts a repository this machine lacks beside the checkouts it has, or in the checkouts folder the person chose', async () => {
  const relay = await memoryRelay()
  const session = '55555555-0000-4000-8000-000000000005'
  const home = join(temporaryFolder(), 'home')
  const writer = captureOn(mac, relay, home, undefined, { captureCode: async () => ({ header: new TextEncoder().encode('header'), parts: [] }), restoreCode: async () => '' }).capture
  const cwd = join(home, 'work', 'shop')
  const transcript = join(home, '.claude', 'projects', '-work-shop', `${session}.jsonl`)
  for (const folder of [cwd, dirname(transcript)]) mkdirSync(folder, { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Ship it"},"cwd":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`)
  await uploadFiles(writer, session, transcript)
  await writer.codeRuns.get(session)
  await uploadFiles(writer, session, `${cwd}/`)
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
    const restorer = captureOn(server, relay, folder, undefined, { captureCode: async () => undefined, restoreCode }).capture
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
      await recordSummary(capture, crypto.randomUUID(), 'claude', [`{"type":"user","cwd":${JSON.stringify(repo)}}\n`], 1, new Date().toISOString())
    }
  }
  const ranInElsewhere = async (folder: string, capture: Capture): Promise<void> => {
    for (const [name, id] of [['code/shop', crypto.randomUUID()], ['elsewhere/shop', session]] as const) {
      const repo = join(folder, name)
      mkdirSync(repo, { recursive: true })
      Bun.spawnSync(['git', 'init', '-q', repo])
      Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', 'git@github.com:alice/shop.git'])
      await recordSummary(capture, id, 'claude', [`{"type":"user","cwd":${JSON.stringify(repo)}}\n`], 1, new Date().toISOString())
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
}, 30_000)

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
  const a = captureOn(mac, relay, join(temporaryFolder(), 'alice'), undefined, code)
  const b = captureOn(server, relay, join(temporaryFolder(), 'bob'), undefined, code)
  const transcriptIn = (roots: MachineRoots, cwd: string): string => join(roots.claudeHome, 'projects', encoded(cwd), `${session}.jsonl`)
  const say = async (on: ReturnType<typeof captureOn>, cwd: string, text: string): Promise<void> => {
    const transcript = transcriptIn(on.roots, cwd)
    mkdirSync(dirname(transcript), { recursive: true })
    appendFileSync(transcript, `{"type":"user","message":{"role":"user","content":"${text}"},"cwd":${JSON.stringify(cwd)},"sessionId":"${session}"}\n`)
    await uploadFiles(on.capture, session, transcript)
    await on.capture.codeRuns.get(session)
    await uploadFiles(on.capture, session, `${cwd}/`)
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
  const old = captureOn(mac, relay, undefined, state)
  const line = (text: string): string => `{"type":"user","message":{"role":"user","content":"${text}"},"cwd":${JSON.stringify(join(old.roots.home, 'work'))},"sessionId":"${session}"}\n`
  const transcript = join(old.roots.home, '.claude', 'projects', '-work', `${session}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, line('Plan the release'))
  await uploadFiles(old.capture, session, transcript)
  await writeIndex(old.capture)
  if (isOffline) old.capture.relay.close()
  const taker = captureOn(server, relay)
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
  expect(await uploadFiles(old.capture, session, transcript)).toEqual([new Set()])
  expect(performance.now() - asked).toBeLessThan(100)
  expect(journalOf(old.capture.db, session)?.stopped).toContain('server took the session')
})

test('a restore over a turn only this machine holds, as one a sleeping machine took after another took the session, keeps that turn as a conflicted copy, once', async () => {
  const { relay, session, old, state, transcript } = await takenOver(true)
  appendFileSync(transcript, `{"type":"assistant","uuid":"only-on-mac","message":{"role":"assistant","content":"Kept going here"},"sessionId":"${session}"}\n`)
  const back = captureOn(mac, relay, old.roots.home, state)
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

  const back = captureOn(mac, relay, old.roots.home, state)
  await until(() => back.capture.relay.state.is === 'connected')
  expect(journalOf(back.capture.db, session)).toMatchObject({ holder: 'server', stopped: expect.stringContaining('server took the session') })
})

test('a session T3 Code settled reads settled and not archived on every machine, one it archived reads archived, and one unsettled after that settle stays unsettled', async () => {
  const relay = await memoryRelay()
  const settledThere = 'aaaaaaaa-0000-0000-0000-00000000000a'
  const open = 'aaaaaaaa-0000-0000-0000-00000000000b'
  const archivedThere = 'aaaaaaaa-0000-0000-0000-00000000000c'
  const { roots, capture } = captureOn(mac, relay)
  await uploadFiles(capture, settledThere, transcriptOf(roots, settledThere, 'Plan the trip'))
  await uploadFiles(capture, open, transcriptOf(roots, open, 'Book the train'))
  await uploadFiles(capture, archivedThere, transcriptOf(roots, archivedThere, 'Pack the bags'))
  await writeIndex(capture)
  const t3 = join(temporaryFolder(), 'statev2.sqlite')
  const state = new Database(t3)
  state.run('create table orchestration_v2_projection_threads (thread_id text primary key, archived_at text, deleted_at text, updated_at text not null, payload_json text not null)')
  state.run('create table orchestration_v2_projection_provider_threads (provider_thread_id text primary key, thread_id text, payload_json text not null)')
  const thread = (id: string, session: string, settledOverride: string | null, archivedAt: string | null = null): void => {
    state.query('insert into orchestration_v2_projection_threads values (?, ?, null, ?, ?)').run(id, archivedAt, '2026-11-10T08:00:00.000Z', JSON.stringify({ settledOverride, settledAt: settledOverride === null ? null : '2026-11-10T08:00:00.000Z' }))
    state.query('insert into orchestration_v2_projection_provider_threads values (?, ?, ?)').run(`provider-${id}`, id, JSON.stringify({ nativeThreadRef: { nativeId: session } }))
  }
  thread('thread-settled', settledThere, 'settled')
  thread('thread-open', open, null)
  thread('thread-archived', archivedThere, null, '2026-11-10T08:00:00.000Z')
  const marksOf = async (): Promise<Record<string, { readonly settled: boolean; readonly archived: boolean }>> => Object.fromEntries((await agentsOf(capture)).agents.map(({ id, settled, archived }) => [id, { settled, archived }]))

  await copyT3Marks(capture.relay, capture.db, t3)
  const synced = await marksOf()
  await settle(capture.relay, settledThere, false)
  state.run("update orchestration_v2_projection_threads set updated_at = '2026-11-10T09:00:00.000Z' where thread_id = 'thread-open'")
  state.close()
  await copyT3Marks(capture.relay, capture.db, t3)

  expect(synced).toEqual({ [settledThere]: { settled: true, archived: false }, [open]: { settled: false, archived: false }, [archivedThere]: { settled: false, archived: true } })
  expect((await marksOf())[settledThere]).toEqual({ settled: false, archived: false })
})

test("T3 Code's database in WAL mode reads while T3 Code is closed and left no -shm file, which SQLite refuses to open read-only", async () => {
  const relay = await memoryRelay()
  const settledThere = 'aaaaaaaa-0000-0000-0000-00000000000d'
  const { roots, capture } = captureOn(mac, relay)
  await uploadFiles(capture, settledThere, transcriptOf(roots, settledThere, 'Plan the trip'))
  await writeIndex(capture)
  const t3 = join(temporaryFolder(), 'statev2.sqlite')
  const state = new Database(t3)
  state.run('pragma journal_mode = wal')
  state.run('create table orchestration_v2_projection_threads (thread_id text primary key, archived_at text, deleted_at text, updated_at text not null, payload_json text not null)')
  state.run('create table orchestration_v2_projection_provider_threads (provider_thread_id text primary key, thread_id text, payload_json text not null)')
  state.query('insert into orchestration_v2_projection_threads values (?, null, null, ?, ?)').run('thread-settled', '2026-11-10T08:00:00.000Z', JSON.stringify({ settledOverride: 'settled', settledAt: '2026-11-10T08:00:00.000Z' }))
  state.query('insert into orchestration_v2_projection_provider_threads values (?, ?, ?)').run('provider-thread-settled', 'thread-settled', JSON.stringify({ nativeThreadRef: { nativeId: settledThere } }))
  state.close()
  rmSync(`${t3}-shm`, { force: true })
  rmSync(`${t3}-wal`, { force: true })

  await copyT3Marks(capture.relay, capture.db, t3)

  expect(existsSync(`${t3}-shm`)).toBe(false)
  expect((await agentsOf(capture)).agents.find(({ id }) => id === settledThere)?.settled).toBe(true)
})
