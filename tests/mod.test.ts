import { expect, test } from 'bun:test'
import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'
import type { Mod, ProcessSpawnOptions, Subprocess } from '../node_modules/@cmodjs/core/mod.js'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { anyhost } from '../src/mod.js'
import { connectStep, type AnyhostState } from '../src/pages/machines.js'

type Spawned = ProcessSpawnOptions & { readonly argv: readonly string[] }
type Ended = Awaited<Subprocess['result']>

function held(): Subprocess {
  async function* read(): AsyncGenerator<{ readonly stream: 'stdout'; readonly text: string }, Ended> {
    yield { stream: 'stdout', text: 'held\n' }
    return { code: 0, signal: null }
  }
  return Object.assign(read(), { result: Promise.resolve<Ended>({ code: 0, signal: null }) }) as Subprocess
}

const SOCKET = '/test/home/.local/state/anyhost/serve.sock'
const instance = { '/test/home/.local/share/cmod/instances/anyhost/anyhost.json': JSON.stringify({ address: `unix:${SOCKET}` }) }

function withHolder(holder: { machine?: string; problem?: string; untold?: string }, status = 200) {
  const tested = testMod(anyhost, { files: instance })
  const spawned: Spawned[] = []
  const fetched: string[] = []
  tested.fakes.process.spawn = (request) => {
    spawned.push(request)
    return held()
  }
  tested.fakes.http.fetch = async (url, init) => {
    fetched.push(`${init?.socketPath ?? ''} ${url}`)
    return { status, ok: status === 200, headers: {}, text: status === 200 ? JSON.stringify(holder) : 'The relay refused the request.' }
  }
  return { tested, spawned, fetched }
}

test('the mod runs the anyhost program as a service of the computer, with the machine in its environment', async () => {
  const { tested, spawned } = withHolder({})
  await tested.start()

  expect(spawned).toEqual([
    {
      argv: [
        '/test/home/.local/share/cmod/programs/cmod', 'program', 'anyhost', '--service',
        '--env', 'ANYHOST_DEVICE_ID', '--env', 'ANYHOST_DEVICE_NAME', '--env', 'ANYHOST_DEVICE_OS', '--env', 'ANYHOST_DEVICE_ARCH',
        '--', 'anyhost', 'serve',
      ],
      env: { ANYHOST_DEVICE_ID: '5f0e8c2a9b7d4e31a6c4d2b0e8f71a93', ANYHOST_DEVICE_NAME: 'test-computer', ANYHOST_DEVICE_OS: 'linux', ANYHOST_DEVICE_ARCH: 'x64', CLAUDE_CODE_SESSION_ID: 'test-session' },
    },
  ])
})

test('a session whose claim another device holds refuses prompts', async () => {
  const { tested, fetched } = withHolder({ machine: 'anyhost-b' })

  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toEqual({ refuse: 'This session continues on anyhost-b.' })
  expect(fetched).toEqual([`${SOCKET} http://localhost/claims/test-session`])
})

test('a program that fails to answer the check lets the prompt through and says why, once a session', async () => {
  const { tested } = withHolder({}, 500)

  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toBeUndefined()
  await tested.raise.beforePrompt({ text: 'And again' })
  expect(tested.shown.toasts.filter(({ type }) => type === 'error')).toEqual([
    { type: 'error', message: 'anyhost could not check which machine holds this session', description: 'The anyhost program answered 500: The relay refused the request.' },
  ])
})

test('a cloned machine shows why anyhost captures nothing, once a session', async () => {
  const { tested } = withHolder({ problem: 'This machine, anyhost-c, has the id of anyhost-a.' })

  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toBeUndefined()
  await tested.raise.beforePrompt({ text: 'And again' })
  expect(tested.shown.toasts.filter(({ type }) => type === 'error')).toEqual([{ type: 'error', message: 'anyhost captures nothing on this machine', description: 'This machine, anyhost-c, has the id of anyhost-a.' }])
})

