import { afterEach, expect, setDefaultTimeout, setSystemTime, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LIVE_MS, MAX_MESSAGE_BYTES, PING_MS, cloneFixFor } from '../../relay/protocol.ts'
import { isAlive } from '../src/claude.ts'
import { decompress, hotKey, journalOf, openCapture, openDatabase, QUIET_MS, sealQuiet, uploadSessions } from '../src/capture.ts'
import { devicesOf, inviteMachine, machinesOf, removeMachine, type Device, type MachineRoots } from '../src/device.ts'
import { connectRelay, type Relay, type RelayOptions } from '../src/relay.ts'
import type { Status } from '../src/serve.ts'
import { listSessions } from '../src/sessions.ts'
import { failTest, memoryRelay, noCode, statusOn, stopRelays, temporaryFolder, until, welcomed, type MemoryRelay } from './memory.ts'

afterEach(stopRelays)
// A test that runs `anyhost serve` against the relay in workerd took 5.0 s alone on the Mac at a load average of 133,
// and 8.3 s on anyhost-a, past Bun's 5 s.
setDefaultTimeout(30_000)

const SESSION = '11111111-2222-3333-4444-555555555555'
const device: Device = { id: 'device-a', name: 'anyhost-a', os: 'linux', arch: 'arm64' }
const roots = (home: string): MachineRoots => ({ home, claudeHome: join(home, '.claude'), claudeTmp: join(home, 'tmp'), codexHome: join(home, '.codex') })
const opened: Relay[] = []
afterEach(() => {
  for (const relay of opened.splice(0)) relay.close()
})
// a relay whose login nothing keeps, so a login the relay refused has nothing to forget
const connect = (options: Omit<RelayOptions, 'forget'>): Relay => {
  const relay = connectRelay({ ...options, forget: async () => undefined })
  opened.push(relay)
  return relay
}

test('a request whose answer the dropped socket lost goes again on the next socket, and its frame is stored once', async () => {
  const relay = await memoryRelay()
  const home = join(temporaryFolder(), 'home')
  const capture = openCapture(relay.connect(device, roots(home)), device, roots(home), { db: openDatabase(join(temporaryFolder(), 'state')), code: noCode })
  const transcript = join(home, '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
  relay.dropAnswers = 1

  await Promise.all(uploadSessions(capture, [{ session: SESSION, tool: 'claude', paths: new Set([transcript]) }], failTest).map(([, left]) => left))
  const frame = hotKey(SESSION, 0)
  expect(relay.requests.filter((ops) => ops.some((op) => op.op === 'put' && op.key === frame))).toHaveLength(2)
  expect(relay.puts.filter(({ key }) => key === frame)).toHaveLength(1)
  expect(journalOf(capture.db, SESSION)?.end).toBeGreaterThan(0)
})

test('a machine with the id of a connected machine and another name, as a clone has, is refused with the fix', async () => {
  const relay = await memoryRelay()
  const token = await relay.join(device, roots('/home/ada'))
  await welcomed(connect({ login: async () => ({ url: relay.url, token }), device, roots: roots('/home/ada'), isPatient: true }))

  const clone = connect({ login: async () => ({ url: relay.url, token }), device: { ...device, name: 'anyhost-c' }, roots: roots('/home/ada'), isPatient: true })
  await until(() => clone.state.is === 'refused', 'the refusal')
  expect(clone.state).toEqual({ is: 'refused', message: `The relay refused anyhost-c: anyhost-a is connected with this machine's id. A machine cloned from another keeps its id, so anyhost captures nothing here. ${cloneFixFor('linux')}` })
})

test('a removed machine is refused, and a command of it fails with the reason', async () => {
  const relay = await memoryRelay()
  const token = await relay.join(device, roots('/home/ada'))
  const service = connect({ login: async () => ({ url: relay.url, token }), device, roots: roots('/home/ada'), isPatient: true })
  await welcomed(service)
  relay.remove(device.id)

  await until(() => service.state.is === 'unjoined', 'the removal')
  const message = 'This machine was removed from your machines. Join it again with a link from Add a machine.'
  expect(service.state).toEqual({ is: 'unjoined', message })
  const command = connect({ login: async () => ({ url: relay.url, token }), device, roots: roots('/home/ada'), isPatient: false })
  await expect(Promise.all(command.run([{ op: 'claims' }]))).rejects.toThrow(message)
})

test('a machine that never joined waits for a join in the service, and connects at once when one comes', async () => {
  const relay = await memoryRelay()
  let login: { url: string; token: string } | undefined
  const service = connect({ login: async () => login, device, roots: roots('/home/ada'), isPatient: true })
  await until(() => service.state.is === 'unjoined', 'the service finding no login')
  let isSettled = false
  const claims = Promise.all(service.run([{ op: 'claims' }])).finally(() => (isSettled = true))
  await Bun.sleep(50)
  expect(isSettled).toBe(false)

  login = { url: relay.url, token: await relay.join(device, roots('/home/ada')) }
  service.reconnect()
  // the next try waits a second after the first failure, and the join connects well before it
  await until(() => service.state.is === 'connected', 'the join connecting')
  expect(await claims).toEqual([{ status: 200, claims: {} }])

  const command = connect({ login: async () => undefined, device, roots: roots('/home/ada'), isPatient: false })
  await expect(Promise.all(command.run([{ op: 'claims' }]))).rejects.toThrow('This machine is not joined to your relay')
})

test('each connect brings this machine\'s roots, which the relay lists from then on', async () => {
  const relay = await memoryRelay()
  const token = await relay.join(device, roots('/home/ada'))
  const moved = { ...roots('/home/ada'), claudeHome: '/srv/claude-config' }
  const service = connect({ login: async () => ({ url: relay.url, token }), device, roots: moved, isPatient: true })
  await welcomed(service)

  expect((await devicesOf(service)).get(device.id)?.roots).toEqual(moved)
})

test('a removed machine leaves the machines list and stays in devicesOf, so its sessions stay listed', async () => {
  const relay = await memoryRelay()
  const other: Device = { id: 'device-b', name: 'anyhost-b', os: 'linux', arch: 'arm64' }
  const here = relay.connect(device, roots('/home/ada'))
  const gone = relay.connect(other, roots('/home/bob'))
  await Promise.all([welcomed(here), welcomed(gone)])
  await relay.objects.put(`sessions/${other.id}/index.json`, new TextEncoder().encode(JSON.stringify([{ id: SESSION, tool: 'claude', cwd: '/home/bob/work', lastActivity: '2026-11-06T00:00:00.000Z' }])))

  await removeMachine(here, other.id)
  // workerd ends a socket the Pool closes while the socket is idle 10 s after the close: 10,005 to 10,022 ms over 3 runs
  await until(() => gone.state.is === 'unjoined', 'the removed machine hearing it', 20_000)
  expect((await machinesOf(here)).map(({ name }) => name)).toEqual(['anyhost-a'])
  expect((await devicesOf(here)).get(other.id)).toMatchObject({ name: 'anyhost-b', roots: roots('/home/bob') })
  expect((await devicesOf(here)).get(other.id)?.removedAt).toBeString()
  expect((await listSessions(here)).map(({ id, machine }) => [id, machine])).toEqual([[SESSION, 'anyhost-b']])
  // a remove sent again, as after its answer was lost, is done as the first was
  await removeMachine(here, other.id)
  await expect(removeMachine(here, 'device-never-joined')).rejects.toThrow('No machine with the id device-never-joined is joined.')
})

test('an invite is the command that installs anyhost with the invite in the option join, quoted for any shell', async () => {
  const relay = await memoryRelay()
  const here = relay.connect(device, roots('/home/ada'))
  const { command, expiresAt } = await inviteMachine(here)
  expect(command).toMatch(new RegExp(`^cmod install heyJordanParker/anyhost --option 'join=${relay.url}/v1/join#[0-9A-HJKMNP-TV-Z]{26}'$`))
  expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000)
})

test('a command fails with the relay it could not reach, instead of waiting for it', async () => {
  const command = connect({ login: async () => ({ url: 'http://127.0.0.1:9', token: 'token' }), device, roots: roots('/home/ada'), isPatient: false })
  await expect(Promise.all(command.run([{ op: 'claims' }]))).rejects.toThrow('The relay at http://127.0.0.1:9 closed the connection')
})

test('an object over 1 MiB goes by HTTP, and a broken download goes on from the byte it reached', async () => {
  const relay = await memoryRelay()
  const client = relay.connect(device, roots('/home/ada'))
  const bytes = crypto.getRandomValues(new Uint8Array(3 * MAX_MESSAGE_BYTES))
  const [put] = client.run([{ op: 'put', key: 'files/big.bin', bytes, if: { none: '*' } }])
  expect(await put).toMatchObject({ status: 200 })
  expect(relay.requests.flat()).toEqual([])
  relay.cutDownloads = 1

  const got = await client.getObject('files/big.bin')
  expect(Buffer.from(got?.bytes ?? new Uint8Array()).equals(Buffer.from(bytes))).toBe(true)
  expect(relay.ranges[0]).toBeNull()
  expect(relay.ranges[1]).toMatch(/^bytes=\d+-$/)
  expect(Number(relay.ranges[1]?.slice('bytes='.length, -1))).toBeGreaterThan(0)
})

const md5 = (bytes: Uint8Array): string => new Bun.CryptoHasher('md5').update(bytes).digest('hex')
const DAILY_LIMIT = "Cloudflare refuses the relay with its error 1027: the relay's Worker reached the Free plan's limit of 100,000 requests a day, which resets at 00:00 UTC."

// The suite missed it because the stand-in relay's join gave a machine that joined before its old token, where the
// Pool's join gives a new one and refuses the old.
test('a machine that joins again while connected puts an object over 1 MiB with its new token', async () => {
  const relay = await memoryRelay()
  let login = { url: relay.url, token: await relay.join(device, roots('/home/ada')) }
  const service = connect({ login: async () => login, device, roots: roots('/home/ada'), isPatient: true })
  await welcomed(service)
  // as the Add a machine command pasted again on this machine gives it a new token while its socket is open
  login = { url: relay.url, token: await relay.join(device, roots('/home/ada')) }
  service.reconnect()

  const bytes = crypto.getRandomValues(new Uint8Array(2 * MAX_MESSAGE_BYTES))
  expect(await service.runOne({ op: 'put', key: 'files/big.bin', bytes })).toEqual({ status: 200, etag: md5(bytes) })
})

// The suite missed it because no relay it ran ever left a request unanswered on a socket that stayed open.
test('a request the relay leaves unanswered goes again on a new socket 40 seconds later, so the seal that ends a backup pass ends', async () => {
  const relay = await memoryRelay()
  const home = join(temporaryFolder(), 'home')
  const capture = openCapture(relay.connect(device, roots(home)), device, roots(home), { db: openDatabase(join(temporaryFolder(), 'state')), code: noCode })
  const transcript = join(home, '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
  await Promise.all(uploadSessions(capture, [{ session: SESSION, tool: 'claude', paths: new Set([transcript]) }], failTest).map(([, left]) => left))
  const asked = relay.requests.length
  relay.unanswered = 1
  // a minute past the 10 quiet minutes after the upload, as a seal counts a session written that very millisecond as
  // not quiet
  const quiet = (journalOf(capture.db, SESSION)?.writtenAt ?? 0) + QUIET_MS + 60_000

  const started = Date.now()
  expect(await sealQuiet(capture, failTest, quiet)).toEqual(new Map())
  expect(Date.now() - started).toBeGreaterThanOrEqual(40_000)
  expect(relay.requests.slice(asked, asked + 2)).toEqual([
    [{ op: 'claim', session: SESSION, take: false }],
    [{ op: 'claim', session: SESSION, take: false }],
  ])
  expect(journalOf(capture.db, SESSION)?.sealed).toBe(journalOf(capture.db, SESSION)?.end ?? -1)
}, 90_000)

// The suite missed it because a socket that brought no answer brought nothing else either, while the socket waits
// from each answer: a pong, as the one to the ping at 30 seconds, and a message another machine sends are no answer.
test('a request the relay leaves unanswered drops its socket 40 seconds later while pongs and messages still arrive on it', async () => {
  const relay = await memoryRelay()
  const other: Device = { id: 'device-b', name: 'anyhost-b', os: 'linux', arch: 'arm64' }
  const here = relay.connect(device, roots('/home/ada'))
  const there = relay.connect(other, roots('/home/bob'))
  await Promise.all([welcomed(here), welcomed(there)])
  const heard: string[] = []
  here.on('moved', ({ id }) => void heard.push(id))
  const sending = setInterval(() => there.send({ t: 'moved', id: `move-${heard.length}`, to: device.id }), 5000)
  try {
    const asked = relay.requests.length
    relay.unanswered = 1

    const started = Date.now()
    expect(await here.runOne({ op: 'devices' })).toMatchObject({ status: 200 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(40_000)
    expect(heard.length).toBeGreaterThanOrEqual(7)
    expect(relay.requests.slice(asked)).toEqual([[{ op: 'devices' }], [{ op: 'devices' }]])
  } finally {
    clearInterval(sending)
  }
}, 90_000)

// The suite missed it because every login a test gave a relay read.
test('a relay login that fails to read is a problem of its own with the reason, and the next try connects', async () => {
  const relay = await memoryRelay()
  const token = await relay.join(device, roots('/home/ada'))
  let reads = 0
  const login = async (): Promise<{ url: string; token: string }> => {
    reads += 1
    if (reads === 1) throw new Error('cmod secret get anyhost token exited with 1.')
    return { url: relay.url, token }
  }
  const service = connect({ login, device, roots: roots('/home/ada'), isPatient: true })

  await until(() => service.state.is !== 'connecting', 'the failed read')
  expect(service.state).toEqual({ is: 'offline', message: "anyhost could not read this machine's relay login: cmod secret get anyhost token exited with 1." })
  await welcomed(service)
  expect(reads).toBe(2)
})

test("an object request Cloudflare refuses for the daily limit goes again, and a connect it refuses names the limit and its reset", async () => {
  const relay = await memoryRelay()
  const client = relay.connect(device, roots('/home/ada'))
  await welcomed(client)
  relay.dailyLimited = 1
  const bytes = crypto.getRandomValues(new Uint8Array(2 * MAX_MESSAGE_BYTES))
  expect(await client.runOne({ op: 'put', key: 'files/big.bin', bytes })).toEqual({ status: 200, etag: md5(bytes) })

  relay.dailyLimited = Infinity
  client.reconnect()
  await until(() => client.state.is === 'offline', 'the refused connect')
  expect(client.state).toEqual({ is: 'offline', message: DAILY_LIMIT })
})

const decoder = new TextDecoder()
const HOST: Device = { id: 'device-host', name: 'anyhost-a', os: 'linux', arch: 'arm64' }
const CLI = join(import.meta.dir, '..', 'src', 'main.ts')
const children: Subprocess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited
  }
})

