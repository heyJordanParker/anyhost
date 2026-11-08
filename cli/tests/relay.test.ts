import { afterEach, expect, jest, setDefaultTimeout, setSystemTime, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { createDecipheriv, hkdfSync } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { connect as dialTcp, createServer, type Socket } from 'node:net'
import type { NetworkInterfaceInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { LIVE_MS, MAX_MESSAGE_BYTES, PING_MS, cloneFixFor, encodeStream, streamOf } from '../../relay/protocol.ts'
import { isAlive } from '../src/background.ts'
import { decompress, hotKey, journalOf, openCapture, openDatabase, QUIET_MS, sealQuiet, uploadSessions } from '../src/capture.ts'
import { devicesOf, inviteMachine, machinesOf, removeMachine, type Device, type MachineRoots } from '../src/device.ts'
import { cipherOf, dialDirect, listenDirect, offeredAddresses, type DirectLink, type DirectListener, type DirectOffer } from '../src/direct.ts'
import { connectRelay, type Relay, type RelayOptions } from '../src/relay.ts'
import type { Status } from '../src/serve.ts'
import { listSessions } from '../src/sessions.ts'
import { offsetOf, openStream, type Link, type Stream } from '../src/stream.ts'
import { failTest, memoryRelay, noCode, statusOn, stopRelays, temporaryFolder, until, welcomed, type MemoryRelay } from './memory.ts'

afterEach(stopRelays)
// A test that runs `anyhost serve` against the relay in workerd took 5.0 s alone on the Mac at a load average of 133,
// and 8.3 s on anyhost-a, past Bun's 5 s.
setDefaultTimeout(30_000)

const SESSION = '11111111-2222-3333-4444-555555555555'
const device: Device = { id: 'device-a', name: 'anyhost-a', os: 'linux', arch: 'arm64' }
const roots = (home: string): MachineRoots => ({ home, claudeHome: join(home, '.claude'), claudeTmp: join(home, 'tmp'), codexHome: join(home, '.codex') })
const opened: Relay[] = []
afterEach(() => {
  for (const relay of opened.splice(0)) relay.close()
})
// a relay whose login nothing keeps, so a login the relay refused has nothing to forget
const connect = (options: Omit<RelayOptions, 'forget'>): Relay => {
  const relay = connectRelay({ ...options, forget: async () => undefined })
  opened.push(relay)
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
  // the next try waits a second after the first failure, and the join connects well before it
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
  // workerd ends a socket the Pool closes while the socket is idle 10 s after the close: 10,005 to 10,022 ms over 3 runs
  await until(() => gone.state.is === 'unjoined', 'the removed machine hearing it', 20_000)
  expect((await machinesOf(here)).map(({ name }) => name)).toEqual(['anyhost-a'])
  expect((await devicesOf(here)).get(other.id)).toMatchObject({ name: 'anyhost-b', roots: roots('/home/bob') })
  expect((await devicesOf(here)).get(other.id)?.removedAt).toBeString()
  expect((await listSessions(here)).map(({ id, machine }) => [id, machine])).toEqual([[SESSION, 'anyhost-b']])
  // a remove sent again, as after its answer was lost, is done as the first was
  await removeMachine(here, other.id)
  await expect(removeMachine(here, 'device-never-joined')).rejects.toThrow('No machine with the id device-never-joined is joined.')
})

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
const DAILY_LIMIT = "Cloudflare refuses the relay with its error 1027: the relay's Worker reached the Free plan's limit of 100,000 requests a day, which resets at 00:00 UTC."

// The suite missed it because the stand-in relay's join gave a machine that joined before its old token, where the
// Pool's join gives a new one and refuses the old.
test('a machine that joins again while connected puts an object over 1 MiB with its new token', async () => {
  const relay = await memoryRelay()
  let login = { url: relay.url, token: await relay.join(device, roots('/home/ada')) }
  const service = connect({ login: async () => login, device, roots: roots('/home/ada'), isPatient: true })
  await welcomed(service)
  // as the Add a machine command pasted again on this machine gives it a new token while its socket is open
  login = { url: relay.url, token: await relay.join(device, roots('/home/ada')) }
  service.reconnect()

  const bytes = crypto.getRandomValues(new Uint8Array(2 * MAX_MESSAGE_BYTES))
  expect(await service.runOne({ op: 'put', key: 'files/big.bin', bytes })).toEqual({ status: 200, etag: md5(bytes) })
})

// The suite missed it because no relay it ran ever left a request unanswered on a socket that stayed open.
test('a request the relay leaves unanswered goes again on a new socket 40 seconds later, so the seal that ends a backup pass ends', async () => {
  const relay = await memoryRelay()
  const home = join(temporaryFolder(), 'home')
  const capture = openCapture(relay.connect(device, roots(home)), device, roots(home), { db: openDatabase(join(temporaryFolder(), 'state')), code: noCode })
  const transcript = join(home, '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
  await Promise.all(uploadSessions(capture, [{ session: SESSION, tool: 'claude', paths: new Set([transcript]) }], failTest).map(([, left]) => left))
  const asked = relay.requests.length
  relay.unanswered = 1
  // a minute past the 10 quiet minutes after the upload, as a seal counts a session written that very millisecond as
  // not quiet
  const quiet = (journalOf(capture.db, SESSION)?.writtenAt ?? 0) + QUIET_MS + 60_000

  const started = Date.now()
  expect(await sealQuiet(capture, failTest, quiet)).toEqual(new Map())
  expect(Date.now() - started).toBeGreaterThanOrEqual(40_000)
  expect(relay.requests.slice(asked, asked + 2)).toEqual([
    [{ op: 'claim', session: SESSION, take: false }],
    [{ op: 'claim', session: SESSION, take: false }],
  ])
  expect(journalOf(capture.db, SESSION)?.sealed).toBe(journalOf(capture.db, SESSION)?.end ?? -1)
}, 90_000)

// The suite missed it because a socket that brought no answer brought nothing else either, while the socket waits
// from each answer: a pong, as the one to the ping at 30 seconds, and a message another machine sends are no answer.
test('a request the relay leaves unanswered drops its socket 40 seconds later while pongs and messages still arrive on it', async () => {
  const relay = await memoryRelay()
  const other: Device = { id: 'device-b', name: 'anyhost-b', os: 'linux', arch: 'arm64' }
  const here = relay.connect(device, roots('/home/ada'))
  const there = relay.connect(other, roots('/home/bob'))
  await Promise.all([welcomed(here), welcomed(there)])
  const heard: string[] = []
  here.on('moved', ({ id }) => void heard.push(id))
  const sending = setInterval(() => there.send({ t: 'moved', id: `move-${heard.length}`, to: device.id }), 5000)
  try {
    const asked = relay.requests.length
    relay.unanswered = 1

    const started = Date.now()
    expect(await here.runOne({ op: 'devices' })).toMatchObject({ status: 200 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(40_000)
    expect(heard.length).toBeGreaterThanOrEqual(7)
    expect(relay.requests.slice(asked)).toEqual([[{ op: 'devices' }], [{ op: 'devices' }]])
  } finally {
    clearInterval(sending)
  }
}, 90_000)

// The suite missed it because every login a test gave a relay read.
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

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const streams: Stream[] = []
const opens = (): Stream => {
  const stream = openStream()
  streams.push(stream)
  return stream
}
afterEach(() => {
  for (const stream of streams.splice(0)) stream.close()
})

// A link to `to` that carries each frame while `isUp` says it is up, and drops it while it is down.
const linkTo = (to: Stream, isUp: () => boolean = () => true): Link => ({ send: (frame) => (isUp() ? to.receive(frame) : undefined) })

test('a stream whose link dropped frames sends again from the offset the other side names on the next link, so no byte is lost or doubled', () => {
  const [host, viewer] = [opens(), opens()]
  let [shown, typed, sizes] = ['', '', [] as string[]]
  viewer.on('output', (bytes) => void (shown += decoder.decode(bytes)))
  host.on('input', (bytes) => void (typed += decoder.decode(bytes)))
  host.on('resize', ({ cols, rows }) => void sizes.push(`${cols}x${rows}`))
  let isUp = true
  viewer.use(linkTo(host, () => isUp))
  host.use(linkTo(viewer, () => isUp))
  host.write('output', encoder.encode('one '))
  viewer.write('input', encoder.encode('a'))
  viewer.write('resize', { cols: 90, rows: 28 })
  isUp = false
  host.write('output', encoder.encode('two '))
  viewer.write('input', encoder.encode('b'))
  viewer.write('resize', { cols: 120, rows: 40 })
  expect([shown, typed, sizes]).toEqual(['one ', 'a', ['90x28']])

  // each side's first frame on the new link names what it holds, and each sends again from the other's offset
  host.use(linkTo(viewer))
  viewer.use(linkTo(host))
  host.write('output', encoder.encode('three'))
  viewer.write('input', encoder.encode('c'))
  expect([shown, typed, sizes]).toEqual(['one two three', 'abc', ['90x28', '120x40']])
  // a link that comes back again sends nothing twice
  host.use(linkTo(viewer))
  viewer.use(linkTo(host))
  expect([shown, typed, sizes]).toEqual(['one two three', 'abc', ['90x28', '120x40']])
})

// A viewer's link to a host in production's order: the viewer links at the host's `attached`, which serve.ts sends
// before its stream's first `use()`, so what the viewer sends reaches the host before the viewer hears the host's first
// frame. The `attached` names a host stream the viewer never linked with, so the viewer's stream starts over, as attach.ts
// starts it.
const attachedTo = (viewer: Stream, host: Stream): void => {
  viewer.startOver()
  const held: Uint8Array[] = []
  let isHeld = true
  viewer.use({ send: (frame) => (isHeld ? void held.push(frame) : host.receive(frame)) })
  host.use(linkTo(viewer))
  isHeld = false
  for (const frame of held.splice(0)) host.receive(frame)
}

// The suite missed it: its restart test linked the restarted host before its viewer, the reverse of production.
test("keys typed before, during and after the loss of the host's stream, as its program restarted or it forgot the viewer, reach a host once each and in order, and the new host's screen shows from its first byte", () => {
  jest.useFakeTimers()
  try {
    const viewer = opens()
    let shown = ''
    viewer.on('output', (bytes) => void (shown += decoder.decode(bytes)))
    const typed: string[] = []
    const hostNamed = (name: string): Stream => {
      const host = opens()
      host.on('input', (bytes) => void typed.push(`${name}:${decoder.decode(bytes)}`))
      return host
    }
    const type = (keys: string): void => viewer.write('input', encoder.encode(keys))
    const first = hostNamed('first')
    attachedTo(viewer, first)
    first.write('output', encoder.encode('first screen. '))
    type('earlier')
    // which the host acknowledges a second later
    jest.advanceTimersByTime(1000)
    // within the second before the host would acknowledge it
    type('yes')
    // the link goes, and the host's stream with it
    viewer.use(undefined)
    first.close()
    type('during')

    const second = hostNamed('second')
    attachedTo(viewer, second)
    second.write('output', encoder.encode('second screen.'))
    type('after')
    expect(typed).toEqual(['first:earlier', 'first:yes', 'second:during', 'second:after'])
    expect(shown).toBe('first screen. second screen.')
  } finally {
    jest.useRealTimers()
  }
})

// The suite missed it: every link a test dropped carried each frame until it went, while a viewer's program whose relay
// is down refuses the frames its link brings.
test('the keys from the frame a link refused reach the next host once the stream starts over, and the keys the link carried before it reach no host again', () => {
  jest.useFakeTimers()
  try {
    const viewer = opens()
    const typed: string[] = []
    const hostNamed = (name: string): Stream => {
      const host = opens()
      host.on('input', (bytes) => void typed.push(`${name}:${decoder.decode(bytes)}`))
      return host
    }
    const first = hostNamed('first')
    // the viewer's link through its program, whose relay refuses each frame from the moment it goes down
    let isRelayUp = true
    let refusedAt: number | undefined
    viewer.startOver()
    viewer.use({ send: (frame) => (isRelayUp ? first.receive(frame) : void (refusedAt ??= offsetOf(frame))) })
    first.use(linkTo(viewer))
    viewer.write('input', encoder.encode('carried'))
    isRelayUp = false
    viewer.write('input', encoder.encode('refused'))
    // the program's `offline` names the frame's offset
    viewer.refused(refusedAt ?? Infinity)
    viewer.write('input', encoder.encode('later'))
    first.close()

    attachedTo(viewer, hostNamed('second'))
    expect(typed).toEqual(['first:carried', 'second:refused', 'second:later'])
  } finally {
    jest.useRealTimers()
  }
})

// The suite missed it: `refused` took any offset, so an `offline` naming the end of the keys the relay carried before a
// direct connection took over counted the keys that connection carried as carried by none, and a new host got them
// again.
test('a link refused after another link carried keys leaves those keys carried, whatever offset its offline names', () => {
  jest.useFakeTimers()
  try {
    const viewer = opens()
    const typed: string[] = []
    const hostNamed = (name: string): Stream => {
      const host = opens()
      host.on('input', (bytes) => void typed.push(`${name}:${decoder.decode(bytes)}`))
      return host
    }
    const first = hostNamed('first')
    viewer.startOver()
    // through the relay, which carries the first key
    viewer.use(linkTo(first))
    first.use(linkTo(viewer))
    viewer.write('input', encoder.encode('relayed'))
    // over a direct connection, which carries the second
    viewer.use(linkTo(first))
    viewer.write('input', encoder.encode('direct'))
    // back on the relay, which refuses every frame, and whose program's offline names the end of the key it carried
    viewer.use({ send: () => undefined })
    viewer.write('input', encoder.encode('refused'))
    viewer.refused('relayed'.length)
    first.close()

    attachedTo(viewer, hostNamed('second'))
    expect(typed).toEqual(['first:relayed', 'first:direct', 'second:refused'])
  } finally {
    jest.useRealTimers()
  }
})

// The kind of a stream frame, its first byte: 3 is output, and 7 an acknowledgement, a side's first frame on each link
// too, which names the offset a side holds in its last 4 bytes.
const kindOf = (frame: Uint8Array): number => frame[0] ?? 0
const heldIn = (frame: Uint8Array): number => new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(5)
// A link to `to` that keeps each frame it carries in `carried`.
const keptLinkTo = (to: Stream, carried: Uint8Array[]): Link => ({
  send: (frame) => {
    carried.push(frame)
    to.receive(frame)
  },
})

test('a stream that takes nothing runs no timer, and one that takes frames acknowledges them once, a second after the first', () => {
  jest.useFakeTimers()
  try {
    const [host, viewer] = [opens(), opens()]
    const fromViewer: Uint8Array[] = []
    host.use(linkTo(viewer))
    viewer.use(keptLinkTo(host, fromViewer))
    jest.advanceTimersByTime(60_000)
    expect(jest.getTimerCount()).toBe(0)
    // the link's first frame, which holds nothing yet
    expect(fromViewer.map(kindOf)).toEqual([7])
    expect(heldIn(fromViewer[0] ?? new Uint8Array())).toBe(0)

    host.write('output', encoder.encode('one '))
    jest.advanceTimersByTime(400)
    host.write('output', encoder.encode('two'))
    jest.advanceTimersByTime(599)
    expect(fromViewer.map(kindOf)).toEqual([7])
    jest.advanceTimersByTime(1)
    expect(fromViewer.map(kindOf)).toEqual([7, 7])
    expect(heldIn(fromViewer[1] ?? new Uint8Array())).toBe('one two'.length)
    jest.advanceTimersByTime(60_000)
    expect(jest.getTimerCount()).toBe(0)
    expect(fromViewer.map(kindOf)).toEqual([7, 7])
  } finally {
    jest.useRealTimers()
  }
})

test('a link switch after frames the other side took and has not acknowledged yet loses no byte and doubles none', () => {
  jest.useFakeTimers()
  try {
    const [host, viewer] = [opens(), opens()]
    let shown = ''
    viewer.on('output', (bytes) => void (shown += decoder.decode(bytes)))
    host.use(linkTo(viewer))
    viewer.use(linkTo(host))
    host.write('output', encoder.encode('one '))
    host.write('output', encoder.encode('two '))
    jest.advanceTimersByTime(500)

    // the host sends both frames again on the next link, and the viewer, which holds them, drops them by their offset
    const fromHost: Uint8Array[] = []
    host.use(keptLinkTo(viewer, fromHost))
    viewer.use(linkTo(host))
    host.write('output', encoder.encode('three'))
    expect(fromHost.map(kindOf)).toEqual([7, 3, 3, 3])
    expect(shown).toBe('one two three')

    // once the viewer acknowledged what it took, a link after it sends nothing again
    jest.advanceTimersByTime(1000)
    const again: Uint8Array[] = []
    host.use(keptLinkTo(viewer, again))
    expect(again.map(kindOf)).toEqual([7])
    expect(shown).toBe('one two three')
  } finally {
    jest.useRealTimers()
  }
})

const randomKey = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
// every server and connection a test opened, closed after it
const closers: (() => void)[] = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
})
const closing = <T extends { close(): void } | Socket>(opened: T): T => {
  closers.push(() => ('destroy' in opened ? opened.destroy() : opened.close()))
  return opened
}
// A host's direct listener on loopback, which a test machine has whatever its network, on a port of its own. It
// listens until the test process ends, as the program's listens until the program ends.
const listensHere = async (): Promise<DirectListener> => await listenDirect(temporaryFolder(), failTest, () => ['127.0.0.1'])

test('a direct frame is its length and AES-256-GCM under an HKDF-SHA256 key of the stream key, id and both salts, one per direction, its nonce a counter', () => {
  const key = crypto.getRandomValues(new Uint8Array(32))
  const [viewerSalt, hostSalt] = [crypto.getRandomValues(new Uint8Array(16)), crypto.getRandomValues(new Uint8Array(16))]
  const stream = 1388413289
  const viewer = cipherOf(key, stream, viewerSalt, hostSalt, 'viewer to host')
  const sealed = [viewer.seal(encoder.encode('first')), viewer.seal(encoder.encode('second'))]
  const id = Buffer.alloc(4)
  id.writeUInt32BE(stream)
  const derived = Buffer.from(hkdfSync('sha256', key, Buffer.concat([id, viewerSalt, hostSalt]), 'anyhost viewer to host', 32))
  const opened = sealed.map((framed, count) => {
    expect(framed.readUInt32BE(0)).toBe(framed.length - 4)
    const nonce = Buffer.alloc(12)
    nonce.writeBigUInt64BE(BigInt(count), 4)
    const decipher = createDecipheriv('aes-256-gcm', derived, nonce)
    decipher.setAuthTag(framed.subarray(framed.length - 16))
    return decoder.decode(Buffer.concat([decipher.update(framed.subarray(4, framed.length - 16)), decipher.final()]))
  })
  expect(opened).toEqual(['first', 'second'])
  // the host opens them in their order, and the other direction's key or another salt of either side opens nothing
  const host = cipherOf(key, stream, viewerSalt, hostSalt, 'viewer to host')
  expect(sealed.map((framed) => decoder.decode(host.open(framed.subarray(4))))).toEqual(['first', 'second'])
  const first = sealed[0]?.subarray(4) ?? new Uint8Array()
  expect(() => cipherOf(key, stream, viewerSalt, hostSalt, 'host to viewer').open(first)).toThrow()
  expect(() => cipherOf(key, stream, crypto.getRandomValues(new Uint8Array(16)), hostSalt, 'viewer to host').open(first)).toThrow()
  expect(() => cipherOf(key, stream, viewerSalt, crypto.getRandomValues(new Uint8Array(16)), 'viewer to host').open(first)).toThrow()
})

// What the host sends a connection that opens with `opening`, then `after(host salt)` once the host's salt came: its
// salt, and every byte after it until it closed the connection or 500 ms passed.
const answerOf = (port: number, opening: Uint8Array, after: (hostSalt: Buffer) => Uint8Array): Promise<{ readonly salt: number; readonly after: number; readonly isClosed: boolean }> =>
  new Promise((resolve) => {
    const socket = closing(dialTcp({ host: '127.0.0.1', port }))
    let got = Buffer.alloc(0)
    const answer = (isClosed: boolean) => ({ salt: Math.min(got.length, 16), after: Math.max(got.length - 16, 0), isClosed })
    socket.on('connect', () => socket.write(opening))
    socket.on('data', (chunk: Buffer) => {
      const isFirst = got.length < 16
      got = Buffer.concat([got, chunk])
      if (isFirst && got.length >= 16) socket.write(after(got.subarray(0, 16)))
    })
    socket.on('error', () => undefined)
    socket.on('close', () => resolve(answer(true)))
    setTimeout(() => resolve(answer(false)), 500)
  })
const openingOf = (stream: number, viewerSalt: Uint8Array): Buffer => {
  const id = Buffer.alloc(4)
  id.writeUInt32BE(stream)
  return Buffer.concat([id, viewerSalt])
}

// A TCP proxy to `port` on loopback, listening at `host` and `at`, a free port unless named. It keeps every byte its
// clients sent, carries each byte and each close `delayMs` late and in order, as a slow path does, and once cut carries
// nothing and closes neither side, as a firewall that drops every packet does.
async function proxyTo(port: number, { host = '127.0.0.1', at = 0, delayMs = 0 } = {}): Promise<{ readonly port: number; readonly sent: () => Buffer; cut(): void }> {
  let isCut = false
  let sent = Buffer.alloc(0)
  const later = (carry: () => void): void => void (delayMs === 0 ? carry() : setTimeout(carry, delayMs))
  const server = closing(
    createServer((inbound) => {
      const outbound = closing(dialTcp({ host: '127.0.0.1', port }))
      closing(inbound)
      inbound.on('data', (chunk: Buffer) => void (sent = Buffer.concat([sent, chunk])))
      for (const [from, to] of [[inbound, outbound], [outbound, inbound]] as const) {
        from.on('data', (chunk) => later(() => void (isCut || to.write(chunk))))
        from.on('close', () => later(() => void (isCut || to.destroy())))
        from.on('error', () => undefined)
      }
    }),
  )
  await new Promise<void>((resolve) => server.listen({ port: at, host }, () => resolve()))
  return { port: (server.address() as { port: number }).port, sent: () => sent, cut: () => void (isCut = true) }
}

// The viewer's direct link to the host at `offer`, which brings `viewer` the host's frames.
async function dialed(offer: DirectOffer, stream: number, key: string, viewer: Stream): Promise<DirectLink> {
  const link = await dialDirect(offer, stream, key, (frame) => viewer.receive(frame))
  if (link === undefined) throw new Error(`No address of ${offer.addresses.join(', ')} answered at ${offer.port}.`)
  return closing(link)
}

test('the host answers every opening with its salt, and closes a connection whose hello opens under the key of no stream it holds, with nothing sealed sent', async () => {
  const listener = await listensHere()
  const key = randomKey()
  listener.hold(7, key, () => undefined, () => undefined)
  const { port, addresses } = await listener.offer()
  expect(addresses).toEqual(['127.0.0.1'])
  // a hello sealed under `sealedWith` and the salts of this connection
  const helloOf = (stream: number, sealedWith: string) => async () => {
    const viewerSalt = crypto.getRandomValues(new Uint8Array(16))
    return await answerOf(port, openingOf(stream, viewerSalt), (hostSalt) => cipherOf(Buffer.from(sealedWith, 'base64'), stream, viewerSalt, hostSalt, 'viewer to host').seal(new Uint8Array()))
  }
  expect(await helloOf(7, randomKey())()).toEqual({ salt: 16, after: 0, isClosed: true })
  expect(await helloOf(8, key)()).toEqual({ salt: 16, after: 0, isClosed: true })
  // the key of the stream it holds gets the host's hello, an empty frame sealed: its length and the 16-byte tag
  expect(await helloOf(7, key)()).toEqual({ salt: 16, after: 4 + 16, isClosed: false })
})

test('an opening and hello an observer replays get a new salt from the host, so the replay closes with nothing sealed and the viewer\'s link goes on', async () => {
  const listener = await listensHere()
  const [host, viewer] = [opens(), opens()]
  let [shown, typed, links] = ['', '', 0]
  host.on('input', (bytes) => void (typed += decoder.decode(bytes)))
  viewer.on('output', (bytes) => void (shown += decoder.decode(bytes)))
  const stream = 1388413289
  const key = randomKey()
  listener.hold(stream, key, (frame) => host.receive(frame), (link) => {
    links += 1
    host.use(link)
  })
  const { port } = await listener.offer()
  // a proxy that keeps what the viewer sent first: its opening and its hello
  const recorder = await proxyTo(port)
  viewer.use(await dialed({ port: recorder.port, addresses: ['127.0.0.1'] }, stream, key, viewer))
  await until(() => links === 1, 'the host linking the viewer')
  // the opening, 20 bytes, then the hello, its length and the 16-byte tag
  const [opening, hello] = [recorder.sent().subarray(0, 20), recorder.sent().subarray(20, 40)]
  expect(hello.readUInt32BE(0)).toBe(16)

  expect(await answerOf(port, opening, () => hello)).toEqual({ salt: 16, after: 0, isClosed: true })
  expect(links).toBe(1)
  host.write('output', encoder.encode('still the viewer\'s'))
  viewer.write('input', encoder.encode('typed after the replay'))
  await until(() => shown === 'still the viewer\'s' && typed === 'typed after the replay', 'both ends hearing each other')
})

// an address of an interface, as `networkInterfaces()` lists it
const info = (address: string, internal = false): NetworkInterfaceInfo =>
  (address.includes(':') ? { address, family: 'IPv6', internal, netmask: '', mac: '', cidr: null, scopeid: 0 } : { address, family: 'IPv4', internal, netmask: '', mac: '', cidr: null })

test('a host offers its Tailscale addresses first, then the private LAN addresses of its physical interfaces, and never a public, loopback, link-local or bridge address', () => {
  // devbox's interfaces, a home LAN, a Docker host and a Mac running OrbStack, in one machine
  const offered = offeredAddresses({
    lo: [info('127.0.0.1', true), info('::1', true)],
    eth0: [info('178.104.119.159'), info('fe80::9000:6ff:fe4b:1a2c')],
    tailscale0: [info('100.65.43.38'), info('fd7a:115c:a1e0::e801:2b26')],
    docker0: [info('172.17.0.1')],
    'br-5c3b1f0a9e2d': [info('172.19.0.1')],
    veth1a2b3c4: [info('fe80::a0de:2fff:fe4d:11')],
    wlan0: [info('192.168.1.20'), info('fd07:b51a:cc66:0:a617:db5e:ab7:e9f1')],
    en1: [info('10.0.0.5'), info('172.32.0.9'), info('100.128.0.1')],
    bridge100: [info('192.168.139.3')],
  })
  expect(offered).toEqual(['100.65.43.38', 'fd7a:115c:a1e0::e801:2b26', '192.168.1.20', '10.0.0.5'])
})

// The suite missed it: every 100.64.0.0/10 address a test offered was on Tailscale's interface, while an ISP's
// carrier-grade NAT gives one to a machine's own interface, where the ISP's other customers reach it.
test("a host offers a 100.64.0.0/10 address only on Tailscale's interface: tailscale0 on Linux, and on macOS the utun interface that holds Tailscale's IPv6 address", () => {
  // Linux with carrier-grade NAT on eth0, and Tailscale with IPv6 off
  expect(offeredAddresses({ eth0: [info('100.72.14.9')], tailscale0: [info('100.65.43.38')] })).toEqual(['100.65.43.38'])
  // macOS with carrier-grade NAT on en0, another VPN's utun3 in the same range, and Tailscale on utun4, as on the
  // Architect's Mac
  const mac = { en0: [info('100.72.14.9'), info('192.168.1.20')], utun3: [info('100.96.0.2'), info('fe80::1')], utun4: [info('100.119.201.53'), info('fd7a:115c:a1e0::3c32:c935')] }
  expect(offeredAddresses(mac)).toEqual(['100.119.201.53', 'fd7a:115c:a1e0::3c32:c935', '192.168.1.20'])
})

test('a 200-character line typed while its direct link is cut arrives once and in order over the relay', async () => {
  const listener = await listensHere()
  const [host, viewer] = [opens(), opens()]
  let typed = ''
  host.on('input', (bytes) => void (typed += decoder.decode(bytes)))
  const [toHost, toViewer] = [linkTo(host), linkTo(viewer)]
  host.use(toViewer)
  viewer.use(toHost)
  // each end as serve.ts and attach.ts run it: the direct link carries the stream while it lasts, then the relay
  const stream = 1388413289
  const key = randomKey()
  let hostLink: DirectLink | undefined
  listener.hold(stream, key, (frame) => host.receive(frame), (link) => {
    hostLink = link
    host.use(link)
    void link.ended.then(() => host.use(toViewer))
  })
  const cutter = await proxyTo((await listener.offer()).port)
  const viewerLink = await dialed({ port: cutter.port, addresses: ['127.0.0.1'] }, stream, key, viewer)
  viewer.use(viewerLink)
  // what the host took before the viewer went back to the relay, which only the direct link brought
  let typedOverDirect = -1
  void viewerLink.ended.then(() => {
    typedOverDirect = typed.length
    viewer.use(toHost)
  })
  await until(() => hostLink !== undefined, 'the host linking the viewer')

  const line = Array.from({ length: 200 }, (_, at) => String.fromCharCode(33 + (at % 94))).join('')
  for (const [at, character] of [...line].entries()) {
    if (at === 50) cutter.cut()
    viewer.write('input', encoder.encode(character))
    await Bun.sleep(5)
  }
  // both ends heard nothing for 3 s and went back to the relay, which brought the rest
  expect(await viewerLink.ended).toBe('it brought nothing for 3 s')
  expect(await hostLink?.ended).toBe('it brought nothing for 3 s')
  await until(() => typed.length >= line.length, 'the whole line')
  expect(typedOverDirect).toBeGreaterThan(0)
  expect(typedOverDirect).toBeLessThanOrEqual(50)
  expect(typed).toBe(line)
}, 20_000)

test('a host that offers two addresses that both answer ends with one live direct link on each side, the same connection', async () => {
  const listener = await listensHere()
  const [host, viewer] = [opens(), opens()]
  let [shown, typed] = ['', '']
  host.on('input', (bytes) => void (typed += decoder.decode(bytes)))
  viewer.on('output', (bytes) => void (shown += decoder.decode(bytes)))
  const stream = 1388413289
  const key = randomKey()
  const hostLinks: DirectLink[] = []
  listener.hold(stream, key, (frame) => host.receive(frame), (link) => {
    hostLinks.push(link)
    host.use(link)
  })
  const { port } = await listener.offer()
  // The first address the viewer dials answers 200 ms after it sent anything, as a slow path does, before the second
  // address's dial 250 ms later: its salt comes back, and its hello reaches the host after the second address's did.
  await proxyTo(port, { host: '::1', at: port, delayMs: 100 })
  const link = await dialed({ port, addresses: ['::1', '127.0.0.1'] }, stream, key, viewer)
  viewer.use(link)
  const isLive = async (ended: Promise<string>): Promise<boolean> => (await Promise.race([ended, Bun.sleep(0).then(() => 'live')])) === 'live'

  // past the 3 s a link that hears nothing lasts
  await Bun.sleep(4000)
  expect(hostLinks).toHaveLength(1)
  expect(await isLive(link.ended)).toBe(true)
  expect(await isLive(hostLinks[0]?.ended ?? Promise.resolve('none'))).toBe(true)
  host.write('output', encoder.encode('over the one connection'))
  viewer.write('input', encoder.encode('typed over it'))
  await until(() => shown === 'over the one connection' && typed === 'typed over it', 'both ends hearing each other')
})

const HOST: Device = { id: 'device-host', name: 'anyhost-a', os: 'linux', arch: 'arm64' }
const VIEWER: Device = { id: 'device-viewer', name: 'anyhost-b', os: 'linux', arch: 'arm64' }
const CLI = join(import.meta.dir, '..', 'src', 'main.ts')
const children: Subprocess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited
  }
})