test('a session resumed from a machine that was not connected names that machine once, however often it asks', async () => {
  const { tested, fetched } = withHolder({ untold: 'anyhost-a' })

  await tested.raise.onSessionStart({ source: 'resume' })
  await tested.raise.beforePrompt({ text: 'Keep going' })
  expect(fetched).toEqual([`${SOCKET} http://localhost/claims/test-session`, `${SOCKET} http://localhost/claims/test-session`])
  expect(tested.shown.toasts.filter(({ type }) => type === 'warning')).toEqual([
    {
      type: 'warning',
      message: 'anyhost-a may take one more prompt of this session',
      description: "anyhost-a's anyhost was not connected when this machine took the session, so it learns that this machine holds the session when it next connects.",
    },
  ])
})

test('a session this device holds, or no device claims, takes prompts', async () => {
  const { tested } = withHolder({})

  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toBeUndefined()
})

const textOf = (body: string | { readonly base64: string }): string => (typeof body === 'string' ? body : atob(body.base64))

type Answer = { readonly status?: number; readonly body: unknown; readonly delayMs?: number }
type Asked = { readonly method: string; readonly path: string; readonly body?: unknown }

function withProgram(answers: Record<string, Answer[]>) {
  let started: Mod<AnyhostState> | undefined
  const definition = {
    ...anyhost,
    setup: async (mod: Parameters<typeof anyhost.setup>[0]) => {
      started = mod
      await anyhost.setup(mod)
      const step = mod.sidebar.add({ id: 'step', title: connectStep.title, render: (current, props) => connectStep.render(current, props) })
      mod.use(slashCommand({ name: 'step', description: 'Show the Step', reply: () => step.open({ focus: true }) }))
    },
  }
  const tested = testMod(definition, { files: instance })
  const asked: Asked[] = []
  const ticks: (() => unknown)[] = []
  const every = new Map<number, () => unknown>()
  const copied: string[] = []
  tested.fakes.process.spawn = () => held()
  tested.fakes.clock.every = (ms, tick) => {
    ticks.push(tick)
    every.set(ms, tick)
    return { cancel: () => undefined }
  }
  tested.fakes.ui.copy = async ({ text }) => {
    copied.push(text)
    return { isCopied: true }
  }
  tested.fakes.http.fetch = async (url, init) => {
    if (init?.socketPath !== SOCKET) throw new Error(`The mod asked ${url} at ${init?.socketPath}, not at the service's socket.`)
    const path = url.replace('http://localhost', '')
    const method = init?.method ?? 'GET'
    asked.push({ method, path, ...(init?.body === undefined ? {} : { body: JSON.parse(textOf(init.body)) }) })
    const queue = answers[`${method} ${path}`] ?? []
    const answer = (queue.length > 1 ? queue.shift() : queue[0]) ?? { status: 404, body: { message: `No answer for ${method} ${path}.` } }
    const status = answer.status ?? 200
    await Bun.sleep(answer.delayMs ?? 0)
    return { status, ok: status === 200, headers: {}, text: JSON.stringify(answer.body) }
  }
  const mod = async (): Promise<Mod<AnyhostState>> => {
    await tested.start()
    if (started === undefined) throw new Error('The mod did not start.')
    return started
  }
  return { tested, asked, ticks, every, copied, mod }
}

const relayIs = (state: string): Answer => ({ body: { relay: { state, message: '' } } })

test('the Step is left to do on a machine not joined or on a relay too old, and done once joined', async () => {
  for (const state of ['unjoined', 'outdated']) {
    const { mod } = withProgram({ 'GET /status': [relayIs(state)] })
    expect(await connectStep.isDone(await mod())).toBe(false)
  }
  for (const state of ['connected', 'offline', 'refused']) {
    const { mod } = withProgram({ 'GET /status': [relayIs(state)] })
    expect(await connectStep.isDone(await mod())).toBe(true)
  }
  const { mod, asked } = withProgram({ 'GET /status': [relayIs('connecting'), relayIs('connecting'), relayIs('connected')] })
  expect(await connectStep.isDone(await mod())).toBe(true)
  expect(asked.filter(({ path }) => path === '/status')).toHaveLength(3)
})

