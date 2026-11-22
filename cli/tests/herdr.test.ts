import { expect } from 'bun:test'
import { test, whenTestEnds } from './test.ts'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeStart } from '../src/claude.ts'
import { installHerdr, uninstallHerdr } from '../src/herdr.ts'
import { script, temporaryFolder } from './program.ts'

const RUNNER_WRAP_0_9_0 = 'program="$HOME/.local/share/cmod/programs/anyhost"; [ -x "$program" ] && exec "$program" run -- "$@"; exec "$@"'
const PANE = join(import.meta.dir, '..', '..', 'herdr', 'anyhost')

const herdrHomeIn = (home = temporaryFolder()): { readonly herdr: string; readonly record: string } => {
  const herdr = join(home, '.config', 'herdr-app')
  mkdirSync(herdr, { recursive: true })
  return { herdr, record: join(home, 'cmod-data', 'herdr.json') }
}
const jsonOf = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

const claudeRunIn = async (run: readonly string[]): Promise<{ readonly home: string; readonly run: string[]; readonly name: string }> => {
  const home = temporaryFolder()
  const before = process.env['XDG_STATE_HOME']
  process.env['XDG_STATE_HOME'] = join(home, 'state')
  whenTestEnds(() => {
    if (before === undefined) delete process.env['XDG_STATE_HOME']
    else process.env['XDG_STATE_HOME'] = before
  })
  const { herdr, record } = herdrHomeIn(home)
  writeFileSync(join(herdr, 'programs.json'), JSON.stringify({ programs: { claude: { name: 'Claude', run } } }))
  await installHerdr(record, herdr)
  await installHerdr(record, herdr)
  const { programs } = jsonOf(join(herdr, 'programs.json')) as { programs: { claude: { name: string; run: string[] } } }
  expect(existsSync(join(herdr, 'mods', 'anyhost', 'main.js'))).toBe(true)
  return { home, run: programs.claude.run, name: programs.claude.name }
}

test("the Herdr app's Claude Code starts through anyhost's launcher, once, without a Claude Code session's markers, and with no anyhost process of its own", async () => {
  const { home, run, name } = await claudeRunIn(['claude', '--model', 'opus'])
  const bin = join(home, 'bin')
  script(join(bin, 'claude'), '#!/bin/sh\necho "claude $* ${CLAUDE_CODE_CHILD_SESSION:-unmarked}"\n')

  const ran = Bun.spawnSync(run, { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CODE_CHILD_SESSION: '1' } })

  expect(name).toBe('Claude')
  expect(run[0]).toBe(claudeStart([], false)[0])
  expect(ran.stdout.toString()).toBe('claude --model opus unmarked\n')
})

test("a Herdr app set up by 0.9.0 runs its own Claude Code command through the launcher, with 0.9.0's runner taken out", async () => {
  const { run } = await claudeRunIn(['sh', '-c', RUNNER_WRAP_0_9_0, 'anyhost', 'claude', '--model', 'opus'])

  expect(run.slice(-3)).toEqual(['claude', '--model', 'opus'])
  expect(run).not.toContain(RUNNER_WRAP_0_9_0)
})

test("a Herdr app whose Claude Code an older launcher starts runs the person's own command through this launcher once", async () => {
  const older = (argv: readonly string[]): string[] => ['perl', '-e', 'my ($environment, $trustsHome) = splice(@ARGV, 0, 2); exec @ARGV;', '--', '/old/environment.json', '', ...argv]
  const { run } = await claudeRunIn(older(older(['claude', '--model', 'opus'])))

  expect(run).toEqual(claudeStart(['claude', '--model', 'opus'], false))
})

