import { afterEach, expect, setSystemTime, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { createDecipheriv, hkdfSync } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect as dialTcp, createServer, type Socket } from 'node:net'
import type { NetworkInterfaceInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { MAX_MESSAGE_BYTES, cloneFixFor, encodeStream, streamOf } from '../../relay/protocol.ts'
import { decompress, hotKey, journalOf, openCapture, openDatabase, uploadSession, type Problems } from '../src/capture.ts'
import { devicesOf, inviteMachine, machinesOf, removeMachine, type Device, type MachineRoots } from '../src/device.ts'
import { cipherOf, dialDirect, listenDirect, offeredAddresses, type DirectLink, type DirectListener } from '../src/direct.ts'
import { connectRelay, type Relay, type RelayOptions } from '../src/relay.ts'
import { listSessions } from '../src/sessions.ts'
import { openStream, type Link, type Stream } from '../src/stream.ts'
import { memoryRelay, noCode, stopRelays, temporaryFolder, welcomed, type MemoryRelay } from './memory.ts'

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
// a relay whose login nothing keeps, so a login the relay refused has nothing to forget
const connect = (options: Omit<RelayOptions, 'forget'>): Relay => {
  const relay = connectRelay({ ...options, forget: async () => undefined })
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

  await until(() => service.state.is === 'unjoined')
  const message = 'This machine was removed from your machines. Join it again with a link from Add a machine.'
  expect(service.state).toEqual({ is: 'unjoined', message })
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
  await until(() => gone.state.is === 'unjoined')
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

test('a viewer whose host lost the stream, as a restarted host program does, takes the new one from its first byte', () => {
  const [host, viewer] = [opens(), opens()]
  let shown = ''
  viewer.on('output', (bytes) => void (shown += decoder.decode(bytes)))
  host.use(linkTo(viewer))
  viewer.use(linkTo(host))
  host.write('output', encoder.encode('before the restart. '))
  viewer.write('input', encoder.encode('x'))
  host.close()

  const restarted = opens()
  let typed = ''
  restarted.on('input', (bytes) => void (typed += decoder.decode(bytes)))
  restarted.use(linkTo(viewer))
  viewer.use(linkTo(restarted))
  restarted.write('output', encoder.encode('after it.'))
  viewer.write('input', encoder.encode('y'))
  expect(shown).toBe('before the restart. after it.')
  expect(typed).toBe('y')
})

const randomKey = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
// every listener, server and connection a test opened, closed after it
const closers: (() => void)[] = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
})
const closing = <T extends { close(): void } | Socket>(opened: T): T => {
  closers.push(() => ('destroy' in opened ? opened.destroy() : opened.close()))
  return opened
}
// a host's direct listener on loopback, which a test machine has whatever its network
const listensHere = async (): Promise<DirectListener> => closing(await listenDirect(temporaryFolder(), failTest, () => ['127.0.0.1']))

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
  let captured = Buffer.alloc(0)
  const recorder = closing(
    createServer((inbound) => {
      const outbound = closing(dialTcp({ host: '127.0.0.1', port }))
      closing(inbound)
      inbound.on('data', (chunk: Buffer) => {
        captured = Buffer.concat([captured, chunk])
        outbound.write(chunk)
      })
      outbound.on('data', (chunk) => inbound.write(chunk))
      for (const socket of [inbound, outbound]) socket.on('error', () => undefined)
    }),
  )
  await new Promise<void>((resolve) => recorder.listen({ port: 0, host: '127.0.0.1' }, () => resolve()))
  const link = closing(await dialDirect({ port: (recorder.address() as { port: number }).port, addresses: ['127.0.0.1'] }, stream, key, (frame) => viewer.receive(frame)))
  viewer.use(link)
  await until(() => links === 1)
  // the opening, 20 bytes, then the hello, its length and the 16-byte tag
  const [opening, hello] = [captured.subarray(0, 20), captured.subarray(20, 40)]
  expect(hello.readUInt32BE(0)).toBe(16)

  expect(await answerOf(port, opening, () => hello)).toEqual({ salt: 16, after: 0, isClosed: true })
  expect(links).toBe(1)
  host.write('output', encoder.encode('still the viewer\'s'))
  viewer.write('input', encoder.encode('typed after the replay'))
  await until(() => shown === 'still the viewer\'s' && typed === 'typed after the replay')
})

test('a host offers its Tailscale addresses first, then the private LAN addresses of its physical interfaces, and never a public, loopback, link-local or bridge address', () => {
  const info = (address: string, internal = false): NetworkInterfaceInfo =>
    (address.includes(':') ? { address, family: 'IPv6', internal, netmask: '', mac: '', cidr: null, scopeid: 0 } : { address, family: 'IPv4', internal, netmask: '', mac: '', cidr: null })
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

// A TCP proxy to `port` on loopback that carries nothing once cut, and closes neither side, as a firewall that drops
// every packet does.
async function cutterTo(port: number): Promise<{ readonly port: number; cut(): void }> {
  let isCut = false
  const server = closing(
    createServer((inbound) => {
      const outbound = closing(dialTcp({ host: '127.0.0.1', port }))
      closing(inbound)
      for (const [from, to] of [[inbound, outbound], [outbound, inbound]] as const) {
        from.on('data', (chunk) => void (isCut || to.write(chunk)))
        from.on('close', () => void (isCut || to.destroy()))
        from.on('error', () => undefined)
      }
    }),
  )
  await new Promise<void>((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, () => resolve()))
  return { port: (server.address() as { port: number }).port, cut: () => void (isCut = true) }
}

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
  const cutter = await cutterTo((await listener.offer()).port)
  const viewerLink = await dialDirect({ port: cutter.port, addresses: ['127.0.0.1'] }, stream, key, (frame) => viewer.receive(frame))
  viewer.use(viewerLink)
  // what the host took before the viewer went back to the relay, which only the direct link brought
  let typedOverDirect = -1
  void viewerLink.ended.then(() => {
    typedOverDirect = typed.length
    viewer.use(toHost)
  })
  await until(() => hostLink !== undefined)

  const line = Array.from({ length: 200 }, (_, at) => String.fromCharCode(33 + (at % 94))).join('')
  for (const [at, character] of [...line].entries()) {
    if (at === 50) cutter.cut()
    viewer.write('input', encoder.encode(character))
    await Bun.sleep(5)
  }
  // both ends heard nothing for 3 s and went back to the relay, which brought the rest
  expect(await viewerLink.ended).toBe('it brought nothing for 3 s')
  expect(await hostLink?.ended).toBe('it brought nothing for 3 s')
  await until(() => typed.length >= line.length)
  expect(typedOverDirect).toBeGreaterThan(0)
  expect(typedOverDirect).toBeLessThanOrEqual(50)
  expect(typed).toBe(line)
}, 20_000)

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

