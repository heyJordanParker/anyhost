import { expect, onTestFinished, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MAX_MESSAGE_BYTES, cloneFixFor } from '../../relay/protocol.ts'
import { hotKey, journalOf, openCapture, openDatabase, QUIET_MS, sealQuiet, uploadSessions } from '../src/capture.ts'
import { devicesOf, inviteMachine, machinesOf, removeMachine, type Device } from '../src/device.ts'
import { connectRelay, type Relay, type RelayOptions } from '../src/relay.ts'
import { listSessions } from '../src/sessions.ts'
import { failTest, memoryRelay, noCode, temporaryFolder, until, welcomed } from './memory.ts'
import { DAILY_LIMIT, roots, SESSION } from './program.ts'

const device: Device = { id: 'device-a', name: 'anyhost-a', os: 'linux', arch: 'arm64' }
const connect = (options: Omit<RelayOptions, 'forget'>): Relay => {
  const relay = connectRelay({ ...options, forget: async () => undefined })
  onTestFinished(() => relay.close())
  return relay
}

test('a request whose answer the dropped socket lost goes again on the next socket, and its frame is stored once', async () => {
  const relay = await memoryRelay()
  const home = join(temporaryFolder(), 'home')
  const capture = openCapture(relay.connect(device, roots(home)), device, roots(home), { db: openDatabase(join(temporaryFolder(), 'state')), code: noCode })
  const transcript = join(home, '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
  relay.dropAnswers = 1

  await Promise.all(uploadSessions(capture, [{ session: SESSION, tool: 'claude', paths: new Set([transcript]) }], failTest).map(([, left]) => left))
  const frame = hotKey(SESSION, 0)
  expect(relay.requests.filter((ops) => ops.some((op) => op.op === 'put' && op.key === frame))).toHaveLength(2)
  expect(relay.puts.filter(({ key }) => key === frame)).toHaveLength(1)
  expect(journalOf(capture.db, SESSION)?.end).toBeGreaterThan(0)
})

test('a machine with the id of a connected machine and another name, as a clone has, is refused with the fix', async () => {
  const relay = await memoryRelay()
  const token = await relay.join(device, roots('/home/ada'))
  await welcomed(connect({ login: async () => ({ url: relay.url, token }), device, roots: roots('/home/ada'), isPatient: true }))

  const clone = connect({ login: async () => ({ url: relay.url, token }), device: { ...device, name: 'anyhost-c' }, roots: roots('/home/ada'), isPatient: true })
  await until(() => clone.state.is === 'refused', 'the refusal')
  expect(clone.state).toEqual({ is: 'refused', message: `The relay refused anyhost-c: anyhost-a is connected with this machine's id. A machine cloned from another keeps its id, so anyhost captures nothing here. ${cloneFixFor('linux')}` })
})

test('a removed machine is refused, and a command of it fails with the reason', async () => {
  const relay = await memoryRelay()
  const token = await relay.join(device, roots('/home/ada'))
  const service = connect({ login: async () => ({ url: relay.url, token }), device, roots: roots('/home/ada'), isPatient: true })
  await welcomed(service)
  relay.remove(device.id)

  await until(() => service.state.is === 'unjoined', 'the removal')
  const message = 'This machine was removed from your machines. Join it again with a link from Add a machine.'
  expect(service.state).toEqual({ is: 'unjoined', message })
  const command = connect({ login: async () => ({ url: relay.url, token }), device, roots: roots('/home/ada'), isPatient: false })
  await expect(Promise.all(command.run([{ op: 'claims' }]))).rejects.toThrow(message)
})

test('a machine that never joined waits for a join in the service, and connects at once when one comes', async () => {
  const relay = await memoryRelay()
  let login: { url: string; token: string } | undefined
  const service = connect({ login: async () => login, device, roots: roots('/home/ada'), isPatient: true })
  await until(() => service.state.is === 'unjoined', 'the service finding no login')
  let isSettled = false
  const claims = Promise.all(service.run([{ op: 'claims' }])).finally(() => (isSettled = true))
  await Bun.sleep(50)
  expect(isSettled).toBe(false)

  login = { url: relay.url, token: await relay.join(device, roots('/home/ada')) }
  service.reconnect()
  await until(() => service.state.is === 'connected', 'the join connecting')
  expect(await claims).toEqual([{ status: 200, claims: {} }])

  const command = connect({ login: async () => undefined, device, roots: roots('/home/ada'), isPatient: false })
  await expect(Promise.all(command.run([{ op: 'claims' }]))).rejects.toThrow('This machine is not joined to your relay')
})

test('each connect brings this machine\'s roots, which the relay lists from then on', async () => {
  const relay = await memoryRelay()
  const token = await relay.join(device, roots('/home/ada'))
  const moved = { ...roots('/home/ada'), claudeHome: '/srv/claude-config' }
  const service = connect({ login: async () => ({ url: relay.url, token }), device, roots: moved, isPatient: true })
  await welcomed(service)

  expect((await devicesOf(service)).get(device.id)?.roots).toEqual(moved)
})

test('a removed machine leaves the machines list and stays in devicesOf, so its sessions stay listed', async () => {
  const relay = await memoryRelay()
  const other: Device = { id: 'device-b', name: 'anyhost-b', os: 'linux', arch: 'arm64' }
  const here = relay.connect(device, roots('/home/ada'))
  const gone = relay.connect(other, roots('/home/bob'))
  await Promise.all([welcomed(here), welcomed(gone)])
  await relay.objects.put(`sessions/${other.id}/index.json`, new TextEncoder().encode(JSON.stringify([{ id: SESSION, tool: 'claude', cwd: '/home/bob/work', lastActivity: '2026-11-06T00:00:00.000Z' }])))

  await removeMachine(here, other.id)
  await until(() => gone.state.is === 'unjoined', 'the removed machine hearing it', 20_000)
  expect((await machinesOf(here)).map(({ name }) => name)).toEqual(['anyhost-a'])
  expect((await devicesOf(here)).get(other.id)).toMatchObject({ name: 'anyhost-b', roots: roots('/home/bob') })
  expect((await devicesOf(here)).get(other.id)?.removedAt).toBeString()
  expect((await listSessions(here)).map(({ id, machine }) => [id, machine])).toEqual([[SESSION, 'anyhost-b']])
  await removeMachine(here, other.id)
  await expect(removeMachine(here, 'device-never-joined')).rejects.toThrow('No machine with the id device-never-joined is joined.')
}, 30_000)

test('an invite is the command that installs anyhost with the invite in the option join, quoted for any shell', async () => {
  const relay = await memoryRelay()
  const here = relay.connect(device, roots('/home/ada'))
  const { command, expiresAt } = await inviteMachine(here)
  expect(command).toMatch(new RegExp(`^cmod install heyJordanParker/anyhost --option 'join=${relay.url}/v1/join#[0-9A-HJKMNP-TV-Z]{26}'$`))
  expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000)
})

