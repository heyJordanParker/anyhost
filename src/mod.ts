import { defineMod, device, messageOf, sessions } from '../node_modules/@cmodjs/core/mod.js'
import { program } from '../node_modules/@cmodjs/core/jobs/program.js'
import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'
import { option } from '../node_modules/@cmodjs/core/options.js'
import { agentTools } from './agents.js'
import { askProgram, connectStep, FOLLOW_MS, initialState, machinesPage, reachProgram, showMachines, toggleMachines } from './pages/machines.js'

// A move of the session the program runs or ran: the machine it goes to, its step and the line that says it. It copies
// `Moving` of `cli/src/move.ts`, as `cmod check`'s compile against Claude Code's API refuses `cli/src/`.
type Move = { readonly to: string; readonly step: 'waiting' | 'uploading' | 'moving' | 'moved' | 'failed'; readonly line: string }
// The program's /claims/<session> answer: the machine that took the session over, or why this machine captures nothing,
// and the session's move. `untold`, answered once, is the machine this one took the session from while that machine was
// not connected.
type Holder = { readonly machine?: string; readonly problem?: string; readonly untold?: string; readonly move?: Move }

// The machines list reads again while /machines is open, as a machine connects or leaves.
const MACHINES_EVERY_MS = 10_000
// The program answers /claims from its memory in milliseconds, so only a program that is busy or starting keeps a
// prompt waiting past PROMPT_ASK_MS, and the prompt then goes on with the mod's last answer of it. PROMPT_MS bounds the
// listener itself, so nothing holds a prompt longer.
const PROMPT_ASK_MS = 1500
const PROMPT_MS = 3000
const MOVING = new Set<Move['step']>(['waiting', 'uploading', 'moving'])

