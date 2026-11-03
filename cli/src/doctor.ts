import { homedir } from 'node:os'
import { join } from 'node:path'
import { cloneFixFor, cmodDevice, QUIET_BEFORE_RENAME_MS, type DeviceRecord } from './device.ts'
import type { Status } from './serve.ts'
import { BUCKET, PROFILE, profileOf, type Store } from './store.ts'

type Check = { readonly ok: string } | { readonly problem: string; readonly fix: string }

const START_CLAUDE = 'Start Claude Code on this machine. The anyhost mod starts the anyhost program, which records and registers this machine.'

async function profileCheck(): Promise<Check> {
  const config = process.env['AWS_CONFIG_FILE'] ?? join(homedir(), '.aws', 'config')
  const credentials = process.env['AWS_SHARED_CREDENTIALS_FILE'] ?? join(homedir(), '.aws', 'credentials')
  const { endpoint, hasKeys } = await profileOf()
  const missing = [
    ...(endpoint === undefined ? [`endpoint_url under [profile ${PROFILE}] in ${config}`] : []),
    ...(hasKeys ? [] : [`aws_access_key_id and aws_secret_access_key under [${PROFILE}] in ${credentials}`]),
  ]
  if (missing.length === 0) return { ok: `The AWS profile ${PROFILE} names R2's endpoint and keys.` }
  return { problem: `The AWS profile ${PROFILE} lacks ${missing.join(', and ')}.`, fix: `Write endpoint_url = https://<account id>.eu.r2.cloudflarestorage.com and region = auto under [profile ${PROFILE}] in ${config}, and the R2 API token's keys under [${PROFILE}] in ${credentials}.` }
}

async function bucketCheck(store: Store): Promise<Check> {
  try {
    await store.list('devices/')
    return { ok: `The bucket ${BUCKET} answers.` }
  } catch (error) {
    return { problem: `The bucket ${BUCKET} did not answer: ${String(error)}`, fix: `Check that the bucket exists in R2 and that the keys of the AWS profile ${PROFILE} can read and write it.` }
  }
}

async function deviceCheck(store: Store): Promise<Check> {
  const device = await cmodDevice().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
  if (device instanceof Error) return { problem: `cmod device cannot name this machine: ${device.message}`, fix: 'Give the machine a machine id with sudo systemd-machine-id-setup, or install cmod with npm install -g @cmodjs/cli.' }
  const stored = await store.get(`devices/${device.id}.json`).catch(() => undefined)
  if (stored === undefined) return { problem: `${device.name} is not registered in ${BUCKET}.`, fix: START_CLAUDE }
  const record = JSON.parse(new TextDecoder().decode(stored.body)) as DeviceRecord
  if (record.name === device.name) return { ok: `${device.name} is registered as ${device.id}.` }
  if (Date.now() - stored.modifiedAt >= QUIET_BEFORE_RENAME_MS) return { problem: `${device.id} is registered as ${record.name}, which has been quiet since ${new Date(stored.modifiedAt).toISOString()}.`, fix: `${START_CLAUDE} The program registers ${device.name} as its new name.` }
  return { problem: `This machine, ${device.name}, has the id of ${record.name}, which ran anyhost at ${new Date(stored.modifiedAt).toISOString()}.`, fix: cloneFixFor(device.os) }
}

async function programCheck(): Promise<Check> {
  const instance = Bun.file(join(process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), 'cmod', 'instances', 'anyhost', 'anyhost.json'))
  if (!(await instance.exists())) return { problem: 'The anyhost program is not running.', fix: START_CLAUDE }
  const { address } = (await instance.json()) as { address: string }
  const status = await fetch(`http://${address}/status`, { signal: AbortSignal.timeout(3000) })
    .then(async (response) => (await response.json()) as Status)
    .catch(() => undefined)
  if (status === undefined) return { problem: `The anyhost program does not answer at ${address}.`, fix: START_CLAUDE }
  if (status.lastError !== '') return { problem: `The anyhost program at ${address} failed: ${status.lastError}`, fix: 'Fix what the error names. The program tries again every 30 seconds.' }
  return { ok: `The anyhost program runs at ${address}: its last capture was at ${status.capturedAt || 'none yet'}, ${status.pending} live files wait for the next one, and ${status.backlog} older files wait in the backlog.` }
}

export async function doctor(store: Store): Promise<number> {
  const checks = [await profileCheck(), await bucketCheck(store), await deviceCheck(store), await programCheck()]
  for (const check of checks) console.log('ok' in check ? `✔ ${check.ok}` : `✘ ${check.problem}\n  ${check.fix}`)
  return checks.some((check) => 'problem' in check) ? 1 : 0
}
