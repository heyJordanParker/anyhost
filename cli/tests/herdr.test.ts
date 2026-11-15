import { expect, onTestFinished, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installHerdr } from '../src/herdr.ts'
import { script, temporaryFolder } from './program.ts'

const RUNNER_WRAP_0_9_0 = 'program="$HOME/.local/share/cmod/programs/anyhost"; [ -x "$program" ] && exec "$program" run -- "$@"; exec "$@"'

const claudeRunIn = async (run: readonly string[]): Promise<{ readonly home: string; readonly run: string[]; readonly name: string }> => {
  const home = temporaryFolder()
  const before = process.env['XDG_STATE_HOME']
  process.env['XDG_STATE_HOME'] = join(home, 'state')
  onTestFinished(() => {
    if (before === undefined) delete process.env['XDG_STATE_HOME']
    else process.env['XDG_STATE_HOME'] = before
  })
  const herdr = join(home, '.config', 'herdr-app')
  mkdirSync(herdr, { recursive: true })
  writeFileSync(join(herdr, 'programs.json'), JSON.stringify({ programs: { claude: { name: 'Claude', run } } }))
  await installHerdr(herdr)
  await installHerdr(herdr)
  const { programs } = JSON.parse(readFileSync(join(herdr, 'programs.json'), 'utf8')) as { programs: { claude: { name: string; run: string[] } } }
  expect(existsSync(join(herdr, 'mods', 'anyhost', 'main.js'))).toBe(true)
  return { home, run: programs.claude.run, name: programs.claude.name }
}

test("the Herdr app's Claude Code starts through anyhost's launcher, once, without a Claude Code session's markers, and with no anyhost process of its own", async () => {
  const { home, run, name } = await claudeRunIn(['claude', '--model', 'opus'])
  const bin = join(home, 'bin')
  script(join(bin, 'claude'), '#!/bin/sh\necho "claude $* ${CLAUDE_CODE_CHILD_SESSION:-unmarked}"\n')

  const ran = Bun.spawnSync(run, { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CODE_CHILD_SESSION: '1' } })

  expect(name).toBe('Claude')
  expect(run[0]).toBe('perl')
  expect(ran.stdout.toString()).toBe('claude --model opus unmarked\n')
})

test("a Herdr app set up by 0.9.0 runs its own Claude Code command through the launcher, with 0.9.0's runner taken out", async () => {
  const { run } = await claudeRunIn(['sh', '-c', RUNNER_WRAP_0_9_0, 'anyhost', 'claude', '--model', 'opus'])

  expect(run.slice(-3)).toEqual(['claude', '--model', 'opus'])
  expect(run).not.toContain(RUNNER_WRAP_0_9_0)
})

test("the Herdr app's sidebar shows the inbox over the projects, split by a divider the person drags, and the rest of its layout as the app ships it", async () => {
  const herdr = join(temporaryFolder(), 'herdr-app')
  mkdirSync(join(herdr, 'layouts'), { recursive: true })
  const lists = { id: 'sidebar-lists', type: 'column', children: [{ id: 'spaces', type: 'block', content: { mod: 'spaces' } }, { id: 'agents', type: 'block', content: { mod: 'agents' } }] }
  const tab = { id: 'main', type: 'block', min: 200, content: { tab: 'active' } }
  const main = { id: 'root', type: 'row', children: [{ id: 'sidebar', type: 'column', children: [{ id: 'brand', type: 'block' }, lists] }, { id: 'work', type: 'column', children: [{ id: 'tabs', type: 'block', size: { px: 30 }, content: { mod: 'tabs' } }, tab] }] }
  writeFileSync(join(herdr, 'layouts', 'main.json'), JSON.stringify(main))

  await installHerdr(herdr)

  const written = JSON.parse(readFileSync(join(herdr, 'layouts', 'anyhost.json'), 'utf8')) as { children: Record<string, unknown>[] & { children?: unknown[] }[] }
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
        children: [
          { id: 'main', type: 'block', content: { tab: 'active' } },
          { id: 'tiles', type: 'row', children: [] },
          { id: 'board', type: 'block', content: { mod: 'anyhost', props: { view: 'board' } } },
        ],
      },
    ],
  })
})

test("in the anyhost layout the person's picker key opens the palette, the tab and pane keys act on the workspace in its view, the pane keys' modifier with enter, m, =, -, comma and period promote, cycle the view, size the master and scroll, and every other key stays the person's", async () => {
  const herdr = join(temporaryFolder(), 'herdr-app')
  mkdirSync(herdr, { recursive: true })
  const global = {
    'cmd-p': 'mod.open:picker',
    'cmd-t': 'tab.new',
    'ctrl-shift-t': 'tab.new',
    'cmd-w': 'tab.close',
    'ctrl-tab': 'tab.next',
    'ctrl-shift-tab': 'tab.prev',
    'cmd-shift-enter': 'pane.zoom',
    'cmd-alt-left': 'pane.go:left',
    'cmd-alt-right': 'pane.go:right',
    'cmd-alt-up': 'pane.go:up',
    'cmd-alt-down': 'pane.go:down',
    'cmd-alt-shift-left': 'pane.swap:left',
    'cmd-alt-shift-right': 'pane.swap:right',
    'cmd-d': 'pane.split:right',
  }
  writeFileSync(join(herdr, 'keys.json'), JSON.stringify({ global, terminal: { 'cmd-c': 'terminal.copy' } }))

  await installHerdr(herdr)
  await installHerdr(herdr)

  expect(JSON.parse(readFileSync(join(herdr, 'keys.json'), 'utf8'))).toEqual({
    global,
    terminal: { 'cmd-c': 'terminal.copy' },
    'layout:anyhost': {
      'cmd-p': 'anyhost.palette',
      'cmd-w': 'anyhost.close',
      'cmd-shift-t': 'anyhost.reopen',
      'ctrl-shift-alt-t': 'anyhost.reopen',
      'ctrl-tab': 'anyhost.next',
      'ctrl-shift-tab': 'anyhost.prev',
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

test('no keys file is written where the Herdr app has not made one, so it still installs its own', async () => {
  const herdr = join(temporaryFolder(), 'herdr-app')
  mkdirSync(herdr, { recursive: true })

  await installHerdr(herdr)

  expect(existsSync(join(herdr, 'keys.json'))).toBe(false)
})
