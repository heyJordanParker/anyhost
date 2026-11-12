import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import plugin from '../../.claude-plugin/plugin.json'
import type * as Protocol from '../../relay/protocol.ts'
import { openCapture, type Capture } from './capture.ts'
import { connectCloudflare, join, type Connecting, type Progress } from './connect.ts'
import { cmodDevice, deviceFromEnvironment, forgetRelayLogin, inviteMachine, machinesOf, otherMachine, personOptions, relayLogin, removeMachine, rootsHere } from './device.ts'
import { doctor } from './doctor.ts'
import type { Moving, Told } from './move.ts'
import { connectRelay } from './relay.ts'
import { openSession, repoSlug, resumeHere } from './resume.ts'
import { runSession } from './runner.ts'
import { serve, serveSocket, type JoinedRelay, type Status } from './serve.ts'
import { agentsOf, type Agents, type ListedSession } from './sessions.ts'

const USAGE = `anyhost ${plugin.version} keeps every Claude Code and Codex session of every machine in your own Cloudflare account.

  anyhost list [--json]              list every session of every machine
  anyhost resume <session> [--take]  continue a Claude Code or Codex session on this machine, in this terminal
  anyhost open <session> [--json]    run a session on this machine in a terminal of herdr-core, the one it runs in already when it does,
                                     and print that terminal: one in tmux comes in once its turn ends, one another machine holds comes here
  anyhost move <session> <machine>   move a session this machine runs to another machine, which runs it from then on
  anyhost new <machine> <folder> [prompt]
                                     start a session on a machine, this one too, in the same repository, and type prompt into it
  anyhost tell <session> [text]      type text into a session wherever it runs, waking it, and print its screen; no text only prints it
  anyhost tell <session> --messages <count>
                                     print the last messages of a session's conversation, wherever it is held, running or not
  anyhost run [--session <id>] [-- <claude command>]
                                     run Claude Code with your login environment, and end it after 8 hours unused off screen
  anyhost connect                    set your relay up in your Cloudflare account and join this machine to it
  anyhost join <link>                join this machine with an invite link from another machine
  anyhost archive <session> [--undo] move a session out of the active list on every machine, or bring it back
  anyhost archive --after <days|never>
                                     archive a session by itself once it sits idle that many days, or never
  anyhost visit <session> [--at <time>]
                                     mark a session read on every machine up to now or that ISO time, earlier than its last turn marks it unread
  anyhost delete <session>           stop a session and delete its files on the machine that holds it; Deleted lists it, and opening it brings it back
  anyhost machines [--json]          list every machine joined to your relay
  anyhost machines --add <ssh target>
                                     install anyhost on a machine ssh reaches and join it, so every machine shows it
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

const FOLLOW_MS = 1000

async function askProgram<T>(path: string, body?: object): Promise<T | undefined> {
  const unix = serveSocket()
  const answer = await fetch(`http://localhost${path}`, { unix, ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }).catch(() => undefined)
  if (answer === undefined) return undefined
  const read = (await answer.json()) as T & { readonly message?: string }
  if (!answer.ok) throw new Error(read.message ?? `The anyhost program at ${unix} answered ${path} with ${answer.status}.`)
  return read
}

const noProgram = (): Error => new Error(`The anyhost program does not answer at ${serveSocket()}. Start Claude Code on this machine, and the anyhost mod starts it.`)

async function moveThroughProgram(session: string, machine: string): Promise<number> {
  const started = await askProgram<{ readonly session: string }>('/move', { session, machine })
  if (started === undefined) throw noProgram()
  process.once('SIGINT', () => {
    console.log(`The move of ${started.session.slice(0, 8)} to ${machine} goes on. Keep it here in the session takes the session back.`)
    process.exit(130)
  })
  let said = ''
  for (;;) {
    const { move } = (await askProgram<{ readonly move?: Pick<Moving, 'step' | 'line'> }>(`/claims/${started.session}`)) ?? {}
    if (move === undefined) throw new Error(`The anyhost program at ${serveSocket()} restarted during the move, so it no longer knows where ${session} is.`)
    if (move.line !== said) (move.step === 'failed' ? console.error : console.log)(move.line)
    said = move.line
    if (move.step === 'moved' || move.step === 'failed') return move.step === 'moved' ? 0 : 1
    await Bun.sleep(FOLLOW_MS)
  }
}

async function startThroughProgram(machine: string, folder: string, prompt: string): Promise<string> {
  const status = await askProgram<Status>('/status')
  if (status === undefined) throw noProgram()
  const { relay } = status
  if (relay.state !== 'connected') console.log(`Waiting for the relay at ${relay.url} to connect.${relay.message === '' ? '' : ` ${relay.message}`} Ctrl-C stops waiting.`)
  const started = await askProgram<{ readonly session: string }>('/new', { machine, folder: resolve(folder), prompt })
  if (started === undefined) throw new Error(`The anyhost program at ${serveSocket()} stopped answering before ${machine} started a session. anyhost list shows whether it did.`)
  return started.session
}

async function joinThroughProgram(link: string): Promise<string> {
  const joined = await askProgram<JoinedRelay>('/join', { link })
  if (joined === undefined) return await join(link, await cmodDevice())
  return joined.url
}

