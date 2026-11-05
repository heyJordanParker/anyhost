// Bundles the relay into the one ES module Cloudflare runs, which the program uploads as the Worker's `relay.js` and
// the tests run in workerd. `bun build.ts <file>` writes it to that file.
import { join } from 'node:path'

export async function bundleRelay(): Promise<string> {
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, 'worker.ts')], target: 'browser', format: 'esm', external: ['cloudflare:workers'] })
  if (!built.success) throw new AggregateError(built.logs, 'The relay failed to bundle.')
  const [module, ...more] = built.outputs
  if (module === undefined || more.length > 0) throw new Error(`The relay bundled into ${built.outputs.length} files, not one.`)
  return await module.text()
}

if (import.meta.main) {
  const [file] = process.argv.slice(2)
  if (file === undefined) throw new Error('Name the file to write the relay to: bun build.ts <file>.')
  await Bun.write(file, await bundleRelay())
}
