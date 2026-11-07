// The direct path of an attach stream: a TCP connection from the viewer's `anyhost attach` straight to the program of
// the machine that shows the session, when the two reach each other over Tailscale or a private LAN. The relay carries
// the stream until then and whenever the connection goes, and the stream's numbering loses no byte across a switch
// (stream.ts). The host binds only its Tailscale addresses and the private LAN addresses of its physical interfaces,
// never a public address and never 0.0.0.0, on one port it keeps in `direct.json` in its state folder, so a firewall
// can allow it. Only the viewer dials, so the viewer's machine opens no port.
//
// A connection opens with the stream id and the viewer's random salt in the clear, and the host answers every opening
// with a random salt of its own, whether it holds that stream or not, so the answer tells nothing of the streams it
// holds. Every frame after is `u32 length` and the stream's frame sealed with AES-256-GCM, its nonce a counter, under a
// key per direction that HKDF-SHA256 derives from the one-time key the viewer sent in the relay's `attach`, the stream
// id and both salts. Both sides' randoms make each connection's keys new, as TLS's do, so no nonce repeats under a key,
// even for an opening an observer replays. The viewer's first frame, its hello, proves the key: the host links the
// connection only once the hello opens, and closes any other with nothing sealed sent, so only the machine that sent
// the attach connects. The hello each way is empty, and so is a ping: each side sends one every PING_MS, and a link
// that hears nothing for SILENCE_MS ends, so its stream goes back to the relay.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { join } from 'node:path'
import type { Problems } from './capture.ts'
import type { Link } from './stream.ts'

const PING_MS = 1000
const SILENCE_MS = 3000
// The viewer dials the next address this long after the one before, so the first that answers wins and a slow one
// costs no more than this.
const DIAL_APART_MS = 250
const SALT_BYTES = 16
const OPENING_BYTES = 4 + SALT_BYTES
const TAG_BYTES = 16
// A stream keeps at most 8 MiB its peer did not acknowledge, so no frame it sends is longer than that and its 9-byte
// header.
const MAX_SEALED_BYTES = 8 * 2 ** 20 + 9 + TAG_BYTES
const EMPTY = new Uint8Array()
// The interfaces of container and virtual machine bridges: Docker's `docker0`, `br-<network>` and `veth<pair>` on
// Linux, and macOS's `bridge100` and up, which carry OrbStack's machines and Docker networks on a Mac.
const BRIDGE = /^(docker|br-|veth)|^bridge1\d\d$/

// What the host answers in `attached`: the port and every address a viewer may dial it at.
export type DirectOffer = { readonly port: number; readonly addresses: readonly string[] }
// A direct connection, which carries its stream's frames while it lasts.
export type DirectLink = Link & {
  // the host's address the connection reached
  readonly address: string
  // why the link ended, once it did
  readonly ended: Promise<string>
  close(): void
}
export type DirectListener = {
  // binds each address this machine offers now, and answers what a viewer dials
  offer(): Promise<DirectOffer>
  // A stream a viewer attached to through the relay: a connection whose first frame opens under its key brings
  // `receive` its frames and becomes its link.
  hold(stream: number, key: string, receive: (frame: Uint8Array) => void, linked: (link: DirectLink) => void): void
  release(stream: number): void
  close(): void
}
type Direction = 'viewer to host' | 'host to viewer'
// One direction of a connection: `seal` frames one, with its length before it, and `open` takes a sealed frame without
// its length, in the order sealed, and throws at one that does not open.
type Cipher = { seal(frame: Uint8Array): Buffer; open(sealed: Uint8Array): Buffer }

// macOS refused a dial to the local network that its own programs make, as it does while the terminal app that started
// this process has no Local Network access (worker-spec W6).
export class LocalNetworkRefused extends Error {}

const octetsOf = (address: string): number[] => (/^\d+\.\d+\.\d+\.\d+$/.test(address) ? address.split('.').map(Number) : [])

// Tailscale gives each machine an address in 100.64.0.0/10 and in fd7a:115c:a1e0::/48.
export function isTailscale(address: string): boolean {
  const [first, second = 0] = octetsOf(address)
  return (first === 100 && second >= 64 && second < 128) || address.toLowerCase().startsWith('fd7a:115c:a1e0:')
}

const isPrivate = (address: string): boolean => {
  const [first, second = 0] = octetsOf(address)
  return first === 10 || (first === 172 && second >= 16 && second < 32) || (first === 192 && second === 168)
}

