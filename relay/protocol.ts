export const RELAY_VERSION = 4
export const PROTOCOL_VERSION = 2
export const COMPATIBILITY_DATE = '2026-11-01'

export const MAX_OPS = 100
export const MAX_MESSAGE_BYTES = 1024 * 1024
export const INVITE_MS = 10 * 60_000
export const PING_MS = 30_000
export const LIVE_MS = 45_000
export const MAX_KEYS = 1000

export const REQUEST = 0x01
export const ANSWER = 0x02

export const CLOSE_UNKNOWN_TOKEN = 4401
export const CLOSE_REMOVED = 4403
export const CLOSE_DEVICE_LIVE = 4409

export const REMOVED_REASON = 'This machine was removed from your machines.'
export const REMOVED_MESSAGE = `${REMOVED_REASON} Join it again with a link from Add a machine.`

export const tokenOf = (authorization: string | null): string => authorization?.replace(/^Bearer /, '') ?? ''

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
export type Device = JoiningDevice & { readonly connected: boolean; readonly seenAt: string; readonly removedAt?: string }

export type Health = { readonly relay: number; readonly protocol: number; readonly bucket: string }
export type JoinRequest = { readonly invite: string; readonly device: JoiningDevice }
export type Joined = Health & { readonly token: string; readonly device: DeviceRef }

export type Condition = { readonly none: '*' } | { readonly match: string }

export const conditionHeaders = (condition: Condition): Record<string, string> => ('none' in condition ? { 'if-none-match': '*' } : { 'if-match': `"${condition.match}"` })

export type TakeCondition = { readonly at: string } | { readonly gone: true }

export type Op =
  | { readonly op: 'get'; readonly key: string; readonly if?: { readonly noneMatch: string } }
  | { readonly op: 'put'; readonly key: string; readonly size: number; readonly if?: Condition; readonly holder?: string }
  | { readonly op: 'list'; readonly prefix: string; readonly cursor?: string }
  | { readonly op: 'delete'; readonly keys: readonly string[] }
  | { readonly op: 'claim'; readonly session: string; readonly take: boolean; readonly if?: TakeCondition }
  | { readonly op: 'claims'; readonly prefix?: string }
  | { readonly op: 'changes'; readonly since: number }
  | { readonly op: 'forget'; readonly session: string }
  | { readonly op: 'devices' }
  | { readonly op: 'invite' }
  | { readonly op: 'remove'; readonly device: string }

export type Listed = { readonly key: string; readonly size: number }

export type Results = {
  readonly get: { readonly status: 200; readonly etag: string; readonly size: number } | { readonly status: 304; readonly etag: string } | { readonly status: 404 } | { readonly status: 413; readonly size: number; readonly etag: string }
  readonly put: { readonly status: 200; readonly etag: string } | { readonly status: 412; readonly etag?: string } | { readonly status: 409; readonly holder: DeviceRef }
  readonly list: { readonly status: 200; readonly objects: readonly Listed[]; readonly cursor?: string }
  readonly delete: { readonly status: 200 }
  readonly claim:
    | { readonly status: 200; readonly told: true; readonly at: string }
    | { readonly status: 200; readonly previous: DeviceRef; readonly told: false; readonly at: string }
    | { readonly status: 409; readonly holder: DeviceRef }
  readonly claims: { readonly status: 200; readonly claims: Readonly<Record<string, DeviceRef>> }
  readonly changes: { readonly status: 200; readonly changes: readonly Claimed[]; readonly last: number }
  readonly forget: { readonly status: 200 } | { readonly status: 409; readonly holder: DeviceRef }
  readonly devices: { readonly status: 200; readonly devices: readonly Device[] }
  readonly invite: { readonly status: 200; readonly link: string; readonly expiresAt: string }
  readonly remove: { readonly status: 200 }
}
export type Result = Results[Op['op']] | ({ readonly status: 400 | 404 | 500 } & Refusal)

export type Request = { readonly id: number; readonly ops: readonly Op[] }
export type Answer = { readonly id: number; readonly results: readonly Result[] } | ({ readonly id: number | null } & Refusal)

export type Released = { readonly t: 'released'; readonly session: string; readonly to: DeviceRef; readonly at: string }
export type Heard = { readonly t: 'heard'; readonly session: string; readonly to: string }
export type Welcome = Health & { readonly t: 'welcome'; readonly device: DeviceRef; readonly waiting: readonly Released[]; readonly changed: number }
export type Claimed = { readonly t: 'claimed'; readonly changed: number; readonly session: string; readonly device: string }

export type Routed =
  | { readonly t: 'move'; readonly id: string; readonly to: string; readonly session: string; readonly trusted: boolean; readonly claimedAt: string; readonly command: readonly string[] }
  | { readonly t: 'moved'; readonly id: string; readonly to: string }
  | { readonly t: 'moved'; readonly id: string; readonly to: string; readonly error: string }
  | { readonly t: 'start'; readonly id: string; readonly to: string; readonly repo: string; readonly branch: string; readonly folder: string; readonly trusted: boolean; readonly prompt: string; readonly sender?: string }
  | { readonly t: 'started'; readonly id: string; readonly to: string; readonly session: string }
  | { readonly t: 'started'; readonly id: string; readonly to: string; readonly error: string }
  | { readonly t: 'tell'; readonly id: string; readonly to: string; readonly session: string; readonly text: string; readonly keys: readonly string[]; readonly lines: number; readonly sender: string; readonly messages?: number }
  | { readonly t: 'told'; readonly id: string; readonly to: string; readonly status: AgentStatus; readonly screen: string; readonly messages?: readonly Message[] }
  | { readonly t: 'told'; readonly id: string; readonly to: string; readonly error: string }
  | { readonly t: 'delete'; readonly id: string; readonly to: string; readonly session: string }
  | { readonly t: 'deleted'; readonly id: string; readonly to: string; readonly session: string }
  | { readonly t: 'deleted'; readonly id: string; readonly to: string; readonly error: string }
  | { readonly t: 'list'; readonly id: string; readonly to: string }
  | { readonly t: 'listed'; readonly id: string; readonly to: string; readonly statuses: Readonly<Record<string, AgentStatus>> }
export type AgentStatus = 'working' | 'idle' | 'waiting'
export type Message = { readonly role: 'user' | 'assistant'; readonly at: string; readonly text: string }
export type Delivered = Routed & { readonly from: DeviceRef }
export type Offline = { readonly t: 'offline'; readonly id?: string; readonly to: string }
export type Invalid = { readonly t: 'invalid'; readonly message: string }
export type FromPool = Welcome | Released | Claimed | Delivered | Offline | Invalid

export function cloneFixFor(os: string): string {
  return os === 'darwin'
    ? 'Give this virtual Mac its own hardware UUID in its virtualization app, then restart it.'
    : 'Give it its own machine id with sudo rm /etc/machine-id && sudo systemd-machine-id-setup, then restart it.'
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

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
