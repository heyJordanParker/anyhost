import { expect, test } from 'bun:test'
import type { HookStream, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult } from 'claude-code'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { anyhost } from '../src/mod.js'

function running(address: string): HookStream<ProcessSpawnChunk, ProcessSpawnResult> {
  async function* read(): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
    yield { stream: 'stdout', text: `${address}\n` }
    await new Promise(() => undefined)
    return { code: 0, signal: null }
  }
  return Object.assign(read(), { result: new Promise<ProcessSpawnResult>(() => undefined) }) as HookStream<ProcessSpawnChunk, ProcessSpawnResult>
}

function withHolder(holder: { machine?: string; problem?: string }) {
  const tested = testMod(anyhost)
  const spawned: ProcessSpawnRequest[] = []
  const fetched: string[] = []
  tested.fakes.process.spawn = (request) => {
    spawned.push(request)
    return running('127.0.0.1:4100')
  }
  tested.fakes.http.fetch = async (url) => {
    fetched.push(url)
    return { status: 200, ok: true, headers: {}, text: JSON.stringify(holder) }
  }
  return { tested, spawned, fetched }
}

test('the mod runs one anyhost program for the machine, with the machine in its environment', async () => {
  const { tested, spawned } = withHolder({})
  await tested.start()

  expect(spawned).toEqual([
    {
      argv: ['/test/home/.local/share/cmod/programs/cmod', 'program', 'anyhost', '--no-wait', '--', 'anyhost', 'serve'],
      env: { ANYHOST_DEVICE_ID: '5f0e8c2a9b7d4e31a6c4d2b0e8f71a93', ANYHOST_DEVICE_NAME: 'test-computer', ANYHOST_DEVICE_OS: 'linux', ANYHOST_DEVICE_ARCH: 'x64', CLAUDE_CODE_SESSION_ID: 'test-session' },
    },
  ])
})

test('a session whose claim another device holds refuses prompts', async () => {
  const { tested, fetched } = withHolder({ machine: 'anyhost-b' })

  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toEqual({ refuse: 'This session continues on anyhost-b.' })
  expect(fetched).toEqual(['http://127.0.0.1:4100/claims/test-session'])
})

test('a cloned machine shows why anyhost captures nothing, once a session', async () => {
  const { tested } = withHolder({ problem: 'This machine, anyhost-c, has the id of anyhost-a.' })

  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toBeUndefined()
  await tested.raise.beforePrompt({ text: 'And again' })
  expect(tested.shown.toasts.filter(({ type }) => type === 'error')).toEqual([{ type: 'error', message: 'anyhost captures nothing on this machine', description: 'This machine, anyhost-c, has the id of anyhost-a.' }])
})

test('a session this device holds, or no device claims, takes prompts', async () => {
  const { tested } = withHolder({})

  expect(await tested.raise.beforePrompt({ text: 'Keep going' })).toBeUndefined()
})
