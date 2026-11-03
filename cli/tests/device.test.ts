import { expect, test } from 'bun:test'
import { ClonedDevice, register } from '../src/device.ts'
import { memoryStore } from './memory.ts'

const original = { id: '5f0e8c2a9b7d4e31a6c4d2b0e8f71a93', name: 'anyhost-a', os: 'linux', arch: 'arm64' }
const recordOf = (store: ReturnType<typeof memoryStore>): unknown => JSON.parse(new TextDecoder().decode(store.objects.get(`devices/${original.id}.json`)?.body))

test('a device registers once, and its next start registers it again', async () => {
  const store = memoryStore()
  await register(store, original, store.now)
  await register(store, original, store.now)

  expect(recordOf(store)).toEqual({ name: 'anyhost-a', os: 'linux', arch: 'arm64', ssh: 'anyhost-a' })
})

test('a cloned device id is refused with the machine-id fix while the original still runs', async () => {
  const store = memoryStore()
  await register(store, original, store.now)

  const clone = register(store, { ...original, name: 'anyhost-c' }, store.now + 9 * 60_000)
  await expect(clone).rejects.toBeInstanceOf(ClonedDevice)
  await expect(clone).rejects.toThrow(
    `This machine, anyhost-c, has the id of anyhost-a, which ran anyhost at ${new Date(store.now).toISOString()}, as a machine cloned from it does, so anyhost does not run here. Give it its own machine id with sudo rm /etc/machine-id && sudo systemd-machine-id-setup, then restart it.`,
  )
  expect(recordOf(store)).toEqual({ name: 'anyhost-a', os: 'linux', arch: 'arm64', ssh: 'anyhost-a' })
})

test('a cloned Mac is refused with the hardware UUID fix', async () => {
  const store = memoryStore()
  const mac = { id: '6649fe3715ce42ba91d9ea8ff5b8f67f', name: 'Jordans-M2-MBP', os: 'darwin', arch: 'arm64' }
  await register(store, mac, store.now)

  await expect(register(store, { ...mac, name: 'Jordans-VM' }, store.now)).rejects.toThrow('Give this virtual Mac its own hardware UUID in its virtualization app, then restart it.')
})

test('a renamed device whose old name has been quiet for 10 minutes takes the new name and runs', async () => {
  const store = memoryStore()
  await register(store, original, store.now)

  await register(store, { ...original, name: 'anyhost-renamed' }, store.now + 10 * 60_000)
  expect(recordOf(store)).toEqual({ name: 'anyhost-renamed', os: 'linux', arch: 'arm64', ssh: 'anyhost-renamed' })
})
