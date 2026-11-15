import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import alarmClockOff from '../../herdr/anyhost/icons/alarm-clock-off.svg' with { type: 'text' }
import alarmClock from '../../herdr/anyhost/icons/alarm-clock.svg' with { type: 'text' }
import appWindow from '../../herdr/anyhost/icons/app-window.svg' with { type: 'text' }
import archiveRestore from '../../herdr/anyhost/icons/archive-restore.svg' with { type: 'text' }
import chevronUp from '../../herdr/anyhost/icons/chevron-up.svg' with { type: 'text' }
import circleAlert from '../../herdr/anyhost/icons/circle-alert.svg' with { type: 'text' }
import circleDashed from '../../herdr/anyhost/icons/circle-dashed.svg' with { type: 'text' }
import circle from '../../herdr/anyhost/icons/circle.svg' with { type: 'text' }
import columns from '../../herdr/anyhost/icons/columns-2.svg' with { type: 'text' }
import copy from '../../herdr/anyhost/icons/copy.svg' with { type: 'text' }
import ellipsis from '../../herdr/anyhost/icons/ellipsis.svg' with { type: 'text' }
import eye from '../../herdr/anyhost/icons/eye.svg' with { type: 'text' }
import galleryHorizontal from '../../herdr/anyhost/icons/gallery-horizontal.svg' with { type: 'text' }
import gitBranchPlus from '../../herdr/anyhost/icons/git-branch-plus.svg' with { type: 'text' }
import hash from '../../herdr/anyhost/icons/hash.svg' with { type: 'text' }
import kanban from '../../herdr/anyhost/icons/kanban.svg' with { type: 'text' }
import layoutDashboard from '../../herdr/anyhost/icons/layout-dashboard.svg' with { type: 'text' }
import layoutGrid from '../../herdr/anyhost/icons/layout-grid.svg' with { type: 'text' }
import layoutPanelLeft from '../../herdr/anyhost/icons/layout-panel-left.svg' with { type: 'text' }
import listFilter from '../../herdr/anyhost/icons/list-filter.svg' with { type: 'text' }
import mailOpen from '../../herdr/anyhost/icons/mail-open.svg' with { type: 'text' }
import moon from '../../herdr/anyhost/icons/moon.svg' with { type: 'text' }
import pencil from '../../herdr/anyhost/icons/pencil.svg' with { type: 'text' }
import rows from '../../herdr/anyhost/icons/rows-2.svg' with { type: 'text' }
import squareStack from '../../herdr/anyhost/icons/square-stack.svg' with { type: 'text' }
import tag from '../../herdr/anyhost/icons/tag.svg' with { type: 'text' }
import trash from '../../herdr/anyhost/icons/trash.svg' with { type: 'text' }
import undo from '../../herdr/anyhost/icons/undo-2.svg' with { type: 'text' }
import pane from '../../herdr/anyhost/main.js' with { type: 'text' }
import placement from '../../herdr/anyhost/mod.json'
import { claudeStart, run } from './claude.ts'
import { hcPath } from './hc.ts'

const ICONS: Record<string, string> = {
  'alarm-clock-off.svg': alarmClockOff,
  'alarm-clock.svg': alarmClock,
  'app-window.svg': appWindow,
  'archive-restore.svg': archiveRestore,
  'chevron-up.svg': chevronUp,
  'circle-alert.svg': circleAlert,
  'circle-dashed.svg': circleDashed,
  'circle.svg': circle,
  'columns-2.svg': columns,
  'copy.svg': copy,
  'ellipsis.svg': ellipsis,
  'eye.svg': eye,
  'gallery-horizontal.svg': galleryHorizontal,
  'git-branch-plus.svg': gitBranchPlus,
  'hash.svg': hash,
  'kanban.svg': kanban,
  'layout-dashboard.svg': layoutDashboard,
  'layout-grid.svg': layoutGrid,
  'layout-panel-left.svg': layoutPanelLeft,
  'list-filter.svg': listFilter,
  'mail-open.svg': mailOpen,
  'moon.svg': moon,
  'pencil.svg': pencil,
  'rows-2.svg': rows,
  'square-stack.svg': squareStack,
  'tag.svg': tag,
  'trash.svg': trash,
  'undo-2.svg': undo,
}

