import { defineMod, device, http, sessions } from '../node_modules/@cmodjs/core/mod.js'
import { program } from '../node_modules/@cmodjs/core/jobs/program.js'
import { option } from '../node_modules/@cmodjs/core/options.js'

// The program's /claims/<session> answer: the machine that took the session over, or why this machine captures nothing.
// `untold`, answered once, is the machine this one took the session from while that machine was not connected.
type Holder = { readonly machine?: string; readonly problem?: string; readonly untold?: string }

export const anyhost = defineMod({
  name: 'anyhost',
  // The anyhost program reads them with cmod options: uploadEvery within a minute of a change, since one program
  // serves every session, and checkouts at each anyhost resume.
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
  },

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
    const shown = new Set<string>()
    const showOnce = (message: string, description: string): void => {
      if (shown.has(message)) return
      shown.add(message)
      mod.toast.error(message, { description, duration: Infinity })
    }
    const holderOf = async (address: { url: string; socketPath?: string }): Promise<Holder> => {
      const answer = await http.fetch(`${address.url}/claims/${sessions.current.id}`, address.socketPath === undefined ? {} : { socketPath: address.socketPath })
      if (!answer.ok) throw new Error(`The anyhost program answered ${answer.status}: ${answer.text}`)
      return JSON.parse(answer.text) as Holder
    }
    const check = async (): Promise<Holder> => {
      const address = await capture.ready().catch(() => undefined)
      if (address === undefined) return {}
      const holder = await holderOf(address).catch((error: unknown): Holder => {
        showOnce('anyhost could not check which machine holds this session', error instanceof Error ? error.message : String(error))
        return {}
      })
      if (holder.problem !== undefined) showOnce('anyhost captures nothing on this machine', holder.problem)
      if (holder.untold !== undefined) {
        mod.toast.warning(`${holder.untold} may take one more prompt of this session`, {
          description: `${holder.untold}'s anyhost was not connected when this machine took the session, so it learns that this machine holds the session when it next connects.`,
          duration: Infinity,
        })
      }
      return holder
    }
    // a session anyhost resume opened after a takeover says at once when the machine it came from did not hear of it
    sessions.current.onSessionStart(async () => void (await check()))
    // The program answers from its own record of the session's holder, in milliseconds and with no network, so the
    // listener keeps cmod's default of 10 s, which only a program still starting comes near.
    sessions.current.beforePrompt(async () => {
      const { machine } = await check()
      return machine === undefined ? undefined : { refuse: `This session continues on ${machine}.` }
    })
  },
})
