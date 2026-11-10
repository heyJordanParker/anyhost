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

export async function installHerdr(home = herdrHome()): Promise<void> {
  if (!existsSync(home)) return
  const mod = join(home, 'mods', 'anyhost')
  await mkdir(mod, { recursive: true })
  await writeChanged(join(mod, 'main.js'), pane)
  await writeChanged(join(mod, 'mod.json'), `${JSON.stringify(placement)}\n`)
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