test('the Step waits while the program joins with the link of the install command, and is done once the join lands', async () => {
  const joining: Answer = { body: { relay: { state: 'unjoined', message: '' }, joining: { is: 'running' } } }
  const { mod, asked } = withProgram({ 'GET /status': [joining, joining, joining, relayIs('connecting'), relayIs('connected')] })
  expect(await connectStep.isDone(await mod())).toBe(true)
  expect(asked.filter(({ path }) => path === '/status')).toHaveLength(5)
})

test('the Step on a program whose install command\'s link joined no relay shows why, and how to join', async () => {
  const error = 'https://anyhost.parker-labs.workers.dev refused to join test-computer: The invite expired at 2026-11-07T09:10:00.000Z, 10 minutes after it was made. Make a new one with Add a machine.'
  const { tested, mod } = withProgram({ 'GET /status': [{ body: { relay: { state: 'unjoined', message: '' }, joining: { is: 'failed', error } } }] })
  expect(await connectStep.isDone(await mod())).toBe(false)
  await tested.type('/step')
  const drawn = (await tested.shown.page.lines({ columns: 400 })).join('\n')
  expect(drawn).toContain(`The invite link of the install command joined no relay: ${error}`)
  expect(drawn).toContain('anyhost tries a link once. Add this machine again from /machines on a joined machine.')
})

test('a machine removed after a link pasted on the Step joined it gets the Step afresh', async () => {
  const command = "cmod install heyJordanParker/anyhost --option 'join=https://anyhost.parker-labs.workers.dev/v1/join#K7QX2M4W9TPR6ZC3HN8JD5VB'"
  const removed = 'This machine was removed from your machines. Join it again with a link from Add a machine.'
  const { tested, mod } = withProgram({ 'POST /join': [{ body: { url: 'https://anyhost.parker-labs.workers.dev' } }], 'GET /status': [{ body: { relay: { state: 'unjoined', message: removed } } }] })
  const started = await mod()
  await tested.type('/step')
  await tested.shown.page.input('invite', command)
  expect((await tested.shown.page.lines()).join('\n')).toContain('✔ Joined https://anyhost.parker-labs.workers.dev')

  expect(await connectStep.isDone(started)).toBe(false)
  expect((await tested.shown.page.lines()).join('\n')).not.toContain('✔ Joined')
})

test('Connect Cloudflare on the Step shows each line, asks for the account, and says when this machine joined', async () => {
  const accounts = [{ id: 'a1', name: 'Parker Labs' }, { id: 'a2', name: 'Side Project' }]
  const asking = { is: 'running', lines: ['Checking your Cloudflare login'], accounts }
  const running = { is: 'running', lines: ['Checking your Cloudflare login', 'Found the bucket anyhost in the eu jurisdiction'] }
  const joined = { is: 'joined', lines: [...running.lines, 'Joined this machine to https://anyhost.parker-labs.workers.dev'] }
  const { tested, asked, ticks } = withProgram({
    'POST /connect': [{ body: asking }],
    'POST /connect/account': [{ body: running }],
    'GET /status': [{ body: { relay: { state: 'connected', message: '' }, connecting: joined } }],
  })
  await tested.type('/step')
  await tested.shown.page.press('connect')
  const lines = (await tested.shown.page.lines()).join('\n')
  expect(lines).toContain('Checking your Cloudflare login')
  expect(lines).toContain('Pick the one your relay goes in')
  expect(lines).not.toContain('[Connect Cloudflare]')

  await tested.shown.page.press('account-a1')
  expect(asked.at(-1)).toEqual({ method: 'POST', path: '/connect/account', body: { id: 'a1' } })
  expect((await tested.shown.page.lines()).join('\n')).toContain('Found the bucket anyhost in the eu jurisdiction')
  for (const tick of ticks) await tick()
  await tested.settle()
  const done = (await tested.shown.page.lines()).join('\n')
  expect(done).toContain('Joined this machine to https://anyhost.parker-labs.workers.dev')
  expect(done).toContain('This machine is joined to your relay.')
  expect(done).not.toContain('[Connect Cloudflare]')
})

