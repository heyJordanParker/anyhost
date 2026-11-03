import { defineMod, device, http, sessions } from '../node_modules/@cmodjs/core/mod.js'
import { program } from '../node_modules/@cmodjs/core/jobs/program.js'

const HOLDER_CHECK_MS = 5000

export const anyhost = defineMod({
  name: 'anyhost',

  async setup(mod) {
    const here = await device.read()
    const capture = mod.use(
      program({
        command: ['anyhost', 'serve'],
        environment: { ANYHOST_DEVICE_ID: here.id, ANYHOST_DEVICE_NAME: here.name, ANYHOST_DEVICE_OS: here.os, ANYHOST_DEVICE_ARCH: here.arch },
        singleInstance: true,
      }),
    )
    let isProblemShown = false
    sessions.current.beforePrompt(
      async () => {
        const address = await capture.ready().catch(() => undefined)
        if (address === undefined) return undefined
        const answer = await http.fetch(`${address.url}/claims/${sessions.current.id}`, address.socketPath === undefined ? {} : { socketPath: address.socketPath })
        if (!answer.ok) throw new Error(`The anyhost program answered ${answer.status}: ${answer.text}`)
        const { machine, problem } = JSON.parse(answer.text) as { machine?: string; problem?: string }
        if (problem !== undefined && !isProblemShown) {
          isProblemShown = true
          mod.toast.error('anyhost captures nothing on this machine', { description: problem, duration: Infinity })
        }
        return machine === undefined ? undefined : { refuse: `This session continues on ${machine}.` }
      },
      { timeoutMs: HOLDER_CHECK_MS },
    )
  },
})
