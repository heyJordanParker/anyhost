import plugin from '../../.claude-plugin/plugin.json'
import { PROTOCOL_VERSION, type Health } from '../../relay/protocol.ts'
import { jsonOf } from './connect.ts'
import { cmodDevice, relayLogin } from './device.ts'
import { DAILY_LIMIT, isDailyLimit } from './relay.ts'
import { serveSocket, type Status } from './serve.ts'

type Check = { readonly ok: string } | { readonly wait: string } | { readonly problem: string; readonly fix: string }

const START_CLAUDE = 'Start Claude Code on this machine. The anyhost mod makes the anyhost program a service of the machine, which records its sessions from each login on.'
const JOIN = 'Connect your machines in the anyhost mod: Connect Cloudflare on your first machine, and on every other machine paste the command Add a machine gives in /machines on a joined one.'
const UPDATE = 'The program tries the update once a run. Connect Cloudflare in the anyhost mod, or run anyhost connect, which updates the relay with your Cloudflare login.'
// The mod's Step shows Connect Cloudflare only while the relay is `unjoined` or `outdated`, so the failed update of a
// relay the program still captures through, an older relay version at this protocol, is fixed from the terminal.
const UPDATE_FROM_TERMINAL = 'The program tries the update once a run. Run anyhost connect, which updates the relay with your Cloudflare login.'
// cmod runs the program as the service com.claudemodmanager.anyhost.anyhost: a launchd agent on macOS and a systemd user
// service on Linux, which a logout leaves running for a user systemd lingers for. A Linux machine with no systemd user
// session runs the program from Claude Code instead.
const RESTART =
  process.platform === 'darwin'
    ? 'Restart the program with launchctl kickstart -k gui/$(id -u)/com.claudemodmanager.anyhost.anyhost.'
    : 'Restart the program with systemctl --user restart com.claudemodmanager.anyhost.anyhost, or, where no systemd user session runs it, close every Claude Code session and start one.'
// The relay answered /v1/health in under a second from the test machines (relay-spec R11).
const HEALTH_MS = 10_000

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// This machine joined a relay, and that relay answers the protocol this program speaks, read here only while no
// program answers, as a running program's relay state says it already.
async function relayChecks(): Promise<Check[]> {
  const login = await relayLogin().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
  if (login instanceof Error) return [{ problem: `anyhost cannot read which relay this machine joined: ${login.message}`, fix: JOIN }]
  if (login === undefined) return [{ problem: 'This machine is not joined to your relay, so anyhost uploads nothing from it.', fix: JOIN }]
  const joined: Check = { ok: `This machine is joined to the relay at ${login.url}.` }
  const answer = await fetch(`${login.url}/v1/health`, { signal: AbortSignal.timeout(HEALTH_MS) }).then(
    async (got) => ({ status: got.status, text: await got.text() }),
    (error: unknown) => new Error(messageOf(error)),
  )
  if (!(answer instanceof Error) && isDailyLimit(answer.status, answer.text)) return [joined, { problem: DAILY_LIMIT, fix: 'Wait until 00:00 UTC. The program keeps every change meanwhile and uploads it once the relay answers.' }]
  const health = ((): Health | Error => {
    if (answer instanceof Error) return answer
    if (answer.status !== 200) return new Error(`it answered ${answer.status}`)
    return jsonOf<Health>(answer.text) ?? new Error(`it answered 200 with no health: ${answer.text.trim().slice(0, 200)}`)
  })()
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

// The program's own checks, and its relay's from its /status, one line per cause.
function programChecks(address: string, status: Status | undefined): Check[] {
  if (status === undefined) return [{ problem: `The anyhost program does not answer at ${address}.`, fix: START_CLAUDE }]
  const { url, state, message, bucket } = status.relay
  // an outdated relay and the failed update of it are one cause, so they make one line with the update's fix
  const { updateProblem } = status
  const isOutdatedUpdate = state === 'outdated' && updateProblem !== undefined
  const connection: Check =
    state === 'connected'
      ? {
          ok: `The anyhost program runs at ${address}: it uploads to ${bucket} through the relay at ${url} ${status.uploadEvery === 0 ? 'every write' : `every ${status.uploadEvery} seconds`}, its last upload was at ${status.capturedAt || 'none yet'}, and ${status.pending} files wait for the next one.`,
        }
      : state === 'connecting'
        ? { wait: `The anyhost program at ${address} connects to the relay, and ${status.pending} files wait for it.` }
        : isOutdatedUpdate
          ? { problem: `The anyhost program at ${address} captures nothing: ${message} Its own update of the relay failed: ${updateProblem}`, fix: UPDATE }
          : state === 'refused' || state === 'outdated'
            ? { problem: `The anyhost program at ${address} captures nothing: ${message}`, fix: 'Do what the line says. The program connects again within a minute.' }
            : state === 'unjoined'
              ? { problem: `The anyhost program at ${address} uploads nothing: ${message}`, fix: JOIN }
              : { problem: `The anyhost program at ${address} reaches no relay, and ${status.pending} files wait for it: ${message}`, fix: 'It connects again within a minute, and uploads every change it kept meanwhile.' }
  // the program reads the shell's environment once at its start, so a fix takes a restart
  const shell: Check = status.shellProblem === undefined ? { ok: 'The sessions the program starts get the environment your login shell sets up.' } : { problem: status.shellProblem, fix: `Make your login shell start with no terminal and no input. ${RESTART}` }
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
  // The join with the link of the option join, which `cmod install … --option 'join=<link>'` set. The program tries a
  // link once, and an invite joins one machine within 10 minutes, so only a new invite joins after a failure.
  const { joining } = status
  const join: Check[] =
    joining === undefined
      ? []
      : joining.is === 'running'
        ? [{ wait: `The anyhost program at ${address} joins this machine with the link of the option join.` }]
        : [
            {
              problem: `The link of the option join joined no relay: ${joining.error}`,
              fix: 'The program does not try that link again. Press Add a machine in /machines on a joined machine, then paste its command into the Connect your machines step of the anyhost mod, or run anyhost join with its link here.',
            },
          ]
  // the mod shows its Connect your machines step only for an unjoined or outdated relay, so a connected one has no button
  const update: Check[] = updateProblem === undefined || isOutdatedUpdate ? [] : [{ problem: updateProblem, fix: state === 'unjoined' ? UPDATE : UPDATE_FROM_TERMINAL }]
  // the listener starts once a run, and viewers on other machines go through the relay without it
  const direct: Check[] =
    status.directProblem === undefined ? [] : [{ problem: `${status.directProblem} Viewers on other machines reach this machine through the relay meanwhile.`, fix: RESTART }]
  const retried = status.problems.map((problem): Check => ({ problem, fix: 'The program tries this again by itself, and this line goes once it works.' }))
  return [connection, ...join, shell, ...localNetwork, ...update, ...direct, ...retried, ...gaps]
}

export async function doctor(): Promise<number> {
  const address = serveSocket()
  const status = await fetch('http://localhost/status', { unix: address, signal: AbortSignal.timeout(3000) })
    .then(async (response) => jsonOf<Status>(await response.text()))
    .catch(() => undefined)
  const checks = [...(status === undefined ? await relayChecks() : []), await deviceCheck(), ...programChecks(address, status)]
  for (const check of checks) console.log('ok' in check ? `✔ ${check.ok}` : 'wait' in check ? `… ${check.wait}` : `✘ ${check.problem}\n  ${check.fix}`)
  return checks.some((check) => 'problem' in check) ? 1 : 0
}
