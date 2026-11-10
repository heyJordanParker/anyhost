import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import plugin from '../../.claude-plugin/plugin.json'
import type * as Protocol from '../../relay/protocol.ts'
import { openCapture, type Capture } from './capture.ts'
import { connectCloudflare, join, type Connecting, type Progress } from './connect.ts'
import { cmodDevice, deviceFromEnvironment, forgetRelayLogin, inviteMachine, machinesOf, otherMachine, personOptions, relayLogin, removeMachine, rootsHere } from './device.ts'
import { doctor } from './doctor.ts'
import type { Moving } from './move.ts'
import { connectRelay } from './relay.ts'
import { openSession, repoSlug, resumeHere } from './resume.ts'
import { runSession } from './runner.ts'
import { serve, serveSocket, type JoinedRelay, type Status } from './serve.ts'
import { listSessions, type ListedSession } from './sessions.ts'

const USAGE = `anyhost ${plugin.version} keeps every Claude Code and Codex session of every machine in your own Cloudflare account.

  anyhost list [--json]              list every session of every machine
  anyhost resume <session> [--take]  continue a Claude Code or Codex session on this machine, in this terminal
  anyhost move <session> <machine>   move a session this machine runs to another machine, which runs it from then on
  anyhost new <machine> <folder> [prompt]
                                     start a session on a machine, this one too, in the same repository, and type prompt into it
  anyhost tell <session> [text]      type text into a session wherever it runs, waking it, and print its screen; no text only prints it
  anyhost run [--session <id>] [-- <claude command>]
                                     run Claude Code, ending its process while it rests and resuming it at the next key
  anyhost connect                    set your relay up in your Cloudflare account and join this machine to it
  anyhost join <link>                join this machine with an invite link from another machine
  anyhost machines [--json]          list every machine joined to your relay
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

// One answer of this machine's program at its unix socket, as the mod's askProgram asks it: a GET, or a POST of `body`
// as JSON. It answers undefined when no program answers there, and throws the program's own message when it refuses.
async function askProgram<T>(path: string, body?: object): Promise<T | undefined> {
  const unix = serveSocket()
  const answer = await fetch(`http://localhost${path}`, { unix, ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }).catch(() => undefined)
  if (answer === undefined) return undefined
  const read = (await answer.json()) as T & { readonly message?: string }
  if (!answer.ok) throw new Error(read.message ?? `The anyhost program at ${unix} answered ${path} with ${answer.status}.`)
  return read
}

const noProgram = (): Error => new Error(`The anyhost program does not answer at ${serveSocket()}. Start Claude Code on this machine, and the anyhost mod starts it.`)

// Asks this machine's program to move the session, as /move in the session does, since only the program holds the
// session's upload queue, and prints each step of the move until it ends, however long the move waits. Ctrl-C ends
// only the command, as the move runs in the program.
async function moveThroughProgram(session: string, machine: string): Promise<number> {
  const started = await askProgram<{ readonly session: string }>('/move', { session, machine })
  if (started === undefined) throw noProgram()
  process.once('SIGINT', () => {
    console.log(`The move of ${started.session.slice(0, 8)} to ${machine} goes on. Keep it here in the session takes the session back.`)
    process.exit(130)
  })
  let said = ''
  for (;;) {
    // the program's /claims/<session> answer carries the move it runs, as serve.ts serves it, and a program that
    // restarts answers nothing for a moment, then knows no move
    const { move } = (await askProgram<{ readonly move?: Pick<Moving, 'step' | 'line'> }>(`/claims/${started.session}`)) ?? {}
    if (move === undefined) throw new Error(`The anyhost program at ${serveSocket()} restarted during the move, so it no longer knows where ${session} is.`)
    if (move.line !== said) (move.step === 'failed' ? console.error : console.log)(move.line)
    said = move.line
    if (move.step === 'moved' || move.step === 'failed') return move.step === 'moved' ? 0 : 1
    await Bun.sleep(FOLLOW_MS)
  }
}

// Asks this machine's program to start a session on the machine named `machine` for `folder`, since the relay sends
// that machine's answer to the sockets this machine has open as it comes, and only the program's own socket stays open
// while the session starts. The program waits for its relay, and so does the command, saying so first when the relay
// is not connected, until Ctrl-C ends it. Answers the session.
async function startThroughProgram(machine: string, folder: string, prompt: string): Promise<string> {
  const status = await askProgram<Status>('/status')
  if (status === undefined) throw noProgram()
  const { relay } = status
  if (relay.state !== 'connected') console.log(`Waiting for the relay at ${relay.url} to connect.${relay.message === '' ? '' : ` ${relay.message}`} Ctrl-C stops waiting.`)
  // the program works in a folder of its own
  const started = await askProgram<{ readonly session: string }>('/new', { machine, folder: resolve(folder), prompt })
  if (started === undefined) throw new Error(`The anyhost program at ${serveSocket()} stopped answering before ${machine} started a session. anyhost list shows whether it did.`)
  return started.session
}

