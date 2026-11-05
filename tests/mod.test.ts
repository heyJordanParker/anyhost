import { expect, test } from 'bun:test'
import type { HookStream, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult } from 'claude-code'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { anyhost } from '../src/mod.js'

// `cmod program --service` loads the service, says `held` and ends, and the session reads the address the service
// wrote to its instance file.
function held(): HookStream<ProcessSpawnChunk, ProcessSpawnResult> {
  async function* read(): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
    yield { stream: 'stdout', text: 'held\n' }
    return { code: 0, signal: null }
  }
  return Object.assign(read(), { result: Promise.resolve<ProcessSpawnResult>({ code: 0, signal: null }) }) as HookStream<ProcessSpawnChunk, ProcessSpawnResult>
}

function withHolder(holder: { machine?: string; problem?: string; untold?: string }, status = 200) {
  const tested = testMod(anyhost, { files: { '/test/home/.local/share/cmod/instances/anyhost/anyhost.json': '{"address":"127.0.0.1:4100"}' } })
  const spawned: ProcessSpawnRequest[] = []
  const fetched: string[] = []
  tested.fakes.process.spawn = (request) => {
    spawned.push(request)
    return held()
  }
  tested.fakes.http.fetch = async (url) => {
    fetched.push(url)
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
  expect(fetched).toEqual(['http://127.0.0.1:4100/claims/test-session'])
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
  expect(fetched).toEqual(['http://127.0.0.1:4100/claims/test-session'])
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
