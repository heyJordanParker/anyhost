import { tool } from '../node_modules/@cmodjs/core/jobs/tool.js'
import { sessions, type Mod } from '../node_modules/@cmodjs/core/mod.js'
import { askProgram } from './program.js'
import type { AnyhostState, Machines } from './state.js'

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
  readonly source: string
}
type Message = { readonly role: 'user' | 'assistant'; readonly at: string; readonly text: string }
type Told = { readonly machine: string; readonly session: string; readonly status: string; readonly screen: string; readonly messages?: readonly Message[] }

const AGENT = { type: 'string', description: 'The agent id, or its first 8 characters.' } as const
const WAKES = 'An idle agent takes the message at once, works, and rests again on its own.'

export function agentTools(mod: Mod<AnyhostState>) {
  const tell = (agent: string, told: { readonly text?: string; readonly keys?: readonly string[]; readonly lines?: number; readonly messages?: number; readonly skip?: number; readonly sleep?: boolean; readonly sender?: string }): Promise<Told> =>
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
        "List the Claude Code and Codex agents of every machine, newest first: id, title, first prompt, the machine that last ran it, the machine that holds it, its status, last activity, repository, folder, whether it is archived, its parent: the agent that started it with start_agent and manages it, and its source: the agent whose conversation it was forked from, each with that agent's title and the machine that holds it, or null. A fork has a source and no parent. The status is working, idle, waiting (at a permission prompt, which press_keys answers), or empty when it runs on no connected machine. tell_agent, read_agent's screen, press_keys and show_agent reach a Codex agent only while it runs in a terminal of herdr-core, and sleep_agent, read_agent's messages, move_agent and open_agent reach Claude Code agents alone. Archived agents are left out unless archived is true. children_of lists only the agents one agent started, `me` the ones this agent started.",
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
        const named = (agent: string): { readonly id: string; readonly title: string; readonly machine: string } | null => {
          const known = byId.get(agent)
          return agent === '' ? null : { id: agent, title: known?.title ?? '', machine: known === undefined ? '' : known.holder || known.machine }
        }
        return agents
          .filter((agent) => (archived || !agent.archived) && (parent === undefined || agent.parent === parent))
          .slice(0, limit)
          .map(({ id, tool: kind, title, firstPrompt, machine, holder, status, lastActivity, repo, cwd, archived: isArchived, parent: startedBy, source }) => ({
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
            parent: named(startedBy),
            source: named(source),
          }))
      },
    }),
    tool({
      name: 'start_agent',
      description: `Start a new Claude Code agent on a machine, this one when machine is left out, in its checkout of the repository the folder is in, and type prompt into it as its first message. It never reaches an agent that exists: to message one, find it with list_agents and use tell_agent, which wakes it wherever it sleeps, and when list_agents fails, call it again instead of starting an agent. This agent becomes its parent: the prompt names this agent and its machine as its sender, so the new agent reports back with tell_agent when it is done or stuck, which wakes this agent, and list_agents lists it with children_of me. Answers the agent's id and machine. ${WAKES}`,
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
        "Read an agent wherever it runs, without waking it: its status and screen, or with messages its conversation, what it was told and what it answered, from the machine that holds it, running or not. An agent's answer to the task start_agent gave it is its last assistant message, messages 1. skip pages back through its whole history.",
      inputSchema: {
        type: 'object',
        properties: {
          agent: AGENT,
          lines: { type: 'integer', minimum: 0, description: 'Lines of the terminal above the screen, 0 by default. herdr-core reads them only while the agent is not working.' },
          messages: { type: 'integer', minimum: 1, description: 'Read this many of its messages instead of its screen, the newest last.' },
          skip: { type: 'integer', minimum: 0, description: 'With messages: leave out this many of the newest first, 0 by default, so messages 20 skip 20 reads the 20 before the last 20.' },
        },
        required: ['agent'],
      },
      execute: ({ agent, lines = 0, messages, skip = 0 }) => tell(agent, messages === undefined ? { lines } : { messages, skip }),
    }),
    tool({
      name: 'sleep_agent',
      description:
        "Stop an agent wherever it runs: its Claude Code ends once its turn ends, and its terminal stays with its last reply, so its tab and place on screen stay. tell_agent wakes it with its whole conversation. press_keys esc stops a turn without stopping the agent.",
      inputSchema: { type: 'object', properties: { agent: AGENT }, required: ['agent'] },
      execute: async ({ agent }) => {
        const told = await tell(agent, { sleep: true })
        return `${told.session.slice(0, 8)} on ${told.machine} goes to sleep once its turn ends. It is ${told.status} now.`
      },
    }),
    tool({
      name: 'show_agent',
      description:
        "Show an agent's terminal on this machine's Herdr app, as a terminal multiplexer shows a pane: focus brings it on screen in its tab, peek shows it over the screen with Keep and Close, tab gives it a tab of its own, right and down show it live beside or below the person's focused pane, and hide takes its pane away while the agent runs on. An agent another machine runs shows from there; one that runs nowhere starts here.",
      inputSchema: {
        type: 'object',
        properties: { agent: AGENT, place: { type: 'string', enum: ['focus', 'peek', 'tab', 'right', 'down', 'hide'], description: 'focus by default.' } },
        required: ['agent'],
      },
      execute: ({ agent, place = 'focus' }) => askProgram<{ readonly session: string; readonly machine: string; readonly terminal: string }>(mod, '/agents/show', { session: agent, place }),
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
      name: 'settle_agent',
      description:
        'Settle an agent whose work rests, which moves it to the Settled shelf on every machine until its next message, and clears its pin and snooze, or with settled false keep it out of Settled until its next message, as an agent settles by itself once it sits idle the days the person chose.',
      inputSchema: { type: 'object', properties: { agent: AGENT, settled: { type: 'boolean', description: 'true by default.' } }, required: ['agent'] },
      execute: async ({ agent, settled = true }) => {
        await askProgram(mod, '/agents/settle', { session: agent, settled })
        return `${settled ? 'Settled' : 'Unsettled'} ${agent.slice(0, 8)}.`
      },
    }),
    tool({
      name: 'snooze_agent',
      description:
        'Snooze an agent on every machine until a time, which hides it on the Snoozed shelf until then, until a prompt reaches it, or until it waits for the person at a permission prompt. A finished turn never wakes it. until null wakes it now.',
      inputSchema: {
        type: 'object',
        properties: { agent: AGENT, until: { type: ['string', 'null'], description: 'The ISO time it wakes, such as 2026-11-16T09:00:00.000Z, or null to wake it now.' } },
        required: ['agent', 'until'],
      },
      execute: async ({ agent, until }) => {
        await askProgram(mod, '/agents/snooze', { session: agent, until })
        return until === null ? `Woke ${agent.slice(0, 8)}.` : `Snoozed ${agent.slice(0, 8)} until ${until}.`
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
      name: 'fork_agent',
      description:
        "Fork a Claude Code agent into a new agent that holds its conversation up to a message, by default its end, on the machine that holds it, titled after it with (fork), with the agent forked as its source in list_agents. A fork is an agent of its own, never a child of the agent forked. A fork at the end that nobody opens is a duplicate, and one at an earlier message a split. Its history refers to the source's and uploads only what it adds. open_agent or tell_agent then runs it.",
      inputSchema: {
        type: 'object',
        properties: { agent: AGENT, at: { type: 'string', description: "The uuid of the message the fork ends with, from the agent's transcript. Leave it out to fork at the end." } },
        required: ['agent'],
      },
      execute: ({ agent, at = '' }) => askProgram<{ readonly session: string; readonly machine: string }>(mod, '/agents/fork', { session: agent, at }),
    }),
    tool({
      name: 'open_agent',
      description: 'Run an agent on this machine in a terminal of herdr-core and answer that terminal: the one it runs in when it runs here, else one that resumes it, from its history in R2 when the machine that holds it is not connected, as when it is closed, offline or died, which then stops its copy as it next connects. An agent whose machine is connected stays there, and move_agent moves it.',
      inputSchema: { type: 'object', properties: { agent: AGENT }, required: ['agent'] },
      execute: ({ agent }) => askProgram<{ readonly session: string; readonly terminal: string; readonly machine: string }>(mod, '/agents/open', { session: agent }),
    }),
  ]
}
