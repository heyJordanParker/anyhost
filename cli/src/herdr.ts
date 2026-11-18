import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
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
import maximize from '../../herdr/anyhost/icons/maximize-2.svg' with { type: 'text' }
import moon from '../../herdr/anyhost/icons/moon.svg' with { type: 'text' }
import panelBottom from '../../herdr/anyhost/icons/panel-bottom.svg' with { type: 'text' }
import panelLeft from '../../herdr/anyhost/icons/panel-left.svg' with { type: 'text' }
import panelRight from '../../herdr/anyhost/icons/panel-right.svg' with { type: 'text' }
import panelTop from '../../herdr/anyhost/icons/panel-top.svg' with { type: 'text' }
import pencil from '../../herdr/anyhost/icons/pencil.svg' with { type: 'text' }
import pictureInPicture from '../../herdr/anyhost/icons/picture-in-picture-2.svg' with { type: 'text' }
import rows from '../../herdr/anyhost/icons/rows-2.svg' with { type: 'text' }
import squareStack from '../../herdr/anyhost/icons/square-stack.svg' with { type: 'text' }
import tag from '../../herdr/anyhost/icons/tag.svg' with { type: 'text' }
import trash from '../../herdr/anyhost/icons/trash.svg' with { type: 'text' }
import undo from '../../herdr/anyhost/icons/undo-2.svg' with { type: 'text' }
import pane from '../../herdr/anyhost/main.js' with { type: 'text' }
import placement from '../../herdr/anyhost/mod.json'
import { claudeStart, run } from './claude.ts'

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
  'maximize-2.svg': maximize,
  'moon.svg': moon,
  'panel-bottom.svg': panelBottom,
  'panel-left.svg': panelLeft,
  'panel-right.svg': panelRight,
  'panel-top.svg': panelTop,
  'pencil.svg': pencil,
  'picture-in-picture-2.svg': pictureInPicture,
  'rows-2.svg': rows,
  'square-stack.svg': squareStack,
  'tag.svg': tag,
  'trash.svg': trash,
  'undo-2.svg': undo,
}

type Programs = { programs?: Record<string, { run?: string[] } & Record<string, unknown>> } & Record<string, unknown>

export const herdrHome = (): string => process.env['HERDR_APP_HOME'] || join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'herdr-app')

type Fingerprints = Readonly<Record<string, string>>
type Installed = {
  readonly mod?: Fingerprints | undefined
  readonly layout?: string | undefined
  readonly keys?: Readonly<Record<string, string>> | undefined
  readonly claude?: { readonly run: readonly string[] | null } | undefined
  readonly switched?: boolean | undefined
}

const MOD = 'anyhost'
const HERDR_HELPERS = ['gpui-kit.d.ts', 'jsconfig.json']

const fingerprint = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex')
const textOf = async (path: string): Promise<string | undefined> => (existsSync(path) ? await readFile(path, 'utf8') : undefined)

const shippedFiles = (): Readonly<Record<string, string>> => ({
  'main.js': pane,
  'mod.json': `${JSON.stringify(placement)}\n`,
  ...Object.fromEntries(Object.entries(ICONS).map(([name, icon]) => [`icons/${name}`, icon])),
})

const editedName = (folder: string, name: string, suffix: string): string => {
  for (let at = 1; ; at++) {
    const edited = at === 1 ? `${name}-edited` : `${name}-edited-${at}`
    if (!existsSync(join(folder, `${edited}${suffix}`))) return edited
  }
}

const isAsInstalled = async (folder: string, files: Fingerprints): Promise<boolean> => {
  if (!existsSync(folder)) return false
  const found = (await readdir(folder, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
    .filter((path) => !path.split('/').some((part) => part.startsWith('.')))
    .filter((path) => !HERDR_HELPERS.includes(path) || files[path] !== undefined)
  if (found.length !== Object.keys(files).length || found.some((path) => files[path] === undefined)) return false
  for (const path of found) if (fingerprint(await readFile(join(folder, path), 'utf8')) !== files[path]) return false
  return true
}

async function placeMod(home: string, was: Installed): Promise<Fingerprints> {
  const mods = join(home, 'mods')
  const folder = join(mods, MOD)
  const files = shippedFiles()
  const shipped = Object.fromEntries(Object.entries(files).map(([path, text]) => [path, fingerprint(text)]))
  if (await isAsInstalled(folder, shipped)) return shipped
  if (was.mod !== undefined && existsSync(folder) && !(await isAsInstalled(folder, was.mod))) await rename(folder, join(mods, editedName(mods, MOD, '')))
  await rm(folder, { recursive: true, force: true })
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(folder, path)), { recursive: true })
    await writeFile(join(folder, path), text)
  }
  return shipped
}

