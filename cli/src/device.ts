import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type * as Protocol from '../../relay/protocol.ts'
import type { Login, Relay } from './relay.ts'
import type { Roots } from './relocate.ts'

export type Device = { readonly id: string; readonly name: string; readonly os: string; readonly arch: string }
export type MachineRoots = Omit<Roots, 'checkout'>

export const stateFolder = (): string => join(process.env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state'), 'anyhost')
const cmodProgram = (): string => join(process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), 'cmod', 'programs', 'cmod')

// Claude Code keeps its folder at `CLAUDE_CONFIG_DIR`, else `~/.claude`, and background output under `/tmp/claude-<uid>`,
// which macOS resolves to `/private/tmp`.
export const rootsHere = (home = homedir()): MachineRoots => ({
  home,
  claudeHome: resolve(process.env['CLAUDE_CONFIG_DIR'] || join(home, '.claude')),
  claudeTmp: join(realpathSync(process.env['CLAUDE_CODE_TMPDIR'] || '/tmp'), `claude-${process.getuid?.() ?? 0}`),
  codexHome: process.env['CODEX_HOME'] || join(home, '.codex'),
})

export function deviceFromEnvironment(): Device {
  const { ANYHOST_DEVICE_ID: id, ANYHOST_DEVICE_NAME: name, ANYHOST_DEVICE_OS: os, ANYHOST_DEVICE_ARCH: arch } = process.env
  if (!id || !name || !os || !arch) throw new Error('anyhost serve runs from the anyhost mod, which passes this machine as ANYHOST_DEVICE_ID, ANYHOST_DEVICE_NAME, ANYHOST_DEVICE_OS and ANYHOST_DEVICE_ARCH.')
  return { id, name, os, arch }
}

async function cmod(...args: string[]): Promise<string> {
  const program = (await Bun.file(cmodProgram()).exists()) ? cmodProgram() : Bun.which('cmod')
  if (program === null) throw new Error(`anyhost runs cmod ${args[0]}, and neither ${cmodProgram()} nor a cmod on PATH exists. Install cmod with npm install -g @cmodjs/cli.`)
  const child = Bun.spawn([program, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(error.trim() || `cmod ${args[0]} exited with ${code}.`)
  return output
}

export const cmodDevice = async (): Promise<Device> => JSON.parse(await cmod('device', '--json')) as Device

// The values the person set in /config. An option they never set is absent, and its default applies.
type PersonOptions = { readonly uploadEvery?: number; readonly checkouts?: string }
export const personOptions = async (): Promise<PersonOptions> => (JSON.parse(await cmod('options', 'anyhost', '--json')) as { person: PersonOptions }).person

// The relay this machine joined: its address in `relay.json` in the state folder, and the device token cmod keeps as
// the secret `token`. A machine that never joined has neither.
export async function relayLogin(): Promise<Login | undefined> {
  const file = Bun.file(join(stateFolder(), 'relay.json'))
  if (!(await file.exists())) return undefined
  const { url } = (await file.json()) as { url?: unknown }
  if (typeof url !== 'string' || url === '') throw new Error(`${file.name} names no relay address in url.`)
  const token = await cmod('secret', 'get', 'anyhost', 'token')
  return token === '' ? undefined : { url: url.replace(/\/+$/, ''), token }
}

// Every machine joined to the relay, by its device id, with the roots it joined with.
export async function devicesOf(relay: Relay): Promise<Map<string, Protocol.Device>> {
  const answer = await relay.run([{ op: 'devices' }])[0]
  if (answer === undefined || !('devices' in answer)) throw new Error('The relay answered no list of machines.')
  return new Map(answer.devices.map((device) => [device.id, device]))
}
