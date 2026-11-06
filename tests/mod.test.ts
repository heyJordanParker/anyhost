import { expect, test } from 'bun:test'
import type { HookStream, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult } from 'claude-code'
import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'
import type { Mod } from '../node_modules/@cmodjs/core/mod.js'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { anyhost } from '../src/mod.js'
import { connectStep, type AnyhostState } from '../src/pages/machines.js'

// `cmod program --service` loads the service, says `held` and ends, and the session reads the address the service
// wrote to its instance file.
function held(): HookStream<ProcessSpawnChunk, ProcessSpawnResult> {
  async function* read(): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
    yield { stream: 'stdout', text: 'held\n' }
    return { code: 0, signal: null }
  }
  return Object.assign(read(), { result: Promise.resolve<ProcessSpawnResult>({ code: 0, signal: null }) }) as HookStream<ProcessSpawnChunk, ProcessSpawnResult>
}

// The service listens on a unix socket in its state folder, and writes that address to its instance file.
const SOCKET = '/test/home/.local/state/anyhost/serve.sock'
const instance = { '/test/home/.local/share/cmod/instances/anyhost/anyhost.json': JSON.stringify({ address: `unix:${SOCKET}` }) }

function withHolder(holder: { machine?: string; problem?: string; untold?: string }, status = 200) {
  const tested = testMod(anyhost, { files: instance })
  const spawned: ProcessSpawnRequest[] = []
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

test('a session resumed from a machine that was not connected names that machine as it starts', async () => {
  const { tested, fetched } = withHolder({ untold: 'anyhost-a' })

  await tested.raise.onSessionStart({ source: 'resume' })
  expect(fetched).toEqual([`${SOCKET} http://localhost/claims/test-session`])
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

// `delayMs` is how long the program takes to answer, as one busy with other work does
type Answer = { readonly status?: number; readonly body: unknown; readonly delayMs?: number }
type Asked = { readonly method: string; readonly path: string; readonly body?: unknown }

// The anyhost program as the Step and /machines ask it: each answer is the next one `answers` has for its method and
// path, and the last one repeats. The Step draws in a page of the test's own, as the install page draws it.
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
  // the tick of the newest timer of each period
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
    asked.push({ method, path, ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) }) })
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
  // a program that just started is still connecting, so the Step waits for its answer
  const { mod, asked } = withProgram({ 'GET /status': [relayIs('connecting'), relayIs('connecting'), relayIs('connected')] })
  expect(await connectStep.isDone(await mod())).toBe(true)
  expect(asked.filter(({ path }) => path === '/status')).toHaveLength(3)
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
  // the Step follows the run once a second until it ends
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

