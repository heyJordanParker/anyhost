import { http, messageOf, type Mod, type Page, type PageInit, type Step } from '../../node_modules/@cmodjs/core/mod.js'
import type { Program } from '../../node_modules/@cmodjs/core/jobs/program.js'
import { Box, Button, Input, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import type { Device as Machine } from '../../relay/protocol.ts'

type Account = { readonly id: string; readonly name: string }
type Connecting = { readonly is: 'running' | 'joined' | 'failed'; readonly lines: readonly string[]; readonly accounts?: readonly Account[]; readonly r2Page?: string; readonly error?: string }
type Joining = { readonly is: 'running' } | { readonly is: 'failed'; readonly error: string }
type Status = { readonly relay: { readonly state: string; readonly message: string }; readonly connecting?: Connecting; readonly joining?: Joining }
type JoinedRelay = { readonly url: string }
type Candidate = { readonly target: string; readonly os: string; readonly online: boolean }
type Machines = { readonly here: string; readonly machines: readonly Machine[]; readonly candidates: readonly Candidate[]; readonly adding: readonly { readonly target: string; readonly error?: string }[] }

export type AnyhostState = {
  memory: {
    connecting: Connecting | null
    isFollowing: boolean
    joined: JoinedRelay | { readonly problem: string } | null
    joining: Joining | null
    relayState: string | null
    machines: Machines | null
    isAdding: boolean
    removing: string | null
    problem: string | null
  }
}

export const initialState: AnyhostState = {
  memory: { connecting: null, isFollowing: false, joined: null, joining: null, relayState: null, machines: null, isAdding: false, removing: null, problem: null },
}

const NEEDS_STEP = new Set(['unjoined', 'outdated'])
const CONNECT_WAIT_MS = 15_000
export const FOLLOW_MS = 1000

const programs = new WeakMap<object, Program>()
export const reachProgram = (mod: Mod<AnyhostState>, program: Program): void => void programs.set(mod, program)

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

function follow(mod: Mod<AnyhostState>): void {
  if (mod.state.memory.isFollowing) return
  mod.state.memory.isFollowing = true
  const timer = mod.every(FOLLOW_MS, async () => {
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

async function connectAsk(mod: Mod<AnyhostState>, path: string, body: object): Promise<void> {
  const answered = await askProgram<Connecting>(mod, path, body).catch((error: unknown): Connecting => ({ is: 'failed', lines: mod.state.memory.connecting?.lines ?? [], error: messageOf(error) }))
  mod.state.memory.connecting = answered
  if (answered.is === 'running') follow(mod)
}

async function joinWith(mod: Mod<AnyhostState>, link: string): Promise<void> {
  mod.state.memory.joined = await askProgram<JoinedRelay>(mod, '/join', { link }).catch((error: unknown) => ({ problem: messageOf(error) }))
  if ('url' in mod.state.memory.joined) mod.state.memory.joining = null
}

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
    mod.state.memory.relayState = relay.state
    const isRemoved = relay.state === 'unjoined'
    mod.state.memory.connecting = isRemoved && connecting?.is === 'joined' ? null : (connecting ?? null)
    if (isRemoved && mod.state.memory.joined !== null && 'url' in mod.state.memory.joined) mod.state.memory.joined = null
    return NEEDS_STEP.has(relay.state)
  }
}

export const connectStep: Step<AnyhostState> = {
  id: 'machines',
  title: 'Connect your machines',
  render: (mod) => <ConnectView mod={mod} />,
  isDone: async (mod) => !(await needsStep(mod)),
}

function ConnectView({ mod }: { readonly mod: Mod<AnyhostState> }): JSX.Element {
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
        {connecting?.is === 'joined' && mod.state.memory.relayState === 'outdated' ? (
          <Text wrap="wrap">Cloudflare still runs your relay's older version, for up to 5 minutes after the upload. Press Finish once it runs the new one.</Text>
        ) : null}
      </Box>
      <Box flexDirection="column">
        <Text bold>On every other machine</Text>
        <Text wrap="wrap">Add it from /machines on a joined machine, which installs anyhost here over ssh, or ask Claude there to add it. A machine it can't reach over ssh joins here with the command anyhost machines --invite prints there.</Text>
        {joining === null ? null : joining.is === 'running' ? (
          <Text dimColor wrap="wrap">Joining with the invite link of the install command</Text>
        ) : (
          <Box flexDirection="column">
            <Text color="error" wrap="wrap">{`The invite link of the install command joined no relay: ${joining.error}`}</Text>
            <Text wrap="wrap">anyhost tries a link once. Add this machine again from /machines on a joined machine.</Text>
          </Box>
        )}
        <Input key="invite" label="› " placeholder="cmod install … --option 'join=https://…/v1/join#…'" submitLabel="join" onSubmit={(link) => void joinWith(mod, link)} />
        {joined === null ? null : 'url' in joined ? <Text color="success">{`✔ Joined ${joined.url}`}</Text> : <Text color="error" wrap="wrap">{joined.problem}</Text>}
      </Box>
    </Box>
  )
}

function ConnectingView({ mod, connecting }: { readonly mod: Mod<AnyhostState>; readonly connecting: Connecting }): JSX.Element {
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
          <Button key="r2-page" plain href={connecting.r2Page}>[Open Cloudflare's R2 page]</Button>
          <Text>Turn R2 on there, then press Next.</Text>
          <Button key="r2-next" plain onPress={() => connectAsk(mod, '/connect/r2', {})}>[Next]</Button>
        </Box>
      )}
      {connecting.is === 'joined' ? <Text color="success">✔ This machine is joined to your relay.</Text> : null}
      {connecting.error === undefined ? null : <Text color="error" wrap="wrap">{connecting.error}</Text>}
    </Box>
  )
}