// Claude Code's record of SESSION running in its background as the process `pid`, as Claude Code keeps it while it runs.
const recordSession = (home: string, pid: number): void =>
  writeFileSync(join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: SESSION, cwd: '/', kind: 'bg', jobId: SESSION.slice(0, 8), status: 'busy' }))

// A machine's folders, its relay login, the cmod that answers its device token and options, and the Claude Code that
// runs SESSION in its background when `isHost` says so. Its `claude attach` enters the alternate screen, prints the
// terminal's size at its start, clears the screen and prints it again at each SIGWINCH in one write, as Claude Code
// paints a frame, prints each line typed into it, and ends at the line `leave`, as it ends when a person leaves its agents view, and
// when its terminal closes. `stopped` in the machine's folder stops the session: `claude agents` lists it no more.
// Its record in `sessions/` names the test's own process, which runs as long as the test, and so does the lock of
// Claude Code's daemon, which a background session needs to run. `claude` replaces that Claude Code with a script of
// the machine's folder.
function machineFor(relay: MemoryRelay, device: Device, isHost: boolean, claude?: (folder: string) => string): { readonly env: Record<string, string>; readonly socket: string; readonly folder: string } {
  const folder = temporaryFolder()
  const home = join(folder, 'home')
  mkdirSync(join(folder, 'tmp'), { recursive: true })
  // where Claude Code keeps the record of each session it runs, and its transcripts
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
  writeFileSync(join(home, '.claude', 'daemon.lock'), JSON.stringify({ pid: process.pid }))
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
    CLAUDE_CODE_EXECPATH: script(
      join(folder, 'bin', 'claude'),
      claude?.(folder) ??
        `#!/bin/bash
case "$1" in
  agents) [ -e '${join(folder, 'stopped')}' ] && printf '[]' || printf '%s' '${isHost ? `[{"pid":1,"id":"${SESSION.slice(0, 8)}","sessionId":"${SESSION}","kind":"background","cwd":"/","status":"busy","state":"working"}]` : '[]'}' ;;
  attach)
    printf '\\033[?1049h'
    trap 'printf "\\033[2Jsize %s\\n" "$(stty size)"' WINCH
    echo "size $(stty size)"
    while IFS= read -r line; do [ "$line" = leave ] && exit 0; echo "typed $line"; done ;;
  *) exit 2 ;;
esac
`,
    ),
  }
  if (isHost && claude === undefined) recordSession(home, process.pid)
  const token = relay.join(device, roots(home))
  script(
    join(env.XDG_DATA_HOME, 'cmod', 'programs', 'cmod'),
    `#!/bin/sh\ncase "$1 $2" in\n  "secret get") printf '%s' '${token}' ;;\n  "options anyhost") printf '{"person":{}}' ;;\n  "device --json") printf '%s' '${JSON.stringify(device)}' ;;\n  *) exit 1 ;;\nesac\n`,
  )
  mkdirSync(join(env.XDG_STATE_HOME, 'anyhost'), { recursive: true })
  writeFileSync(join(env.XDG_STATE_HOME, 'anyhost', 'relay.json'), JSON.stringify({ url: relay.url }))
  return { env, socket: join(env.XDG_STATE_HOME, 'anyhost', 'serve.sock'), folder }
}

// Runs `anyhost serve` on the machine and answers the first line it printed, and the program.
async function serveOn(env: Record<string, string>): Promise<{ readonly address: string; readonly child: Subprocess }> {
  const child = Bun.spawn(['bun', CLI, 'serve'], { env, stdout: 'pipe', stderr: 'inherit' })
  children.push(child)
  const reader = child.stdout.getReader()
  let printed = ''
  while (!printed.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`anyhost serve exited, having printed ${JSON.stringify(printed)}.`)
    printed += decoder.decode(value)
  }
  reader.releaseLock()
  return { address: printed.slice(0, printed.indexOf('\n')), child }
}

async function waitFor(what: string, isTrue: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  for (const started = Date.now(); !(await isTrue()); await Bun.sleep(10)) if (Date.now() - started > ms) throw new Error(`${what} did not happen within ${ms} ms.`)
}

// Runs `anyhost join <link>` on the machine, and answers its exit code and what it printed.
async function joinOn(env: Record<string, string>, link: string): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  const child = Bun.spawn(['bun', CLI, 'join', link], { env, stdout: 'pipe', stderr: 'pipe' })
  children.push(child)
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, out, err }
}

test('anyhost join asks the program that answers on this machine, which joins in turn with its forgets', async () => {
  const { env, socket } = machineFor(memoryRelay(), HOST, false)
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
    expect(await joinOn(env, link)).toEqual({ code: 0, out: 'Joined this machine to https://anyhost-test-join.parker-labs.workers.dev\n', err: '' })
    expect(asked).toEqual([{ method: 'POST', path: '/join', body: { link } }])
  } finally {
    await program.stop(true)
  }
})

