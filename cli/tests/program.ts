import { onTestFinished } from 'bun:test'
import type { Subprocess } from 'bun'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { decompress } from '../src/capture.ts'
import { machinesOf, type Device, type MachineRoots } from '../src/device.ts'
import type { Relay } from '../src/relay.ts'
import { statusOn, temporaryFolder, until, type MemoryRelay } from './memory.ts'

export const SESSION = '11111111-2222-3333-4444-555555555555'
export const roots = (home: string): MachineRoots => ({ home, claudeHome: join(home, '.claude'), claudeTmp: join(home, 'tmp'), codexHome: join(home, '.codex') })
export const DAILY_LIMIT = "Cloudflare refuses the relay with its error 1027: the relay's Worker reached the Free plan's limit of 100,000 requests a day, which resets at 00:00 UTC."
export const decoder = new TextDecoder()
export const HOST: Device = { id: 'device-host', name: 'anyhost-a', os: 'linux', arch: 'arm64' }
export const CLI = join(import.meta.dir, '..', 'src', 'main.ts')
export const killAfterTest = (child: Subprocess): void =>
  onTestFinished(async () => {
    child.kill()
    await child.exited
  })

export const script = (path: string, text: string): string => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, 0o755)
  return path
}

export const fakeHc = (folder: string): string => `#!/bin/bash
F='${folder}'
RUNS="\${XDG_STATE_HOME:-$HOME/.local/state}/anyhost/runs"
mkdir -p "$F/terminals" "$RUNS"
case "$1" in
  ls)
    wanted="\${4#anyhost.session=}"
    found=''
    for terminal in "$F"/terminals/*; do
      [ -e "$terminal" ] || continue
      read -r owner pid < "$terminal"
      if [ "$owner" = "$wanted" ] && kill -0 "$pid" 2>/dev/null; then found="{\\"address\\":\\"$(basename "$terminal")\\"}"; fi
    done
    printf '{"terminals":[%s]}' "$found"
    exit 0 ;;
  send)
    left="$(cat "$F/unsettled" 2>/dev/null || echo 0)"
    if [ "$left" -gt 0 ]; then
      echo $((left - 1)) > "$F/unsettled"
      echo "{\\"error\\":{\\"kind\\":\\"unavailable\\",\\"message\\":\\"$2 is still starting: its output has not settled\\"}}" >&2
      exit 5
    fi
    echo "$2 $3" >> "$F/sent.log"
    read -r owner pid < "$F/terminals/$2"
    record="$CLAUDE_CONFIG_DIR/sessions/$pid.json"
    if [ -e "$record" ]; then sed 's/"status":"idle"/"status":"busy"/' "$record" > "$record.new" && mv "$record.new" "$record"; fi
    exit 0 ;;
  keys) shift; echo "$*" >> "$F/keys.log"; exit 0 ;;
  kill) read -r owner pid < "$F/terminals/$2"; kill -9 "$pid"; exit 0 ;;
  read) read -r owner pid < "$F/terminals/$2"; printf 'screen of %s\\n\\n\\n%s\\n' "$owner" "$(tail -n 1 "$F/sent.log" 2>/dev/null | cut -d ' ' -f 2-)"; exit 0 ;;
  get)
    read -r owner pid < "$F/terminals/$2" || exit 3
    state=finished
    if kill -0 "$pid" 2>/dev/null; then state=live; fi
    printf '{"state":"%s","cwd":"/","labels":{"anyhost.session":"%s"}}' "$state" "$owner"
    exit 0 ;;
  machine) printf '{"machines":[]}'; exit 0 ;;
  label) exit 0 ;;
  run) ;;
  *) exit 2 ;;
esac
args=("$@")
cwd=''
session=''
last=0
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[i]}" in
    --cwd) cwd="\${args[i + 1]}" ;;
    --session|--session-id) session="\${args[i + 1]}" ;;
    --) last=$i ;;
  esac
done
command="\${args[*]:last+1}"
echo "$(date +%s%N) $cwd $session $command" >> "$F/hc.log"
if [ -e "$F/hang" ]; then sleep "$(cat "$F/hang")"; fi
if [ -e "$F/fail" ]; then cat "$F/fail" >&2; exit 1; fi
if [ -e "$F/appends" ]; then cat "$F/appends" >> "$(find "$CLAUDE_CONFIG_DIR/projects" -name "$session.jsonl" | head -n 1)"; fi
address="t$(ls "$F/terminals" | wc -l | tr -d ' ')"
running() {
  sleep 600 < /dev/null > /dev/null 2>&1 &
  echo $! >> "$F/copies"
  echo "$session $!" > "$F/terminals/$address"
  if [ -r "/proc/$!/stat" ]; then stat="$(cat "/proc/$!/stat")"; start="$(echo "\${stat##*) }" | cut -d ' ' -f 20)"; else start="$(TZ=UTC ps -o lstart= -p $! | sed 's/^ *//;s/ *$//')"; fi
  printf '{"session":"%s","runner":{"process":{"id":%s,"start":"%s"},"version":"","startedAt":""},"terminal":{"address":"%s","machine":""},"claude":{"command":["claude"]}}' "$session" $! "$start" "$address" > "$RUNS/$session.json"
  printf '{"pid":%s,"sessionId":"%s","kind":"interactive","cwd":"%s","status":"idle"}' $! "$session" "$cwd" > "$CLAUDE_CONFIG_DIR/sessions/$!.json"
}
if [ -e "$F/unlisted" ]; then (while [ -e "$F/unlisted" ]; do sleep 0.1; done; running) < /dev/null > /dev/null 2>&1 &
else running; fi
printf '{"address":"%s","state":"live"}' "$address"
`