const script = (path: string, text: string): string => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, 0o755)
  return path
}

// The herdr-core of a test machine, whose `hc run` runs each session the way the runner it names would, as a process of
// its own, `sleep 600`, which writes Claude Code's record of the session the runner's `--session` or Claude Code's
// `--session-id` names, idle, in the folder of `--cwd`. `hc run` fails with the text of `fail` in the machine's folder
// when there is one, waits the seconds `hang` holds first, appends the text of `appends` to the session's transcript,
// as Claude Code re-appends a resumed session's metadata there, and while `unlisted` is there writes the record only
// once that file goes. Each run goes into `hc.log` in the machine's folder: the time, its `--cwd`, the session, and the
// Claude Code command the runner runs, and each copy's pid into `copies`. Each terminal it opens is `terminals/<address>`
// in the machine's folder, which holds its session and its copy's pid, and the copy writes its run as the runner does,
// naming that terminal: `hc ls --label anyhost.session=<id>` lists the session's live one, `hc send` logs the text into
// `sent.log` with the terminal's address and makes the copy's record say `busy`, as the turn it starts does, `hc keys`
// logs the keys into `keys.log`, `hc kill` ends the terminal's copy, and
// `hc read` prints the session's screen, its id and the last text sent.
const fakeHc = (folder: string): string => `#!/bin/bash
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
running() {
  sleep 600 < /dev/null > /dev/null 2>&1 &
  echo $! >> "$F/copies"
  address="t$(ls "$F/terminals" | wc -l | tr -d ' ')"
  echo "$session $!" > "$F/terminals/$address"
  printf '{"pid":%s,"terminal":"%s","command":["claude"]}' $! "$address" > "$RUNS/$session.json"
  printf '{"pid":%s,"sessionId":"%s","kind":"interactive","cwd":"%s","status":"idle"}' $! "$session" "$cwd" > "$CLAUDE_CONFIG_DIR/sessions/$!.json"
}
if [ -e "$F/unlisted" ]; then (while [ -e "$F/unlisted" ]; do sleep 0.1; done; running) < /dev/null > /dev/null 2>&1 &
else running; fi
printf '{"address":"t1","state":"live"}'
`

const machineFolders: string[] = []
afterEach(() => {
  for (const folder of machineFolders.splice(0)) {
    for (const pid of readFileSync(join(folder, 'copies'), { encoding: 'utf8', flag: 'a+' }).split('\n').filter((line) => line !== '')) Bun.spawnSync(['kill', '-9', pid])
  }
})

// A machine's folders, its relay login, the cmod that answers its device token and the options `person` sets, and its
// herdr-core (`fakeHc`).
async function machineFor(relay: MemoryRelay, device: Device, person: Record<string, unknown> = {}): Promise<{ readonly env: Record<string, string>; readonly socket: string; readonly folder: string }> {
  const folder = temporaryFolder()
  machineFolders.push(folder)
  const home = join(folder, 'home')
  mkdirSync(join(folder, 'tmp'), { recursive: true })
  // where Claude Code keeps the record of each session it runs, and its transcripts
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
  script(join(folder, 'bin', 'hc'), fakeHc(folder))
  const env = {
    // the machine's own programs, such as its herdr-core, come first
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
    // where the user's systemd listens on Linux, which systemd gives every user service, as each `hc run` runs in a scope
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

// Runs `anyhost serve` on the machine and answers the first line it printed, the program, and what it logged so far,
// which goes on to the test's own errors too.
async function serveOn(env: Record<string, string>): Promise<{ readonly address: string; readonly child: Subprocess; readonly logged: () => string }> {
  const child = Bun.spawn(['bun', CLI, 'serve'], { env, stdout: 'pipe', stderr: 'pipe' })
  children.push(child)
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

// Runs the anyhost command `args` on the machine with `input` typed into its terminal, and answers its exit code and
// what it printed.
async function anyhostOn(env: Record<string, string>, args: readonly string[], input = ''): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  const child = Bun.spawn(['bun', CLI, ...args], { env, stdin: new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' })
  children.push(child)
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, out, err }
}

test('anyhost join asks the program that answers on this machine, which joins in turn with its forgets', async () => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST)
  const asked: unknown[] = []
  // the program's /join as serve.ts answers it, at the program's own socket
  const program = Bun.serve({
    unix: socket,
    async fetch(request) {
      asked.push({ method: request.method, path: new URL(request.url).pathname, body: await request.json() })
      return Response.json({ url: 'https://anyhost-test-join.parker-labs.workers.dev' })
    },
  })
  try {
    // no relay answers at this link, so only the program's answer joins
    const link = "cmod install heyJordanParker/anyhost --option 'join=http://127.0.0.1:9/v1/join#K7QX2M4W9TPR6ZC3'"
    expect(await anyhostOn(env, ['join', link])).toEqual({ code: 0, out: 'Joined this machine to https://anyhost-test-join.parker-labs.workers.dev\n', err: '' })
    expect(asked).toEqual([{ method: 'POST', path: '/join', body: { link } }])
  } finally {
    await program.stop(true)
  }
})

test('anyhost join joins in its own process when no program answers on this machine', async () => {
  const { env } = await machineFor(await memoryRelay(), HOST)
  const asked: string[] = []
  const relay = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      asked.push(`${request.method} ${new URL(request.url).pathname}`)
      return Response.json({ error: 'invite_unknown', message: 'The relay made no invite with that code. Make a new one with Add a machine.' }, { status: 403 })
    },
  })
  try {
    const { code, err } = await anyhostOn(env, ['join', `http://127.0.0.1:${relay.port}/v1/join#K7QX2M4W9TPR6ZC3`])
    expect({ code, err }).toEqual({ code: 1, err: `http://127.0.0.1:${relay.port} refused to join anyhost-a: The relay made no invite with that code. Make a new one with Add a machine.\n` })
    expect(asked).toEqual(['POST /v1/join'])
  } finally {
    await relay.stop(true)
  }
})

test('anyhost connect asks the program that answers on this machine, prints each line of its run, and answers its question from the terminal', async () => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST)
  const accounts = [{ id: 'a1', name: 'Parker Labs' }, { id: 'a2', name: 'Side Project' }]
  const lines = ['Checking your Cloudflare login', 'Found the bucket anyhost-test in the eu jurisdiction', 'Joined this machine to https://anyhost-test-connect.parker-labs.workers.dev']
  const asked: string[] = []
  // the program's /connect, /connect/account and /status as serve.ts answers them, at the program's own socket
  const program = Bun.serve({
    unix: socket,
    async fetch(request) {
      const { pathname } = new URL(request.url)
      asked.push(`${request.method} ${pathname}${request.method === 'POST' ? ` ${await request.text()}` : ''}`)
      if (pathname === '/connect') return Response.json({ is: 'running', lines: lines.slice(0, 1), accounts })
      if (pathname === '/connect/account') return Response.json({ is: 'running', lines: lines.slice(0, 2) })
      return Response.json({ relay: { url: '', state: 'unjoined', message: '', bucket: '' }, connecting: { is: 'joined', lines } })
    },
  })
  try {
    const { code, out, err } = await anyhostOn(env, ['connect'], '2\n')
    expect({ code, err }).toEqual({ code: 0, err: '' })
    expect(out).toBe(`${lines[0]}\nYour Cloudflare login reaches 2 accounts:\n  1  Parker Labs\n  2  Side Project\nType the number of the account your relay goes in:\n${lines[1]}\n${lines[2]}\n`)
    expect(asked).toEqual(['POST /connect {}', 'POST /connect/account {"id":"a2"}', 'GET /status'])
  } finally {
    await program.stop(true)
  }
})

// The suite missed it: no test ran anyhost doctor beside a program.
test('anyhost doctor beside a program that answers unjoined prints one ✘ line with its one fix, and reads no relay itself', async () => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST)
  rmSync(join(env['XDG_STATE_HOME'] ?? '', 'anyhost', 'relay.json'))
  const message = 'This machine is not joined to your relay, so anyhost keeps what its sessions write and uploads nothing.'
  const status: Status = { device: HOST, relay: { url: '', state: 'unjoined', message, bucket: '' }, pending: 0, uploadEvery: 5, capturedAt: '', problems: [], journalGaps: [] }
  const program = Bun.serve({ unix: socket, fetch: () => Response.json(status) })
  try {
    const { code, out } = await anyhostOn(env, ['doctor'])
    expect(code).toBe(1)
    expect(out.split('\n').filter((line) => line.startsWith('✘'))).toEqual([`✘ The anyhost program at ${socket} uploads nothing: ${message}`])
  } finally {
    await program.stop(true)
  }
})

// A machine whose cmod keeps `join` as its option in Claude Code's settings.json, as cmod does, keeps the secret it
// stores, and logs each option it sets, emptying the options, with no relay login yet.
async function unjoinedWithOption(link: string): Promise<{ readonly env: Record<string, string>; readonly socket: string; readonly folder: string }> {
  const machine = await machineFor(await memoryRelay(), HOST)
  const programs = join(machine.env['XDG_DATA_HOME'] ?? '', 'cmod', 'programs')
  const settings = join(machine.env['CLAUDE_CONFIG_DIR'] ?? '', 'settings.json')
  writeFileSync(settings, JSON.stringify({ join: link }))
  script(
    join(programs, 'cmod'),
    `#!/bin/sh\ncase "$1 $2" in\n  "secret get") cat '${programs}/token' ;;\n  "secret store") cat > '${programs}/token' ;;\n  "options anyhost") printf '{"person":%s}' "$(cat '${settings}')" ;;\n  "option anyhost") echo "$3=$4" >> '${programs}/options-set'; printf '{}' > '${settings}' ;;\n  "device --json") printf '%s' '${JSON.stringify(HOST)}' ;;\n  *) exit 1 ;;\nesac\n`,
  )
  rmSync(join(machine.env['XDG_STATE_HOME'] ?? '', 'anyhost', 'relay.json'))
  return machine
}

test('the option join joins at the program\'s start, running in /status, and one the relay refused empties the option too and stays failed in /status until the machine joins', async () => {
  // a relay that answers the option's invite once the test lets it, refusing it, and takes the next one, and serves
  // nothing else, as the program's connect to it once it joined
  const joins: string[] = []
  const answer = Promise.withResolvers<void>()
  const relay = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/join') return Response.json({ error: 'missing', message: 'The stand-in serves only POST /v1/join.' }, { status: 404 })
      const { invite } = (await request.json()) as { invite: string }
      joins.push(invite)
      if (invite !== 'USED') return Response.json({ relay: 1, protocol: 1, bucket: 'anyhost-test', token: 'token-of-anyhost-a', device: { id: HOST.id, name: HOST.name } })
      await answer.promise
      return Response.json({ error: 'invite_used', message: 'The invite already joined anyhost-c at 2026-11-07T09:00:00.000Z. Make a new one with Add a machine.' }, { status: 403 })
    },
  })
  try {
    const origin = `http://127.0.0.1:${relay.port}`
    const machine = await unjoinedWithOption(`cmod install heyJordanParker/anyhost --option 'join=${origin}/v1/join#USED'`)
    const programs = join(machine.env['XDG_DATA_HOME'] ?? '', 'cmod', 'programs')
    await serveOn(machine.env)
    await until(() => joins.length === 1, 'the join asking the relay')
    expect((await statusOn(machine.socket)).joining).toEqual({ is: 'running' })

    answer.resolve()
    await until(async () => (await statusOn(machine.socket)).joining?.is === 'failed', 'the refused join in /status')
    const refused = await statusOn(machine.socket)
    expect(refused.joining).toEqual({ is: 'failed', error: `${origin} refused to join anyhost-a: The invite already joined anyhost-c at 2026-11-07T09:00:00.000Z. Make a new one with Add a machine.` })
    // the program tries the link no more, so it is no problem the program tries again
    expect(refused.problems.filter((problem) => problem.includes('refused to join'))).toEqual([])
    expect(readFileSync(join(programs, 'options-set'), 'utf8')).toBe('join=\n')
    expect(existsSync(join(programs, 'token'))).toBe(false)

    const joined = await fetch('http://localhost/join', { unix: machine.socket, method: 'POST', body: JSON.stringify({ link: `${origin}/v1/join#FRESH` }) })
    expect(await joined.json()).toEqual({ url: origin })
    expect((await statusOn(machine.socket)).joining).toBeUndefined()
    expect(readFileSync(join(programs, 'token'), 'utf8')).toBe('token-of-anyhost-a')
    expect(joins).toEqual(['USED', 'FRESH'])
  } finally {
    await relay.stop(true)
  }
}, 30_000)

// The suite missed it: the doctor test above had no problem lines, and every line got the same fix.
test('anyhost doctor beside a program whose option join failed prints why and the fix that works, with no claim that the program tries it again', async () => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST)
  rmSync(join(env['XDG_STATE_HOME'] ?? '', 'anyhost', 'relay.json'))
  const refusal = 'https://anyhost.parker-labs.workers.dev refused to join anyhost-a: The invite expired at 2026-11-07T09:10:00.000Z, 10 minutes after it was made. Make a new one with Add a machine.'
  const update = '2026-11-07T09:20:00.000Z relay update: Error: cf is logged in to no Cloudflare account on this machine. Connect Cloudflare logs it in.'
  const status: Status = {
    device: HOST,
    relay: { url: '', state: 'unjoined', message: 'This machine is not joined to your relay, so anyhost keeps what its sessions write and uploads nothing.', bucket: '' },
    pending: 0,
    uploadEvery: 5,
    capturedAt: '',
    problems: [],
    journalGaps: [],
    updateProblem: update,
    joining: { is: 'failed', error: refusal },
  }
  const program = Bun.serve({ unix: socket, fetch: () => Response.json(status) })
  try {
    const { code, out } = await anyhostOn(env, ['doctor'])
    expect(code).toBe(1)
    const lines = out.split('\n')
    const at = lines.indexOf(`✘ The link of the option join joined no relay: ${refusal}`)
    expect(at).toBeGreaterThan(-1)
    expect(lines[at + 1]).toBe(
      '  The program does not try that link again. Add this machine again from /machines on a joined machine, or run anyhost join here with the link anyhost machines --invite prints there.',
    )
    expect(lines[lines.indexOf(`✘ ${update}`) + 1]).toBe('  The program tries the update once a run. Connect Cloudflare in the anyhost mod, or run anyhost connect, which updates the relay with your Cloudflare login.')
    expect(out).not.toContain('tries this again')
  } finally {
    await program.stop(true)
  }
})

