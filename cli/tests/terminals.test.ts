import { expect, test } from 'bun:test'
import { memoryRelay, until } from './memory.ts'
import { anyhostOn, coreEvent, coreSays, decoder, LAPTOP, logOf, machineFor, OTHER_SESSION, runsOn, sentOn, serveOn, SESSION, sharedIn, terminalIn } from './program.ts'

const SHELL = ['/bin/zsh', '-l']
const RUNNER = ['/home/ada/.local/share/cmod/programs/anyhost', 'run', '--session', SESSION]
const THIRD_SESSION = '33333333-4444-5555-6666-777777777777'

test('a session terminal that herdr-core kept through its restart runs anyhost again in the same terminal, asleep, with no window open', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  coreSays(laptop.folder, {
    seq: 1,
    terminals: [
      terminalIn('t0', SHELL, { 'anyhost.session': SESSION, 'herdr.tab': SESSION.slice(0, 8) }),
      terminalIn('t1', RUNNER, { 'anyhost.session': OTHER_SESSION }),
      terminalIn('t2', SHELL, {}),
      terminalIn('t3', ['sh', '-c', 'exec anyhost "$@"', 'anyhost', 'run', '--session', THIRD_SESSION], { 'anyhost.session': THIRD_SESSION }),
    ],
  })

  await serveOn(laptop.env)
  await until(() => sentOn(laptop.folder).length > 0, 'the program typing into the kept shell', 15_000)
  await Bun.sleep(3000)

  expect(sentOn(laptop.folder)).toEqual([expect.stringMatching(new RegExp(`^t0 exec \\S+ \\S+/main\\.ts run --asleep --session ${SESSION}$`))])
  expect(runsOn(laptop.folder)).toEqual([])
}, 60_000)

test("closing a session's pane archives the session once, and a runner that ends by itself or a view of a session that ends archives nothing", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  coreSays(laptop.folder, {
    seq: 1,
    terminals: [
      terminalIn('t0', RUNNER, { 'anyhost.session': SESSION }),
      terminalIn('t1', RUNNER, { 'anyhost.session': OTHER_SESSION }),
      terminalIn('t2', ['anyhost', 'run', '--asleep', '--session', THIRD_SESSION], { 'anyhost.session': THIRD_SESSION, 'anyhost.view': THIRD_SESSION }, ['hc', 'attach', 't3']),
    ],
  })
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')

  coreSays(
    laptop.folder,
    coreEvent('labels', 't1', { labels: {} }),
    coreEvent('finished', 't1', { exit_code: 0, finished_ms: Date.now(), reason: 'exited', signal: null }),
    coreEvent('finished', 't2', { exit_code: 0, finished_ms: Date.now(), reason: 'killed', signal: null }),
    coreEvent('finished', 't0', { exit_code: 0, finished_ms: Date.now(), reason: 'killed', signal: null }),
  )
  await until(async () => (await sharedIn(relay)).archived?.[SESSION]?.archived === true, 'the closed session archiving', 15_000)
  await Bun.sleep(2000)

  const archives = relay.puts.filter(({ key }) => key === 'shared.json').map(({ body }) => (JSON.parse(decoder.decode(body)) as { archived?: Record<string, { at: string }> }).archived?.[SESSION]?.at)
  expect(new Set(archives.filter((at) => at !== undefined)).size).toBe(1)
  expect((await sharedIn(relay)).archived?.[OTHER_SESSION]).toBeUndefined()
  expect((await sharedIn(relay)).archived?.[THIRD_SESSION]).toBeUndefined()
}, 60_000)

test('a terminal two windows show stays shown while either shows it, and a session is marked read once', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  coreSays(laptop.folder, { seq: 1, terminals: [terminalIn('t0', RUNNER, { 'anyhost.session': SESSION }), terminalIn('t1', ['anyhost', 'run', '--session', SESSION], { 'anyhost.view': SESSION }, ['hc', 'attach', 't0'])] })
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const shownLabels = (): string[] => logOf(laptop.folder, 'labels.log').filter((line) => line.includes(`anyhost.shown.${LAPTOP.id}=`))

  const first = await anyhostOn(laptop.env, ['shown', 'window-a', 't0'])
  const second = await anyhostOn(laptop.env, ['shown', 'window-b', 't1'])
  await until(async () => (await sharedIn(relay)).visited?.[SESSION] !== undefined, 'the shown session marked read', 15_000)
  await anyhostOn(laptop.env, ['shown', 'window-a'])
  await Bun.sleep(1000)
  const whileOneShows = shownLabels()
  await anyhostOn(laptop.env, ['shown', 'window-b'])
  await until(() => shownLabels().length > whileOneShows.length, 'the label leaving the terminal no window shows')

  expect([first.code, second.code]).toEqual([0, 0])
  expect(whileOneShows).toEqual([expect.stringMatching(new RegExp(`^t0 anyhost\\.shown\\.${LAPTOP.id}=\\d+$`))])
  expect(shownLabels().at(-1)).toBe(`t0 anyhost.shown.${LAPTOP.id}=`)
  const visits = relay.puts.filter(({ key }) => key === 'shared.json').map(({ body }) => (JSON.parse(decoder.decode(body)) as { visited?: Record<string, string> }).visited?.[SESSION])
  expect(new Set(visits.filter((at) => at !== undefined)).size).toBe(1)
}, 60_000)