async function connectThroughProgram(): Promise<void> {
  const started = await askProgram<Connecting>('/connect', { apiToken: process.env['CLOUDFLARE_API_TOKEN'] })
  if (started === undefined) return await connectCloudflare(TERMINAL, await cmodDevice())
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
      const { connecting } = await during<Status>('/status')
      if (connecting === undefined) throw new Error(`The anyhost program at ${serveSocket()} restarted during Connect Cloudflare. Run anyhost connect again.`)
      view = connecting
    }
  }
}

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
    options: {
      json: { type: 'boolean' },
      brief: { type: 'boolean' },
      take: { type: 'boolean' },
      invite: { type: 'boolean' },
      add: { type: 'string' },
      remove: { type: 'string' },
      undo: { type: 'boolean' },
      after: { type: 'string' },
      at: { type: 'string' },
      messages: { type: 'string' },
      version: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, ...rest] = positionals
  if (values.version === true) {
    console.log(plugin.version)
    return 0
  }
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
  if (command === 'machines' && rest.length === 0 && values.add !== undefined) {
    const target = values.add
    if ((await askProgram('/machines/add', { target })) === undefined) throw noProgram()
    console.log(`Adding ${target}: herdr-core, cmod and anyhost install there, and it joins your relay.`)
    for (;;) {
      await Bun.sleep(FOLLOW_MS)
      const { adding } = (await askProgram<{ readonly adding: readonly { readonly target: string; readonly error?: string }[] }>('/machines')) ?? { adding: [] }
      const add = adding.find((each) => each.target === target)
      if (add?.error !== undefined) throw new Error(add.error)
      if (add === undefined) break
    }
    console.log(`Added ${target}. Its sessions show on every machine, and the Herdr app reaches it.`)
    return 0
  }
  if (command === 'machines' && rest.length === 0 && values.invite !== true && values.remove === undefined) {
    const listed = (await askProgram<{ readonly here: string; readonly machines: Protocol.Device[] }>('/machines')) ?? (await connected(async ({ relay, device }) => ({ here: device.id, machines: await machinesOf(relay) })))
    console.log(values.json === true ? JSON.stringify(listed) : machineTable(listed.machines, listed.here))
    return 0
  }
  if (command === 'list') {
    const listed = (await askProgram<Agents>('/agents')) ?? (await connected(async (capture) => await agentsOf(capture)))
    const brief = values.brief === true ? { ...listed, agents: listed.agents.map(({ id, tool, title, firstPrompt, cwd, repo, machine, holder, entrypoint, lastActivity, status, archived, visitedAt, deleted, parent }) => ({ id, tool, title: title || firstPrompt.slice(0, 120), cwd, repo, machine, holder, entrypoint, lastActivity, status, archived, visitedAt, deleted: deleted === true, parent })) } : listed
    console.log(values.json === true ? JSON.stringify(brief, null, values.brief === true ? undefined : 2) : table(listed.agents))
    return 0
  }
  if (command === 'archive' && rest.length === 1 && rest[0] !== undefined && values.after === undefined) {
    if ((await askProgram('/agents/archive', { session: rest[0], archived: values.undo !== true })) === undefined) throw noProgram()
    return 0
  }
  if (command === 'archive' && rest.length === 0 && values.after !== undefined) {
    const days = values.after === 'never' ? null : Number(values.after)
    if (days !== null && !(days > 0)) throw new Error(`anyhost archive --after takes a number of days or never, not ${values.after}.`)
    if ((await askProgram('/settings', { archiveAfterDays: days })) === undefined) throw noProgram()
    return 0
  }
  if (command === 'visit' && rest.length === 1 && rest[0] !== undefined) {
    const at = values.at ?? new Date().toISOString()
    if (Number.isNaN(Date.parse(at))) throw new Error(`anyhost visit --at takes an ISO time, such as 2026-11-11T16:00:00.000Z, not ${at}.`)
    if ((await askProgram('/agents/visit', { session: rest[0], at: new Date(at).toISOString() })) === undefined) throw noProgram()
    return 0
  }
  if (command === 'delete' && rest.length === 1 && rest[0] !== undefined) {
    const deleted = await askProgram<{ readonly session: string }>('/agents/delete', { session: rest[0] })
    if (deleted === undefined) throw noProgram()
    console.log(`Deleted ${deleted.session.slice(0, 8)}. Deleted lists it, and opening it brings it back.`)
    return 0
  }
  if (command === 'resume' && rest.length === 1 && rest[0] !== undefined) {
    const id = rest[0]
    const { checkouts } = await personOptions()
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
  if (command === 'open' && rest.length === 1 && rest[0] !== undefined) {
    const opened = await askProgram<{ readonly session: string; readonly terminal: string; readonly machine: string }>('/agents/open', { session: rest[0] })
    if (opened === undefined) throw noProgram()
    console.log(values.json === true ? JSON.stringify(opened) : `${opened.session.slice(0, 8)} runs on ${opened.machine} in terminal ${opened.terminal} of herdr-core.`)
    return 0
  }
  if (command === 'tell' && (rest.length === 1 || rest.length === 2) && rest[0] !== undefined) {
    const messages = Number(values.messages ?? 0)
    if (!Number.isInteger(messages) || messages < 0) throw new Error(`--messages takes a count of messages, not ${values.messages}.`)
    const told = await askProgram<Pick<Told, 'screen' | 'messages'>>('/agents/tell', { session: rest[0], text: rest[1] ?? '', messages })
    if (told === undefined) throw noProgram()
    console.log(told.messages === undefined ? told.screen : values.json === true ? JSON.stringify(told.messages) : told.messages.map(({ role, at, text }) => `${role} ${at}\n${text}\n`).join('\n'))
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