test('a machine removed after Connect Cloudflare joined it gets the Step afresh, with Connect Cloudflare to press', async () => {
  const joined = { is: 'joined', lines: ['Joined this machine to https://anyhost.parker-labs.workers.dev'] }
  const removed = 'This machine was removed from your machines. Join it again with a link from Add a machine.'
  const { tested, mod } = withProgram({ 'GET /status': [{ body: { relay: { state: 'unjoined', message: removed }, connecting: joined } }] })
  expect(await connectStep.isDone(await mod())).toBe(false)
  await tested.type('/step')
  const drawn = (await tested.shown.page.lines()).join('\n')
  expect(drawn).toContain('[Connect Cloudflare]')
  expect(drawn).not.toContain('Joined this machine')
})

test('a Step whose Connect Cloudflare joined keeps the run while the relay still reads outdated, and says what Finish waits for', async () => {
  const joined = { is: 'joined', lines: ['Uploading the relay as the Worker anyhost', 'Joined this machine to https://anyhost.parker-labs.workers.dev'] }
  const outdated = 'The relay at https://anyhost.parker-labs.workers.dev answers protocol 1, and anyhost 0.3.0 needs 2. Connect Cloudflare again to update the relay.'
  const { tested, mod } = withProgram({ 'GET /status': [{ body: { relay: { state: 'outdated', message: outdated }, connecting: joined } }] })
  expect(await connectStep.isDone(await mod())).toBe(false)
  await tested.type('/step')
  const drawn = (await tested.shown.page.lines({ columns: 400 })).join('\n')
  expect(drawn).toContain('Joined this machine to https://anyhost.parker-labs.workers.dev')
  expect(drawn).toContain('✔ This machine is joined to your relay.')
  expect(drawn).toContain("Cloudflare still runs your relay's older version, for up to 5 minutes after the upload. Press Finish once it runs the new one.")
  expect(drawn).not.toContain('[Connect Cloudflare]')
})

test('the Step shows the R2 page while R2 is off, and Next tells the program it is on', async () => {
  const off = { is: 'running', lines: ['R2 is off in Parker Labs. Turn it on at https://dash.cloudflare.com/?to=/:account/r2/overview, then go on.'], r2Page: 'https://dash.cloudflare.com/?to=/:account/r2/overview' }
  const { tested, asked } = withProgram({ 'POST /connect': [{ body: off }], 'POST /connect/r2': [{ body: { is: 'running', lines: off.lines } }] })
  await tested.type('/step')
  await tested.shown.page.press('connect')
  expect((await tested.shown.page.lines()).join('\n')).toContain("[Open Cloudflare's R2 page]  Turn R2 on there, then press Next.  [Next]")

  await tested.shown.page.press('r2-next')
  expect(asked.at(-1)).toEqual({ method: 'POST', path: '/connect/r2', body: {} })
  expect((await tested.shown.page.lines()).join('\n')).not.toContain('press Next')
})

test('the command or link pasted on the Step joins this machine, or says why the relay refused it', async () => {
  const command = "cmod install heyJordanParker/anyhost --option 'join=https://anyhost.parker-labs.workers.dev/v1/join#K7QX2M4W9TPR6ZC3HN8JD5VB'"
  const { tested, asked } = withProgram({
    'POST /join': [{ body: { url: 'https://anyhost.parker-labs.workers.dev' } }, { status: 500, body: { message: 'https://anyhost.parker-labs.workers.dev refused to join test-computer: The invite already joined anyhost-b.' } }],
  })
  await tested.type('/step')
  await tested.shown.page.input('invite', command)
  expect(asked.at(-1)).toEqual({ method: 'POST', path: '/join', body: { link: command } })
  expect((await tested.shown.page.lines()).join('\n')).toContain('✔ Joined https://anyhost.parker-labs.workers.dev')

  await tested.shown.page.input('invite', command)
  expect((await tested.shown.page.lines()).join(' ')).toContain('refused to join test-computer: The invite already joined anyhost-b.')
})

const machines = {
  here: 'mac-id',
  machines: [
    { id: 'b-id', name: 'anyhost-b', os: 'linux', arch: 'arm64', connected: false, seenAt: '2026-11-05T08:00:00.000Z' },
    { id: 'mac-id', name: 'macbook', os: 'darwin', arch: 'arm64', connected: true, seenAt: '2026-11-06T09:00:00.000Z' },
  ],
  candidates: [{ target: 'mac-studio', os: 'macOS', online: true }],
  adding: [],
}

