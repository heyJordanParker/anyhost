import { mkdirSync, realpathSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import plugin from '../../.claude-plugin/plugin.json'
import type * as Protocol from '../../relay/protocol.ts'
import type { Login, Relay } from './relay.ts'
import type { Roots } from './relocate.ts'

export type Device = { readonly id: string; readonly name: string; readonly os: string; readonly arch: string }
export type MachineRoots = Omit<Roots, 'checkout'>

export const stateFolder = (): string => join(process.env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state'), 'anyhost')
const cmodProgram = (): string => join(process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), 'cmod', 'programs', 'cmod')

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

export async function cmod(args: readonly string[], stdin?: string): Promise<string> {
  const program = (await Bun.file(cmodProgram()).exists()) ? cmodProgram() : Bun.which('cmod')
  if (program === null) throw new Error(`anyhost runs cmod ${args[0]}, and neither ${cmodProgram()} nor a cmod on PATH exists. Install cmod with npm install -g @cmodjs/cli.`)
  const child = Bun.spawn([program, ...args], { stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' })
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(error.trim() || `cmod ${args.slice(0, 2).join(' ')} exited with ${code}.`)
  return output
}

export const cmodDevice = async (): Promise<Device> => JSON.parse(await cmod(['device', '--json'])) as Device

const lastWriteOf = async (path: string): Promise<string> => await stat(path).then(({ mtimeMs, size }) => `${path} ${mtimeMs} ${size}`, () => path)

type PersonOptions = { readonly uploadEvery?: number; readonly checkouts?: string; readonly join?: string }
let optionsRead: { readonly write: string; readonly options: PersonOptions } | undefined
export async function personOptions(): Promise<PersonOptions> {
  const write = await lastWriteOf(join(rootsHere().claudeHome, 'settings.json'))
  if (optionsRead?.write === write) return optionsRead.options
  const options = (JSON.parse(await cmod(['options', 'anyhost', '--json'])) as { person: PersonOptions }).person
  optionsRead = { write, options }
  return options
}

const relayFile = (): string => join(stateFolder(), 'relay.json')

let loginRead: { readonly write: string; readonly login: Login | undefined } | undefined
export async function relayLogin(): Promise<Login | undefined> {
  const file = Bun.file(relayFile())
  if (!(await file.exists())) return undefined
  const write = await lastWriteOf(relayFile())
  if (loginRead?.write === write) return loginRead.login
  const { url } = (await file.json()) as { url?: unknown }
  if (typeof url !== 'string' || url === '') throw new Error(`${file.name} names no relay address in url.`)
  const token = await cmod(['secret', 'get', 'anyhost', 'token'])
  const login = token === '' ? undefined : { url: url.replace(/\/+$/, ''), token }
  loginRead = { write, login }
  return login
}

let loginWrites: Promise<void> = Promise.resolve()
const inTurn = (write: () => Promise<void>): Promise<void> => {
  const turn = loginWrites.then(write)
  loginWrites = turn.catch(() => undefined)
  return turn
}

export async function saveRelayLogin({ url, token }: Login): Promise<void> {
  await inTurn(async () => {
    await cmod(['secret', 'store', 'anyhost', 'token'], token)
    mkdirSync(stateFolder(), { recursive: true })
    await Bun.write(relayFile(), `${JSON.stringify({ url })}\n`)
  })
}

export async function forgetRelayLogin(refused: Login): Promise<void> {
  await inTurn(async () => {
    if (loginRead?.login?.token !== refused.token || loginRead.write !== (await lastWriteOf(relayFile()))) return
    await rm(relayFile(), { force: true })
    await cmod(['secret', 'delete', 'anyhost', 'token'])
  })
}

export async function devicesOf(relay: Relay): Promise<Map<string, Protocol.Device>> {
  const { devices } = await relay.runOne({ op: 'devices' })
  return new Map(devices.map((device) => [device.id, device]))
}

export const machinesOf = async (relay: Relay): Promise<Protocol.Device[]> => [...(await devicesOf(relay)).values()].filter((device) => device.removedAt === undefined)

export async function otherMachine(relay: Relay, here: Device, name: string, instead: string): Promise<Protocol.Device> {
  const machine = (await machinesOf(relay)).find((each) => each.name === name)
  if (machine === undefined) throw new Error(`No machine joined to your relay is named ${name}. anyhost machines lists them.`)
  if (machine.id === here.id) throw new Error(`${name} is this machine. ${instead}`)
  return machine
}

const MOD = new URL(plugin.repository).pathname.slice(1)

export async function inviteMachine(relay: Relay): Promise<{ readonly command: string; readonly link: string; readonly expiresAt: string }> {
  const { link, expiresAt } = await relay.runOne({ op: 'invite' })
  return { command: `cmod install ${MOD} --option 'join=${link}'`, link, expiresAt }
}

export async function removeMachine(relay: Relay, id: string): Promise<void> {
  await relay.runOne({ op: 'remove', device: id })
}
