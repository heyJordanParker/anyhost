import { expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Status } from '../src/serve.ts'
import { memoryRelay, statusOn, until } from './memory.ts'
import { anyhostOn, CLI, DAILY_LIMIT, HOST, killAfterTest, machineFor, script, serveOn } from './program.ts'

test('anyhost join asks the program that answers on this machine, which joins in turn with its forgets', async () => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST)
  const asked: unknown[] = []
  const program = Bun.serve({
    unix: socket,
    async fetch(request) {
      asked.push({ method: request.method, path: new URL(request.url).pathname, body: await request.json() })
      return Response.json({ url: 'https://anyhost-test-join.parker-labs.workers.dev' })
    },
  })
  try {
    const link ="cmod install heyJordanParker/anyhost --option 'join=http://127.0.0.1:9/v1/join#K7QX2M4W9TPR6ZC3'"
    expect(await anyhostOn(env, ['join', link])).toEqual({ code: 0, out: 'Joined this machine to https://anyhost-test-join.parker-labs.workers.dev\n', err: '' })
    expect(asked).toEqual([{ method: 'POST', path: '/join', body: { link } }])
  } finally {
    await program.stop(true)
  }
})

test('anyhost join joins in its own process when no program answers on this machine', async () => {
  const { env } = await machineFor(await memoryRelay(), HOST)
  const asked: string[] = []
  const relay = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      asked.push(`${request.method} ${new URL(request.url).pathname}`)
      return Response.json({ error: 'invite_unknown', message: 'The relay made no invite with that code. Make a new one with Add a machine.' }, { status: 403 })
    },
  })
  try {
    const { code, err } = await anyhostOn(env, ['join', `http://127.0.0.1:${relay.port}/v1/join#K7QX2M4W9TPR6ZC3`])
    expect({ code, err }).toEqual({ code: 1, err: `http://127.0.0.1:${relay.port} refused to join anyhost-a: The relay made no invite with that code. Make a new one with Add a machine.\n` })
    expect(asked).toEqual(['POST /v1/join'])
  } finally {
    await relay.stop(true)
  }
})

test('anyhost connect asks the program that answers on this machine, prints each line of its run, and answers its question from the terminal', async () => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST)
  const accounts = [{ id: 'a1', name: 'Parker Labs' }, { id: 'a2', name: 'Side Project' }]
  const lines = ['Checking your Cloudflare login', 'Found the bucket anyhost-test in the eu jurisdiction', 'Joined this machine to https://anyhost-test-connect.parker-labs.workers.dev']
  const asked: string[] = []
  const program = Bun.serve({
    unix: socket,
    async fetch(request) {
      const { pathname } = new URL(request.url)
      asked.push(`${request.method} ${pathname}${request.method === 'POST' ? ` ${await request.text()}` : ''}`)
      if (pathname === '/connect') return Response.json({ is: 'running', lines: lines.slice(0, 1), accounts })
      if (pathname === '/connect/account') return Response.json({ is: 'running', lines: lines.slice(0, 2) })
      return Response.json({ relay: { url: '', state: 'unjoined', message: '', bucket: '' }, connecting: { is: 'joined', lines } })
    },
  })
  try {
    const { code, out, err } = await anyhostOn(env, ['connect'], '2\n')
    expect({ code, err }).toEqual({ code: 0, err: '' })
    expect(out).toBe(`${lines[0]}\nYour Cloudflare login reaches 2 accounts:\n  1  Parker Labs\n  2  Side Project\nType the number of the account your relay goes in:\n${lines[1]}\n${lines[2]}\n`)
    expect(asked).toEqual(['POST /connect {}', 'POST /connect/account {"id":"a2"}', 'GET /status'])
  } finally {
    await program.stop(true)
  }
})

