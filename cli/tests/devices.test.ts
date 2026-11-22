import { expect } from 'bun:test'
import { test } from './test.ts'
import { memoryRelay, statusOn } from './memory.ts'
import { cmodServeOf, LAPTOP, machineFor, serveOn, withCmod, WORKER } from './program.ts'

type Machine = { readonly id: string; readonly name: string }

function devicesOn(machine: { readonly env: Record<string, string> }) {
  const { heard, once, provides, listen, call } = cmodServeOf(machine)
  const changesOf = (device?: string): number => heard.filter(({ event, payload }) => event === 'Change' && (device === undefined || (payload as { readonly device: string }).device === device)).length
  return {
    heard,
    provides: () => provides('cmod/Devices'),
    listen: (event: string) => listen('cmod/Devices', event),
    devices: () => call('cmod/Devices', 'devices') as Promise<Machine[]>,
    send: (device: string, message: unknown) => call('cmod/Devices', 'send', device, message),
    messages: (count: number) => once(() => heard.filter(({ event }) => event === 'Message').length >= count),
    nextChange(device?: string): Promise<void> {
      const told = changesOf(device)
      return once(() => changesOf(device) > told)
    },
    async listing(expected: readonly Machine[]): Promise<void> {
      for (;;) {
        const change = this.nextChange()
        if (JSON.stringify(await this.devices()) === JSON.stringify(expected)) return
        await change
      }
    },
  }
}

const laptopMachine = { id: LAPTOP.id, name: LAPTOP.name }
const workerMachine = { id: WORKER.id, name: WORKER.name }

test("cmod/Devices lists each other machine whose relay link is up, carries cmod serve's messages to that machine's cmod serve in order as Message from this machine, and tells Change when that link or this machine's own drops", async () => {
  const relay = await memoryRelay()
  const [worker, laptop] = [await machineFor(relay, WORKER), await machineFor(relay, LAPTOP)]
  const [here, there] = [devicesOn(worker), devicesOn(laptop)]
  await Promise.all([serveOn(withCmod(worker.env)), serveOn(withCmod(laptop.env))])
  await Promise.all([here.provides(), there.provides()])
  await Promise.all([here.listen('Change'), here.listen('Message'), there.listen('Change'), there.listen('Message')])
  await Promise.all([here.listing([laptopMachine]), there.listing([workerMachine])])

  const messages = [
    { jsonrpc: '2.0', method: '$/link', params: { link: 'worker-link' } },
    { jsonrpc: '2.0', id: 1, method: '$/providers', params: { interface: 'demo/Platform', device: LAPTOP.id } },
    { jsonrpc: '2.0', id: 2, result: [{ name: 'eu-1', ids: [1, 2, 3], nested: { text: 'a "quoted" line\n' } }] },
  ]
  for (const message of messages) await here.send(LAPTOP.id, message)
  await there.messages(messages.length)
  expect(there.heard.filter(({ event }) => event === 'Message')).toEqual(messages.map((message) => ({ event: 'Message', payload: { device: WORKER.id, message } })))

  const dropped = here.nextChange(LAPTOP.id)
  const reconnect = relay.disconnect(LAPTOP.id)
  await dropped
  expect(await here.devices()).toEqual([])

  const back = here.nextChange(LAPTOP.id)
  reconnect()
  await back
  expect(await here.devices()).toEqual([laptopMachine])

  const ownDropped = here.nextChange(LAPTOP.id)
  relay.disconnect(WORKER.id)
  await ownDropped
  expect(await here.devices()).toEqual([])
  await expect(here.send(LAPTOP.id, messages[0])).rejects.toThrow(/^(anyhost-a is still connecting to its relay\.|The relay at http:\/\/127\.0\.0\.1:\d+ .*)$/)
}, 60_000)

test('anyhost serve runs on while cmod serve does not answer, logs one line, and provides cmod/Devices once cmod serve starts, and logs one line and provides nothing outside cmod program', async () => {
  const relay = await memoryRelay()
  const [worker, laptop] = [await machineFor(relay, WORKER), await machineFor(relay, LAPTOP)]
  const [early, outside] = [await serveOn(withCmod(worker.env)), await serveOn(laptop.env)]
  const late = devicesOn(worker)
  await late.provides()
  expect(early.logged().match(/anyhost: waits for cmod serve at \S+serve\.sock/g)).toHaveLength(1)
  expect((await statusOn(laptop.socket)).device.id).toBe(LAPTOP.id)
  expect(outside.logged().match(/anyhost provides nothing to cmod, as connect\(\) failed: connect\(\) names its mod by CMOD_MOD/g)).toHaveLength(1)
}, 60_000)