test('a command fails with the relay it could not reach, instead of waiting for it', async () => {
  const command = connect({ login: async () => ({ url: 'http://127.0.0.1:9', token: 'token' }), device, roots: roots('/home/ada'), isPatient: false })
  await expect(Promise.all(command.run([{ op: 'claims' }]))).rejects.toThrow('The relay at http://127.0.0.1:9 closed the connection')
})

test('an object over 1 MiB goes by HTTP, and a broken download goes on from the byte it reached', async () => {
  const relay = await memoryRelay()
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

const md5 = (bytes: Uint8Array): string => new Bun.CryptoHasher('md5').update(bytes).digest('hex')

test('a machine that joins again while connected puts an object over 1 MiB with its new token', async () => {
  const relay = await memoryRelay()
  let login = { url: relay.url, token: await relay.join(device, roots('/home/ada')) }
  const service = connect({ login: async () => login, device, roots: roots('/home/ada'), isPatient: true })
  await welcomed(service)
  login ={ url: relay.url, token: await relay.join(device, roots('/home/ada')) }
  service.reconnect()

  const bytes = crypto.getRandomValues(new Uint8Array(2 * MAX_MESSAGE_BYTES))
  expect(await service.runOne({ op: 'put', key: 'files/big.bin', bytes })).toEqual({ status: 200, etag: md5(bytes) })
})

test('a request the relay leaves unanswered goes again on a new socket 40 seconds later though messages still arrive on the old one, so the seal that ends a backup pass ends', async () => {
  const relay = await memoryRelay()
  const home = join(temporaryFolder(), 'home')
  const capture = openCapture(relay.connect(device, roots(home)), device, roots(home), { db: openDatabase(join(temporaryFolder(), 'state')), code: noCode })
  const there = relay.connect({ id: 'device-b', name: 'anyhost-b', os: 'linux', arch: 'arm64' }, roots('/home/bob'))
  await welcomed(there)
  const transcript = join(home, '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
  await Promise.all(uploadSessions(capture, [{ session: SESSION, tool: 'claude', paths: new Set([transcript]) }], failTest).map(([, left]) => left))
  const heard: string[] = []
  capture.relay.on('moved', ({ id }) => void heard.push(id))
  const sending = setInterval(() => there.send({ t: 'moved', id: `move-${heard.length}`, to: device.id }), 5000)
  try {
    const asked = relay.requests.length
    relay.unanswered = 1
    const quiet = (journalOf(capture.db, SESSION)?.writtenAt ?? 0) + QUIET_MS + 60_000

    const started = Date.now()
    expect(await sealQuiet(capture, failTest, quiet)).toEqual(new Map())
    expect(Date.now() - started).toBeGreaterThanOrEqual(40_000)
    expect(heard.length).toBeGreaterThanOrEqual(7)
    expect(relay.requests.slice(asked, asked + 2)).toEqual([
      [{ op: 'claim', session: SESSION, take: false }],
      [{ op: 'claim', session: SESSION, take: false }],
    ])
    expect(journalOf(capture.db, SESSION)?.sealed).toBe(journalOf(capture.db, SESSION)?.end ?? -1)
  } finally {
    clearInterval(sending)
  }
}, 90_000)

test('a relay login that fails to read is a problem of its own with the reason, and the next try connects', async () => {
  const relay = await memoryRelay()
  const token = await relay.join(device, roots('/home/ada'))
  let reads = 0
  const login = async (): Promise<{ url: string; token: string }> => {
    reads += 1
    if (reads === 1) throw new Error('cmod secret get anyhost token exited with 1.')
    return { url: relay.url, token }
  }
  const service = connect({ login, device, roots: roots('/home/ada'), isPatient: true })

  await until(() => service.state.is !== 'connecting', 'the failed read')
  expect(service.state).toEqual({ is: 'offline', message: "anyhost could not read this machine's relay login: cmod secret get anyhost token exited with 1." })
  await welcomed(service)
  expect(reads).toBe(2)
})

test("an object request Cloudflare refuses for the daily limit goes again, and a connect it refuses names the limit and its reset", async () => {
  const relay = await memoryRelay()
  const client = relay.connect(device, roots('/home/ada'))
  await welcomed(client)
  relay.dailyLimited = 1
  const bytes = crypto.getRandomValues(new Uint8Array(2 * MAX_MESSAGE_BYTES))
  expect(await client.runOne({ op: 'put', key: 'files/big.bin', bytes })).toEqual({ status: 200, etag: md5(bytes) })

  relay.dailyLimited = Infinity
  client.reconnect()
  await until(() => client.state.is === 'offline', 'the refused connect')
  expect(client.state).toEqual({ is: 'offline', message: DAILY_LIMIT })
})