test('anyhost doctor beside a program that answers unjoined prints one ✘ line with its one fix, and reads no relay itself', async () => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST)
  rmSync(join(env['XDG_STATE_HOME'] ?? '', 'anyhost', 'relay.json'))
  const message = 'This machine is not joined to your relay, so anyhost keeps what its sessions write and uploads nothing.'
  const status: Status = { device: HOST, relay: { url: '', state: 'unjoined', message, bucket: '' }, pending: 0, uploadEvery: 5, capturedAt: '', problems: [], journalGaps: [] }
  const program = Bun.serve({ unix: socket, fetch: () => Response.json(status) })
  try {
    const { code, out } = await anyhostOn(env, ['doctor'])
    expect(code).toBe(1)
    expect(out.split('\n').filter((line) => line.startsWith('✘'))).toEqual([`✘ The anyhost program at ${socket} uploads nothing: ${message}`])
  } finally {
    await program.stop(true)
  }
})

async function unjoinedWithOption(link: string): Promise<{ readonly env: Record<string, string>; readonly socket: string; readonly folder: string }> {
  const machine = await machineFor(await memoryRelay(), HOST)
  const programs = join(machine.env['XDG_DATA_HOME'] ?? '', 'cmod', 'programs')
  const settings = join(machine.env['CLAUDE_CONFIG_DIR'] ?? '', 'settings.json')
  writeFileSync(settings, JSON.stringify({ join: link }))
  script(
    join(programs, 'cmod'),
    `#!/bin/sh\ncase "$1 $2" in\n  "secret get") cat '${programs}/token' ;;\n  "secret store") cat > '${programs}/token' ;;\n  "options anyhost") printf '{"person":%s}' "$(cat '${settings}')" ;;\n  "option anyhost") echo "$3=$4" >> '${programs}/options-set'; printf '{}' > '${settings}' ;;\n  "device --json") printf '%s' '${JSON.stringify(HOST)}' ;;\n  *) exit 1 ;;\nesac\n`,
  )
  rmSync(join(machine.env['XDG_STATE_HOME'] ?? '', 'anyhost', 'relay.json'))
  return machine
}

test('the option join joins at the program\'s start, running in /status, and one the relay refused empties the option too and stays failed in /status until the machine joins', async () => {
  const joins: string[] = []
  const answer = Promise.withResolvers<void>()
  const relay = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/join') return Response.json({ error: 'missing', message: 'The stand-in serves only POST /v1/join.' }, { status: 404 })
      const { invite } = (await request.json()) as { invite: string }
      joins.push(invite)
      if (invite !== 'USED') return Response.json({ relay: 1, protocol: 1, bucket: 'anyhost-test', token: 'token-of-anyhost-a', device: { id: HOST.id, name: HOST.name } })
      await answer.promise
      return Response.json({ error: 'invite_used', message: 'The invite already joined anyhost-c at 2026-11-07T09:00:00.000Z. Make a new one with Add a machine.' }, { status: 403 })
    },
  })
  try {
    const origin = `http://127.0.0.1:${relay.port}`
    const machine = await unjoinedWithOption(`cmod install heyJordanParker/anyhost --option 'join=${origin}/v1/join#USED'`)
    const programs = join(machine.env['XDG_DATA_HOME'] ?? '', 'cmod', 'programs')
    await serveOn(machine.env)
    await until(() => joins.length === 1, 'the join asking the relay')
    expect((await statusOn(machine.socket)).joining).toEqual({ is: 'running' })

    answer.resolve()
    await until(async () => (await statusOn(machine.socket)).joining?.is === 'failed', 'the refused join in /status')
    const refused = await statusOn(machine.socket)
    expect(refused.joining).toEqual({ is: 'failed', error: `${origin} refused to join anyhost-a: The invite already joined anyhost-c at 2026-11-07T09:00:00.000Z. Make a new one with Add a machine.` })
    expect(refused.problems.filter((problem) => problem.includes('refused to join'))).toEqual([])
    expect(readFileSync(join(programs, 'options-set'), 'utf8')).toBe('join=\n')
    expect(existsSync(join(programs, 'token'))).toBe(false)

    const joined = await fetch('http://localhost/join', { unix: machine.socket, method: 'POST', body: JSON.stringify({ link: `${origin}/v1/join#FRESH` }) })
    expect(await joined.json()).toEqual({ url: origin })
    expect((await statusOn(machine.socket)).joining).toBeUndefined()
    expect(readFileSync(join(programs, 'token'), 'utf8')).toBe('token-of-anyhost-a')
    expect(joins).toEqual(['USED', 'FRESH'])
  } finally {
    await relay.stop(true)
  }
}, 30_000)