test("the Herdr app's sidebar shows the inbox over the projects, split by a divider the person drags, its panes wear anyhost's header, anyhost draws its notifications at the top right and its terminals' right-click menu, the right panel holds cmod's views beside Files and Changes, and the rest of its layout is as the app ships it", async () => {
  const herdr = join(temporaryFolder(), 'herdr-app')
  mkdirSync(join(herdr, 'layouts'), { recursive: true })
  const lists = { id: 'sidebar-lists', type: 'column', children: [{ id: 'spaces', type: 'block', content: { mod: 'spaces' } }, { id: 'agents', type: 'block', content: { mod: 'agents' } }] }
  const tab = { id: 'main', type: 'block', min: 200, content: { tab: 'active', pane: { gap: 8, header: { content: { mod: 'pane' }, height: 30, position: 'top', reveal: 'always' } } } }
  const files = { id: 'files', type: 'block', content: { mod: 'files' } }
  const changes = { id: 'changes', type: 'block', content: { mod: 'changes' } }
  const panel = { id: 'panel', type: 'column', hidden: true, children: [{ id: 'panel-body', type: 'stack', active: 'files', children: [files, changes] }] }
  const main = { id: 'root', type: 'row', children: [{ id: 'sidebar', type: 'column', children: [{ id: 'brand', type: 'block' }, lists] }, { id: 'work', type: 'column', children: [{ id: 'tabs', type: 'block', size: { px: 30 }, content: { mod: 'tabs' } }, tab] }, panel] }
  writeFileSync(join(herdr, 'layouts', 'main.json'), JSON.stringify(main))

  await installHerdr(join(herdr, 'herdr.json'), herdr)

  const written = JSON.parse(readFileSync(join(herdr, 'layouts', 'anyhost.json'), 'utf8')) as { toast: string; terminal_menu: string; children: Record<string, unknown>[] & { children?: unknown[] }[] }
  expect([written.toast, written.terminal_menu]).toEqual(['anyhost', 'anyhost'])
  expect(written.children[0]?.children?.[1]).toEqual({
    id: 'sidebar-lists',
    type: 'column',
    children: [
      { id: 'spaces', type: 'block', size: { weight: 1 }, min: 136, content: { mod: 'anyhost', props: { view: 'projects' } } },
      { id: 'agents', type: 'block', size: { weight: 2 }, min: 120, content: { mod: 'anyhost' } },
    ],
  })
  expect(written.children[1]).toEqual({
    id: 'work',
    type: 'column',
    children: [
      { id: 'tabs', type: 'block', size: { px: 30 }, content: { mod: 'anyhost', props: { view: 'tabs' } } },
      {
        id: 'views',
        type: 'stack',
        active: 'main',
        min: 200,
        floating: [{ id: 'toasts', content: { mod: 'anyhost', props: { view: 'toasts' } }, edge: 'top', align: 'end' }],
        children: [
          { id: 'main', type: 'block', content: { tab: 'active', pane: { gap: 8, header: { content: { mod: 'anyhost', props: { view: 'pane' } }, height: 30, position: 'top', reveal: 'always' } } } },
          { id: 'tiles', type: 'row', children: [] },
          { id: 'board', type: 'block', content: { mod: 'anyhost', props: { view: 'board' } } },
        ],
      },
    ],
  })
  expect(written.children[2]).toEqual({
    id: 'panel',
    type: 'column',
    hidden: true,
    children: [{ id: 'panel-body', type: 'stack', active: 'files', children: [files, changes, { id: 'cmod', type: 'block', content: { mod: 'cmod', props: { show: 'views', block: 'cmod' } } }] }],
  })
})