test('anyhost join joins in its own process when no program answers on this machine', async () => {
  const { env } = machineFor(memoryRelay(), HOST, false)
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
    const { code, err } = await joinOn(env, `http://127.0.0.1:${relay.port}/v1/join#K7QX2M4W9TPR6ZC3`)
    expect({ code, err }).toEqual({ code: 1, err: `http://127.0.0.1:${relay.port} refused to join anyhost-a: The relay made no invite with that code. Make a new one with Add a machine.\n` })
    expect(asked).toEqual(['POST /v1/join'])
  } finally {
    await relay.stop(true)
  }
})

// A viewer on its own machine, attached to SESSION on HOST through the relay as `anyhost serve` sends an attach.
async function viewerOn(relay: MemoryRelay, device: Device, size: { cols: number; rows: number }) {
  const client = relay.connect(device, roots(`/home/${device.name}`))
  await welcomed(client)
  const id = Math.floor(Math.random() * 2 ** 32)
  const stream = opens()
  const seen = { shown: '', states: [] as string[], attached: [] as unknown[], exits: [] as string[] }
  stream.on('output', (bytes) => void (seen.shown += decoder.decode(bytes)))
  stream.on('state', ({ status }) => void seen.states.push(status))
  stream.on('exit', ({ message }) => void seen.exits.push(message))
  client.on('attached', (message) => {
    if (message.stream !== id) return
    seen.attached.push(message)
    stream.use({ send: (frame) => void client.send(encodeStream(id, frame)) })
  })
  client.on('stream', (bytes) => (streamOf(bytes) === id ? stream.receive(bytes.subarray(5)) : undefined))
  client.send({ t: 'attach', stream: id, to: HOST.id, session: SESSION, ...size, key: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64') })
  return { id, stream, seen, client }
}

test('serve answers at unix:<its state folder>/serve.sock, and two viewers of one session draw it at the smaller size of the two', async () => {
  const relay = memoryRelay()
  const host = machineFor(relay, HOST, true)
  const served = await serveOn(host.env)
  expect(served.address).toBe(`unix:${host.socket}`)
  const status = (await (await fetch('http://localhost/status', { unix: host.socket })).json()) as { device: Device }
  expect(status.device).toEqual(HOST)
  await waitFor('the host connecting', () => relay.isConnected(HOST.id))

  const small = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await waitFor('the first viewer\'s screen', () => small.seen.shown.includes('size 24 80'))
  // the host offers the port it picked at its first start and every address of this machine it may be dialed at
  const { port } = JSON.parse(readFileSync(join(host.env['XDG_STATE_HOME'] ?? '', 'anyhost', 'direct.json'), 'utf8')) as { port: number }
  expect(small.seen.attached).toEqual([{ t: 'attached', stream: small.id, port, addresses: offeredAddresses(), from: { id: HOST.id, name: HOST.name } }])
  expect(small.seen.shown.startsWith('\x1b[?1049h')).toBe(true)
  await waitFor('the session\'s status', () => small.seen.states.includes('busy'))

  // a larger viewer gets the alternate screen and a redraw, a row less and back, at the size both draw whole
  const large = await viewerOn(relay, { ...VIEWER, id: 'device-viewer-2', name: 'mac' }, { cols: 120, rows: 40 })
  await waitFor('the redraw', () => large.seen.shown.includes('size 24 80'))
  expect(large.seen.shown).toStartWith('\x1b[?1049h')
  expect(large.seen.shown).toContain('size 23 80')
  expect(small.seen.shown).toContain('size 23 80')

  // a resize is a frame of the viewer's stream, and the smaller of each side wins
  small.stream.write('resize', { cols: 100, rows: 50 })
  await waitFor('the new smallest size', () => large.seen.shown.includes('size 40 100'))
  large.stream.write('input', encoder.encode('from the mac\r'))
  await waitFor('the typed line on both', () => small.seen.shown.includes('typed from the mac') && large.seen.shown.includes('typed from the mac'))

  // keys of one viewer that end `claude attach` while the session runs get every viewer a new one, which paints anew
  const [smallBefore, largeBefore] = [small.seen.shown.length, large.seen.shown.length]
  small.stream.write('input', encoder.encode('leave\r'))
  await waitFor('a new claude attach on both', () => small.seen.shown.slice(smallBefore).includes('size 40 100') && large.seen.shown.slice(largeBefore).includes('size 40 100'))
  large.stream.write('input', encoder.encode('still here\r'))
  await waitFor('typing into the new one', () => small.seen.shown.includes('typed still here'))

  // a viewer that leaves counts no more, and the one left gets the whole of its own size
  small.client.send({ t: 'detach', stream: small.id })
  await waitFor('the larger viewer\'s size', () => large.seen.shown.includes('size 40 120'))

  // a stopped program leaves no claude attach of its own behind
  const attaches = (): string => Bun.spawnSync(['pgrep', '-f', `${host.env['CLAUDE_CODE_EXECPATH']} attach`]).stdout.toString().trim()
  expect(attaches()).not.toBe('')
  served.child.kill('SIGTERM')
  await served.child.exited
  await waitFor('no claude attach left', () => attaches() === '')
})

test('anyhost attach on another machine and on the host share the host\'s one claude attach, at the smaller size', async () => {
  const relay = memoryRelay()
  const host = machineFor(relay, HOST, true)
  const viewer = machineFor(relay, VIEWER, false)
  relay.claims.set(SESSION, HOST.id)
  await Promise.all([serveOn(host.env), serveOn(viewer.env)])
  await waitFor('both machines connecting', () => relay.isConnected(HOST.id) && relay.isConnected(VIEWER.id))

  let shown = ''
  const terminal = new Bun.Terminal({ cols: 90, rows: 28, data: (_terminal, bytes) => void (shown += decoder.decode(bytes)) })
  // the 8 characters of the id `anyhost attach` takes, as Claude Code shows them
  const attach = Bun.spawn(['bun', CLI, 'attach', SESSION.slice(0, 8)], { env: viewer.env, terminal })
  children.push(attach)
  await waitFor('the session on the viewer\'s terminal', () => shown.includes('size 28 90'))
  terminal.write('hello there\r')
  await waitFor('the typed line', () => shown.includes('typed hello there'))
  terminal.resize(70, 20)
  attach.kill('SIGWINCH')
  await waitFor('the new size', () => shown.includes('size 20 70'))
  expect(shown).toContain('typed hello there')

  // on the host itself, anyhost attach is one more viewer of the same claude attach, through the host's program
  let shownHere = ''
  const here = new Bun.Terminal({ cols: 60, rows: 18, data: (_terminal, bytes) => void (shownHere += decoder.decode(bytes)) })
  const attachHere = Bun.spawn(['bun', CLI, 'attach', SESSION], { env: host.env, terminal: here })
  children.push(attachHere)
  await waitFor('the size both draw whole', () => shownHere.includes('size 18 60') && shown.includes('size 18 60'))
  here.write('typed on the host\r')
  await waitFor('the host\'s line on the other machine', () => shown.includes('typed typed on the host'))
  terminal.close()
  here.close()
})

test('a session that stops running ends its claude attach at once, and its viewer with the reason', async () => {
  const relay = memoryRelay()
  const host = machineFor(relay, HOST, true)
  await serveOn(host.env)
  await waitFor('the host connecting', () => relay.isConnected(HOST.id))
  const viewer = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await waitFor('the viewer\'s screen', () => viewer.seen.shown.includes('size 24 80'))
  await waitFor('the session\'s status', () => viewer.seen.states.includes('busy'))
  // the session stops, and Claude Code's record of it changes
  writeFileSync(join(host.folder, 'stopped'), '')
  writeFileSync(join(host.env['HOME'] ?? '', '.claude', 'sessions', '1.json'), '{}')
  await waitFor('the viewer\'s end', () => viewer.seen.exits.length > 0)
  expect(viewer.seen.exits).toEqual([`The session ${SESSION} stopped running on ${HOST.name}.`])
  await waitFor('no claude attach left', () => Bun.spawnSync(['pgrep', '-f', `${host.env['CLAUDE_CODE_EXECPATH']} attach`]).stdout.toString().trim() === '')
})

test('a claude attach SIGKILL ended while its session runs starts again, and its viewer gets no exit', async () => {
  const relay = memoryRelay()
  const host = machineFor(relay, HOST, true)
  await serveOn(host.env)
  await waitFor('the host connecting', () => relay.isConnected(HOST.id))
  const viewer = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await waitFor('the viewer\'s screen', () => viewer.seen.shown.includes('size 24 80'))
  const attaches = (): string => Bun.spawnSync(['pgrep', '-f', `${host.env['CLAUDE_CODE_EXECPATH']} attach`]).stdout.toString().trim()
  const killed = attaches()
  const before = viewer.seen.shown.length
  // as the OOM killer or a kill -9 ends it, while Claude Code's record of the session stays
  Bun.spawnSync(['pkill', '-KILL', '-f', `${host.env['CLAUDE_CODE_EXECPATH']} attach`])
  await waitFor('a new claude attach on the viewer\'s screen', () => viewer.seen.shown.slice(before).includes('size 24 80'))
  expect(attaches()).not.toBe('')
  expect(attaches()).not.toBe(killed)
  viewer.stream.write('input', encoder.encode('after the kill\r'))
  await waitFor('typing into the new one', () => viewer.seen.shown.includes('typed after the kill'))
  expect(viewer.seen.exits).toEqual([])
})

test('a claude attach a signal ended once its session\'s process is gone ends its viewer with the reason', async () => {
  const relay = memoryRelay()
  const host = machineFor(relay, HOST, true)
  const home = host.env['HOME'] ?? ''
  // the session runs as a process of its own
  const session = Bun.spawn(['sleep', '600'])
  children.push(session)
  rmSync(join(home, '.claude', 'sessions', `${process.pid}.json`))
  recordSession(home, session.pid)
  await serveOn(host.env)
  await waitFor('the host connecting', () => relay.isConnected(HOST.id))
  const viewer = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await waitFor('the viewer\'s screen', () => viewer.seen.shown.includes('size 24 80'))
  // as when systemd stops the session's scope: the session's process ends, and its attach by a signal, while
  // `claude agents` still lists the session
  session.kill('SIGKILL')
  await session.exited
  const signalled = Date.now()
  Bun.spawnSync(['pkill', '-TERM', '-f', `${host.env['CLAUDE_CODE_EXECPATH']} attach`])
  await waitFor('the viewer\'s end', () => viewer.seen.exits.length > 0)
  expect(viewer.seen.exits).toEqual([`The session ${SESSION} stopped running on ${HOST.name}.`])
  // at its first read of the records, not after the 3 s a running session's record is followed
  expect(Date.now() - signalled).toBeLessThan(3000)
  expect(Bun.spawnSync(['pgrep', '-f', `${host.env['CLAUDE_CODE_EXECPATH']} attach`]).stdout.toString().trim()).toBe('')
})

test('a claude attach a signal ended once Claude Code\'s daemon went ends its viewer with the reason, though the session\'s record is still there', async () => {
  const relay = memoryRelay()
  const host = machineFor(relay, HOST, true)
  const home = host.env['HOME'] ?? ''
  await serveOn(host.env)
  await waitFor('the host connecting', () => relay.isConnected(HOST.id))
  const viewer = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await waitFor('the viewer\'s screen', () => viewer.seen.shown.includes('size 24 80'))
  // as when systemd stops the daemon's scope: the daemon removes its lock as it ends, and its attaches end by a signal,
  // while the session's process still ends, so its record is still there
  rmSync(join(home, '.claude', 'daemon.lock'))
  const signalled = Date.now()
  Bun.spawnSync(['pkill', '-TERM', '-f', `${host.env['CLAUDE_CODE_EXECPATH']} attach`])
  await waitFor('the viewer\'s end', () => viewer.seen.exits.length > 0)
  expect(viewer.seen.exits).toEqual([`The session ${SESSION} stopped running on ${HOST.name}.`])
  // at its first read of the records, not after the 3 s a running session's record is followed
  expect(Date.now() - signalled).toBeLessThan(3000)
  expect(existsSync(join(home, '.claude', 'sessions', `${process.pid}.json`))).toBe(true)
  expect(Bun.spawnSync(['pgrep', '-f', `${host.env['CLAUDE_CODE_EXECPATH']} attach`]).stdout.toString().trim()).toBe('')
})

test('the program\'s own stop ends its viewers\' streams and starts no claude attach', async () => {
  const relay = memoryRelay()
  const host = machineFor(relay, HOST, true)
  const served = await serveOn(host.env)
  await waitFor('the host connecting', () => relay.isConnected(HOST.id))
  const viewer = await viewerOn(relay, VIEWER, { cols: 80, rows: 24 })
  await waitFor('the viewer\'s screen', () => viewer.seen.shown.includes('size 24 80'))
  const detached: number[] = []
  viewer.client.on('detach', ({ stream }) => void detached.push(stream))
  const attaches = (): string => Bun.spawnSync(['pgrep', '-f', `${host.env['CLAUDE_CODE_EXECPATH']} attach`]).stdout.toString().trim()
  expect(attaches()).not.toBe('')
  // the session still runs, so only the stop keeps its closed attach from starting again
  served.child.kill('SIGTERM')
  await served.child.exited
  expect(served.child.signalCode).toBe('SIGTERM')
  await waitFor('the viewer\'s stream ending', () => detached.includes(viewer.id))
  await waitFor('no claude attach left', () => attaches() === '')
  expect(viewer.seen.exits).toEqual([])
})

test('anyhost attach on the host shows a session its Claude Code runs while the relay is down', async () => {
  const relay = memoryRelay()
  const host = machineFor(relay, HOST, true)
  relay.stop()
  await serveOn(host.env)
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 72, rows: 22, data: (_terminal, bytes) => void (shown += decoder.decode(bytes)) })
  const attach = Bun.spawn(['bun', CLI, 'attach', SESSION.slice(0, 8)], { env: host.env, terminal })
  children.push(attach)
  await waitFor('the session on the host\'s terminal', () => shown.includes('size 22 72'))
  terminal.write('no relay\r')
  await waitFor('the typed line', () => shown.includes('typed no relay'))
  // the session stops once the host read it listed, 200 ms after it started showing it: anyhost attach says why,
  // gives the terminal back as it was, and ends
  await Bun.sleep(1000)
  writeFileSync(join(host.folder, 'stopped'), '')
  writeFileSync(join(host.env['HOME'] ?? '', '.claude', 'sessions', '1.json'), '{}')
  expect(await attach.exited).toBe(0)
  await waitFor('the reset and the reason', () => shown.includes('\x1b[?1049l\x1b[?25h') && shown.includes(`The session ${SESSION} stopped running on ${HOST.name}.`))
  terminal.close()
})

