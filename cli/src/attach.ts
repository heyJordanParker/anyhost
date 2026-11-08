// The pane's side of a session: `anyhost attach <session>` shows it in this terminal and types into it, as if it ran
// here. It streams through this machine's program, which shows a session this machine holds itself and reaches the
// machine that holds any other, so every viewer of a session shares its one `claude attach` there. It attaches again by
// itself after the link or either machine's program went away, until that `claude attach` ends for good. Once the host
// answers with its addresses, this process dials it directly, as macOS judges a dial to the local network by the
// terminal app that started the process, and the stream goes over that connection while it lasts.
import { run } from './background.ts'
import { dialDirect, isTailscale, LocalNetworkRefused, offeredAddresses, type DirectLink, type DirectOffer } from './direct.ts'
import { waitAfter } from './relay.ts'
import { serveSocket } from './serve.ts'
import { openStream, randomStreamId, type Link, type Size } from './stream.ts'

// A viewer waiting to dial the host again dials at once when the addresses this machine dials from changed, as on a
// new network.
const ADDRESSES_MS = 1000
// The state herdr shows of an agent, by Claude Code's `status` of the session. `claude agents` names a session that
// waits for its first prompt `blocked` in its `state` too, which herdr shows as a question to answer, so its status
// decides.
const HERDR_STATES: Readonly<Record<string, string>> = { busy: 'working', waiting: 'blocked', idle: 'idle' }

const sizeHere = (): Size => ({ cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 })
// the Tailscale and private LAN addresses a direct dial goes from, so a Docker `veth` coming or going starts none
const addressesHere = (): string => offeredAddresses().join(' ')

// The terminal modes Claude Code sets, off again: the alternate screen, a hidden cursor, the modes Claude Code's
// daemon records for a session (bracketed paste, color scheme reports, focus, mouse), the kitty keyboard flags it pushes
// and modifyOtherKeys. Claude Code turns them off as its own `claude attach` ends, which a viewer whose session ended
// on the host never sees.
const RESET_TERMINAL = '\x1b[?1049l\x1b[?25h\x1b[?2004l\x1b[?2031l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[<u\x1b[>4m\x1b[0m'

// herdr knows the agent of a pane by its foreground program, which is anyhost here, so each state the host sends is
// reported for the pane, with the command that shows the session again after herdr restarts.
async function reportToHerdr(session: string, status: string): Promise<string | undefined> {
  const pane = process.env['HERDR_PANE_ID']
  if (pane === undefined || pane === '') return undefined
  const argv = ['herdr', 'pane', 'report-agent', '--source', 'anyhost', '--agent', 'claude', '--state', HERDR_STATES[status] ?? 'unknown', '--agent-session-id', session, pane, '--', 'anyhost', 'attach', session]
  return await run(argv).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
}

const newKey = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')

