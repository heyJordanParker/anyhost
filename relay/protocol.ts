// Every message, op and error the relay and the anyhost program exchange, and the relay's limits. The relay and
// `cli/src/relay.ts` both compile against this file, so it uses nothing but the language: no Worker or Bun API.

// A new relay keeps answering every protocol before its own, so machines on two versions work side by side.
export const RELAY_VERSION = 1
export const PROTOCOL_VERSION = 1

export const MAX_OPS = 100
// The bytes of a request's puts, and of an answer's gets. A larger object travels as its own HTTP request.
export const MAX_MESSAGE_BYTES = 1024 * 1024
export const INVITE_MS = 10 * 60_000
// What the R2 binding lists and deletes in one call.
export const MAX_KEYS = 1000

// The first byte of a binary WebSocket message.
export const REQUEST = 0x01
export const ANSWER = 0x02
export const STREAM = 0x03

// The codes the Pool closes a socket with: its token is unknown, its machine was removed, or a machine with its id
// and another name is connected, as a cloned machine is.
export const CLOSE_UNKNOWN_TOKEN = 4401
export const CLOSE_REMOVED = 4403
export const CLOSE_DEVICE_LIVE = 4409

export type ErrorCode =
  | 'invalid'
  | 'unknown_token'
  | 'removed'
  | 'invite_unknown'
  | 'invite_used'
  | 'invite_expired'
  | 'device_live'
  | 'unknown_device'
  | 'precondition'
  | 'held'
  | 'missing'
  | 'too_large'
  | 'length_required'
  | 'storage'
  | 'unavailable'
export type Refusal = { readonly error: ErrorCode; readonly message: string }

export type Roots = { readonly home: string; readonly claudeHome: string; readonly claudeTmp: string; readonly codexHome: string }
export type DeviceRef = { readonly id: string; readonly name: string }
export type JoiningDevice = DeviceRef & { readonly os: string; readonly arch: string; readonly roots: Roots }
// A removed machine stays listed with `removedAt`, so its sessions stay listed and resumable from its roots.
export type Device = JoiningDevice & { readonly connected: boolean; readonly joinedAt: string; readonly seenAt: string; readonly removedAt?: string }

// GET /v1/health
export type Health = { readonly relay: number; readonly protocol: number; readonly bucket: string }
// POST /v1/join: `invite` is an invite's code or the setup code.
export type JoinRequest = { readonly invite: string; readonly device: JoiningDevice }
export type Joined = Health & { readonly token: string; readonly device: DeviceRef }

// `none` is create-only, `match` an etag as R2 answers it, unquoted.
export type Condition = { readonly none: '*' } | { readonly match: string }

export type Op =
  | { readonly op: 'get'; readonly key: string }
  | { readonly op: 'put'; readonly key: string; readonly size: number; readonly if?: Condition; readonly holder?: string }
  | { readonly op: 'list'; readonly prefix: string; readonly cursor?: string }
  | { readonly op: 'delete'; readonly keys: readonly string[] }
  | { readonly op: 'claim'; readonly session: string; readonly take: boolean }
  | { readonly op: 'claims' }
  | { readonly op: 'devices' }
  | { readonly op: 'invite' }
  | { readonly op: 'remove'; readonly device: string }

export type Listed = { readonly key: string; readonly size: number; readonly modified: string }
export type Claim = DeviceRef & { readonly at: string }

// Each op's answer, in the position of its op. A `get` answered 200 carries `size` bytes in the answer's bytes.
export type Result =
  | { readonly status: 200; readonly etag: string; readonly size: number; readonly modified: string }
  | { readonly status: 200; readonly etag: string }
  | { readonly status: 200; readonly objects: readonly Listed[]; readonly cursor?: string }
  | { readonly status: 200; readonly previous?: DeviceRef; readonly told: boolean }
  | { readonly status: 200; readonly claims: Readonly<Record<string, Claim>> }
  | { readonly status: 200; readonly devices: readonly Device[] }
  | { readonly status: 200; readonly link: string; readonly expiresAt: string }
  | { readonly status: 200 }
  | { readonly status: 404 }
  | { readonly status: 412; readonly etag?: string }
  | { readonly status: 409; readonly holder: DeviceRef }
  | { readonly status: 413; readonly size: number; readonly etag: string }
  | ({ readonly status: 400 | 404 | 500 } & Refusal)