test('a second serve on one state folder refuses to start, naming the one that runs, and a POST of no JSON answers 400', async () => {
  const relay = memoryRelay()
  const host = machineFor(relay, HOST, true)
  await serveOn(host.env)
  const second = Bun.spawn(['bun', CLI, 'serve'], { env: host.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(second)
  expect(await second.exited).toBe(1)
  expect(await new Response(second.stderr).text()).toContain(`The anyhost program of ${HOST.name} already answers at ${host.socket}, so this one does not start.`)
  // the first one still answers
  const answer = await fetch('http://localhost/machines/invite', { unix: host.socket, method: 'POST', body: 'not json' })
  expect(answer.status).toBe(400)
  expect(((await answer.json()) as { message: string }).message).toStartWith('anyhost takes a JSON object at POST /machines/invite, and this body is none:')
})

test("the program's start stats every captured file, and uploads a line a quiet session gained while the program did not run", async () => {
  const relay = memoryRelay()
  const host = machineFor(relay, HOST, false)
  const home = host.env['HOME'] ?? ''
  const transcript = join(home, '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  const line = (text: string): string => `{"type":"user","message":{"role":"user","content":"${text}"},"sessionId":"${SESSION}"}\n`
  writeFileSync(transcript, line('Plan the trip'))
  // an earlier run of the program captured the session an hour ago, and left no heartbeat to catch up from
  const db = openDatabase(join(host.env['XDG_STATE_HOME'] ?? '', 'anyhost'))
  const capture = openCapture(relay.connect(HOST, roots(home)), HOST, roots(home), db, noCode)
  await welcomed(capture.relay)
  setSystemTime(new Date(Date.now() - 60 * 60_000))
  await uploadSession(capture, SESSION, 'claude', new Set([transcript]), failTest)
  setSystemTime()
  const end = journalOf(db, SESSION)?.end ?? 0
  capture.relay.close()
  db.close()
  appendFileSync(transcript, line('Book the train'))

  await serveOn(host.env)
  await waitFor('the line uploaded', () => relay.puts.some(({ key }) => key === hotKey(SESSION, end)))
  const frame = relay.puts.find(({ key }) => key === hotKey(SESSION, end))?.body ?? new Uint8Array()
  expect(decoder.decode(decompress(frame))).toEndWith(line('Book the train'))
  // the queue drains every 5 seconds
}, 20_000)

const LAPTOP: Device = { id: 'device-laptop', name: 'anyhost-b', os: 'linux', arch: 'arm64' }
const WORKER: Device = { id: 'device-worker', name: 'anyhost-a', os: 'linux', arch: 'arm64' }
// the id the Claude Code of a test machine gives the session `claude --bg` starts new
const NEW_SESSION = 'abcdef12-0000-4000-8000-000000000001'

// A Claude Code that runs sessions in its background: `claude agents --json` lists what `agents.json` in the machine's
// folder holds, and with `--all` what `kept.json` holds, the background jobs it keeps, when there is one. `claude --bg`
// fails with the text of `fail` when there is one, and else starts the session `--resume` names, or a new one, which it
// lists running from then on, with its record in `sessions/`, as Claude Code writes one for each session it runs.
// `claude attach` starts a kept job again, and shows the terminal's size and each line typed. `claude daemon run` takes
// the daemon's lock and runs as long as the program that started it. Every call goes into `claude.log`: the time, the
// folder it ran in, and its arguments. A session it runs has the pid of the program that asked for it, which runs as
// long as the test.
const backgroundClaude = (folder: string): string => `#!/bin/bash
F='${folder}'
echo "$(date +%s%N) $PWD $*" >> "$F/claude.log"
running() {
  printf '[{"pid":%s,"id":"%s","sessionId":"%s","kind":"background","cwd":"%s","status":"idle","state":"blocked"}]' $PPID "\${1:0:8}" "$1" "$PWD" > "$F/agents.json"
  printf '{"pid":%s,"sessionId":"%s","jobId":"%s","kind":"bg","cwd":"%s","status":"idle"}' $PPID "$1" "\${1:0:8}" "$PWD" > "$CLAUDE_CONFIG_DIR/sessions/$PPID.json"
}
case "$1" in
  agents)
    if [ "$3" = --all ] && [ -e "$F/kept.json" ]; then cat "$F/kept.json"; elif [ -e "$F/agents.json" ]; then cat "$F/agents.json"; else printf '[]'; fi ;;
  --bg)
    if [ -e "$F/fail" ]; then cat "$F/fail" >&2; exit 1; fi
    session="\${3:-${NEW_SESSION}}"
    running "$session"
    echo "backgrounded · \${session:0:8} · test (idle — send a prompt to start)" ;;
  attach)
    if [ -e "$F/kept.json" ]; then rm "$F/kept.json"; running '${SESSION}'; fi
    printf '\\033[?1049h'
    echo "size $(stty size)"
    while IFS= read -r line; do echo "typed $line"; done ;;
  stop) rm -f "$F/agents.json" "$CLAUDE_CONFIG_DIR"/sessions/*.json; echo "stopped $2" ;;
  daemon)
    printf '{"pid":%s}' $$ > "$CLAUDE_CONFIG_DIR/daemon.lock"
    while kill -0 $PPID 2>/dev/null; do sleep 0.2; done ;;
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
// Each step the laptop's program showed of the session's move, in order, until it reached `until`.
async function stepsOf(socket: string, until: ReadonlySet<string> = new Set(['moved', 'failed'])): Promise<{ readonly steps: string[]; readonly last: Moved }> {
  const steps: string[] = []
  for (const started = Date.now(); Date.now() - started < 30_000; await Bun.sleep(10)) {
    const { move } = await claimOn(socket)
    if (move === undefined) continue
    if (steps.at(-1) !== move.step) steps.push(move.step)
    if (until.has(move.step)) return { steps, last: move }
  }
  throw new Error(`The move showed ${steps.join(', ')} and reached none of ${[...until].join(', ')} within 30 s.`)
}

// The machine SESSION runs on, in a terminal of its own in a herdr pane, or in Claude Code's background, as `kind`
// says, its Claude Code's process `claude`, and its program captured it. The session works in `work` in the machine's
// home, which holds one file.
async function runningOn(relay: MemoryRelay, device = LAPTOP, kind: 'interactive' | 'background' = 'interactive') {
  const laptop = machineFor(relay, device, false, backgroundClaude)
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
  await serveOn(laptop.env)
  await waitFor('the machine connecting', () => relay.isConnected(device.id))
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
  await waitFor('the machine claiming the session', () => relay.claims.get(SESSION) === device.id, 15_000)
  return { ...laptop, cwd, transcript, claude, status }
}

async function workerOn(relay: MemoryRelay, prepare: (folder: string) => void = () => undefined, device = WORKER) {
  const worker = machineFor(relay, device, false, backgroundClaude)
  prepare(worker.folder)
  await serveOn(worker.env)
  await waitFor('the machine connecting', () => relay.isConnected(device.id))
  return worker
}

test('a move waits for the turn to end, uploads and seals the session, the worker restores and runs it, and only then the laptop\'s Claude Code ends and its herdr pane shows the session there', async () => {
  const relay = memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  laptop.status('busy')

  const asked = await postTo(laptop.socket, '/move', { session: SESSION.slice(0, 8), machine: WORKER.name })
  expect(asked.status).toBe(200)
  expect(asked.body).toMatchObject({ session: SESSION, to: WORKER.name })
  // the turn runs on, and the move waits for it
  await Bun.sleep(500)
  expect((await claimOn(laptop.socket)).move).toEqual({ to: WORKER.name, step: 'waiting', line: `Waiting for ${SESSION.slice(0, 8)} to finish its turn.` })
  laptop.status('idle')
  const { steps, last } = await stepsOf(laptop.socket)

  expect(steps).toEqual(['waiting', 'uploading', 'moving', 'moved'])
  expect(last.line).toMatch(new RegExp(`^${WORKER.name} restored ${SESSION.slice(0, 8)} in \\d+\\.\\d s and runs it\\.$`))
  expect(relay.claims.get(SESSION)).toBe(WORKER.id)
  expect([...relay.objects.keys()].filter((key) => key.startsWith(`journals/${SESSION}/`)).every((key) => key.includes('/sealed/'))).toBe(true)
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
  await waitFor('the pane run', () => logOf(laptop.folder, 'herdr.log').some((line) => line.includes('pane run')))
  const run = logOf(laptop.folder, 'herdr.log').find((line) => line.includes('pane run')) ?? ''
  expect(run.slice(run.indexOf(' ') + 1)).toBe(`pane run w1:p1 anyhost attach ${SESSION.slice(0, 8)}`)
  expect(Number(run.split(' ')[0])).toBeGreaterThan(Number(started?.split(' ')[0]))
  expect(await claimOn(laptop.socket)).toMatchObject({ machine: WORKER.name, move: { step: 'moved' } })
}, 60_000)

test('a move of a session whose first frame R2 lost uploads its files whole again, and the worker restores every byte', async () => {
  const relay = memoryRelay()
  const laptop = await runningOn(relay)
  const hot = (): string[] => [...relay.objects.keys()].filter((key) => key.startsWith(`journals/${SESSION}/hot/`))
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"Book the train"}}\n`, { flag: 'a' })
  await waitFor('the second line uploading', () => relay.puts.some(({ key, body }) => key.includes('/hot/') && decoder.decode(decompress(body)).includes('Book the train')), 15_000)
  relay.objects.delete(hotKey(SESSION, 0))
  const worker = await workerOn(relay)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  expect(hot()).toEqual([])
  const workerHome = worker.env['HOME'] ?? ''
  const workerCwd = join(workerHome, 'work')
  const restored = readFileSync(join(workerHome, '.claude', 'projects', workerCwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`), 'utf8')
  expect(restored).toBe(readFileSync(laptop.transcript, 'utf8').replaceAll(laptop.env['HOME'] ?? '', workerHome))
  expect(readFileSync(join(workerCwd, 'notes.txt'), 'utf8')).toBe('the plan for the trip\n')
}, 60_000)

test('a move to a machine that is offline keeps the session running here, with its claim', async () => {
  const relay = memoryRelay()
  const laptop = await runningOn(relay)
  relay.join(WORKER, roots('/home/worker'))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.line).toBe(`${WORKER.name} is offline, so the session keeps running here.`)
  expect(relay.claims.get(SESSION)).toBe(LAPTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
}, 60_000)

test('a move the worker cannot take takes the claim back, and the laptop captures the session again', async () => {
  const relay = memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'fail'), 'Claude Code is not logged in.'))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.line).toStartWith(`${WORKER.name} could not take the session: `)
  expect(last.line).toContain('Claude Code is not logged in.')
  expect(last.line).toEndWith('. It keeps running here.')
  expect(relay.claims.get(SESSION)).toBe(LAPTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  await waitFor('the worker hearing it lost the session', async () => (await claimOn(worker.socket)).machine === LAPTOP.name)
  expect(laptop.claude.exitCode).toBeNull()
  // the session's next line goes up from the laptop
  const frames = relay.puts.filter(({ key }) => key.startsWith(`journals/${SESSION}/hot/`)).length
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`, { flag: 'a' })
  await waitFor('the next line uploading', () => relay.puts.filter(({ key }) => key.startsWith(`journals/${SESSION}/hot/`)).length > frames, 15_000)
}, 60_000)

test('a move to a worker that took the claim and answers nothing waits for it, and Keep it here takes the session back', async () => {
  const relay = memoryRelay()
  const laptop = await runningOn(relay)
  const silent = relay.connect(WORKER, roots('/home/worker'))
  silent.on('move', ({ session }) => void silent.run([{ op: 'claim', session, take: true }]))
  await welcomed(silent)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await stepsOf(laptop.socket, new Set(['moving']))
  await waitFor('the worker taking the claim', () => relay.claims.get(SESSION) === WORKER.id)
  await waitFor('the laptop hearing it', async () => (await claimOn(laptop.socket)).machine === WORKER.name)
  expect((await claimOn(laptop.socket)).move?.step).toBe('moving')
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `${WORKER.name} did not answer, so the session keeps running here.` })
  expect(relay.claims.get(SESSION)).toBe(LAPTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
}, 60_000)

