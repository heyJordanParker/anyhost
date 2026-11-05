// The relay's bundle, which `bun run --cwd relay build` writes and `connect.ts` carries as text. TypeScript 7.0 has no
// type for an import `with { type: 'text' }`, which bun-types gives from TypeScript 7.1 on, and then this file goes.
declare module '*/relay/dist/relay.js' {
  const relay: string
  export default relay
}