// The suite missed it: an outdated relay printed two ✘ lines for one cause, the connection's and its failed update's.
test("anyhost doctor beside a program whose relay is outdated and whose update of it failed prints one ✘ line with the update's fix", async () => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST)
  const message = 'The relay at https://anyhost.parker-labs.workers.dev answers protocol 0, and anyhost 0.9.0 needs 1. Connect Cloudflare again to update the relay.'
  const update = '2026-11-07T09:20:00.000Z relay update: Error: cf is logged in to no Cloudflare account on this machine. Connect Cloudflare logs it in.'
  const status: Status = {
    device: HOST,
    relay: { url: 'https://anyhost.parker-labs.workers.dev', state: 'outdated', message, bucket: 'anyhost' },
    pending: 3,
    uploadEvery: 5,
    capturedAt: '',
    problems: [],
    journalGaps: [],
    updateProblem: update,
  }
  const program = Bun.serve({ unix: socket, fetch: () => Response.json(status) })
  try {
    const { code, out } = await anyhostOn(env, ['doctor'])
    expect(code).toBe(1)
    const problems = out.split('\n').filter((line) => line.startsWith('✘'))
    expect(problems).toEqual([`✘ The anyhost program at ${socket} captures nothing: ${message} Its own update of the relay failed: ${update}`])
    const lines = out.split('\n')
    expect(lines[lines.indexOf(problems[0] ?? '') + 1]).toBe('  The program tries the update once a run. Connect Cloudflare in the anyhost mod, or run anyhost connect, which updates the relay with your Cloudflare login.')
  } finally {
    await program.stop(true)
  }
})

// The suite missed it: right after an upload, while Cloudflare still runs the busy Pool's older code for up to 300 s,
// doctor said to Connect Cloudflare again, where the Step says to wait.
test('anyhost doctor beside a program whose relay is outdated with no failed update says to wait 5 minutes first, then to Connect Cloudflare again', async () => {
  const { env, socket } = await machineFor(await memoryRelay(), HOST)
  const message = 'The relay at https://anyhost.parker-labs.workers.dev answers protocol 0, and anyhost 0.9.0 needs 1. Connect Cloudflare again to update the relay.'
  const status: Status = { device: HOST, relay: { url: 'https://anyhost.parker-labs.workers.dev', state: 'outdated', message, bucket: 'anyhost' }, pending: 3, uploadEvery: 5, capturedAt: '', problems: [], journalGaps: [] }
  const program = Bun.serve({ unix: socket, fetch: () => Response.json(status) })
  try {
    const { code, out } = await anyhostOn(env, ['doctor'])
    expect(code).toBe(1)
    const lines = out.split('\n')
    expect(lines[lines.indexOf(`✘ The anyhost program at ${socket} captures nothing: ${message}`) + 1]).toBe(
      '  Wait 5 minutes first: after an upload of the relay, from this machine or another, Cloudflare runs its older version for up to 5 minutes, and the program connects again within a minute. If this line is still here then, Connect Cloudflare again in the anyhost mod, or run anyhost connect, which updates the relay.',
    )
  } finally {
    await program.stop(true)
  }
})

// The suite missed it: anyhost doctor read Cloudflare's daily limit as a relay that did not answer, and said to check
// the internet.
test("anyhost doctor with no program reads the relay's 429 error code: 1027 as Cloudflare's daily limit, which resets at 00:00 UTC", async () => {
  const relay = await memoryRelay()
  const { env } = await machineFor(relay, HOST)
  relay.dailyLimited = Infinity
  const { code, out } = await anyhostOn(env, ['doctor'])
  expect(code).toBe(1)
  const lines = out.split('\n')
  expect(lines[lines.indexOf(`✘ ${DAILY_LIMIT}`) + 1]).toBe('  Wait until 00:00 UTC. The program keeps every change meanwhile and uploads it once the relay answers.')
  expect(out).not.toContain('did not answer')
})

test('a second serve on one state folder refuses to start, naming the one that runs, a POST of no JSON answers 400, and one to no route 404', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  await serveOn(host.env)
  const second = Bun.spawn(['bun', CLI, 'serve'], { env: host.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(second)
  expect(await second.exited).toBe(1)
  expect(await new Response(second.stderr).text()).toContain(`The anyhost program of ${HOST.name} already answers at ${host.socket}, so this one does not start.`)
  // the first one still answers
  const answer = await fetch('http://localhost/machines/invite', { unix: host.socket, method: 'POST', body: 'not json' })
  expect(answer.status).toBe(400)
  expect(((await answer.json()) as { message: string }).message).toStartWith('anyhost takes a JSON object at POST /machines/invite, and this body is none:')
  // an unknown route answers JSON as every other refusal does, naming every route the program serves
  const unknown = await fetch('http://localhost/machines/rename', { unix: host.socket, method: 'POST', body: '{}' })
  expect(unknown.status).toBe(404)
  expect(await unknown.json()).toEqual({
    message: 'anyhost serves GET /status, /machines, /agents and /claims/<session>, POST /connect, /connect/account, /connect/r2, /join, /machines/add, /machines/invite, /machines/remove, /move, /move/keep, /new, /agents/tell, /agents/take, /agents/settle and /settings, not POST /machines/rename.',
  })
})

test("the program's start stats every captured file, and uploads a line a quiet session gained while the program did not run", async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  const home = host.env['HOME'] ?? ''
  const transcript = join(home, '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  const line = (text: string): string => `{"type":"user","message":{"role":"user","content":"${text}"},"sessionId":"${SESSION}"}\n`
  writeFileSync(transcript, line('Plan the trip'))
  // an earlier run of the program captured the session an hour ago, and left no heartbeat to catch up from
  const db = openDatabase(join(host.env['XDG_STATE_HOME'] ?? '', 'anyhost'))
  const capture = openCapture(relay.connect(HOST, roots(home)), HOST, roots(home), { db, code: noCode })
  await welcomed(capture.relay)
  setSystemTime(new Date(Date.now() - 60 * 60_000))
  await Promise.all(uploadSessions(capture, [{ session: SESSION, tool: 'claude', paths: new Set([transcript]) }], failTest).map(([, left]) => left))
  setSystemTime()
  const end = journalOf(db, SESSION)?.end ?? 0
  capture.relay.close()
  db.close()
  appendFileSync(transcript, line('Book the train'))

  await serveOn(host.env)
  await until(() => relay.puts.some(({ key }) => key === hotKey(SESSION, end)), 'the line uploaded')
  const frame = relay.puts.find(({ key }) => key === hotKey(SESSION, end))?.body ?? new Uint8Array()
  expect(decoder.decode(decompress(frame))).toEndWith(line('Book the train'))
  // the queue drains every 5 seconds
}, 20_000)

const OTHER_SESSION = '22222222-3333-4444-5555-666666666666'
// Whether a frame R2 holds of the session's journal carries `text`.
const isUploaded = (relay: MemoryRelay, session: string, text: string): boolean =>
  relay.puts.some(({ key, body }) => key.startsWith(`journals/${session}/hot/`) && decoder.decode(decompress(body)).includes(text))
const problemsOn = async (socket: string): Promise<readonly string[]> => (await statusOn(socket)).problems
// The heartbeat of a run of the program an hour ago, which the program's start hears every file written since.
const ranAnHourAgo = (machine: { readonly env: Record<string, string> }): void => {
  const heartbeat = join(machine.env['XDG_STATE_HOME'] ?? '', 'anyhost', 'heartbeat')
  writeFileSync(heartbeat, '')
  const hourAgo = new Date(Date.now() - 60 * 60_000)
  utimesSync(heartbeat, hourAgo, hourAgo)
}

// The suite missed it: no test made a watch hang, as only macOS's fseventsd hangs one, for minutes at a time.
test("a program whose watcher hangs at its start names the stall in /status, backs up a captured session's line and a new session within one backup pass, and ends at SIGTERM within 5 s", async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  const transcriptOf = (session: string): string => join(host.env['HOME'] ?? '', '.claude', 'projects', '-work', `${session}.jsonl`)
  const line = (session: string, text: string): string => `{"type":"user","message":{"role":"user","content":"${text}"},"sessionId":"${session}"}\n`
  ranAnHourAgo(host)
  mkdirSync(dirname(transcriptOf(SESSION)), { recursive: true })
  writeFileSync(transcriptOf(SESSION), line(SESSION, 'Plan the trip'))

  const served = await serveOn({ ...host.env, ANYHOST_WATCHER_HANGS: '1' })
  await until(async () => (await problemsOn(host.socket)).some((problem) => problem.includes(" watcher: Error: anyhost's watcher heard none of its watches 10 s after its start, as while macOS's fseventsd takes no new watcher")), 'the stall in /status', 30_000)
  await until(() => isUploaded(relay, SESSION, 'Plan the trip'), 'the session the start captured uploaded', 30_000)
  appendFileSync(transcriptOf(SESSION), line(SESSION, 'Book the train'))
  writeFileSync(transcriptOf(OTHER_SESSION), line(OTHER_SESSION, 'Pack the bags'))
  // the next backup pass starts 60 s after the one before
  await until(() => isUploaded(relay, SESSION, 'Book the train') && isUploaded(relay, OTHER_SESSION, 'Pack the bags'), 'the line and the new session uploaded', 75_000)

  const watchersOf = (pid: number): number[] => Bun.spawnSync(['pgrep', '-P', String(pid), '-f', 'ANYHOST_WATCHER_HANGS']).stdout.toString().split('\n').filter((found) => found !== '').map(Number)
  await until(() => watchersOf(served.child.pid).length > 0, 'a hung watcher')
  const [watcher = 0] = watchersOf(served.child.pid)
  const signalled = Date.now()
  served.child.kill('SIGTERM')
  await served.child.exited
  expect(Date.now() - signalled).toBeLessThan(5000)
  expect(served.child.signalCode).toBe('SIGTERM')
  await until(() => !isAlive(watcher), 'the hung watcher ending with the program', 5000)
}, 150_000)

test('a watcher that exits is a problem in /status until the one started after it is ready, which hears a new session', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  const transcript = join(host.env['HOME'] ?? '', '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  // each watcher writes its pid to `watcher` in the state folder until it hears that write
  const probe = join(host.env['XDG_STATE_HOME'] ?? '', 'anyhost', 'watcher')
  const watcherPid = (): number => (existsSync(probe) ? Number(readFileSync(probe, 'utf8')) || 0 : 0)
  const served = await serveOn(host.env)
  await until(() => watcherPid() > 0, 'the watcher')
  const first = watcherPid()
  expect(Bun.spawnSync(['pgrep', '-P', String(served.child.pid)]).stdout.toString().split('\n')).toContain(String(first))

  process.kill(first, 'SIGKILL')
  await until(async () => (await problemsOn(host.socket)).some((problem) => problem.includes(" watcher: Error: anyhost's watcher exited with SIGKILL, so each backup pass lists the watched folders")), 'the exit in /status')
  await until(async () => !(await problemsOn(host.socket)).some((problem) => problem.includes(' watcher: ')), 'the problem leaving')
  expect(watcherPid()).not.toBe(first)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
  // heard by the new watcher, as the backup pass after the start's lists it no sooner than 60 s after the start
  await until(() => isUploaded(relay, SESSION, 'Plan the trip'), 'the new session uploaded', 30_000)
}, 60_000)

const isWatcherProblem = (problem: string): boolean => problem.includes(' watcher: ')

// The suite missed it: no test removed a watched folder while the program ran. Bun's watch on Linux names the removal
// of a folder it watches with every level with no name, which the watcher could not join and died at, and hears
// nothing of a folder made again where it watched.
test('a watched folder removed and made again while the program runs is watched again: a file written in the new one uploads within one backup pass, and /status names no watcher problem', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  // Claude Code's temp root, whose folder above it no watch hears
  const tempRoot = join(realpathSync(host.env['CLAUDE_CODE_TMPDIR'] ?? ''), `claude-${process.getuid?.() ?? 0}`)
  mkdirSync(tempRoot, { recursive: true })
  await serveOn(host.env)
  // a session the watcher heard, so it is ready
  const transcript = join(host.env['HOME'] ?? '', '.claude', 'projects', '-work', `${OTHER_SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${OTHER_SESSION}"}\n`)
  await until(() => isUploaded(relay, OTHER_SESSION, 'Plan the trip'), 'the session the watcher heard uploaded', 30_000)

  rmSync(tempRoot, { recursive: true })
  await Bun.sleep(1000)
  const output = join(tempRoot, '-work', SESSION, 'tasks', 'trip.output')
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, 'Booked the train\n')
  const watcherProblems = new Set<string>()
  // the next backup pass starts 60 s after the one before
  await until(
    async () => {
      for (const problem of (await problemsOn(host.socket)).filter(isWatcherProblem)) watcherProblems.add(problem)
      return isUploaded(relay, SESSION, 'Booked the train')
    },
    'the output in the new folder uploaded',
    75_000,
  )
  expect([...watcherProblems]).toEqual([])
}, 120_000)