async function removeMod(home: string, was: Installed): Promise<void> {
  const folder = join(home, 'mods', MOD)
  if (was.mod !== undefined && (await isAsInstalled(folder, was.mod))) await rm(folder, { recursive: true, force: true })
}

type Node = { id?: string; content?: unknown; children?: Node[] } & Record<string, unknown>
const LAYOUT = 'anyhost'

const PANES: readonly Node[] = [
  { id: 'spaces', type: 'block', size: { weight: 1 }, min: 136, content: { mod: 'anyhost', props: { view: 'projects' } } },
  { id: 'agents', type: 'block', size: { weight: 2 }, min: 120, content: { mod: 'anyhost' } },
]

type PaneLook = { readonly pane?: { readonly header?: Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown>

const withPaneHeader = (node: Node): Node => {
  const content = node.content as PaneLook | undefined
  if (content?.pane?.header === undefined) return node
  return { ...node, content: { ...content, pane: { ...content.pane, header: { ...content.pane.header, content: { mod: 'anyhost', props: { view: 'pane' } } } } } }
}

const withSessions = (node: Node): Node => {
  if (node.id === 'sidebar-lists') return { id: node.id, type: 'column', children: [...PANES] }
  if (node.id === 'sidebar-footer') return { ...node, content: { mod: 'anyhost', props: { view: 'footer' } } }
  if (node.id === 'tabs') return { ...node, content: { mod: 'anyhost', props: { view: 'tabs' } } }
  if (node.id === 'main') {
    const { size, min, max, ...shown } = node
    return { id: 'views', type: 'stack', active: 'main', ...(size === undefined ? {} : { size }), ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }), children: [withPaneHeader(shown),{ id: 'tiles', type: 'row', children: [] }, { id: 'board', type: 'block', content: { mod: 'anyhost', props: { view: 'board' } } }] }
  }
  return { ...node, ...(node.children === undefined ? {} : { children: node.children.map(withSessions) }) }
}

const herdrApp = (): string | undefined => Bun.which('herdr-app', { PATH: `${process.env['PATH'] ?? ''}:${join(homedir(), '.local', 'bin')}` }) ?? undefined

const recordOf = async (record: string): Promise<Installed> => JSON.parse((await textOf(record)) ?? '{}') as Installed

export async function installHerdr(record: string, home = herdrHome()): Promise<void> {
  if (!existsSync(home)) return
  const was = await recordOf(record)
  const switched = was.switched ?? existsSync(join(home, 'mods', MOD, '.switched'))
  const mod = await placeMod(home, was)
  const layout = await placeLayout(home, was)
  const installed: Installed = { mod, layout, keys: await bindKeys(home, was), claude: await startClaudeClean(home, was), switched: switched || (await switchTo(home)) }
  await mkdir(dirname(record), { recursive: true })
  await writeFile(record, `${JSON.stringify(installed, null, 2)}\n`)
}

export async function uninstallHerdr(record: string, home = herdrHome()): Promise<void> {
  if (!existsSync(home)) return
  const was = await recordOf(record)
  await removeMod(home, was)
  await removeLayout(home, was)
  await unbindKeys(home, was)
  await restoreClaude(home, was)
  if (existsSync(record)) await writeFile(record, `${JSON.stringify({ ...was, switched: false }, null, 2)}\n`)
}