test('a session the worker keeps a background job of starts again with claude attach, never as a copy from claude --bg --resume', async () => {
  const relay = memoryRelay()
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
  const relay = memoryRelay()
  const worker = await runningOn(relay, WORKER, 'background')
  const laptop = await workerOn(relay, () => undefined, LAPTOP)
  let shown = ''
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_terminal, bytes) => void (shown += decoder.decode(bytes)) })
  const attach = Bun.spawn(['bun', CLI, 'attach', SESSION.slice(0, 8)], { env: laptop.env, terminal })
  children.push(attach)
  await waitFor('the session from the worker on the laptop\'s terminal', () => shown.includes('size 24 80'))
  expect(logOf(worker.folder, 'claude.log').some((line) => line.endsWith(`attach ${SESSION.slice(0, 8)}`))).toBe(true)

  await postTo(worker.socket, '/move', { session: SESSION, machine: LAPTOP.name })
  const { last } = await stepsOf(worker.socket)

  expect(last.step).toBe('moved')
  // the worker stopped its copy, and the laptop's anyhost attach shows the session in the laptop's own background
  await waitFor('the worker stopping its copy', () => logOf(worker.folder, 'claude.log').some((line) => line.endsWith(`stop ${SESSION.slice(0, 8)}`)))
  await waitFor('the laptop showing it', () => logOf(laptop.folder, 'claude.log').some((line) => line.endsWith(`attach ${SESSION.slice(0, 8)}`)))
  expect(logOf(laptop.folder, 'claude.log').some((line) => line.endsWith(`--bg --resume ${SESSION}`))).toBe(true)
  terminal.write('typed on the laptop\r')
  await waitFor('the typed line', () => shown.includes('typed typed on the laptop'))
  expect(attach.exitCode).toBeNull()
  terminal.close()
}, 60_000)