test('/machines lists every machine, adds one over ssh from your Tailscale network, and removes another machine', async () => {
  const adding = { ...machines, candidates: [], adding: [{ target: 'mac-studio' }] }
  const { tested, asked } = withProgram({
    'GET /machines': [{ body: machines }, { body: adding }, { body: { ...adding, machines: machines.machines.slice(1) } }],
    'POST /machines/add': [{ body: { target: 'mac-studio' } }],
    'POST /machines/remove': [{ body: {} }],
  })
  await tested.type('/machines')
  await tested.settle()
  const listed = (await tested.shown.page.lines()).map((line) => line.trim())
  expect(listed.find((line) => line.startsWith('anyhost-b'))).toMatch(/^anyhost-b {2}linux-arm64 {3}last seen .+ {2}\[Remove\]$/)
  expect(listed.find((line) => line.startsWith('macbook'))).toBe('macbook    darwin-arm64  connected  this machine')

  await tested.shown.page.press('add')
  expect((await tested.shown.page.lines({ columns: 160 })).join('\n')).toContain('On your Tailscale network:  [mac-studio]')
  await tested.shown.page.press('candidate-mac-studio')
  expect(asked.filter(({ method }) => method === 'POST').at(-1)).toEqual({ method: 'POST', path: '/machines/add', body: { target: 'mac-studio' } })
  expect((await tested.shown.page.lines({ columns: 160 })).join('\n')).toContain('Adding mac-studio: anyhost installs there and joins it')

  await tested.shown.page.press('remove-b-id')
  expect((await tested.shown.page.lines()).join('\n')).toContain('Remove anyhost-b? It stops uploading at once')
  await tested.shown.page.press('remove-yes-b-id')
  expect(asked.filter(({ method }) => method === 'POST').at(-1)).toEqual({ method: 'POST', path: '/machines/remove', body: { id: 'b-id' } })
  expect((await tested.shown.page.lines()).some((line) => line.startsWith('anyhost-b'))).toBe(false)
})

const moveIs = (step: string, line: string, machine?: string): Answer => ({ body: { ...(machine === undefined ? {} : { machine }), move: { to: 'anyhost-a', step, line } } })
const moveToasts = (tested: ReturnType<typeof withProgram>['tested']) => tested.shown.toasts.filter(({ message }) => message !== 'Installed')

test('/move asks the program to move the session, takes prompts until another machine holds the session, and follows each step in its toast', async () => {
  const { tested, asked, every } = withProgram({
    'POST /move': [{ body: { session: 'test-session', to: 'anyhost-a', step: 'waiting', line: 'Waiting for test-ses to finish its turn.' } }],
    'GET /claims/test-session': [
      moveIs('uploading', 'Uploading test-ses.'),
      moveIs('uploading', 'Uploading test-ses.'),
      moveIs('moving', 'Uploaded and sealed test-ses. anyhost-a restores it.', 'anyhost-a'),
      moveIs('moving', 'Uploaded and sealed test-ses. anyhost-a restores it.', 'anyhost-a'),
      moveIs('moved', 'anyhost-a restored test-ses in 2.4 s and runs it.', 'anyhost-a'),
    ],
  })
  await tested.type('/move anyhost-a')
  expect(asked.filter(({ method }) => method === 'POST')).toEqual([{ method: 'POST', path: '/move', body: { session: 'test-session', machine: 'anyhost-a' } }])
  expect(moveToasts(tested)).toEqual([{ type: 'loading', message: 'Moving to anyhost-a…' }])

  const follow = async (): Promise<void> => {
    await every.get(1000)?.()
    await tested.settle()
  }
  await follow()
  expect(moveToasts(tested)).toEqual([{ type: 'loading', message: 'Moving to anyhost-a…', description: 'Uploading test-ses.' }])
  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toBeUndefined()
  await follow()
  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toEqual({ refuse: 'This session continues on anyhost-a.' })

  await follow()
  const continues = 'This session continues on anyhost-a, in a terminal of herdr-core there. The anyhost pane of the Herdr app opens it.'
  expect(moveToasts(tested)).toEqual([{ type: 'info', message: continues, description: 'anyhost-a restored test-ses in 2.4 s and runs it.' }])
  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toEqual({ refuse: continues })
})

