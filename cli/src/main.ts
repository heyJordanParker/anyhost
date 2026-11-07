import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import plugin from '../../.claude-plugin/plugin.json'
import type * as Protocol from '../../relay/protocol.ts'
import { attach } from './attach.ts'
import { openCapture, type Capture } from './capture.ts'
import { connectCloudflare, join, type Connecting, type Progress } from './connect.ts'
import { cmodDevice, deviceFromEnvironment, forgetRelayLogin, inviteMachine, machinesOf, otherMachine, personOptions, relayLogin, removeMachine, rootsHere } from './device.ts'
import { doctor } from './doctor.ts'
import { startNew, type Moving } from './move.ts'
import { connectRelay } from './relay.ts'
import { openSession, repoSlug, restore } from './resume.ts'
import { serve, serveSocket, type JoinedRelay, type Status } from './serve.ts'
import { listSessions, type ListedSession } from './sessions.ts'

const USAGE = `anyhost ${plugin.version} keeps every Claude Code and Codex session of every machine in your own Cloudflare account.

  anyhost list [--json]              list every session of every machine
  anyhost resume <session> [--take]  continue a Claude Code or Codex session on this machine
  anyhost attach <session>           show a session the machine that holds it runs, and type into it
  anyhost move <session> <machine>   move a session this machine runs to another machine, which runs it from then on
  anyhost new <machine> <folder>     start a session on another machine in the same repository, and show it here
  anyhost connect                    set your relay up in your Cloudflare account and join this machine to it
  anyhost join <link>                join this machine with an invite link from another machine
  anyhost machines                   list every machine joined to your relay
  anyhost machines --invite          print the command that joins one more machine
  anyhost machines --remove <name>   remove a machine; its sessions stay listed and resumable
  anyhost doctor                     check this machine's relay, the machine and the program
  anyhost serve                      capture this machine's sessions, as the anyhost mod runs it
  anyhost --version                  print the version`

const cut = (text: string, length: number): string => (text.length > length ? `${text.slice(0, length - 1)}…` : text)
const minute = (at: string): string => at.slice(0, 16).replace('T', ' ')

function columns(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)))
  return [header, ...rows].map((row) => row.map((value, column) => value.padEnd(widths[column] ?? 0)).join('  ').trimEnd()).join('\n')
}

function table(sessions: readonly ListedSession[]): string {
  const home = homedir()
  const rows = sessions.map((session) => [
    session.id,
    session.tool,
    session.entrypoint || '-',
    session.machine,
    session.holder || '-',
    minute(session.lastActivity),
    session.repo === '' ? '-' : repoSlug(session.repo).split('/').slice(-2).join('/'),
    cut(session.cwd.startsWith(home) ? `~${session.cwd.slice(home.length)}` : session.cwd, 40),
    cut(session.title || '-', 40),
    cut(session.firstPrompt || '-', 60),
  ])
  return columns(['SESSION', 'TOOL', 'ENTRYPOINT', 'MACHINE', 'HOLDER', 'LAST ACTIVITY', 'REPOSITORY', 'FOLDER', 'TITLE', 'FIRST PROMPT'], rows)
}

const machineTable = (machines: readonly Protocol.Device[], here: string): string =>
  columns(
    ['MACHINE', 'OS', 'STATE'],
    machines.map((machine) => [machine.id === here ? `${machine.name} (this machine)` : machine.name, `${machine.os}-${machine.arch}`, machine.connected ? 'connected' : `last seen ${minute(machine.seenAt)}`]),
  )

// how often anyhost move and anyhost connect read the program's step, as the mod's /move and Step do
const FOLLOW_MS = 1000

