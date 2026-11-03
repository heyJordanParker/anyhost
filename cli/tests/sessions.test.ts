import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase, uploadFile, writeIndex, type Capture } from '../src/capture.ts'
import { HeldElsewhere, takeClaim } from '../src/claims.ts'
import { register, type Device } from '../src/device.ts'
import { resume } from '../src/resume.ts'
import { listSessions } from '../src/sessions.ts'
import type { Store } from '../src/store.ts'
import { memoryStore, temporaryFolder } from './memory.ts'

const mac: Device = { id: 'device-mac', name: 'mac', os: 'darwin', arch: 'arm64' }
const devbox: Device = { id: 'device-devbox', name: 'devbox', os: 'linux', arch: 'x64' }

async function capture(store: Store, device: Device, session: string, prompt: string): Promise<void> {
  const folder = temporaryFolder()
  const projects = join(folder, 'projects')
  mkdirSync(join(projects, '-work'), { recursive: true })
  writeFileSync(join(projects, '-work', `${session}.jsonl`), `{"type":"user","message":{"role":"user","content":${JSON.stringify(prompt)}},"cwd":"/work","sessionId":"${session}"}\n`)
  const captured: Capture = { store, db: openDatabase(join(folder, 'state')), device }
  await register(store, device)
  await uploadFile(captured, { tool: 'claude', folder: projects }, join(projects, '-work', `${session}.jsonl`))
  await writeIndex(captured)
}

test('the index lists sessions of two devices', async () => {
  const store = memoryStore()
  await capture(store, mac, 'aaaaaaaa-0000-0000-0000-000000000001', 'Plan the release')
  await capture(store, devbox, 'bbbbbbbb-0000-0000-0000-000000000002', 'Fix the deploy')
  await takeClaim(store, 'aaaaaaaa-0000-0000-0000-000000000001', devbox.id, { take: false })

  const listed = (await listSessions(store)).map(({ id, tool, machine, holder, firstPrompt, cwd }) => ({ id, tool, machine, holder, firstPrompt, cwd }))
  expect(listed.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
    { id: 'aaaaaaaa-0000-0000-0000-000000000001', tool: 'claude', machine: 'mac', holder: 'devbox', firstPrompt: 'Plan the release', cwd: '/work' },
    { id: 'bbbbbbbb-0000-0000-0000-000000000002', tool: 'claude', machine: 'devbox', holder: '', firstPrompt: 'Fix the deploy', cwd: '/work' },
  ])
})

test("a claimed session lists the holder's entry, even when the old holder wrote later", async () => {
  const store = memoryStore()
  const session = 'aaaaaaaa-0000-0000-0000-000000000001'
  const entry = { id: session, tool: 'claude', title: '', firstPrompt: 'Plan the release', cwd: '/work', repo: '', repoFolder: '', size: 10 }
  await register(store, mac)
  await register(store, devbox)
  await store.put(`sessions/${mac.id}/index.json`, JSON.stringify([{ ...entry, lastActivity: '2026-11-03T12:45:00.000Z' }]))
  await store.put(`sessions/${devbox.id}/index.json`, JSON.stringify([{ ...entry, cwd: '/home/devbox/work', lastActivity: '2026-11-03T12:44:00.000Z' }]))
  await takeClaim(store, session, devbox.id, { take: false })

  expect((await listSessions(store)).map(({ machine, holder, cwd }) => ({ machine, holder, cwd }))).toEqual([{ machine: 'devbox', holder: 'devbox', cwd: '/home/devbox/work' }])
})

test('a claim held by another device refuses resume without --take', async () => {
  const store = memoryStore()
  const session = 'aaaaaaaa-0000-0000-0000-000000000001'
  await capture(store, mac, session, 'Plan the release')
  await register(store, devbox)
  await takeClaim(store, session, mac.id, { take: false })

  await expect(resume(store, devbox, session, { take: false })).rejects.toThrow(`This session continues on mac. Run anyhost resume ${session} --take to continue it here.`)
  await expect(takeClaim(store, session, devbox.id, { take: false })).rejects.toBeInstanceOf(HeldElsewhere)
  await takeClaim(store, session, devbox.id, { take: true })
  expect(JSON.parse(new TextDecoder().decode(store.objects.get(`claims/${session}.json`)?.body)).device).toBe(devbox.id)
})