export const killCopiesAfterTest = (folder: string): void =>
  onTestFinished(() => {
    for (const pid of readFileSync(join(folder, 'copies'), { encoding: 'utf8', flag: 'a+' }).split('\n').filter((line) => line !== '')) Bun.spawnSync(['kill', '-9', pid])
  })

export async function machineFor(relay: MemoryRelay, device: Device, person: Record<string, unknown> = {}): Promise<{ readonly env: Record<string, string>; readonly socket: string; readonly folder: string }> {
  const folder = temporaryFolder()
  killCopiesAfterTest(folder)
  const home = join(folder, 'home')
  mkdirSync(join(folder, 'tmp'), { recursive: true })
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
  script(join(folder, 'bin', 'hc'), fakeHc(folder))
  const env = {
    PATH: `${join(folder, 'bin')}:${process.env['PATH'] ?? ''}`,
    HOME: home,
    XDG_STATE_HOME: join(folder, 'state'),
    XDG_DATA_HOME: join(folder, 'data'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CLAUDE_CODE_TMPDIR: join(folder, 'tmp'),
    CODEX_HOME: join(home, '.codex'),
    ANYHOST_DEVICE_ID: device.id,
    ANYHOST_DEVICE_NAME: device.name,
    ANYHOST_DEVICE_OS: device.os,
    ANYHOST_DEVICE_ARCH: device.arch,
    ...(process.env['XDG_RUNTIME_DIR'] === undefined ? {} : { XDG_RUNTIME_DIR: process.env['XDG_RUNTIME_DIR'] }),
  }
  const token = await relay.join(device, roots(home))
  script(
    join(env.XDG_DATA_HOME, 'cmod', 'programs', 'cmod'),
    `#!/bin/sh\ncase "$1 $2" in\n  "secret get") printf '%s' '${token}' ;;\n  "options anyhost") printf '%s' '${JSON.stringify({ person })}' ;;\n  "device --json") printf '%s' '${JSON.stringify(device)}' ;;\n  *) exit 1 ;;\nesac\n`,
  )
  mkdirSync(join(env.XDG_STATE_HOME, 'anyhost'), { recursive: true })
  writeFileSync(join(env.XDG_STATE_HOME, 'anyhost', 'relay.json'), JSON.stringify({ url: relay.url }))
  return { env, socket: join(env.XDG_STATE_HOME, 'anyhost', 'serve.sock'), folder }
}

export async function serveOn(env: Record<string, string>): Promise<{ readonly address: string; readonly child: Subprocess; readonly logged: () => string }> {
  const child = Bun.spawn(['bun', CLI, 'serve'], { env, stdout: 'pipe', stderr: 'pipe' })
  killAfterTest(child)
  let logged = ''
  void (async () => {
    const text = new TextDecoder()
    for await (const chunk of child.stderr) {
      process.stderr.write(chunk)
      logged += text.decode(chunk, { stream: true })
    }
  })()
  const reader = child.stdout.getReader()
  let printed = ''
  while (!printed.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`anyhost serve exited, having printed ${JSON.stringify(printed)}.`)
    printed += decoder.decode(value)
  }
  reader.releaseLock()
  return { address: printed.slice(0, printed.indexOf('\n')), child, logged: () => logged }
}