// The addresses this machine offers viewers, Tailscale's first: its Tailscale addresses, and the private IPv4
// addresses of its physical interfaces, never a public, loopback or bridge address. A link-local IPv6 address names no
// interface of the viewer's, which only the viewer knows, so it is never offered.
export function offeredAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const all = Object.entries(interfaces).flatMap(([name, infos]) => (infos ?? []).filter((info) => !info.internal).map((info) => ({ name, address: info.address })))
  const tailscale = all.filter(({ address }) => isTailscale(address))
  const lan = all.filter(({ name, address }) => isPrivate(address) && !isTailscale(address) && !BRIDGE.test(name))
  return [...new Set([...tailscale, ...lan].map(({ address }) => address))]
}

const at = (address: string, port: number): string => (address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`)

// The cipher of one direction of the connection whose opening named `stream` and `viewerSalt`, and whose host answered
// `hostSalt`.
export function cipherOf(key: Uint8Array, stream: number, viewerSalt: Uint8Array, hostSalt: Uint8Array, direction: Direction): Cipher {
  const id = Buffer.alloc(4)
  id.writeUInt32BE(stream)
  const secret = Buffer.from(hkdfSync('sha256', key, Buffer.concat([id, viewerSalt, hostSalt]), `anyhost ${direction}`, 32))
  const nonceOf = (count: bigint): Buffer => {
    const nonce = Buffer.alloc(12)
    nonce.writeBigUInt64BE(count, 4)
    return nonce
  }
  let sealed = 0n
  let opened = 0n
  return {
    seal(frame) {
      const cipher = createCipheriv('aes-256-gcm', secret, nonceOf(sealed++))
      const body = Buffer.concat([cipher.update(frame), cipher.final(), cipher.getAuthTag()])
      const framed = Buffer.alloc(4 + body.length)
      framed.writeUInt32BE(body.length)
      body.copy(framed, 4)
      return framed
    },
    open(body) {
      if (body.length < TAG_BYTES) throw new Error(`A sealed frame holds its ${TAG_BYTES}-byte tag, and this one ${body.length} bytes.`)
      const decipher = createDecipheriv('aes-256-gcm', secret, nonceOf(opened++))
      decipher.setAuthTag(body.subarray(body.length - TAG_BYTES))
      return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()])
    },
  }
}

// Reads a connection's bytes: `opening` bytes in the clear, then frames of `u32 length` and that many bytes, each at
// most `limit()`. A callback that answers false closes the connection, and so does a frame past the limit.
function readFrames(socket: Socket, opening: number, limit: () => number, onOpening: (bytes: Buffer) => boolean, onFrame: (body: Buffer) => boolean): void {
  let pending: Buffer = Buffer.alloc(0)
  let isOpened = opening === 0
  socket.on('data', (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    if (!isOpened) {
      if (pending.length < opening) return
      isOpened = true
      const bytes = pending.subarray(0, opening)
      pending = pending.subarray(opening)
      if (!onOpening(bytes)) return void socket.destroy()
    }
    while (pending.length >= 4 && !socket.destroyed) {
      const size = pending.readUInt32BE(0)
      if (size > limit()) return void socket.destroy()
      if (pending.length < 4 + size) return
      const body = pending.subarray(4, 4 + size)
      pending = pending.subarray(4 + size)
      if (!onFrame(body)) return void socket.destroy()
    }
  })
}

// A connection whose hellos both opened: it seals every frame, pings every PING_MS, and ends once SILENCE_MS pass with
// nothing heard, or the connection closes. `heard` takes each sealed frame after the hello.
function linkOn(socket: Socket, address: string, seal: Cipher, open: Cipher, receive: (frame: Uint8Array) => void): { readonly link: DirectLink; readonly heard: (body: Buffer) => boolean } {
  let isEnded = false
  let endWith: (why: string) => void = () => undefined
  const ended = new Promise<string>((resolve) => (endWith = resolve))
  const end = (why: string): void => {
    if (isEnded) return
    isEnded = true
    clearInterval(pinger)
    clearTimeout(silence)
    socket.destroy()
    endWith(why)
  }
  const silence = setTimeout(() => end(`it brought nothing for ${SILENCE_MS / 1000} s`), SILENCE_MS)
  const pinger = setInterval(() => socket.write(seal.seal(EMPTY)), PING_MS)
  socket.on('error', (error) => end(error.message))
  socket.on('close', () => end('the other end closed it'))
  return {
    link: {
      address,
      ended,
      send: (frame) => void (isEnded || socket.write(seal.seal(frame))),
      close: () => end('this end closed it'),
    },
    heard(body) {
      silence.refresh()
      let frame: Buffer
      try {
        frame = open.open(body)
      } catch {
        end('a frame did not open under the stream\'s key')
        return false
      }
      if (frame.length > 0) receive(frame)
      return true
    },
  }
}

// The port this machine's direct connections reach: picked free at the first start, then the one `direct.json` keeps.
async function portIn(folder: string): Promise<number> {
  const file = Bun.file(join(folder, 'direct.json'))
  if (await file.exists()) {
    const { port } = (await file.json()) as { port?: unknown }
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${file.name} names no port: its port is ${JSON.stringify(port)}, not a whole number from 1 to 65535.`)
    return port
  }
  const free = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    free.once('error', reject)
    free.listen({ port: 0, host: '127.0.0.1' }, () => resolve((free.address() as { port: number }).port))
  })
  free.close()
  mkdirSync(folder, { recursive: true })
  await Bun.write(file, `${JSON.stringify({ port })}\n`)
  return port
}