// The session through this machine's program, whose WebSocket at /attach takes the attach.
export function attach(asked: string): Promise<number> {
  const frames = openStream()
  let id = randomStreamId()
  let key = newKey()
  // what went wrong while the terminal was the session's, said once it is this terminal's again
  const problems = new Set<string>()
  let session = asked
  let socket: WebSocket | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  let wasAttached = false
  let isDone = false
  // The way through this machine's program and the relay, from the host's `attached` on, and the direct connection to
  // the host, which carries the stream whenever it is up.
  let leg: Link | undefined
  // the id of the host's end of the stream this side last linked with, which the host's `attached` names
  let hostStream: number | undefined
  let direct: DirectLink | undefined
  let offer: DirectOffer | undefined
  let isDialing = false
  let dials = 0
  let redial: ReturnType<typeof setTimeout> | undefined
  return new Promise((resolve) => {
    // ends the stream, gives the terminal back and answers `code`
    const finish = (code: number, message = ''): void => {
      if (isDone) return
      isDone = true
      clearTimeout(retry)
      clearTimeout(redial)
      direct?.close()
      frames.close()
      socket?.close()
      if (wasAttached) process.stdout.write(RESET_TERMINAL)
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdin.pause()
      for (const problem of [...problems, ...(message === '' ? [] : [message])]) console.error(problem)
      resolve(code)
    }
    const attachMessage = (): string => JSON.stringify({ t: 'attach', stream: id, session, ...sizeHere(), key })
    // This machine's program keeps what the last dial says of the terminal app's Local Network access, for anyhost
    // doctor, and an empty problem says a dial to the local network went through.
    const tellLocalNetwork = (problem: string): void => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'localNetwork', problem }))
    }
    const dial = (): void => {
      clearTimeout(redial)
      if (isDone || direct !== undefined || isDialing || offer === undefined || offer.addresses.length === 0) return
      isDialing = true
      const started = Date.now()
      const addresses = addressesHere()
      const dialed = id
      dialDirect(offer, id, key, (frame) => frames.receive(frame)).then(
        (link) => {
          isDialing = false
          if (link === undefined) return dialAgain(started, addresses)
          if (isDone) return link.close()
          // A session that moved meanwhile runs on another machine, which the offer of the next attach names, and the
          // `attached` that brought it dialed nothing while this dial ran.
          if (dialed !== id) {
            link.close()
            return dial()
          }
          // No `attached` came since the last link went, so the host may hold a new stream, as a restarted program
          // does, which only its next `attached` says, and which dials again.
          if (leg === undefined) return link.close()
          direct = link
          dials = 0
          frames.use(link)
          if (!isTailscale(link.address)) tellLocalNetwork('')
          void link.ended.then(() => {
            if (direct !== link) return
            direct = undefined
            frames.use(leg)
            dialAgain(Date.now(), addressesHere())
          })
        },
        (error: unknown) => {
          isDialing = false
          if (error instanceof LocalNetworkRefused) {
            problems.add(error.message)
            tellLocalNetwork(error.message)
          }
          dialAgain(started, addresses)
        },
      )
    }
    // the next dial after 1, 2, 4 and up to 60 seconds from the last one's start, or at once when this machine's
    // addresses changed since it
    const dialAgain = (since: number, addresses: string): void => {
      if (isDone) return
      dials += 1
      const due = since + waitAfter(dials)
      const check = (): void => {
        if (Date.now() >= due || addressesHere() !== addresses) return dial()
        redial = setTimeout(check, Math.min(ADDRESSES_MS, due - Date.now()))
      }
      check()
    }
    // The same attach again after `waitAfter` the failed tries in a row, at once with none. A failed try is an attach
    // this machine's program answered `offline` with no `at`, or a socket to the program that closed. A `detach` counts
    // none and starts the count over, as one comes only after a frame on a linked leg, a socket's close or a welcome,
    // when the path is back or the next attach's answer says it is not.
    const again = (): void => {
      leg = undefined
      if (direct === undefined) frames.use(undefined)
      clearTimeout(retry)
      retry = setTimeout(() => (socket?.readyState === WebSocket.OPEN ? socket.send(attachMessage()) : connect()), waitAfter(failures))
    }
    // The stream's host so far holds it no more, as after `moved` or an `attached` of another host stream: its direct
    // connection closes, the stream starts over for the next host, and the next dial goes at once.
    const leaveHost = (): void => {
      clearTimeout(redial)
      dials = 0
      const link = direct
      direct = undefined
      link?.close()
      frames.startOver()
    }
    const connect = (): void => {
      const ws = new WebSocket(`ws+unix://${serveSocket()}:/attach`)
      ws.binaryType = 'arraybuffer'
      socket = ws
      let isOpen = false
      ws.addEventListener('open', () => {
        isOpen = true
        ws.send(attachMessage())
      })
      ws.addEventListener('message', (event) => {
        if (socket !== ws) return
        if (typeof event.data !== 'string') return frames.receive(new Uint8Array(event.data as ArrayBuffer))
        const message = JSON.parse(event.data) as { readonly t: string; readonly message?: string; readonly hostStream?: number; readonly at?: number } & Partial<DirectOffer>
        if (message.t === 'attached') {
          wasAttached = true
          failures = 0
          clearTimeout(retry)
          // A host stream this side never linked with, as a restarted host program or one that forgot the viewer opens,
          // takes the stream from its first byte, and the keys no link carried meanwhile reach it, even when this side
          // missed that host's earlier `attached`.
          if (message.hostStream !== hostStream) leaveHost()
          hostStream = message.hostStream
          leg = { send: (frame) => ws.send(frame) }
          offer = { port: message.port ?? 0, addresses: message.addresses ?? [] }
          if (direct === undefined) frames.use(leg)
          dial()
        } else if (message.t === 'invalid') finish(1, message.message)
        // the link to the host is gone, as one of the two machines' relay sockets went
        else if (message.t === 'detach') {
          failures = 0
          again()
        }
        // offline: the machine that holds the session, or this machine's relay, is gone for now
        else {
          if (message.at === undefined) failures += 1
          again()
          // the frame at `at` and every one after it went nowhere, as this machine's relay was down, while a direct
          // connection sends every frame its host did not acknowledge anyway
          if (message.at !== undefined && direct === undefined) frames.refused(message.at)
        }
      })
      ws.addEventListener('close', () => {
        if (socket !== ws || isDone) return
        if (!isOpen && !wasAttached && failures === 0) return finish(1, `The anyhost program does not answer at ${serveSocket()}. Start Claude Code on this machine, and the anyhost mod starts it.`)
        failures += 1
        again()
      })
    }
    frames.on('output', (bytes) => void process.stdout.write(bytes))
    frames.on('state', ({ session: whole, status }) => {
      session = whole
      void reportToHerdr(whole, status).then((problem) => (problem === undefined ? undefined : problems.add(problem)))
    })
    frames.on('exit', ({ code, message }) => finish(code, message))
    // The session moved to another machine, which holds it now: this machine's program attaches it again where it went,
    // on a new stream to its new host, which starts from its first byte, so the keys typed meanwhile reach it there.
    frames.on('moved', () => {
      offer = undefined
      leg = undefined
      hostStream = undefined
      leaveHost()
      id = randomStreamId()
      key = newKey()
      if (socket?.readyState === WebSocket.OPEN) socket.send(attachMessage())
    })
    frames.on('lost', (why) => finish(1, why))
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.on('data', (chunk: Buffer) => frames.write('input', new Uint8Array(chunk)))
    // a terminal that closed ends its input, and the viewer with it
    process.stdin.on('end', () => finish(0))
    process.stdout.on('resize', () => frames.write('resize', sizeHere()))
    connect()
  })
}