export async function anyhostOn(env: Record<string, string>, args: readonly string[], input = ''): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  const child = Bun.spawn(['bun', CLI, ...args], { env, stdin: new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' })
  killAfterTest(child)
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, out, err }
}
export const OTHER_SESSION = '22222222-3333-4444-5555-666666666666'
export const isUploaded = (relay: MemoryRelay, session: string, text: string): boolean =>
  relay.puts.some(({ key, body }) => key.startsWith(`journals/${session}/hot/`) && decoder.decode(decompress(body)).includes(text))
export const problemsOn = async (socket: string): Promise<readonly string[]> => (await statusOn(socket)).problems
export const ranAnHourAgo = (machine: { readonly env: Record<string, string> }): void => {
  const heartbeat = join(machine.env['XDG_STATE_HOME'] ?? '', 'anyhost', 'heartbeat')
  writeFileSync(heartbeat, '')
  const hourAgo = new Date(Date.now() - 60 * 60_000)
  utimesSync(heartbeat, hourAgo, hourAgo)
}
export const LAPTOP: Device = { id: 'device-laptop', name: 'anyhost-b', os: 'linux', arch: 'arm64' }
export const WORKER: Device = { id: 'device-worker', name: 'anyhost-a', os: 'linux', arch: 'arm64' }
export const logOf = (folder: string, name: string): string[] => readFileSync(join(folder, name), { encoding: 'utf8', flag: 'a+' }).split('\n').filter((line) => line !== '')
export const runsOn = (folder: string): { readonly at: number; readonly cwd: string; readonly session: string; readonly command: string }[] =>
  logOf(folder, 'hc.log').map((line) => {
    const [at = '', cwd = '', session = '', ...command] = line.split(' ')
    return { at: Number(at), cwd, session, command: command.join(' ') }
  })
export const startedOn = (machine: { readonly folder: string }): string => runsOn(machine.folder)[0]?.session ?? ''
export const copiesOn = (folder: string): { readonly pid: number; readonly isRunning: boolean }[] =>
  logOf(folder, 'copies').map((line) => ({ pid: Number(line), isRunning: Bun.spawnSync(['kill', '-0', line]).exitCode === 0 }))

