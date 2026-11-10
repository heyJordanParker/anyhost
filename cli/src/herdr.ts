import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import pane from '../../herdr/anyhost/main.js' with { type: 'text' }
import placement from '../../herdr/anyhost/mod.json'

type Programs = { programs?: Record<string, { run?: string[] } & Record<string, unknown>> } & Record<string, unknown>

export const herdrHome = (): string => process.env['HERDR_APP_HOME'] || join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'herdr-app')

const writeChanged = async (path: string, text: string): Promise<void> => {
  if ((await readFile(path, 'utf8').catch(() => undefined)) === text) return
  await writeFile(`${path}.anyhost`, text)
  await rename(`${path}.anyhost`, path)
}

type Node = { id?: string; content?: unknown; children?: Node[] } & Record<string, unknown>
const LAYOUT = 'anyhost'

// The Herdr app's main layout with anyhost's session list in the place of its Agents list, as a layout of its own,
// since the app replaces its shipped layouts at each start: Herdr's guide adds a layout by writing its file and
// switching to it, and the person's own layout stays one ctrl-shift-l away.
const withSessions = (node: Node): Node => ({
  ...node,
  ...(node.id === 'agents' ? { content: { mod: 'anyhost' } } : {}),
  ...(node.children === undefined ? {} : { children: node.children.map(withSessions) }),
})

const herdrApp = (): string | undefined => Bun.which('herdr-app', { PATH: `${process.env['PATH'] ?? ''}:${join(homedir(), '.local', 'bin')}` }) ?? undefined

export async function installHerdr(home = herdrHome()): Promise<void> {
  if (!existsSync(home)) return
  const mod = join(home, 'mods', 'anyhost')
  await mkdir(mod, { recursive: true })
  await writeChanged(join(mod, 'main.js'), pane)
  await writeChanged(join(mod, 'mod.json'), `${JSON.stringify(placement)}\n`)
  const main = await readFile(join(home, 'layouts', 'main.json'), 'utf8').catch(() => undefined)
  if (main !== undefined) await writeChanged(join(home, 'layouts', `${LAYOUT}.json`), `${JSON.stringify(withSessions(JSON.parse(main) as Node), null, 2)}\n`)
  await switchOnce(home)
  await runUnderRunner(home)
}

// The app shows the layout once, at the first start of anyhost that finds the app running, and the person's choice
// from then on.
async function switchOnce(home: string): Promise<void> {
  const switched = join(home, 'mods', 'anyhost', '.switched')
  const app = herdrApp()
  if (existsSync(switched) || app === undefined || !existsSync(join(home, 'layouts', `${LAYOUT}.json`))) return
  const child = Bun.spawn([app, 'do', 'layout.switch', '--name', LAYOUT], { env: { ...process.env, HERDR_APP_HOME: home }, stdout: 'ignore', stderr: 'ignore' })
  if ((await child.exited) === 0) await writeFile(switched, '')
}

async function runUnderRunner(home: string): Promise<void> {
  const file = join(home, 'programs.json')
  const read = await readFile(file, 'utf8').catch(() => '{}')
  const programs = JSON.parse(read) as Programs
  const claude = programs.programs?.['claude'] ?? {}
  const command = claude.run ?? ['claude']
  if (command[0] === 'sh' && command[2] === UNDER_RUNNER) return
  const written: Programs = { ...programs, programs: { ...programs.programs, claude: { ...claude, run: ['sh', '-c', UNDER_RUNNER, 'anyhost', ...command] } } }
  await writeChanged(file, `${JSON.stringify(written, null, 2)}\n`)
}

// The Herdr app's Claude Code runs under anyhost's runner where cmod links the program, and as it was once anyhost is
// gone from there, so removing anyhost leaves the Herdr app working.
const UNDER_RUNNER = 'program="$HOME/.local/share/cmod/programs/anyhost"; [ -x "$program" ] && exec "$program" run -- "$@"; exec "$@"'
