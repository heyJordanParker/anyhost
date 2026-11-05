import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import plugin from '../../.claude-plugin/plugin.json'
import { openCapture, type Capture } from './capture.ts'
import { cmodDevice, deviceFromEnvironment, personOptions, relayLogin, rootsHere } from './device.ts'
import { doctor } from './doctor.ts'
import { connectRelay } from './relay.ts'
import { openSession, repoSlug, restore } from './resume.ts'
import { serve } from './serve.ts'
import { listSessions, type ListedSession } from './sessions.ts'

const USAGE = `anyhost ${plugin.version} keeps every Claude Code and Codex session of every machine in your own Cloudflare account.

  anyhost list [--json]              list every session of every machine
  anyhost resume <session> [--take]  continue a Claude Code or Codex session on this machine
  anyhost doctor                     check this machine's relay, the machine and the program
  anyhost serve                      capture this machine's sessions, as the anyhost mod runs it
  anyhost --version                  print the version`

const cut = (text: string, length: number): string => (text.length > length ? `${text.slice(0, length - 1)}…` : text)

function table(sessions: readonly ListedSession[]): string {
  const home = homedir()
  const rows = sessions.map((session) => [
    session.id,
    session.tool,
    session.entrypoint || '-',
    session.machine,
    session.holder || '-',
    session.lastActivity.slice(0, 16).replace('T', ' '),
    session.repo === '' ? '-' : repoSlug(session.repo).split('/').slice(-2).join('/'),
    cut(session.cwd.startsWith(home) ? `~${session.cwd.slice(home.length)}` : session.cwd, 40),
    cut(session.title || '-', 40),
    cut(session.firstPrompt || '-', 60),
  ])
  const header = ['SESSION', 'TOOL', 'ENTRYPOINT', 'MACHINE', 'HOLDER', 'LAST ACTIVITY', 'REPOSITORY', 'FOLDER', 'TITLE', 'FIRST PROMPT']
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)))
  return [header, ...rows].map((row) => row.map((value, column) => value.padEnd(widths[column] ?? 0)).join('  ').trimEnd()).join('\n')
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' }, take: { type: 'boolean' }, version: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } })
  const [command, ...rest] = positionals
  if (values.version === true) {
    console.log(plugin.version)
    return 0
  }
  // A command keeps its own connection to the relay while it runs, and fails once the relay cannot be reached.
  const connected = async <T>(work: (capture: Capture) => Promise<T>): Promise<T> => {
    const device = await cmodDevice()
    const relay = connectRelay({ login: relayLogin, device, isPatient: false })
    try {
      return await work(openCapture(relay, device, rootsHere()))
    } finally {
      relay.close()
    }
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