// The suite missed it: every folder a test's watcher watched was there to watch, while Bun's watch() throws at a
// folder gone since the program found it, which ended each watcher at its start.
test('a watched folder the watcher cannot watch at its start, as one removed after the program found it, costs only that folder, and the watcher gets ready and hears a new session', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  // a folder its user may not list, which Bun's watch() on Linux throws at with EACCES, as it throws ENOENT at a folder
  // gone by then
  const plans = join(host.env['HOME'] ?? '', '.claude', 'plans')
  mkdirSync(plans)
  chmodSync(plans, 0)
  try {
    await serveOn(host.env)
    // past the listing of the program's start
    await Bun.sleep(3000)
    const transcript = join(host.env['HOME'] ?? '', '.claude', 'projects', '-work', `${SESSION}.jsonl`)
    mkdirSync(dirname(transcript), { recursive: true })
    writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
    // heard by the watcher, as the backup pass after the start's lists it no sooner than 60 s after the start
    await until(() => isUploaded(relay, SESSION, 'Plan the trip'), 'the new session uploaded', 30_000)
    expect((await problemsOn(host.socket)).filter(isWatcherProblem)).toEqual([])
  } finally {
    chmodSync(plans, 0o755)
  }
}, 60_000)

// The suite missed it: a folder the watcher could not watch still counted as one it heard, so no backup pass listed it,
// and a file written there waited for the hourly sweep.
test('a watched folder the watcher lost at its start is listed by the next backup pass, which uploads a session written there', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  const sessionEnv = join(host.env['HOME'] ?? '', '.claude', 'session-env')
  mkdirSync(sessionEnv)
  // Bun's watch() on Linux throws EACCES at a folder its user may not list
  chmodSync(sessionEnv, 0)
  try {
    const served = await serveOn(host.env)
    await until(() => served.logged().includes(`anyhost hears no change in a folder under ${sessionEnv}`), 'the watch failing')
    // past the program's first backup pass, its full sweep, and the listing as the watcher got ready
    await Bun.sleep(3000)
  } finally {
    chmodSync(sessionEnv, 0o755)
  }
  const hook = join(sessionEnv, SESSION, 'sessionstart-hook-0.sh')
  mkdirSync(dirname(hook))
  writeFileSync(hook, 'export TRIP=train\n')
  // the next backup pass starts 60 s after the one before
  await until(() => isUploaded(relay, SESSION, 'export TRIP=train'), 'the file in the lost folder uploaded', 75_000)
}, 120_000)

// The suite missed it: every watcher a test ran heard each write, while macOS's watcher drops events with no word of
// it, and a full sweep statted only the files the program captured, so no sweep found a file no event named.
test('a file written in a watched folder while the watcher hears nothing is uploaded by the next full sweep', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  // The program's first backup pass, its first full sweep, comes after it read the options, which wait for the test.
  const cmod = join(host.env['XDG_DATA_HOME'] ?? '', 'cmod', 'programs', 'cmod')
  const release = join(host.folder, 'release')
  writeFileSync(cmod, readFileSync(cmod, 'utf8').replace('"options anyhost")', `"options anyhost") while [ ! -e '${release}' ]; do sleep 0.1; done;`))
  ranAnHourAgo(host)
  await serveOn({ ...host.env, ANYHOST_WATCHER_DROPS: '1' })
  // past the watcher getting ready and the listing that follows it
  await Bun.sleep(3000)
  expect((await problemsOn(host.socket)).filter(isWatcherProblem)).toEqual([])
  const transcript = join(host.env['HOME'] ?? '', '.claude', 'projects', '-work', `${SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `{"type":"user","message":{"role":"user","content":"Plan the trip"},"sessionId":"${SESSION}"}\n`)
  // a watcher that heard it would have queued it by now
  await Bun.sleep(1000)
  writeFileSync(release, '')
  await until(() => isUploaded(relay, SESSION, 'Plan the trip'), 'the session the full sweep found uploaded', 30_000)
}, 60_000)

test('a listing of the watched folders and of a session\'s files follows no symlink, so a cycle leaves the other files listed, and the log names a folder it cannot read once', async () => {
  const relay = await memoryRelay()
  const host = await machineFor(relay, HOST)
  const home = host.env['HOME'] ?? ''
  // Claude Code's temp root, where a background task of the session wrote its output while the program did not run,
  // beside a scratchpad that holds a symlink cycle and a folder only its owner may list
  const sessionFolder = join(realpathSync(host.env['CLAUDE_CODE_TMPDIR'] ?? ''), `claude-${process.getuid?.() ?? 0}`, '-work', SESSION)
  mkdirSync(join(sessionFolder, 'tasks'), { recursive: true })
  mkdirSync(join(sessionFolder, 'scratchpad'), { recursive: true })
  symlinkSync('loop', join(sessionFolder, 'scratchpad', 'loop'))
  const locked = join(sessionFolder, 'locked')
  mkdirSync(locked)
  chmodSync(locked, 0)
  // A subagent's transcript of the session, older than the heartbeat, so only the first capture of the session, which
  // reads every file of it from byte 0, finds it, beside another symlink cycle
  const subagents = join(home, '.claude', 'projects', '-work', SESSION, 'subagents')
  mkdirSync(subagents, { recursive: true })
  symlinkSync('loop', join(subagents, 'loop'))
  const subagent = join(subagents, 'agent-a1.jsonl')
  writeFileSync(subagent, `{"type":"user","message":{"role":"user","content":"Find the trains"},"sessionId":"${SESSION}"}\n`)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000)
  utimesSync(subagent, twoHoursAgo, twoHoursAgo)
  mkdirSync(join(home, '.codex'), { recursive: true })
  ranAnHourAgo(host)
  writeFileSync(join(sessionFolder, 'tasks', 'trip.output'), 'Booked the train\n')
  try {
    const served = await serveOn(host.env)
    await until(() => isUploaded(relay, SESSION, 'Booked the train'), 'the output the start listed uploaded', 30_000)
    await until(() => isUploaded(relay, SESSION, 'Find the trains'), "the subagent's transcript the session's first capture found uploaded", 30_000)
    // Codex makes `sessions/` while the program runs, so a new watcher starts, and the listing as it gets ready reads
    // every watched folder again, the temp root before Codex's sessions
    const rollout = join(home, '.codex', 'sessions', '2026', '11', '07', `rollout-2026-11-07T09-00-00-${OTHER_SESSION}.jsonl`)
    mkdirSync(dirname(rollout), { recursive: true })
    writeFileSync(rollout, `{"type":"session_meta","payload":{"id":"${OTHER_SESSION}","cwd":"/work"}}\n`)
    await until(() => isUploaded(relay, OTHER_SESSION, 'session_meta'), 'the rollout in the new folder uploaded', 30_000)

    expect(served.logged().split('\n').filter((logged) => logged.includes(`anyhost lists no file in ${locked}: EACCES`))).toHaveLength(1)
  } finally {
    chmodSync(locked, 0o755)
  }
}, 60_000)

test("a program whose relay Cloudflare refuses for the daily limit names the limit and its reset at 00:00 UTC in /status", async () => {
  const relay = await memoryRelay()
  relay.dailyLimited = Infinity
  const host = await machineFor(relay, HOST)
  await serveOn(host.env)
  await until(async () => (await statusOn(host.socket)).relay.state === 'offline', 'the refused connect')

  expect((await statusOn(host.socket)).relay).toMatchObject({ state: 'offline', message: DAILY_LIMIT })
})

const LAPTOP: Device = { id: 'device-laptop', name: 'anyhost-b', os: 'linux', arch: 'arm64' }
const WORKER: Device = { id: 'device-worker', name: 'anyhost-a', os: 'linux', arch: 'arm64' }
const logOf = (folder: string, name: string): string[] => readFileSync(join(folder, name), { encoding: 'utf8', flag: 'a+' }).split('\n').filter((line) => line !== '')
// Each terminal the machine's herdr-core ran a session in: when, in which folder, the session, and its Claude Code command.
const runsOn = (folder: string): { readonly at: number; readonly cwd: string; readonly session: string; readonly command: string }[] =>
  logOf(folder, 'hc.log').map((line) => {
    const [at = '', cwd = '', session = '', ...command] = line.split(' ')
    return { at: Number(at), cwd, session, command: command.join(' ') }
  })
// The session the machine's herdr-core started first, or '' before any.
const startedOn = (machine: { readonly folder: string }): string => runsOn(machine.folder)[0]?.session ?? ''
// The pid of each copy of a session the machine's herdr-core runs, and whether it still runs.
const copiesOn = (folder: string): { readonly pid: number; readonly isRunning: boolean }[] =>
  logOf(folder, 'copies').map((line) => ({ pid: Number(line), isRunning: Bun.spawnSync(['kill', '-0', line]).exitCode === 0 }))

type Moved = { readonly to: string; readonly step: string; readonly line: string }
type Claimed = { readonly machine?: string; readonly move?: Moved }
const claimOn = async (socket: string, session = SESSION): Promise<Claimed> => (await (await fetch(`http://localhost/claims/${session}`, { unix: socket })).json()) as Claimed
const postTo = async (socket: string, path: string, body: object): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> => {
  const answer = await fetch(`http://localhost${path}`, { unix: socket, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> }
}
// Each step the laptop's program showed of the session's move, in order, after the steps the test read already, until
// it reached `until`.
async function stepsOf(socket: string, until: ReadonlySet<string> = new Set(['moved', 'failed']), read: readonly string[] = []): Promise<{ readonly steps: string[]; readonly last: Moved }> {
  const steps = [...read]
  for (const started = Date.now(); Date.now() - started < 30_000; await Bun.sleep(10)) {
    const { move } = await claimOn(socket)
    if (move === undefined) continue
    if (steps.at(-1) !== move.step) steps.push(move.step)
    if (until.has(move.step)) return { steps, last: move }
  }
  throw new Error(`The move showed ${steps.join(', ')} and reached none of ${[...until].join(', ')} within 30 s.`)
}

// The machine SESSION runs on, its Claude Code's process `claude`, and its program, `child`, captured it, with the
// options `person` sets, and what the program logged so far. The session works in `work` in the machine's home, which
// holds one file.
async function runningOn(relay: MemoryRelay, device = LAPTOP, person: Record<string, unknown> = {}, argv: string[] = ['sleep', '600']) {
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
  children.push(claude)
  // Claude Code rewrites the session's record at each change of its status
  const status = (value: string): void => writeFileSync(join(home, '.claude', 'sessions', `${claude.pid}.json`), JSON.stringify({ pid: claude.pid, sessionId: SESSION, kind: 'interactive', cwd, status: value }))
  status('idle')
  // the first drain at the default 5 seconds claims the session
  await until(async () => (await relay.claims()).get(SESSION) === device.id, 'the machine claiming the session', 15_000)
  return { ...laptop, cwd, transcript, claude, status, child, logged }
}

async function workerOn(relay: MemoryRelay, prepare: (folder: string) => void = () => undefined, device = WORKER) {
  const worker = await machineFor(relay, device)
  prepare(worker.folder)
  const served = await serveOn(worker.env)
  await until(() => relay.isConnected(device.id), 'the machine connecting')
  return { ...worker, ...served }
}

test('a move waits for the turn to end, uploads and seals the session, the worker restores it and runs it in a terminal of herdr-core with the same command, and only then the laptop\'s Claude Code ends', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  laptop.status('busy')

  const asked = await postTo(laptop.socket, '/move', { session: SESSION.slice(0, 8), machine: WORKER.name })
  expect(asked.status).toBe(200)
  expect(asked.body).toMatchObject({ session: SESSION, to: WORKER.name })
  // the turn runs on, and the move waits for it
  await Bun.sleep(500)
  const waiting = (await claimOn(laptop.socket)).move
  expect(waiting).toEqual({ to: WORKER.name, step: 'waiting', line: `Waiting for ${SESSION.slice(0, 8)} to finish its turn.` })
  laptop.status('idle')
  // the steps from the one read while the turn ran, as the program may have gone past it before the next read
  const { steps, last } = await stepsOf(laptop.socket, undefined, [waiting?.step ?? ''])

  expect(steps).toEqual(['waiting', 'uploading', 'moving', 'moved'])
  expect(last.line).toMatch(new RegExp(`^${WORKER.name} restored ${SESSION.slice(0, 8)} in \\d+\\.\\d s and runs it\\.$`))
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  expect((await relay.keys(`journals/${SESSION}/`)).every((key) => key.includes('/sealed/'))).toBe(true)
  // the worker continues the session in its own home, with its transcript and its working folder's file
  const workerHome = worker.env['HOME'] ?? ''
  const workerCwd = join(workerHome, 'work')
  expect(readFileSync(join(workerCwd, 'notes.txt'), 'utf8')).toBe('the plan for the trip\n')
  expect(readFileSync(join(workerHome, '.claude', 'projects', workerCwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`), 'utf8')).toContain(`"cwd":"${workerCwd}"`)
  const [started, ...more] = runsOn(worker.folder)
  expect(more).toEqual([])
  expect(started).toMatchObject({ session: SESSION, command: 'claude' })
  expect(realpathSync(started?.cwd ?? '')).toBe(realpathSync(workerCwd))
  // the laptop's Claude Code ended after the worker ran the session
  await laptop.claude.exited
  expect(laptop.claude.signalCode).toBe('SIGTERM')
  expect(await claimOn(laptop.socket)).toMatchObject({ machine: WORKER.name, move: { step: 'moved' } })
}, 60_000)

test('a move of a session whose first frame R2 lost uploads its files whole again, and the worker restores every byte', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"Book the train"}}\n`, { flag: 'a' })
  await until(() => relay.puts.some(({ key, body }) => key.includes('/hot/') && decoder.decode(decompress(body)).includes('Book the train')), 'the second line uploading', 15_000)
  await relay.objects.delete(hotKey(SESSION, 0))
  const worker = await workerOn(relay)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  expect(await relay.keys(`journals/${SESSION}/hot/`)).toEqual([])
  const workerHome = worker.env['HOME'] ?? ''
  const workerCwd = join(workerHome, 'work')
  const restored = readFileSync(join(workerHome, '.claude', 'projects', workerCwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`), 'utf8')
  expect(restored).toBe(readFileSync(laptop.transcript, 'utf8').replaceAll(laptop.env['HOME'] ?? '', workerHome))
  expect(readFileSync(join(workerCwd, 'notes.txt'), 'utf8')).toBe('the plan for the trip\n')
}, 60_000)

test('a move to a machine that is offline keeps the session running here, with its claim', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await relay.join(WORKER, roots('/home/worker'))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.line).toBe(`${WORKER.name} is offline, so the session keeps running here.`)
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
}, 60_000)

// The suite missed it: every worker a move or start test took offline stayed down, while a program that restarts
// within the 10 s between two checks of its connection reads as connected at both, and its wait for the move died
// with it.
test('a move to a worker whose program restarts before its Claude Code ran the session runs again there at the laptop\'s next repeat, and reaches moved', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  // its first Claude Code starts the session past the end of the test
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'hang'), '60'))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  // The first herdr-core sleeps out the hang it read, so the one the restarted program runs starts at once. Its log
  // line comes a moment before it reads the hang, so the hang goes only once it sleeps.
  const isHanging = (): boolean => {
    const [first = ''] = Bun.spawnSync(['pgrep', '-f', `${worker.folder}/bin/hc run`]).stdout.toString().trim().split('\n')
    return first !== '' && Bun.spawnSync(['pgrep', '-P', first, '-x', 'sleep']).exitCode === 0
  }
  await until(isHanging, 'the worker\'s first herdr-core hanging', 30_000)
  worker.child.kill('SIGKILL')
  rmSync(join(worker.folder, 'hang'))
  const killedAt = Date.now()
  await serveOn(worker.env)
  await until(() => relay.isConnected(WORKER.id), 'the worker connecting again')
  const { last } = await stepsOf(laptop.socket)

  // the checks 10 s apart, the worker's restart, and its run of the move
  expect(Date.now() - killedAt).toBeLessThan(40_000)
  expect(last.step).toBe('moved')
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  expect(runsOn(worker.folder).filter((run) => run.session === SESSION)).toHaveLength(2)
  await laptop.claude.exited
  expect(laptop.claude.signalCode).toBe('SIGTERM')
}, 90_000)

// The suite missed it: every worker that heard `released` for a session was the program that started its job, while a
// program that restarted since knew nothing of the job its earlier run started.
test("a worker program restarted after it opened a terminal for a move stops that copy at the session's released, once its turn ends", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  // its herdr-core starts the session past the end of the test
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'hang'), '60'))
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await until(() => runsOn(worker.folder).some((run) => run.session === SESSION), 'the worker starting the session', 30_000)
  worker.child.kill('SIGKILL')
  // the terminal the earlier program opened runs the session, in a turn
  const job = Bun.spawn(['sleep', '600'])
  children.push(job)
  const workerHome = worker.env['HOME'] ?? ''
  const record = (status: string): void =>
    writeFileSync(join(workerHome, '.claude', 'sessions', `${job.pid}.json`), JSON.stringify({ pid: job.pid, sessionId: SESSION, kind: 'interactive', cwd: join(workerHome, 'work'), status }))
  record('busy')
  const stops = (): string[] => (job.signalCode === 'SIGTERM' ? ['stopped'] : [])

  // the move waits for the worker, which holds the session, and Keep it here takes the session back while it is down
  await until(async () => (await claimOn(laptop.socket)).move?.line.includes(' does not answer. ') === true, 'the move saying the worker does not answer', 30_000)
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)
  await serveOn(worker.env)
  await until(() => relay.isConnected(WORKER.id), 'the worker connecting again')
  await until(async () => (await claimOn(worker.socket)).machine === LAPTOP.name, 'the worker hearing it lost the session')
  await Bun.sleep(1000)
  const stopsInTurn = stops()
  record('idle')
  await until(() => stops().length > 0, 'the worker stopping the job once its turn ended')

  expect(last.line).toBe(`${WORKER.name} did not answer, so the session keeps running here.`)
  expect(stopsInTurn).toEqual([])
  expect(stops()).toHaveLength(1)
}, 90_000)

// The suite missed it: every worker program that restarted during a move had run no job of the session, and the
// laptop's ask ended at the restart, so no repeat of a move reached a program that forgot it while the session ran there.
test("a worker whose program restarts after it opened a terminal for a move, before the laptop heard moved, answers the laptop's repeat with moved and never stops or restores the copy", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  // the worker's moved never leaves the worker's socket
  const held = relay.holdNext('moved')
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await held
  worker.child.kill('SIGKILL')
  await worker.child.exited
  // the terminal the earlier program opened runs on past that program's end
  const [copy] = copiesOn(worker.folder)
  const restarted = await serveOn(worker.env)
  const { last } = await stepsOf(laptop.socket)
  await laptop.claude.exited
  // a stop of the job would come at once, as its record says idle
  await Bun.sleep(2000)

  expect(last.step).toBe('moved')
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  expect(restarted.logged()).toContain(`${LAPTOP.name} asked again for its move of ${SESSION}`)
  expect(restarted.logged()).not.toContain(`moves ${SESSION} here.`)
  expect(runsOn(worker.folder)).toHaveLength(1)
  expect(copiesOn(worker.folder)).toEqual([{ pid: copy?.pid ?? 0, isRunning: true }])
}, 90_000)

test('a move the worker cannot take takes the claim back, and the laptop captures the session again', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'fail'), 'Claude Code is not logged in.'))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.line).toStartWith(`${WORKER.name} could not take the session: `)
  expect(last.line).toContain('Claude Code is not logged in.')
  expect(last.line).toEndWith('. It keeps running here.')
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  await until(async () => (await claimOn(worker.socket)).machine === LAPTOP.name, 'the worker hearing it lost the session')
  expect(laptop.claude.exitCode).toBeNull()
  // the session's next line goes up from the laptop
  const frames = relay.puts.filter(({ key }) => key.startsWith(`journals/${SESSION}/hot/`)).length
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`, { flag: 'a' })
  await until(() => relay.puts.filter(({ key }) => key.startsWith(`journals/${SESSION}/hot/`)).length > frames, 'the next line uploading', 15_000)
}, 60_000)

// The suite missed it: a move to mac-studio stranded its session there, held and running nowhere, as cmod set the
// laptop's program up again during the move, and the program that started after it knew of no move to take back.
test('a move the worker cannot take after the laptop program restarted takes the session back, and the laptop runs it', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  // the worker takes the claim, then its herdr-core waits 8 s and fails
  const worker = await workerOn(relay, (folder) => {
    writeFileSync(join(folder, 'hang'), '8')
    writeFileSync(join(folder, 'fail'), 'Claude Code is not logged in.')
  })

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await until(async () => (await relay.claims()).get(SESSION) === WORKER.id, 'the worker taking the claim', 30_000)
  laptop.child.kill('SIGKILL')
  const restarted = await serveOn(laptop.env)
  await until(() => worker.logged().includes(`could not take ${SESSION} from ${LAPTOP.name}`), 'the worker failing the move', 30_000)
  await until(async () => (await relay.claims()).get(SESSION) === LAPTOP.id, 'the laptop taking the session back', 30_000)
  const tookBack = `${WORKER.name} could not take ${SESSION} in a move this program forgot, so ${LAPTOP.name} took it back and runs it`
  // the program says so once Claude Code runs the session there
  await until(() => restarted.logged().includes(tookBack), 'the laptop running the session', 30_000)

  expect(runsOn(laptop.folder).some((run) => run.session === SESSION)).toBe(true)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
}, 90_000)

test('a move to a worker that took the claim and answers nothing waits for it, and Keep it here takes the session back', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const silent = relay.connect(WORKER, roots('/home/worker'))
  // the claim's answer may still be on its way when the test cuts the worker off, so its failure is the test's to drop
  silent.on('move', ({ session }) => {
    for (const ran of silent.run([{ op: 'claim', session, take: true }])) ran.catch(() => undefined)
  })
  await welcomed(silent)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await stepsOf(laptop.socket, new Set(['moving']))
  await until(async () => (await relay.claims()).get(SESSION) === WORKER.id, 'the worker taking the claim')
  await until(async () => (await claimOn(laptop.socket)).machine === WORKER.name, 'the laptop hearing it')
  expect((await claimOn(laptop.socket)).move?.step).toBe('moving')
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `${WORKER.name} did not answer, so the session keeps running here.` })
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
}, 60_000)

// The suite missed it: every worker that took the claim and answered nothing stayed connected, so no move met an
// `offline` from a machine that may run the session already.
test('a move to a worker that took the claim and then goes offline waits, saying so in its line and in anyhost move, which Ctrl-C leaves running, and Keep it here takes the session back', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const silent = relay.connect(WORKER, roots('/home/worker'))
  // the claim's answer may still be on its way when the test cuts the worker off, so its failure is the test's to drop
  silent.on('move', ({ session }) => {
    for (const ran of silent.run([{ op: 'claim', session, take: true }])) ran.catch(() => undefined)
  })
  await welcomed(silent)
  const waiting = `${WORKER.name} took ${SESSION.slice(0, 8)} and does not answer. Keep it here takes the session back.`

  const moving = Bun.spawn(['bun', CLI, 'move', SESSION.slice(0, 8), WORKER.name], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(moving)
  let printed = ''
  const reading = (async () => {
    for await (const chunk of moving.stdout) printed += decoder.decode(chunk)
  })()
  await until(async () => (await relay.claims()).get(SESSION) === WORKER.id, 'the worker taking the claim', 30_000)
  relay.disconnect(WORKER.id)
  await until(async () => (await claimOn(laptop.socket)).move?.line === waiting, 'the move saying the worker does not answer', 30_000)
  // the move goes on waiting through the next checks of the worker's connection
  await Bun.sleep(12_000)
  expect((await claimOn(laptop.socket)).move).toEqual({ to: WORKER.name, step: 'moving', line: waiting })
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  await until(() => printed.includes(`${waiting}\n`), 'anyhost move printing the line')
  moving.kill('SIGINT')
  const [code] = await Promise.all([moving.exited, reading])
  expect(code).toBe(130)
  expect(printed.trimEnd().split('\n').at(-1)).toBe(`The move of ${SESSION.slice(0, 8)} to ${WORKER.name} goes on. Keep it here in the session takes the session back.`)
  expect((await claimOn(laptop.socket)).move?.step).toBe('moving')
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `${WORKER.name} did not answer, so the session keeps running here.` })
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
}, 90_000)

