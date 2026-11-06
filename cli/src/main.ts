import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import plugin from '../../.claude-plugin/plugin.json'
import type * as Protocol from '../../relay/protocol.ts'
import { openCapture, type Capture } from './capture.ts'
import { connectCloudflare, join, type Progress } from './connect.ts'
import { cmodDevice, deviceFromEnvironment, inviteMachine, machinesOf, personOptions, relayLogin, removeMachine, rootsHere } from './device.ts'
import { doctor } from './doctor.ts'
import { connectRelay } from './relay.ts'
import { openSession, repoSlug, restore } from './resume.ts'
import { serve } from './serve.ts'
import { listSessions, type ListedSession } from './sessions.ts'

const USAGE = `anyhost ${plugin.version} keeps every Claude Code and Codex session of every machine in your own Cloudflare account.

  anyhost list [--json]              list every session of every machine
  anyhost resume <session> [--take]  continue a Claude Code or Codex session on this machine
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
    const relay = connectRelay({ login: relayLogin, device, roots, isPatient: false })
    try {
      return await work(openCapture(relay, device, roots))
    } finally {
      relay.close()
    }
  }
  if (command === 'connect' && rest.length === 0) {
    await connectCloudflare(TERMINAL)
    return 0
  }
  if (command === 'join' && rest.length === 1 && rest[0] !== undefined) {
    console.log(`Joined this machine to ${await join(rest[0])}`)
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
      const machine = (await machinesOf(relay)).find((each) => each.name === name)
      if (machine === undefined) throw new Error(`No machine joined to your relay is named ${name}. anyhost machines lists them.`)
      if (machine.id === device.id) throw new Error(`${name} is this machine. Remove it from another machine.`)
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