// Asks this machine's program to move the session, as /move in the session does, since only the program holds the
// session's upload queue, and prints each step of the move until it ends.
async function moveThroughProgram(session: string, machine: string): Promise<number> {
  const unix = serveSocket()
  const asked = await fetch('http://localhost/move', { unix, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session, machine }) }).catch(() => undefined)
  if (asked === undefined) throw new Error(`The anyhost program does not answer at ${unix}. Start Claude Code on this machine, and the anyhost mod starts it.`)
  const started = (await asked.json()) as { readonly session: string; readonly message?: string }
  if (!asked.ok) throw new Error(started.message ?? `The anyhost program at ${unix} answered the move with ${asked.status}.`)
  let said = ''
  for (;;) {
    // the program's /claims/<session> answer carries the move it runs, as serve.ts serves it
    const { move } = (await (await fetch(`http://localhost/claims/${started.session}`, { unix })).json()) as { readonly move?: Pick<Moving, 'step' | 'line'> }
    if (move === undefined) throw new Error(`The anyhost program at ${unix} restarted during the move, so it no longer knows where ${session} is.`)
    if (move.line !== said) (move.step === 'failed' ? console.error : console.log)(move.line)
    said = move.line
    if (move.step === 'moved' || move.step === 'failed') return move.step === 'moved' ? 0 : 1
    await Bun.sleep(FOLLOW_MS)
  }
}

// Asks this machine's program to join, as the Step does, since the program saves the login in turn with its forget of
// a login the relay refused. With no program answering, no forget runs, and the join runs here.
async function joinThroughProgram(link: string): Promise<string> {
  const unix = serveSocket()
  const asked = await fetch('http://localhost/join', { unix, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link }) }).catch(() => undefined)
  if (asked === undefined) return await join(link, await cmodDevice())
  const joined = (await asked.json()) as Partial<JoinedRelay> & { readonly message?: string }
  if (!asked.ok || joined.url === undefined) throw new Error(joined.message ?? `The anyhost program at ${unix} answered the join with ${asked.status}.`)
  return joined.url
}

// The Connect Cloudflare the program's answer carries, or why it gave none.
async function connectingOf(unix: string, answer: Response): Promise<Connecting> {
  const read = (await answer.json()) as Connecting & { readonly message?: string }
  if (!answer.ok) throw new Error(read.message ?? `The anyhost program at ${unix} answered Connect Cloudflare with ${answer.status}.`)
  return read
}

