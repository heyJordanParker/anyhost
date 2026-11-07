import type { RenderElement } from 'claude-code'
import { clipboard, http, messageOf, type Mod, type Page, type PageInit, type Step } from '../../node_modules/@cmodjs/core/mod.js'
import type { Program } from '../../node_modules/@cmodjs/core/jobs/program.js'
import { Box, Button, Input, Link, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import type { Device as Machine } from '../../relay/protocol.ts'

// What the anyhost program answers, as `cli/src/serve.ts` serves it. `cmod check`'s compile against Claude Code's API
// type-checks every file a type comes from, and refuses `cli/src/`, whose files import with `.ts` paths and use Bun, so
// these copy the program's `Connecting`, `Status` and `JoinedRelay`. `relay/protocol.ts` uses nothing but the language.
type Account = { readonly id: string; readonly name: string }
type Connecting = { readonly is: 'running' | 'joined' | 'failed'; readonly lines: readonly string[]; readonly accounts?: readonly Account[]; readonly r2Page?: string; readonly error?: string }
type Joining = { readonly is: 'running' } | { readonly is: 'failed'; readonly error: string }
type Status = { readonly relay: { readonly state: string; readonly message: string }; readonly connecting?: Connecting; readonly joining?: Joining }
type JoinedRelay = { readonly url: string }
type Machines = { readonly here: string; readonly machines: readonly Machine[] }
type Invite = { readonly command: string; readonly expiresAt: string }

export type AnyhostState = {
  memory: {
    connecting: Connecting | null
    isFollowing: boolean
    // the program's answer to the invite link pasted on the Step: the relay joined, or why not
    joined: JoinedRelay | { readonly problem: string } | null
    // the program's join with the link of the option join, as the install command Add a machine gives sets it
    joining: Joining | null
    machines: Machines | null
    invite: Invite | null
    removing: string | null
    problem: string | null
  }
}

export const initialState: AnyhostState = {
  memory: { connecting: null, isFollowing: false, joined: null, joining: null, machines: null, invite: null, removing: null, problem: null },
}

// The relay states in which this machine needs the Step: not joined, as before a join or once the program forgot a
// removed machine's login, or joined to a relay older than the program needs.
const NEEDS_STEP = new Set(['unjoined', 'outdated'])
// The relay welcomes a joined machine within CONNECT_MS, 10 seconds, of the program asking (cli/src/relay.ts).
const CONNECT_WAIT_MS = 15_000
// how often the Step follows Connect Cloudflare and /move follows its move
export const FOLLOW_MS = 1000

// The anyhost program of each started mod, which its setup hands over.
const programs = new WeakMap<object, Program>()
export const reachProgram = (mod: Mod<AnyhostState>, program: Program): void => void programs.set(mod, program)

// One answer of the program, at the unix socket it listens on: a GET, or a POST of `body` as JSON.
export async function askProgram<T>(mod: Mod<AnyhostState>, path: string, body?: object): Promise<T> {
  const program = programs.get(mod)
  if (program === undefined) throw new Error('The anyhost mod has not started its program yet.')
  const { url, socketPath } = await program.ready()
  const answer = await http.fetch(`${url}${path}`, {
    ...(socketPath === undefined ? {} : { socketPath }),
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const read = ((): unknown => {
    try {
      return JSON.parse(answer.text)
    } catch {
      return undefined
    }
  })()
  if (!answer.ok) throw new Error((read as { message?: string } | undefined)?.message ?? `The anyhost program answered ${answer.status}: ${answer.text}`)
  return read as T
}

const pause = (mod: Mod<AnyhostState>, ms: number): Promise<void> => new Promise((resolve) => void mod.after(ms, resolve))

// Follows a Connect Cloudflare the program runs, once a second until it joined or failed.
function follow(mod: Mod<AnyhostState>): void {
  if (mod.state.memory.isFollowing) return
  mod.state.memory.isFollowing = true
  const timer = mod.every(FOLLOW_MS, async () => {
    // a program that restarts answers at a later tick
    const status = await askProgram<Status>(mod, '/status').catch((error: unknown) => void mod.log(`anyhost could not follow Connect Cloudflare: ${messageOf(error)}`, { level: 'warning' }))
    if (status === undefined) return
    const { connecting, joining } = status
    mod.state.memory.connecting = connecting ?? null
    mod.state.memory.joining = joining ?? null
    if (connecting?.is === 'running') return
    timer.stop()
    mod.state.memory.isFollowing = false
  })
}

// Asks the program what a press on the Step asks, and shows the Connect Cloudflare it answers, or why it failed.
async function connectAsk(mod: Mod<AnyhostState>, path: string, body: object): Promise<void> {
  const answered = await askProgram<Connecting>(mod, path, body).catch((error: unknown): Connecting => ({ is: 'failed', lines: mod.state.memory.connecting?.lines ?? [], error: messageOf(error) }))
  mod.state.memory.connecting = answered
  if (answered.is === 'running') follow(mod)
}

// A link that joins this machine ends the failure of the option's join, which the program forgets too.
async function joinWith(mod: Mod<AnyhostState>, link: string): Promise<void> {
  mod.state.memory.joined = await askProgram<JoinedRelay>(mod, '/join', { link }).catch((error: unknown) => ({ problem: messageOf(error) }))
  if ('url' in mod.state.memory.joined) mod.state.memory.joining = null
}

// Done once this machine is joined to a relay that answers the program's protocol. A program that just started
// connects first, and one installed with the command Add a machine gives joins with the option's link first, so the
// Step never opens on a machine that is joining for that moment.
async function needsStep(mod: Mod<AnyhostState>): Promise<boolean> {
  const started = Date.now()
  for (;;) {
    const { relay, connecting, joining } = await askProgram<Status>(mod, '/status')
    if (connecting?.is === 'running') follow(mod)
    mod.state.memory.joining = joining ?? null
    if (joining?.is === 'running' || (relay.state === 'connecting' && Date.now() - started < CONNECT_WAIT_MS)) {
      await pause(mod, 250)
      continue
    }
    const needs = NEEDS_STEP.has(relay.state)
    // a run or a pasted link that joined this machine before it was removed is over, and the Step starts afresh
    mod.state.memory.connecting = needs && connecting?.is === 'joined' ? null : (connecting ?? null)
    if (needs && mod.state.memory.joined !== null && 'url' in mod.state.memory.joined) mod.state.memory.joined = null
    return needs
  }
}

export const connectStep: Step<AnyhostState> = {
  id: 'machines',
  title: 'Connect your machines',
  render: (mod) => <ConnectView mod={mod} />,
  isDone: async (mod) => !(await needsStep(mod)),
}

function ConnectView({ mod }: { readonly mod: Mod<AnyhostState> }): RenderElement {
  const { connecting, joined, joining } = mod.state.memory
  return (
    <Box flexDirection="column" gap={1}>
      <Text wrap="wrap">anyhost keeps every session of every machine in your own Cloudflare account, through a relay it sets up there. Connect each machine once.</Text>
      <Box flexDirection="column">
        <Text bold>On your first machine, or any machine with your Cloudflare login</Text>
        {connecting !== null && connecting.is !== 'failed' ? null : (
          <Box>
            <Button key="connect" plain onPress={() => connectAsk(mod, '/connect', {})}>
              <Text color="claude">{connecting?.is === 'failed' ? '[Connect Cloudflare again]' : '[Connect Cloudflare]'}</Text>
            </Button>
          </Box>
        )}
        {connecting === null ? null : <ConnectingView mod={mod} connecting={connecting} />}
      </Box>
      <Box flexDirection="column">
        <Text bold>On every other machine</Text>
        <Text wrap="wrap">Paste the command or the invite link that Add a machine gives in /machines on a joined machine.</Text>
        {joining === null ? null : joining.is === 'running' ? (
          <Text dimColor wrap="wrap">Joining with the invite link of the install command</Text>
        ) : (
          <Box flexDirection="column">
            <Text color="error" wrap="wrap">{`The invite link of the install command joined no relay: ${joining.error}`}</Text>
            <Text wrap="wrap">anyhost tries a link once. Press Add a machine in /machines on a joined machine for a new invite, and paste its command here.</Text>
          </Box>
        )}
        <Input key="invite" label="› " placeholder="cmod install … --option 'join=https://…/v1/join#…'" submitLabel="join" onSubmit={(link) => void joinWith(mod, link)} />
        {joined === null ? null : 'url' in joined ? <Text color="success">{`✔ Joined ${joined.url}`}</Text> : <Text color="error" wrap="wrap">{joined.problem}</Text>}
      </Box>
    </Box>
  )
}

// Every line Connect Cloudflare said, then what it waits for: an account to pick, or R2 turned on at its page.
function ConnectingView({ mod, connecting }: { readonly mod: Mod<AnyhostState>; readonly connecting: Connecting }): RenderElement {
  return (
    <Box flexDirection="column">
      {connecting.lines.map((line) => <Text dimColor wrap="wrap">{line}</Text>)}
      {connecting.accounts === undefined ? null : (
        <Box flexDirection="column">
          <Text>Your Cloudflare login reaches several accounts. Pick the one your relay goes in:</Text>
          {connecting.accounts.map((account) => (
            <Box>
              <Button key={`account-${account.id}`} plain onPress={() => connectAsk(mod, '/connect/account', { id: account.id })}>{`[${account.name}]`}</Button>
            </Box>
          ))}
        </Box>
      )}
      {connecting.r2Page === undefined ? null : (
        <Box gap={2}>
          <Text>
            Turn R2 on at <Link href={connecting.r2Page}>Cloudflare's R2 page</Link>, then press Next.
          </Text>
          <Button key="r2-next" plain onPress={() => connectAsk(mod, '/connect/r2', {})}>[Next]</Button>
        </Box>
      )}
      {connecting.is === 'joined' ? <Text color="success">✔ This machine is joined to your relay.</Text> : null}
      {connecting.error === undefined ? null : <Text color="error" wrap="wrap">{connecting.error}</Text>}
    </Box>
  )
}

// The clock time of a moment today, else its date and time, in the person's own zone.
function momentOf(iso: string): string {
  const at = new Date(iso)
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return at.toDateString() === new Date().toDateString() ? time : `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

// Runs what a press on /machines asks of the program, and shows why it failed.
async function act(mod: Mod<AnyhostState>, work: () => Promise<void>): Promise<void> {
  mod.state.memory.problem = null
  await work().catch((error: unknown) => void (mod.state.memory.problem = messageOf(error)))
}

export async function showMachines(mod: Mod<AnyhostState>): Promise<void> {
  await act(mod, async () => void (mod.state.memory.machines = await askProgram<Machines>(mod, '/machines')))
}

// Opens or closes /machines, reading the machines as it opens.
export async function toggleMachines(mod: Mod<AnyhostState>, page: Page): Promise<void> {
  if (!page.isOpen) {
    mod.state.memory.invite = null
    mod.state.memory.removing = null
    void showMachines(mod)
  }
  await page.toggle({ focus: true })
}

const addMachine = (mod: Mod<AnyhostState>): Promise<void> => act(mod, async () => void (mod.state.memory.invite = await askProgram<Invite>(mod, '/machines/invite', {})))

const remove = (mod: Mod<AnyhostState>, id: string): Promise<void> =>
  act(mod, async () => {
    await askProgram(mod, '/machines/remove', { id })
    mod.state.memory.removing = null
    await showMachines(mod)
  })

async function copy(mod: Mod<AnyhostState>, command: string): Promise<void> {
  await clipboard.write(command)
  mod.toast.success('Copied the install command')
}

export const machinesPage: PageInit<AnyhostState> = {
  id: 'machines',
  title: 'Machines',
  render: (mod) => {
    const { machines, invite, removing, problem } = mod.state.memory
    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {machines === null ? <Text dimColor>{problem === null ? 'Reading your machines' : ''}</Text> : <MachineList mod={mod} machines={machines} removing={removing} />}
        {invite === null ? (
          <Box>
            <Button key="add" plain onPress={() => addMachine(mod)}><Text color="claude">[Add a machine]</Text></Button>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text wrap="wrap">{`Paste this on the machine to join. It joins one machine, until ${momentOf(invite.expiresAt)}.`}</Text>
            <Text>{invite.command}</Text>
            <Box gap={2}>
              <Button key="copy" plain onPress={() => copy(mod, invite.command)}><Text color="claude">[Copy]</Text></Button>
              <Button key="add-another" plain dimColor onPress={() => addMachine(mod)}>[New invite]</Button>
            </Box>
          </Box>
        )}
        {problem === null ? null : <Text color="error" wrap="wrap">{problem}</Text>}
      </Box>
    )
  },
}

function MachineList({ mod, machines, removing }: { readonly mod: Mod<AnyhostState>; readonly machines: Machines; readonly removing: string | null }): RenderElement {
  const width = Math.max(...machines.machines.map(({ name }) => name.length))
  const kind = ({ os, arch }: Machine): string => `${os}-${arch}`
  const kindWidth = Math.max(...machines.machines.map((machine) => kind(machine).length))
  return (
    <Box flexDirection="column">
      {machines.machines.map((machine) => (
        <Box key={machine.id} flexDirection="column">
          <Box gap={2}>
            <Box flexShrink={0}><Text bold={machine.id === machines.here}>{machine.name.padEnd(width)}</Text></Box>
            <Box flexShrink={0}><Text dimColor>{kind(machine).padEnd(kindWidth)}</Text></Box>
            {machine.connected ? <Text color="success">connected</Text> : <Text dimColor>{`last seen ${momentOf(machine.seenAt)}`}</Text>}
            {machine.id === machines.here ? <Text dimColor>this machine</Text> : <Button key={`remove-${machine.id}`} plain dimColor onPress={() => void (mod.state.memory.removing = machine.id)}>[Remove]</Button>}
          </Box>
          {removing !== machine.id ? null : (
            <Box flexDirection="column" paddingLeft={2}>
              <Text wrap="wrap">{`Remove ${machine.name}? It stops uploading at once, and its sessions stay listed and resumable here. It joins again with a new invite.`}</Text>
              <Box gap={2}>
                <Button key={`remove-yes-${machine.id}`} plain onPress={() => remove(mod, machine.id)}><Text color="error">[Remove]</Text></Button>
                <Button key={`remove-no-${machine.id}`} plain dimColor onPress={() => void (mod.state.memory.removing = null)}>[Cancel]</Button>
              </Box>
            </Box>
          )}
        </Box>
      ))}
    </Box>
  )
}