test('a layout an older anyhost wrote, without cmod in the right panel, gains it at the next install and is not kept as an edited copy', async () => {
  const { herdr, record } = herdrHomeIn()
  mkdirSync(join(herdr, 'layouts'), { recursive: true })
  const body = { id: 'panel-body', type: 'stack', active: 'files', children: [{ id: 'files', type: 'block', content: { mod: 'files' } }] }
  writeFileSync(join(herdr, 'layouts', 'main.json'), JSON.stringify({ id: 'root', type: 'row', children: [body] }))
  await installHerdr(record, herdr)
  const older = `${JSON.stringify({ id: 'root', type: 'row', children: [body], toast: 'anyhost', terminal_menu: 'anyhost' }, null, 2)}\n`
  writeFileSync(join(herdr, 'layouts', 'anyhost.json'), older)
  writeFileSync(record, JSON.stringify({ ...(jsonOf(record) as Record<string, unknown>), layout: new Bun.CryptoHasher('sha256').update(older).digest('hex') }))

  await installHerdr(record, herdr)

  expect(readdirSync(join(herdr, 'layouts')).sort()).toEqual(['anyhost.json', 'main.json'])
  expect(jsonOf(join(herdr, 'layouts', 'anyhost.json'))).toEqual({
    id: 'root',
    type: 'row',
    children: [{ ...body, children: [...body.children, { id: 'cmod', type: 'block', content: { mod: 'cmod', props: { show: 'views', block: 'cmod' } } }] }],
    toast: 'anyhost',
    terminal_menu: 'anyhost',
  })
})

test('every icon of its own the pane draws reaches the Herdr app with it', async () => {
  const herdr = join(temporaryFolder(), 'herdr-app')
  mkdirSync(herdr, { recursive: true })

  await installHerdr(join(herdr, 'herdr.json'), herdr)

  const drawn = new Set([...readFileSync(join(PANE, 'main.js'), 'utf8').matchAll(/(?:\$\{OWN\}|mods\/anyhost\/icons)\/([a-z0-9-]+)/g)].map(([, icon]) => icon))
  expect(drawn).toContain('circle-x')
  expect([...drawn].filter((icon) => !existsSync(join(herdr, 'mods', 'anyhost', 'icons', `${icon}.svg`)))).toEqual([])
})

test("in the anyhost layout the new-tab key starts a session as the sidebar's New session does, with alt it opens an empty terminal, the tab and pane keys act on the shown window, ctrl-tab walks the windows by recency while the other next-tab keys stay positional, the pane keys' modifier with enter, m, =, -, comma and period promote, cycle the layout, size the master and scroll, and a key the person bound there stays theirs, as the picker key does here", async () => {
  const herdr = join(temporaryFolder(), 'herdr-app')
  mkdirSync(herdr, { recursive: true })
  const global = {
    'cmd-p': 'mod.open:picker',
    'cmd-t': 'tab.new',
    'ctrl-shift-t': 'tab.new',
    'cmd-w': 'tab.close',
    'ctrl-tab': 'tab.next',
    'ctrl-shift-tab': 'tab.prev',
    'cmd-shift-]': 'tab.next',
    'cmd-shift-[': 'tab.prev',
    'cmd-shift-enter': 'pane.zoom',
    'cmd-alt-left': 'pane.go:left',
    'cmd-alt-right': 'pane.go:right',
    'cmd-alt-up': 'pane.go:up',
    'cmd-alt-down': 'pane.go:down',
    'cmd-alt-shift-left': 'pane.swap:left',
    'cmd-alt-shift-right': 'pane.swap:right',
    'cmd-d': 'pane.split:right',
  }
  writeFileSync(join(herdr, 'keys.json'), JSON.stringify({ global, terminal: { 'cmd-c': 'terminal.copy' }, 'layout:anyhost': { 'cmd-p': 'files.open' } }))
  const record = join(herdr, 'herdr.json')

  await installHerdr(record, herdr)
  await installHerdr(record, herdr)

  expect(jsonOf(join(herdr, 'keys.json'))).toEqual({
    global,
    terminal: { 'cmd-c': 'terminal.copy' },
    'layout:anyhost': {
      'cmd-p': 'files.open',
      'cmd-w': 'anyhost.close',
      'cmd-t': 'anyhost.new',
      'ctrl-shift-t': 'anyhost.new',
      'cmd-alt-t': 'tab.new',
      'cmd-shift-t': 'anyhost.reopen',
      'ctrl-shift-alt-t': 'anyhost.reopen',
      'ctrl-tab': 'anyhost.recent',
      'ctrl-shift-tab': 'anyhost.recent-back',
      'cmd-shift-]': 'anyhost.next',
      'cmd-shift-[': 'anyhost.prev',
      'cmd-shift-enter': 'anyhost.zoom',
      'cmd-alt-left': 'anyhost.go-left',
      'cmd-alt-right': 'anyhost.go-right',
      'cmd-alt-up': 'anyhost.go-up',
      'cmd-alt-down': 'anyhost.go-down',
      'cmd-alt-shift-left': 'anyhost.move-left',
      'cmd-alt-shift-right': 'anyhost.move-right',
      'cmd-alt-enter': 'anyhost.promote',
      'cmd-alt-m': 'anyhost.mode',
      'cmd-alt-=': 'anyhost.grow',
      'cmd-alt--': 'anyhost.shrink',
      'cmd-alt-,': 'anyhost.scroll-left',
      'cmd-alt-.': 'anyhost.scroll-right',
    },
  })
})

