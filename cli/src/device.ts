import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Store } from './store.ts'

export type Device = { readonly id: string; readonly name: string; readonly os: string; readonly arch: string }
export type DeviceRecord = { readonly name: string; readonly os: string; readonly arch: string; readonly ssh: string }

export const stateFolder = (): string => join(process.env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state'), 'anyhost')
const cmodProgram = (): string => join(process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), 'cmod', 'programs', 'cmod')

export function deviceFromEnvironment(): Device {
  const { ANYHOST_DEVICE_ID: id, ANYHOST_DEVICE_NAME: name, ANYHOST_DEVICE_OS: os, ANYHOST_DEVICE_ARCH: arch } = process.env
  if (!id || !name || !os || !arch) throw new Error('anyhost serve runs from the anyhost mod, which passes this machine as ANYHOST_DEVICE_ID, ANYHOST_DEVICE_NAME, ANYHOST_DEVICE_OS and ANYHOST_DEVICE_ARCH.')
  return { id, name, os, arch }
}

export async function cmodDevice(): Promise<Device> {
  const cmod = (await Bun.file(cmodProgram()).exists()) ? cmodProgram() : Bun.which('cmod')
  if (cmod === null) throw new Error(`anyhost reads this machine from cmod device, and neither ${cmodProgram()} nor a cmod on PATH exists. Install cmod with npm install -g @cmodjs/cli.`)
  const child = Bun.spawn([cmod, 'device', '--json'], { stdout: 'pipe', stderr: 'pipe' })
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(error.trim() || `cmod device exited with ${code}.`)
  return JSON.parse(output) as Device
}

export const QUIET_BEFORE_RENAME_MS = 10 * 60_000

export class ClonedDevice extends Error {}

export function cloneFixFor(os: string): string {
  return os === 'darwin'
    ? 'Give this virtual Mac its own hardware UUID in its virtualization app, then restart it.'
    : 'Give it its own machine id with sudo rm /etc/machine-id && sudo systemd-machine-id-setup, then restart it.'
}

export async function register(store: Store, device: Device, now = Date.now()): Promise<void> {
  const key = `devices/${device.id}.json`
  const record = JSON.stringify({ name: device.name, os: device.os, arch: device.arch, ssh: device.name } satisfies DeviceRecord)
  if ((await store.put(key, record, { ifNoneMatch: '*' })) !== undefined) return
  const taken = await store.get(key)
  if (taken === undefined) throw new Error(`R2 refused ${key} as taken, then answered that it does not exist.`)
  const owner = JSON.parse(new TextDecoder().decode(taken.body)) as DeviceRecord
  if (owner.name !== device.name && now - taken.modifiedAt < QUIET_BEFORE_RENAME_MS) {
    const renamedAt = new Date(taken.modifiedAt + QUIET_BEFORE_RENAME_MS).toISOString()
    throw new ClonedDevice(
      `This machine, ${device.name}, has the id of ${owner.name}, which ran anyhost at ${new Date(taken.modifiedAt).toISOString()}, as a machine cloned from it does, so anyhost does not run here. ${cloneFixFor(device.os)} If you renamed ${owner.name} to ${device.name}, anyhost takes the new name once ${owner.name} has been quiet for 10 minutes, from ${renamedAt}.`,
    )
  }
  if ((await store.put(key, record, { ifMatch: taken.etag })) === undefined) throw new Error(`${key} changed while ${device.name} registered. anyhost registers it again on its next pass.`)
}

export async function devicesOf(store: Store): Promise<Map<string, DeviceRecord>> {
  const listed = await store.list('devices/')
  const records = await Promise.all(
    listed.map(async ({ key }) => {
      const stored = await store.get(key)
      return [key.slice('devices/'.length, -'.json'.length), stored === undefined ? undefined : (JSON.parse(new TextDecoder().decode(stored.body)) as DeviceRecord)] as const
    }),
  )
  return new Map(records.flatMap(([id, record]) => (record === undefined ? [] : [[id, record] as const])))
}
