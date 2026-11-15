import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import plugin from '../../.claude-plugin/plugin.json'
import type * as Protocol from '../../relay/protocol.ts'
import { openCapture, type Capture } from './capture.ts'
import { forgetClaudeMarkers } from './claude.ts'
import { connectCloudflare, join, type Connecting, type Progress } from './connect.ts'
import { cmodDevice, deviceFromEnvironment, forgetRelayLogin, inviteMachine, machinesOf, otherMachine, personOptions, relayLogin, removeMachine, rootsHere, stateFolder } from './device.ts'
import { doctor } from './doctor.ts'
import type { Moving, Told } from './move.ts'
import { connectRelay } from './relay.ts'
import { openSession, repoSlug, restoreData, resumeHere } from './resume.ts'
import { askProgram, PROGRAM_RESTART_MS, serve, serveSocket, type JoinedRelay, type Status } from './serve.ts'
import { agentsOf, type Agents, type ListedSession } from './sessions.ts'
import { SETTLE_MOST_DAYS } from './shared.ts'

const USAGE = `anyhost ${plugin.version} keeps every Claude Code and Codex session of every machine in your own Cloudflare account.

  anyhost list [--json] [--wait <version>]
                                     list every session of every machine, once the list moved past that version
  anyhost resume <session> [--take]  continue a Claude Code or Codex session on this machine, in this terminal
  anyhost resume --data <mod> --from <machine>
                                     place a machine's copy of a mod's data folder into this machine's empty one, which this machine keeps from then on
  anyhost open <session> [--json]    run a session on this machine in a terminal of herdr-core, the one it runs in already when it does,
                                     and print that terminal: one in tmux comes in once its turn ends, one another machine holds comes here
  anyhost move <session> <machine>   move a session this machine runs to another machine, which runs it from then on
  anyhost new <machine> <folder> [prompt] [--json]
                                     start a session on a machine, this one too, in the same repository, and type prompt into it
  anyhost tell <session> [text]      type text into a session wherever it runs, waking it, and print its screen; no text only prints it
  anyhost tell <session> --messages <count> [--skip <count>]
                                     print the last messages of a session's conversation, wherever it is held, running or not;
                                     --skip leaves out that many of the newest, to page back through its history
  anyhost sleep <session>            stop a session's Claude Code and close its terminal once its turn ends; a message or an open starts it again
  anyhost show <session> [focus|peek|tab|right|down|hide]
                                     show a session's terminal on this machine's Herdr app: focus it, peek at it, in a tab,
                                     beside or below the focused pane, or take its pane away while it runs on
  anyhost tell <session> --keys <key>
                                     press a named key in a session wherever it runs, such as 1, enter, esc or down, and print its screen
  anyhost connect                    set your relay up in your Cloudflare account and join this machine to it
  anyhost join <link>                join this machine with an invite link from another machine
  anyhost archive <session> [--undo] move a session out of the sidebar into the Archived list on every machine, or bring it back
  anyhost settle <session> [--undo]  mark a session settled on every machine until its next message, or keep it from settling by itself
  anyhost settle --after <days|never>
                                     settle an idle session by itself once it sits idle that many days, from 1 to 90, or never
  anyhost snooze <session> <time|--undo>
                                     hide a session on every machine until that ISO time, a prompt to it, or its wait for you, or wake it now
  anyhost project-name <project> [<name>|--undo]
                                     name a project, by its owner/name key, on every machine, or go back to its own name
  anyhost pin <session> [--undo]     pin a session to the top of every machine's list, where it never settles by itself, or unpin it
  anyhost organize '<json list>'     change tags and stages every machine shows: defineTag, dropTag, tagSession, defineStages, stageSession
  anyhost visit <session> [--at <time>]
                                     mark a session read on every machine up to now or that ISO time, earlier than its last turn marks it unread
  anyhost delete <session>           stop a session and delete its files on the machine that holds it; Deleted lists it, and opening it brings it back
  anyhost fork <session> [--at <message>] [--open]
                                     copy a Claude Code session's conversation up to a message's uuid, by default its end, into a new session
                                     on the machine that holds it, which uploads only what the copy adds; --open runs the copy here
  anyhost machines [--json]          list every machine joined to your relay
  anyhost machines --add <ssh target>
                                     install anyhost on a machine ssh reaches and join it, so every machine shows it
  anyhost machines --invite          print the command that joins one more machine
  anyhost machines --remove <name>   remove a machine; its sessions stay listed and resumable
  anyhost doctor                     check this machine's relay, the machine and the program
  anyhost shown <window> [terminal...]
                                     say which terminals a Herdr window shows, as the Herdr pane does, so their sessions stay awake and read
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
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      brief: { type: 'boolean' },
      take: { type: 'boolean' },
      data: { type: 'string' },
      from: { type: 'string' },
      invite: { type: 'boolean' },
      add: { type: 'string' },
      remove: { type: 'string' },
      undo: { type: 'boolean' },
      after: { type: 'string' },
      wait: { type: 'string' },
      skip: { type: 'string' },
      at: { type: 'string' },
      open: { type: 'boolean' },
      messages: { type: 'string' },
      keys: { type: 'string', multiple: true },
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
    const listed = (await askProgram<Agents>(values.wait === undefined ? '/agents' : `/agents?after=${Number(values.wait)}`, undefined, existsSync(serveSocket()) ? PROGRAM_RESTART_MS : 0)) ?? (await connected(async (capture) => ({ ...(await agentsOf(capture)), here: capture.device.id, machines: await machinesOf(capture.relay) })))
    const brief = values.brief === true ? { ...listed, agents: listed.agents.map(({ id, tool, title, cwd, repo, repoFolder, machine, holder, entrypoint, lastSaid, lastActivity, lastPromptAt, status, terminal, archived, settled, settledAt, snoozedUntil, visitedAt, deleted, parent, source, pinned, tags, stage }) => ({ id, tool, title, terminal, cwd, repo, repoFolder, machine, holder, entrypoint, lastSaid: (lastSaid ?? '').slice(0, 160), lastActivity, lastPromptAt: lastPromptAt ?? '', status, archived, settled, settledAt, snoozedUntil, visitedAt, deleted: deleted === true, parent, source: source ?? '', pinned, tags, stage })) } : listed
    console.log(values.json === true ? JSON.stringify(brief, null, values.brief === true ? undefined : 2) : table(listed.agents))
    return 0
  }
  if (command === 'archive' && rest.length === 1 && rest[0] !== undefined) {
    if ((await askProgram('/agents/archive', { session: rest[0], archived: values.undo !== true }, PROGRAM_RESTART_MS)) === undefined) throw noProgram()
    return 0
  }
  if (command === 'settle' && rest.length === 1 && rest[0] !== undefined && values.after === undefined) {
    if ((await askProgram('/agents/settle', { session: rest[0], settled: values.undo !== true }, PROGRAM_RESTART_MS)) === undefined) throw noProgram()
    return 0
  }
  if (command === 'settle' && rest.length === 0 && values.after !== undefined) {
    const days = values.after === 'never' ? null : Number(values.after)
    if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= SETTLE_MOST_DAYS)) throw new Error(`anyhost settle --after takes a whole number of days from 1 to ${SETTLE_MOST_DAYS}, or never, not ${values.after}.`)
    if ((await askProgram('/settings', { settleAfterDays: days }, PROGRAM_RESTART_MS)) === undefined) throw noProgram()
    return 0
  }
  if (command === 'snooze' && rest[0] !== undefined && (values.undo === true ? rest.length === 1 : rest.length === 2)) {
    const until = values.undo === true ? null : (rest[1] ?? '')
    if (until !== null && Number.isNaN(Date.parse(until))) throw new Error(`anyhost snooze takes the ISO time the session wakes, such as 2026-11-16T09:00:00.000Z, or --undo, not ${until}.`)
    if ((await askProgram('/agents/snooze', { session: rest[0], until: until === null ? null : new Date(until).toISOString() }, PROGRAM_RESTART_MS)) === undefined) throw noProgram()
    return 0
  }
  if (command === 'project-name' && rest[0] !== undefined && (values.undo === true ? rest.length === 1 : rest.length === 2)) {
    if ((await askProgram('/projects/name', { project: rest[0], name: values.undo === true ? null : (rest[1] ?? '') }, PROGRAM_RESTART_MS)) === undefined) throw noProgram()
    return 0
  }
  if (command === 'pin' && rest.length === 1 && rest[0] !== undefined) {
    if ((await askProgram('/agents/pin', { session: rest[0], pinned: values.undo !== true }, PROGRAM_RESTART_MS)) === undefined) throw noProgram()
    return 0
  }
  if (command === 'organize' && rest.length === 1 && rest[0] !== undefined) {
    const changes = JSON.parse(rest[0]) as unknown
    if (!Array.isArray(changes)) throw new Error('anyhost organize takes a JSON list of changes, such as [{"op":"stageSession","session":"1a2b3c4d","stage":"review"}].')
    if ((await askProgram('/organize', { changes }, PROGRAM_RESTART_MS)) === undefined) throw noProgram()
    return 0
  }
  if (command === 'visit' && rest.length === 1 && rest[0] !== undefined) {
    const at = values.at ?? new Date().toISOString()
    if (Number.isNaN(Date.parse(at))) throw new Error(`anyhost visit --at takes an ISO time, such as 2026-11-11T16:00:00.000Z, not ${at}.`)
    if ((await askProgram('/agents/visit', { session: rest[0], at: new Date(at).toISOString() }, PROGRAM_RESTART_MS)) === undefined) throw noProgram()
    return 0
  }
  if (command === 'delete' && rest.length === 1 && rest[0] !== undefined) {
    const deleted = await askProgram<{ readonly session: string }>('/agents/delete', { session: rest[0] })
    if (deleted === undefined) throw noProgram()
    console.log(`Deleted ${deleted.session.slice(0, 8)}. Deleted lists it, and opening it brings it back.`)
    return 0
  }
  if (command === 'fork' && rest.length === 1 && rest[0] !== undefined) {
    const forked = await askProgram<{ readonly session: string; readonly machine: string }>('/agents/fork', { session: rest[0], at: values.at ?? '' })
    if (forked === undefined) throw noProgram()
    const opened = values.open === true ? await askProgram<{ readonly terminal: string; readonly machine: string }>('/agents/open', { session: forked.session }) : undefined
    if (values.open === true && opened === undefined) throw noProgram()
    console.log(`Forked ${rest[0].slice(0, 8)} into ${forked.session}${opened === undefined ? ` on ${forked.machine}` : `, which runs on ${opened.machine} in terminal ${opened.terminal} of herdr-core`}.`)
    return 0
  }
  if (command === 'resume' && rest.length === 0 && values.data !== undefined && values.from !== undefined) {
    const { data: mod, from } = values
    const { folder, files } = await connected(async (capture) => await restoreData(capture, mod, from))
    console.log(`Placed ${files} files of ${mod}'s data from ${from} into ${folder}, which ${mod}'s history on this machine keeps from now on.`)
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
    console.log(values.json === true ? JSON.stringify({ session, machine }) : `${machine} started ${session.slice(0, 8)} in a terminal of herdr-core there.`)
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
    const skip = Number(values.skip ?? 0)
    if (!Number.isInteger(skip) || skip < 0) throw new Error(`--skip takes a count of messages, not ${values.skip}.`)
    const told = await askProgram<Pick<Told, 'screen' | 'messages'>>('/agents/tell', { session: rest[0], text: rest[1] ?? '', keys: values.keys ?? [], messages, skip })
    if (told === undefined) throw noProgram()
    console.log(told.messages === undefined ? told.screen : values.json === true ? JSON.stringify(told.messages) : told.messages.map(({ role, at, text }) => `${role} ${at}\n${text}\n`).join('\n'))
    return 0
  }
  if (command === 'show' && (rest.length === 1 || rest.length === 2) && rest[0] !== undefined) {
    const shown = await askProgram<{ readonly session: string; readonly machine: string; readonly terminal: string }>('/agents/show', { session: rest[0], place: rest[1] ?? 'focus' })
    if (shown === undefined) throw noProgram()
    console.log(`${shown.session.slice(0, 8)} of ${shown.machine} shows in terminal ${shown.terminal}.`)
    return 0
  }
  if (command === 'sleep' && rest.length === 1 && rest[0] !== undefined) {
    const told = await askProgram<Pick<Told, 'session' | 'machine' | 'status'>>('/agents/tell', { session: rest[0], sleep: true })
    if (told === undefined) throw noProgram()
    console.log(`${told.session.slice(0, 8)} on ${told.machine} goes to sleep once its turn ends. A message wakes it.`)
    return 0
  }
  if (command === 'shown' && rest[0] !== undefined) {
    if ((await askProgram('/shown', { window: rest[0], terminals: rest.slice(1) })) === undefined) throw noProgram()
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
  forgetClaudeMarkers()
process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  const isBusy = error instanceof Error && 'code' in error && error.code === 'SQLITE_BUSY'
  console.error(isBusy ? `The anyhost program is not answering at ${serveSocket()}, so this command read ${resolve(stateFolder(), 'anyhost.db')} itself, and the program kept it busy for over 5 s. anyhost doctor says why the program does not answer.` : error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