// Asks this machine's program to run Connect Cloudflare, as the Step does, since the program saves the login in turn
// with its forget of a login the relay refused, and follows it once a second, printing each line and asking each
// question on the terminal. With no program answering, Connect Cloudflare runs here.
async function connectThroughProgram(): Promise<void> {
  const unix = serveSocket()
  const post = (path: string, body: object): Promise<Response> => fetch(`http://localhost${path}`, { unix, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const started = await post('/connect', {}).catch(() => undefined)
  if (started === undefined) return await connectCloudflare(TERMINAL, await cmodDevice())
  let view = await connectingOf(unix, started)
  for (let said = 0; ; ) {
    for (const line of view.lines.slice(said)) TERMINAL.say(line)
    said = view.lines.length
    if (view.is === 'joined') return
    if (view.is === 'failed') throw new Error(view.error ?? 'Connect Cloudflare failed.')
    if (view.accounts !== undefined) view = await connectingOf(unix, await post('/connect/account', { id: (await TERMINAL.pickAccount(view.accounts)).id }))
    else if (view.r2Page !== undefined) {
      await TERMINAL.enableR2(view.r2Page)
      view = await connectingOf(unix, await post('/connect/r2', {}))
    } else {
      await Bun.sleep(FOLLOW_MS)
      // a program that stops during the run, as at a restart, answers nothing for a moment, then knows no run
      const status = await fetch('http://localhost/status', { unix }).then(
        async (answer) => (await answer.json()) as Status,
        (error: unknown) => new Error(`The anyhost program at ${unix} stopped answering during Connect Cloudflare (${error instanceof Error ? error.message : String(error)}). Run anyhost connect again once it runs.`),
      )
      if (status instanceof Error) throw status
      if (status.connecting === undefined) throw new Error(`The anyhost program at ${unix} restarted during Connect Cloudflare. Run anyhost connect again.`)
      view = status.connecting
    }
  }
}

// The person answers each question Connect Cloudflare asks on the terminal, one line each.
let lines: AsyncIterator<string> | undefined
async function answer(question: string): Promise<string> {
  console.log(question)
  lines ??= console[Symbol.asyncIterator]()
  const { value, done } = await lines.next()
  if (done === true) throw new Error('Connect Cloudflare stopped, as the terminal sent no answer.')
  return String(value).trim()
}

const TERMINAL: Progress = {
  say: (line) => console.log(line),
  async pickAccount(accounts) {
    const numbered = accounts.map((account, index) => `  ${index + 1}  ${account.name}`).join('\n')
    for (;;) {
      const picked = accounts[Number(await answer(`Your Cloudflare login reaches ${accounts.length} accounts:\n${numbered}\nType the number of the account your relay goes in:`)) - 1]
      if (picked !== undefined) return picked
    }
  },
  enableR2: async () => void (await answer('Press Enter once R2 is on.')),
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: 'boolean' }, take: { type: 'boolean' }, invite: { type: 'boolean' }, remove: { type: 'string' }, version: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  })
  const [command, ...rest] = positionals
  if (values.version === true) {
    console.log(plugin.version)
    return 0
  }
  // A command keeps its own connection to the relay while it runs, and fails once the relay cannot be reached.
  const connected = async <T>(work: (capture: Capture) => Promise<T>): Promise<T> => {
    const device = await cmodDevice()
    const roots = rootsHere()
    const relay = connectRelay({ login: relayLogin, forget: forgetRelayLogin, device, roots, isPatient: false })
    try {
      return await work(openCapture(relay, device, roots))
    } finally {
      relay.close()
    }
  }
  if (command === 'connect' && rest.length === 0) {
    await connectThroughProgram()
    return 0
  }
  if (command === 'join' && rest.length === 1 && rest[0] !== undefined) {
    console.log(`Joined this machine to ${await joinThroughProgram(rest[0])}`)
    return 0
  }
  if (command === 'machines' && rest.length === 0 && values.invite === true && values.remove === undefined) {
    const { command: install, expiresAt } = await connected(async ({ relay }) => await inviteMachine(relay))
    console.log(`Paste this on the machine to join, before ${minute(expiresAt)} UTC. It joins one machine.\n\n${install}`)
    return 0
  }
  if (command === 'machines' && rest.length === 0 && values.remove !== undefined && values.invite !== true) {
    const name = values.remove
    const removed = await connected(async ({ relay, device }) => {
      const machine = await otherMachine(relay, device, name, 'Remove it from another machine.')
      await removeMachine(relay, machine.id)
      return machine
    })
    console.log(`Removed ${removed.name}. Its sessions stay listed and resumable.`)
    return 0
  }
  if (command === 'machines' && rest.length === 0 && values.invite !== true && values.remove === undefined) {
    console.log(await connected(async ({ relay, device }) => machineTable(await machinesOf(relay), device.id)))
    return 0
  }
  if (command === 'list') {
    const sessions = await connected(async ({ relay }) => await listSessions(relay))
    console.log(values.json === true ? JSON.stringify(sessions, null, 2) : table(sessions))
    return 0
  }
  if (command === 'resume' && rest.length === 1 && rest[0] !== undefined) {
    const id = rest[0]
    const { checkouts } = await personOptions()
    // the session opens once the connection is closed, as it runs for as long as the person works in it
    const { session, cwd } = await connected(async (capture) => await restore(capture, id, { take: values.take === true, checkouts: checkouts ?? '' }))
    return await openSession(session, cwd)
  }
  if (command === 'attach' && rest.length === 1 && rest[0] !== undefined) return await attach(rest[0])
  if (command === 'move' && rest.length === 2 && rest[0] !== undefined && rest[1] !== undefined) return await moveThroughProgram(rest[0], rest[1])
  if (command === 'new' && rest.length === 2 && rest[0] !== undefined && rest[1] !== undefined) {
    const [machine, folder] = rest
    // the session shows here once the connection is closed, as it runs for as long as the person works in it
    const session = await connected(async (capture) => await startNew(capture, machine, folder))
    console.log(`${machine} started ${session.slice(0, 8)}.`)
    return await attach(session)
  }
  if (command === 'doctor') return await doctor()
  if (command === 'serve') {
    await serve(deviceFromEnvironment())
    return 0
  }
  console.log(USAGE)
  return command === undefined || values.help === true ? 0 : 2
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