const script = (path: string, text: string): string => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, 0o755)
  return path
}

// Claude Code's record of SESSION running in its background as the process `pid`, as Claude Code keeps it while it runs,
// and rewrites at each change of its `status`.
const recordSession = (home: string, pid: number, status = 'busy'): void =>
  writeFileSync(join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: SESSION, cwd: '/', kind: 'bg', jobId: SESSION.slice(0, 8), status }))
// The lock of Claude Code's daemon, which names the test's own process, and on Linux its start, the 22nd field of its
// stat, as Claude Code writes it there.
const procStat = existsSync(`/proc/${process.pid}/stat`) ? readFileSync(`/proc/${process.pid}/stat`, 'utf8') : undefined
const DAEMON_LOCK = JSON.stringify({ pid: process.pid, ...(procStat === undefined ? {} : { procStart: procStat.slice(procStat.lastIndexOf(')') + 2).split(' ')[19] }) })

// A machine's folders, its relay login, the cmod that answers its device token and the options `person` sets, and the Claude Code that
// runs SESSION in its background when `isHost` says so. Its `claude attach` enters the alternate screen and prints the
// terminal's size in one write at its start, after the seconds `draws-after` in the machine's folder holds when there is
// one, clears the screen and prints it again at each SIGWINCH in one write, as Claude Code paints a frame, keeps its
// terminal cooked, which echoes each key as the terminal takes it, prints each line typed into it, and ends at the line `leave`, as it ends when a person leaves its agents view, and
// when its terminal closes. It reads the lines in a job of its own and waits for it, as a signal it traps ends a `wait`
// at once, while bash 5 runs the trap of a signal that came during `read` only once a line comes. Each run goes into
// `claude.log` in the machine's folder, with its arguments. `claude agents` answers after the seconds `slow` in the
// machine's folder holds, when there is one, as it took up to 4.59 s on test machines.
// Its record in `sessions/` names the test's own process, which runs as long as the test, and so does the lock of
// Claude Code's daemon, which a background session needs to run. `claude` replaces that Claude Code with a script of
// the machine's folder.
async function machineFor(relay: MemoryRelay, device: Device, isHost: boolean, claude?: (folder: string) => string, person: Record<string, unknown> = {}): Promise<{ readonly env: Record<string, string>; readonly socket: string; readonly folder: string }> {
  const folder = temporaryFolder()
  const home = join(folder, 'home')
  mkdirSync(join(folder, 'tmp'), { recursive: true })
  // where Claude Code keeps the record of each session it runs, and its transcripts
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
  writeFileSync(join(home, '.claude', 'daemon.lock'), DAEMON_LOCK)
  const env = {
    // the machine's own programs, such as its herdr, come first
    PATH: `${join(folder, 'bin')}:${process.env['PATH'] ?? ''}`,
    HOME: home,
    XDG_STATE_HOME: join(folder, 'state'),
    XDG_DATA_HOME: join(folder, 'data'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CLAUDE_CODE_TMPDIR: join(folder, 'tmp'),
    CODEX_HOME: join(home, '.codex'),
    ANYHOST_DEVICE_ID: device.id,
    ANYHOST_DEVICE_NAME: device.name,
    ANYHOST_DEVICE_OS: device.os,
    ANYHOST_DEVICE_ARCH: device.arch,
    // the user's systemd, which runs each claude --bg and claude attach in a scope on Linux, as it gives a service
    ...(process.env['XDG_RUNTIME_DIR'] === undefined ? {} : { XDG_RUNTIME_DIR: process.env['XDG_RUNTIME_DIR'] }),
    CLAUDE_CODE_EXECPATH: script(
      join(folder, 'bin', 'claude'),
      claude?.(folder) ??
        `#!/bin/bash
echo "$*" >> '${join(folder, 'claude.log')}'
case "$1" in
  agents)
    if [ -e '${join(folder, 'slow')}' ]; then sleep "$(cat '${join(folder, 'slow')}')"; fi
    printf '%s' '${isHost ? `[{"pid":1,"id":"${SESSION.slice(0, 8)}","sessionId":"${SESSION}","kind":"background","cwd":"/","status":"busy","state":"working"}]` : '[]'}' ;;
  attach)
    if [ -e '${join(folder, 'draws-after')}' ]; then sleep "$(cat '${join(folder, 'draws-after')}')"; fi
    printf '\\033[?1049hsize %s\\n' "$(stty size)"
    while IFS= read -r line; do [ "$line" = leave ] && exit 0; echo "typed $line"; done <&0 &
    trap 'printf "\\033[2Jsize %s\\n" "$(stty size)"' WINCH
    while kill -0 $! 2>/dev/null; do wait $!; done ;;
  *) exit 2 ;;
esac
`,
    ),
  }
  if (isHost && claude === undefined) recordSession(home, process.pid)
  const token = await relay.join(device, roots(home))
  script(
    join(env.XDG_DATA_HOME, 'cmod', 'programs', 'cmod'),
    `#!/bin/sh\ncase "$1 $2" in\n  "secret get") printf '%s' '${token}' ;;\n  "options anyhost") printf '%s' '${JSON.stringify({ person })}' ;;\n  "device --json") printf '%s' '${JSON.stringify(device)}' ;;\n  *) exit 1 ;;\nesac\n`,
  )
  mkdirSync(join(env.XDG_STATE_HOME, 'anyhost'), { recursive: true })
  writeFileSync(join(env.XDG_STATE_HOME, 'anyhost', 'relay.json'), JSON.stringify({ url: relay.url }))
  return { env, socket: join(env.XDG_STATE_HOME, 'anyhost', 'serve.sock'), folder }
}

// The `claude attach` processes the machine's Claude Code runs, by their pids.
const attachesOn = (machine: { readonly env: Record<string, string> }): string => Bun.spawnSync(['pgrep', '-f', `${machine.env['CLAUDE_CODE_EXECPATH']} attach`]).stdout.toString().trim()

// Runs `anyhost serve` on the machine and answers the first line it printed, the program, and what it logged so far,
// which goes on to the test's own errors too.
async function serveOn(env: Record<string, string>): Promise<{ readonly address: string; readonly child: Subprocess; readonly logged: () => string }> {
  const child = Bun.spawn(['bun', CLI, 'serve'], { env, stdout: 'pipe', stderr: 'pipe' })
  children.push(child)
  let logged = ''
  void (async () => {
    const text = new TextDecoder()
    for await (const chunk of child.stderr) {
      process.stderr.write(chunk)
      logged += text.decode(chunk, { stream: true })
    }
  })()
  const reader = child.stdout.getReader()
  let printed = ''
  while (!printed.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`anyhost serve exited, having printed ${JSON.stringify(printed)}.`)
    printed += decoder.decode(value)
  }
  reader.releaseLock()
  return { address: printed.slice(0, printed.indexOf('\n')), child, logged: () => logged }
}

// Runs the anyhost command `args` on the machine with `input` typed into its terminal, and answers its exit code and
// what it printed.
async function anyhostOn(env: Record<string, string>, args: readonly string[], input = ''): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  const child = Bun.spawn(['bun', CLI, ...args], { env, stdin: new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' })
  children.push(child)
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, out, err }
}

test('anyhost join asks the program that answers on this machine, which joins in turn with its forgets', async () => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST, false)
  const asked: unknown[] = []
  // the program's /join as serve.ts answers it, at the program's own socket
  const program = Bun.serve({
    unix: socket,
    async fetch(request) {
      asked.push({ method: request.method, path: new URL(request.url).pathname, body: await request.json() })
      return Response.json({ url: 'https://anyhost-test-join.parker-labs.workers.dev' })
    },
  })
  try {
    // no relay answers at this link, so only the program's answer joins
    const link = "cmod install heyJordanParker/anyhost --option 'join=http://127.0.0.1:9/v1/join#K7QX2M4W9TPR6ZC3'"
    expect(await anyhostOn(env, ['join', link])).toEqual({ code: 0, out: 'Joined this machine to https://anyhost-test-join.parker-labs.workers.dev\n', err: '' })
    expect(asked).toEqual([{ method: 'POST', path: '/join', body: { link } }])
  } finally {
    await program.stop(true)
  }
})

test('anyhost join joins in its own process when no program answers on this machine', async () => {
  const { env } = await machineFor(await memoryRelay(), HOST, false)
  const asked: string[] = []
  const relay = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      asked.push(`${request.method} ${new URL(request.url).pathname}`)
      return Response.json({ error: 'invite_unknown', message: 'The relay made no invite with that code. Make a new one with Add a machine.' }, { status: 403 })
    },
  })
  try {
    const { code, err } = await anyhostOn(env, ['join', `http://127.0.0.1:${relay.port}/v1/join#K7QX2M4W9TPR6ZC3`])
    expect({ code, err }).toEqual({ code: 1, err: `http://127.0.0.1:${relay.port} refused to join anyhost-a: The relay made no invite with that code. Make a new one with Add a machine.\n` })
    expect(asked).toEqual(['POST /v1/join'])
  } finally {
    await relay.stop(true)
  }
})

test('anyhost connect asks the program that answers on this machine, prints each line of its run, and answers its question from the terminal', async () => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST, false)
  const accounts = [{ id: 'a1', name: 'Parker Labs' }, { id: 'a2', name: 'Side Project' }]
  const lines = ['Checking your Cloudflare login', 'Found the bucket anyhost-test in the eu jurisdiction', 'Joined this machine to https://anyhost-test-connect.parker-labs.workers.dev']
  const asked: string[] = []
  // the program's /connect, /connect/account and /status as serve.ts answers them, at the program's own socket
  const program = Bun.serve({
    unix: socket,
    async fetch(request) {
      const { pathname } = new URL(request.url)
      asked.push(`${request.method} ${pathname}${request.method === 'POST' ? ` ${await request.text()}` : ''}`)
      if (pathname === '/connect') return Response.json({ is: 'running', lines: lines.slice(0, 1), accounts })
      if (pathname === '/connect/account') return Response.json({ is: 'running', lines: lines.slice(0, 2) })
      return Response.json({ relay: { url: '', state: 'unjoined', message: '', bucket: '' }, connecting: { is: 'joined', lines } })
    },
  })
  try {
    const { code, out, err } = await anyhostOn(env, ['connect'], '2\n')
    expect({ code, err }).toEqual({ code: 0, err: '' })
    expect(out).toBe(`${lines[0]}\nYour Cloudflare login reaches 2 accounts:\n  1  Parker Labs\n  2  Side Project\nType the number of the account your relay goes in:\n${lines[1]}\n${lines[2]}\n`)
    expect(asked).toEqual(['POST /connect {}', 'POST /connect/account {"id":"a2"}', 'GET /status'])
  } finally {
    await program.stop(true)
  }
})

// The suite missed it: no test ran anyhost doctor beside a program.
test('anyhost doctor beside a program that answers unjoined prints one ✘ line with its one fix, and reads no relay itself', async () => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST, false)
  rmSync(join(env['XDG_STATE_HOME'] ?? '', 'anyhost', 'relay.json'))
  const message = 'This machine is not joined to your relay, so anyhost keeps what its sessions write and uploads nothing.'
  const status: Status = { device: HOST, relay: { url: '', state: 'unjoined', message, bucket: '' }, pending: 0, uploadEvery: 5, capturedAt: '', problems: [], journalGaps: [] }
  const program = Bun.serve({ unix: socket, fetch: () => Response.json(status) })
  try {
    const { code, out } = await anyhostOn(env, ['doctor'])
    expect(code).toBe(1)
    expect(out.split('\n').filter((line) => line.startsWith('✘'))).toEqual([`✘ The anyhost program at ${socket} uploads nothing: ${message}`])
  } finally {
    await program.stop(true)
  }
})

// A machine whose cmod keeps `join` as its option in Claude Code's settings.json, as cmod does, keeps the secret it
// stores, and logs each option it sets, emptying the options, with no relay login yet.
async function unjoinedWithOption(link: string): Promise<{ readonly env: Record<string, string>; readonly socket: string; readonly folder: string }> {
  const machine = await machineFor(await memoryRelay(), HOST, false)
  const programs = join(machine.env['XDG_DATA_HOME'] ?? '', 'cmod', 'programs')
  const settings = join(machine.env['CLAUDE_CONFIG_DIR'] ?? '', 'settings.json')
  writeFileSync(settings, JSON.stringify({ join: link }))
  script(
    join(programs, 'cmod'),
    `#!/bin/sh\ncase "$1 $2" in\n  "secret get") cat '${programs}/token' ;;\n  "secret store") cat > '${programs}/token' ;;\n  "options anyhost") printf '{"person":%s}' "$(cat '${settings}')" ;;\n  "option anyhost") echo "$3=$4" >> '${programs}/options-set'; printf '{}' > '${settings}' ;;\n  "device --json") printf '%s' '${JSON.stringify(HOST)}' ;;\n  *) exit 1 ;;\nesac\n`,
  )
  rmSync(join(machine.env['XDG_STATE_HOME'] ?? '', 'anyhost', 'relay.json'))
  return machine
}

