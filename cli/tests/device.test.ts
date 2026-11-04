import { expect, test } from 'bun:test'
import { register } from '../src/device.ts'
import { memoryStore } from './memory.ts'

const original = { id: '5f0e8c2a9b7d4e31a6c4d2b0e8f71a93', name: 'anyhost-a', os: 'linux', arch: 'arm64' }
const roots = { home: '/home/ada', claudeTmp: '/tmp/claude-1000', codexHome: '/home/ada/.codex' }
const MINUTE = 60_000
const recordOf = (store: ReturnType<typeof memoryStore>): unknown => JSON.parse(new TextDecoder().decode(store.objects.get(`devices/${original.id}.json`)?.body))

test("a device registers once with its home folders, and its next start registers it again", async () => {
  const store = memoryStore()
  expect(await register(store, original, roots, store.now)).toEqual({ state: 'registered' })
  expect(await register(store, original, roots, store.now)).toEqual({ state: 'registered' })

  expect(recordOf(store)).toEqual({ name: 'anyhost-a', os: 'linux', arch: 'arm64', ssh: 'anyhost-a', home: '/home/ada', claudeTmp: '/tmp/claude-1000', codexHome: '/home/ada/.codex' })
})

test('a renamed device waits while its old name may still run, then takes the new name by itself', async () => {
  const store = memoryStore()
  await register(store, original, roots, store.now)
  const renamed = { ...original, name: 'anyhost-renamed' }

  const waiting = await register(store, renamed, roots, store.now + 2 * MINUTE)
  expect(waiting.state).toBe('waiting')
  expect(await register(store, renamed, roots, store.now + 6 * MINUTE, waiting)).toMatchObject({ state: 'waiting' })
  expect(await register(store, renamed, roots, store.now + 10 * MINUTE, waiting)).toEqual({ state: 'registered' })
  expect(recordOf(store)).toMatchObject({ name: 'anyhost-renamed', ssh: 'anyhost-renamed' })
})

test('a cloned device id is refused with the machine-id fix once the original writes again', async () => {
  const store = memoryStore()
  await register(store, original, roots, store.now)
  const clone = { ...original, name: 'anyhost-c' }
  const waiting = await register(store, clone, roots, store.now + MINUTE)
  store.now += 5 * MINUTE
  await register(store, original, roots, store.now)

  const refused = await register(store, clone, roots, store.now + MINUTE, waiting)
  expect(refused).toEqual({
    state: 'cloned',
    message: `This machine, anyhost-c, has the id of anyhost-a, which still runs anyhost and wrote at ${new Date(store.now).toISOString()}, as a machine cloned from it does, so anyhost captures nothing here. Give it its own machine id with sudo rm /etc/machine-id && sudo systemd-machine-id-setup, then restart it.`,
  })
  expect(recordOf(store)).toMatchObject({ name: 'anyhost-a', ssh: 'anyhost-a' })
})

test('a cloned Mac is refused with the hardware UUID fix', async () => {
  const store = memoryStore()
  const mac = { id: '9c3d7a1e5b2f4c8d0e6a1b7f3c9d2e4a', name: 'Adas-MacBook-Pro', os: 'darwin', arch: 'arm64' }
  await register(store, mac, roots, store.now)
  const waiting = await register(store, { ...mac, name: 'Adas-VM' }, roots, store.now)
  store.now += MINUTE
  await register(store, mac, roots, store.now)

  expect(await register(store, { ...mac, name: 'Adas-VM' }, roots, store.now, waiting)).toMatchObject({
    state: 'cloned',
    message: expect.stringContaining('Give this virtual Mac its own hardware UUID in its virtualization app, then restart it.'),
  })
})