// Asks this machine's program to join, as the Step does, since the program saves the login in turn with its forget of
// a login the relay refused. With no program answering, no forget runs, and the join runs here.
async function joinThroughProgram(link: string): Promise<string> {
  const joined = await askProgram<JoinedRelay>('/join', { link })
  if (joined === undefined) return await join(link, await cmodDevice())
  return joined.url
}

// Asks this machine's program to run Connect Cloudflare, as the Step does, since the program saves the login in turn
// with its forget of a login the relay refused, and follows it once a second, printing each line and asking each
// question on the terminal. The program's service environment has no CLOUDFLARE_API_TOKEN, so the request carries this
// command's, over the program's unix socket, for that run alone. With no program answering, Connect Cloudflare runs
// here.
async function connectThroughProgram(): Promise<void> {
  const started = await askProgram<Connecting>('/connect', { apiToken: process.env['CLOUDFLARE_API_TOKEN'] })
  if (started === undefined) return await connectCloudflare(TERMINAL, await cmodDevice())
  // a program that stops during the run, as at a restart, answers nothing for a moment
  const during = async <T>(path: string, body?: object): Promise<T> => {
    const asked = await askProgram<T>(path, body)
    if (asked === undefined) throw new Error(`The anyhost program at ${serveSocket()} stopped answering during Connect Cloudflare. Run anyhost connect again once it runs.`)
    return asked
  }
  let view = started
  for (let said = 0; ; ) {
    for (const line of view.lines.slice(said)) TERMINAL.say(line)
    said = view.lines.length
    if (view.is === 'joined') return
    if (view.is === 'failed') throw new Error(view.error ?? 'Connect Cloudflare failed.')
    if (view.accounts !== undefined) view = await during<Connecting>('/connect/account', { id: (await TERMINAL.pickAccount(view.accounts)).id })
    else if (view.r2Page !== undefined) {
      await TERMINAL.enableR2(view.r2Page)
      view = await during<Connecting>('/connect/r2', {})
    } else {
      await Bun.sleep(FOLLOW_MS)
      // a program that started again since knows no run
      const { connecting } = await during<Status>('/status')
      if (connecting === undefined) throw new Error(`The anyhost program at ${serveSocket()} restarted during Connect Cloudflare. Run anyhost connect again.`)
      view = connecting
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
  if (argv[0] === 'run') {
    const split = argv.indexOf('--')
    const { values: run } = parseArgs({ args: argv.slice(1, split < 0 ? undefined : split), options: { session: { type: 'string' } } })
    const command = split < 0 ? [] : argv.slice(split + 1)
    process.exit(await runSession(command.length === 0 ? ['claude'] : command, run.session))
  }
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
  // the program answers from the socket it keeps to the relay, so a command opens one only while no program runs
  if (command === 'machines' && rest.length === 0 && values.invite !== true && values.remove === undefined) {
    const { here, machines } = (await askProgram<{ readonly here: string; readonly machines: Protocol.Device[] }>('/machines')) ?? (await connected(async ({ relay, device }) => ({ here: device.id, machines: await machinesOf(relay) })))
    console.log(values.json === true ? JSON.stringify({ here, machines }) : machineTable(machines, here))
    return 0
  }
  if (command === 'list') {
    const sessions = (await askProgram<{ readonly agents: ListedSession[] }>('/agents'))?.agents ?? (await connected(async ({ relay }) => await listSessions(relay)))
    console.log(values.json === true ? JSON.stringify(sessions, null, 2) : table(sessions))
    return 0
  }
  if (command === 'resume' && rest.length === 1 && rest[0] !== undefined) {
    const id = rest[0]
    const { checkouts } = await personOptions()
    // the session opens once the connection is closed, as it runs for as long as the person works in it
    const { tool, cwd } = await connected(async (capture) => await resumeHere(capture, id, { take: values.take === true, checkouts: checkouts ?? '' }))
    return await openSession(tool, id, cwd)
  }
  if (command === 'move' && rest.length === 2 && rest[0] !== undefined && rest[1] !== undefined) return await moveThroughProgram(rest[0], rest[1])
  if (command === 'new' && (rest.length === 2 || rest.length === 3) && rest[0] !== undefined && rest[1] !== undefined) {
    const [machine, folder, prompt = ''] = rest
    const session = await startThroughProgram(machine, folder, prompt)
    console.log(`${machine} started ${session.slice(0, 8)} in a terminal of herdr-core there.`)
    return 0
  }
  if (command === 'tell' && (rest.length === 1 || rest.length === 2) && rest[0] !== undefined) {
    const told = await askProgram<{ readonly machine: string; readonly screen: string }>('/agents/tell', { session: rest[0], text: rest[1] ?? '' })
    if (told === undefined) throw noProgram()
    console.log(told.screen)
    return 0
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
