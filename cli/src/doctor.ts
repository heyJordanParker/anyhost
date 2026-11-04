import { homedir } from 'node:os'
import { join } from 'node:path'
import { cmodDevice, type DeviceRecord } from './device.ts'
import type { Status } from './serve.ts'
import { BUCKET, messageOf, PROFILE, profileOf, type Store } from './store.ts'

type Check = { readonly ok: string } | { readonly wait: string } | { readonly problem: string; readonly fix: string }

const START_CLAUDE = 'Start Claude Code on this machine. The anyhost mod makes the anyhost program a service of the machine, which registers it and records its sessions from each login on.'

async function profileCheck(): Promise<Check> {
  const config = process.env['AWS_CONFIG_FILE'] ?? join(homedir(), '.aws', 'config')
  const credentials = process.env['AWS_SHARED_CREDENTIALS_FILE'] ?? join(homedir(), '.aws', 'credentials')
  const { endpoint, hasKeys } = await profileOf()
  const missing = [
    ...(endpoint === undefined ? [`endpoint_url under [profile ${PROFILE}] in ${config}`] : []),
    ...(hasKeys ? [] : [`aws_access_key_id and aws_secret_access_key under [${PROFILE}] in ${credentials}`]),
  ]
  if (missing.length === 0) return { ok: `The AWS profile ${PROFILE} names R2's endpoint and keys.` }
  return { problem: `The AWS profile ${PROFILE} lacks ${missing.join(', and ')}.`, fix: `Write endpoint_url = https://<account id>.r2.cloudflarestorage.com (with .eu. before r2 for a bucket in the EU jurisdiction) and region = auto under [profile ${PROFILE}] in ${config}, and the R2 API token's keys under [${PROFILE}] in ${credentials}.` }
}

async function bucketCheck(store: Store): Promise<Check> {
  try {
    await store.list('devices/')
    return { ok: `The bucket ${BUCKET} answers.` }
  } catch (error) {
    return { problem: `The bucket ${BUCKET} did not answer: ${messageOf(error)}`, fix: `Check that the bucket exists in R2 and that the keys of the AWS profile ${PROFILE} can read and write it.` }
  }
}

async function deviceCheck(store: Store): Promise<Check> {
  const device = await cmodDevice().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
  if (device instanceof Error) return { problem: `cmod device cannot name this machine: ${device.message}`, fix: 'Give the machine a machine id with sudo systemd-machine-id-setup, or install cmod with npm install -g @cmodjs/cli.' }
  const stored = await store.get(`devices/${device.id}.json`).catch((error: unknown) => new Error(messageOf(error)))
  if (stored instanceof Error) return { problem: `${device.name}'s registration could not be read from ${BUCKET}: ${stored.message}`, fix: 'Fix what the bucket check names.' }
  if (stored === undefined) return { problem: `${device.name} is not registered in ${BUCKET}.`, fix: START_CLAUDE }
  const record = JSON.parse(new TextDecoder().decode(stored.body)) as DeviceRecord
  if (record.name === device.name) return { ok: `${device.name} is registered as ${device.id}.` }
  return { wait: `${device.id} is registered as ${record.name}, which ran anyhost at ${new Date(stored.modifiedAt).toISOString()}. The program's line says whether ${device.name} is that machine renamed or its clone.` }
}

async function programChecks(): Promise<Check[]> {
  const instance = Bun.file(join(process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), 'cmod', 'instances', 'anyhost', 'anyhost.json'))
  if (!(await instance.exists())) return [{ problem: 'The anyhost program is not running.', fix: START_CLAUDE }]
  const { address } = (await instance.json()) as { address: string }
  const status = await fetch(`http://${address}/status`, { signal: AbortSignal.timeout(3000) })
    .then(async (response) => (await response.json()) as Status)
    .catch(() => undefined)
  if (status === undefined) return [{ problem: `The anyhost program does not answer at ${address}.`, fix: START_CLAUDE }]
  const { state, message } = status.registration
  const registration: Check =
    state === 'registered'
      ? {
          ok: `The anyhost program runs at ${address}: it uploads ${status.uploadEvery === 0 ? 'every write' : `every ${status.uploadEvery} seconds`}, its last upload was at ${status.capturedAt || 'none yet'}, and ${status.pending} files wait for the next one.`,
        }
      : state === 'waiting'
        ? { wait: `The anyhost program at ${address} waits: ${message}` }
        : state === 'cloned'
          ? { problem: `The anyhost program at ${address} captures nothing: ${message}`, fix: 'Restart the machine after the fix, then start Claude Code.' }
          : { problem: `The anyhost program at ${address} has not registered this machine yet.`, fix: 'It tries again every 60 seconds. The line below names why it failed.' }
  return [registration, ...status.problems.map((problem): Check => ({ problem, fix: 'The program tries again at the next write or within 60 seconds, and this line goes once the cause is gone.' }))]
}

export async function doctor(store: Store): Promise<number> {
  const checks = [await profileCheck(), await bucketCheck(store), await deviceCheck(store), ...(await programChecks())]
  for (const check of checks) console.log('ok' in check ? `✔ ${check.ok}` : 'wait' in check ? `… ${check.wait}` : `✘ ${check.problem}\n  ${check.fix}`)
  return checks.some((check) => 'problem' in check) ? 1 : 0
}