test('the Step shows the R2 page while R2 is off, and Next tells the program it is on', async () => {
  const off = { is: 'running', lines: ['R2 is off in Parker Labs. Turn it on at https://dash.cloudflare.com/?to=/:account/r2/overview, then go on.'], r2Page: 'https://dash.cloudflare.com/?to=/:account/r2/overview' }
  const { tested, asked } = withProgram({ 'POST /connect': [{ body: off }], 'POST /connect/r2': [{ body: { is: 'running', lines: off.lines } }] })
  await tested.type('/step')
  await tested.shown.page.press('connect')
  expect((await tested.shown.page.lines()).join('\n')).toContain("Turn R2 on at Cloudflare's R2 page, then press Next.")

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
}

test('/machines lists every machine, gives the install command with a fresh invite to copy, and removes another machine', async () => {
  const invite = { command: "cmod install heyJordanParker/anyhost --option 'join=https://anyhost.parker-labs.workers.dev/v1/join#K7QX2M4W9TPR6ZC3HN8JD5VB'", expiresAt: '2026-11-06T09:10:00.000Z' }
  const { tested, asked, copied } = withProgram({
    'GET /machines': [{ body: machines }, { body: { ...machines, machines: machines.machines.slice(1) } }],
    'POST /machines/invite': [{ body: invite }],
    'POST /machines/remove': [{ body: {} }],
  })
  await tested.type('/machines')
  await tested.settle()
  const listed = (await tested.shown.page.lines()).map((line) => line.trim())
  expect(listed.find((line) => line.startsWith('anyhost-b'))).toMatch(/^anyhost-b {2}linux-arm64 {3}last seen .+ {2}\[Remove\]$/)
  expect(listed.find((line) => line.startsWith('macbook'))).toBe('macbook    darwin-arm64  connected  this machine')

  await tested.shown.page.press('add')
  const offered = (await tested.shown.page.lines({ columns: 160 })).join('\n')
  expect(offered).toContain('It joins one machine, until')
  expect(offered).toContain(invite.command)
  await tested.shown.page.press('copy')
  expect(copied).toEqual([invite.command])

  await tested.shown.page.press('remove-b-id')
  expect((await tested.shown.page.lines()).join('\n')).toContain('Remove anyhost-b? It stops uploading at once')
  await tested.shown.page.press('remove-yes-b-id')
  expect(asked.filter(({ method }) => method === 'POST').at(-1)).toEqual({ method: 'POST', path: '/machines/remove', body: { id: 'b-id' } })
  expect((await tested.shown.page.lines()).some((line) => line.startsWith('anyhost-b'))).toBe(false)
})

const moveIs = (step: string, line: string, machine?: string): Answer => ({ body: { ...(machine === undefined ? {} : { machine }), move: { to: 'anyhost-a', step, line } } })
// the toasts of the move, without the one of the mod's first start
const moveToasts = (tested: ReturnType<typeof withProgram>['tested']) => tested.shown.toasts.filter(({ message }) => message !== 'Installed')

test('/move asks the program to move the session, refuses prompts while it moves, and follows each step in its toast', async () => {
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

  // the toast follows the move once a second, and the timer runs its tick without waiting for it
  const follow = async (): Promise<void> => {
    await every.get(1000)?.()
    await tested.settle()
  }
  await follow()
  expect(moveToasts(tested)).toEqual([{ type: 'loading', message: 'Moving to anyhost-a…', description: 'Uploading test-ses.' }])
  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toEqual({ refuse: 'This session is moving to anyhost-a.' })
  // the machine took the claim, and the move still runs
  await follow()
  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toEqual({ refuse: 'This session is moving to anyhost-a.' })

  // the session runs there, and outside herdr this Claude Code stays open and says how to go on with it
  await follow()
  const continues = 'This session continues on anyhost-a. Run anyhost attach test-ses here to keep working on it.'
  expect(moveToasts(tested)).toEqual([{ type: 'info', message: continues, description: 'anyhost-a restored test-ses in 2.4 s and runs it.' }])
  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toEqual({ refuse: continues })
})

// The program answers a prompt's ask 3 s late, past the 1.5 s a prompt waits for it.
const SLOW_MS = 3000

test('a program slow to answer holds no prompt: it goes through within the 1.5 s bound, with no toast', async () => {
  const { tested } = withProgram({ 'GET /claims/test-session': [{ body: { machine: 'anyhost-b' }, delayMs: SLOW_MS }] })
  await tested.start()

  const started = Date.now()
  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toBeUndefined()
  expect(Date.now() - started).toBeLessThan(2000)
  expect(moveToasts(tested)).toEqual([])
})

test('a prompt during a move is refused while the program is too slow to answer it', async () => {
  const { tested } = withProgram({
    'POST /move': [{ body: { session: 'test-session', to: 'anyhost-a', step: 'uploading', line: 'Uploading test-ses.' } }],
    'GET /claims/test-session': [{ ...moveIs('uploading', 'Uploading test-ses.'), delayMs: SLOW_MS }],
  })
  await tested.type('/move anyhost-a')

  const started = Date.now()
  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toEqual({ refuse: 'This session is moving to anyhost-a.' })
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

test('/move names the machine to move to, and shows why the program refused the move', async () => {
  const { tested } = withProgram({ 'POST /move': [{ status: 400, body: { message: 'No machine joined to your relay is named devbx. anyhost machines lists them.' } }] })

  expect(await tested.type('/move')).toEqual({ text: 'Name the one machine to move this session to, as in /move devbox. /machines lists your machines.' })
  expect(await tested.type('/move devbx')).toEqual({ text: '/move failed: No machine joined to your relay is named devbx. anyhost machines lists them.' })
  expect(moveToasts(tested)).toEqual([])
})

test('/machines says why it lists nothing while this machine is not joined', async () => {
  const { tested } = withProgram({ 'GET /machines': [{ status: 503, body: { message: 'This machine is not joined to your relay, so anyhost keeps what its sessions write and uploads nothing.' } }] })
  await tested.type('/machines')
  await tested.settle()
  expect((await tested.shown.page.lines()).join('\n')).toContain('This machine is not joined to your relay')
})
