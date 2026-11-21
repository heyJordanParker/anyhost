import { messageOf, type Mod, type View, type ViewInit } from '../../node_modules/@cmodjs/core/mod.js'
import { Box, Button, Input, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import type { Device as Machine } from '../../relay/protocol.ts'
import { askProgram } from '../program.js'
import type { AnyhostState, Machines } from '../state.js'

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

export async function toggleMachines(mod: Mod<AnyhostState>, view: View): Promise<void> {
  if (!view.isOpen) {
    mod.state.memory.isAdding = false
    mod.state.memory.removing = null
    void showMachines(mod)
  }
  await view.toggle({ focus: true })
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

export const machinesView: ViewInit<AnyhostState> = {
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