test('anyhost doctor beside a program whose option join failed prints why and the fix that works, with no claim that the program tries it again', async () => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST)
  rmSync(join(env['XDG_STATE_HOME'] ?? '', 'anyhost', 'relay.json'))
  const refusal = 'https://anyhost.parker-labs.workers.dev refused to join anyhost-a: The invite expired at 2026-11-07T09:10:00.000Z, 10 minutes after it was made. Make a new one with Add a machine.'
  const update = '2026-11-07T09:20:00.000Z relay update: Error: cf is logged in to no Cloudflare account on this machine. Connect Cloudflare logs it in.'
  const status: Status = {
    device: HOST,
    relay: { url: '', state: 'unjoined', message: 'This machine is not joined to your relay, so anyhost keeps what its sessions write and uploads nothing.', bucket: '' },
    pending: 0,
    uploadEvery: 5,
    capturedAt: '',
    problems: [],
    journalGaps: [],
    updateProblem: update,
    joining: { is: 'failed', error: refusal },
  }
  const program = Bun.serve({ unix: socket, fetch: () => Response.json(status) })
  try {
    const { code, out } = await anyhostOn(env, ['doctor'])
    expect(code).toBe(1)
    const lines = out.split('\n')
    const at = lines.indexOf(`✘ The link of the option join joined no relay: ${refusal}`)
    expect(at).toBeGreaterThan(-1)
    expect(lines[at + 1]).toBe(
      '  The program does not try that link again. Add this machine again from /machines on a joined machine, or run anyhost join here with the link anyhost machines --invite prints there.',
    )
    expect(lines[lines.indexOf(`✘ ${update}`) + 1]).toBe('  The program tries the update once a run. Connect Cloudflare in the anyhost mod, or run anyhost connect, which updates the relay with your Cloudflare login.')
    expect(out).not.toContain('tries this again')
  } finally {
    await program.stop(true)
  }
})

const OUTDATED = 'The relay at https://anyhost.parker-labs.workers.dev answers protocol 0, and anyhost 0.9.0 needs 1. Connect Cloudflare again to update the relay.'
const FAILED_UPDATE = '2026-11-07T09:20:00.000Z relay update: Error: cf is logged in to no Cloudflare account on this machine. Connect Cloudflare logs it in.'

test.each([
  {
    updateProblem: FAILED_UPDATE,
    problem: `${OUTDATED} Its own update of the relay failed: ${FAILED_UPDATE}`,
    fix: '  The program tries the update once a run. Connect Cloudflare in the anyhost mod, or run anyhost connect, which updates the relay with your Cloudflare login.',
  },
  {
    updateProblem: undefined,
    problem: OUTDATED,
    fix: '  Wait 5 minutes first: after an upload of the relay, from this machine or another, Cloudflare runs its older version for up to 5 minutes, and the program connects again within a minute. If this line is still here then, Connect Cloudflare again in the anyhost mod, or run anyhost connect, which updates the relay.',
  },
])('anyhost doctor beside a program whose relay is outdated prints one ✘ line, with the fix for its update problem $updateProblem', async ({ updateProblem, problem, fix }) => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST)
  const status: Status = {
    device: HOST,
    relay: { url: 'https://anyhost.parker-labs.workers.dev', state: 'outdated', message: OUTDATED, bucket: 'anyhost' },
    pending: 3,
    uploadEvery: 5,
    capturedAt: '',
    problems: [],
    journalGaps: [],
    ...(updateProblem === undefined ? {} : { updateProblem }),
  }
  const program = Bun.serve({ unix: socket, fetch: () => Response.json(status) })
  try {
    const { code, out } = await anyhostOn(env, ['doctor'])
    const lines = out.split('\n')
    const line = `✘ The anyhost program at ${socket} captures nothing: ${problem}`
    expect(code).toBe(1)
    expect(lines.filter((printed) => printed.startsWith('✘'))).toEqual([line])
    expect(lines[lines.indexOf(line) + 1]).toBe(fix)
  } finally {
    await program.stop(true)
  }
})