const SLOW_MS = 3000

test('a program slow to answer holds no prompt: it goes through within the 1.5 s bound, with no toast', async () => {
  const { tested } = withProgram({ 'GET /claims/test-session': [{ body: { machine: 'anyhost-b' }, delayMs: SLOW_MS }] })
  await tested.start()

  const started = Date.now()
  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toBeUndefined()
  expect(Date.now() - started).toBeLessThan(2000)
  expect(moveToasts(tested)).toEqual([])
})

test('a prompt during a move goes through, as the move waits for its turn before it stops the session, though the program answers slowly', async () => {
  const { tested } = withProgram({
    'POST /move': [{ body: { session: 'test-session', to: 'anyhost-a', step: 'uploading', line: 'Uploading test-ses.' } }],
    'GET /claims/test-session': [{ ...moveIs('uploading', 'Uploading test-ses.'), delayMs: SLOW_MS }],
  })
  await tested.type('/move anyhost-a')

  const started = Date.now()
  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toBeUndefined()
  expect(Date.now() - started).toBeLessThan(2000)
})

test('a move that failed shows why in its toast, and the session takes prompts again', async () => {
  const { tested, every } = withProgram({
    'POST /move': [{ body: { session: 'test-session', to: 'anyhost-a', step: 'waiting', line: 'Waiting for test-ses to finish its turn.' } }],
    'GET /claims/test-session': [moveIs('failed', 'anyhost-a is offline, so the session keeps running here.')],
  })
  await tested.type('/move anyhost-a')
  await every.get(1000)?.()
  await tested.settle()

  expect(moveToasts(tested)).toEqual([{ type: 'error', message: 'anyhost-a is offline, so the session keeps running here.' }])
  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toBeUndefined()
})

test('a move the program forgot, as it restarted, says so and stops following it', async () => {
  const { tested, every } = withProgram({
    'POST /move': [{ body: { session: 'test-session', to: 'anyhost-a', step: 'uploading', line: 'Uploading test-ses.' } }],
    'GET /claims/test-session': [{ body: {} }],
  })
  await tested.type('/move anyhost-a')
  await every.get(1000)?.()
  await tested.settle()

  expect(moveToasts(tested)).toEqual([{ type: 'error', message: 'anyhost lost track of the move, as its program restarted', description: 'anyhost list shows which machine holds the session now.' }])
})

test('a move anyhost move asked for, which a prompt finds running, gets the toast that follows it and offers Keep it here', async () => {
  const waiting = 'anyhost-a took test-ses and does not answer. Keep it here takes the session back.'
  const { tested, every } = withProgram({ 'GET /claims/test-session': [moveIs('moving', waiting, 'anyhost-a')] })
  await tested.start()

  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toEqual({ refuse: 'This session continues on anyhost-a.' })
  await every.get(1000)?.()
  await tested.settle()

  expect(moveToasts(tested)).toEqual([{ type: 'loading', message: 'Moving to anyhost-a…', description: waiting }])
})

test('/move names the machine to move to, and shows why the program refused the move', async () => {
  const { tested } = withProgram({ 'POST /move': [{ status: 400, body: { message: 'No machine joined to your relay is named devbx. anyhost machines lists them.' } }] })

  expect(await tested.type('/move')).toEqual({ text: 'Name the one machine to move this session to, as in /move devbox. /machines lists your machines.' })
  expect(await tested.type('/move devbx')).toEqual({ text: '/move failed: No machine joined to your relay is named devbx. anyhost machines lists them.' })
  expect(moveToasts(tested)).toEqual([])
})

const AGENT = { id: '3f9c2b1e-7a4d-4c55-9b0e-2d8f61a0c7e4', tool: 'claude', title: 'Checkout retry', firstPrompt: 'Make the checkout retry a declined card once', machine: 'devbox', holder: 'devbox', status: 'idle', lastActivity: '2026-11-10T14:02:00.000Z', repo: 'git@github.com:acme/shop.git', cwd: '/home/jordan/shop', entrypoint: 'cli', device: 'd1', archived: false, parent: '' }
const MACHINES = { here: 'd0', machines: [{ id: 'd0', name: 'test-computer', connected: true, seenAt: '' }, { id: 'd1', name: 'devbox', connected: true, seenAt: '' }] }