test('the option join joins at the program\'s start, running in /status, and one the relay refused empties the option too and stays failed in /status until the machine joins', async () => {
  // a relay that answers the option's invite once the test lets it, refusing it, and takes the next one, and serves
  // nothing else, as the program's connect to it once it joined
  const joins: string[] = []
  const answer = Promise.withResolvers<void>()
  const relay = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/join') return Response.json({ error: 'missing', message: 'The stand-in serves only POST /v1/join.' }, { status: 404 })
      const { invite } = (await request.json()) as { invite: string }
      joins.push(invite)
      if (invite !== 'USED') return Response.json({ relay: 1, protocol: 1, bucket: 'anyhost-test', token: 'token-of-anyhost-a', device: { id: HOST.id, name: HOST.name } })
      await answer.promise
      return Response.json({ error: 'invite_used', message: 'The invite already joined anyhost-c at 2026-11-07T09:00:00.000Z. Make a new one with Add a machine.' }, { status: 403 })
    },
  })
  try {
    const origin = `http://127.0.0.1:${relay.port}`
    const machine = await unjoinedWithOption(`cmod install heyJordanParker/anyhost --option 'join=${origin}/v1/join#USED'`)
    const programs = join(machine.env['XDG_DATA_HOME'] ?? '', 'cmod', 'programs')
    await serveOn(machine.env)
    await until(() => joins.length === 1, 'the join asking the relay')
    expect((await statusOn(machine.socket)).joining).toEqual({ is: 'running' })

    answer.resolve()
    await until(async () => (await statusOn(machine.socket)).joining?.is === 'failed', 'the refused join in /status')
    const refused = await statusOn(machine.socket)
    expect(refused.joining).toEqual({ is: 'failed', error: `${origin} refused to join anyhost-a: The invite already joined anyhost-c at 2026-11-07T09:00:00.000Z. Make a new one with Add a machine.` })
    // the program tries the link no more, so it is no problem the program tries again
    expect(refused.problems.filter((problem) => problem.includes('refused to join'))).toEqual([])
    expect(readFileSync(join(programs, 'options-set'), 'utf8')).toBe('join=\n')
    expect(existsSync(join(programs, 'token'))).toBe(false)

    const joined = await fetch('http://localhost/join', { unix: machine.socket, method: 'POST', body: JSON.stringify({ link: `${origin}/v1/join#FRESH` }) })
    expect(await joined.json()).toEqual({ url: origin })
    expect((await statusOn(machine.socket)).joining).toBeUndefined()
    expect(readFileSync(join(programs, 'token'), 'utf8')).toBe('token-of-anyhost-a')
    expect(joins).toEqual(['USED', 'FRESH'])
  } finally {
    await relay.stop(true)
  }
}, 30_000)

// The suite missed it: the doctor test above had no problem lines, and every line got the same fix.
test('anyhost doctor beside a program whose option join failed prints why and the fix that works, with no claim that the program tries it again', async () => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST, false)
  rmSync(join(env['XDG_STATE_HOME'] ?? '', 'anyhost', 'relay.json'))
  const refusal = 'https://anyhost.parker-labs.workers.dev refused to join anyhost-a: The invite expired at 2026-11-07T09:10:00.000Z, 10 minutes after it was made. Make a new one with Add a machine.'
  const update = '2026-11-07T09:20:00.000Z relay update: Error: cf is logged in to no Cloudflare account on this machine. Connect Cloudflare logs it in.'
  const status: Status = {
    device: HOST,
    relay: { url: '', state: 'unjoined', message: 'This machine is not joined to your relay, so anyhost keeps what its sessions write and uploads nothing.', bucket: '' },
    pending: 0,
    uploadEvery: 5,
    capturedAt: '',
    problems: [],
    journalGaps: [],
    updateProblem: update,
    joining: { is: 'failed', error: refusal },
  }
  const program = Bun.serve({ unix: socket, fetch: () => Response.json(status) })
  try {
    const { code, out } = await anyhostOn(env, ['doctor'])
    expect(code).toBe(1)
    const lines = out.split('\n')
    const at = lines.indexOf(`✘ The link of the option join joined no relay: ${refusal}`)
    expect(at).toBeGreaterThan(-1)
    expect(lines[at + 1]).toBe(
      '  The program does not try that link again. Press Add a machine in /machines on a joined machine, then paste its command into the Connect your machines step of the anyhost mod, or run anyhost join with its link here.',
    )
    expect(lines[lines.indexOf(`✘ ${update}`) + 1]).toBe('  The program tries the update once a run. Connect Cloudflare in the anyhost mod, or run anyhost connect, which updates the relay with your Cloudflare login.')
    expect(out).not.toContain('tries this again')
  } finally {
    await program.stop(true)
  }
})

// The suite missed it: an outdated relay printed two ✘ lines for one cause, the connection's and its failed update's.
test("anyhost doctor beside a program whose relay is outdated and whose update of it failed prints one ✘ line with the update's fix", async () => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST, false)
  const message = 'The relay at https://anyhost.parker-labs.workers.dev answers protocol 0, and anyhost 0.9.0 needs 1. Connect Cloudflare again to update the relay.'
  const update = '2026-11-07T09:20:00.000Z relay update: Error: cf is logged in to no Cloudflare account on this machine. Connect Cloudflare logs it in.'
  const status: Status = {
    device: HOST,
    relay: { url: 'https://anyhost.parker-labs.workers.dev', state: 'outdated', message, bucket: 'anyhost' },
    pending: 3,
    uploadEvery: 5,
    capturedAt: '',
    problems: [],
    journalGaps: [],
    updateProblem: update,
  }
  const program = Bun.serve({ unix: socket, fetch: () => Response.json(status) })
  try {
    const { code, out } = await anyhostOn(env, ['doctor'])
    expect(code).toBe(1)
    const problems = out.split('\n').filter((line) => line.startsWith('✘'))
    expect(problems).toEqual([`✘ The anyhost program at ${socket} captures nothing: ${message} Its own update of the relay failed: ${update}`])
    const lines = out.split('\n')
    expect(lines[lines.indexOf(problems[0] ?? '') + 1]).toBe('  The program tries the update once a run. Connect Cloudflare in the anyhost mod, or run anyhost connect, which updates the relay with your Cloudflare login.')
  } finally {
    await program.stop(true)
  }
})

// The suite missed it: right after an upload, while Cloudflare still runs the busy Pool's older code for up to 300 s,
// doctor said to Connect Cloudflare again, where the Step says to wait.
test('anyhost doctor beside a program whose relay is outdated with no failed update says to wait 5 minutes first, then to Connect Cloudflare again', async () => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST, false)
  const message = 'The relay at https://anyhost.parker-labs.workers.dev answers protocol 0, and anyhost 0.9.0 needs 1. Connect Cloudflare again to update the relay.'
  const status: Status = { device: HOST, relay: { url: 'https://anyhost.parker-labs.workers.dev', state: 'outdated', message, bucket: 'anyhost' }, pending: 3, uploadEvery: 5, capturedAt: '', problems: [], journalGaps: [] }
  const program = Bun.serve({ unix: socket, fetch: () => Response.json(status) })
  try {
    const { code, out } = await anyhostOn(env, ['doctor'])
    expect(code).toBe(1)
    const lines = out.split('\n')
    expect(lines[lines.indexOf(`✘ The anyhost program at ${socket} captures nothing: ${message}`) + 1]).toBe(
      '  Wait 5 minutes first: after an upload of the relay, from this machine or another, Cloudflare runs its older version for up to 5 minutes, and the program connects again within a minute. If this line is still here then, Connect Cloudflare again in the anyhost mod, or run anyhost connect, which updates the relay.',
    )
  } finally {
    await program.stop(true)
  }
})

// The suite missed it: "log out and in again" leaves a systemd user service that lingers running, so it restarted no
// program on such a Linux machine.
test('anyhost doctor names the command that restarts the program as the service of this machine, for a problem only a restart fixes', async () => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST, false)
  const direct = 'anyhost offers viewers on other machines no direct connection: Error: EADDRINUSE: address already in use.'
  const status: Status = { device: HOST, relay: { url: '', state: 'connecting', message: '', bucket: '' }, pending: 0, uploadEvery: 5, capturedAt: '', problems: [], journalGaps: [], directProblem: direct }
  const program = Bun.serve({ unix: socket, fetch: () => Response.json(status) })
  try {
    const { out } = await anyhostOn(env, ['doctor'])
    const lines = out.split('\n')
    const restart =
      process.platform === 'darwin'
        ? 'Restart the program with launchctl kickstart -k gui/$(id -u)/com.claudemodmanager.anyhost.anyhost.'
        : 'Restart the program with systemctl --user restart com.claudemodmanager.anyhost.anyhost, or, where no systemd user session runs it, close every Claude Code session and start one.'
    expect(lines[lines.indexOf(`✘ ${direct} Viewers on other machines reach this machine through the relay meanwhile.`) + 1]).toBe(`  ${restart}`)
  } finally {
    await program.stop(true)
  }
})

// The suite missed it: anyhost doctor read Cloudflare's daily limit as a relay that did not answer, and said to check
// the internet.
test("anyhost doctor with no program reads the relay's 429 error code: 1027 as Cloudflare's daily limit, which resets at 00:00 UTC", async () => {
  const relay = await memoryRelay()
  const { env } = await machineFor(relay, HOST, false)
  relay.dailyLimited = Infinity
  const { code, out } = await anyhostOn(env, ['doctor'])
  expect(code).toBe(1)
  const lines = out.split('\n')
  expect(lines[lines.indexOf(`✘ ${DAILY_LIMIT}`) + 1]).toBe('  Wait until 00:00 UTC. The program keeps every change meanwhile and uploads it once the relay answers.')
  expect(out).not.toContain('did not answer')
})

// A viewer on its own machine, attached to SESSION on HOST through the relay as `anyhost serve` sends an attach, whose
// stream starts over at an `attached` of a host stream it never linked with, as `anyhost attach` starts it. `attach`
// sends the same attach again, as `anyhost attach` does after a `detach`.
async function viewerOn(relay: MemoryRelay, device: Device, size: { cols: number; rows: number }) {
  const client = relay.connect(device, roots(`/home/${device.name}`))
  await welcomed(client)
  const id = Math.floor(Math.random() * 2 ** 32)
  const stream = opens()
  const seen = { shown: '', states: [] as string[], attached: [] as unknown[], exits: [] as string[] }
  stream.on('output', (bytes) => void (seen.shown += decoder.decode(bytes)))
  stream.on('state', ({ status }) => void seen.states.push(status))
  stream.on('exit', ({ message }) => void seen.exits.push(message))
  let hostStream: number | undefined
  client.on('attached', (message) => {
    if (message.stream !== id) return
    seen.attached.push(message)
    if (message.hostStream !== hostStream) stream.startOver()
    hostStream = message.hostStream
    stream.use({ send: (frame) => void client.send(encodeStream(id, frame)) })
  })
  client.on('stream', (bytes) => (streamOf(bytes) === id ? stream.receive(bytes.subarray(5)) : undefined))
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
  const attach = (): void => void client.send({ t: 'attach', stream: id, to: HOST.id, session: SESSION, ...size, key })
  attach()
  return { id, stream, seen, client, attach }
}

test('serve answers at unix:<its state folder>/serve.sock, and two viewers of one session draw it at the smaller size of the two', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, true)
  const served = await serveOn(host.env)
  expect(served.address).toBe(`unix:${host.socket}`)
  expect((await statusOn(host.socket)).device).toEqual(HOST)
  await until(() => relay.isConnected(HOST.id), 'the host connecting')

  const small = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await until(() => small.seen.shown.includes('size 24 80'), 'the first viewer\'s screen')
  // the host offers the port it picked at its first start and every address of this machine it may be dialed at
  const { port } = JSON.parse(readFileSync(join(host.env['XDG_STATE_HOME'] ?? '', 'anyhost', 'direct.json'), 'utf8')) as { port: number }
  expect(small.seen.attached).toEqual([{ t: 'attached', stream: small.id, hostStream: expect.any(Number), port, addresses: offeredAddresses(), from: { id: HOST.id, name: HOST.name } }])
  expect(small.seen.shown.startsWith('\x1b[?1049h')).toBe(true)
  await until(() => small.seen.states.includes('busy'), 'the session\'s status')

  // a larger viewer gets the alternate screen and a redraw, a row less and back, at the size both draw whole
  const large = await viewerOn(relay, { ...VIEWER, id: 'device-viewer-2', name: 'mac' }, { cols: 120, rows: 40 })
  await until(() => large.seen.shown.includes('size 24 80'), 'the redraw')
  expect(large.seen.shown).toStartWith('\x1b[?1049h')
  expect(large.seen.shown).toContain('size 23 80')
  expect(small.seen.shown).toContain('size 23 80')

  // a resize is a frame of the viewer's stream, and the smaller of each side wins
  small.stream.write('resize', { cols: 100, rows: 50 })
  await until(() => large.seen.shown.includes('size 40 100'), 'the new smallest size')
  large.stream.write('input', encoder.encode('from the mac\r'))
  await until(() => small.seen.shown.includes('typed from the mac') && large.seen.shown.includes('typed from the mac'), 'the typed line on both')

  // keys of one viewer that end `claude attach` while the session runs get every viewer a new one, which paints anew
  const [smallBefore, largeBefore] = [small.seen.shown.length, large.seen.shown.length]
  small.stream.write('input', encoder.encode('leave\r'))
  await until(() => small.seen.shown.slice(smallBefore).includes('size 40 100') && large.seen.shown.slice(largeBefore).includes('size 40 100'), 'a new claude attach on both')
  large.stream.write('input', encoder.encode('still here\r'))
  await until(() => small.seen.shown.includes('typed still here'), 'typing into the new one')

  // a viewer that leaves counts no more, and the one left gets the whole of its own size
  small.client.send({ t: 'detach', stream: small.id })
  await until(() => large.seen.shown.includes('size 40 120'), 'the larger viewer\'s size')

  // a stopped program leaves no claude attach of its own behind
  expect(attachesOn(host)).not.toBe('')
  served.child.kill('SIGTERM')
  await served.child.exited
  await until(() => attachesOn(host) === '', 'no claude attach left')
})

test('anyhost attach on another machine and on the host share the host\'s one claude attach, at the smaller size', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, true)
  const viewer = await machineFor(relay, VIEWER, false)
  // the host holds the session, as its program's first upload of it claims it
  const holder = relay.connect(HOST, roots(host.env['HOME'] ?? ''))
  expect(await holder.runOne({ op: 'claim', session: SESSION, take: false })).toEqual({ status: 200, told: true, at: expect.any(String) })
  holder.close()
  await Promise.all([serveOn(host.env), serveOn(viewer.env)])
  await until(() => relay.isConnected(HOST.id) && relay.isConnected(VIEWER.id), 'both machines connecting')

  let shown = ''
  const terminal = new Bun.Terminal({ cols: 90, rows: 28, data: (_terminal, bytes) => void (shown += decoder.decode(bytes)) })
  // the 8 characters of the id `anyhost attach` takes, as Claude Code shows them
  const attach = Bun.spawn(['bun', CLI, 'attach', SESSION.slice(0, 8)], { env: viewer.env, terminal })
  children.push(attach)
  await until(() => shown.includes('size 28 90'), 'the session on the viewer\'s terminal')
  terminal.write('hello there\r')
  await until(() => shown.includes('typed hello there'), 'the typed line')
  terminal.resize(70, 20)
  attach.kill('SIGWINCH')
  await until(() => shown.includes('size 20 70'), 'the new size')
  expect(shown).toContain('typed hello there')

  // on the host itself, anyhost attach is one more viewer of the same claude attach, through the host's program
  let shownHere = ''
  const here = new Bun.Terminal({ cols: 60, rows: 18, data: (_terminal, bytes) => void (shownHere += decoder.decode(bytes)) })
  const attachHere = Bun.spawn(['bun', CLI, 'attach', SESSION], { env: host.env, terminal: here })
  children.push(attachHere)
  await until(() => shownHere.includes('size 18 60') && shown.includes('size 18 60'), 'the size both draw whole')
  here.write('typed on the host\r')
  await until(() => shown.includes('typed typed on the host'), 'the host\'s line on the other machine')
  terminal.close()
  here.close()
})

test('a viewer hears each change of a session\'s status from its record alone, with no claude agents run', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, true)
  const home = host.env['HOME'] ?? ''
  await serveOn(host.env)
  await until(() => relay.isConnected(HOST.id), 'the host connecting')
  const viewer = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await until(() => viewer.seen.states.includes('busy'), 'the session\'s status')
  // Claude Code rewrites the record at a permission prompt, and again as the turn ends
  recordSession(home, process.pid, 'waiting')
  await until(() => viewer.seen.states.includes('waiting'), 'the permission prompt')
  recordSession(home, process.pid, 'idle')
  await until(() => viewer.seen.states.includes('idle'), 'the turn\'s end')
  expect(viewer.seen.states).toEqual(['unknown', 'busy', 'waiting', 'idle'])
  // the session's record names the background job `claude attach` opens, so the start runs none either
  expect(logOf(host.folder, 'claude.log').filter((line) => line.startsWith('agents'))).toEqual([])
})

// The suite missed it: every test that showed a session had a watcher that heard each change, while macOS's watcher
// drops the rename of a record with no word of it, which left the pane's herdr state as it was until the next one.
test("a shown session's turn that ends while the watcher drops every change turns its herdr pane idle within 2 s", async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, true)
  const holder = relay.connect(HOST, roots(host.env['HOME'] ?? ''))
  expect(await holder.runOne({ op: 'claim', session: SESSION, take: false })).toMatchObject({ status: 200, told: true })
  holder.close()
  script(join(host.folder, 'bin', 'herdr'), `#!/bin/bash\necho "$*" >> '${host.folder}/herdr.log'\n`)
  await serveOn({ ...host.env, ANYHOST_WATCHER_DROPS: '1' })
  await until(() => relay.isConnected(HOST.id), 'the host connecting')
  // each state anyhost attach reported for its pane, in order
  const states = (): string[] => logOf(host.folder, 'herdr.log').map((line) => /--state (\S+)/.exec(line)?.[1] ?? '')
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_terminal, bytes) => void (shown += decoder.decode(bytes)) })
  closers.push(() => terminal.close())
  const attach = Bun.spawn(['bun', CLI, 'attach', SESSION], { env: { ...host.env, HERDR_PANE_ID: 'w1:p1' }, terminal })
  children.push(attach)
  await until(() => shown.includes('size 24 80'), 'the session on the terminal')
  await until(() => states().includes('working'), 'the turn in herdr')
  // past the program's start, whose listing and first reads of the records went before
  await Bun.sleep(3000)
  recordSession(host.env['HOME'] ?? '', process.pid, 'idle')
  const endedAt = Date.now()
  await until(() => states().includes('idle'), "the turn's end in herdr", 10_000)
  expect(Date.now() - endedAt).toBeLessThan(2000)
}, 60_000)

test('a session whose record stays gone 10 s through other changes of the records ends its claude attach after one record check, and its viewer once with the reason', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, true)
  const served = await serveOn(host.env)
  await until(() => relay.isConnected(HOST.id), 'the host connecting')
  const viewer = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await until(() => viewer.seen.shown.includes('size 24 80'), 'the viewer\'s screen')
  await until(() => viewer.seen.states.includes('busy'), 'the session\'s status')
  // the session stops, and Claude Code removes its record, then writes the records of other sessions
  const sessions = join(host.env['HOME'] ?? '', '.claude', 'sessions')
  const stopped = Date.now()
  rmSync(join(sessions, `${process.pid}.json`))
  for (let change = 1; change <= 5; change += 1) {
    await Bun.sleep(500)
    writeFileSync(join(sessions, 'other.json'), String(change))
  }
  await until(() => viewer.seen.exits.length > 0, 'the viewer\'s end', 20_000)
  // as Claude Code respawns a session within 10 s
  expect(Date.now() - stopped).toBeGreaterThanOrEqual(10_000)
  // past the 10 s a check started at the last change would follow the records
  await Bun.sleep(3000)
  expect(viewer.seen.exits).toEqual([`The session ${SESSION} stopped running on ${HOST.name}.`])
  expect(served.logged().split('\n').filter((line) => line.includes(`Claude Code's record of ${SESSION} is gone`))).toHaveLength(1)
  await until(() => attachesOn(host) === '', 'no claude attach left')
}, 40_000)

test('a claude attach SIGKILL ended while its session runs starts again, and its viewer gets no exit', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, true)
  await serveOn(host.env)
  await until(() => relay.isConnected(HOST.id), 'the host connecting')
  const viewer = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await until(() => viewer.seen.shown.includes('size 24 80'), 'the viewer\'s screen')
  const killed = attachesOn(host)
  const before = viewer.seen.shown.length
  // as the OOM killer or a kill -9 ends it, while Claude Code's record of the session stays
  Bun.spawnSync(['pkill', '-KILL', '-f', `${host.env['CLAUDE_CODE_EXECPATH']} attach`])
  await until(() => viewer.seen.shown.slice(before).includes('size 24 80'), 'a new claude attach on the viewer\'s screen')
  expect(attachesOn(host)).not.toBe('')
  expect(attachesOn(host)).not.toBe(killed)
  viewer.stream.write('input', encoder.encode('after the kill\r'))
  await until(() => viewer.seen.shown.includes('typed after the kill'), 'typing into the new one')
  expect(viewer.seen.exits).toEqual([])
})

// The lines the session's `claude attach` took, in order, each as often as it took it.
const typedIn = (shown: string): string[] => [...shown.matchAll(/typed (\S+)/g)].map(([, line]) => line ?? '')