// The host's side: one server per address it offers, all on the port `direct.json` keeps in `folder`. A bind that
// fails is a problem of its address, and the next offer tries it again.
export async function listenDirect(folder: string, problems: Problems, addresses: () => readonly string[] = offeredAddresses): Promise<DirectListener> {
  const port = await portIn(folder)
  const held = new Map<number, { readonly key: Buffer; readonly receive: (frame: Uint8Array) => void; readonly linked: (link: DirectLink) => void }>()
  const servers = new Map<string, Promise<Server | undefined>>()
  const sockets = new Set<Socket>()
  const accept = (socket: Socket): void => {
    sockets.add(socket)
    socket.setNoDelay(true)
    // a connection whose hello does not open under the key of the stream it named within SILENCE_MS gets nothing sealed
    const late = setTimeout(() => socket.destroy(), SILENCE_MS)
    socket.on('error', () => undefined)
    socket.on('close', () => {
      clearTimeout(late)
      sockets.delete(socket)
    })
    let opened: { readonly stream: number; readonly seal: Cipher; readonly open: Cipher } | undefined
    let heard: ((body: Buffer) => boolean) | undefined
    readFrames(
      socket,
      OPENING_BYTES,
      () => (heard === undefined ? TAG_BYTES : MAX_SEALED_BYTES),
      (opening) => {
        const stream = opening.readUInt32BE(0)
        const [viewerSalt, hostSalt] = [opening.subarray(4), randomBytes(SALT_BYTES)]
        socket.write(hostSalt)
        const holding = held.get(stream)
        // a stream this machine does not hold gets the salt too, and its hello opens under no key here
        if (holding !== undefined) opened = { stream, seal: cipherOf(holding.key, stream, viewerSalt, hostSalt, 'host to viewer'), open: cipherOf(holding.key, stream, viewerSalt, hostSalt, 'viewer to host') }
        return true
      },
      (body) => {
        if (heard !== undefined) return heard(body)
        const holding = opened === undefined ? undefined : held.get(opened.stream)
        if (opened === undefined || holding === undefined) return false
        try {
          if (opened.open.open(body).length > 0) return false
        } catch {
          return false
        }
        clearTimeout(late)
        socket.write(opened.seal.seal(EMPTY))
        const { link, heard: hear } = linkOn(socket, socket.localAddress ?? '', opened.seal, opened.open, holding.receive)
        heard = hear
        holding.linked(link)
        return true
      },
    )
  }
  const bind = (address: string): Promise<Server | undefined> =>
    new Promise((resolve) => {
      const server = createServer(accept)
      server.once('error', (error) => {
        problems.set(`direct ${at(address, port)}`, error)
        resolve(undefined)
      })
      server.listen({ port, host: address }, () => {
        problems.clear(`direct ${at(address, port)}`)
        server.on('error', (error) => problems.set(`direct ${at(address, port)}`, error))
        resolve(server)
      })
    })
  const offer = async (): Promise<DirectOffer> => {
    const wanted = addresses()
    for (const [address, server] of servers) {
      if (wanted.includes(address)) continue
      servers.delete(address)
      problems.clear(`direct ${at(address, port)}`)
      void server.then((bound) => bound?.close())
    }
    for (const address of wanted) if (!servers.has(address)) servers.set(address, bind(address))
    const bound: string[] = []
    for (const address of wanted) {
      if ((await servers.get(address)) !== undefined) bound.push(address)
      else servers.delete(address)
    }
    return { port, addresses: bound }
  }
  await offer()
  return {
    offer,
    hold: (stream, key, receive, linked) => void held.set(stream, { key: Buffer.from(key, 'base64'), receive, linked }),
    release: (stream) => void held.delete(stream),
    close() {
      for (const server of servers.values()) void server.then((bound) => bound?.close())
      servers.clear()
      for (const socket of sockets) socket.destroy()
      held.clear()
    },
  }
}