test('Claude lists every agent of every machine with what it does, starts one on a machine with its first message, and tells, reads or answers one wherever it runs', async () => {
  const told = { machine: 'devbox', session: AGENT.id, status: 'working', screen: '❯ Book the train' }
  const { tested, asked } = withProgram({
    'GET /agents': [{ body: { agents: [AGENT, { ...AGENT, id: 'b2' }] } }],
    'POST /new': [{ body: { session: 'c3', machine: 'devbox' } }],
    'POST /agents/tell': [{ body: told }],
  })

  expect(await tested.callTool('list_agents', { limit: 1 })).toEqual({
    result: JSON.stringify([{ id: AGENT.id, tool: 'claude', title: 'Checkout retry', firstPrompt: AGENT.firstPrompt, machine: 'devbox', holder: 'devbox', status: 'idle', lastActivity: AGENT.lastActivity, repo: AGENT.repo, cwd: AGENT.cwd, archived: false, parent: null }]),
  })
  expect(await tested.callTool('start_agent', { folder: '/Users/jordan/shop', machine: 'devbox', prompt: 'You are the CTO. Watch every agent.' })).toEqual({ result: JSON.stringify({ session: 'c3', machine: 'devbox' }) })
  expect(await tested.callTool('tell_agent', { agent: '3f9c2b1e', text: 'Book the train' })).toEqual({ result: JSON.stringify(told) })
  expect(await tested.callTool('read_agent', { agent: '3f9c2b1e', lines: 40 })).toEqual({ result: JSON.stringify(told) })
  expect(await tested.callTool('press_keys', { agent: '3f9c2b1e', keys: ['down', 'enter'] })).toEqual({ result: JSON.stringify(told) })
  expect(asked.filter(({ method }) => method === 'POST')).toEqual([
    { method: 'POST', path: '/new', body: { folder: '/Users/jordan/shop', machine: 'devbox', prompt: 'You are the CTO. Watch every agent.', parent: 'test-session' } },
    { method: 'POST', path: '/agents/tell', body: { session: '3f9c2b1e', text: 'Book the train', sender: 'test-session' } },
    { method: 'POST', path: '/agents/tell', body: { session: '3f9c2b1e', lines: 40 } },
    { method: 'POST', path: '/agents/tell', body: { session: '3f9c2b1e', keys: ['down', 'enter'] } },
  ])
})

test("Claude lists the agents it started with their parent and its machine, reads a child's last messages, and deletes a child but never itself", async () => {
  const child = { ...AGENT, id: 'c4000000-0000-4000-8000-000000000000', title: 'Book the train', parent: 'test-session' }
  const messages = [{ role: 'assistant', at: '2026-11-12T10:00:04.000Z', text: 'Booked the 9:15 train.' }]
  const { tested, asked } = withProgram({
    'GET /agents': [{ body: { agents: [child, { ...AGENT, id: 'test-session', title: 'CTO', holder: 'mac-studio' }, AGENT] } }],
    'POST /agents/tell': [{ body: { machine: 'devbox', session: child.id, status: 'idle', screen: '', messages } }],
    'POST /agents/delete': [{ body: { session: child.id } }],
  })

  expect(await tested.callTool('list_agents', { children_of: 'me' })).toEqual({
    result: JSON.stringify([{ id: child.id, tool: 'claude', title: 'Book the train', firstPrompt: AGENT.firstPrompt, machine: 'devbox', holder: 'devbox', status: 'idle', lastActivity: AGENT.lastActivity, repo: AGENT.repo, cwd: AGENT.cwd, archived: false, parent: { id: 'test-session', title: 'CTO', machine: 'mac-studio' } }]),
  })
  expect(await tested.callTool('read_agent', { agent: 'c4000000', messages: 1 })).toEqual({ result: JSON.stringify({ machine: 'devbox', session: child.id, status: 'idle', screen: '', messages }) })
  expect(await tested.callTool('delete_agent', { agent: 'c4000000' })).toEqual({ result: 'Deleted c4000000.' })
  expect(await tested.callTool('delete_agent', { agent: 'test-session' })).toEqual({ deny: 'The delete_agent tool failed: test-ses is this agent, which cannot delete itself.' })
  expect(asked.filter(({ method }) => method === 'POST')).toEqual([
    { method: 'POST', path: '/agents/tell', body: { session: 'c4000000', messages: 1 } },
    { method: 'POST', path: '/agents/delete', body: { session: child.id } },
  ])
})

