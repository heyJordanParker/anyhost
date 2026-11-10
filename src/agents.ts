import { tool } from '../node_modules/@cmodjs/core/jobs/tool.js'
import { sessions, type Mod } from '../node_modules/@cmodjs/core/mod.js'
import { askProgram, type AnyhostState } from './pages/machines.js'

// An agent as the program's /agents lists it, cut to what Claude reads to pick one. `status` is what it does on the
// machine that runs it now, and empty when it runs nowhere.
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
}
type Machines = { readonly here: string; readonly machines: readonly { readonly id: string; readonly name: string; readonly connected: boolean; readonly seenAt: string }[] }
type Told = { readonly machine: string; readonly session: string; readonly status: string; readonly screen: string }

const AGENT = { type: 'string', description: 'The agent id, or its first 8 characters.' } as const
const WAKES = 'An agent that sleeps, as each does 15 minutes after its last turn, wakes at the message, works, and sleeps again on its own.'

// The tools that let Claude manage every agent of every machine through this machine's anyhost program, so a session
// that manages others, such as a CTO or a project manager, does what a person does in the Herdr app.
export function agentTools(mod: Mod<AnyhostState>) {
  const tell = (agent: string, told: { readonly text?: string; readonly keys?: readonly string[]; readonly lines?: number; readonly sender?: string }): Promise<Told> =>
    askProgram<Told>(mod, '/agents/tell', { session: agent, ...told })
  return [
    tool({
      name: 'list_machines',
      description: 'List every machine joined to your relay: its name, whether it is connected, and when it was last seen. `here` is the id of this machine.',
      execute: () => askProgram<Machines>(mod, '/machines'),
    }),
    tool({
      name: 'add_machine',
      description: 'Make a one-time invite that joins one more machine within 10 minutes. Give the person the command to paste on that machine.',
      execute: () => askProgram<{ readonly command: string; readonly expiresAt: string }>(mod, '/machines/invite', {}),
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
        'List the Claude Code and Codex agents of every machine, newest first: id, title, first prompt, the machine that last ran it, the machine that holds it, its status, last activity, repository and folder. The status is working, idle, waiting (at a permission prompt, which press_keys answers), asleep (its Claude Code process ended while it rests, and a message wakes it), or empty when it runs on no connected machine.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, description: 'How many to list, 30 by default.' } } },
      execute: async ({ limit = 30 }) => {
        const { agents } = await askProgram<{ readonly agents: readonly Agent[] }>(mod, '/agents')
        return agents.slice(0, limit).map(({ id, tool: kind, title, firstPrompt, machine, holder, status, lastActivity, repo, cwd }) => ({ id, tool: kind, title, firstPrompt: firstPrompt.slice(0, 200), machine, holder, status, lastActivity, repo, cwd }))
      },
    }),
    tool({
      name: 'start_agent',
      description: `Start a new Claude Code agent on a machine, this one when machine is left out, in its checkout of the repository the folder is in, and type prompt into it as its first message. Answers the agent's id. ${WAKES}`,
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'An absolute folder on this machine. Another machine works in its own checkout of the same repository.' },
          machine: { type: 'string', description: 'The machine name, from list_machines.' },
          prompt: { type: 'string', description: 'The first message the agent gets.' },
        },
        required: ['folder'],
      },
      execute: ({ folder, machine = '', prompt = '' }) => askProgram<{ readonly session: string; readonly machine: string }>(mod, '/new', { folder, machine, prompt }),
    }),
    tool({
      name: 'tell_agent',
      description: `Send an agent a message wherever it runs: anyhost types it into its terminal and presses Enter, then answers its status and screen once its turn started. The message names this agent as its sender, so the other agent answers with tell_agent when it is done or stuck. A message that starts with / runs that slash command in it, as /exit. An agent waiting at a permission prompt refuses messages until press_keys answers it. ${WAKES}`,
      inputSchema: { type: 'object', properties: { agent: AGENT, text: { type: 'string' } }, required: ['agent', 'text'] },
      execute: ({ agent, text }) => tell(agent, { text, sender: sessions.current.id }),
    }),
    tool({
      name: 'read_agent',
      description: 'Read the status and screen of an agent wherever it runs, without waking it.',
      inputSchema: { type: 'object', properties: { agent: AGENT, lines: { type: 'integer', minimum: 0, description: 'Lines of history above the screen, 0 by default. herdr-core reads history only while the agent is not working.' } }, required: ['agent'] },
      execute: ({ agent, lines = 0 }) => tell(agent, { lines }),
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
        const [{ agents }, { here, machines }] = await Promise.all([askProgram<{ readonly agents: readonly Agent[] }>(mod, '/agents'), askProgram<Machines>(mod, '/machines')])
        const found = agents.find(({ id }) => id.startsWith(agent))
        if (found === undefined) throw new Error(`No agent's id begins with ${agent}. list_agents lists them.`)
        const runsOn = found.holder || found.machine
        if (runsOn === machines.find(({ id }) => id === here)?.name) return await askProgram<{ readonly session: string; readonly line: string }>(mod, '/move', { session: found.id, machine })
        // the machine that runs the agent holds its upload queue, so the move runs there, typed into the agent
        await tell(found.id, { text: `/move ${machine}` })
        return `${runsOn} moves ${found.id.slice(0, 8)} to ${machine} once its turn ends. read_agent shows how it goes.`
      },
    }),
    tool({
      name: 'take_agent',
      description: 'Continue an agent on this machine from its history in R2, as when the machine that runs it sleeps, is offline or died. That machine stops its copy as it next connects. move_agent moves an agent whose machine is connected without that.',
      inputSchema: { type: 'object', properties: { agent: AGENT }, required: ['agent'] },
      execute: ({ agent }) => askProgram<{ readonly session: string; readonly machine: string }>(mod, '/agents/take', { session: agent }),
    }),
  ]
}