// Claude Code's global config on a machine, where it keeps each folder's trust
const configOf = (machine: { readonly env: Record<string, string> }): string => join(machine.env['CLAUDE_CONFIG_DIR'] ?? '', '.claude.json')
const trustedIn = (machine: { readonly env: Record<string, string> }): string[] => {
  const { projects = {} } = JSON.parse(readFileSync(configOf(machine), { encoding: 'utf8', flag: 'a+' }) || '{}') as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }
  return Object.entries(projects).filter(([, project]) => project.hasTrustDialogAccepted === true).map(([folder]) => folder)
}
const trust = (machine: { readonly env: Record<string, string> }, folder: string): void => writeFileSync(configOf(machine), JSON.stringify({ projects: { [realpathSync(folder)]: { hasTrustDialogAccepted: true } } }))

test('a move carries the trust of the session\'s folder: the worker trusts the folder it continues in, keeping the rest of its config and its config\'s symlink', async () => {
  const relay = memoryRelay()
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
  const relay = memoryRelay()
  const laptop = machineFor(relay, LAPTOP, false, backgroundClaude)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await waitFor('the laptop connecting', () => relay.isConnected(LAPTOP.id))
  const checkout = tripOn(laptop)
  trust(laptop, laptop.env['HOME'] ?? '')

  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(started)
  await waitFor('the session starting on the worker', () => relay.claims.get(NEW_SESSION) === WORKER.id, 30_000)

  expect(trustedIn(worker)).toEqual([])
}, 60_000)

