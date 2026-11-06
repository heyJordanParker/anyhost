import { mkdirSync, realpathSync } from 'node:fs'
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

// Runs cmod from the cmod store, as a session runs it, with `stdin` as its input: `cmod secret store` reads the value
// there, so a token never shows in a process's arguments. Answers what it printed.
export async function cmod(args: readonly string[], stdin?: string): Promise<string> {
  const program = (await Bun.file(cmodProgram()).exists()) ? cmodProgram() : Bun.which('cmod')
  if (program === null) throw new Error(`anyhost runs cmod ${args[0]}, and neither ${cmodProgram()} nor a cmod on PATH exists. Install cmod with npm install -g @cmodjs/cli.`)
  const child = Bun.spawn([program, ...args], { stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' })
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(error.trim() || `cmod ${args.slice(0, 2).join(' ')} exited with ${code}.`)
  return output
}

export const cmodDevice = async (): Promise<Device> => JSON.parse(await cmod(['device', '--json'])) as Device

// The values the person set in /config. An option they never set is absent, and its default applies.
type PersonOptions = { readonly uploadEvery?: number; readonly checkouts?: string; readonly join?: string }
export const personOptions = async (): Promise<PersonOptions> => (JSON.parse(await cmod(['options', 'anyhost', '--json'])) as { person: PersonOptions }).person

const relayFile = (): string => join(stateFolder(), 'relay.json')

// The relay this machine joined: its address in `relay.json` in the state folder, and the device token cmod keeps as
// the secret `token`. A machine that never joined has neither.
export async function relayLogin(): Promise<Login | undefined> {
  const file = Bun.file(relayFile())
  if (!(await file.exists())) return undefined
  const { url } = (await file.json()) as { url?: unknown }
  if (typeof url !== 'string' || url === '') throw new Error(`${file.name} names no relay address in url.`)
  const token = await cmod(['secret', 'get', 'anyhost', 'token'])
  return token === '' ? undefined : { url: url.replace(/\/+$/, ''), token }
}

// Keeps the login a join gave, for relayLogin to read at the next connect.
export async function saveRelayLogin({ url, token }: Login): Promise<void> {
  await cmod(['secret', 'store', 'anyhost', 'token'], token)
  mkdirSync(stateFolder(), { recursive: true })
  await Bun.write(relayFile(), `${JSON.stringify({ url })}\n`)
}

// Every machine that ever joined the relay, by its device id, with its roots as it last connected. A removed machine
// stays, so the sessions it wrote stay listed and resumable.
export async function devicesOf(relay: Relay): Promise<Map<string, Protocol.Device>> {
  const answer = await relay.run([{ op: 'devices' }])[0]
  if (answer === undefined || !('devices' in answer)) throw new Error('The relay answered no list of machines.')
  return new Map(answer.devices.map((device) => [device.id, device]))
}

// The machines joined now, as `/machines` and `anyhost machines` show them.
export const machinesOf = async (relay: Relay): Promise<Protocol.Device[]> => [...(await devicesOf(relay)).values()].filter((device) => device.removedAt === undefined)

// The command that joins one more machine: cmod installs anyhost with the option `join`, which the program exchanges
// at its first start. Its invite joins one machine before `expiresAt`. The link is quoted, because zsh's extendedglob
// reads its `#` as a pattern.
export async function inviteMachine(relay: Relay): Promise<{ readonly command: string; readonly expiresAt: string }> {
  const answer = await relay.run([{ op: 'invite' }])[0]
  if (answer === undefined || !('link' in answer)) throw new Error('The relay answered no invite.')
  return { command: `cmod install ${new URL(plugin.repository).pathname.slice(1)} --option 'join=${answer.link}'`, expiresAt: answer.expiresAt }
}

// Takes the machine's token back and closes its connections. Its sessions stay listed and resumable.
export async function removeMachine(relay: Relay, id: string): Promise<void> {
  await relay.run([{ op: 'remove', device: id }])[0]
}
