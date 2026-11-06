// The pane's side of a session: `anyhost attach <session>` shows it in this terminal and types into it, as if it ran
// here. It streams through this machine's program, which shows a session this machine holds itself and reaches the
// machine that holds any other, so every viewer of a session shares its one `claude attach` there. It attaches again by
// itself after the link or either machine's program went away, until that `claude attach` ends for good.
import { serveSocket } from './serve.ts'
import { openStream, type Size } from './stream.ts'

// The waits between tries to attach again, as the relay's socket waits between its tries.
const RETRY_MS = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000]
// The state herdr shows of an agent, by Claude Code's `status` of the session. `claude agents` names a session that
// waits for its first prompt `blocked` in its `state` too, which herdr shows as a question to answer, so its status
// decides.
const HERDR_STATES: Readonly<Record<string, string>> = { busy: 'working', waiting: 'blocked', idle: 'idle' }

const sizeHere = (): Size => ({ cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 })

// herdr knows the agent of a pane by its foreground program, which is anyhost here, so each state the host sends is
// reported for the pane, with the command that shows the session again after herdr restarts.
async function reportToHerdr(session: string, status: string): Promise<string | undefined> {
  const pane = process.env['HERDR_PANE_ID']
  if (pane === undefined || pane === '') return undefined
  const argv = ['herdr', 'pane', 'report-agent', '--source', 'anyhost', '--agent', 'claude', '--state', HERDR_STATES[status] ?? 'unknown', '--agent-session-id', session, pane, '--', 'anyhost', 'attach', session]
  const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
  const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
  return code === 0 ? undefined : `herdr pane report-agent exited with ${code}: ${error.trim()}`
}

// The session through this machine's program, whose WebSocket at /attach takes the attach.
export function attach(asked: string): Promise<number> {
  const frames = openStream()
  const id = new DataView(crypto.getRandomValues(new Uint8Array(4)).buffer).getUint32(0)
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
  // what went wrong while the terminal was the session's, said once it is this terminal's again
  const problems = new Set<string>()
  let session = asked
  let socket: WebSocket | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  let wasAttached = false
  let isDone = false
  return new Promise((resolve) => {
    // ends the stream, gives the terminal back and answers `code`
    const finish = (code: number, message = ''): void => {
      if (isDone) return
      isDone = true
      clearTimeout(retry)
      frames.close()
      socket?.close()
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdin.pause()
      for (const problem of [...problems, ...(message === '' ? [] : [message])]) console.error(problem)
      resolve(code)
    }
    const attachMessage = (): string => JSON.stringify({ t: 'attach', stream: id, session, ...sizeHere(), key })
    const again = (): void => {
      frames.use(undefined)
      clearTimeout(retry)
      const wait = RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]
      failures += 1
      retry = setTimeout(() => (socket?.readyState === WebSocket.OPEN ? socket.send(attachMessage()) : connect()), wait)
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
        const message = JSON.parse(event.data) as { readonly t: string; readonly message?: string }
        if (message.t === 'attached') {
          wasAttached = true
          failures = 0
          frames.use({ send: (frame) => ws.send(frame) })
        } else if (message.t === 'invalid') finish(1, message.message)
        // detach or offline: the link or the machine that holds the session is gone for now
        else again()
      })
      ws.addEventListener('close', () => {
        if (socket !== ws || isDone) return
        if (!isOpen && !wasAttached && failures === 0) return finish(1, `The anyhost program does not answer at ${serveSocket()}. Start Claude Code on this machine, and the anyhost mod starts it.`)
        again()
      })
    }
    frames.on('output', (bytes) => void process.stdout.write(bytes))
    frames.on('state', ({ session: whole, status }) => {
      session = whole
      void reportToHerdr(whole, status).then((problem) => (problem === undefined ? undefined : problems.add(problem)))
    })
    frames.on('exit', ({ code, message }) => finish(code, message))
    frames.on('lost', (why) => finish(1, why))
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.on('data', (chunk: Buffer) => frames.write('input', new Uint8Array(chunk)))
    process.stdout.on('resize', () => frames.write('resize', sizeHere()))
    connect()
  })
}