test('in the anyhost layout the new-space key starts a session in the project on screen, as the new-tab key does, so no space outside a project opens', async () => {
  const herdr = join(temporaryFolder(), 'herdr-app')
  mkdirSync(herdr, { recursive: true })
  writeFileSync(join(herdr, 'keys.json'), JSON.stringify({ global: { 'cmd-n': 'space.new' } }))

  await installHerdr(join(herdr, 'herdr.json'), herdr)

  expect(jsonOf(join(herdr, 'keys.json'))).toEqual({ global: { 'cmd-n': 'space.new' }, 'layout:anyhost': { 'cmd-n': 'anyhost.new' } })
})

test('no keys file is written where the Herdr app has not made one, so it still installs its own', async () => {
  const herdr = join(temporaryFolder(), 'herdr-app')
  mkdirSync(herdr, { recursive: true })

  await installHerdr(join(herdr, 'herdr.json'), herdr)

  expect(existsSync(join(herdr, 'keys.json'))).toBe(false)
})

test("an update replaces the pane and the layout anyhost installed, keeps each one the person edited beside them as Herdr keeps an edited mod, and never touches them between updates", async () => {
  const { herdr, record } = herdrHomeIn()
  mkdirSync(join(herdr, 'layouts'), { recursive: true })
  writeFileSync(join(herdr, 'layouts', 'main.json'), JSON.stringify({ id: 'root', type: 'row', children: [] }))
  await installHerdr(record, herdr)
  writeFileSync(join(herdr, 'mods', 'anyhost', 'main.js'), 'export default class Edited {}\n')
  writeFileSync(join(herdr, 'layouts', 'anyhost.json'), '{"id":"root","type":"row","children":[],"theme":"mine"}\n')
  const installed = jsonOf(record) as Record<string, unknown>
  writeFileSync(record, JSON.stringify({ ...installed, mod: { 'main.js': 'an older pane' }, layout: 'an older layout' }))

  await installHerdr(record, herdr)

  expect(readFileSync(join(herdr, 'mods', 'anyhost-edited', 'main.js'), 'utf8')).toBe('export default class Edited {}\n')
  expect(readFileSync(join(herdr, 'mods', 'anyhost', 'main.js'), 'utf8')).toBe(readFileSync(join(PANE, 'main.js'), 'utf8'))
  expect(readFileSync(join(herdr, 'layouts', 'anyhost-edited.json'), 'utf8')).toContain('"theme":"mine"')
  expect(jsonOf(join(herdr, 'layouts', 'anyhost.json'))).toEqual({ id: 'root', type: 'row', children: [], toast: 'anyhost', terminal_menu: 'anyhost' })
})

