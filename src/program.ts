import { http, messageOf, type Mod } from '../node_modules/@cmodjs/core/mod.js'
import type { Program } from '../node_modules/@cmodjs/core/jobs/program.js'
import type { AnyhostState } from './state.js'

const READY_MS = 10_000
export const FOLLOW_MS = 1000

const programs = new WeakMap<object, Program>()
export const reachProgram = (mod: Mod<AnyhostState>, program: Program): void => void programs.set(mod, program)

export class NoAnswer extends Error {}

export async function askProgram<T>(mod: Mod<AnyhostState>, path: string, body?: object): Promise<T> {
  const program = programs.get(mod)
  if (program === undefined) throw new Error('The anyhost mod has not started its program yet.')
  const { url, socketPath } = await new Promise<Awaited<ReturnType<Program['ready']>>>((resolve, reject) => {
    const timer = mod.after(READY_MS, () => reject(new NoAnswer(`The anyhost program is restarting and did not answer ${path} within ${READY_MS / 1000} s. Ask again in a few seconds.`)))
    program.ready().then(
      (ready) => {
        timer.stop()
        resolve(ready)
      },
      (error: unknown) => {
        timer.stop()
        reject(error)
      },
    )
  })
  const answer = await http
    .fetch(`${url}${path}`, {
      ...(socketPath === undefined ? {} : { socketPath }),
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    .catch((error: unknown) => {
      throw new NoAnswer(`The anyhost program did not answer ${path}: ${messageOf(error)}`)
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
