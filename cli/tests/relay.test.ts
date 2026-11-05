import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MAX_MESSAGE_BYTES, cloneFixFor } from '../../relay/protocol.ts'
import { hotKey, journalOf, openCapture, openDatabase, uploadSession, type Problems } from '../src/capture.ts'
import type { Device, MachineRoots } from '../src/device.ts'
import { connectRelay, type Relay } from '../src/relay.ts'
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
  await welcomed(connect({ login: async () => ({ url: relay.url, token }), device, isPatient: true }))

  const clone = connect({ login: async () => ({ url: relay.url, token }), device: { ...device, name: 'anyhost-c' }, isPatient: true })
  await until(() => clone.state.is === 'refused')
  expect(clone.state).toEqual({ is: 'refused', message: `The relay refused anyhost-c: anyhost-a is connected with this machine's id. A machine cloned from another keeps its id, so anyhost captures nothing here. ${cloneFixFor('linux')}` })
})

test('a removed machine is refused, and a command of it fails with the reason', async () => {
  const relay = memoryRelay()
  const token = relay.join(device, roots('/home/ada'))
  const service = connect({ login: async () => ({ url: relay.url, token }), device, isPatient: true })
  await welcomed(service)
  relay.remove(device.id)

  await until(() => service.state.is === 'refused')
  const message = 'This machine was removed from your machines. Join it again with a link from Add a machine.'
  expect(service.state).toEqual({ is: 'refused', message })
  const command = connect({ login: async () => ({ url: relay.url, token }), device, isPatient: false })
  await expect(Promise.all(command.run([{ op: 'claims' }]))).rejects.toThrow(message)
})

test('a machine that never joined waits for a join in the service, and a command fails at once saying so', async () => {
  const service = connect({ login: async () => undefined, device, isPatient: true })
  await until(() => service.state.is === 'unjoined')
  let isSettled = false
  void Promise.all(service.run([{ op: 'claims' }]))
    .catch(() => undefined)
    .finally(() => (isSettled = true))
  await Bun.sleep(50)
  expect(isSettled).toBe(false)

  const command = connect({ login: async () => undefined, device, isPatient: false })
  await expect(Promise.all(command.run([{ op: 'claims' }]))).rejects.toThrow('This machine is not joined to your relay')
})

test('a command fails with the relay it could not reach, instead of waiting for it', async () => {
  const command = connect({ login: async () => ({ url: 'http://127.0.0.1:9', token: 'token' }), device, isPatient: false })
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