// The suite missed it: no test typed while the host started its claude attach again, and a write to the closed
// terminal of the attach that ended threw, which ended the host's program. Its attaches drew at once, so no test saw
// keys reach a terminal before the attach in it was up, which a cooked terminal takes Enter in as a newline.
test("keys typed while the host's claude attach starts again after a SIGKILL reach the new attach once each, in order, after its first frame", async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, true)
  const served = await serveOn(host.env)
  await until(() => relay.isConnected(HOST.id), 'the host connecting')
  const viewer = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await until(() => viewer.seen.shown.includes('size 24 80'), 'the viewer\'s screen')
  const before = viewer.seen.shown.length
  // the next attach draws its first frame half a second after it starts
  writeFileSync(join(host.folder, 'draws-after'), '0.5')
  Bun.spawnSync(['pkill', '-KILL', '-f', `${host.env['CLAUDE_CODE_EXECPATH']} attach`])
  await until(() => attachesOn(host) === '', 'the attach ending')
  // the host follows the session's record for 3 s after a signal ended its attach, then starts the attach again
  viewer.stream.write('input', encoder.encode('one\r'))
  viewer.stream.write('input', encoder.encode('two\r'))
  await until(() => viewer.seen.shown.slice(before).includes('size 24 80'), 'a new claude attach on the viewer\'s screen')
  await until(() => typedIn(viewer.seen.shown).length >= 2, 'both lines')
  // a key the host typed twice would show by now
  await Bun.sleep(1000)
  expect(typedIn(viewer.seen.shown)).toEqual(['one', 'two'])
  // the cooked terminal echoes each key as it takes it, which comes after the new attach's frame, Enter included
  const fresh = viewer.seen.shown.slice(before)
  expect(fresh.indexOf('one\r\n')).toBeGreaterThan(fresh.indexOf('size 24 80'))
  expect(served.child.exitCode).toBeNull()
  expect(viewer.seen.exits).toEqual([])
})

// The suite missed it: each viewer test sent one attach per stream, and the host's start never waited, as the test
// Claude Code's record named its job and `claude agents` answered at once.
test("a viewer whose attach goes again while the host's start takes 3 s, as anyhost attach sends it after a detach, shows the session, and its keys reach it once each", async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, true)
  // a job a reboot stopped, which no record names, so the host's start asks claude agents, which answers after 3 s
  rmSync(join(host.env['HOME'] ?? '', '.claude', 'sessions', `${process.pid}.json`))
  writeFileSync(join(host.folder, 'slow'), '3')
  await serveOn(host.env)
  await until(() => relay.isConnected(HOST.id), 'the host connecting')
  const viewer = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await Bun.sleep(1000)
  viewer.attach()
  viewer.stream.write('input', encoder.encode('one\r'))
  await until(() => viewer.seen.shown.includes('size 24 80'), 'the session on the viewer\'s screen', 20_000)
  viewer.stream.write('input', encoder.encode('two\r'))
  await until(() => typedIn(viewer.seen.shown).length >= 2, 'both lines')
  // a key the host typed twice would show by now
  await Bun.sleep(1000)
  expect(typedIn(viewer.seen.shown)).toEqual(['one', 'two'])
  // the first attach opened the host's end of the stream, and the second found the same one
  const [first, second, ...more] = viewer.seen.attached.map((message) => (message as { hostStream: number }).hostStream)
  expect({ first: typeof first, second, more }).toEqual({ first: 'number', second: first, more: [] })
  expect(viewer.seen.exits).toEqual([])
}, 40_000)

// The suite missed it: no test took Claude Code's daemon lock away while a viewer watched, and only a change in
// `sessions/` made the host read the records again.
test('a session whose records change while a Claude Code update leaves no daemon lock for 2 s keeps its claude attach and its viewer once the lock is back', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, true)
  await serveOn(host.env)
  await until(() => relay.isConnected(HOST.id), 'the host connecting')
  const viewer = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await until(() => viewer.seen.shown.includes('size 24 80'), 'the viewer\'s screen')
  await until(() => viewer.seen.states.includes('busy'), 'the session\'s status')
  // the old daemon removes its lock as it ends, the session's turn ends in the gap, and the new daemon locks 2 s later
  const lock = join(host.env['CLAUDE_CONFIG_DIR'] ?? '', 'daemon.lock')
  rmSync(lock)
  recordSession(host.env['HOME'] ?? '', process.pid, 'idle')
  await Bun.sleep(2000)
  writeFileSync(lock, DAEMON_LOCK)
  // past the 10 s a record check started in the gap follows the records
  await Bun.sleep(13_000)
  expect(viewer.seen.exits).toEqual([])
  viewer.stream.write('input', encoder.encode('after the update\r'))
  await until(() => viewer.seen.shown.includes('typed after the update'), 'typing into the same attach')
}, 60_000)

// HOST, whose Claude Code runs SESSION and which holds it, and VIEWER, each with its program, and `anyhost attach` of
// the session in an 80×24 terminal on VIEWER, once it shows the session. With `isRelayOnly`, HOST's `direct.json` names
// a port its listener refuses, so it offers no direct connection and the stream goes through the relay alone, as from
// a VPS with no Tailscale.
async function attachedFrom(relay: MemoryRelay, { isRelayOnly = false } = {}) {
  const host = await machineFor(relay, HOST, true)
  const viewer = await machineFor(relay, VIEWER, false)
  if (isRelayOnly) writeFileSync(join(host.env['XDG_STATE_HOME'] ?? '', 'anyhost', 'direct.json'), JSON.stringify({ port: 0 }))
  const holder = relay.connect(HOST, roots(host.env['HOME'] ?? ''))
  expect(await holder.runOne({ op: 'claim', session: SESSION, take: false })).toEqual({ status: 200, told: true, at: expect.any(String) })
  holder.close()
  const [served] = await Promise.all([serveOn(host.env), serveOn(viewer.env)])
  await until(() => relay.isConnected(HOST.id) && relay.isConnected(VIEWER.id), 'both machines connecting')
  const screen = { shown: '' }
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_terminal, bytes) => void (screen.shown += decoder.decode(bytes)) })
  closers.push(() => terminal.close())
  const attach = Bun.spawn(['bun', CLI, 'attach', SESSION.slice(0, 8)], { env: viewer.env, terminal })
  children.push(attach)
  await until(() => screen.shown.includes('size 24 80'), 'the session on the viewer\'s terminal')
  return { host, viewer, served, screen, terminal, attach }
}

// The suite missed it: its restart test linked the restarted host before its viewer, where in production the viewer
// links at the host's `attached`, before the host's first frame, so the new host took the viewer's old frames.
test("keys typed before, during and after the host's program restarts reach the session once each, in order, and a line typed within 1 s of the restart once", async () => {
  const relay = await memoryRelay()
  const { host, served, screen, terminal } = await attachedFrom(relay)
  // the host acknowledges a key a second after it took it, and its program ends before that
  terminal.write('yes\r')
  await until(() => typedIn(screen.shown).includes('yes'), 'the line on the first attach')
  served.child.kill('SIGTERM')
  await served.child.exited
  // anyhost attach hears that its links went, from the relay and from the end of its direct connection
  await Bun.sleep(1000)
  terminal.write('during\r')
  const before = screen.shown.length
  await serveOn(host.env)
  await until(() => screen.shown.slice(before).includes('size 24 80'), 'the new attach on the viewer\'s terminal', 40_000)
  terminal.write('after\r')
  await until(() => typedIn(screen.shown).includes('after'), 'the line after')
  // a key the host typed twice would show by now
  await Bun.sleep(1000)
  expect(typedIn(screen.shown)).toEqual(['yes', 'during', 'after'])
}, 90_000)

// The suite missed it: every `attached` of the restarted host reached its viewer, so no viewer met a host that knew its
// stream while it still followed the stream of the host's program before.
test("keys typed before, during and after the host's program restarts reach the session once each, though the viewer's socket broke as the new program's first attached came", async () => {
  const relay = await memoryRelay()
  const { host, served, screen, terminal } = await attachedFrom(relay)
  terminal.write('yes\r')
  await until(() => typedIn(screen.shown).includes('yes'), 'the line on the first attach')
  // the line is acknowledged, so it goes to no host again
  await Bun.sleep(1500)
  served.child.kill('SIGTERM')
  await served.child.exited
  await Bun.sleep(1000)
  terminal.write('during\r')
  const before = screen.shown.length
  const lost = relay.loseNext(VIEWER.id, 'attached')
  await serveOn(host.env)
  await lost
  // the viewer's machine connects again, and anyhost attach attaches again, which the new program answers
  await until(() => screen.shown.slice(before).includes('size 24 80'), 'the new attach on the viewer\'s terminal', 40_000)
  terminal.write('after\r')
  await until(() => typedIn(screen.shown).includes('after'), 'the line after')
  // a key the host typed twice would show by now
  await Bun.sleep(1000)
  expect(typedIn(screen.shown)).toEqual(['yes', 'during', 'after'])
}, 90_000)

// The suite missed it: no viewer test left a viewer's links gone past the LINGER_MS its host keeps its stream.
test('keys typed before, during and after the host forgot a viewer whose links were gone 60 s, as a laptop that slept, reach the session once each, in order', async () => {
  const relay = await memoryRelay()
  const { host, screen, terminal, attach } = await attachedFrom(relay)
  terminal.write('earlier\r')
  await until(() => typedIn(screen.shown).includes('earlier'), 'the line on the first attach')
  // the host acknowledged it
  await Bun.sleep(1500)
  // as a laptop that sleeps: anyhost attach stops, and its machine loses the relay for a while
  process.kill(attach.pid, 'SIGSTOP')
  try {
    const reconnect = relay.disconnect(VIEWER.id)
    await Bun.sleep(2000)
    reconnect()
    await until(() => relay.isConnected(VIEWER.id), 'the viewer\'s machine connecting again', 70_000)
    // the host forgets the viewer 60 s after its last link went, and closes the attach only that viewer viewed
    await until(() => attachesOn(host) === '', 'the host forgetting the viewer', 90_000)
  } finally {
    process.kill(attach.pid, 'SIGCONT')
  }
  const before = screen.shown.length
  // anyhost attach hears that its links went, and attaches again a second later
  await Bun.sleep(500)
  terminal.write('during\r')
  await until(() => screen.shown.slice(before).includes('size 24 80'), 'the new attach on the viewer\'s terminal', 40_000)
  terminal.write('after\r')
  await until(() => typedIn(screen.shown).includes('after'), 'the line after')
  await Bun.sleep(1000)
  expect(typedIn(screen.shown)).toEqual(['earlier', 'during', 'after'])
}, 200_000)

// The suite missed it: every host whose relay socket went in a test closed it, which the Pool hears at once and tells
// the viewers of, while a host that slept leaves a half-open socket the Pool still lists, and a viewer through the
// relay alone has no direct connection to go on over.
test("a viewer through the relay alone whose host slept and woke shows the session and takes its keys again within 5 s", async () => {
  const relay = await memoryRelay()
  const { served, screen, terminal } = await attachedFrom(relay, { isRelayOnly: true })
  terminal.write('before\r')
  await until(() => typedIn(screen.shown).includes('before'), 'the line before the sleep')
  const wake = relay.silence(HOST.id)
  await Bun.sleep(2000)
  wake()
  const wokeAt = Date.now()
  terminal.write('after\r')

  await until(() => typedIn(screen.shown).includes('after'), 'the line typed after the host woke', 5000)
  expect(Date.now() - wokeAt).toBeLessThan(5000)
  // a key typed twice would show by now
  await Bun.sleep(1000)
  expect(typedIn(screen.shown)).toEqual(['before', 'after'])
  expect(served.logged()).not.toContain('directly at')
}, 60_000)

// The suite missed it: no test typed while the viewer's own relay was down, where its program dropped each frame while
// the viewer counted it carried, so a host program that restarted meanwhile never got those keys.
test("keys typed while the viewer's machine has no relay reach the session once each after the host's program restarted meanwhile", async () => {
  const relay = await memoryRelay()
  const { host, viewer, served, screen, terminal } = await attachedFrom(relay, { isRelayOnly: true })
  terminal.write('yes\r')
  await until(() => typedIn(screen.shown).includes('yes'), 'the line on the first attach')
  // the host acknowledged it, so it goes to no host again
  await Bun.sleep(1500)
  const reconnect = relay.disconnect(VIEWER.id)
  await until(async () => (await statusOn(viewer.socket)).relay.state !== 'connected', "the viewer's program reading its relay down")
  terminal.write('during\r')
  // anyhost attach hears from its program that the relay refused the line
  await Bun.sleep(1000)
  served.child.kill('SIGTERM')
  await served.child.exited
  const before = screen.shown.length
  await serveOn(host.env)
  reconnect()
  await until(() => screen.shown.slice(before).includes('size 24 80'), 'the new attach on the viewer\'s terminal', 60_000)
  terminal.write('after\r')
  await until(() => typedIn(screen.shown).includes('after'), 'the line after')
  // a key the host typed twice would show by now
  await Bun.sleep(1000)
  expect(typedIn(screen.shown)).toEqual(['yes', 'during', 'after'])
}, 120_000)

// The suite missed it: no test kept a viewer's path away past a few seconds, while anyhost attach counted every
// `detach` and `offline` as a failed try, so the welcome's `detach`, which says to attach again now, waited out a step
// of a climb to a minute.
test("a viewer through the relay alone whose machine's relay is down 20 s while keys are typed shows them within 2 s of its relay's welcome", async () => {
  const relay = await memoryRelay()
  const { viewer, screen, terminal } = await attachedFrom(relay, { isRelayOnly: true })
  terminal.write('before\r')
  await until(() => typedIn(screen.shown).includes('before'), 'the line before the outage')
  const reconnect = relay.disconnect(VIEWER.id)
  await until(async () => (await statusOn(viewer.socket)).relay.state !== 'connected', "the viewer's program reading its relay down")
  for (const line of ['one', 'two', 'three', 'four']) {
    terminal.write(`${line}\r`)
    await Bun.sleep(5000)
  }
  reconnect()
  await until(() => relay.isConnected(VIEWER.id), "the viewer's relay welcoming it again", 60_000)
  const welcomedAt = Date.now()
  await until(() => typedIn(screen.shown).includes('four'), 'the lines typed during the outage', 10_000)
  expect(Date.now() - welcomedAt).toBeLessThan(2000)
  // a key the host typed twice would show by now
  await Bun.sleep(1000)
  expect(typedIn(screen.shown)).toEqual(['before', 'one', 'two', 'three', 'four'])
}, 120_000)

// The suite missed it: its sleep test woke the host within the LIVE_MS the Pool counts a silent socket live for, so no
// viewer's frame met a host gone, whose `detach` and the `offline` of each attach after it climbed the viewer's waits.
test("a viewer through the relay alone whose host slept 55 s while keys were typed shows them within 2 s of the host's welcome", async () => {
  const relay = await memoryRelay()
  const { screen, terminal } = await attachedFrom(relay, { isRelayOnly: true })
  terminal.write('before\r')
  await until(() => typedIn(screen.shown).includes('before'), 'the line before the sleep')
  const wake = relay.silence(HOST.id)
  // the Pool counts the host's socket live up to LIVE_MS, 45 s, after it last heard it, so the lines typed 47 and 51 s
  // into the 55 s sleep meet no host
  for (const [line, wait] of [['one', 25_000], ['two', 22_000], ['three', 4000], ['four', 4000]] as const) {
    terminal.write(`${line}\r`)
    await Bun.sleep(wait)
  }
  // the host's program sends `detach` for each viewer the relay reached as its welcome comes, and no other machine
  // sends one meanwhile
  const welcome = relay.holdNext('detach')
  wake()
  const release = await welcome
  const welcomedAt = Date.now()
  release()
  await until(() => typedIn(screen.shown).includes('four'), 'the lines typed during the sleep', 10_000)
  expect(Date.now() - welcomedAt).toBeLessThan(2000)
  // a key the host typed twice would show by now
  await Bun.sleep(1000)
  expect(typedIn(screen.shown)).toEqual(['before', 'one', 'two', 'three', 'four'])
}, 150_000)

// The suite missed it: the program answered each frame the relay refused with an `offline` of its own, at the offset of
// an acknowledgement too, which counts the host's bytes, so anyhost attach counted keys the old host took as never
// carried and sent them to a new host again, and climbed one wait per frame.
test("frames the relay refuses get one offline until the leg's next attach, at the offset from which the relay took none of the viewer's bytes", async () => {
  const relay = await memoryRelay()
  const viewer = await machineFor(relay, VIEWER, false)
  await serveOn(viewer.env)
  await until(() => relay.isConnected(VIEWER.id), 'the viewer connecting')
  // the leg anyhost attach opens, and every `offline` its program sends it
  const offlines: unknown[] = []
  const leg = closing(new WebSocket(`ws+unix://${viewer.socket}:/attach`))
  leg.addEventListener('message', ({ data }) => {
    const message = typeof data === 'string' ? (JSON.parse(data) as { readonly t: string }) : undefined
    if (message?.t === 'offline') offlines.push(message)
  })
  await new Promise((opened) => leg.addEventListener('open', opened, { once: true }))
  const id = Math.floor(Math.random() * 2 ** 32)
  const attach = (): void => leg.send(JSON.stringify({ t: 'attach', stream: id, session: SESSION, cols: 80, rows: 24, key: randomKey() }))
  const offline = { t: 'offline', stream: id, to: '' }
  const stream = opens()
  const link = { send: (frame: Uint8Array): void => leg.send(frame) }
  // No machine holds the session, which the program answers `invalid`, and it carries the leg's frames all the same: a
  // stream's first frame on a link acknowledges what it holds, and the relay takes the keys after it.
  attach()
  stream.use(link)
  stream.write('input', encoder.encode('a'))
  stream.write('input', encoder.encode('b'))
  await Bun.sleep(500)
  relay.disconnect(VIEWER.id)
  await until(async () => (await statusOn(viewer.socket)).relay.state !== 'connected', "the viewer's program reading its relay down")
  // The stream links again, as after its direct connection ended: the relay refuses its acknowledgement, which names
  // the end of the keys the relay took, and then the keys again, and one typed after them.
  stream.use(link)
  stream.write('input', encoder.encode('c'))
  // an offline for each frame would have come by now
  await Bun.sleep(1000)
  expect(offlines).toEqual([{ ...offline, at: 2 }])
  // the next attach starts over, and an acknowledgement refused before the relay took any key names no offset
  attach()
  await until(() => offlines.length === 2, 'the attach answered')
  stream.use(link)
  await Bun.sleep(1000)
  expect(offlines).toEqual([{ ...offline, at: 2 }, offline, offline])
  // after the next attach, keys typed in a burst, refused frame by frame, get one offline at the first one's offset
  attach()
  await until(() => offlines.length === 4, 'the attach answered again')
  for (const key of ['d', 'e', 'f']) stream.write('input', encoder.encode(key))
  await Bun.sleep(1000)
  expect(offlines).toEqual([{ ...offline, at: 2 }, offline, offline, offline, { ...offline, at: 3 }])
})

test('a claude attach a signal ended once its session\'s process is gone ends its viewer with the reason', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, true)
  const home = host.env['HOME'] ?? ''
  // the session runs as a process of its own
  const session = Bun.spawn(['sleep', '600'])
  children.push(session)
  rmSync(join(home, '.claude', 'sessions', `${process.pid}.json`))
  recordSession(home, session.pid)
  await serveOn(host.env)
  await until(() => relay.isConnected(HOST.id), 'the host connecting')
  const viewer = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await until(() => viewer.seen.shown.includes('size 24 80'), 'the viewer\'s screen')
  // as when systemd stops the session's scope: the session's process ends, and its attach by a signal, while its
  // record is still there
  session.kill('SIGKILL')
  await session.exited
  const signalled = Date.now()
  Bun.spawnSync(['pkill', '-TERM', '-f', `${host.env['CLAUDE_CODE_EXECPATH']} attach`])
  await until(() => viewer.seen.exits.length > 0, 'the viewer\'s end')
  expect(viewer.seen.exits).toEqual([`The session ${SESSION} stopped running on ${HOST.name}.`])
  // at its first read of the records, not after the 3 s a running session's record is followed
  expect(Date.now() - signalled).toBeLessThan(3000)
  expect(attachesOn(host)).toBe('')
})

test('a claude attach that ended by itself while Claude Code respawns its session starts again once the session\'s record is back, and its viewer gets no exit', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, true)
  const home = host.env['HOME'] ?? ''
  await serveOn(host.env)
  await until(() => relay.isConnected(HOST.id), 'the host connecting')
  const viewer = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await until(() => viewer.seen.shown.includes('size 24 80'), 'the viewer\'s screen')
  const before = viewer.seen.shown.length
  // the session's process ends, so its record goes, and its attach ends with it
  rmSync(join(home, '.claude', 'sessions', `${process.pid}.json`))
  viewer.stream.write('input', encoder.encode('leave\r'))
  await until(() => attachesOn(host) === '', 'the attach ending')
  // Claude Code's respawn of the session writes its record again
  await Bun.sleep(1000)
  recordSession(home, process.pid)
  await until(() => viewer.seen.shown.slice(before).includes('size 24 80'), 'a new claude attach on the viewer\'s screen')
  viewer.stream.write('input', encoder.encode('after the respawn\r'))
  await until(() => viewer.seen.shown.includes('typed after the respawn'), 'typing into the new one')
  expect(viewer.seen.exits).toEqual([])
}, 30_000)

// The suite missed it: every respawn test's watcher heard the record come back, while macOS's watcher drops events
// with no word of it, and the wait for the record read it again only at a change the watcher heard.
test("a claude attach that ended by itself while Claude Code respawns its session starts again once the record is back, though the watcher drops every change, and its viewer gets no exit", async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, true)
  const home = host.env['HOME'] ?? ''
  await serveOn({ ...host.env, ANYHOST_WATCHER_DROPS: '1' })
  await until(() => relay.isConnected(HOST.id), 'the host connecting')
  const viewer = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await until(() => viewer.seen.shown.includes('size 24 80'), 'the viewer\'s screen')
  const before = viewer.seen.shown.length
  rmSync(join(home, '.claude', 'sessions', `${process.pid}.json`))
  viewer.stream.write('input', encoder.encode('leave\r'))
  await until(() => attachesOn(host) === '', 'the attach ending')
  await Bun.sleep(1000)
  recordSession(home, process.pid)

  // within the 10 s Claude Code takes to respawn a session, past which the host ends its viewers
  await until(() => viewer.seen.shown.slice(before).includes('size 24 80'), 'a new claude attach on the viewer\'s screen', 9000)
  viewer.stream.write('input', encoder.encode('after the respawn\r'))
  await until(() => viewer.seen.shown.includes('typed after the respawn'), 'typing into the new one')
  expect(viewer.seen.exits).toEqual([])
}, 30_000)