// macOS's own programs reach the local network whatever the terminal app's access, so a dial macOS refused while
// /usr/bin/nc reaches the same address is a refusal of that access.
async function isLocalNetworkRefusal(address: string, port: number, code: string | undefined): Promise<boolean> {
  if (process.platform !== 'darwin' || isTailscale(address) || (code !== 'EHOSTUNREACH' && code !== 'ECONNREFUSED')) return false
  const nc = Bun.spawn(['/usr/bin/nc', '-z', '-G', '2', address, String(port)], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  return (await nc.exited) === 0
}

// The viewer's side: dials every address the host offered, Tailscale's first, DIAL_APART_MS apart, and sends its hello
// on the first connection whose host answers with its salt, closing the others, so the host links one connection of
// the dial, the one this side keeps. It answers that link once the host's hello comes back, within SILENCE_MS of its
// dial. It answers undefined when no address answered, as on a network with no route to the host, and rejects with
// LocalNetworkRefused when macOS refused this process the local network.
export function dialDirect(offer: DirectOffer, stream: number, key: string, receive: (frame: Uint8Array) => void): Promise<DirectLink | undefined> {
  const secret = Buffer.from(key, 'base64')
  const addresses = [...offer.addresses.filter(isTailscale), ...offer.addresses.filter((address) => !isTailscale(address))]
  return new Promise((resolve, reject) => {
    // the error code of each address that answered no salt
    const failures: { readonly address: string; readonly code: string | undefined }[] = []
    const sockets = new Set<Socket>()
    let chosen: Socket | undefined
    const failed = (address: string, code: string | undefined): void => {
      failures.push({ address, code })
      if (chosen !== undefined || failures.length < addresses.length) return
      void (async () => {
        for (const failure of failures) {
          if (await isLocalNetworkRefusal(failure.address, offer.port, failure.code)) {
            return reject(new LocalNetworkRefused(`macOS refused anyhost attach a connection to ${at(failure.address, offer.port)} with ${failure.code}, while /usr/bin/nc reaches it, so the terminal app anyhost attach runs in has no Local Network access.`))
          }
        }
        resolve(undefined)
      })()
    }
    const dial = (address: string): void => {
      if (chosen !== undefined) return
      const viewerSalt = randomBytes(SALT_BYTES)
      // both directions' ciphers, from the host's salt on
      let seal: Cipher
      let open: Cipher
      const socket = connect({ host: address, port: offer.port })
      sockets.add(socket)
      let isOver = false
      const fail = (code?: string): void => {
        if (isOver) return
        isOver = true
        clearTimeout(late)
        sockets.delete(socket)
        socket.destroy()
        // the connection this side sent its hello on ends the dial
        if (socket === chosen) resolve(undefined)
        else failed(address, code)
      }
      const late = setTimeout(() => fail(), SILENCE_MS)
      socket.setNoDelay(true)
      socket.on('error', (error: NodeJS.ErrnoException) => fail(error.code))
      socket.on('close', () => fail())
      socket.on('connect', () => {
        const opening = Buffer.alloc(OPENING_BYTES)
        opening.writeUInt32BE(stream)
        viewerSalt.copy(opening, 4)
        socket.write(opening)
      })
      let heard: ((body: Buffer) => boolean) | undefined
      readFrames(
        socket,
        SALT_BYTES,
        () => (heard === undefined ? TAG_BYTES : MAX_SEALED_BYTES),
        // The host's salt: this side's hello, sealed under the keys both salts give, proves it holds the stream's key.
        // The host links each connection whose hello opens, the last in place of the one before, so only one gets it.
        (hostSalt) => {
          if (chosen !== undefined) return false
          chosen = socket
          for (const other of sockets) if (other !== socket) other.destroy()
          seal = cipherOf(secret, stream, viewerSalt, hostSalt, 'viewer to host')
          open = cipherOf(secret, stream, viewerSalt, hostSalt, 'host to viewer')
          socket.write(seal.seal(EMPTY))
          return true
        },
        // the host's hello, empty, which opens under the stream's key
        (body) => {
          if (heard !== undefined) return heard(body)
          try {
            if (open.open(body).length > 0) return false
          } catch {
            return false
          }
          isOver = true
          clearTimeout(late)
          const linked = linkOn(socket, address, seal, open, receive)
          heard = linked.heard
          resolve(linked.link)
          return true
        },
      )
    }
    for (const [index, address] of addresses.entries()) setTimeout(() => dial(address), index * DIAL_APART_MS)
  })
}