// The suite missed it: every worker of a move that failed after it took the claim wrote nothing to the session, so no
// frame of the worker's ever waited at the laptop's end, where the laptop's next frame met it as a fork.
test("Keep it here after a moved the laptop never heard, from a worker that ran the session and wrote to it, leaves the laptop taking the next prompt and capturing it with no fork, and stops the worker's copy", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  // the worker's resume re-appends the session's metadata, and its Claude Code lists the session running once the
  // worker uploaded that
  const worker = await workerOn(relay, (folder) => {
    writeFileSync(join(folder, 'appends'), `{"type":"permission-mode","permissionMode":"default","sessionId":"${SESSION}"}\n`)
    writeFileSync(join(folder, 'unlisted'), '')
  })
  const held = relay.holdNext('moved')

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await until(() => isUploaded(relay, SESSION, '"permission-mode"'), 'the worker uploading what its resume wrote', 30_000)
  rmSync(join(worker.folder, 'unlisted'))
  // the worker runs the session and answers, and the relay holds the answer
  const release = await held
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)
  await until(() => copiesOn(worker.folder).some((copy) => !copy.isRunning), 'the worker stopping its copy as the laptop took the session back')
  release()

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `${WORKER.name} did not answer, so the session keeps running here.` })
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  // the laptop's next prompt goes up from the laptop, past what the worker wrote
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`, { flag: 'a' })
  await until(() => isUploaded(relay, SESSION, 'And the hotel'), 'the next prompt uploading', 15_000)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.logged()).not.toContain('Another machine wrote byte')
  expect(laptop.claude.exitCode).toBeNull()
}, 90_000)

// The suite missed it: every Keep it here a test pressed came once the worker held the claim or was gone, so no take
// the laptop gave up on reached the Pool after the laptop took the session back, where it took the session anyway.
test("Keep it here before the worker's take lands keeps the session with the laptop once that take comes, starts no copy on the worker, and the laptop takes the next prompt", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  // the laptop's move, and every message the laptop sends after it, wait at the relay's front, so the worker's take
  // comes only after the laptop took the session back
  const held = relay.holdNext('move')

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const release = await held
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  release()
  const { last } = await stepsOf(laptop.socket)
  await until(() => worker.logged().includes(`could not take ${SESSION} from ${LAPTOP.name}`), 'the worker refusing the move', 30_000)

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `${WORKER.name} did not answer, so the session keeps running here.` })
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect(runsOn(worker.folder)).toEqual([])
  // the laptop's next prompt goes through and up from the laptop
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`, { flag: 'a' })
  await until(() => isUploaded(relay, SESSION, 'And the hotel'), 'the next prompt uploading', 15_000)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
}, 60_000)

test('Keep it here while the move waits for the turn to end keeps the session here, with its claim', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await relay.join(WORKER, roots('/home/worker'))
  laptop.status('busy')

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await stepsOf(laptop.socket, new Set(['waiting']))
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `Kept ${SESSION.slice(0, 8)} here, so it does not move to ${WORKER.name}.` })
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBeUndefined()
  expect(laptop.claude.exitCode).toBeNull()
  // the move is over, so there is nothing more to keep
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(400)
}, 60_000)

// The suite missed it: every move test's watcher heard the record of the turn's end, while macOS's watcher drops
// events with no word of it, and the move's wait read the records again only at a change the watcher heard.
test('a move waiting for the turn to end goes on to uploading once the record says idle, though the watcher drops every change', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await relay.join(WORKER, roots('/home/worker'))
  // the laptop's program starts again with a watcher that drops every change it hears, as macOS's drops events
  laptop.child.kill('SIGTERM')
  await laptop.child.exited
  await serveOn({ ...laptop.env, ANYHOST_WATCHER_DROPS: '1' })
  await until(async () => (await statusOn(laptop.socket)).relay.state === 'connected', 'the laptop connecting again')
  // past the watcher getting ready, before which the program reads the records every second anyway
  await Bun.sleep(3000)
  laptop.status('busy')
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await stepsOf(laptop.socket, new Set(['waiting']))

  laptop.status('idle')
  const idleAt = Date.now()
  const { steps } = await stepsOf(laptop.socket, new Set(['uploading', 'failed']), ['waiting'])
  expect(steps).toEqual(['waiting', 'uploading'])
  expect(Date.now() - idleAt).toBeLessThan(5000)
}, 60_000)