test("anyhost doctor with no program reads the relay's 429 error code: 1027 as Cloudflare's daily limit, which resets at 00:00 UTC", async () => {
  const relay = await memoryRelay()
  const { env } = await machineFor(relay, HOST)
  relay.dailyLimited = Infinity
  const { code, out } = await anyhostOn(env, ['doctor'])
  expect(code).toBe(1)
  const lines = out.split('\n')
  expect(lines[lines.indexOf(`✘ ${DAILY_LIMIT}`) + 1]).toBe('  Wait until 00:00 UTC. The program keeps every change meanwhile and uploads it once the relay answers.')
  expect(out).not.toContain('did not answer')
})

test('a second serve on one state folder refuses to start, naming the one that runs, a POST of no JSON answers 400, and one to no route 404', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  await serveOn(host.env)
  const second = Bun.spawn(['bun', CLI, 'serve'], { env: host.env, stdout: 'pipe', stderr: 'pipe' })
  killAfterTest(second)
  expect(await second.exited).toBe(1)
  expect(await new Response(second.stderr).text()).toContain(`The anyhost program of ${HOST.name} already answers at ${host.socket}, so this one does not start.`)
  const answer = await fetch('http://localhost/machines/invite', { unix: host.socket, method: 'POST', body: 'not json' })
  expect(answer.status).toBe(400)
  expect(((await answer.json()) as { message: string }).message).toStartWith('anyhost takes a JSON object at POST /machines/invite, and this body is none:')
  const unknown = await fetch('http://localhost/machines/rename', { unix: host.socket, method: 'POST', body: '{}' })
  expect(unknown.status).toBe(404)
  expect(await unknown.json()).toEqual({
    message: 'anyhost serves GET /status, /machines, /agents and /claims/<session>, POST /connect, /connect/account, /connect/r2, /join, /machines/add, /machines/invite, /machines/remove, /move, /move/keep, /new, /agents/tell, /agents/open, /agents/archive, /agents/visit, /agents/delete and /settings, not POST /machines/rename.',
  })
})

test('a request the relay keeps waiting past 10 s still gets its answer, whatever client asked', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  await serveOn(host.env)
  await until(async () => (await statusOn(host.socket)).relay.state === 'connected', 'the program connecting')
  relay.before = (op) => (op.op === 'devices' ? Bun.sleep(12_000) : undefined)
  const curl = Bun.spawn(['curl', '-sS', '--unix-socket', host.socket, 'http://localhost/agents'], { stdout: 'pipe', stderr: 'pipe' })
  killAfterTest(curl)

  expect(await new Response(curl.stdout).text()).toStartWith('{"agents":[')
}, 30_000)

test("a program whose relay Cloudflare refuses for the daily limit names the limit and its reset at 00:00 UTC in /status", async () => {
  const relay = await memoryRelay()
  relay.dailyLimited = Infinity
  const host = await machineFor(relay, HOST)
  await serveOn(host.env)
  await until(async () => (await statusOn(host.socket)).relay.state === 'offline', 'the refused connect')

  expect((await statusOn(host.socket)).relay).toMatchObject({ state: 'offline', message: DAILY_LIMIT })
})