export const anyhost = defineMod({
  name: 'anyhost',
  state: initialState,
  // The anyhost program reads them with cmod options: uploadEvery within a minute of a change, since one program
  // serves every session, checkouts at each anyhost resume, and join at its start and within a minute of a change.
  options: {
    uploadEvery: option.number({
      title: 'Upload every',
      description: 'Seconds between uploads of a session to your Cloudflare account. 0 uploads every write.',
      default: 5,
      min: 0,
    }),
    checkouts: option.folder({
      title: 'Checkouts folder',
      description: 'Where anyhost resume clones a repository this machine lacks. Empty: the folder your checkouts share, else your home folder.',
      default: '',
    }),
    join: option.text({
      title: 'Join with',
      description: 'An invite link, which Add a machine sets as it installs anyhost here, or anyhost machines --invite prints on a joined machine. anyhost joins this machine with it within a minute, then empties it.',
      default: '',
    }),
  },
  installer: [connectStep],

  async setup(mod) {
    const here = await device.read()
    // a service of the computer, so capture runs from login on, with no Claude Code open
    const capture = mod.use(
      program({
        command: ['anyhost', 'serve'],
        environment: { ANYHOST_DEVICE_ID: here.id, ANYHOST_DEVICE_NAME: here.name, ANYHOST_DEVICE_OS: here.os, ANYHOST_DEVICE_ARCH: here.arch },
        isService: true,
      }),
    )
    reachProgram(mod, capture)
    for (const job of agentTools(mod)) mod.use(job)
    const page = mod.sidebar.add(machinesPage)
    mod.use(
      slashCommand({
        name: 'machines',
        description: 'Show every machine joined to your relay, add a machine, or remove one',
        reply: () => toggleMachines(mod, page),
      }),
    )
    mod.every(MACHINES_EVERY_MS, () => (page.isOpen ? showMachines(mod) : undefined))
    const shown = new Set<string>()
    const showOnce = (message: string, description: string): void => {
      if (shown.has(message)) return
      shown.add(message)
      mod.toast.error(message, { description, duration: Infinity })
    }
    // The program's last answer of each session's holder and move, which a prompt goes on with while the program is slow.
    const known = new Map<string, Holder>()
    // the sessions whose move a toast follows now
    const following = new Set<string>()
    const check = async (): Promise<Holder | undefined> => {
      const session = sessions.current.id
      if ((await capture.ready().catch(() => undefined)) === undefined) return undefined
      const holder = await askProgram<Holder>(mod, `/claims/${session}`).catch((error: unknown) => {
        showOnce('anyhost could not check which machine holds this session', messageOf(error))
        return undefined
      })
      if (holder === undefined) return undefined
      known.set(session, holder)
      if (holder.problem !== undefined) showOnce('anyhost captures nothing on this machine', holder.problem)
      if (holder.untold !== undefined) {
        mod.toast.warning(`${holder.untold} may take one more prompt of this session`, {
          description: `${holder.untold}'s anyhost was not connected when this machine took the session, so it learns that this machine holds the session when it next connects.`,
          duration: Infinity,
        })
      }
      // a move another command asked for, as anyhost move, gets the toast and its Keep it here too
      if (holder.move !== undefined && MOVING.has(holder.move.step)) follow()
      return holder
    }
    // a session anyhost resume opened after a takeover says at once when the machine it came from did not hear of it
    sessions.current.onSessionStart(async () => void (await check()))
    const continuesOn = (machine: string): string => `This session continues on ${machine}, in a terminal of herdr-core there. The anyhost pane of the Herdr app opens it.`
    // The prompt waits PROMPT_ASK_MS at most for the program's answer, else goes on with the last one, so a move this
    // session asked for refuses the prompt even while the program is busy with it. The check it gave up on still
    // records its answer once it comes. A session that moved and still shows here says where to go on with it.
    sessions.current.beforePrompt(
      async () => {
        const session = sessions.current.id
        const answered = await new Promise<Holder | undefined>((resolve) => {
          const late = mod.after(PROMPT_ASK_MS, () => resolve(undefined))
          void check().then((holder) => {
            late.stop()
            resolve(holder)
          })
        })
        const { machine, move } = answered ?? known.get(session) ?? {}
        if (move !== undefined && MOVING.has(move.step)) return { refuse: `This session is moving to ${move.to}.` }
        if (machine === undefined) return undefined
        return { refuse: move?.step === 'moved' ? continuesOn(machine) : `This session continues on ${machine}.` }
      },
      { timeoutMs: PROMPT_MS, onFailure: 'pass' },
    )

    // /move asks the program, which drains, seals and sends the session, and its toast follows each step: the
    // session's own Claude Code ends once the session runs there, and each prompt it still takes is refused. Until the machine
    // answers, Keep it here ends the move and keeps the session here. One toast follows a session's move, whether this
    // session's /move or a check that found it running asked for it.
    const follow = (): void => {
      const session = sessions.current.id
      if (following.has(session)) return
      following.add(session)
      const toast = `move-${session}`
      // the step and line the toast draws now
      let drawn = ''
      const end = (): void => {
        timer.stop()
        following.delete(session)
      }
      const timer = mod.every(FOLLOW_MS, async () => {
        const holder = await askProgram<Holder>(mod, `/claims/${session}`).catch((error: unknown) => {
          mod.log(`anyhost could not follow the move of ${session}: ${messageOf(error)}`, { level: 'warning' })
          return undefined
        })
        // a failed ask is asked again at the next tick
        if (holder === undefined) return
        known.set(session, holder)
        const { move } = holder
        // the program keeps its moves in memory only, so one that restarted knows this move no more
        if (move === undefined) {
          end()
          mod.toast.error('anyhost lost track of the move, as its program restarted', { id: toast, description: 'anyhost list shows which machine holds the session now.', duration: Infinity })
          return
        }
        if (`${move.step} ${move.line}` === drawn) return
        drawn = `${move.step} ${move.line}`
        if (move.step === 'moved') mod.toast.info(continuesOn(move.to), { id: toast, description: move.line, duration: Infinity })
        else if (move.step === 'failed') mod.toast.error(move.line, { id: toast, duration: Infinity })
        else {
          const keep = { label: 'Keep it here', onClick: () => askProgram(mod, '/move/keep', { session }) }
          mod.toast.loading(`Moving to ${move.to}…`, { id: toast, description: move.line, action: keep })
        }
        if (!MOVING.has(move.step)) end()
      })
    }
    mod.use(
      slashCommand({
        name: 'move',
        description: 'Move this session to another of your machines, which runs it from then on',
        argumentHint: '<machine>',
        reply: async ({ positionals }) => {
          const [machine, ...more] = positionals
          if (machine === undefined || more.length > 0) return 'Name the one machine to move this session to, as in /move devbox. /machines lists your machines.'
          const session = sessions.current.id
          const { to, step, line } = await askProgram<Move>(mod, '/move', { session, machine })
          // the next prompt is refused from here on, before the program answers again
          known.set(session, { ...known.get(session), move: { to, step, line } })
          mod.toast.loading(`Moving to ${machine}…`, { id: `move-${session}` })
          follow()
          return undefined
        },
      }),
    )
  },
})
