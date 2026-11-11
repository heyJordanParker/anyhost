import { basename } from 'node:path'

export type Roots = {
  readonly home: string
  readonly claudeHome: string
  readonly claudeTmp: string
  readonly codexHome: string
  readonly checkout: string
}

export function relocate(bytes: Uint8Array, path: string, from: Roots, to: Roots): { path: string; bytes: Uint8Array } {
  check(from, 'from')
  check(to, 'to')
  if (ROOTS.every((key) => from[key] === to[key])) return { path, bytes }
  const plain = new Relocation(from, to, (text) => text)
  const moved = new TextDecoder().decode(plain.rewrite(encoder.encode(path)))
  if (path.startsWith(`${from.claudeHome}/file-history/`)) return { path: moved, bytes }
  if (path.endsWith('.jsonl') || path.endsWith('.json') || basename(path) === 'state_5.sqlite') return { path: moved, bytes: new Relocation(from, to, jsonText).rewrite(bytes) }
  return { path: moved, bytes: isText(bytes) ? plain.rewrite(bytes) : bytes }
}

const ROOTS = ['home', 'claudeHome', 'claudeTmp', 'codexHome', 'checkout'] as const

function check(roots: Roots, name: string) {
  for (const key of ROOTS) {
    const value = roots[key]
    if (!value.startsWith('/') || (value.length > 1 && value.endsWith('/'))) throw new Error(`relocate: ${name}.${key} must be an absolute path without a trailing slash, got ${JSON.stringify(value)}`)
  }
}

const encoder = new TextEncoder()

const isText = (bytes: Uint8Array): boolean => !bytes.subarray(0, 8000).includes(0)

const jsonText = (text: string): string => JSON.stringify(text).slice(1, -1)
const encode = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-')
function forms(path: string): string[] {
  if (/^\/private\/(?:etc|tmp|var)(?:\/|$)/.test(path)) return [path, path.slice('/private'.length)]
  if (/^\/(?:etc|tmp|var)(?:\/|$)/.test(path)) return [path, `/private${path}`]
  return [path]
}

const SLASH = 0x2f
const BACKSLASH = 0x5c
const isPathByte = (byte: number): boolean => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x2e || byte === 0x5f || byte === 0x2d
const isNameByte = (byte: number): boolean => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x2d

type Root = { readonly from: Buffer; readonly to: Buffer }
type Match = { readonly end: number; readonly with: Buffer }

class Relocation {
  readonly roots: Root[]
  readonly encoded: { readonly from: string; readonly to: string }[]
  readonly needles: Buffer[]

  constructor(from: Roots, to: Roots, form: (text: string) => string) {
    const checkout: [string, string][] = from.checkout === from.home ? [] : [[from.checkout, to.checkout]]
    const namedAfter: [string, string][] = [...checkout, [from.claudeTmp, to.claudeTmp], [from.home, to.home]]
    const pairs: [string, string][] = [[from.claudeHome, to.claudeHome], [from.codexHome, to.codexHome], ...namedAfter]
    this.roots = pairs
      .flatMap(([a, b]) => forms(a).map((alias) => ({ from: Buffer.from(form(alias)), to: Buffer.from(form(b)) })))
      .sort((a, b) => b.from.length - a.from.length)
    this.encoded = namedAfter.flatMap(([a, b]) => forms(a).map((alias) => ({ from: encode(alias), to: encode(b) }))).sort((a, b) => b.from.length - a.from.length)
    const starts = [...new Set([...this.roots.map((root) => root.from.toString()), ...this.encoded.map((name) => name.from)])]
    this.needles = starts.filter((start) => !starts.some((other) => other !== start && start.startsWith(other))).map((start) => Buffer.from(start))
  }

  rewrite(bytes: Uint8Array): Uint8Array {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const next = this.needles.map((needle) => buffer.indexOf(needle))
    const parts: Uint8Array[] = []
    let copied = 0
    for (;;) {
      let at = -1
      for (const position of next) if (position >= 0 && (at < 0 || position < at)) at = position
      if (at < 0) break
      const match = this.matchAt(buffer, at)
      if (match !== undefined) {
        parts.push(buffer.subarray(copied, at), match.with)
        copied = match.end
      }
      const after = match?.end ?? at + 1
      for (let i = 0; i < next.length; i++) if (next[i]! >= 0 && next[i]! < after) next[i] = buffer.indexOf(this.needles[i]!, after)
    }
    if (parts.length === 0) return bytes
    parts.push(buffer.subarray(copied))
    return Buffer.concat(parts)
  }

  matchAt(buffer: Buffer, at: number): Match | undefined {
    if (!startsPath(buffer, at)) return undefined
    for (const root of this.roots) {
      const end = at + root.from.length
      if (end <= buffer.length && buffer.compare(root.from, 0, root.from.length, at, end) === 0 && endsRoot(buffer, end)) return { end, with: root.to }
    }
    let end = at
    while (end < buffer.length && isNameByte(buffer[end]!)) end++
    const name = buffer.toString('latin1', at, end)
    const renamed = this.encodedName(name)
    return renamed === name ? undefined : { end, with: Buffer.from(renamed) }
  }

  encodedName(name: string): string {
    if (!this.encoded.some(({ from }) => partAt(name, 0, from))) return name
    let out = ''
    let at = 0
    while (at < name.length) {
      const hit = at === 0 || name[at - 1] === '-' ? this.encoded.find(({ from }) => partAt(name, at, from)) : undefined
      if (hit === undefined) {
        out += name[at]
        at++
        continue
      }
      out += hit.to
      at += hit.from.length
    }
    return out
  }
}

const partAt = (name: string, at: number, part: string): boolean => name.startsWith(part, at) && (at + part.length === name.length || name[at + part.length] === '-')

function startsPath(buffer: Buffer, at: number): boolean {
  if (at === 0) return true
  let backslashes = 0
  for (let i = at - 2; i >= 0 && buffer[i] === BACKSLASH; i--) backslashes++
  if (backslashes % 2 === 1) return true
  if (at >= 6 && buffer[at - 6] === BACKSLASH && buffer[at - 5] === 0x75) return !isPathCode(buffer.toString('latin1', at - 4, at))
  return !isPathByte(buffer[at - 1]!)
}

function endsRoot(buffer: Buffer, end: number): boolean {
  if (end >= buffer.length || buffer[end] === SLASH) return true
  if (buffer[end] !== BACKSLASH) return !isPathByte(buffer[end]!)
  if (buffer[end + 1] === 0x75) return !isPathCode(buffer.toString('latin1', end + 2, end + 6))
  return true
}

const isPathCode = (hex: string): boolean => {
  const code = parseInt(hex, 16)
  return code !== SLASH && code < 0x80 && isPathByte(code)
}