test('Claude moves an agent this machine runs through its program, and one another machine runs by typing /move into it there', async () => {
  const { tested, asked } = withProgram({
    'GET /agents': [{ body: { agents: [AGENT, { ...AGENT, id: '7c1d0e9a-0000-4000-8000-000000000000', holder: 'test-computer' }] } }],
    'GET /machines': [{ body: MACHINES }],
    'POST /move': [{ body: { session: '7c1d0e9a-0000-4000-8000-000000000000', line: 'Uploading 7c1d0e9a.' } }],
    'POST /agents/tell': [{ body: { machine: 'devbox', session: AGENT.id, status: 'working', screen: '❯ /move mac-studio' } }],
  })

  expect(await tested.callTool('move_agent', { agent: '7c1d0e9a', machine: 'devbox' })).toEqual({ result: JSON.stringify({ session: '7c1d0e9a-0000-4000-8000-000000000000', line: 'Uploading 7c1d0e9a.' }) })
  expect(await tested.callTool('move_agent', { agent: '3f9c2b1e', machine: 'mac-studio' })).toEqual({ result: 'devbox moves 3f9c2b1e to mac-studio once its turn ends. read_agent shows how it goes.' })
  expect(asked.filter(({ method }) => method === 'POST').map(({ path, body }) => ({ path, body }))).toEqual([
    { path: '/move', body: { session: '7c1d0e9a-0000-4000-8000-000000000000', machine: 'devbox' } },
    { path: '/agents/tell', body: { session: AGENT.id, text: '/move mac-studio' } },
  ])
})

test('Claude opens an agent on this machine, as when the machine that ran it is offline, and gets its terminal', async () => {
  const { tested, asked } = withProgram({ 'POST /agents/open': [{ body: { session: AGENT.id, terminal: 't3', machine: 'test-computer' } }] })

  expect(await tested.callTool('open_agent', { agent: '3f9c2b1e' })).toEqual({ result: JSON.stringify({ session: AGENT.id, terminal: 't3', machine: 'test-computer' }) })
  expect(asked.at(-1)).toEqual({ method: 'POST', path: '/agents/open', body: { session: '3f9c2b1e' } })
})

test('Claude adds a machine it reaches over ssh, and removes one by its name', async () => {
  const { tested, asked } = withProgram({
    'POST /machines/add': [{ body: { target: 'mac-studio' } }],
    'GET /machines': [{ body: { here: 'd0', machines: [{ id: 'd2', name: 'mac-studio', connected: true, seenAt: '' }], candidates: [], adding: [] } }],
    'POST /machines/remove': [{ body: {} }],
  })

  expect(await tested.callTool('add_machine', { target: 'mac-studio' })).toEqual({ result: 'Adding mac-studio. list_machines shows it under adding until it joins.' })
  expect(asked.at(-1)).toEqual({ method: 'POST', path: '/machines/add', body: { target: 'mac-studio' } })
  expect(await tested.callTool('remove_machine', { machine: 'mac-studio' })).toEqual({ result: 'Removed mac-studio.' })
  expect(asked.at(-1)).toEqual({ method: 'POST', path: '/machines/remove', body: { id: 'd2' } })
})

test('/machines says why it lists nothing while this machine is not joined', async () => {
  const { tested } = withProgram({ 'GET /machines': [{ status: 503, body: { message: 'This machine is not joined to your relay, so anyhost keeps what its sessions write and uploads nothing.' } }] })
  await tested.type('/machines')
  await tested.settle()
  expect((await tested.shown.page.lines()).join('\n')).toContain('This machine is not joined to your relay')
})