export type Request = { readonly id: number; readonly ops: readonly Op[] }
// A request the Pool refuses whole, as one over MAX_OPS, answers `error` instead of `results`.
export type Answer = { readonly id: number; readonly results: readonly Result[] } | ({ readonly id: number | null } & Refusal)

export type Released = { readonly t: 'released'; readonly session: string; readonly to: DeviceRef; readonly at: string }
export type Welcome = Health & { readonly t: 'welcome'; readonly device: DeviceRef; readonly waiting: readonly Released[] }

// What a machine sends another: the Pool routes it to every socket of `to`, a device id, adding `from`. `attached` and
// `detach` name only their stream, whose two machines the Pool knows from the `attach` that opened it. `key` is the
// base64 of the 32 random bytes that key the stream's direct connection, and `attached` is the host's answer, with the
// port and the addresses that connection reaches it at.
export type Routed =
  | { readonly t: 'move'; readonly id: string; readonly to: string; readonly session: string; readonly t3: boolean }
  | { readonly t: 'moved'; readonly id: string; readonly to: string; readonly ok: boolean; readonly error?: string }
  | { readonly t: 'attach'; readonly stream: number; readonly to: string; readonly session: string; readonly cols: number; readonly rows: number; readonly key: string }
  | { readonly t: 'attached'; readonly stream: number; readonly port: number; readonly addresses: readonly string[] }
  | { readonly t: 'detach'; readonly stream: number }
export type Delivered = Routed & { readonly from: DeviceRef }
// The Pool's answer to a message for a machine with no open socket, or to one it cannot read.
export type Offline = { readonly t: 'offline'; readonly id?: string; readonly stream?: number; readonly to: string }
export type Invalid = { readonly t: 'invalid'; readonly message: string }
export type FromPool = Welcome | Released | Delivered | Offline | Invalid

// The fix a cloned machine's person runs, named in the refusal of its join and its connect.
export function cloneFixFor(os: string): string {
  return os === 'darwin'
    ? 'Give this virtual Mac its own hardware UUID in its virtualization app, then restart it.'
    : 'Give it its own machine id with sudo rm /etc/machine-id && sudo systemd-machine-id-setup, then restart it.'
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// A request or an answer: its kind byte, its header as one JSON line, then its bytes back to back.
export function encodeMessage(kind: typeof REQUEST | typeof ANSWER, header: Request | Answer, parts: readonly Uint8Array[]): Uint8Array {
  const line = encoder.encode(`${JSON.stringify(header)}\n`)
  const message = new Uint8Array(1 + line.length + parts.reduce((total, part) => total + part.length, 0))
  message[0] = kind
  message.set(line, 1)
  let at = 1 + line.length
  for (const part of parts) {
    message.set(part, at)
    at += part.length
  }
  return message
}

export function decodeMessage(message: Uint8Array): { readonly header: unknown; readonly bytes: Uint8Array } {
  const end = message.indexOf(10)
  if (end < 0) throw new Error('The message has no header line.')
  return { header: JSON.parse(decoder.decode(message.subarray(1, end))), bytes: message.subarray(end + 1) }
}

// An attach stream's bytes: the kind byte, the stream id as 4 bytes big-endian, then one frame of the stream, which
// `cli/src/stream.ts` numbers: its kind, the offset of its first byte, and its bytes.
export function encodeStream(stream: number, bytes: Uint8Array): Uint8Array {
  const message = new Uint8Array(5 + bytes.length)
  message[0] = STREAM
  new DataView(message.buffer).setUint32(1, stream)
  message.set(bytes, 5)
  return message
}

export const streamOf = (message: Uint8Array): number => new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(1)