test('a session whose record goes while Claude Code respawns it keeps its claude attach and its viewer once its record is back', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, true)
  const home = host.env['HOME'] ?? ''
  await serveOn(host.env)
  await until(() => relay.isConnected(HOST.id), 'the host connecting')
  const viewer = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await until(() => viewer.seen.shown.includes('size 24 80'), 'the viewer\'s screen')
  await until(() => viewer.seen.states.includes('busy'), 'the session\'s status')
  const attach = attachesOn(host)
  // the session's process crashed, so its record goes
  rmSync(join(home, '.claude', 'sessions', `${process.pid}.json`))
  await Bun.sleep(1000)
  // the respawned process writes its record
  recordSession(home, process.pid)
  // past the 10 s a gone record is followed
  await Bun.sleep(11_000)
  expect(viewer.seen.exits).toEqual([])
  expect(attachesOn(host)).toBe(attach)
  viewer.stream.write('input', encoder.encode('after the respawn\r'))
  await until(() => viewer.seen.shown.includes('typed after the respawn'), 'typing into the same attach')
}, 30_000)

test('a claude attach a signal ended once Claude Code\'s daemon went ends its viewer with the reason, though the session\'s record is still there', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, true)
  const home = host.env['HOME'] ?? ''
  await serveOn(host.env)
  await until(() => relay.isConnected(HOST.id), 'the host connecting')
  const viewer = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await until(() => viewer.seen.shown.includes('size 24 80'), 'the viewer\'s screen')
  // as when systemd stops anyhost-claude.slice: the daemon removes its lock as it ends, and its attaches end by a signal,
  // while the session's process still ends, so its record is still there
  rmSync(join(home, '.claude', 'daemon.lock'))
  const signalled = Date.now()
  Bun.spawnSync(['pkill', '-TERM', '-f', `${host.env['CLAUDE_CODE_EXECPATH']} attach`])
  await until(() => viewer.seen.exits.length > 0, 'the viewer\'s end')
  expect(viewer.seen.exits).toEqual([`The session ${SESSION} stopped running on ${HOST.name}.`])
  // at its first read of the records, not after the 3 s a running session's record is followed
  expect(Date.now() - signalled).toBeLessThan(3000)
  expect(existsSync(join(home, '.claude', 'sessions', `${process.pid}.json`))).toBe(true)
  expect(attachesOn(host)).toBe('')
})

test('the program\'s own stop ends its viewers\' streams and starts no claude attach', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, true)
  const served = await serveOn(host.env)
  await until(() => relay.isConnected(HOST.id), 'the host connecting')
  const viewer = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await until(() => viewer.seen.shown.includes('size 24 80'), 'the viewer\'s screen')
  const detached: number[] = []
  viewer.client.on('detach', ({ stream }) => void detached.push(stream))
  expect(attachesOn(host)).not.toBe('')
  // the session still runs, so only the stop keeps its closed attach from starting again
  served.child.kill('SIGTERM')
  await served.child.exited
  expect(served.child.signalCode).toBe('SIGTERM')
  await until(() => detached.includes(viewer.id), 'the viewer\'s stream ending')
  await until(() => attachesOn(host) === '', 'no claude attach left')
  expect(viewer.seen.exits).toEqual([])
})

test('anyhost attach on the host shows a session its Claude Code runs while the relay is down', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, true)
  await relay.stop()
  await serveOn(host.env)
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 72, rows: 22, data: (_terminal, bytes) => void (shown += decoder.decode(bytes)) })
  const attach = Bun.spawn(['bun', CLI, 'attach', SESSION.slice(0, 8)], { env: host.env, terminal })
  children.push(attach)
  await until(() => shown.includes('size 22 72'), 'the session on the host\'s terminal')
  terminal.write('no relay\r')
  await until(() => shown.includes('typed no relay'), 'the typed line')
  // the session stops once the host read its record, 200 ms after it started showing it: anyhost attach says why,
  // gives the terminal back as it was, and ends
  await Bun.sleep(1000)
  rmSync(join(host.env['HOME'] ?? '', '.claude', 'sessions', `${process.pid}.json`))
  expect(await attach.exited).toBe(0)
  await until(() => shown.includes('\x1b[?1049l\x1b[?25h') && shown.includes(`The session ${SESSION} stopped running on ${HOST.name}.`), 'the reset and the reason')
  terminal.close()
}, 30_000)

test('a second serve on one state folder refuses to start, naming the one that runs, a POST of no JSON answers 400, and one to no route 404', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, true)
  await serveOn(host.env)
  const second = Bun.spawn(['bun', CLI, 'serve'], { env: host.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(second)
  expect(await second.exited).toBe(1)
  expect(await new Response(second.stderr).text()).toContain(`The anyhost program of ${HOST.name} already answers at ${host.socket}, so this one does not start.`)
  // the first one still answers
  const answer = await fetch('http://localhost/machines/invite', { unix: host.socket, method: 'POST', body: 'not json' })
  expect(answer.status).toBe(400)
  expect(((await answer.json()) as { message: string }).message).toStartWith('anyhost takes a JSON object at POST /machines/invite, and this body is none:')
  // an unknown route answers JSON as every other refusal does, naming every route the program serves
  const unknown = await fetch('http://localhost/machines/rename', { unix: host.socket, method: 'POST', body: '{}' })
  expect(unknown.status).toBe(404)
  expect(await unknown.json()).toEqual({
    message: 'anyhost serves GET /status, /machines and /claims/<session>, POST /connect, /connect/account, /connect/r2, /join, /machines/invite, /machines/remove, /move, /move/keep and /new, and a WebSocket at /attach, not POST /machines/rename.',
  })
})

test("the program's start stats every captured file, and uploads a line a quiet session gained while the program did not run", async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, false)
  const home = host.env['HOME'] ?? ''
  const transcript = join(home, '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  const line = (text: string): string => `{"type":"user","message":{"role":"user","content":"${text}"},"sessionId":"${SESSION}"}\n`
  writeFileSync(transcript, line('Plan the trip'))
  // an earlier run of the program captured the session an hour ago, and left no heartbeat to catch up from
  const db = openDatabase(join(host.env['XDG_STATE_HOME'] ?? '', 'anyhost'))
  const capture = openCapture(relay.connect(HOST, roots(home)), HOST, roots(home), { db, code: noCode })
  await welcomed(capture.relay)
  setSystemTime(new Date(Date.now() - 60 * 60_000))
  await Promise.all(uploadSessions(capture, [{ session: SESSION, tool: 'claude', paths: new Set([transcript]) }], failTest).map(([, left]) => left))
  setSystemTime()
  const end = journalOf(db, SESSION)?.end ?? 0
  capture.relay.close()
  db.close()
  appendFileSync(transcript, line('Book the train'))

  await serveOn(host.env)
  await until(() => relay.puts.some(({ key }) => key === hotKey(SESSION, end)), 'the line uploaded')
  const frame = relay.puts.find(({ key }) => key === hotKey(SESSION, end))?.body ?? new Uint8Array()
  expect(decoder.decode(decompress(frame))).toEndWith(line('Book the train'))
  // the queue drains every 5 seconds
}, 20_000)

const OTHER_SESSION = '22222222-3333-4444-5555-666666666666'
// Whether a frame R2 holds of the session's journal carries `text`.
const isUploaded = (relay: MemoryRelay, session: string, text: string): boolean =>
  relay.puts.some(({ key, body }) => key.startsWith(`journals/${session}/hot/`) && decoder.decode(decompress(body)).includes(text))
const problemsOn = async (socket: string): Promise<readonly string[]> => (await statusOn(socket)).problems
// The heartbeat of a run of the program an hour ago, which the program's start hears every file written since.
const ranAnHourAgo = (machine: { readonly env: Record<string, string> }): void => {
  const heartbeat = join(machine.env['XDG_STATE_HOME'] ?? '', 'anyhost', 'heartbeat')
  writeFileSync(heartbeat, '')
  const hourAgo = new Date(Date.now() - 60 * 60_000)
  utimesSync(heartbeat, hourAgo, hourAgo)
}

// The suite missed it: no test made a watch hang, as only macOS's fseventsd hangs one, for minutes at a time.
test("a program whose watcher hangs at its start names the stall in /status, backs up a captured session's line and a new session within one backup pass, and ends at SIGTERM within 5 s", async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, false)
  const transcriptOf = (session: string): string => join(host.env['HOME'] ?? '', '.claude', 'projects', '-work', `${session}.jsonl`)
  const line = (session: string, text: string): string => `{"type":"user","message":{"role":"user","content":"${text}"},"sessionId":"${session}"}\n`
  ranAnHourAgo(host)
  mkdirSync(dirname(transcriptOf(SESSION)), { recursive: true })
  writeFileSync(transcriptOf(SESSION), line(SESSION, 'Plan the trip'))

  const served = await serveOn({ ...host.env, ANYHOST_WATCHER_HANGS: '1' })
  await until(async () => (await problemsOn(host.socket)).some((problem) => problem.includes(" watcher: Error: anyhost's watcher heard none of its watches 10 s after its start, as while macOS's fseventsd takes no new watcher")), 'the stall in /status', 30_000)
  await until(() => isUploaded(relay, SESSION, 'Plan the trip'), 'the session the start captured uploaded', 30_000)
  appendFileSync(transcriptOf(SESSION), line(SESSION, 'Book the train'))
  writeFileSync(transcriptOf(OTHER_SESSION), line(OTHER_SESSION, 'Pack the bags'))
  // the next backup pass starts 60 s after the one before
  await until(() => isUploaded(relay, SESSION, 'Book the train') && isUploaded(relay, OTHER_SESSION, 'Pack the bags'), 'the line and the new session uploaded', 75_000)

  const watchersOf = (pid: number): number[] => Bun.spawnSync(['pgrep', '-P', String(pid), '-f', 'ANYHOST_WATCHER_HANGS']).stdout.toString().split('\n').filter((found) => found !== '').map(Number)
  await until(() => watchersOf(served.child.pid).length > 0, 'a hung watcher')
  const [watcher = 0] = watchersOf(served.child.pid)
  const signalled = Date.now()
  served.child.kill('SIGTERM')
  await served.child.exited
  expect(Date.now() - signalled).toBeLessThan(5000)
  expect(served.child.signalCode).toBe('SIGTERM')
  await until(() => !isAlive(watcher), 'the hung watcher ending with the program', 5000)
}, 150_000)

test('a watcher that exits is a problem in /status until the one started after it is ready, which hears a new session', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, false)
  const transcript = join(host.env['HOME'] ?? '', '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  // each watcher writes its pid to `watcher` in the state folder until it hears that write
  const probe = join(host.env['XDG_STATE_HOME'] ?? '', 'anyhost', 'watcher')
  const watcherPid = (): number => (existsSync(probe) ? Number(readFileSync(probe, 'utf8')) || 0 : 0)
  const served = await serveOn(host.env)
  await until(() => watcherPid() > 0, 'the watcher')
  const first = watcherPid()
  expect(Bun.spawnSync(['pgrep', '-P', String(served.child.pid)]).stdout.toString().split('\n')).toContain(String(first))

  process.kill(first, 'SIGKILL')
  await until(async () => (await problemsOn(host.socket)).some((problem) => problem.includes(" watcher: Error: anyhost's watcher exited with SIGKILL, so each backup pass lists the watched folders")), 'the exit in /status')
  await until(async () => !(await problemsOn(host.socket)).some((problem) => problem.includes(' watcher: ')), 'the problem leaving')
  expect(watcherPid()).not.toBe(first)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
  // heard by the new watcher, as the backup pass after the start's lists it no sooner than 60 s after the start
  await until(() => isUploaded(relay, SESSION, 'Plan the trip'), 'the new session uploaded', 30_000)
}, 60_000)

const isWatcherProblem = (problem: string): boolean => problem.includes(' watcher: ')

// The suite missed it: no test removed a watched folder while the program ran. Bun's watch on Linux names the removal
// of a folder it watches with every level with no name, which the watcher could not join and died at, and hears
// nothing of a folder made again where it watched.
test('a watched folder removed and made again while the program runs is watched again: a file written in the new one uploads within one backup pass, and /status names no watcher problem', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, false)
  // Claude Code's temp root, whose folder above it no watch hears
  const tempRoot = join(realpathSync(host.env['CLAUDE_CODE_TMPDIR'] ?? ''), `claude-${process.getuid?.() ?? 0}`)
  mkdirSync(tempRoot, { recursive: true })
  await serveOn(host.env)
  // a session the watcher heard, so it is ready
  const transcript = join(host.env['HOME'] ?? '', '.claude', 'projects', '-work', `${OTHER_SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${OTHER_SESSION}"}\n`)
  await until(() => isUploaded(relay, OTHER_SESSION, 'Plan the trip'), 'the session the watcher heard uploaded', 30_000)

  rmSync(tempRoot, { recursive: true })
  await Bun.sleep(1000)
  const output = join(tempRoot, '-work', SESSION, 'tasks', 'trip.output')
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, 'Booked the train\n')
  const watcherProblems = new Set<string>()
  // the next backup pass starts 60 s after the one before
  await until(
    async () => {
      for (const problem of (await problemsOn(host.socket)).filter(isWatcherProblem)) watcherProblems.add(problem)
      return isUploaded(relay, SESSION, 'Booked the train')
    },
    'the output in the new folder uploaded',
    75_000,
  )
  expect([...watcherProblems]).toEqual([])
}, 120_000)

// The suite missed it: every folder a test's watcher watched was there to watch, while Bun's watch() throws at a
// folder gone since the program found it, which ended each watcher at its start.
test('a watched folder the watcher cannot watch at its start, as one removed after the program found it, costs only that folder, and the watcher gets ready and hears a new session', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, false)
  // a folder its user may not list, which Bun's watch() on Linux throws at with EACCES, as it throws ENOENT at a folder
  // gone by then
  const plans = join(host.env['HOME'] ?? '', '.claude', 'plans')
  mkdirSync(plans)
  chmodSync(plans, 0)
  try {
    await serveOn(host.env)
    // past the listing of the program's start
    await Bun.sleep(3000)
    const transcript = join(host.env['HOME'] ?? '', '.claude', 'projects', '-work', `${SESSION}.jsonl`)
    mkdirSync(dirname(transcript), { recursive: true })
    writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
    // heard by the watcher, as the backup pass after the start's lists it no sooner than 60 s after the start
    await until(() => isUploaded(relay, SESSION, 'Plan the trip'), 'the new session uploaded', 30_000)
    expect((await problemsOn(host.socket)).filter(isWatcherProblem)).toEqual([])
  } finally {
    chmodSync(plans, 0o755)
  }
}, 60_000)

// The suite missed it: a folder the watcher could not watch still counted as one it heard, so no backup pass listed it,
// and a file written there waited for the hourly sweep.
test('a watched folder the watcher lost at its start is listed by the next backup pass, which uploads a session written there', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, false)
  const sessionEnv = join(host.env['HOME'] ?? '', '.claude', 'session-env')
  mkdirSync(sessionEnv)
  // Bun's watch() on Linux throws EACCES at a folder its user may not list
  chmodSync(sessionEnv, 0)
  try {
    const served = await serveOn(host.env)
    await until(() => served.logged().includes(`anyhost hears no change in a folder under ${sessionEnv}`), 'the watch failing')
    // past the program's first backup pass, its full sweep, and the listing as the watcher got ready
    await Bun.sleep(3000)
  } finally {
    chmodSync(sessionEnv, 0o755)
  }
  const hook = join(sessionEnv, SESSION, 'sessionstart-hook-0.sh')
  mkdirSync(dirname(hook))
  writeFileSync(hook, 'export TRIP=train\n')
  // the next backup pass starts 60 s after the one before
  await until(() => isUploaded(relay, SESSION, 'export TRIP=train'), 'the file in the lost folder uploaded', 75_000)
}, 120_000)

// The suite missed it: every watcher a test ran heard each write, while macOS's watcher drops events with no word of
// it, and a full sweep statted only the files the program captured, so no sweep found a file no event named.
test('a file written in a watched folder while the watcher hears nothing is uploaded by the next full sweep', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, false)
  // The program's first backup pass, its first full sweep, comes after it read the options, which wait for the test.
  const cmod = join(host.env['XDG_DATA_HOME'] ?? '', 'cmod', 'programs', 'cmod')
  const release = join(host.folder, 'release')
  writeFileSync(cmod, readFileSync(cmod, 'utf8').replace('"options anyhost")', `"options anyhost") while [ ! -e '${release}' ]; do sleep 0.1; done;`))
  ranAnHourAgo(host)
  await serveOn({ ...host.env, ANYHOST_WATCHER_DROPS: '1' })
  // past the watcher getting ready and the listing that follows it
  await Bun.sleep(3000)
  expect((await problemsOn(host.socket)).filter(isWatcherProblem)).toEqual([])
  const transcript = join(host.env['HOME'] ?? '', '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
  // a watcher that heard it would have queued it by now
  await Bun.sleep(1000)
  writeFileSync(release, '')
  await until(() => isUploaded(relay, SESSION, 'Plan the trip'), 'the session the full sweep found uploaded', 30_000)
}, 60_000)

test('a listing of the watched folders and of a session\'s files follows no symlink, so a cycle leaves the other files listed, and the log names a folder it cannot read once', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST, false)
  const home = host.env['HOME'] ?? ''
  // Claude Code's temp root, where a background task of the session wrote its output while the program did not run,
  // beside a scratchpad that holds a symlink cycle and a folder only its owner may list
  const sessionFolder = join(realpathSync(host.env['CLAUDE_CODE_TMPDIR'] ?? ''), `claude-${process.getuid?.() ?? 0}`, '-work', SESSION)
  mkdirSync(join(sessionFolder, 'tasks'), { recursive: true })
  mkdirSync(join(sessionFolder, 'scratchpad'), { recursive: true })
  symlinkSync('loop', join(sessionFolder, 'scratchpad', 'loop'))
  const locked = join(sessionFolder, 'locked')
  mkdirSync(locked)
  chmodSync(locked, 0)
  // A subagent's transcript of the session, older than the heartbeat, so only the first capture of the session, which
  // reads every file of it from byte 0, finds it, beside another symlink cycle
  const subagents = join(home, '.claude', 'projects', '-work', SESSION, 'subagents')
  mkdirSync(subagents, { recursive: true })
  symlinkSync('loop', join(subagents, 'loop'))
  const subagent = join(subagents, 'agent-a1.jsonl')
  writeFileSync(subagent, `{"type":"user","message":{"role":"user","content":"Find the trains"},"sessionId":"${SESSION}"}\n`)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000)
  utimesSync(subagent, twoHoursAgo, twoHoursAgo)
  mkdirSync(join(home, '.codex'), { recursive: true })
  ranAnHourAgo(host)
  writeFileSync(join(sessionFolder, 'tasks', 'trip.output'), 'Booked the train\n')
  try {
    const served = await serveOn(host.env)
    await until(() => isUploaded(relay, SESSION, 'Booked the train'), 'the output the start listed uploaded', 30_000)
    await until(() => isUploaded(relay, SESSION, 'Find the trains'), "the subagent's transcript the session's first capture found uploaded", 30_000)
    // Codex makes `sessions/` while the program runs, so a new watcher starts, and the listing as it gets ready reads
    // every watched folder again, the temp root before Codex's sessions
    const rollout = join(home, '.codex', 'sessions', '2026', '11', '07', `rollout-2026-11-07T09-00-00-${OTHER_SESSION}.jsonl`)
    mkdirSync(dirname(rollout), { recursive: true })
    writeFileSync(rollout, `{"type":"session_meta","payload":{"id":"${OTHER_SESSION}","cwd":"/work"}}\n`)
    await until(() => isUploaded(relay, OTHER_SESSION, 'session_meta'), 'the rollout in the new folder uploaded', 30_000)

    expect(served.logged().split('\n').filter((logged) => logged.includes(`anyhost lists no file in ${locked}: EACCES`))).toHaveLength(1)
  } finally {
    chmodSync(locked, 0o755)
  }
}, 60_000)

test("a program whose relay Cloudflare refuses for the daily limit names the limit and its reset at 00:00 UTC in /status", async () => {
  const relay = await memoryRelay()
  relay.dailyLimited = Infinity
  const host = await machineFor(relay, HOST, false)
  await serveOn(host.env)
  await until(async () => (await statusOn(host.socket)).relay.state === 'offline', 'the refused connect')

  expect((await statusOn(host.socket)).relay).toMatchObject({ state: 'offline', message: DAILY_LIMIT })
})

const LAPTOP: Device = { id: 'device-laptop', name: 'anyhost-b', os: 'linux', arch: 'arm64' }
const WORKER: Device = { id: 'device-worker', name: 'anyhost-a', os: 'linux', arch: 'arm64' }
// the id the Claude Code of a test machine gives the session `claude --bg` starts new
const NEW_SESSION = 'abcdef12-0000-4000-8000-000000000001'

