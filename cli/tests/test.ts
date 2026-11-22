import { test as bunTest } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'

type Body<Args extends unknown[]> = (...args: Args) => unknown
const endings = new AsyncLocalStorage<(() => unknown)[]>()

export function whenTestEnds(end: () => unknown): void {
  const ends = endings.getStore()
  if (ends === undefined) throw new Error('whenTestEnds runs inside a test of tests/test.ts, which runs each ending when the test ends.')
  ends.push(end)
}

const scoped =
  <Args extends unknown[]>(body: Body<Args>) =>
  (...args: Args): Promise<void> =>
    endings.run([], async () => {
      try {
        await body(...args)
      } finally {
        for (const end of (endings.getStore() ?? []).reverse()) await end()
      }
    })

type Each = {
  <const Row extends readonly unknown[]>(rows: readonly Row[]): (name: string, body: (...row: [...Row]) => unknown, timeout?: number) => void
  <const Row>(rows: readonly Row[]): (name: string, body: (row: Row) => unknown, timeout?: number) => void
}

const each =
  (run: typeof bunTest.each): Each =>
  (rows: readonly unknown[]) =>
  (name: string, body: Body<never[]>, timeout?: number): void =>
    run(rows)(name, scoped(body) as never, timeout)

const serial = (name: string, body: Body<[]>, timeout?: number): void => bunTest.serial(name, scoped(body), timeout)

export const test = Object.assign((name: string, body: Body<[]>, timeout?: number): void => bunTest(name, scoped(body), timeout), { each: each(bunTest.each.bind(bunTest)), serial })