async function placeLayout(home: string, was: Installed): Promise<string | undefined> {
  const layouts = join(home, 'layouts')
  const main = await textOf(join(layouts, 'main.json'))
  if (main === undefined) return was.layout
  const text = `${JSON.stringify(withSessions(JSON.parse(main) as Node), null, 2)}\n`
  const path = join(layouts, `${LAYOUT}.json`)
  const current = await textOf(path)
  if (current !== undefined && current !== text && was.layout !== undefined && fingerprint(current) !== was.layout) {
    const edited = editedName(layouts, LAYOUT, '.json')
    const state = join(layouts, '.state', `${LAYOUT}.json`)
    if (existsSync(state)) await copyFile(state, join(layouts, '.state', `${edited}.json`))
    await rename(path, join(layouts, `${edited}.json`))
  }
  if (current !== text) await writeFile(path, text)
  return fingerprint(text)
}

async function removeLayout(home: string, was: Installed): Promise<void> {
  const path = join(home, 'layouts', `${LAYOUT}.json`)
  const current = await textOf(path)
  if (current === undefined || fingerprint(current) !== was.layout) return
  await rm(path)
  await rm(join(home, 'layouts', '.state', `${LAYOUT}.json`), { force: true })
}

type Keys = Record<string, Record<string, unknown>>

const same = (key: string): string => key
const DIRECTIONS = ['left', 'right', 'up', 'down'] as const
const isTabKey = (key: string): boolean => key.split('-').at(-1) === 'tab'