// The session's transcript gains a line every 50 ms, as a session's background command or agent writes after its turn
// ended, until the function it answers is called.
const keepsWriting = (laptop: { readonly cwd: string; readonly transcript: string }): { readonly written: () => number; readonly stop: () => void } => {
  let lines = 0
  const writing = setInterval(() => appendFileSync(laptop.transcript, `{"type":"progress","cwd":"${laptop.cwd}","sessionId":"${SESSION}","line":${++lines}}\n`), 50)
  return { written: () => lines, stop: () => clearInterval(writing) }
}

// The suite missed it: every session a move test moved stopped writing once its turn ended, so no drain of a move met a
// write made during the drain before it.
test('a move of a session that gains a line every 50 ms after its turn ended reaches moved within 20 s, and the worker restores every line up to its last drain', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  const writer = keepsWriting(laptop)
  await Bun.sleep(500)
  const before = writer.written()

  const asked = Date.now()
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)
  const took = Date.now() - asked
  writer.stop()

  expect(last.step).toBe('moved')
  expect(took).toBeLessThan(20_000)
  const workerHome = worker.env['HOME'] ?? ''
  const workerCwd = join(workerHome, 'work')
  const restored = readFileSync(join(workerHome, '.claude', 'projects', workerCwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`), 'utf8').split('\n').filter((line) => line !== '')
  const written = readFileSync(laptop.transcript, 'utf8').replaceAll(laptop.env['HOME'] ?? '', workerHome).split('\n').filter((line) => line !== '')
  // the first line, every line written before the move, and the lines after it in order up to the move's last drain
  expect(restored.length).toBeGreaterThan(before)
  expect(restored).toEqual(written.slice(0, restored.length))
}, 60_000)

// The suite missed it: no program test ran at uploadEvery 0, where a drain that carried a line carried no code, so a
// session that kept writing never backed up its code, and its move waited for that code without end.
test('at uploadEvery 0 a move of a session that gains a line every 50 ms while its code waits reaches moved within 20 s, and the worker restores its code', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay, LAPTOP, { uploadEvery: 0 })
  const worker = await workerOn(relay)
  // 512 KiB of code that does not compress, which goes up as 4 pieces of 128 KiB, in drains that take longer than the
  // 50 ms between lines, so every drain finds a new line
  const code = crypto.getRandomValues(new Uint8Array(2 ** 19))
  writeFileSync(join(laptop.cwd, 'map.bin'), code)
  relay.delayMs = 100
  const writer = keepsWriting(laptop)
  await Bun.sleep(500)

  const asked = Date.now()
  const before = relay.requests.length
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  // the seal, which lists the journal once the move's drains are done, and the restore read it at the relay's own pace
  await until(() => relay.requests.slice(before).some((ops) => ops.some((op) => op.op === 'list' && op.prefix === `journals/${SESSION}/`)), 'the seal listing the journal', 20_000)
  relay.delayMs = 0
  const { last } = await stepsOf(laptop.socket)
  const took = Date.now() - asked
  writer.stop()

  expect(last.step).toBe('moved')
  expect(took).toBeLessThan(20_000)
  expect(Buffer.from(readFileSync(join(worker.env['HOME'] ?? '', 'work', 'map.bin'))).equals(Buffer.from(code))).toBe(true)
}, 60_000)

// The suite missed it: Keep it here ended only the move's wait, and no test counted the puts after it.
test("Keep it here while a session that keeps writing uploads ends the move's drains, so the session's puts come at the program's uploadEvery from then on", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await relay.join(WORKER, roots('/home/worker'))
  const writer = keepsWriting(laptop)
  // each request takes 300 ms, so the move uploads for as long as Keep it here takes to come
  relay.delayMs = 300

  const asked = await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  expect(asked.body['step']).toBe('uploading')
  expect((await postTo(laptop.socket, '/move/keep', { session: SESSION })).status).toBe(200)
  const { last } = await stepsOf(laptop.socket)
  // the upload in flight as Keep it here came ends, and every put after it counts
  await Bun.sleep(1000)
  const frames = (): number => relay.puts.filter(({ key }) => key.startsWith(`journals/${SESSION}/hot/`)).length
  const kept = frames()
  await Bun.sleep(6000)
  const after = frames() - kept
  writer.stop()

  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `Kept ${SESSION.slice(0, 8)} here, so it does not move to ${WORKER.name}.` })
  // at the default 5 seconds, 6 seconds hold one or two drains, where the move's drains, one per write, put 19 here
  expect(after).toBeGreaterThan(0)
  expect(after).toBeLessThanOrEqual(2)
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
}, 60_000)

// The suite missed it: no move test's code read failed, and a move read the failure only of a read it started itself,
// while a session that keeps writing has an upload start the read the move waits on.
test('a move of a session that keeps writing while its code cannot be read ends failed with the reason of the read it waited on', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await workerOn(relay)
  // the working folder is a checkout whose index git refuses, so every read of its code fails
  Bun.spawnSync(['git', 'init', '-q', laptop.cwd])
  writeFileSync(join(laptop.cwd, '.git', 'index'), 'not an index')
  // git takes 2 s to refuse it, so the read an upload started still runs as the move looks for one to wait on
  script(join(laptop.folder, 'bin', 'git'), `#!/bin/bash\ncase " $* " in *" ls-files "*) sleep 2 ;; esac\nexec '${Bun.which('git') ?? 'git'}' "$@"\n`)
  const writer = keepsWriting(laptop)
  await Bun.sleep(500)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)
  writer.stop()

  expect(last.step).toBe('failed')
  expect(last.line).toStartWith(`anyhost could not move the session to ${WORKER.name}: anyhost could not read the code of ${SESSION.slice(0, 8)}: `)
  // git's own words for an index it refuses, as `index file smaller than expected`
  expect(last.line).toContain(': index file ')
  expect(last.line).toEndWith('. It keeps running here.')
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
}, 60_000)

// A third machine of the person's, which takes a session over as `anyhost resume --take` there does.
const DESKTOP: Device = { id: 'device-desktop', name: 'anyhost-c', os: 'linux', arch: 'arm64' }

// The suite missed it: no move test had the session taken by another machine mid-move, so no drain ever met a stopped
// journal with code waiting.
test('a move whose session another machine takes while it waits ends failed within seconds, the program answering meanwhile, and leaves the session with that machine', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  await relay.join(WORKER, roots('/home/worker'))
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await welcomed(desktop)
  laptop.status('busy')
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await stepsOf(laptop.socket, new Set(['waiting']))

  // the desktop takes the session, and the relay's `released` stops the laptop's journal
  await desktop.run([{ op: 'claim', session: SESSION, take: true }])[0]
  await until(async () => (await claimOn(laptop.socket)).machine === DESKTOP.name, 'the laptop hearing it')
  // the working folder changed, so the move's read of it finds code to upload
  writeFileSync(join(laptop.cwd, 'notes.txt'), 'the plan for the trip, by train\n')
  laptop.status('idle')
  const idleAt = Date.now()
  const { last } = await stepsOf(laptop.socket)

  expect(Date.now() - idleAt).toBeLessThan(10_000)
  expect(last).toEqual({ to: WORKER.name, step: 'failed', line: `${DESKTOP.name} took ${SESSION.slice(0, 8)} over during the move, so it continues there.` })
  const askedAt = Date.now()
  await statusOn(laptop.socket)
  expect(Date.now() - askedAt).toBeLessThan(2000)
  expect((await relay.claims()).get(SESSION)).toBe(DESKTOP.id)
  expect((await claimOn(laptop.socket)).machine).toBe(DESKTOP.name)
}, 60_000)

// The suite missed it: no test dropped the asking machine's socket while the other machine's answer was on its way, so
// every `moved` reached a machine that was connected.
test('a moved the relay could not deliver, as the laptop lost its socket just before, reaches the laptop at its next ask once it connects again, and the worker runs the session once', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await welcomed(desktop)
  const held = relay.holdNext('moved')

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const release = await held
  const reconnect = relay.disconnect(LAPTOP.id)
  await until(async () => (await machinesOf(desktop)).find(({ id }) => id === LAPTOP.id)?.connected === false, 'the relay listing the laptop offline')
  // the Pool answers the worker's one send of moved offline
  release()
  await Bun.sleep(1000)
  reconnect()
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  expect(worker.logged()).toContain(`${LAPTOP.name} asked again for its answer`)
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  expect(runsOn(worker.folder).filter((run) => run.session === SESSION)).toHaveLength(1)
  await laptop.claude.exited
  expect(laptop.claude.signalCode).toBe('SIGTERM')
}, 90_000)

// Whether the relay lists the machine as connected, as `/machines` shows it.
const listedConnected = async (asking: Relay, id: string): Promise<boolean | undefined> => (await machinesOf(asking)).find((machine) => machine.id === id)?.connected

// The suite missed it: `disconnect` closed the Pool's socket cleanly, so every machine a test took offline sent a close
// the real network never sends, and no Pool held the open socket of a machine gone to sleep, which it counted as told.
test('a laptop gone silent with a drain in flight while the desktop takes its session refuses that session\'s next prompt once it connects again, and the Pool stores no frame of it after the take', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await welcomed(desktop)
  // the first upload's index is up, so no upload of the session is in flight as the laptop goes silent
  await until(() => relay.puts.some(({ key }) => key === `sessions/${LAPTOP.id}/index.json`), 'the laptop putting its index')
  await Bun.sleep(1000)
  const wake = relay.silence(LAPTOP.id)
  // a line written as the lid closes, whose drain goes out on the silent socket
  writeFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`, { flag: 'a' })
  // the Pool counts the laptop's socket alive for up to LIVE_MS after its last ping
  for (const started = Date.now(); (await listedConnected(desktop, LAPTOP.id)) !== false; await Bun.sleep(250)) {
    if (Date.now() - started > LIVE_MS + 15_000) throw new Error(`The relay still lists ${LAPTOP.name} connected ${LIVE_MS + 15_000} ms after it went silent.`)
  }

  const [taken] = await Promise.all(desktop.run([{ op: 'claim', session: SESSION, take: true }]))
  expect(taken).toEqual({ status: 200, previous: { id: LAPTOP.id, name: LAPTOP.name }, told: false, at: expect.any(String) })
  const stored = relay.puts.length
  wake()
  // a laptop that dropped its silent socket itself waits out its next try to connect, up to 60 s
  await until(async () => (await statusOn(laptop.socket)).relay.state === 'connected', 'the laptop connecting again', 70_000)

  expect((await claimOn(laptop.socket)).machine).toBe(DESKTOP.name)
  // The drain the silent socket swallowed goes again, whole, on the next socket, after the welcome, and the Pool refuses
  // its frames with 409, as the desktop holds the session: a fork is a frame stored, never one sent. The requests the
  // laptop sends at its welcome are answered by then.
  await Bun.sleep(3000)
  expect(relay.puts.slice(stored).filter(({ key }) => key.startsWith(`journals/${SESSION}/`))).toEqual([])
}, 180_000)

// The suite missed it: the same `disconnect`, whose close the Pool heard at once, so `/machines` never had to tell a
// machine gone silent from a connected one.
test('/machines lists a machine gone silent as connected until LIVE_MS passed, and as not connected from then on', async () => {
  const relay = await memoryRelay()
  const laptop = relay.connect(LAPTOP, roots('/home/laptop'))
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await Promise.all([welcomed(laptop), welcomed(desktop)])
  relay.silence(LAPTOP.id)
  expect(await listedConnected(desktop, LAPTOP.id)).toBe(true)

  await Bun.sleep(LIVE_MS + 2000)

  expect(await listedConnected(desktop, LAPTOP.id)).toBe(false)
}, 90_000)

// The suite missed it: every holder a take met had gone silent past LIVE_MS or closed its socket, so no take met a
// socket the Pool still counted alive, which took the released into nowhere, as a laptop's does whose lid closed 5 s
// after the Pool last heard it.
test("a take of a session whose holder went silent 5 s after the Pool last heard it answers told false, and the holder's next welcome carries released, which it confirms", async () => {
  const relay = await memoryRelay()
  const home = join(temporaryFolder(), 'home')
  const laptop = openCapture(relay.connect(LAPTOP, roots(home)), LAPTOP, roots(home), { db: openDatabase(join(temporaryFolder(), 'state')), code: noCode })
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await Promise.all([welcomed(laptop.relay), welcomed(desktop)])
  expect(await laptop.relay.runOne({ op: 'claim', session: SESSION, take: false })).toEqual({ status: 200, told: true, at: expect.any(String) })
  await Bun.sleep(5000)
  const wake = relay.silence(LAPTOP.id)
  // the Pool counts the laptop's socket alive for LIVE_MS after it last heard it
  expect(await listedConnected(desktop, LAPTOP.id)).toBe(true)

  expect(await desktop.runOne({ op: 'claim', session: SESSION, take: true })).toEqual({ status: 200, previous: { id: LAPTOP.id, name: LAPTOP.name }, told: false, at: expect.any(String) })
  wake()
  await until(() => journalOf(laptop.db, SESSION)?.holder === DESKTOP.name, 'the laptop hearing it lost the session')
  await until(async () => (await relay.waiting()).length === 0, 'the Pool hearing the laptop confirm it')
})

// The suite missed it: `silence` ends a machine's sockets as it wakes, while a laptop whose lid closed for a few minutes
// wakes on its old socket, which the Pool counted not live meanwhile, so the take's released went only into the
// Pool's waiting, which only a welcome sends again. SIGSTOP freezes the program's timers with its socket open, as a
// sleep does.
test('a program whose socket outlives a sleep past LIVE_MS while another machine takes its session connects again before it sends anything more, and confirms the released before its next frame', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await welcomed(desktop)
  // the first upload's index is up, so no upload of the session is in flight as the laptop sleeps
  await until(() => relay.puts.some(({ key }) => key === `sessions/${LAPTOP.id}/index.json`), 'the laptop putting its index')
  await Bun.sleep(1000)
  let asked = 0
  let stored = 0
  // the front holds the laptop's heard and all it sends after it, so what reached it by then went before the heard
  const heard = relay.holdNext('heard')
  process.kill(laptop.child.pid, 'SIGSTOP')
  try {
    // the Pool counts the laptop's socket alive for LIVE_MS after its last ping, at most PING_MS before the sleep
    for (const started = Date.now(); (await listedConnected(desktop, LAPTOP.id)) !== false; await Bun.sleep(250)) {
      if (Date.now() - started > PING_MS + LIVE_MS + 5000) throw new Error(`The relay still lists ${LAPTOP.name} connected ${PING_MS + LIVE_MS + 5000} ms after it slept.`)
    }
    expect(await desktop.runOne({ op: 'claim', session: SESSION, take: true })).toEqual({ status: 200, previous: { id: LAPTOP.id, name: LAPTOP.name }, told: false, at: expect.any(String) })
    asked = relay.requests.length
    stored = relay.puts.length
    // a line written as the lid opens, which the laptop's next drain carries
    appendFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`)
  } finally {
    process.kill(laptop.child.pid, 'SIGCONT')
  }
  const release = await heard

  expect(relay.requests.slice(asked).flat().filter((op) => op.op === 'put' && op.key.startsWith(`journals/${SESSION}/`))).toEqual([])
  expect(laptop.logged()).toContain('seconds ago, as before this machine slept, so it connects again before it sends anything more.')
  release()
  await until(async () => (await relay.waiting()).length === 0, 'the Pool hearing the laptop confirm the released')
  expect((await claimOn(laptop.socket)).machine).toBe(DESKTOP.name)
  // the drain the laptop read as it woke goes after the heard, and the Pool refuses its frame
  await Bun.sleep(7000)
  expect(relay.puts.slice(stored).filter(({ key }) => key.startsWith(`journals/${SESSION}/`))).toEqual([])
}, 180_000)

