import plugin from '../../.claude-plugin/plugin.json'
import { PROTOCOL_VERSION, type Health } from '../../relay/protocol.ts'
import { jsonOf } from './connect.ts'
import { cmodDevice, relayLogin, rootsHere, type Device } from './device.ts'
import { hcPath } from './hc.ts'
import { connectRelay, DAILY_LIMIT, isDailyLimit } from './relay.ts'
import { serveSocket, type Status } from './serve.ts'

type Check = { readonly ok: string } | { readonly wait: string } | { readonly problem: string; readonly fix: string }

const START_CLAUDE = 'Start Claude Code on this machine. The anyhost mod makes the anyhost program a service of the machine, which records its sessions from each login on.'
const JOIN = 'Connect your machines in the anyhost mod: Connect Cloudflare on your first machine, and add every other machine from /machines on a joined one, or join it with the command anyhost machines --invite prints there.'
const UPDATE = 'The program tries the update once a run. Connect Cloudflare in the anyhost mod, or run anyhost connect, which updates the relay with your Cloudflare login.'
const UPDATE_FROM_TERMINAL = 'The program tries the update once a run. Run anyhost connect, which updates the relay with your Cloudflare login.'
const OUTDATED = 'Wait 5 minutes first: after an upload of the relay, from this machine or another, Cloudflare runs its older version for up to 5 minutes, and the program connects again within a minute. If this line is still here then, Connect Cloudflare again in the anyhost mod, or run anyhost connect, which updates the relay.'
const REACH = 'Check this machine reaches the internet. The program keeps every change meanwhile and uploads it once the relay answers.'
const HEALTH_MS = 10_000

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const errorOf = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)))

async function relayChecks(device: Device | Error): Promise<Check[]> {
  const login = await relayLogin().catch(errorOf)
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
  if (health instanceof Error) return [joined, { problem: `The relay at ${login.url} did not answer: ${health.message}`, fix: REACH }]
  if (health.protocol < PROTOCOL_VERSION) {
    return [joined, { problem: `The relay at ${login.url} answers protocol ${health.protocol}, and anyhost ${plugin.version} needs ${PROTOCOL_VERSION}.`, fix: 'Connect Cloudflare again in the anyhost mod, or run anyhost connect, which updates the relay.' }]
  }
  const answers: Check = { ok: `The relay answers protocol ${health.protocol} and keeps every session in the bucket ${health.bucket}.` }
  if (device instanceof Error) return [joined, answers]
  const relay = connectRelay({ login: async () => login, forget: async () => undefined, device, roots: rootsHere(), isPatient: false })
  const refusal = await relay.runOne({ op: 'devices' }).then(() => undefined, messageOf)
  const { state } = relay
  relay.close()
  if (refusal === undefined) return [joined, answers]
  return [joined, { problem: refusal, fix: state.is === 'refused' ? 'Do what the line says.' : state.is === 'unjoined' ? JOIN : REACH }]
}

function deviceCheck(device: Device | Error): Check {
  if (device instanceof Error) return { problem: `cmod device cannot name this machine: ${device.message}`, fix: 'Give the machine a machine id with sudo systemd-machine-id-setup, or install cmod with npm install -g @cmodjs/cli.' }
  return { ok: `This machine is ${device.name}, ${device.id}.` }
}

function programChecks(address: string, status: Status | undefined): Check[] {
  if (status === undefined) return [{ problem: `The anyhost program does not answer at ${address}.`, fix: START_CLAUDE }]
  const { url, state, message, bucket } = status.relay
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
          : state === 'outdated'
            ? { problem: `The anyhost program at ${address} captures nothing: ${message}`, fix: OUTDATED }
            : state === 'refused'
              ? { problem: `The anyhost program at ${address} captures nothing: ${message}`, fix: 'Do what the line says. The program connects again within a minute.' }
              : state === 'unjoined'
                ? { problem: `The anyhost program at ${address} uploads nothing: ${message}`, fix: JOIN }
                : { problem: `The anyhost program at ${address} reaches no relay, and ${status.pending} files wait for it: ${message}`, fix: 'It connects again within a minute, and uploads every change it kept meanwhile.' }
  const gaps = (status.journalGaps ?? []).map((problem): Check => ({
    problem,
    fix: "Put the session's transcript back at its path, as from a backup, and the program uploads it whole within an hour. Else a restore of the session goes on without that span. This line goes when the program restarts.",
  }))
  const { joining } = status
  const join: Check[] =
    joining === undefined
      ? []
      : joining.is === 'running'
        ? [{ wait: `The anyhost program at ${address} joins this machine with the link of the option join.` }]
        : [
            {
              problem: `The link of the option join joined no relay: ${joining.error}`,
              fix: 'The program does not try that link again. Add this machine again from /machines on a joined machine, or run anyhost join here with the link anyhost machines --invite prints there.',
            },
          ]
  const update: Check[] = updateProblem === undefined || isOutdatedUpdate ? [] : [{ problem: updateProblem, fix: state === 'unjoined' ? UPDATE : UPDATE_FROM_TERMINAL }]
  const retried = status.problems.map((problem): Check => ({ problem, fix: 'The program tries this again by itself, and this line goes once it works.' }))
  return [connection, ...join, ...update, ...retried, ...gaps]
}

function terminalCheck(): Check {
  const hc = hcPath()
  if (hc === undefined) return { problem: 'herdr-core is not installed here, so no session can move to this machine or start on it.', fix: 'Install the Herdr app, or herdr-core alone with curl -fsSL https://releases.herdr.dev/core/install.sh | sh.' }
  return { ok: `Sessions moved or started here run in terminals of herdr-core, ${hc}.` }
}

export async function doctor(): Promise<number> {
  const address = serveSocket()
  const status = await fetch('http://localhost/status', { unix: address, signal: AbortSignal.timeout(3000) })
    .then(async (response) => jsonOf<Status>(await response.text()))
    .catch(() => undefined)
  const device = await cmodDevice().catch(errorOf)
  const checks = [...(status === undefined ? await relayChecks(device) : []), deviceCheck(device), ...programChecks(address, status), terminalCheck()]
  for (const check of checks) console.log('ok' in check ? `✔ ${check.ok}` : 'wait' in check ? `… ${check.wait}` : `✘ ${check.problem}\n  ${check.fix}`)
  return checks.some((check) => 'problem' in check) ? 1 : 0
}
