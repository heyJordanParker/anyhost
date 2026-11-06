// The stream between `anyhost attach` and the program on the machine that runs the session, over any link to the other
// end, such as the relay. Each direction numbers its bytes, and a frame is its kind, the offset of its first byte and
// its bytes. Each side acknowledges what it took every ACK_MS, keeps what the other has not acknowledged, and takes a
// frame only at the offset it holds. So on each new link, a side names the offset it holds in its first frame and sends
// again every frame the other has not acknowledged, and no byte is lost or doubled across links.

export type Size = { readonly cols: number; readonly rows: number }
// Claude Code's own record of the session, as `claude agents --json` names it: its whole id and its `status`, such as
// `busy` during a turn, `waiting` at a question or a permission prompt, and `idle`.
export type SessionState = { readonly session: string; readonly status: string }
// The host ended the stream: code 0 once `claude attach` ended, or 1 with the reason it shows nothing.
export type Exit = { readonly code: number; readonly message: string }
// The session runs on the machine `to` names from now on, and the viewer attaches to it there.
export type Moved = { readonly to: string }

// What each kind of frame carries: the viewer sends `input` and `resize`, and the host `output`, `state`, `exit` and
// `moved`.
type Values = { readonly input: Uint8Array; readonly resize: Size; readonly output: Uint8Array; readonly state: SessionState; readonly exit: Exit; readonly moved: Moved }
export type Kind = keyof Values
// `lost` says why the stream ended on this side, as when its peer acknowledged nothing for MAX_WAITING bytes.
type Events = Values & { readonly lost: string }

// One way to the other end, which carries each frame whole and in order.
export type Link = { readonly send: (frame: Uint8Array) => void }

export type Stream = {
  write<K extends Kind>(kind: K, value: Values[K]): void
  on<K extends keyof Events>(kind: K, listener: (value: Events[K]) => void): void
  // the way to the other end from now on, or none, while frames wait for the next one
  use(link: Link | undefined): void
  // a frame the link brought
  receive(frame: Uint8Array): void
  close(): void
}

const KINDS: readonly Kind[] = ['input', 'resize', 'output', 'state', 'exit', 'moved']
// A side's first frame on each link: `start` on its first one, as it holds nothing yet, and `ack` on every later one.
const ACK = 7
const START = 8
const HEADER = 9
const ACK_MS = 100
// A full 120×40 screen of Claude Code took 6,442 bytes (worker-spec W7), so 8 MiB holds over a thousand screens.
const MAX_WAITING = 8 * 2 ** 20

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytesOf<K extends Kind>(kind: K, value: Values[K]): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (kind === 'resize') {
    const { cols, rows } = value as Size
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint16(0, cols)
    new DataView(bytes.buffer).setUint16(2, rows)
    return bytes
  }
  if (kind === 'exit') {
    const { code, message } = value as Exit
    return new Uint8Array([code, ...encoder.encode(message)])
  }
  return encoder.encode(JSON.stringify(value))
}

function valueOf(kind: Kind, bytes: Uint8Array): Values[Kind] {
  if (kind === 'input' || kind === 'output') return bytes
  if (kind === 'resize') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { cols: view.getUint16(0), rows: view.getUint16(2) }
  }
  if (kind === 'exit') return { code: bytes[0] ?? 1, message: decoder.decode(bytes.subarray(1)) }
  return JSON.parse(decoder.decode(bytes)) as SessionState | Moved
}

function frameOf(code: number, offset: number, bytes: Uint8Array = new Uint8Array()): Uint8Array {
  const frame = new Uint8Array(HEADER + bytes.length)
  const view = new DataView(frame.buffer)
  frame[0] = code
  view.setUint32(1, Math.floor(offset / 2 ** 32))
  view.setUint32(5, offset % 2 ** 32)
  frame.set(bytes, HEADER)
  return frame
}

export function openStream(): Stream {
  const listeners: Partial<Record<keyof Events, ((value: never) => void)[]>> = {}
  const emit = <K extends keyof Events>(kind: K, value: Events[K]): void => {
    for (const listener of listeners[kind] ?? []) (listener as (value: Events[K]) => void)(value)
  }
  let link: Link | undefined
  let wasLinked = false
  let sent = 0
  let received = 0
  let acknowledged = 0
  // every frame from the last offset the peer named on, in order
  let waiting: { readonly offset: number; readonly size: number; readonly frame: Uint8Array }[] = []
  let waitingBytes = 0
  let isClosed = false

  const timer = setInterval(() => {
    if (link === undefined || received === acknowledged) return
    acknowledged = received
    link.send(frameOf(ACK, received))
  }, ACK_MS)

  // The peer holds every byte before `offset`. A peer that names more than this side sent holds an earlier stream's
  // bytes, and this side keeps all it has.
  const peerHolds = (offset: number): void => {
    if (offset > sent) return
    const kept = waiting.filter((frame) => frame.offset + frame.size > offset)
    waitingBytes -= waiting.slice(0, waiting.length - kept.length).reduce((total, frame) => total + frame.size, 0)
    waiting = kept
  }

  const close = (): void => {
    isClosed = true
    link = undefined
    clearInterval(timer)
  }

  return {
    write(kind, value) {
      const bytes = bytesOf(kind, value)
      if (isClosed || bytes.length === 0) return
      const frame = frameOf(KINDS.indexOf(kind) + 1, sent, bytes)
      waiting.push({ offset: sent, size: bytes.length, frame })
      waitingBytes += bytes.length
      sent += bytes.length
      if (waitingBytes > MAX_WAITING) {
        close()
        emit('lost', `The other end acknowledged none of the last ${waitingBytes} bytes, past the ${MAX_WAITING} this side keeps.`)
        return
      }
      link?.send(frame)
    },
    on(kind, listener) {
      listeners[kind] = [...(listeners[kind] ?? []), listener]
    },
    use(next) {
      link = isClosed ? undefined : next
      if (link === undefined) return
      link.send(wasLinked ? frameOf(ACK, received) : frameOf(START, 0))
      wasLinked = true
      acknowledged = received
      for (const { frame } of waiting) link.send(frame)
    },
    receive(frame) {
      if (isClosed || frame.length < HEADER) return
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
      const code = frame[0] ?? 0
      const offset = view.getUint32(1) * 2 ** 32 + view.getUint32(5)
      // A peer that starts after this side took its bytes lost the stream, as a restarted program does, so this side
      // starts over from nothing too. What it sent and the peer never acknowledged may have reached the peer's
      // terminal, so it goes nowhere again.
      if (code === START && received > 0) [sent, received, acknowledged, waiting, waitingBytes] = [0, 0, 0, [], 0]
      if (code === START || code === ACK) return peerHolds(offset)
      const kind = KINDS[code - 1]
      const bytes = frame.subarray(HEADER)
      // a frame this side took already, or one past a gap, which the next link's first frame sends again
      if (kind === undefined || offset !== received || bytes.length === 0) return
      received += bytes.length
      emit(kind, valueOf(kind, bytes) as never)
    },
    close,
  }
}