type Programs = { programs?: Record<string, { run?: string[] } & Record<string, unknown>> } & Record<string, unknown>

export const herdrHome = (): string => process.env['HERDR_APP_HOME'] || join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'herdr-app')

const writeChanged = async (path: string, text: string): Promise<void> => {
  if ((await readFile(path, 'utf8').catch(() => undefined)) === text) return
  await writeFile(`${path}.anyhost`, text)
  await rename(`${path}.anyhost`, path)
}

type Node = { id?: string; content?: unknown; children?: Node[] } & Record<string, unknown>
const LAYOUT = 'anyhost'

const PANES: readonly Node[] = [
  { id: 'spaces', type: 'block', size: { weight: 1 }, min: 136, content: { mod: 'anyhost', props: { view: 'projects' } } },
  { id: 'agents', type: 'block', size: { weight: 2 }, min: 120, content: { mod: 'anyhost' } },
]

const withSessions = (node: Node): Node => {
  if (node.id === 'sidebar-lists') return { id: node.id, type: 'column', children: [...PANES] }
  if (node.id === 'sidebar-footer') return { ...node, content: { mod: 'anyhost', props: { view: 'footer' } } }
  if (node.id === 'tabs') return { ...node, content: { mod: 'anyhost', props: { view: 'tabs' } } }
  if (node.id === 'main') {
    const { size, min, max, ...shown } = node
    return { id: 'views', type: 'stack', active: 'main', ...(size === undefined ? {} : { size }), ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }), children: [shown, { id: 'tiles', type: 'row', children: [] }, { id: 'board', type: 'block', content: { mod: 'anyhost', props: { view: 'board' } } }] }
  }
  return { ...node, ...(node.children === undefined ? {} : { children: node.children.map(withSessions) }) }
}

const herdrApp = (): string | undefined => Bun.which('herdr-app', { PATH: `${process.env['PATH'] ?? ''}:${join(homedir(), '.local', 'bin')}` }) ?? undefined

export async function installHerdr(home = herdrHome()): Promise<void> {
  if (!existsSync(home)) return
  const mod = join(home, 'mods', 'anyhost')
  await mkdir(join(mod, 'icons'), { recursive: true })
  await writeChanged(join(mod, 'main.js'), pane)
  for (const [name, icon] of Object.entries(ICONS)) await writeChanged(join(mod, 'icons', name), icon)
  await writeChanged(join(mod, 'mod.json'), `${JSON.stringify(placement)}\n`)
  const main = await readFile(join(home, 'layouts', 'main.json'), 'utf8').catch(() => undefined)
  if (main !== undefined) await writeChanged(join(home, 'layouts', `${LAYOUT}.json`), `${JSON.stringify(withSessions(JSON.parse(main) as Node), null, 2)}\n`)
  await switchOnce(home)
  await startClaudeClean(home)
  await bindKeys(home)
}

type Keys = Record<string, Record<string, unknown>>

const same = (key: string): string => key
const DIRECTIONS = ['left', 'right', 'up', 'down'] as const

const BOUND: readonly (readonly [string, string, (key: string) => string])[] = [
  ['mod.open:picker', 'anyhost.palette', same],
  ['tab.close', 'anyhost.close', same],
  ['tab.new', 'anyhost.reopen', (key) => withModifier(key, key.includes('shift-') ? 'alt' : 'shift')],
  ['tab.next', 'anyhost.next', same],
  ['tab.prev', 'anyhost.prev', same],
  ['pane.zoom', 'anyhost.zoom', same],
  ...DIRECTIONS.flatMap((direction) => [[`pane.go:${direction}`, `anyhost.go-${direction}`, same] as const, [`pane.swap:${direction}`, `anyhost.move-${direction}`, same] as const]),
]

const WORKSPACE_KEYS: readonly (readonly [string, string])[] = [
  ['enter', 'anyhost.promote'],
  ['m', 'anyhost.mode'],
  ['=', 'anyhost.grow'],
  ['-', 'anyhost.shrink'],
  [',', 'anyhost.scroll-left'],
  ['.', 'anyhost.scroll-right'],
]

const withModifier = (key: string, modifier: string): string => {
  const parts = key.split('-')
  return [...parts.slice(0, -1), modifier, parts.at(-1)].join('-')
}

