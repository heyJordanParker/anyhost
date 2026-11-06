import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MAX_MESSAGE_BYTES, cloneFixFor } from '../../relay/protocol.ts'
import { hotKey, journalOf, openCapture, openDatabase, uploadSession, type Problems } from '../src/capture.ts'
import { devicesOf, inviteMachine, machinesOf, removeMachine, type Device, type MachineRoots } from '../src/device.ts'
import { connectRelay, type Relay } from '../src/relay.ts'
import { listSessions } from '../src/sessions.ts'
import { memoryRelay, noCode, stopRelays, temporaryFolder, welcomed } from './memory.ts'

afterEach(stopRelays)

const SESSION = '11111111-2222-3333-4444-555555555555'
const device: Device = { id: 'device-a', name: 'anyhost-a', os: 'linux', arch: 'arm64' }
const roots = (home: string): MachineRoots => ({ home, claudeHome: join(home, '.claude'), claudeTmp: join(home, 'tmp'), codexHome: join(home, '.codex') })
const failTest: Problems = {
  set: (_key, error) => {
    throw error
  },
  clear: () => undefined,
}
const opened: Relay[] = []
afterEach(() => {
  for (const relay of opened.splice(0)) relay.close()
})
const connect = (...options: Parameters<typeof connectRelay>): Relay => {
  const relay = connectRelay(...options)
  opened.push(relay)
  return relay
}
async function until(isTrue: () => boolean): Promise<void> {
  for (const started = Date.now(); !isTrue(); await Bun.sleep(2)) if (Date.now() - started > 5000) throw new Error('It did not happen within 5 s.')
}