// A Claude Code that runs sessions in its background: `claude agents --json` lists what `agents.json` in the machine's
// folder holds, and with `--all` what `kept.json` holds, the background jobs it keeps, when there is one. `claude --bg`
// fails with the text of `fail` when there is one, and else starts the session `--resume` names, or a new one, which it
// lists running from then on, with its record in `sessions/`, as Claude Code writes one for each session it runs.
// `claude attach` starts a kept job again, and shows the terminal's size and each line typed. Every call goes into
// `claude.log`: the time, the folder it ran in, and its arguments. A session it runs has the pid of the program that asked for it, which runs as
// long as the test. `claude agents` answers after the seconds `slow` holds, when there is one, `claude --bg` waits the
// seconds `hang` holds, and `claude stop` fails with the text of `fail-stop`. `claude --bg --resume` appends the text of
// `appends` to the session's transcript, as Claude Code re-appends a resumed session's metadata there, and a session
// `claude --bg` starts while `unlisted` is there is listed running only once that file goes.
const backgroundClaude = (folder: string): string => `#!/bin/bash
F='${folder}'
echo "$(date +%s%N) $PWD $*" >> "$F/claude.log"
running() {
  printf '[{"pid":%s,"id":"%s","sessionId":"%s","kind":"background","cwd":"%s","status":"idle","state":"blocked"}]' $PPID "\${1:0:8}" "$1" "$PWD" > "$F/agents.json"
  printf '{"pid":%s,"sessionId":"%s","jobId":"%s","kind":"bg","cwd":"%s","status":"idle"}' $PPID "$1" "\${1:0:8}" "$PWD" > "$CLAUDE_CONFIG_DIR/sessions/$PPID.json"
}
case "$1" in
  agents)
    if [ -e "$F/slow" ]; then sleep "$(cat "$F/slow")"; fi
    if [ "$3" = --all ] && [ -e "$F/kept.json" ]; then cat "$F/kept.json"; elif [ -e "$F/agents.json" ]; then cat "$F/agents.json"; else printf '[]'; fi ;;
  --bg)
    if [ -e "$F/hang" ]; then sleep "$(cat "$F/hang")"; fi
    if [ -e "$F/fail" ]; then cat "$F/fail" >&2; exit 1; fi
    session="\${3:-${NEW_SESSION}}"
    if [ -n "$3" ] && [ -e "$F/appends" ]; then cat "$F/appends" >> "$(find "$CLAUDE_CONFIG_DIR/projects" -name "$session.jsonl" | head -n 1)"; fi
    if [ -e "$F/unlisted" ]; then (while [ -e "$F/unlisted" ]; do sleep 0.1; done; running "$session") > /dev/null 2>&1 &
    else running "$session"; fi
    echo "backgrounded · \${session:0:8} · test (idle — send a prompt to start)" ;;
  attach)
    if [ -e "$F/kept.json" ]; then rm "$F/kept.json"; running '${SESSION}'; fi
    printf '\\033[?1049h'
    echo "size $(stty size)"
    while IFS= read -r line; do echo "typed $line"; done ;;
  stop)
    if [ -e "$F/fail-stop" ]; then cat "$F/fail-stop" >&2; exit 1; fi
    rm -f "$F/agents.json" "$CLAUDE_CONFIG_DIR"/sessions/*.json; echo "stopped $2" ;;
  *) exit 2 ;;
esac
`
const logOf = (folder: string, name: string): string[] => readFileSync(join(folder, name), { encoding: 'utf8', flag: 'a+' }).split('\n').filter((line) => line !== '')

type Moved = { readonly to: string; readonly step: string; readonly line: string }
type Claimed = { readonly machine?: string; readonly move?: Moved }
const claimOn = async (socket: string, session = SESSION): Promise<Claimed> => (await (await fetch(`http://localhost/claims/${session}`, { unix: socket })).json()) as Claimed
const postTo = async (socket: string, path: string, body: object): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> => {
  const answer = await fetch(`http://localhost${path}`, { unix: socket, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> }
}
// Each step the laptop's program showed of the session's move, in order, after the steps the test read already, until
// it reached `until`.
async function stepsOf(socket: string, until: ReadonlySet<string> = new Set(['moved', 'failed']), read: readonly string[] = []): Promise<{ readonly steps: string[]; readonly last: Moved }> {
  const steps = [...read]
  for (const started = Date.now(); Date.now() - started < 30_000; await Bun.sleep(10)) {
    const { move } = await claimOn(socket)
    if (move === undefined) continue
    if (steps.at(-1) !== move.step) steps.push(move.step)
    if (until.has(move.step)) return { steps, last: move }
  }
  throw new Error(`The move showed ${steps.join(', ')} and reached none of ${[...until].join(', ')} within 30 s.`)
}

// The machine SESSION runs on, in a terminal of its own in a herdr pane, or in Claude Code's background, as `kind`
// says, its Claude Code's process `claude`, and its program, `child`, captured it, with the options `person` sets, and
// what the program logged so far. The session works in `work` in the machine's home, which holds one file.
async function runningOn(relay: MemoryRelay, device = LAPTOP, kind: 'interactive' | 'background' = 'interactive', person: Record<string, unknown> = {}) {
  const laptop = await machineFor(relay, device, false, backgroundClaude, person)
  const home = laptop.env['HOME'] ?? ''
  script(
    join(laptop.folder, 'bin', 'herdr'),
    `#!/bin/bash
echo "$(date +%s%N) $*" >> '${laptop.folder}/herdr.log'
[ "$1 $2" = 'agent list' ] && printf '%s' '{"id":"cli:agent:list","result":{"agents":[{"agent":"claude","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"${SESSION}"},"pane_id":"w1:p1"}],"type":"agent_list"}}'
exit 0
`,
  )
  const cwd = join(home, 'work')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'notes.txt'), 'the plan for the trip\n')
  const { child, logged } = await serveOn(laptop.env)
  await until(() => relay.isConnected(device.id), 'the machine connecting')
  const transcript = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","cwd":"${cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"Plan the trip"}}\n`)
  const claude = Bun.spawn(['sleep', '600'])
  children.push(claude)
  const status = (value: string): void => {
    const id = kind === 'background' ? { id: SESSION.slice(0, 8) } : {}
    writeFileSync(join(laptop.folder, 'agents.json'), JSON.stringify([{ pid: claude.pid, ...id, sessionId: SESSION, kind, cwd, status: value }]))
    // Claude Code rewrites the session's record at each change of its status
    const job = kind === 'background' ? { jobId: SESSION.slice(0, 8), kind: 'bg' } : { kind: 'interactive' }
    writeFileSync(join(home, '.claude', 'sessions', `${claude.pid}.json`), JSON.stringify({ pid: claude.pid, sessionId: SESSION, ...job, cwd, status: value }))
  }
  status('idle')
  // the first drain at the default 5 seconds claims the session
  await until(async () => (await relay.claims()).get(SESSION) === device.id, 'the machine claiming the session', 15_000)
  return { ...laptop, cwd, transcript, claude, status, child, logged }
}

async function workerOn(relay: MemoryRelay, prepare: (folder: string) => void = () => undefined, device = WORKER) {
  const worker = await machineFor(relay, device, false, backgroundClaude)
  prepare(worker.folder)
  const served = await serveOn(worker.env)
  await until(() => relay.isConnected(device.id), 'the machine connecting')
  return { ...worker, ...served }
}

test('a move waits for the turn to end, uploads and seals the session, the worker restores and runs it, and only then the laptop\'s Claude Code ends and its herdr pane shows the session there', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  laptop.status('busy')

  const asked = await postTo(laptop.socket, '/move', { session: SESSION.slice(0, 8), machine: WORKER.name })
  expect(asked.status).toBe(200)
  expect(asked.body).toMatchObject({ session: SESSION, to: WORKER.name })
  // the turn runs on, and the move waits for it
  await Bun.sleep(500)
  const waiting = (await claimOn(laptop.socket)).move
  expect(waiting).toEqual({ to: WORKER.name, step: 'waiting', line: `Waiting for ${SESSION.slice(0, 8)} to finish its turn.` })
  laptop.status('idle')
  // the steps from the one read while the turn ran, as the program may have gone past it before the next read
  const { steps, last } = await stepsOf(laptop.socket, undefined, [waiting?.step ?? ''])

  expect(steps).toEqual(['waiting', 'uploading', 'moving', 'moved'])
  expect(last.line).toMatch(new RegExp(`^${WORKER.name} restored ${SESSION.slice(0, 8)} in \\d+\\.\\d s and runs it\\.$`))
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  expect((await relay.keys(`journals/${SESSION}/`)).every((key) => key.includes('/sealed/'))).toBe(true)
  // the worker continues the session in its own home, with its transcript and its working folder's file
  const workerHome = worker.env['HOME'] ?? ''
  const workerCwd = join(workerHome, 'work')
  expect(readFileSync(join(workerCwd, 'notes.txt'), 'utf8')).toBe('the plan for the trip\n')
  expect(readFileSync(join(workerHome, '.claude', 'projects', workerCwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`), 'utf8')).toContain(`"cwd":"${workerCwd}"`)
  const started = logOf(worker.folder, 'claude.log').find((line) => line.endsWith(`--bg --resume ${SESSION}`))
  expect(started?.split(' ')[1]).toBe(realpathSync(workerCwd))
  // the laptop's Claude Code ended after the worker ran the session, and the pane attaches to it there
  await laptop.claude.exited
  expect(laptop.claude.signalCode).toBe('SIGTERM')
  await until(() => logOf(laptop.folder, 'herdr.log').some((line) => line.includes('pane run')), 'the pane run')
  const run = logOf(laptop.folder, 'herdr.log').find((line) => line.includes('pane run')) ?? ''
  expect(run.slice(run.indexOf(' ') + 1)).toBe(`pane run w1:p1 anyhost attach ${SESSION.slice(0, 8)}`)
  expect(Number(run.split(' ')[0])).toBeGreaterThan(Number(started?.split(' ')[0]))
  expect(await claimOn(laptop.socket)).toMatchObject({ machine: WORKER.name, move: { step: 'moved' } })
}, 60_000)

test('a move of a session whose first frame R2 lost uploads its files whole again, and the worker restores every byte', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"Book the train"}}\n`, { flag: 'a' })
  await until(() => relay.puts.some(({ key, body }) => key.includes('/hot/') && decoder.decode(decompress(body)).includes('Book the train')), 'the second line uploading', 15_000)
  await relay.objects.delete(hotKey(SESSION, 0))
  const worker = await workerOn(relay)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  expect(await relay.keys(`journals/${SESSION}/hot/`)).toEqual([])
  const workerHome = worker.env['HOME'] ?? ''
  const workerCwd = join(workerHome, 'work')
  const restored = readFileSync(join(workerHome, '.claude', 'projects', workerCwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`), 'utf8')
  expect(restored).toBe(readFileSync(laptop.transcript, 'utf8').replaceAll(laptop.env['HOME'] ?? '', workerHome))
  expect(readFileSync(join(workerCwd, 'notes.txt'), 'utf8')).toBe('the plan for the trip\n')
}, 60_000)

test('a move to a machine that is offline keeps the session running here, with its claim', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await relay.join(WORKER, roots('/home/worker'))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.line).toBe(`${WORKER.name} is offline, so the session keeps running here.`)
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
}, 60_000)

// The suite missed it: every worker a move or start test took offline stayed down, while a program that restarts
// within the 10 s between two checks of its connection reads as connected at both, and its wait for the move died
// with it.
test('a move to a worker whose program restarts before its Claude Code ran the session runs again there at the laptop\'s next repeat, and reaches moved', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  // its first Claude Code starts the session past the end of the test
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'hang'), '60'))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  // The first Claude Code sleeps out the hang it read, so the one the restarted program runs starts at once. Its log
  // line comes a moment before it reads the hang, so the hang goes only once it sleeps.
  const isHanging = (): boolean => {
    const [first = ''] = Bun.spawnSync(['pgrep', '-f', `${worker.env['CLAUDE_CODE_EXECPATH']} --bg --resume`]).stdout.toString().trim().split('\n')
    return first !== '' && Bun.spawnSync(['pgrep', '-P', first, '-x', 'sleep']).exitCode === 0
  }
  await until(isHanging, 'the worker\'s first Claude Code hanging', 30_000)
  worker.child.kill('SIGKILL')
  rmSync(join(worker.folder, 'hang'))
  const killedAt = Date.now()
  await serveOn(worker.env)
  await until(() => relay.isConnected(WORKER.id), 'the worker connecting again')
  const { last } = await stepsOf(laptop.socket)

  // the checks 10 s apart, the worker's restart, and its run of the move
  expect(Date.now() - killedAt).toBeLessThan(40_000)
  expect(last.step).toBe('moved')
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  expect(logOf(worker.folder, 'claude.log').filter((line) => line.endsWith(`--bg --resume ${SESSION}`))).toHaveLength(2)
  await laptop.claude.exited
  expect(laptop.claude.signalCode).toBe('SIGTERM')
}, 90_000)

// The suite missed it: every worker that heard `released` for a session was the program that started its job, while a
// program that restarted since knew nothing of the job its earlier run started.
test("a worker program restarted after it ran claude --bg --resume for a move stops that job at the session's released, once its turn ends", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  // its Claude Code starts the session past the end of the test
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'hang'), '60'))
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await until(() => logOf(worker.folder, 'claude.log').some((line) => line.endsWith(`--bg --resume ${SESSION}`)), 'the worker starting the session', 30_000)
  worker.child.kill('SIGKILL')
  // Claude Code's daemon runs the job the earlier program started, in a turn
  const job = Bun.spawn(['sleep', '600'])
  children.push(job)
  const workerHome = worker.env['HOME'] ?? ''
  const record = (status: string): void =>
    writeFileSync(join(workerHome, '.claude', 'sessions', `${job.pid}.json`), JSON.stringify({ pid: job.pid, sessionId: SESSION, jobId: SESSION.slice(0, 8), kind: 'bg', cwd: join(workerHome, 'work'), status }))
  record('busy')
  const stops = (): string[] => logOf(worker.folder, 'claude.log').filter((line) => line.endsWith(`stop ${SESSION.slice(0, 8)}`))

  // the move waits for the worker, which holds the session, and Keep it here takes the session back while it is down
  await until(async () => (await claimOn(laptop.socket)).move?.line.includes(' does not answer. ') === true, 'the move saying the worker does not answer', 30_000)
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)
  await serveOn(worker.env)
  await until(() => relay.isConnected(WORKER.id), 'the worker connecting again')
  await until(async () => (await claimOn(worker.socket)).machine === LAPTOP.name, 'the worker hearing it lost the session')
  await Bun.sleep(1000)
  const stopsInTurn = stops()
  record('idle')
  await until(() => stops().length > 0, 'the worker stopping the job once its turn ended')

  expect(last.line).toBe(`${WORKER.name} did not answer, so the session keeps running here.`)
  expect(stopsInTurn).toEqual([])
  expect(stops()).toHaveLength(1)
}, 90_000)

// The suite missed it: every worker program that restarted during a move had run no job of the session, and the
// laptop's ask ended at the restart, so no repeat of a move reached a program that forgot it while the session ran there.
test("a worker whose program restarts after it ran claude --bg --resume for a move, before the laptop heard moved, answers the laptop's repeat with moved and never stops or restores the job", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  // the worker's moved never leaves the worker's socket
  const held = relay.holdNext('moved')
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await held
  worker.child.kill('SIGKILL')
  await worker.child.exited
  // Claude Code's daemon runs on the job the earlier program started, past that program's end
  const job = Bun.spawn(['sleep', '600'])
  children.push(job)
  const workerHome = worker.env['HOME'] ?? ''
  writeFileSync(join(workerHome, '.claude', 'sessions', `${job.pid}.json`), JSON.stringify({ pid: job.pid, sessionId: SESSION, jobId: SESSION.slice(0, 8), kind: 'bg', cwd: join(workerHome, 'work'), status: 'idle' }))
  const restarted = await serveOn(worker.env)
  const { last } = await stepsOf(laptop.socket)
  await laptop.claude.exited
  // a stop of the job would come at once, as its record says idle
  await Bun.sleep(2000)

  expect(last.step).toBe('moved')
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  expect(restarted.logged()).toContain(`${LAPTOP.name} asked again for its move of ${SESSION}`)
  expect(restarted.logged()).not.toContain(`moves ${SESSION} here.`)
  const calls = logOf(worker.folder, 'claude.log').map((line) => line.split(' ').slice(2).join(' '))
  expect(calls.filter((call) => call === `--bg --resume ${SESSION}`)).toHaveLength(1)
  expect(calls.filter((call) => call.startsWith('stop'))).toEqual([])
  expect(isAlive(job.pid)).toBe(true)
}, 90_000)

test('a move the worker cannot take takes the claim back, and the laptop captures the session again', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'fail'), 'Claude Code is not logged in.'))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.line).toStartWith(`${WORKER.name} could not take the session: `)
  expect(last.line).toContain('Claude Code is not logged in.')
  expect(last.line).toEndWith('. It keeps running here.')
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  await until(async () => (await claimOn(worker.socket)).machine === LAPTOP.name, 'the worker hearing it lost the session')
  expect(laptop.claude.exitCode).toBeNull()
  // the session's next line goes up from the laptop
  const frames = relay.puts.filter(({ key }) => key.startsWith(`journals/${SESSION}/hot/`)).length
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`, { flag: 'a' })
  await until(() => relay.puts.filter(({ key }) => key.startsWith(`journals/${SESSION}/hot/`)).length > frames, 'the next line uploading', 15_000)
}, 60_000)

test('a move to a worker that took the claim and answers nothing waits for it, and Keep it here takes the session back', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const silent = relay.connect(WORKER, roots('/home/worker'))
  // the claim's answer may still be on its way when the test cuts the worker off, so its failure is the test's to drop
  silent.on('move', ({ session }) => {
    for (const ran of silent.run([{ op: 'claim', session, take: true }])) ran.catch(() => undefined)
  })
  await welcomed(silent)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await stepsOf(laptop.socket, new Set(['moving']))
  await until(async () => (await relay.claims()).get(SESSION) === WORKER.id, 'the worker taking the claim')
  await until(async () => (await claimOn(laptop.socket)).machine === WORKER.name, 'the laptop hearing it')
  expect((await claimOn(laptop.socket)).move?.step).toBe('moving')
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `${WORKER.name} did not answer, so the session keeps running here.` })
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
}, 60_000)

// The suite missed it: every worker that took the claim and answered nothing stayed connected, so no move met an
// `offline` from a machine that may run the session already.
test('a move to a worker that took the claim and then goes offline waits, saying so in its line and in anyhost move, which Ctrl-C leaves running, and Keep it here takes the session back', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const silent = relay.connect(WORKER, roots('/home/worker'))
  // the claim's answer may still be on its way when the test cuts the worker off, so its failure is the test's to drop
  silent.on('move', ({ session }) => {
    for (const ran of silent.run([{ op: 'claim', session, take: true }])) ran.catch(() => undefined)
  })
  await welcomed(silent)
  const waiting = `${WORKER.name} took ${SESSION.slice(0, 8)} and does not answer. Keep it here takes the session back.`

  const moving = Bun.spawn(['bun', CLI, 'move', SESSION.slice(0, 8), WORKER.name], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(moving)
  let printed = ''
  const reading = (async () => {
    for await (const chunk of moving.stdout) printed += decoder.decode(chunk)
  })()
  await until(async () => (await relay.claims()).get(SESSION) === WORKER.id, 'the worker taking the claim', 30_000)
  relay.disconnect(WORKER.id)
  await until(async () => (await claimOn(laptop.socket)).move?.line === waiting, 'the move saying the worker does not answer', 30_000)
  // the move goes on waiting through the next checks of the worker's connection
  await Bun.sleep(12_000)
  expect((await claimOn(laptop.socket)).move).toEqual({ to: WORKER.name, step: 'moving', line: waiting })
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  await until(() => printed.includes(`${waiting}\n`), 'anyhost move printing the line')
  moving.kill('SIGINT')
  const [code] = await Promise.all([moving.exited, reading])
  expect(code).toBe(130)
  expect(printed.trimEnd().split('\n').at(-1)).toBe(`The move of ${SESSION.slice(0, 8)} to ${WORKER.name} goes on. Keep it here in the session takes the session back.`)
  expect((await claimOn(laptop.socket)).move?.step).toBe('moving')
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `${WORKER.name} did not answer, so the session keeps running here.` })
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
}, 90_000)

// The suite missed it: every worker of a move that failed after it took the claim wrote nothing to the session, so no
// frame of the worker's ever waited at the laptop's end, where the laptop's next frame met it as a fork.
test("Keep it here after a moved the laptop never heard, from a worker that ran the session and wrote to it, leaves the laptop taking the next prompt and capturing it with no fork, and stops the worker's job", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  // the worker's resume re-appends the session's metadata, and its Claude Code lists the session running once the
  // worker uploaded that
  const worker = await workerOn(relay, (folder) => {
    writeFileSync(join(folder, 'appends'), `{"type":"permission-mode","permissionMode":"default","sessionId":"${SESSION}"}\n`)
    writeFileSync(join(folder, 'unlisted'), '')
  })
  const held = relay.holdNext('moved')

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await until(() => isUploaded(relay, SESSION, '"permission-mode"'), 'the worker uploading what its resume wrote', 30_000)
  rmSync(join(worker.folder, 'unlisted'))
  // the worker runs the session and answers, and the relay holds the answer
  const release = await held
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)
  await until(() => logOf(worker.folder, 'claude.log').some((line) => line.endsWith(`stop ${SESSION.slice(0, 8)}`)), "the worker stopping its job as the laptop took the session back")
  release()

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `${WORKER.name} did not answer, so the session keeps running here.` })
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  // the laptop's next prompt goes up from the laptop, past what the worker wrote
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`, { flag: 'a' })
  await until(() => isUploaded(relay, SESSION, 'And the hotel'), 'the next prompt uploading', 15_000)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.logged()).not.toContain('Another machine wrote byte')
  expect(laptop.claude.exitCode).toBeNull()
}, 90_000)

