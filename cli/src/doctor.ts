import plugin from '../../.claude-plugin/plugin.json'
import { PROTOCOL_VERSION, type Health } from '../../relay/protocol.ts'
import { cmodDevice, relayLogin } from './device.ts'
import { serveSocket, type Status } from './serve.ts'

type Check = { readonly ok: string } | { readonly wait: string } | { readonly problem: string; readonly fix: string }

const START_CLAUDE = 'Start Claude Code on this machine. The anyhost mod makes the anyhost program a service of the machine, which records its sessions from each login on.'
const JOIN = 'Connect your machines in the anyhost mod: Connect Cloudflare on your first machine, and on every other machine paste the command Add a machine gives in /machines on a joined one.'
// The relay answered /v1/health in under a second from the test machines (relay-spec R11).
const HEALTH_MS = 10_000

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// This machine joined a relay, and that relay answers the protocol this program speaks.
async function relayChecks(): Promise<Check[]> {
  const login = await relayLogin().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
  if (login instanceof Error) return [{ problem: `anyhost cannot read which relay this machine joined: ${login.message}`, fix: JOIN }]
  if (login === undefined) return [{ problem: 'This machine is not joined to your relay, so anyhost uploads nothing from it.', fix: JOIN }]
  const joined: Check = { ok: `This machine is joined to the relay at ${login.url}.` }
  const health = await fetch(`${login.url}/v1/health`, { signal: AbortSignal.timeout(HEALTH_MS) })
    .then(async (answer) => (answer.ok ? ((await answer.json()) as Health) : new Error(`it answered ${answer.status}`)))
    .catch((error: unknown) => new Error(messageOf(error)))
  if (health instanceof Error) return [joined, { problem: `The relay at ${login.url} did not answer: ${health.message}`, fix: 'Check this machine reaches the internet. The program keeps every change meanwhile and uploads it once the relay answers.' }]
  if (health.protocol < PROTOCOL_VERSION) {
    return [joined, { problem: `The relay at ${login.url} answers protocol ${health.protocol}, and anyhost ${plugin.version} needs ${PROTOCOL_VERSION}.`, fix: 'Connect Cloudflare again in the anyhost mod, or run anyhost connect, which updates the relay.' }]
  }
  return [joined, { ok: `The relay answers protocol ${health.protocol} and keeps every session in the bucket ${health.bucket}.` }]
}

async function deviceCheck(): Promise<Check> {
  const device = await cmodDevice().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
  if (device instanceof Error) return { problem: `cmod device cannot name this machine: ${device.message}`, fix: 'Give the machine a machine id with sudo systemd-machine-id-setup, or install cmod with npm install -g @cmodjs/cli.' }
  return { ok: `This machine is ${device.name}, ${device.id}.` }
}

async function programChecks(): Promise<Check[]> {
  const address = serveSocket()
  const status = await fetch('http://localhost/status', { unix: address, signal: AbortSignal.timeout(3000) })
    .then(async (response) => (await response.json()) as Status)
    .catch(() => undefined)
  if (status === undefined) return [{ problem: `The anyhost program does not answer at ${address}.`, fix: START_CLAUDE }]
  const { state, message, bucket } = status.relay
  const connection: Check =
    state === 'connected'
      ? {
          ok: `The anyhost program runs at ${address}: it uploads to ${bucket} ${status.uploadEvery === 0 ? 'every write' : `every ${status.uploadEvery} seconds`}, its last upload was at ${status.capturedAt || 'none yet'}, and ${status.pending} files wait for the next one.`,
        }
      : state === 'connecting'
        ? { wait: `The anyhost program at ${address} connects to the relay, and ${status.pending} files wait for it.` }
        : state === 'refused' || state === 'outdated'
          ? { problem: `The anyhost program at ${address} captures nothing: ${message}`, fix: 'Do what the line says. The program connects again within a minute.' }
          : state === 'unjoined' || state === 'removed'
            ? { problem: `The anyhost program at ${address} uploads nothing: ${message}`, fix: JOIN }
            : { problem: `The anyhost program at ${address} reaches no relay, and ${status.pending} files wait for it: ${message}`, fix: 'It connects again within a minute, and uploads every change it kept meanwhile.' }
  // the program reads the shell's environment once at its start, so a fix takes a restart
  const shell: Check = status.shellProblem === undefined ? { ok: 'The sessions the program starts get the environment your login shell sets up.' } : { problem: status.shellProblem, fix: 'Make your login shell start with no terminal and no input, then log out and in again, which starts the program anew.' }
  // a stream macOS keeps off the local network still runs, through the relay
  const localNetwork: Check[] =
    status.localNetworkProblem === undefined
      ? []
      : [{ problem: `${status.localNetworkProblem} Its stream goes through the relay, a few times slower.`, fix: 'Turn your terminal app on in System Settings > Privacy & Security > Local Network, then quit it and open it again. A tmux or herdr server keeps the access of the terminal app that started it, so start it again from there.' }]
  // a program older than journalGaps answers none
  const gaps = (status.journalGaps ?? []).map((problem): Check => ({
    problem,
    fix: "Put the session's transcript back at its path, as from a backup, and the program uploads it whole within an hour. Else a restore of the session goes on without that span. This line goes when the program restarts.",
  }))
  return [connection, shell, ...localNetwork, ...status.problems.map((problem): Check => ({ problem, fix: 'The program tries again at the next write or within 60 seconds, and this line goes once the cause is gone.' })), ...gaps]
}

export async function doctor(): Promise<number> {
  const checks = [...(await relayChecks()), await deviceCheck(), ...(await programChecks())]
  for (const check of checks) console.log('ok' in check ? `✔ ${check.ok}` : 'wait' in check ? `… ${check.wait}` : `✘ ${check.problem}\n  ${check.fix}`)
  return checks.some((check) => 'problem' in check) ? 1 : 0
}