test('a request whose answer the dropped socket lost goes again on the next socket, and its frame is stored once', async () => {
  const relay = memoryRelay()
  const home = join(temporaryFolder(), 'home')
  const capture = openCapture(relay.connect(device, roots(home)), device, roots(home), openDatabase(join(temporaryFolder(), 'state')), noCode)
  const transcript = join(home, '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
  relay.dropAnswers = 1

  await uploadSession(capture, SESSION, 'claude', new Set([transcript]), failTest)
  const frame = hotKey(SESSION, 0)
  expect(relay.requests.filter((ops) => ops.some((op) => op.op === 'put' && op.key === frame))).toHaveLength(2)
  expect(relay.puts.filter(({ key }) => key === frame)).toHaveLength(1)
  expect(journalOf(capture.db, SESSION)?.end).toBeGreaterThan(0)
})

test('a machine with the id of a connected machine and another name, as a clone has, is refused with the fix', async () => {
  const relay = memoryRelay()
  const token = relay.join(device, roots('/home/ada'))
  await welcomed(connect({ login: async () => ({ url: relay.url, token }), device, roots: roots('/home/ada'), isPatient: true }))

  const clone = connect({ login: async () => ({ url: relay.url, token }), device: { ...device, name: 'anyhost-c' }, roots: roots('/home/ada'), isPatient: true })
  await until(() => clone.state.is === 'refused')
  expect(clone.state).toEqual({ is: 'refused', message: `The relay refused anyhost-c: anyhost-a is connected with this machine's id. A machine cloned from another keeps its id, so anyhost captures nothing here. ${cloneFixFor('linux')}` })
})

test('a removed machine is refused, and a command of it fails with the reason', async () => {
  const relay = memoryRelay()
  const token = relay.join(device, roots('/home/ada'))
  const service = connect({ login: async () => ({ url: relay.url, token }), device, roots: roots('/home/ada'), isPatient: true })
  await welcomed(service)
  relay.remove(device.id)

  await until(() => service.state.is === 'removed')
  const message = 'This machine was removed from your machines. Join it again with a link from Add a machine.'
  expect(service.state).toEqual({ is: 'removed', message })
  const command = connect({ login: async () => ({ url: relay.url, token }), device, roots: roots('/home/ada'), isPatient: false })
  await expect(Promise.all(command.run([{ op: 'claims' }]))).rejects.toThrow(message)
})

test('a machine that never joined waits for a join in the service, and connects at once when one comes', async () => {
  const relay = memoryRelay()
  let login: { url: string; token: string } | undefined
  const service = connect({ login: async () => login, device, roots: roots('/home/ada'), isPatient: true })
  await until(() => service.state.is === 'unjoined')
  let isSettled = false
  const claims = Promise.all(service.run([{ op: 'claims' }])).finally(() => (isSettled = true))
  await Bun.sleep(50)
  expect(isSettled).toBe(false)

  login = { url: relay.url, token: relay.join(device, roots('/home/ada')) }
  service.reconnect()
  // the next try waits a second after the first failure, and the join connects well before it
  await until(() => service.state.is === 'connected')
  expect(await claims).toEqual([{ status: 200, claims: {} }])

  const command = connect({ login: async () => undefined, device, roots: roots('/home/ada'), isPatient: false })
  await expect(Promise.all(command.run([{ op: 'claims' }]))).rejects.toThrow('This machine is not joined to your relay')
})

test('each connect brings this machine\'s roots, which the relay lists from then on', async () => {
  const relay = memoryRelay()
  const token = relay.join(device, roots('/home/ada'))
  const moved = { ...roots('/home/ada'), claudeHome: '/srv/claude-config' }
  const service = connect({ login: async () => ({ url: relay.url, token }), device, roots: moved, isPatient: true })
  await welcomed(service)

  expect((await devicesOf(service)).get(device.id)?.roots).toEqual(moved)
})

test('a removed machine leaves the machines list and stays in devicesOf, so its sessions stay listed', async () => {
  const relay = memoryRelay()
  const other: Device = { id: 'device-b', name: 'anyhost-b', os: 'linux', arch: 'arm64' }
  const here = relay.connect(device, roots('/home/ada'))
  const gone = relay.connect(other, roots('/home/bob'))
  await Promise.all([welcomed(here), welcomed(gone)])
  relay.put(`sessions/${other.id}/index.json`, new TextEncoder().encode(JSON.stringify([{ id: SESSION, tool: 'claude', cwd: '/home/bob/work', lastActivity: '2026-11-06T00:00:00.000Z' }])))

  await removeMachine(here, other.id)
  await until(() => gone.state.is === 'removed')
  expect((await machinesOf(here)).map(({ name }) => name)).toEqual(['anyhost-a'])
  expect((await devicesOf(here)).get(other.id)).toMatchObject({ name: 'anyhost-b', roots: roots('/home/bob') })
  expect((await devicesOf(here)).get(other.id)?.removedAt).toBeString()
  expect((await listSessions(here)).map(({ id, machine }) => [id, machine])).toEqual([[SESSION, 'anyhost-b']])
  await expect(removeMachine(here, other.id)).rejects.toThrow(`No machine with the id ${other.id} is joined.`)
})

test('an invite is the command that installs anyhost with the invite in the option join, quoted for any shell', async () => {
  const relay = memoryRelay()
  const here = relay.connect(device, roots('/home/ada'))
  const { command, expiresAt } = await inviteMachine(here)
  expect(command).toMatch(new RegExp(`^cmod install heyJordanParker/anyhost --option 'join=${relay.url}/v1/join#[0-9a-f-]+'$`))
  expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000)
})

test('a command fails with the relay it could not reach, instead of waiting for it', async () => {
  const command = connect({ login: async () => ({ url: 'http://127.0.0.1:9', token: 'token' }), device, roots: roots('/home/ada'), isPatient: false })
  await expect(Promise.all(command.run([{ op: 'claims' }]))).rejects.toThrow('The relay at http://127.0.0.1:9 closed the connection')
})

test('an object over 1 MiB goes by HTTP, and a broken download goes on from the byte it reached', async () => {
  const relay = memoryRelay()
  const client = relay.connect(device, roots('/home/ada'))
  const bytes = crypto.getRandomValues(new Uint8Array(3 * MAX_MESSAGE_BYTES))
  const [put] = client.run([{ op: 'put', key: 'files/big.bin', bytes, if: { none: '*' } }])
  expect(await put).toMatchObject({ status: 200 })
  expect(relay.requests.flat()).toEqual([])
  relay.cutDownloads = 1

  const got = await client.getObject('files/big.bin')
  expect(Buffer.from(got?.bytes ?? new Uint8Array()).equals(Buffer.from(bytes))).toBe(true)
  expect(relay.ranges[0]).toBeNull()
  expect(relay.ranges[1]).toMatch(/^bytes=\d+-$/)
  expect(Number(relay.ranges[1]?.slice('bytes='.length, -1))).toBeGreaterThan(0)
})