// The suite missed it: a frame the relay refused with 409 only wrote the holder, so the Pool kept the take's released
// for this machine, and the session's copy here ran on, refusing every prompt.
test("a frame the relay refuses with 409, as after a released that never reached the program, stops the session's copy here and confirms the released", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay, LAPTOP)
  const desktop = relay.connect(DESKTOP, roots('/home/desktop'))
  await welcomed(desktop)
  const dropped = relay.dropNext(LAPTOP.id, 'released')
  expect(await desktop.runOne({ op: 'claim', session: SESSION, take: true })).toEqual({ status: 200, previous: { id: LAPTOP.id, name: LAPTOP.name }, told: false, at: expect.any(String) })
  await dropped
  expect(await relay.waiting()).toHaveLength(1)

  appendFileSync(laptop.transcript, `{"type":"user","cwd":"${laptop.cwd}","sessionId":"${SESSION}","message":{"role":"user","content":"And the hotel"}}\n`)
  await until(() => laptop.claude.signalCode === 'SIGTERM', 'the program stopping the copy', 20_000)
  expect(await relay.waiting()).toEqual([])
  expect((await claimOn(laptop.socket)).machine).toBe(DESKTOP.name)
}, 60_000)

// The suite missed it: every released a test sent reached the program that ran the session, while any command's
// connect took the welcome's released as well, and the program's own welcome then carried none.
test("a released a command's connect took stops the session's copy here at the program's next welcome", async () => {
  const relay = await memoryRelay()
  const worker = await workerOn(relay)
  const workerHome = worker.env['HOME'] ?? ''
  // the session runs on the worker between two turns, and the worker holds it
  const job = Bun.spawn(['sleep', '600'])
  children.push(job)
  writeFileSync(join(workerHome, '.claude', 'sessions', `${job.pid}.json`), JSON.stringify({ pid: job.pid, sessionId: SESSION, kind: 'interactive', cwd: join(workerHome, 'work'), status: 'idle' }))
  const claimer = relay.connect(WORKER, roots(workerHome))
  expect(await claimer.runOne({ op: 'claim', session: SESSION, take: false })).toEqual({ status: 200, told: true, at: expect.any(String) })
  claimer.close()
  // the worker's program stops, and the laptop takes the session meanwhile
  worker.child.kill('SIGKILL')
  await worker.child.exited
  await until(() => !relay.isConnected(WORKER.id), "the worker's socket closing")
  const laptop = relay.connect(LAPTOP, roots('/home/laptop'))
  expect(await laptop.runOne({ op: 'claim', session: SESSION, take: true })).toMatchObject({ status: 200, told: false })
  // a command on the worker connects before its program does, and takes the released
  const command = openCapture(relay.connect(WORKER, roots(workerHome)), WORKER, roots(workerHome), { db: openDatabase(join(worker.env['XDG_STATE_HOME'] ?? '', 'anyhost')), code: noCode })
  await until(() => journalOf(command.db, SESSION)?.holder === LAPTOP.name, 'the command taking the released')
  await until(async () => (await relay.waiting()).length === 0, 'the Pool hearing the command confirm it')
  command.relay.close()
  command.db.close()

  await serveOn(worker.env)
  await until(() => job.signalCode === 'SIGTERM', 'the program stopping the copy')
}, 60_000)

// The suite missed it: every copy a released stopped was idle or in a turn, while one at a permission prompt waits for
// an answer, which would change files on a machine that no longer holds the session.
test('a released stops the copy of a session at a permission prompt, as its record says waiting', async () => {
  const relay = await memoryRelay()
  const worker = await workerOn(relay)
  const workerHome = worker.env['HOME'] ?? ''
  // the session runs on the worker, at a permission prompt, and the worker holds it
  const job = Bun.spawn(['sleep', '600'])
  children.push(job)
  writeFileSync(join(workerHome, '.claude', 'sessions', `${job.pid}.json`), JSON.stringify({ pid: job.pid, sessionId: SESSION, kind: 'interactive', cwd: join(workerHome, 'work'), status: 'waiting' }))
  const claimer = relay.connect(WORKER, roots(workerHome))
  expect(await claimer.runOne({ op: 'claim', session: SESSION, take: false })).toMatchObject({ status: 200, told: true })
  claimer.close()

  // the laptop takes the session, as anyhost resume --take there does
  const laptop = relay.connect(LAPTOP, roots('/home/laptop'))
  expect(await laptop.runOne({ op: 'claim', session: SESSION, take: true })).toMatchObject({ status: 200 })
  // the program logs the stop once the copy ended
  await until(() => worker.logged().includes(`${LAPTOP.name} took ${SESSION} over, so ${WORKER.name} stopped its copy here.`), 'the program stopping the copy at its permission prompt')
  expect(job.signalCode).toBe('SIGTERM')
}, 60_000)

// The suite missed it: every asker a move test cut off lost its socket with a close the Pool heard at once, while the
// Pool counts a silent socket alive for LIVE_MS and sends it the answer, which counts as delivered and reaches no one.
test("a moved the Pool sent to the laptop's silent socket reaches the laptop once it connects again and asks again, and the worker runs the session once", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  const held = relay.holdNext('moved')

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const release = await held
  const wake = relay.silence(LAPTOP.id)
  release()
  // the Pool sends `moved` to the silent socket it still counts alive, and answers the worker's devices after it
  await Bun.sleep(2000)
  wake()
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  expect(worker.logged()).toContain(`${LAPTOP.name} asked again for its answer`)
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  expect(runsOn(worker.folder).filter((run) => run.session === SESSION)).toHaveLength(1)
}, 90_000)

