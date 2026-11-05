import { basename } from 'node:path'

// A captured file holds the absolute paths of the machine that wrote it. `relocate`
// rewrites every one of them into this machine's, so a session restored under another
// home, user id, temp root or checkout reads as if it ran here: it opens its saved
// output, plan and background output, and keeps `/rewind`, up-arrow history and Codex
// resume.
//
// Every occurrence of a root is rewritten, wherever it sits: Claude Code's and Codex's own
// fields, tool results, the person's prompts, the model's text, thinking and tool calls.
// A root matches only at a path boundary, and so does an encoded folder name
// (`-Users-alice-app`, Claude Code's name for a folder) that starts with one.
//
// Nothing another party verifies breaks: the Messages API answers a conversation whose
// signed thinking or earlier turns changed by dropping that thinking
// (`input_transformations` `thinking_dropped`, `prefix_binding_mismatch`), as it does in
// any long session, and Claude Code never re-hashes a stored `api-request-blob` (its own
// secret scrubber edits them in place). Two kinds of file keep their bytes: the backups
// `/rewind` writes back into the person's files, and binary files.

export type Roots = {
  readonly home: string
  // Claude Code's own folder: `CLAUDE_CONFIG_DIR`, else `<home>/.claude`
  readonly claudeHome: string
  // Claude Code's per-user temp root: `/private/tmp/claude-501` on macOS, `/tmp/claude-1000` on Linux
  readonly claudeTmp: string
  readonly codexHome: string
  // the session's checkout, or the home when the session runs outside one
  readonly checkout: string
}

// The file this machine keeps for a file the writer kept at `path` on the machine with
// roots `from`, and where it keeps it.
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

// git's test for a binary file: a NUL byte in its first 8000 bytes. It holds for a record
// that starts or ends inside a character, as an appended `.output` record can.
const isText = (bytes: Uint8Array): boolean => !bytes.subarray(0, 8000).includes(0)

// a path as it sits between the quotes of a JSON string
const jsonText = (text: string): string => JSON.stringify(text).slice(1, -1)
// Claude Code names a folder after a path with every character but letters and digits as `-`
const encode = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-')
// macOS keeps /etc, /tmp and /var under /private, so a path names one folder in two forms: Claude Code writes the
// resolved one, such as a working folder of /private/tmp/trwork, and prompts and tool calls hold the other too
function forms(path: string): string[] {
  if (/^\/private\/(?:etc|tmp|var)(?:\/|$)/.test(path)) return [path, path.slice('/private'.length)]
  if (/^\/(?:etc|tmp|var)(?:\/|$)/.test(path)) return [path, `/private${path}`]
  return [path]
}

const SLASH = 0x2f
const BACKSLASH = 0x5c
// A path continues through letters, digits, `.`, `_` and `-`, so `/Users/al` is no root of `/Users/alice`.
const isPathByte = (byte: number): boolean => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x2e || byte === 0x5f || byte === 0x2d
const isNameByte = (byte: number): boolean => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x2d

type Root = { readonly from: Buffer; readonly to: Buffer }
type Match = { readonly end: number; readonly with: Buffer }

class Relocation {
  // longest first, so Claude Code's folder and the checkout win over the home they sit in
  readonly roots: Root[]
  readonly encoded: { readonly from: string; readonly to: string }[]
  // the bytes a match starts with: each root and encoded root that has no other as its prefix
  readonly needles: Buffer[]

  constructor(from: Roots, to: Roots, form: (text: string) => string) {
    // a session in the home folder has no checkout of its own: the home maps it
    const checkout: [string, string][] = from.checkout === from.home ? [] : [[from.checkout, to.checkout]]
    // the roots Claude Code names folders after
    const namedAfter: [string, string][] = [...checkout, [from.claudeTmp, to.claudeTmp], [from.home, to.home]]
    const pairs: [string, string][] = [[from.claudeHome, to.claudeHome], [from.codexHome, to.codexHome], ...namedAfter]
    this.roots = pairs
      .flatMap(([a, b]) => forms(a).map((alias) => ({ from: Buffer.from(form(alias)), to: Buffer.from(form(b)) })))
      .sort((a, b) => b.from.length - a.from.length)
    this.encoded = namedAfter.flatMap(([a, b]) => forms(a).map((alias) => ({ from: encode(alias), to: encode(b) }))).sort((a, b) => b.from.length - a.from.length)
    const starts = [...new Set([...this.roots.map((root) => root.from.toString()), ...this.encoded.map((name) => name.from)])]
    this.needles = starts.filter((start) => !starts.some((other) => other !== start && start.startsWith(other))).map((start) => Buffer.from(start))
  }

  // The bytes with every root and encoded root rewritten, or the same bytes when none is in them.
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

  // An encoded folder name that starts with an encoded root: each part that encodes the
  // checkout, the temp root or the home, starting and ending at a `-`, becomes the same
  // part of this machine. The encoding is lossy, so the checkout wins over the home it
  // sits in, and `-Users-alice-app-web` is the checkout's `web` folder.
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

// Boundaries read through JSON escapes: in "\n/Users/al" the path follows a line break,
// not the letter n, and a `\u` escape counts as the character it names.
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