// The suite missed it: every Keep it here a test pressed came once the worker held the claim or was gone, so no take
// the laptop gave up on reached the Pool after the laptop took the session back, where it took the session anyway.
test("Keep it here before the worker's take lands keeps the session with the laptop once that take comes, starts no job on the worker, and the laptop takes the next prompt", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  // the laptop's move, and every message the laptop sends after it, wait at the relay's front, so the worker's take
  // comes only after the laptop took the session back
  const held = relay.holdNext('move')

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const release = await held
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  release()
  const { last } = await stepsOf(laptop.socket)
  await until(() => worker.logged().includes(`could not take ${SESSION} from ${LAPTOP.name}`), 'the worker refusing the move', 30_000)

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `${WORKER.name} did not answer, so the session keeps running here.` })
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect(logOf(worker.folder, 'claude.log').filter((line) => line.includes(' --bg '))).toEqual([])
  // the laptop's next prompt goes through and up from the laptop
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`, { flag: 'a' })
  await until(() => isUploaded(relay, SESSION, 'And the hotel'), 'the next prompt uploading', 15_000)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
}, 60_000)

test('Keep it here while the move waits for the turn to end keeps the session here, with its claim', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await relay.join(WORKER, roots('/home/worker'))
  laptop.status('busy')

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await stepsOf(laptop.socket, new Set(['waiting']))
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `Kept ${SESSION.slice(0, 8)} here, so it does not move to ${WORKER.name}.` })
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
  // the move is over, so there is nothing more to keep
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(400)
}, 60_000)

// The suite missed it: every move test's watcher heard the record of the turn's end, while macOS's watcher drops
// events with no word of it, and the move's wait read the records again only at a change the watcher heard.
test('a move waiting for the turn to end goes on to uploading once the record says idle, though the watcher drops every change', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await relay.join(WORKER, roots('/home/worker'))
  // the laptop's program starts again with a watcher that drops every change it hears, as macOS's drops events
  laptop.child.kill('SIGTERM')
  await laptop.child.exited
  await serveOn({ ...laptop.env, ANYHOST_WATCHER_DROPS: '1' })
  await until(async () => (await statusOn(laptop.socket)).relay.state === 'connected', 'the laptop connecting again')
  // past the watcher getting ready, before which the program reads the records every second anyway
  await Bun.sleep(3000)
  laptop.status('busy')
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await stepsOf(laptop.socket, new Set(['waiting']))

  laptop.status('idle')
  const idleAt = Date.now()
  const { steps } = await stepsOf(laptop.socket, new Set(['uploading', 'failed']), ['waiting'])
  expect(steps).toEqual(['waiting', 'uploading'])
  expect(Date.now() - idleAt).toBeLessThan(5000)
}, 60_000)

// The session's transcript gains a line every 50 ms, as a session's background command or agent writes after its turn
// ended, until the function it answers is called.
const keepsWriting = (laptop: { readonly cwd: string; readonly transcript: string }): { readonly written: () => number; readonly stop: () => void } => {
  let lines = 0
  const writing = setInterval(() => appendFileSync(laptop.transcript, `{"type":"progress","cwd":"${laptop.cwd}","sessionId":"${SESSION}","line":${++lines}}\n`), 50)
  return { written: () => lines, stop: () => clearInterval(writing) }
}

// The suite missed it: every session a move test moved stopped writing once its turn ended, so no drain of a move met a
// write made during the drain before it.
test('a move of a session that gains a line every 50 ms after its turn ended reaches moved within 20 s, and the worker restores every line up to its last drain', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  const writer = keepsWriting(laptop)
  await Bun.sleep(500)
  const before = writer.written()

  const asked = Date.now()
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)
  const took = Date.now() - asked
  writer.stop()

  expect(last.step).toBe('moved')
  expect(took).toBeLessThan(20_000)
  const workerHome = worker.env['HOME'] ?? ''
  const workerCwd = join(workerHome, 'work')
  const restored = readFileSync(join(workerHome, '.claude', 'projects', workerCwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`), 'utf8').split('\n').filter((line) => line !== '')
  const written = readFileSync(laptop.transcript, 'utf8').replaceAll(laptop.env['HOME'] ?? '', workerHome).split('\n').filter((line) => line !== '')
  // the first line, every line written before the move, and the lines after it in order up to the move's last drain
  expect(restored.length).toBeGreaterThan(before)
  expect(restored).toEqual(written.slice(0, restored.length))
}, 60_000)

// The suite missed it: no program test ran at uploadEvery 0, where a drain that carried a line carried no code, so a
// session that kept writing never backed up its code, and its move waited for that code without end.
test('at uploadEvery 0 a move of a session that gains a line every 50 ms while its code waits reaches moved within 20 s, and the worker restores its code', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay, LAPTOP, 'interactive', { uploadEvery: 0 })
  const worker = await workerOn(relay)
  // 512 KiB of code that does not compress, which goes up as 4 pieces of 128 KiB, in drains that take longer than the
  // 50 ms between lines, so every drain finds a new line
  const code = crypto.getRandomValues(new Uint8Array(2 ** 19))
  writeFileSync(join(laptop.cwd, 'map.bin'), code)
  relay.delayMs = 100
  const writer = keepsWriting(laptop)
  await Bun.sleep(500)

  const asked = Date.now()
  const before = relay.requests.length
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  // the seal, which lists the journal once the move's drains are done, and the restore read it at the relay's own pace
  await until(() => relay.requests.slice(before).some((ops) => ops.some((op) => op.op === 'list' && op.prefix === `journals/${SESSION}/`)), 'the seal listing the journal', 20_000)
  relay.delayMs = 0
  const { last } = await stepsOf(laptop.socket)
  const took = Date.now() - asked
  writer.stop()

  expect(last.step).toBe('moved')
  expect(took).toBeLessThan(20_000)
  expect(Buffer.from(readFileSync(join(worker.env['HOME'] ?? '', 'work', 'map.bin'))).equals(Buffer.from(code))).toBe(true)
}, 60_000)

// The suite missed it: Keep it here ended only the move's wait, and no test counted the puts after it.
test("Keep it here while a session that keeps writing uploads ends the move's drains, so the session's puts come at the program's uploadEvery from then on", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await relay.join(WORKER, roots('/home/worker'))
  const writer = keepsWriting(laptop)
  // each request takes 300 ms, so the move uploads for as long as Keep it here takes to come
  relay.delayMs = 300

  const asked = await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  expect(asked.body['step']).toBe('uploading')
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)
  // the upload in flight as Keep it here came ends, and every put after it counts
  await Bun.sleep(1000)
  const frames = (): number => relay.puts.filter(({ key }) => key.startsWith(`journals/${SESSION}/hot/`)).length
  const kept = frames()
  await Bun.sleep(6000)
  const after = frames() - kept
  writer.stop()

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `Kept ${SESSION.slice(0, 8)} here, so it does not move to ${WORKER.name}.` })
  // at the default 5 seconds, 6 seconds hold one or two drains, where the move's drains, one per write, put 19 here
  expect(after).toBeGreaterThan(0)
  expect(after).toBeLessThanOrEqual(2)
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
}, 60_000)

// The suite missed it: no move test's code read failed, and a move read the failure only of a read it started itself,
// while a session that keeps writing has an upload start the read the move waits on.
test('a move of a session that keeps writing while its code cannot be read ends failed with the reason of the read it waited on', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await workerOn(relay)
  // the working folder is a checkout whose index git refuses, so every read of its code fails
  Bun.spawnSync(['git', 'init', '-q', laptop.cwd])
  writeFileSync(join(laptop.cwd, '.git', 'index'), 'not an index')
  // git takes 2 s to refuse it, so the read an upload started still runs as the move looks for one to wait on
  script(join(laptop.folder, 'bin', 'git'), `#!/bin/bash\ncase " $* " in *" ls-files "*) sleep 2 ;; esac\nexec '${Bun.which('git') ?? 'git'}' "$@"\n`)
  const writer = keepsWriting(laptop)
  await Bun.sleep(500)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)
  writer.stop()

  expect(last.step).toBe('failed')
  expect(last.line).toStartWith(`anyhost could not move the session to ${WORKER.name}: anyhost could not read the code of ${SESSION.slice(0, 8)}: `)
  // git's own words for an index it refuses, as `index file smaller than expected`
  expect(last.line).toContain(': index file ')
  expect(last.line).toEndWith('. It keeps running here.')
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
}, 60_000)

// A third machine of the person's, which takes a session over as `anyhost resume --take` there does.
const DESKTOP: Device = { id: 'device-desktop', name: 'anyhost-c', os: 'linux', arch: 'arm64' }

// The suite missed it: no move test had the session taken by another machine mid-move, so no drain ever met a stopped
// journal with code waiting.
test('a move whose session another machine takes while it waits ends failed within seconds, the program answering meanwhile, and leaves the session with that machine', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await relay.join(WORKER, roots('/home/worker'))
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await welcomed(desktop)
  laptop.status('busy')
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await stepsOf(laptop.socket, new Set(['waiting']))

  // the desktop takes the session, and the relay's `released` stops the laptop's journal
  await desktop.run([{ op: 'claim', session: SESSION, take: true }])[0]
  await until(async () => (await claimOn(laptop.socket)).machine === DESKTOP.name, 'the laptop hearing it')
  // the working folder changed, so the move's read of it finds code to upload
  writeFileSync(join(laptop.cwd, 'notes.txt'), 'the plan for the trip, by train\n')
  laptop.status('idle')
  const idleAt = Date.now()
  const { last } = await stepsOf(laptop.socket)

  expect(Date.now() - idleAt).toBeLessThan(10_000)
  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `${DESKTOP.name} took ${SESSION.slice(0, 8)} over during the move, so it continues there.` })
  const askedAt = Date.now()
  await statusOn(laptop.socket)
  expect(Date.now() - askedAt).toBeLessThan(2000)
  expect((await relay.claims()).get(SESSION)).toBe(DESKTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBe(DESKTOP.name)
}, 60_000)

// The suite missed it: no test dropped the asking machine's socket while the other machine's answer was on its way, so
// every `moved` reached a machine that was connected.
test('a moved the relay could not deliver, as the laptop lost its socket just before, reaches the laptop at its next ask once it connects again, and the worker runs the session once', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await welcomed(desktop)
  const held = relay.holdNext('moved')

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const release = await held
  const reconnect = relay.disconnect(LAPTOP.id)
  await until(async () => (await machinesOf(desktop)).find(({ id }) => id === LAPTOP.id)?.connected === false, 'the relay listing the laptop offline')
  // the Pool answers the worker's one send of moved offline
  release()
  await Bun.sleep(1000)
  reconnect()
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  expect(worker.logged()).toContain(`${LAPTOP.name} asked again for its answer`)
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  expect(logOf(worker.folder, 'claude.log').filter((line) => line.endsWith(`--bg --resume ${SESSION}`))).toHaveLength(1)
  await laptop.claude.exited
  expect(laptop.claude.signalCode).toBe('SIGTERM')
}, 90_000)

// Whether the relay lists the machine as connected, as `/machines` shows it.
const listedConnected = async (asking: Relay, id: string): Promise<boolean | undefined> => (await machinesOf(asking)).find((machine) => machine.id === id)?.connected

// The suite missed it: `disconnect` closed the Pool's socket cleanly, so every machine a test took offline sent a close
// the real network never sends, and no Pool held the open socket of a machine gone to sleep, which it counted as told.
test('a laptop gone silent with a drain in flight while the desktop takes its session refuses that session\'s next prompt once it connects again, and the Pool stores no frame of it after the take', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await welcomed(desktop)
  // the first upload's index is up, so no upload of the session is in flight as the laptop goes silent
  await until(() => relay.puts.some(({ key }) => key === `sessions/${LAPTOP.id}/index.json`), 'the laptop putting its index')
  await Bun.sleep(1000)
  const wake = relay.silence(LAPTOP.id)
  // a line written as the lid closes, whose drain goes out on the silent socket
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`, { flag: 'a' })
  // the Pool counts the laptop's socket alive for up to LIVE_MS after its last ping
  for (const started = Date.now(); (await listedConnected(desktop, LAPTOP.id)) !== false; await Bun.sleep(250)) {
    if (Date.now() - started > LIVE_MS + 15_000) throw new Error(`The relay still lists ${LAPTOP.name} connected ${LIVE_MS + 15_000} ms after it went silent.`)
  }

  const [taken] = await Promise.all(desktop.run([{ op: 'claim', session: SESSION, take: true }]))
  expect(taken).toEqual({ status: 200, previous: { id: LAPTOP.id, name: LAPTOP.name }, told: false, at: expect.any(String) })
  const stored = relay.puts.length
  wake()
  // a laptop that dropped its silent socket itself waits out its next try to connect, up to 60 s
  await until(async () => (await statusOn(laptop.socket)).relay.state === 'connected', 'the laptop connecting again', 70_000)

  expect((await claimOn(laptop.socket)).machine).toBe(DESKTOP.name)
  // The drain the silent socket swallowed goes again, whole, on the next socket, after the welcome, and the Pool refuses
  // its frames with 409, as the desktop holds the session: a fork is a frame stored, never one sent. The requests the
  // laptop sends at its welcome are answered by then.
  await Bun.sleep(3000)
  expect(relay.puts.slice(stored).filter(({ key }) => key.startsWith(`journals/${SESSION}/`))).toEqual([])
}, 180_000)

// The suite missed it: the same `disconnect`, whose close the Pool heard at once, so `/machines` never had to tell a
// machine gone silent from a connected one.
test('/machines lists a machine gone silent as connected until LIVE_MS passed, and as not connected from then on', async () => {
  const relay = await memoryRelay()
  const laptop = relay.connect(LAPTOP, roots('/home/laptop'))
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await Promise.all([welcomed(laptop), welcomed(desktop)])
  relay.silence(LAPTOP.id)
  expect(await listedConnected(desktop, LAPTOP.id)).toBe(true)

  await Bun.sleep(LIVE_MS + 2000)

  expect(await listedConnected(desktop, LAPTOP.id)).toBe(false)
}, 90_000)

// The suite missed it: every holder a take met had gone silent past LIVE_MS or closed its socket, so no take met a
// socket the Pool still counted alive, which took the released into nowhere, as a laptop's does whose lid closed 5 s
// after the Pool last heard it.
test("a take of a session whose holder went silent 5 s after the Pool last heard it answers told false, and the holder's next welcome carries released, which it confirms", async () => {
  const relay = await memoryRelay()
  const home = join(temporaryFolder(), 'home')
  const laptop = openCapture(relay.connect(LAPTOP, roots(home)), LAPTOP, roots(home), { db: openDatabase(join(temporaryFolder(), 'state')), code: noCode })
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await Promise.all([welcomed(laptop.relay), welcomed(desktop)])
  expect(await laptop.relay.runOne({ op: 'claim', session: SESSION, take: false })).toEqual({ status: 200, told: true, at: expect.any(String) })
  await Bun.sleep(5000)
  const wake = relay.silence(LAPTOP.id)
  // the Pool counts the laptop's socket alive for LIVE_MS after it last heard it
  expect(await listedConnected(desktop, LAPTOP.id)).toBe(true)

  expect(await desktop.runOne({ op: 'claim', session: SESSION, take: true })).toEqual({ status: 200, previous: { id: LAPTOP.id, name: LAPTOP.name }, told: false, at: expect.any(String) })
  wake()
  await until(() => journalOf(laptop.db, SESSION)?.holder === DESKTOP.name, 'the laptop hearing it lost the session')
  await until(async () => (await relay.waiting()).length === 0, 'the Pool hearing the laptop confirm it')
})

// The suite missed it: `silence` ends a machine's sockets as it wakes, while a laptop whose lid closed for a few minutes
// wakes on its old socket, which the Pool counted not live meanwhile, so the take's released went only into the
// Pool's waiting, which only a welcome sends again. SIGSTOP freezes the program's timers with its socket open, as a
// sleep does.
test('a program whose socket outlives a sleep past LIVE_MS while another machine takes its session connects again before it sends anything more, and confirms the released before its next frame', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await welcomed(desktop)
  // the first upload's index is up, so no upload of the session is in flight as the laptop sleeps
  await until(() => relay.puts.some(({ key }) => key === `sessions/${LAPTOP.id}/index.json`), 'the laptop putting its index')
  await Bun.sleep(1000)
  let asked = 0
  let stored = 0
  // the front holds the laptop's heard and all it sends after it, so what reached it by then went before the heard
  const heard = relay.holdNext('heard')
  process.kill(laptop.child.pid, 'SIGSTOP')
  try {
    // the Pool counts the laptop's socket alive for LIVE_MS after its last ping, at most PING_MS before the sleep
    for (const started = Date.now(); (await listedConnected(desktop, LAPTOP.id)) !== false; await Bun.sleep(250)) {
      if (Date.now() - started > PING_MS + LIVE_MS + 5000) throw new Error(`The relay still lists ${LAPTOP.name} connected ${PING_MS + LIVE_MS + 5000} ms after it slept.`)
    }
    expect(await desktop.runOne({ op: 'claim', session: SESSION, take: true })).toEqual({ status: 200, previous: { id: LAPTOP.id, name: LAPTOP.name }, told: false, at: expect.any(String) })
    asked = relay.requests.length
    stored = relay.puts.length
    // a line written as the lid opens, which the laptop's next drain carries
    appendFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`)
  } finally {
    process.kill(laptop.child.pid, 'SIGCONT')
  }
  const release = await heard

  expect(relay.requests.slice(asked).flat().filter((op) => op.op === 'put' && op.key.startsWith(`journals/${SESSION}/`))).toEqual([])
  expect(laptop.logged()).toContain('seconds ago, as before this machine slept, so it connects again before it sends anything more.')
  release()
  await until(async () => (await relay.waiting()).length === 0, 'the Pool hearing the laptop confirm the released')
  expect((await claimOn(laptop.socket)).machine).toBe(DESKTOP.name)
  // the drain the laptop read as it woke goes after the heard, and the Pool refuses its frame
  await Bun.sleep(7000)
  expect(relay.puts.slice(stored).filter(({ key }) => key.startsWith(`journals/${SESSION}/`))).toEqual([])
}, 180_000)

// The suite missed it: a frame the relay refused with 409 only wrote the holder, so the Pool kept the take's released
// for this machine, and the session's background job here ran on, refusing every prompt.
test("a frame the relay refuses with 409, as after a released that never reached the program, stops the program's background job of the session and confirms the released", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay, LAPTOP, 'background')
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await welcomed(desktop)
  const dropped = relay.dropNext(LAPTOP.id, 'released')
  expect(await desktop.runOne({ op: 'claim', session: SESSION, take: true })).toEqual({ status: 200, previous: { id: LAPTOP.id, name: LAPTOP.name }, told: false, at: expect.any(String) })
  await dropped
  expect(await relay.waiting()).toHaveLength(1)

  appendFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`)
  await until(() => logOf(laptop.folder, 'claude.log').some((line) => line.endsWith(`stop ${SESSION.slice(0, 8)}`)), 'the program stopping the job', 20_000)
  expect(await relay.waiting()).toEqual([])
  expect((await claimOn(laptop.socket)).machine).toBe(DESKTOP.name)
}, 60_000)

// The suite missed it: every released a test sent reached the program that ran the session's job, while any command's
// connect took the welcome's released as well, and the program's own welcome then carried none.
test("a released a command's connect took stops the program's background job of the session at the program's next welcome", async () => {
  const relay = await memoryRelay()
  const worker = await workerOn(relay)
  const workerHome = worker.env['HOME'] ?? ''
  // Claude Code's daemon runs the session in the worker's background between two turns, and the worker holds it
  const job = Bun.spawn(['sleep', '600'])
  children.push(job)
  writeFileSync(join(workerHome, '.claude', 'sessions', `${job.pid}.json`), JSON.stringify({ pid: job.pid, sessionId: SESSION, jobId: SESSION.slice(0, 8), kind: 'bg', cwd: join(workerHome, 'work'), status: 'idle' }))
  const claimer = relay.connect(WORKER, roots(workerHome))
  expect(await claimer.runOne({ op: 'claim', session: SESSION, take: false })).toEqual({ status: 200, told: true, at: expect.any(String) })
  claimer.close()
  // the worker's program stops, and the laptop takes the session meanwhile
  worker.child.kill('SIGKILL')
  await worker.child.exited
  await until(() => !relay.isConnected(WORKER.id), "the worker's socket closing")
  const laptop = relay.connect(LAPTOP, roots('/home/laptop'))
  expect(await laptop.runOne({ op: 'claim', session: SESSION, take: true })).toMatchObject({ status: 200, told: false })
  // a command on the worker connects before its program does, and takes the released
  const command = openCapture(relay.connect(WORKER, roots(workerHome)), WORKER, roots(workerHome), { db: openDatabase(join(worker.env['XDG_STATE_HOME'] ?? '', 'anyhost')), code: noCode })
  await until(() => journalOf(command.db, SESSION)?.holder === LAPTOP.name, 'the command taking the released')
  await until(async () => (await relay.waiting()).length === 0, 'the Pool hearing the command confirm it')
  command.relay.close()
  command.db.close()

  await serveOn(worker.env)
  await until(() => logOf(worker.folder, 'claude.log').some((line) => line.endsWith(`stop ${SESSION.slice(0, 8)}`)), 'the program stopping the job')
}, 60_000)

// The suite missed it: every job a released stopped was idle or in a turn, while one at a permission prompt waits for
// a viewer's answer, which would change files on a machine that no longer holds the session.
test('a released stops the background job of a session at a permission prompt, as its record says waiting', async () => {
  const relay = await memoryRelay()
  const worker = await workerOn(relay)
  const workerHome = worker.env['HOME'] ?? ''
  // Claude Code's daemon runs the session in the worker's background, at a permission prompt, and the worker holds it
  const job = Bun.spawn(['sleep', '600'])
  children.push(job)
  writeFileSync(join(workerHome, '.claude', 'sessions', `${job.pid}.json`), JSON.stringify({ pid: job.pid, sessionId: SESSION, jobId: SESSION.slice(0, 8), kind: 'bg', cwd: join(workerHome, 'work'), status: 'waiting' }))
  const claimer = relay.connect(WORKER, roots(workerHome))
  expect(await claimer.runOne({ op: 'claim', session: SESSION, take: false })).toMatchObject({ status: 200, told: true })
  claimer.close()

  // the laptop takes the session, as anyhost resume --take there does
  const laptop = relay.connect(LAPTOP, roots('/home/laptop'))
  expect(await laptop.runOne({ op: 'claim', session: SESSION, take: true })).toMatchObject({ status: 200 })
  // the program logs the stop once claude stop returned
  await until(() => worker.logged().includes(`${LAPTOP.name} took ${SESSION} over, so ${WORKER.name} stopped its background job ${SESSION.slice(0, 8)}.`), 'the program stopping the job at its permission prompt')
  expect(logOf(worker.folder, 'claude.log').filter((line) => line.endsWith(`stop ${SESSION.slice(0, 8)}`))).toHaveLength(1)
}, 60_000)

// The suite missed it: every asker a move test cut off lost its socket with a close the Pool heard at once, while the
// Pool counts a silent socket alive for LIVE_MS and sends it the answer, which counts as delivered and reaches no one.
test("a moved the Pool sent to the laptop's silent socket reaches the laptop once it connects again and asks again, and the worker runs the session once", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  const held = relay.holdNext('moved')

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const release = await held
  const wake = relay.silence(LAPTOP.id)
  release()
  // the Pool sends `moved` to the silent socket it still counts alive, and answers the worker's devices after it
  await Bun.sleep(2000)
  wake()
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  expect(worker.logged()).toContain(`${LAPTOP.name} asked again for its answer`)
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  expect(logOf(worker.folder, 'claude.log').filter((line) => line.endsWith(`--bg --resume ${SESSION}`))).toHaveLength(1)
}, 90_000)

// The suite missed it: every worker whose `seenAt` moved during a move had restarted, so a laptop that read any move of
// it as a restart passed, though a worker's socket that merely reconnected moves it too.
test('a laptop asleep from its move until after the worker reconnected and ran a prompt reaches moved once it wakes, and the worker keeps the session and its turn', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  const held = relay.holdNext('moved')

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const release = await held
  // the laptop's lid closes, and the Pool sends the worker's moved to the laptop's silent socket, which it counts alive
  const wake = relay.silence(LAPTOP.id)
  const asleepAt = Date.now()
  release()
  await Bun.sleep(500)
  // the worker's socket drops and opens again, which moves its seenAt
  const reconnect = relay.disconnect(WORKER.id)
  await until(() => !relay.isConnected(WORKER.id), 'the worker losing its socket')
  reconnect()
  await until(() => relay.isConnected(WORKER.id), 'the worker connecting again', 30_000)
  // a prompt runs on the worker
  const workerCwd = join(worker.env['HOME'] ?? '', 'work')
  const workerTranscript = join(worker.env['HOME'] ?? '', '.claude', 'projects', workerCwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`)
  appendFileSync(workerTranscript, `{"type":"user","cwd":"${workerCwd}","sessionId":"${SESSION}","message":{"role":"user","content":"Book the hotel"}}\n`)
  await until(() => isUploaded(relay, SESSION, 'Book the hotel'), 'the worker uploading its turn', 30_000)
  const turnAt = relay.puts.findIndex(({ key, body }) => key.startsWith(`journals/${SESSION}/hot/`) && decoder.decode(decompress(body)).includes('Book the hotel'))
  // the laptop sleeps through at least one check of the worker's connection
  await Bun.sleep(Math.max(0, 12_000 - (Date.now() - asleepAt)))
  wake()
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  expect(worker.logged()).toContain(`${LAPTOP.name} asked again for its answer`)
  // no frame of the laptop's goes up over the worker's turn
  const laptopFrames = relay.puts.slice(turnAt + 1).filter(({ key, body }) => key.startsWith(`journals/${SESSION}/`) && decoder.decode(decompress(body)).includes(`"device":"${LAPTOP.id}"`))
  expect(laptopFrames).toEqual([])
  await laptop.claude.exited
  expect(laptop.claude.signalCode).toBe('SIGTERM')
}, 120_000)