test("a pane folder linked to this checkout holds the pane anyhost ships, so an install leaves the link and the Herdr app shows the checkout's pane live", async () => {
  const { herdr, record } = herdrHomeIn()
  mkdirSync(join(herdr, 'mods'), { recursive: true })
  symlinkSync(PANE, join(herdr, 'mods', 'anyhost'))

  await installHerdr(record, herdr)

  expect(readdirSync(join(herdr, 'mods'))).toEqual(['anyhost'])
  expect(readFileSync(join(herdr, 'mods', 'anyhost', 'main.js'), 'utf8')).toBe(readFileSync(join(PANE, 'main.js'), 'utf8'))
})

test('a Herdr app 0.9 set up takes the new pane over the one 0.9 kept current, and stays on the layout 0.9 switched it to', async () => {
  const { herdr, record } = herdrHomeIn()
  mkdirSync(join(herdr, 'mods', 'anyhost'), { recursive: true })
  writeFileSync(join(herdr, 'mods', 'anyhost', 'main.js'), 'export default class Older {}\n')
  writeFileSync(join(herdr, 'mods', 'anyhost', '.switched'), '')

  await installHerdr(record, herdr)

  expect(readdirSync(join(herdr, 'mods'))).toEqual(['anyhost'])
  expect(readFileSync(join(herdr, 'mods', 'anyhost', 'main.js'), 'utf8')).toBe(readFileSync(join(PANE, 'main.js'), 'utf8'))
  expect((jsonOf(record) as { switched: boolean }).switched).toBe(true)
})

test("an uninstall takes out the pane, the layout, the keys and the Claude Code launcher anyhost added, and keeps every one the person changed since", async () => {
  const home = temporaryFolder()
  const { herdr, record } = herdrHomeIn(home)
  mkdirSync(join(herdr, 'layouts'), { recursive: true })
  writeFileSync(join(herdr, 'layouts', 'main.json'), JSON.stringify({ id: 'root', type: 'row', children: [] }))
  writeFileSync(join(herdr, 'keys.json'), JSON.stringify({ global: { 'cmd-p': 'mod.open:picker', 'cmd-w': 'tab.close' } }))
  writeFileSync(join(herdr, 'programs.json'), JSON.stringify({ programs: { claude: { name: 'Claude' } } }))
  await installHerdr(record, herdr)
  const keys = jsonOf(join(herdr, 'keys.json')) as { global: Record<string, string>; 'layout:anyhost': Record<string, string> }
  writeFileSync(join(herdr, 'keys.json'), JSON.stringify({ ...keys, 'layout:anyhost': { ...keys['layout:anyhost'], 'cmd-w': 'files.open' } }))

  await uninstallHerdr(record, herdr)

  expect(readdirSync(join(herdr, 'mods'))).toEqual([])
  expect(readdirSync(join(herdr, 'layouts'))).toEqual(['main.json'])
  expect(jsonOf(join(herdr, 'keys.json'))).toEqual({ global: keys.global, 'layout:anyhost': { 'cmd-w': 'files.open' } })
  expect(jsonOf(join(herdr, 'programs.json'))).toEqual({ programs: { claude: { name: 'Claude' } } })
})

test('an install after an uninstall switches the Herdr app to the anyhost layout again', async () => {
  const home = temporaryFolder()
  const { herdr, record } = herdrHomeIn(home)
  mkdirSync(join(herdr, 'layouts'), { recursive: true })
  writeFileSync(join(herdr, 'layouts', 'main.json'), JSON.stringify({ id: 'root', type: 'row', children: [] }))
  const switches = join(home, 'switches')
  script(join(home, 'bin', 'herdr-app'), `#!/bin/sh\necho "$*" >> ${switches}\n`)
  const path = process.env['PATH']
  process.env['PATH'] = `${join(home, 'bin')}:${path ?? ''}`
  whenTestEnds(() => void (process.env['PATH'] = path))
  await installHerdr(record, herdr)

  await uninstallHerdr(record, herdr)
  await installHerdr(record, herdr)

  expect(readFileSync(switches, 'utf8').trim().split('\n')).toEqual(['do layout.switch --name anyhost', 'do layout.switch --name anyhost'])
  expect((jsonOf(record) as { switched: boolean }).switched).toBe(true)
})