const workspaceModifierOf = (global: readonly (readonly [string, unknown])[]): string | undefined =>
  global.find(([key, action]) => action === 'pane.go:left' && key.endsWith('-left'))?.[0].slice(0, -'left'.length)

async function bindKeys(home: string): Promise<void> {
  const file = join(home, 'keys.json')
  const read = await readFile(file, 'utf8').catch(() => undefined)
  if (read === undefined) return
  const keys = JSON.parse(read) as Keys
  const section = `layout:${LAYOUT}`
  const global = Object.entries(keys['global'] ?? {})
  const modifier = workspaceModifierOf(global)
  const bound = Object.fromEntries([
    ...BOUND.flatMap(([herdr, anyhost, keyOf]) => global.filter(([, action]) => action === herdr).map(([key]) => [keyOf(key), anyhost])),
    ...(modifier === undefined ? [] : WORKSPACE_KEYS.map(([key, anyhost]) => [`${modifier}${key}`, anyhost])),
  ])
  if (Object.entries(bound).every(([key, action]) => keys[section]?.[key] === action)) return
  await writeChanged(file, `${JSON.stringify({ ...keys, [section]: { ...keys[section], ...bound } }, null, 2)}\n`)
}

async function switchOnce(home: string): Promise<void> {
  const switched = join(home, 'mods', 'anyhost', '.switched')
  const app = herdrApp()
  if (existsSync(switched) || app === undefined || !existsSync(join(home, 'layouts', `${LAYOUT}.json`))) return
  const child = Bun.spawn([app, 'do', 'layout.switch', '--name', LAYOUT], { env: { ...process.env, HERDR_APP_HOME: home }, stdout: 'ignore', stderr: 'ignore' })
  if ((await child.exited) === 0) await writeFile(switched, '')
}

const RUNNER_WRAP_0_9_0 = 'program="$HOME/.local/share/cmod/programs/anyhost"; [ -x "$program" ] && exec "$program" run -- "$@"; exec "$@"'

const ownCommandOf = (run: readonly string[]): readonly string[] => {
  const started = claudeStart([], false)
  if (started.every((word, at) => run[at] === word)) return run.slice(started.length)
  if (run[0] === 'sh' && run[2] === RUNNER_WRAP_0_9_0) return run.slice(4)
  return run
}

async function startClaudeClean(home: string): Promise<void> {
  const file = join(home, 'programs.json')
  const read = await readFile(file, 'utf8').catch(() => '{}')
  const programs = JSON.parse(read) as Programs
  const claude = programs.programs?.['claude'] ?? {}
  const written: Programs = { ...programs, programs: { ...programs.programs, claude: { ...claude, run: claudeStart(ownCommandOf(claude.run ?? ['claude']), false) } } }
  await writeChanged(file, `${JSON.stringify(written, null, 2)}\n`)
}

export const PLACES = ['focus', 'peek', 'tab', 'right', 'down', 'hide'] as const
export type Place = (typeof PLACES)[number]
type Shown = { readonly spaces: readonly { readonly tabs: readonly { readonly terminals: readonly { readonly terminal: string; readonly pane: string | null }[] }[] }[] }

export async function showTerminal(terminal: string, place: Place): Promise<void> {
  const app = herdrApp()
  if (app === undefined) throw new Error('The Herdr app is not installed on this machine, so no screen here shows the session.')
  const say = async (command: string, args: Record<string, unknown>): Promise<void> => void (await run([app, 'do', command, JSON.stringify(args)]))
  const shown = JSON.parse(await run([app, 'ls'])) as Shown
  const pane = shown.spaces.flatMap(({ tabs }) => tabs).flatMap(({ terminals }) => terminals).find((each) => each.terminal === terminal)?.pane ?? null
  if (place === 'peek') return await say('terminal.peek', { terminal })
  if (place === 'hide') return pane === null ? undefined : await say('terminal.park', { terminal })
  if (pane === null) return await say('terminal.keep', { terminal, place: place === 'focus' ? 'tab' : place })
  if (place === 'focus' || place === 'tab') return await say('agent.focus', { terminal })
  await say('pane.split', { direction: place, argv: [hcPath() ?? 'hc', 'attach', terminal] })
}