test('anyhost new starts a session on the worker in its clone of the same repository, routed by start and started, and shows it', async () => {
  const relay = memoryRelay()
  const laptop = machineFor(relay, LAPTOP, false, backgroundClaude)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await waitFor('the laptop connecting', () => relay.isConnected(LAPTOP.id))
  const checkout = tripOn(laptop)
  // Claude Code records a checkout's trust at its root
  trust(laptop, checkout)

  let shown = ''
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_terminal, bytes) => void (shown += decoder.decode(bytes)) })
  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, terminal })
  children.push(started)
  await waitFor('the new session on the laptop\'s terminal', () => shown.includes('size 24 80'), 30_000)

  expect(shown).toContain(`${WORKER.name} started ${NEW_SESSION.slice(0, 8)}.`)
  expect(relay.claims.get(NEW_SESSION)).toBe(WORKER.id)
  const workerCwd = join(worker.env['HOME'] ?? '', 'trip', 'plans')
  expect(readFileSync(join(workerCwd, 'route.md'), 'utf8')).toBe('Lisbon, then Porto\n')
  expect(logOf(worker.folder, 'claude.log').find((line) => line.endsWith(' --bg'))?.split(' ')[1]).toBe(realpathSync(workerCwd))
  // the worker trusts its clone at its root, where Claude Code looks for the trust of the folder inside it
  expect(trustedIn(worker)).toEqual([realpathSync(join(worker.env['HOME'] ?? '', 'trip'))])
  terminal.write('hello from the laptop\r')
  await waitFor('the typed line', () => shown.includes('typed hello from the laptop'))
  terminal.close()
}, 60_000)

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