// The suite missed it: the test Claude Code's `claude stop` never failed, and no test read /status after a move.
test('a move whose copy here fails to stop ends failed with the reason, never at moved, and leaves no problem in /status', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay, LAPTOP, 'background')
  writeFileSync(join(laptop.folder, 'fail-stop'), 'Claude Code reached no daemon.')
  await workerOn(relay)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { steps, last } = await stepsOf(laptop.socket)

  expect(steps).not.toContain('moved')
  expect(last.step).toBe('failed')
  expect(last.line).toStartWith(`${WORKER.name} runs ${SESSION.slice(0, 8)} now, and anyhost could not stop its copy here: `)
  expect(last.line).toEndWith('Claude Code reached no daemon.')
  // the session runs on the worker, which holds it
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  const { problems } = await statusOn(laptop.socket)
  expect(problems.filter((problem) => problem.includes(`move ${SESSION}`))).toEqual([])
}, 60_000)

test('a session the worker keeps a background job of starts again with claude attach, never as a copy from claude --bg --resume', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay, (folder) =>
    writeFileSync(join(folder, 'kept.json'), JSON.stringify([{ id: SESSION.slice(0, 8), sessionId: SESSION, kind: 'background', cwd: join(folder, 'home', 'work'), state: 'stopped' }])),
  )

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  const calls = logOf(worker.folder, 'claude.log').map((line) => line.split(' ').slice(2).join(' '))
  expect(calls).toContain(`attach ${SESSION.slice(0, 8)}`)
  expect(calls.filter((call) => call.startsWith('--bg'))).toEqual([])
}, 60_000)

test('a session moved back from the worker\'s background tells its viewers where it went, so anyhost attach on the laptop shows it there with no command typed', async () => {
  const relay = await memoryRelay()
  const worker = await runningOn(relay, WORKER, 'background')
  const laptop = await workerOn(relay, () => undefined, LAPTOP)
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_terminal, bytes) => void (shown += decoder.decode(bytes)) })
  const attach = Bun.spawn(['bun', CLI, 'attach', SESSION.slice(0, 8)], { env: laptop.env, terminal })
  children.push(attach)
  await until(() => shown.includes('size 24 80'), 'the session from the worker on the laptop\'s terminal')
  expect(logOf(worker.folder, 'claude.log').some((line) => line.endsWith(`attach ${SESSION.slice(0, 8)}`))).toBe(true)

  await postTo(worker.socket, '/move', { session: SESSION, machine: LAPTOP.name })
  const { last } = await stepsOf(worker.socket)

  expect(last.step).toBe('moved')
  // the worker stopped its copy, and the laptop's anyhost attach shows the session in the laptop's own background
  await until(() => logOf(worker.folder, 'claude.log').some((line) => line.endsWith(`stop ${SESSION.slice(0, 8)}`)), 'the worker stopping its copy')
  await until(() => logOf(laptop.folder, 'claude.log').some((line) => line.endsWith(`attach ${SESSION.slice(0, 8)}`)), 'the laptop showing it')
  expect(logOf(laptop.folder, 'claude.log').some((line) => line.endsWith(`--bg --resume ${SESSION}`))).toBe(true)
  terminal.write('typed on the laptop\r')
  await until(() => shown.includes('typed typed on the laptop'), 'the typed line')
  expect(attach.exitCode).toBeNull()
  terminal.close()
}, 60_000)

test('keys typed while a session moves, before its new machine shows it, reach the session there once each', async () => {
  const relay = await memoryRelay()
  const worker = await runningOn(relay, WORKER, 'background')
  const laptop = await workerOn(relay, () => undefined, LAPTOP)
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_terminal, bytes) => void (shown += decoder.decode(bytes)) })
  const attach = Bun.spawn(['bun', CLI, 'attach', SESSION.slice(0, 8)], { env: laptop.env, terminal })
  children.push(attach)
  await until(() => shown.includes('size 24 80'), 'the session from the worker on the laptop\'s terminal')
  // a viewer that typed into the session on the worker, so its stream sent bytes before the move
  terminal.write('typed on the worker\r')
  await until(() => shown.includes('typed typed on the worker'), 'the line typed on the worker')

  await postTo(worker.socket, '/move', { session: SESSION, machine: LAPTOP.name })
  // Once the laptop started the session, each request takes 3 s, so the laptop's program reads which machine holds the
  // session 3 s after anyhost attach's new attach. The worker stops its copy after its viewers got `moved`.
  await until(() => logOf(laptop.folder, 'claude.log').some((line) => line.endsWith(`--bg --resume ${SESSION}`)), 'the laptop starting the session', 90_000)
  relay.delayMs = 3000
  await until(() => logOf(worker.folder, 'claude.log').some((line) => line.endsWith(`stop ${SESSION.slice(0, 8)}`)), 'the worker stopping its copy', 60_000)
  terminal.write('typed during the move\r')
  relay.delayMs = 0
  await until(() => shown.includes('typed typed during the move'), 'the line typed during the move')
  // the laptop's claude attach shows the session's whole screen, and the line once
  await Bun.sleep(1000)
  expect(shown.split('typed typed during the move')).toHaveLength(2)
  terminal.close()
}, 120_000)

// Claude Code's global config on a machine, where it keeps each folder's trust
const configOf = (machine: { readonly env: Record<string, string> }): string => join(machine.env['CLAUDE_CONFIG_DIR'] ?? '', '.claude.json')
const trustedIn = (machine: { readonly env: Record<string, string> }): string[] => {
  const { projects = {} } = JSON.parse(readFileSync(configOf(machine), { encoding: 'utf8', flag: 'a+' }) || '{}') as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }
  return Object.entries(projects).filter(([, project]) => project.hasTrustDialogAccepted === true).map(([folder]) => folder)
}
const trust = (machine: { readonly env: Record<string, string> }, folder: string): void => writeFileSync(configOf(machine), JSON.stringify({ projects: { [realpathSync(folder)]: { hasTrustDialogAccepted: true } } }))

test('a move carries the trust of the session\'s folder: the worker trusts the folder it continues in, keeping the rest of its config and its config\'s symlink', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  // outside git, Claude Code trusts a folder below a trusted one
  trust(laptop, laptop.env['HOME'] ?? '')
  // the worker keeps its config in dotfiles, and Claude Code's folder links to it
  const kept = { numStartups: 3, projects: { '/elsewhere': { allowedTools: [], hasTrustDialogAccepted: true } } }
  const dotfile = join(temporaryFolder(), 'dotfiles', 'claude.json')
  mkdirSync(dirname(dotfile), { recursive: true })
  writeFileSync(dotfile, JSON.stringify(kept))
  symlinkSync(dotfile, configOf(worker))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  const workerCwd = realpathSync(join(worker.env['HOME'] ?? '', 'work'))
  expect(JSON.parse(readFileSync(dotfile, 'utf8'))).toEqual({ ...kept, projects: { ...kept.projects, [workerCwd]: { hasTrustDialogAccepted: true } } })
  expect(readlinkSync(configOf(worker))).toBe(dotfile)
  expect(readdirSync(dirname(dotfile))).toEqual(['claude.json'])
  expect(existsSync(`${configOf(worker)}.lock`)).toBe(false)
}, 60_000)

// The suite missed it: every trust test's config was readable or missing, and none was a symlink to a missing file,
// where a read that fails reads as an empty config.
test('a worker whose Claude Code config it cannot read fails the move with the reason, and the config stays as it was', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  trust(laptop, laptop.env['HOME'] ?? '')
  const config = JSON.stringify({ numStartups: 3, oauthAccount: { emailAddress: 'ada@example.com' } })
  writeFileSync(configOf(worker), config)
  chmodSync(configOf(worker), 0o000)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)
  chmodSync(configOf(worker), 0o600)

  expect(last.step).toBe('failed')
  expect(last.line).toStartWith(`${WORKER.name} could not take the session: EACCES`)
  expect(last.line).toEndWith('. It keeps running here.')
  expect(readFileSync(configOf(worker), 'utf8')).toBe(config)
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
}, 60_000)

// The suite missed it: every laptop a trust test moved from could read its own Claude Code config, while one it could
// not read sent the move untrusted, which the worker's Claude Code refuses with `Workspace not trusted`.
test("a laptop whose Claude Code config it cannot read fails the move with the reason before it asks the worker", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  trust(laptop, laptop.env['HOME'] ?? '')
  chmodSync(configOf(laptop), 0o000)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)
  chmodSync(configOf(laptop), 0o600)

  expect(last.line).toStartWith(`anyhost could not move the session to ${WORKER.name}: EACCES`)
  expect(last.line).toEndWith('. It keeps running here.')
  expect(worker.logged()).not.toContain(`${LAPTOP.name} moves ${SESSION} here.`)
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
}, 60_000)

test('a worker whose Claude Code config is a symlink to a missing file trusts the folder in that file, and the config stays a symlink', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  trust(laptop, laptop.env['HOME'] ?? '')
  const dotfile = join(temporaryFolder(), 'dotfiles', 'claude.json')
  mkdirSync(dirname(dotfile), { recursive: true })
  symlinkSync(dotfile, configOf(worker))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  expect(lstatSync(configOf(worker)).isSymbolicLink()).toBe(true)
  expect(readlinkSync(configOf(worker))).toBe(dotfile)
  const workerCwd = realpathSync(join(worker.env['HOME'] ?? '', 'work'))
  expect(JSON.parse(readFileSync(dotfile, 'utf8'))).toEqual({ projects: { [workerCwd]: { hasTrustDialogAccepted: true } } })
}, 60_000)

// The suite missed it: every lock of Claude Code's config a test left behind was a folder, which rmdir removes.
test("a worker whose Claude Code config's lock is a file left behind fails the move with the reason within 5 s, and the file stays", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  trust(laptop, laptop.env['HOME'] ?? '')
  const lock = `${configOf(worker)}.lock`
  writeFileSync(lock, '')
  const leftAt = new Date(Date.now() - 60_000)
  utimesSync(lock, leftAt, leftAt)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { steps } = await stepsOf(laptop.socket, new Set(['moving', 'failed']))
  const askedAt = Date.now()
  const { last } = await stepsOf(laptop.socket, undefined, steps)

  expect(Date.now() - askedAt).toBeLessThan(5000)
  expect(last.step).toBe('failed')
  expect(last.line).toStartWith(`${WORKER.name} could not take the session: ${lock} is left behind, unchanged for 10 s, and anyhost could not remove it, so it could not trust the folder: ENOTDIR`)
  expect(last.line).toEndWith('. It keeps running here.')
  expect(lstatSync(lock).isFile()).toBe(true)
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
}, 60_000)

// A checkout on the laptop of a repository whose remote the worker reaches too, with a plan in `plans/`.
function tripOn(laptop: { readonly env: Record<string, string> }): string {
  const origin = join(temporaryFolder(), 'trip.git')
  const checkout = join(laptop.env['HOME'] ?? '', 'trip')
  const git = (...args: string[]): void => void Bun.spawnSync(['git', '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', ...args], { stderr: 'ignore' })
  git('init', '--bare', '-b', 'main', origin)
  git('clone', origin, checkout)
  mkdirSync(join(checkout, 'plans'), { recursive: true })
  writeFileSync(join(checkout, 'plans', 'route.md'), 'Lisbon, then Porto\n')
  git('-C', checkout, 'add', '.')
  git('-C', checkout, 'commit', '-m', 'Plan the route')
  git('-C', checkout, 'push', 'origin', 'main')
  return checkout
}

test('anyhost new trusts nothing on the worker when the laptop trusts only a folder above the checkout, which Claude Code never counts', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP, false, backgroundClaude)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)
  trust(laptop, laptop.env['HOME'] ?? '')

  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(started)
  await until(async () => (await relay.claims()).get(NEW_SESSION) === WORKER.id, 'the session starting on the worker', 30_000)

  expect(trustedIn(worker)).toEqual([])
}, 60_000)

test('anyhost new starts a session on the worker in its clone of the same repository, routed by start and started, and shows it', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP, false, backgroundClaude)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)
  // Claude Code records a checkout's trust at its root
  trust(laptop, checkout)

  let shown = ''
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_terminal, bytes) => void (shown += decoder.decode(bytes)) })
  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, terminal })
  children.push(started)
  await until(() => shown.includes('size 24 80'), 'the new session on the laptop\'s terminal', 30_000)

  expect(shown).toContain(`${WORKER.name} started ${NEW_SESSION.slice(0, 8)}.`)
  expect((await relay.claims()).get(NEW_SESSION)).toBe(WORKER.id)
  const workerCwd = join(worker.env['HOME'] ?? '', 'trip', 'plans')
  expect(readFileSync(join(workerCwd, 'route.md'), 'utf8')).toBe('Lisbon, then Porto\n')
  expect(logOf(worker.folder, 'claude.log').find((line) => line.endsWith(' --bg'))?.split(' ')[1]).toBe(realpathSync(workerCwd))
  // the worker trusts its clone at its root, where Claude Code looks for the trust of the folder inside it
  expect(trustedIn(worker)).toEqual([realpathSync(join(worker.env['HOME'] ?? '', 'trip'))])
  terminal.write('hello from the laptop\r')
  await until(() => shown.includes('typed hello from the laptop'), 'the typed line')
  terminal.close()
}, 60_000)

// The suite missed it: every worker an anyhost new test asked answered, and the relay's `offline` comes only as a
// message is sent.
test('anyhost new to a worker whose program ends after it took the start ends with the reason within the check of its connection', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP, false, backgroundClaude)
  // its Claude Code starts the session past the end of the test
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'hang'), '60'))
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)

  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(started)
  await until(() => logOf(worker.folder, 'claude.log').some((line) => line.endsWith(' --bg')), 'the worker starting the session', 30_000)
  worker.child.kill('SIGKILL')
  const endedAt = Date.now()
  const [code, err] = await Promise.all([started.exited, new Response(started.stderr).text()])

  // the check every 10 s, and the answer of the relay's devices
  expect(Date.now() - endedAt).toBeLessThan(25_000)
  expect(code).toBe(1)
  // the worker may have started the session before it went, so the line names where to look
  expect(err.trim()).toBe(`${WORKER.name} is offline or its program restarted before it answered. anyhost list shows whether a session started there.`)
}, 60_000)

// The suite missed it: no test dropped the socket of anyhost new's own process, which alone waited for `started`, while
// the relay sends `started` only to the sockets the laptop has open as it comes.
test("anyhost new whose command's own socket drops while the worker starts the session prints the session it started and exits 0", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP, false, backgroundClaude)
  // its Claude Code takes 3 s to start the session
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'hang'), '3'))
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)

  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(started)
  await until(() => logOf(worker.folder, 'claude.log').some((line) => line.endsWith(' --bg')), 'the worker starting the session', 30_000)
  // every socket of the laptop but its program's, which it opened first, ends, and none opens until the relay sent the
  // worker's `started` on
  const reconnect = relay.disconnect(LAPTOP.id, 1)
  await until(() => worker.logged().includes(`${WORKER.name} started ${NEW_SESSION}`), 'the worker answering', 30_000)
  await Bun.sleep(1000)
  reconnect()
  const [code, out] = await Promise.all([started.exited, new Response(started.stdout).text()])

  expect(out).toStartWith(`${WORKER.name} started ${NEW_SESSION.slice(0, 8)}.\n`)
  expect(code).toBe(0)
}, 60_000)

// The suite missed it: every started a test held reached a laptop whose socket closed with a close the Pool heard, while
// a laptop asleep keeps a socket the Pool counts alive, which takes the answer into nowhere.
test("anyhost new whose laptop sleeps as the worker's started goes prints the session once it wakes and exits 0, with one session started there", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP, false, backgroundClaude)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)
  const held = relay.holdNext('started')

  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(started)
  const release = await held
  // the laptop's lid closes, and the Pool sends the worker's started to the laptop's silent sockets, which it counts alive
  const wake = relay.silence(LAPTOP.id)
  release()
  // the laptop sleeps through at least one check of the worker's connection
  await Bun.sleep(12_000)
  wake()
  const [code, out] = await Promise.all([started.exited, new Response(started.stdout).text()])

  expect(out).toStartWith(`${WORKER.name} started ${NEW_SESSION.slice(0, 8)}.\n`)
  expect(code).toBe(0)
  expect(worker.logged()).toContain(`${LAPTOP.name} asked again for its answer`)
  expect(logOf(worker.folder, 'claude.log').filter((line) => line.endsWith(' --bg'))).toHaveLength(1)
}, 90_000)

test("anyhost new while its program's relay is not connected says what it waits for, and starts the session once the relay connects", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP, false, backgroundClaude)
  await workerOn(relay)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)
  const reconnect = relay.disconnect(LAPTOP.id)
  await until(async () => (await statusOn(laptop.socket)).relay.state !== 'connected', 'the program reading its relay down')

  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(started)
  let printed = ''
  const reading = (async () => {
    for await (const chunk of started.stdout) printed += decoder.decode(chunk)
  })()
  await until(() => printed.includes('\n'), 'the line that says what anyhost new waits for', 30_000)
  const waiting = printed
  reconnect()
  const [code] = await Promise.all([started.exited, reading])

  expect(waiting).toStartWith(`Waiting for the relay at ${relay.url} to connect.`)
  expect(waiting).toEndWith(' Ctrl-C stops waiting.\n')
  expect(printed.slice(waiting.length)).toStartWith(`${WORKER.name} started ${NEW_SESSION.slice(0, 8)}.\n`)
  expect(code).toBe(0)
}, 90_000)

// systemd's systemd-run, which logs each call into `systemd-run.log` in the machine's folder and runs the command in it
const systemdOn = (folder: string): void =>
  void script(
    join(folder, 'bin', 'systemd-run'),
    `#!/bin/bash
echo "$*" >> '${folder}/systemd-run.log'
while [ "$1" != --unit ]; do shift; done
shift 2
exec "$@"
`,
  )

test('on Linux each claude --bg and each claude attach runs in a scope of a new name inside anyhost-claude.slice, bound to no other unit', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP, false, backgroundClaude)
  const worker = await workerOn(relay, systemdOn)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)
  trust(laptop, checkout)

  let shown = ''
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_terminal, bytes) => void (shown += decoder.decode(bytes)) })
  const first = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, terminal })
  children.push(first)
  await until(() => shown.includes('size 24 80'), 'the new session on the laptop\'s terminal', 30_000)
  // a later session starts in a scope of its own
  const later = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(later)
  const calls = (): string[] => logOf(worker.folder, 'claude.log').map((line) => line.split(' ').slice(2).join(' ')).filter((call) => !call.startsWith('agents'))
  await until(() => calls().filter((call) => call === '--bg').length === 2, 'the later claude --bg', 30_000)

  const claude = worker.env['CLAUDE_CODE_EXECPATH']
  const id = NEW_SESSION.slice(0, 8)
  expect(calls()).toEqual(['--bg', `attach ${id}`, '--bg'])
  const scoped = logOf(worker.folder, 'systemd-run.log')
  expect(scoped).toHaveLength(3)
  const inSlice = '--user --scope --quiet --collect --slice anyhost-claude\\.slice --unit'
  expect(scoped[0]).toMatch(new RegExp(`^${inSlice} anyhost-bg-[0-9a-f]{8}\\.scope ${claude} --bg$`))
  expect(scoped[1]).toMatch(new RegExp(`^${inSlice} anyhost-attach-${id}-[0-9a-f]{8}\\.scope ${claude} attach ${id}$`))
  expect(scoped[2]).toMatch(new RegExp(`^${inSlice} anyhost-bg-[0-9a-f]{8}\\.scope ${claude} --bg$`))
  // a name of its own each time, which no scope that still runs holds
  expect(scoped[2]).not.toBe(scoped[0])
  terminal.close()
}, 60_000)
