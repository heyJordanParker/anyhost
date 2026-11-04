import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Code } from '../src/capture.ts'
import type { Release } from '../src/resume.ts'
import type { Store, Stored } from '../src/store.ts'

// The stand-in for the working folder's code: nothing to record, and the session continues in the folder it names.
export const noCode: Code = { captureCode: async () => undefined, restoreCode: async (_header, _readPart, folder) => folder }

// The stand-in for the ssh message a restore sends the machine that held the session: none, so no test reaches ssh,
// and the machine that held it hears nothing.
export const noRelease: Release = async () => false

export type MemoryStore = Store & { readonly objects: Map<string, Stored>; readonly puts: { key: string; body: Uint8Array }[]; now: number }

// the bucket every memory store stands for
export const MEMORY = 'memory'

export function memoryStore(): MemoryStore {
  const objects = new Map<string, Stored>()
  const puts: { key: string; body: Uint8Array }[] = []
  let version = 0
  const store: MemoryStore = {
    bucket: MEMORY,
    objects,
    puts,
    now: Date.now(),
    get: async (key) => objects.get(key),
    async put(key, body, condition) {
      const held = objects.get(key)
      if (condition !== undefined && ('ifMatch' in condition ? held?.etag !== condition.ifMatch : held !== undefined)) return undefined
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body)
      const etag = `"${(version += 1)}"`
      objects.set(key, { body: bytes, etag, modifiedAt: store.now })
      puts.push({ key, body: bytes })
      return etag
    },
    list: async (prefix) => [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, { body }]) => ({ key, size: body.length })).sort((a, b) => a.key.localeCompare(b.key)),
    async delete(keys) {
      for (const key of keys) objects.delete(key)
    },
  }
  return store
}

export const temporaryFolder = (): string => mkdtempSync(join(tmpdir(), 'anyhost-test-'))
