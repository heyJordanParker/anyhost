import { messageOf, type Mod, type Step } from '../node_modules/@cmodjs/core/mod.js'
import { Box, Button, Input, Text } from '../node_modules/@cmodjs/core/ui/elements.js'
import { askProgram, FOLLOW_MS, NoAnswer } from './program.js'
import type { AnyhostState, Connecting, JoinedRelay, Joining } from './state.js'

type Status = { readonly relay: { readonly state: string; readonly message: string }; readonly connecting?: Connecting; readonly joining?: Joining; readonly needsLogin?: true }

const CONNECT_WAIT_MS = 15_000

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
    const status = await askProgram<Status>(mod, '/status').catch((error: unknown) => {
      if (error instanceof NoAnswer) return Date.now() - started < CONNECT_WAIT_MS ? undefined : null
      throw error
    })
    if (status === null) return false
    if (status === undefined) {
      await pause(mod, 250)
      continue
    }
    const { relay, connecting, joining } = status
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
    return isRemoved || (relay.state === 'outdated' && (status.needsLogin === true || connecting?.is === 'joined'))
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