function momentOf(iso: string): string {
  const at = new Date(iso)
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return at.toDateString() === new Date().toDateString() ? time : `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

async function act(mod: Mod<AnyhostState>, work: () => Promise<void>): Promise<void> {
  mod.state.memory.problem = null
  await work().catch((error: unknown) => void (mod.state.memory.problem = messageOf(error)))
}

export async function showMachines(mod: Mod<AnyhostState>): Promise<void> {
  await act(mod, async () => void (mod.state.memory.machines = await askProgram<Machines>(mod, '/machines')))
}

export async function toggleMachines(mod: Mod<AnyhostState>, page: Page): Promise<void> {
  if (!page.isOpen) {
    mod.state.memory.isAdding = false
    mod.state.memory.removing = null
    void showMachines(mod)
  }
  await page.toggle({ focus: true })
}

const addMachine = (mod: Mod<AnyhostState>, target: string): Promise<void> =>
  act(mod, async () => {
    await askProgram(mod, '/machines/add', { target: target.trim() })
    await showMachines(mod)
  })

const remove = (mod: Mod<AnyhostState>, id: string): Promise<void> =>
  act(mod, async () => {
    await askProgram(mod, '/machines/remove', { id })
    mod.state.memory.removing = null
    await showMachines(mod)
  })

export const machinesPage: PageInit<AnyhostState> = {
  id: 'machines',
  title: 'Machines',
  render: (mod) => {
    const { machines, isAdding, removing, problem } = mod.state.memory
    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {machines === null ? <Text dimColor>{problem === null ? 'Reading your machines' : ''}</Text> : <MachineList mod={mod} machines={machines} removing={removing} />}
        {machines?.adding.map(({ target, error }) => (error === undefined ? <Text key={`adding-${target}`} dimColor>{`Adding ${target}: anyhost installs there and joins it`}</Text> : <Text key={`adding-${target}`} color="error" wrap="wrap">{`${target} was not added: ${error}`}</Text>))}
        {!isAdding ? (
          <Box>
            <Button key="add" plain onPress={() => void (mod.state.memory.isAdding = true)}><Text color="claude">[Add a machine]</Text></Button>
          </Box>
        ) : (
          <Box flexDirection="column">
            {machines === null || machines.candidates.length === 0 ? null : (
              <Box gap={2}>
                <Text dimColor>On your Tailscale network:</Text>
                {machines.candidates.map(({ target, online }) => (
                  <Button key={`candidate-${target}`} plain onPress={() => addMachine(mod, target)}>
                    <Text color={online ? 'claude' : undefined} dimColor={!online}>{`[${target}]`}</Text>
                  </Button>
                ))}
              </Box>
            )}
            <Input key="target" label="› " placeholder="how ssh reaches it: devbox, me@10.0.0.7" submitLabel="add" onSubmit={(target) => void addMachine(mod, target)} />
          </Box>
        )}
        {problem === null ? null : <Text color="error" wrap="wrap">{problem}</Text>}
      </Box>
    )
  },
}

function MachineList({ mod, machines, removing }: { readonly mod: Mod<AnyhostState>; readonly machines: Machines; readonly removing: string | null }): JSX.Element {
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
              <Text wrap="wrap">{`Remove ${machine.name}? It stops uploading at once, and its sessions stay listed and resumable here. Add a machine joins it again.`}</Text>
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