export type Moved = { readonly to: string; readonly step: string; readonly line: string }
export type Claimed = { readonly machine?: string; readonly move?: Moved }
export const claimOn = async (socket: string, session = SESSION): Promise<Claimed> => (await (await fetch(`http://localhost/claims/${session}`, { unix: socket })).json()) as Claimed
export const postTo = async (socket: string, path: string, body: object): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> => {
  const answer = await fetch(`http://localhost${path}`, { unix: socket, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> }
}
export async function stepsOf(socket: string, until: ReadonlySet<string> = new Set(['moved', 'failed']), read: readonly string[] = []): Promise<{ readonly steps: string[]; readonly last: Moved }> {
  const steps = [...read]
  for (const started = Date.now(); Date.now() - started < 30_000; await Bun.sleep(10)) {
    const { move } = await claimOn(socket)
    if (move === undefined) continue
    if (steps.at(-1) !== move.step) steps.push(move.step)
    if (until.has(move.step)) return { steps, last: move }
  }
  throw new Error(`The move showed ${steps.join(', ')} and reached none of ${[...until].join(', ')} within 30 s.`)
}

export async function runningOn(relay: MemoryRelay, device = LAPTOP, person: Record<string, unknown> = {}, argv: string[] = ['sleep', '600']) {
  const laptop = await machineFor(relay, device, person)
  const home = laptop.env['HOME'] ?? ''
  const cwd = join(home, 'work')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'notes.txt'), 'the plan for the trip\n')
  const { child, logged } = await serveOn(laptop.env)
  await until(() => relay.isConnected(device.id), 'the machine connecting')
  const transcript = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","cwd":"${cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"Plan the trip"}}\n`)
  const claude = Bun.spawn(argv)
  killAfterTest(claude)
  const status = (value: string): void => writeFileSync(join(home, '.claude', 'sessions', `${claude.pid}.json`), JSON.stringify({ pid: claude.pid, sessionId: SESSION, kind: 'interactive', cwd, status: value }))
  status('idle')
  await until(async () => (await relay.claims()).get(SESSION) === device.id, 'the machine claiming the session', 15_000)
  return { ...laptop, cwd, transcript, claude, status, child, logged }
}

export async function workerOn(relay: MemoryRelay, prepare: (folder: string) => void = () => undefined, device = WORKER) {
  const worker = await machineFor(relay, device)
  prepare(worker.folder)
  const served = await serveOn(worker.env)
  await until(() => relay.isConnected(device.id), 'the machine connecting')
  return { ...worker, ...served }
}
export const keepsWriting = (laptop: { readonly cwd: string; readonly transcript: string }): { readonly written: () => number; readonly stop: () => void } => {
  let lines = 0
  const writing = setInterval(() => appendFileSync(laptop.transcript, `{"type":"progress","cwd":"${laptop.cwd}","sessionId":"${SESSION}","line":${++lines}}\n`), 50)
  return { written: () => lines, stop: () => clearInterval(writing) }
}
export const DESKTOP: Device = { id: 'device-desktop', name: 'anyhost-c', os: 'linux', arch: 'arm64' }
export const listedConnected = async (asking: Relay, id: string): Promise<boolean | undefined> => (await machinesOf(asking)).find((machine) => machine.id === id)?.connected
export const configOf = (machine: { readonly env: Record<string, string> }): string => join(machine.env['CLAUDE_CONFIG_DIR'] ?? '', '.claude.json')
export const trustedIn = (machine: { readonly env: Record<string, string> }): string[] => {
  const { projects = {} } = JSON.parse(readFileSync(configOf(machine), { encoding: 'utf8', flag: 'a+' }) || '{}') as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }
  return Object.entries(projects).filter(([, project]) => project.hasTrustDialogAccepted === true).map(([folder]) => folder)
}
export const trust = (machine: { readonly env: Record<string, string> }, folder: string): void => writeFileSync(configOf(machine), JSON.stringify({ projects: { [realpathSync(folder)]: { hasTrustDialogAccepted: true } } }))
export function tripOn(laptop: { readonly env: Record<string, string> }): string {
  const origin = join(temporaryFolder(), 'trip.git')
  const checkout = join(laptop.env['HOME'] ?? '', 'trip')
  const git = (...args: string[]): void => void Bun.spawnSync(['git', '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', ...args], { stderr: 'ignore' })
  git('init', '--bare', '-b', 'main', origin)
  git('clone', origin, checkout)
  mkdirSync(join(checkout, 'plans'), { recursive: true })
  writeFileSync(join(checkout, 'plans', 'route.md'), 'Lisbon, then Porto\n')
  git('-C', checkout, 'add', '.')
  git('-C', checkout, 'commit', '-m', 'Plan the route')
  git('-C', checkout, 'push', 'origin', 'main')
  return checkout
}
export const sentOn = (folder: string): string[] => logOf(folder, 'sent.log')
export const isWatcherProblem = (problem: string): boolean => problem.includes(' watcher: ')
