import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import plugin from '../../.claude-plugin/plugin.json'
import { holdElsewhere, openCapture, openDatabase } from './capture.ts'
import { cmodDevice, deviceFromEnvironment, rootsHere } from './device.ts'
import { doctor } from './doctor.ts'
import { repoSlug, resume } from './resume.ts'
import { serve } from './serve.ts'
import { listSessions, type ListedSession } from './sessions.ts'
import { r2Store } from './store.ts'

const USAGE = `anyhost ${plugin.version} keeps every Claude Code and Codex session of every machine in R2.

  anyhost list [--json]              list every session of every machine
  anyhost resume <session> [--take]  continue a Claude Code or Codex session on this machine
  anyhost released <session> --to <machine>
                                     mark a session another machine took over, as its anyhost resume --take does over ssh
  anyhost doctor                     check the AWS profile, the bucket, this machine and the program
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
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' }, take: { type: 'boolean' }, to: { type: 'string' }, version: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } })
  const [command, ...rest] = positionals
  if (values.version === true) {
    console.log(plugin.version)
    return 0
  }
  if (command === 'list') {
    const sessions = await listSessions(r2Store())
    console.log(values.json === true ? JSON.stringify(sessions, null, 2) : table(sessions))
    return 0
  }
  if (command === 'resume' && rest.length === 1 && rest[0] !== undefined) {
    return await resume(openCapture(r2Store(), await cmodDevice(), rootsHere()), rest[0], { take: values.take === true })
  }
  if (command === 'released' && rest.length === 1 && rest[0] !== undefined && values.to !== undefined) {
    const db = openDatabase()
    holdElsewhere(db, rest[0], values.to, `${new Date().toISOString()} ${values.to} took the session ${rest[0]} over and said so over ssh, so this machine captures nothing more of it.`)
    db.close()
    return 0
  }
  if (command === 'doctor') return await doctor(r2Store())
  if (command === 'serve') {
    await serve(r2Store(), deviceFromEnvironment())
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