// The suite missed it: every worker whose `seenAt` moved during a move had restarted, so a laptop that read any move of
// it as a restart passed, though a worker's socket that merely reconnected moves it too.
test('a laptop asleep from its move until after the worker reconnected and ran a prompt reaches moved once it wakes, and the worker keeps the session and its turn', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  const held = relay.holdNext('moved')

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const release = await held
  // the laptop's lid closes, and the Pool sends the worker's moved to the laptop's silent socket, which it counts alive
  const wake = relay.silence(LAPTOP.id)
  const asleepAt = Date.now()
  release()
  await Bun.sleep(500)
  // the worker's socket drops and opens again, which moves its seenAt
  const reconnect = relay.disconnect(WORKER.id)
  await until(() => !relay.isConnected(WORKER.id), 'the worker losing its socket')
  reconnect()
  await until(() => relay.isConnected(WORKER.id), 'the worker connecting again', 30_000)
  // a prompt runs on the worker
  const workerCwd = join(worker.env['HOME'] ?? '', 'work')
  const workerTranscript = join(worker.env['HOME'] ?? '', '.claude', 'projects', workerCwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`)
  appendFileSync(workerTranscript, `{"type":"user","cwd":"${workerCwd}","sessionId":"${SESSION}","message":{"role":"user","content":"Book the hotel"}}\n`)
  await until(() => isUploaded(relay, SESSION, 'Book the hotel'), 'the worker uploading its turn', 30_000)
  const turnAt = relay.puts.findIndex(({ key, body }) => key.startsWith(`journals/${SESSION}/hot/`) && decoder.decode(decompress(body)).includes('Book the hotel'))
  // the laptop sleeps through at least one check of the worker's connection
  await Bun.sleep(Math.max(0, 12_000 - (Date.now() - asleepAt)))
  wake()
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  expect(worker.logged()).toContain(`${LAPTOP.name} asked again for its answer`)
  // no frame of the laptop's goes up over the worker's turn
  const laptopFrames = relay.puts.slice(turnAt + 1).filter(({ key, body }) => key.startsWith(`journals/${SESSION}/`) && decoder.decode(decompress(body)).includes(`"device":"${LAPTOP.id}"`))
  expect(laptopFrames).toEqual([])
  await laptop.claude.exited
  expect(laptop.claude.signalCode).toBe('SIGTERM')
}, 120_000)

// The suite missed it: no test Claude Code outlived its SIGTERM, which held the move a minute and then failed it, and no
// test read /status after a move.
test('a move whose copy here ignores its SIGTERM ends it with SIGKILL 10 s later and reaches moved, with no problem in /status', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay, LAPTOP, {}, ['bash', '-c', "trap '' TERM; while true; do sleep 1; done"])
  await workerOn(relay)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  await stepsOf(laptop.socket, new Set(['moving', 'moved', 'failed']))
  const stoppingAt = Date.now()
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  expect(Date.now() - stoppingAt).toBeGreaterThan(9000)
  await laptop.claude.exited
  expect(laptop.claude.signalCode).toBe('SIGKILL')
  // the session runs on the worker, which holds it
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
  const { problems } = await statusOn(laptop.socket)
  expect(problems.filter((problem) => problem.includes(`move ${SESSION}`))).toEqual([])
}, 60_000)

// Claude Code's global config on a machine, where it keeps each folder's trust
const configOf = (machine: { readonly env: Record<string, string> }): string => join(machine.env['CLAUDE_CONFIG_DIR'] ?? '', '.claude.json')
const trustedIn = (machine: { readonly env: Record<string, string> }): string[] => {
  const { projects = {} } = JSON.parse(readFileSync(configOf(machine), { encoding: 'utf8', flag: 'a+' }) || '{}') as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }
  return Object.entries(projects).filter(([, project]) => project.hasTrustDialogAccepted === true).map(([folder]) => folder)
}
const trust = (machine: { readonly env: Record<string, string> }, folder: string): void => writeFileSync(configOf(machine), JSON.stringify({ projects: { [realpathSync(folder)]: { hasTrustDialogAccepted: true } } }))

test('a move carries the trust of the session\'s folder: the worker trusts the folder it continues in, keeping the rest of its config and its config\'s symlink', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  // outside git, Claude Code trusts a folder below a trusted one
  trust(laptop, laptop.env['HOME'] ?? '')
  // the worker keeps its config in dotfiles, and Claude Code's folder links to it
  const kept = { numStartups: 3, projects: { '/elsewhere': { allowedTools: [], hasTrustDialogAccepted: true } } }
  const dotfile = join(temporaryFolder(), 'dotfiles', 'claude.json')
  mkdirSync(dirname(dotfile), { recursive: true })
  writeFileSync(dotfile, JSON.stringify(kept))
  symlinkSync(dotfile, configOf(worker))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  const workerCwd = realpathSync(join(worker.env['HOME'] ?? '', 'work'))
  expect(JSON.parse(readFileSync(dotfile, 'utf8'))).toEqual({ ...kept, projects: { ...kept.projects, [workerCwd]: { hasTrustDialogAccepted: true } } })
  expect(readlinkSync(configOf(worker))).toBe(dotfile)
  expect(readdirSync(dirname(dotfile))).toEqual(['claude.json'])
  expect(existsSync(`${configOf(worker)}.lock`)).toBe(false)
}, 60_000)

// The suite missed it: every trust test's config was readable or missing, and none was a symlink to a missing file,
// where a read that fails reads as an empty config.
test('a worker whose Claude Code config it cannot read fails the move with the reason, and the config stays as it was', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  trust(laptop, laptop.env['HOME'] ?? '')
  const config = JSON.stringify({ numStartups: 3, oauthAccount: { emailAddress: 'ada@example.com' } })
  writeFileSync(configOf(worker), config)
  chmodSync(configOf(worker), 0o000)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)
  chmodSync(configOf(worker), 0o600)

  expect(last.step).toBe('failed')
  expect(last.line).toStartWith(`${WORKER.name} could not take the session: EACCES`)
  expect(last.line).toEndWith('. It keeps running here.')
  expect(readFileSync(configOf(worker), 'utf8')).toBe(config)
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
}, 60_000)

// The suite missed it: every laptop a trust test moved from could read its own Claude Code config, while one it could
// not read sent the move untrusted, which the worker's Claude Code refuses with `Workspace not trusted`.
test("a laptop whose Claude Code config it cannot read fails the move with the reason before it asks the worker", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  trust(laptop, laptop.env['HOME'] ?? '')
  chmodSync(configOf(laptop), 0o000)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)
  chmodSync(configOf(laptop), 0o600)

  expect(last.line).toStartWith(`anyhost could not move the session to ${WORKER.name}: EACCES`)
  expect(last.line).toEndWith('. It keeps running here.')
  expect(worker.logged()).not.toContain(`${LAPTOP.name} moves ${SESSION} here.`)
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
}, 60_000)

test('a worker whose Claude Code config is a symlink to a missing file trusts the folder in that file, and the config stays a symlink', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  trust(laptop, laptop.env['HOME'] ?? '')
  const dotfile = join(temporaryFolder(), 'dotfiles', 'claude.json')
  mkdirSync(dirname(dotfile), { recursive: true })
  symlinkSync(dotfile, configOf(worker))

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { last } = await stepsOf(laptop.socket)

  expect(last.step).toBe('moved')
  expect(lstatSync(configOf(worker)).isSymbolicLink()).toBe(true)
  expect(readlinkSync(configOf(worker))).toBe(dotfile)
  const workerCwd = realpathSync(join(worker.env['HOME'] ?? '', 'work'))
  expect(JSON.parse(readFileSync(dotfile, 'utf8'))).toEqual({ projects: { [workerCwd]: { hasTrustDialogAccepted: true } } })
}, 60_000)

// The suite missed it: every lock of Claude Code's config a test left behind was a folder, which rmdir removes.
test("a worker whose Claude Code config's lock is a file left behind fails the move with the reason within 5 s, and the file stays", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  trust(laptop, laptop.env['HOME'] ?? '')
  const lock = `${configOf(worker)}.lock`
  writeFileSync(lock, '')
  const leftAt = new Date(Date.now() - 60_000)
  utimesSync(lock, leftAt, leftAt)

  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  const { steps } = await stepsOf(laptop.socket, new Set(['moving', 'failed']))
  const askedAt = Date.now()
  const { last } = await stepsOf(laptop.socket, undefined, steps)

  expect(Date.now() - askedAt).toBeLessThan(5000)
  expect(last.step).toBe('failed')
  expect(last.line).toStartWith(`${WORKER.name} could not take the session: ${lock} is left behind, unchanged for 10 s, and anyhost could not remove it, so it could not trust the folder: ENOTDIR`)
  expect(last.line).toEndWith('. It keeps running here.')
  expect(lstatSync(lock).isFile()).toBe(true)
  expect((await relay.claims()).get(SESSION)).toBe(LAPTOP.id)
}, 60_000)

// A checkout on the laptop of a repository whose remote the worker reaches too, with a plan in `plans/`.
function tripOn(laptop: { readonly env: Record<string, string> }): string {
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

test('anyhost new trusts nothing on the worker when the laptop trusts only a folder above the checkout, which Claude Code never counts', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)
  trust(laptop, laptop.env['HOME'] ?? '')

  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(started)
  await until(async () => (await relay.claims()).get(startedOn(worker)) === WORKER.id, 'the session starting on the worker', 30_000)

  expect(trustedIn(worker)).toEqual([])
}, 60_000)

test('anyhost new starts a session on the worker in a terminal of herdr-core in its clone of the same repository, routed by start and started', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)
  // Claude Code records a checkout's trust at its root
  trust(laptop, checkout)

  const { code, out } = await anyhostOn(laptop.env, ['new', WORKER.name, join(checkout, 'plans')])

  const [run, ...more] = runsOn(worker.folder)
  expect(more).toEqual([])
  expect(code).toBe(0)
  expect(out).toBe(`${WORKER.name} started ${run?.session.slice(0, 8)} in a terminal of herdr-core there.\n`)
  expect(run?.command).toBe(`claude --session-id ${run?.session}`)
  expect((await relay.claims()).get(run?.session ?? '')).toBe(WORKER.id)
  const workerCwd = join(worker.env['HOME'] ?? '', 'trip', 'plans')
  expect(readFileSync(join(workerCwd, 'route.md'), 'utf8')).toBe('Lisbon, then Porto\n')
  expect(realpathSync(run?.cwd ?? '')).toBe(realpathSync(workerCwd))
  // the worker trusts its clone at its root, where Claude Code looks for the trust of the folder inside it
  expect(trustedIn(worker)).toEqual([realpathSync(join(worker.env['HOME'] ?? '', 'trip'))])
}, 60_000)

// The suite missed it: every worker an anyhost new test asked answered, and the relay's `offline` comes only as a
// message is sent.
test('anyhost new to a worker whose program ends after it took the start ends with the reason within the check of its connection', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  // its herdr-core starts the session past the end of the test
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'hang'), '60'))
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)

  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(started)
  await until(() => startedOn(worker) !== '', 'the worker starting the session', 30_000)
  worker.child.kill('SIGKILL')
  const endedAt = Date.now()
  const [code, err] = await Promise.all([started.exited, new Response(started.stderr).text()])

  // the check every 10 s, and the answer of the relay's devices
  expect(Date.now() - endedAt).toBeLessThan(25_000)
  expect(code).toBe(1)
  // the worker may have started the session before it went, so the line names where to look
  expect(err.trim()).toBe(`${WORKER.name} is offline or its program restarted before it answered. anyhost list shows whether a session started there.`)
}, 60_000)

// The suite missed it: no test dropped the socket of anyhost new's own process, which alone waited for `started`, while
// the relay sends `started` only to the sockets the laptop has open as it comes.
test("anyhost new whose command's own socket drops while the worker starts the session prints the session it started and exits 0", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  // its herdr-core takes 3 s to start the session
  const worker = await workerOn(relay, (folder) => writeFileSync(join(folder, 'hang'), '3'))
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)

  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(started)
  await until(() => startedOn(worker) !== '', 'the worker starting the session', 30_000)
  // every socket of the laptop but its program's, which it opened first, ends, and none opens until the relay sent the
  // worker's `started` on
  const reconnect = relay.disconnect(LAPTOP.id, 1)
  await until(() => worker.logged().includes(`${WORKER.name} started ${startedOn(worker)}`), 'the worker answering', 30_000)
  await Bun.sleep(1000)
  reconnect()
  const [code, out] = await Promise.all([started.exited, new Response(started.stdout).text()])

  expect(out).toBe(`${WORKER.name} started ${startedOn(worker).slice(0, 8)} in a terminal of herdr-core there.\n`)
  expect(code).toBe(0)
}, 60_000)

// The suite missed it: every started a test held reached a laptop whose socket closed with a close the Pool heard, while
// a laptop asleep keeps a socket the Pool counts alive, which takes the answer into nowhere.
test("anyhost new whose laptop sleeps as the worker's started goes prints the session once it wakes and exits 0, with one session started there", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)
  const held = relay.holdNext('started')

  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(started)
  const release = await held
  // the laptop's lid closes, and the Pool sends the worker's started to the laptop's silent sockets, which it counts alive
  const wake = relay.silence(LAPTOP.id)
  release()
  // the laptop sleeps through at least one check of the worker's connection
  await Bun.sleep(12_000)
  wake()
  const [code, out] = await Promise.all([started.exited, new Response(started.stdout).text()])

  expect(out).toBe(`${WORKER.name} started ${startedOn(worker).slice(0, 8)} in a terminal of herdr-core there.\n`)
  expect(code).toBe(0)
  expect(worker.logged()).toContain(`${LAPTOP.name} asked again for its answer`)
  expect(runsOn(worker.folder)).toHaveLength(1)
}, 90_000)

test("anyhost new while its program's relay is not connected says what it waits for, and starts the session once the relay connects", async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)
  const reconnect = relay.disconnect(LAPTOP.id)
  await until(async () => (await statusOn(laptop.socket)).relay.state !== 'connected', 'the program reading its relay down')

  const started = Bun.spawn(['bun', CLI, 'new', WORKER.name, join(checkout, 'plans')], { env: laptop.env, stdout: 'pipe', stderr: 'pipe' })
  children.push(started)
  let printed = ''
  const reading = (async () => {
    for await (const chunk of started.stdout) printed += decoder.decode(chunk)
  })()
  await until(() => printed.includes('\n'), 'the line that says what anyhost new waits for', 30_000)
  const waiting = printed
  reconnect()
  const [code] = await Promise.all([started.exited, reading])

  expect(waiting).toStartWith(`Waiting for the relay at ${relay.url} to connect.`)
  expect(waiting).toEndWith(' Ctrl-C stops waiting.\n')
  expect(printed.slice(waiting.length)).toBe(`${WORKER.name} started ${startedOn(worker).slice(0, 8)} in a terminal of herdr-core there.\n`)
  expect(code).toBe(0)
}, 90_000)

// What each machine's herdr-core typed into a terminal: its address and the text.
const sentOn = (folder: string): string[] => logOf(folder, 'sent.log')

// The folder is one Claude Code does not trust on the laptop, so the start answers once the terminal opened, where Claude
// Code asks the person first, and the first message goes in once Claude Code runs the session. herdr-core refuses the
// first 3 sends while the new terminal's output still moves, which the suite missed: devbox's start failed at the first.
test('anyhost new on this machine starts a session in a terminal of herdr-core here and types its first message into it', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const folder = join(laptop.env['HOME'] ?? '', 'trip')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(laptop.folder, 'unsettled'), '3')

  const { code, out } = await anyhostOn(laptop.env, ['new', LAPTOP.name, folder, 'You are the CTO. Watch every agent.'])

  const session = startedOn(laptop)
  expect(code).toBe(0)
  expect(out).toBe(`${LAPTOP.name} started ${session.slice(0, 8)} in a terminal of herdr-core there.\n`)
  expect(runsOn(laptop.folder)).toMatchObject([{ session, command: `claude --session-id ${session}` }])
  await until(() => sentOn(laptop.folder).length > 0, 'the first message going in')
  expect(sentOn(laptop.folder)).toEqual(['t0 You are the CTO. Watch every agent.'])
  expect((await relay.claims()).get(session)).toBe(LAPTOP.id)
}, 60_000)

test('anyhost tell types into a session another machine runs and prints its screen, and with no text only reads it', async () => {
  const relay = await memoryRelay()
  const laptop = await machineFor(relay, LAPTOP)
  const worker = await workerOn(relay)
  await serveOn(laptop.env)
  await until(() => relay.isConnected(LAPTOP.id), 'the laptop connecting')
  const checkout = tripOn(laptop)
  await anyhostOn(laptop.env, ['new', WORKER.name, checkout])
  const session = startedOn(worker)

  const told = await anyhostOn(laptop.env, ['tell', session.slice(0, 8), 'Book the train'])
  const read = await anyhostOn(laptop.env, ['tell', session.slice(0, 8)])

  expect(told).toMatchObject({ code: 0, out: `screen of ${session}\nBook the train\n` })
  expect(read).toMatchObject({ code: 0, out: `screen of ${session}\nBook the train\n` })
  expect(sentOn(worker.folder)).toEqual(['t0 Book the train'])
  expect(sentOn(laptop.folder)).toEqual([])
}, 60_000)

// The suite missed it: a session whose terminal ended, as after the machine restarted, had nothing to type into.
test('anyhost tell to a session its machine holds in no live terminal opens one there that resumes it with its command, and types into it', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  expect((await stepsOf(laptop.socket)).last.step).toBe('moved')
  for (const { pid } of copiesOn(worker.folder)) process.kill(pid, 'SIGKILL')
  await until(() => copiesOn(worker.folder).every(({ isRunning }) => !isRunning), "the worker's copy ending")

  const read = await anyhostOn(laptop.env, ['tell', SESSION.slice(0, 8)])
  const told = await anyhostOn(laptop.env, ['tell', SESSION.slice(0, 8), 'And the hotel'])

  expect(read).toMatchObject({ code: 1, err: `${WORKER.name}: ${SESSION.slice(0, 8)} runs in no terminal of herdr-core on ${WORKER.name}. Tell it something to start it again.\n` })
  expect(told).toMatchObject({ code: 0, out: `screen of ${SESSION}\nAnd the hotel\n` })
  expect(runsOn(worker.folder).map(({ session, command }) => ({ session, command }))).toEqual([
    { session: SESSION, command: 'claude' },
    { session: SESSION, command: 'claude' },
  ])
  expect(sentOn(worker.folder)).toEqual(['t1 And the hotel'])
}, 90_000)

const CTO = 'c7000000-0000-4000-8000-000000000000'

test("an agent's message names the agent and the machine that sent it, so the agent it reaches answers it, and keys answer a prompt", async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  expect((await stepsOf(laptop.socket)).last.step).toBe('moved')

  const told = await postTo(laptop.socket, '/agents/tell', { session: SESSION.slice(0, 8), text: 'Book the train', sender: CTO })
  const pressed = await postTo(laptop.socket, '/agents/tell', { session: SESSION.slice(0, 8), keys: ['down', 'enter'] })

  const tagged = `<anyhost from="c7000000 on ${LAPTOP.name}" reach="tell_agent c7000000 when done or stuck">Book the train</anyhost>`
  expect(told).toEqual({ status: 200, body: { machine: WORKER.name, session: SESSION, status: 'working', screen: `screen of ${SESSION}\n${tagged}` } })
  expect(pressed).toMatchObject({ status: 200, body: { status: 'working' } })
  expect(sentOn(worker.folder)).toEqual([`t0 ${tagged}`])
  expect(logOf(worker.folder, 'keys.log')).toEqual(['t0 down enter'])
}, 90_000)

test('GET /agents lists what every session of every connected machine does now', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  await postTo(laptop.socket, '/move', { session: SESSION, machine: WORKER.name })
  expect((await stepsOf(laptop.socket)).last.step).toBe('moved')

  const listed = (await (await fetch('http://localhost/agents', { unix: laptop.socket })).json()) as { agents: { id: string; status: string }[] }

  expect(listed.agents.find(({ id }) => id === SESSION)?.status).toBe('idle')
  expect(worker.folder).not.toBe('')
}, 90_000)

// The suite missed it: a session that runs outside herdr-core holds Claude Code's input itself, and a tell opened a
// second Claude Code on the same transcript.
test('a tell to a session that runs here outside herdr-core types nothing and says so', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)

  const told = await postTo(laptop.socket, '/agents/tell', { session: SESSION, text: 'Book the train' })

  expect(told).toEqual({ status: 400, body: { message: `${SESSION.slice(0, 8)} runs on ${LAPTOP.name} outside herdr-core, so anyhost cannot type into it or read it.` } })
  expect(runsOn(laptop.folder)).toEqual([])
}, 60_000)

test('a take continues a session here from R2 while the machine that ran it is gone', async () => {
  const relay = await memoryRelay()
  const laptop = await runningOn(relay)
  const worker = await workerOn(relay)
  laptop.child.kill('SIGKILL')
  await until(() => !relay.isConnected(LAPTOP.id), 'the laptop going away', 60_000)

  const taken = await postTo(worker.socket, '/agents/take', { session: SESSION.slice(0, 8) })

  expect(taken).toEqual({ status: 200, body: { session: SESSION, machine: WORKER.name } })
  expect(runsOn(worker.folder).map(({ session, command }) => ({ session, command }))).toEqual([{ session: SESSION, command: 'claude' }])
  expect((await relay.claims()).get(SESSION)).toBe(WORKER.id)
}, 90_000)

