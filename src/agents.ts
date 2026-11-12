import { tool } from '../node_modules/@cmodjs/core/jobs/tool.js'
import { sessions, type Mod } from '../node_modules/@cmodjs/core/mod.js'
import { askProgram, type AnyhostState } from './pages/machines.js'

type Agent = {
  readonly id: string
  readonly tool: string
  readonly title: string
  readonly firstPrompt: string
  readonly machine: string
  readonly holder: string
  readonly status: string
  readonly lastActivity: string
  readonly repo: string
  readonly cwd: string
  readonly archived: boolean
  readonly parent: string
}
type Message = { readonly role: 'user' | 'assistant'; readonly at: string; readonly text: string }
type Machines = { readonly here: string; readonly machines: readonly { readonly id: string; readonly name: string; readonly connected: boolean; readonly seenAt: string }[] }
type Told = { readonly machine: string; readonly session: string; readonly status: string; readonly screen: string; readonly messages?: readonly Message[] }

const AGENT = { type: 'string', description: 'The agent id, or its first 8 characters.' } as const
const WAKES = 'An idle agent takes the message at once, works, and rests again on its own.'

export function agentTools(mod: Mod<AnyhostState>) {
  const tell = (agent: string, told: { readonly text?: string; readonly keys?: readonly string[]; readonly lines?: number; readonly messages?: number; readonly sender?: string }): Promise<Told> =>
    askProgram<Told>(mod, '/agents/tell', { session: agent, ...told })
  const agentsNow = async (): Promise<readonly Agent[]> => (await askProgram<{ readonly agents: readonly Agent[] }>(mod, '/agents')).agents
  const found = (agents: readonly Agent[], agent: string): Agent => {
    const matches = agents.filter(({ id }) => id.startsWith(agent))
    if (matches[0] === undefined) throw new Error(`No agent's id begins with ${agent}. list_agents lists them.`)
    if (matches.length > 1) throw new Error(`${matches.length} agents' ids begin with ${agent}. Give more of it.`)
    return matches[0]
  }
  return [
    tool({
      name: 'list_machines',
      description:
        'List every machine joined to your relay: its name, whether it is connected, and when it was last seen. `here` is the id of this machine. `candidates` are machines on your Tailscale network not joined yet, which add_machine adds, and `adding` the adds still running, with why one failed.',
      execute: () => askProgram<Machines>(mod, '/machines'),
    }),
    tool({
      name: 'add_machine',
      description:
        'Add a machine this one reaches over ssh: anyhost installs herdr-core, cmod and anyhost there and joins it to your relay, and every machine then shows its agents and terminals. It takes a few minutes and runs on after this call: list_machines shows it under adding until it joins, or why it failed.',
      inputSchema: { type: 'object', properties: { target: { type: 'string', description: 'How ssh reaches the machine: a Host of the ssh config, a Tailscale name such as mac-studio, or user@host.' } }, required: ['target'] },
      execute: async ({ target }) => {
        await askProgram(mod, '/machines/add', { target })
        return `Adding ${target}. list_machines shows it under adding until it joins.`
      },
    }),
    tool({
      name: 'remove_machine',
      description: 'Remove a machine from your relay by its name. Its agents stay listed and can be taken onto another machine.',
      inputSchema: { type: 'object', properties: { machine: { type: 'string' } }, required: ['machine'] },
      execute: async ({ machine }) => {
        const found = (await askProgram<Machines>(mod, '/machines')).machines.find((each) => each.name === machine)
        if (found === undefined) throw new Error(`No machine joined to your relay is named ${machine}.`)
        await askProgram(mod, '/machines/remove', { id: found.id })
        return `Removed ${machine}.`
      },
    }),
    tool({
      name: 'list_agents',
      description:
        "List the Claude Code and Codex agents of every machine, newest first: id, title, first prompt, the machine that last ran it, the machine that holds it, its status, last activity, repository, folder, whether it is archived, and its parent: the agent that started it with start_agent, with that agent's title and the machine that holds it, or null. The status is working, idle, waiting (at a permission prompt, which press_keys answers), or empty when it runs on no connected machine. Archived agents are left out unless archived is true. children_of lists only the agents one agent started, `me` the ones this agent started.",
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, description: 'How many to list, 30 by default.' },
          archived: { type: 'boolean', description: 'List archived agents too.' },
          children_of: { type: 'string', description: 'An agent id, its first 8 characters, or `me`: list only the agents it started.' },
        },
      },
      execute: async ({ limit = 30, archived = false, children_of: childrenOf }) => {
        const agents = await agentsNow()
        const parent = childrenOf === undefined ? undefined : childrenOf === 'me' ? sessions.current.id : found(agents, childrenOf).id
        const byId = new Map(agents.map((agent) => [agent.id, agent]))
        return agents
          .filter((agent) => (archived || !agent.archived) && (parent === undefined || agent.parent === parent))
          .slice(0, limit)
          .map(({ id, tool: kind, title, firstPrompt, machine, holder, status, lastActivity, repo, cwd, archived: isArchived, parent: startedBy }) => {
            const starter = byId.get(startedBy)
            return {
              id,
              tool: kind,
              title,
              firstPrompt: firstPrompt.slice(0, 200),
              machine,
              holder,
              status,
              lastActivity,
              repo,
              cwd,
              archived: isArchived,
              parent: startedBy === '' ? null : { id: startedBy, title: starter?.title || starter?.firstPrompt.slice(0, 80) || '', machine: starter === undefined ? '' : starter.holder || starter.machine },
            }
          })
      },
    }),
    tool({
      name: 'start_agent',
      description: `Start a new Claude Code agent on a machine, this one when machine is left out, in its checkout of the repository the folder is in, and type prompt into it as its first message. This agent becomes its parent: the prompt names this agent and its machine as its sender, so the new agent reports back with tell_agent when it is done or stuck, which wakes this agent, and list_agents lists it with children_of me. Answers the agent's id and machine. ${WAKES}`,
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'An absolute folder on this machine. Another machine works in its own checkout of the same repository.' },
          machine: { type: 'string', description: 'The machine name, from list_machines.' },
          prompt: { type: 'string', description: 'The first message the agent gets.' },
        },
        required: ['folder'],
      },
      execute: ({ folder, machine = '', prompt = '' }) => askProgram<{ readonly session: string; readonly machine: string }>(mod, '/new', { folder, machine, prompt, parent: sessions.current.id }),
    }),
    tool({
      name: 'tell_agent',
      description: `Send an agent a message wherever it runs: anyhost types it into its terminal and presses Enter, then answers its status and screen once its turn started. The message names this agent as its sender, so the other agent answers with tell_agent when it is done or stuck. A message that starts with / runs that slash command in it, as /exit. An agent waiting at a permission prompt refuses messages until press_keys answers it. ${WAKES}`,
      inputSchema: { type: 'object', properties: { agent: AGENT, text: { type: 'string' } }, required: ['agent', 'text'] },
      execute: ({ agent, text }) => tell(agent, { text, sender: sessions.current.id }),
    }),
    tool({
      name: 'read_agent',
      description:
        "Read an agent wherever it runs, without waking it: its status and screen, or with messages its last messages, what it was told and what it answered, from its conversation on the machine that holds it, running or not. An agent's answer to the task start_agent gave it is its last assistant message.",
      inputSchema: {
        type: 'object',
        properties: {
          agent: AGENT,
          lines: { type: 'integer', minimum: 0, description: 'Lines of history above the screen, 0 by default. herdr-core reads history only while the agent is not working.' },
          messages: { type: 'integer', minimum: 1, description: 'Read this many of its last messages instead of its screen.' },
        },
        required: ['agent'],
      },
      execute: ({ agent, lines = 0, messages }) => tell(agent, messages === undefined ? { lines } : { messages }),
    }),
    tool({
      name: 'press_keys',
      description: 'Press named keys in an agent\'s terminal wherever it runs, then answer its status and screen: down and enter pick and answer a permission prompt, esc stops its turn. Names are enter, esc, tab, up, down, left, right, ctrl+c, a single character, and the like.',
      inputSchema: { type: 'object', properties: { agent: AGENT, keys: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['agent', 'keys'] },
      execute: ({ agent, keys }) => tell(agent, { keys }),
    }),
    tool({
      name: 'move_agent',
      description: 'Move an agent to another machine, which runs it from then on with its whole conversation and code. The machine that runs the agent moves it once its turn ends.',
      inputSchema: { type: 'object', properties: { agent: AGENT, machine: { type: 'string' } }, required: ['agent', 'machine'] },
      execute: async ({ agent, machine }) => {
        const [agents, { here, machines }] = await Promise.all([agentsNow(), askProgram<Machines>(mod, '/machines')])
        const moved = found(agents, agent)
        const runsOn = moved.holder || moved.machine
        if (runsOn === machines.find(({ id }) => id === here)?.name) return await askProgram<{ readonly session: string; readonly line: string }>(mod, '/move', { session: moved.id, machine })
        await tell(moved.id, { text: `/move ${machine}` })
        return `${runsOn} moves ${moved.id.slice(0, 8)} to ${machine} once its turn ends. read_agent shows how it goes.`
      },
    }),
    tool({
      name: 'archive_agent',
      description: 'Archive an agent whose work is finished, which moves it out of the active list on every machine, or bring an archived one back with archived false. Working in an archived agent brings it back by itself.',
      inputSchema: { type: 'object', properties: { agent: AGENT, archived: { type: 'boolean', description: 'true by default.' } }, required: ['agent'] },
      execute: async ({ agent, archived = true }) => {
        const { id } = found(await agentsNow(), agent)
        await askProgram(mod, '/agents/archive', { session: id, archived })
        return `${archived ? 'Archived' : 'Brought back'} ${id.slice(0, 8)}.`
      },
    }),
    tool({
      name: 'delete_agent',
      description:
        'Delete an agent wherever it is held: the machine that holds it stops it, working or not, and deletes its conversation and files there and in R2, so every machine lists it under Deleted. Opening a deleted agent with open_agent brings it back. An agent cannot delete itself.',
      inputSchema: { type: 'object', properties: { agent: AGENT }, required: ['agent'] },
      execute: async ({ agent }) => {
        const { id } = found(await agentsNow(), agent)
        if (id === sessions.current.id) throw new Error(`${id.slice(0, 8)} is this agent, which cannot delete itself.`)
        await askProgram(mod, '/agents/delete', { session: id })
        return `Deleted ${id.slice(0, 8)}.`
      },
    }),
    tool({
      name: 'open_agent',
      description: 'Run an agent on this machine in a terminal of herdr-core and answer that terminal: the one it runs in when it runs here, else one that resumes it, from its history in R2 when another machine holds it, as when that machine is closed, offline or died, which then stops its copy as it next connects. move_agent moves an agent whose machine is connected without that.',
      inputSchema: { type: 'object', properties: { agent: AGENT }, required: ['agent'] },
      execute: ({ agent }) => askProgram<{ readonly session: string; readonly terminal: string; readonly machine: string }>(mod, '/agents/open', { session: agent }),
    }),
  ]
}