test('on Linux the program starts Claude Code\'s daemon in anyhost-claude.scope before the first claude --bg, every later claude --bg bare, and each claude attach PartOf that scope', async () => {
  const relay = memoryRelay()
  const laptop = machineFor(relay, LAPTOP, false, backgroundClaude)
  const worker = await workerOn(relay, (folder) => {
    systemdOn(folder)
    // no daemon runs on the worker yet
    rmSync(join(folder, 'home', '.claude', 'daemon.lock'))
  })
  await serveOn(laptop.env)
  await waitFor('the laptop connecting', () => relay.isConnected(LAPTOP.id))
  const checkout = tripOn(laptop)
  trust(laptop, checkout)

  let shown = ''
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: (_terminal, bytes) => void (shown += decoder.decode(bytes)) })
  const first = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, terminal })
  children.push(first)
  await waitFor('the new session on the laptop\'s terminal', () => shown.includes('size 24 80'), 30_000)
  // a later session reaches the daemon that runs
  const later = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(later)
  const calls = (): string[] => logOf(worker.folder, 'claude.log').map((line) => line.split(' ').slice(2).join(' ')).filter((call) => !call.startsWith('agents'))
  await waitFor('the later claude --bg', () => calls().filter((call) => call === '--bg').length === 2, 30_000)

  const claude = worker.env['CLAUDE_CODE_EXECPATH']
  const id = NEW_SESSION.slice(0, 8)
  expect(calls()).toEqual(['daemon run --origin transient', '--bg', `attach ${id}`, '--bg'])
  const scoped = logOf(worker.folder, 'systemd-run.log')
  expect(scoped).toHaveLength(2)
  expect(scoped[0]).toBe(`--user --scope --quiet --collect --unit anyhost-claude.scope ${claude} daemon run --origin transient`)
  expect(scoped[1]).toMatch(new RegExp(`^--user --scope --quiet --collect -p PartOf=anyhost-claude\\.scope --unit anyhost-attach-${id}-[0-9a-f]{8}\\.scope ${claude} attach ${id}$`))
  terminal.close()
}, 60_000)