const BOUND: readonly (readonly [string, (key: string) => string, (key: string) => string])[] = [
  ['mod.open:picker', () => 'anyhost.palette', same],
  ['tab.close', () => 'anyhost.close', same],
  ['tab.new', () => 'anyhost.reopen', (key) => withModifier(key, key.includes('shift-') ? 'alt' : 'shift')],
  ['tab.next', (key) => (isTabKey(key) ? 'anyhost.recent' : 'anyhost.next'), same],
  ['tab.prev', (key) => (isTabKey(key) ? 'anyhost.recent-back' : 'anyhost.prev'), same],
  ['pane.zoom', () => 'anyhost.zoom', same],
  ...DIRECTIONS.flatMap((direction) => [[`pane.go:${direction}`, () => `anyhost.go-${direction}`, same] as const, [`pane.swap:${direction}`, () => `anyhost.move-${direction}`, same] as const]),
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

const SECTION = `layout:${LAYOUT}`

const keysWanted = (keys: Keys): Record<string, string> => {
  const global = Object.entries(keys['global'] ?? {})
  const modifier = workspaceModifierOf(global)
  return Object.fromEntries([
    ...BOUND.flatMap(([herdr, anyhostOf, keyOf]) => global.filter(([, action]) => action === herdr).map(([key]) => [keyOf(key), anyhostOf(key)])),
    ...(modifier === undefined ? [] : WORKSPACE_KEYS.map(([key, anyhost]) => [`${modifier}${key}`, anyhost])),
  ])
}

const writeKeys = async (file: string, keys: Keys, section: Record<string, unknown>): Promise<void> => {
  const next = Object.keys(section).length === 0 ? Object.fromEntries(Object.entries(keys).filter(([name]) => name !== SECTION)) : { ...keys, [SECTION]: section }
  if (JSON.stringify(next) !== JSON.stringify(keys)) await writeFile(file, `${JSON.stringify(next, null, 2)}\n`)
}

async function bindKeys(home: string, was: Installed): Promise<Installed['keys']> {
  const file = join(home, 'keys.json')
  const read = await textOf(file)
  if (read === undefined) return was.keys
  const keys = JSON.parse(read) as Keys
  const wanted = keysWanted(keys)
  const section: Record<string, unknown> = { ...keys[SECTION] }
  for (const [key, action] of Object.entries(was.keys ?? {})) if (wanted[key] === undefined && section[key] === action) delete section[key]
  const ours: Record<string, string> = {}
  for (const [key, action] of Object.entries(wanted)) {
    if (section[key] !== undefined && section[key] !== action && section[key] !== was.keys?.[key]) continue
    section[key] = action
    ours[key] = action
  }
  await writeKeys(file, keys, section)
  return ours
}

async function unbindKeys(home: string, was: Installed): Promise<void> {
  const file = join(home, 'keys.json')
  const read = await textOf(file)
  if (read === undefined) return
  const keys = JSON.parse(read) as Keys
  const section: Record<string, unknown> = { ...keys[SECTION] }
  for (const [key, action] of Object.entries(was.keys ?? {})) if (section[key] === action) delete section[key]
  await writeKeys(file, keys, section)
}

async function switchTo(home: string): Promise<boolean> {
  const app = herdrApp()
  if (app === undefined || !existsSync(join(home, 'layouts', `${LAYOUT}.json`))) return false
  const child = Bun.spawn([app, 'do', 'layout.switch', '--name', LAYOUT], { env: { ...process.env, HERDR_APP_HOME: home }, stdout: 'ignore', stderr: 'ignore' })
  return (await child.exited) === 0
}

const RUNNER_WRAP_0_9_0 = 'program="$HOME/.local/share/cmod/programs/anyhost"; [ -x "$program" ] && exec "$program" run -- "$@"; exec "$@"'

const ownCommandOf = (run: readonly string[]): readonly string[] => {
  const started = claudeStart([], false)
  if (started.every((word, at) => run[at] === word)) return run.slice(started.length)
  if (run[0] === 'sh' && run[2] === RUNNER_WRAP_0_9_0) return run.slice(4)
  return run
}

const writeClaudeRun = async (file: string, programs: Programs, run: readonly string[] | null): Promise<void> => {
  const claude = Object.fromEntries(Object.entries(programs.programs?.['claude'] ?? {}).filter(([name]) => name !== 'run'))
  const written: Programs = { ...programs, programs: { ...programs.programs, claude: run === null ? claude : { ...claude, run: [...run] } } }
  if (JSON.stringify(written) !== JSON.stringify(programs)) await writeFile(file, `${JSON.stringify(written, null, 2)}\n`)
}

async function startClaudeClean(home: string, was: Installed): Promise<Installed['claude']> {
  const file = join(home, 'programs.json')
  const programs = JSON.parse((await textOf(file)) ?? '{}') as Programs
  const run = programs.programs?.['claude']?.run
  await writeClaudeRun(file, programs, claudeStart(ownCommandOf(run ?? ['claude']), false))
  return was.claude ?? { run: run === undefined ? null : ownCommandOf(run) }
}

async function restoreClaude(home: string, was: Installed): Promise<void> {
  const file = join(home, 'programs.json')
  const read = await textOf(file)
  const run = read === undefined ? undefined : (JSON.parse(read) as Programs).programs?.['claude']?.run
  if (read === undefined || run === undefined || was.claude === undefined) return
  const own = ownCommandOf(run)
  if (own === run) return
  await writeClaudeRun(file, JSON.parse(read) as Programs, JSON.stringify(own) === JSON.stringify(was.claude.run ?? ['claude']) ? was.claude.run : own)
}

export const PLACES = ['focus', 'peek', 'tab', 'right', 'down', 'hide'] as const
export type Place = (typeof PLACES)[number]
type Shown = { readonly spaces: readonly { readonly tabs: readonly { readonly terminals: readonly { readonly terminal: string; readonly pane: string | null }[] }[] }[] }

const VIEW = 'export PATH="$HOME/.local/bin:$PATH"; hc label "$HC_TERMINAL_ID" "anyhost.view=$1"; exec hc attach "$2"'

export async function showTerminal(session: string, terminal: string, place: Place): Promise<void> {
  const app = herdrApp()
  if (app === undefined) throw new Error('The Herdr app is not installed on this machine, so no screen here shows the session.')
  const say = async (command: string, args: Record<string, unknown>): Promise<void> => void (await run([app, 'do', command, JSON.stringify(args)]))
  const shown = JSON.parse(await run([app, 'ls'])) as Shown
  const pane = shown.spaces.flatMap(({ tabs }) => tabs).flatMap(({ terminals }) => terminals).find((each) => each.terminal === terminal)?.pane ?? null
  if (place === 'peek') return await say('terminal.peek', { terminal })
  if (place === 'hide') return pane === null ? undefined : await say('terminal.park', { terminal })
  if (pane === null) return await say('terminal.keep', { terminal, place: place === 'focus' ? 'tab' : place })
  if (place === 'focus' || place === 'tab') return await say('agent.focus', { terminal })
  await say('pane.split', { direction: place, argv: ['sh', '-c', VIEW, 'view', session, terminal] })
}
