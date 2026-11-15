import { existsSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import type { Message } from '../../relay/protocol.ts'
import type { DataFolder, MachineRoots } from './device.ts'

export type Tool = 'claude' | 'codex' | 'mod'
export type Summary = {
  readonly title: string
  readonly titleRank: number
  readonly firstPrompt: string
  readonly cwd: string
  readonly repo: string
  readonly entrypoint: string
  readonly lastSaid: string
  readonly lastActivity: string
  readonly lastPromptAt: string
  readonly source: string
}
export const UNSUMMARIZED: Summary = { title: '', titleRank: 0, firstPrompt: '', cwd: '', repo: '', entrypoint: '', lastSaid: '', lastActivity: '', lastPromptAt: '', source: '' }

export type Owner =
  | { readonly session: string; readonly tool: Tool; readonly isTranscript: boolean }
  | { readonly prefix: string }
  | { readonly lines: string; readonly tool: Tool }
  | { readonly named: true }
  | { readonly mod: string }

const PROMPT_LENGTH = 300
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ROLLOUT = /^rollout-.*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/

const claudeFolder = (roots: MachineRoots, ...parts: string[]): string => join(roots.claudeHome, ...parts)

export const codexState = (roots: MachineRoots): string => join(roots.codexHome, 'state_5.sqlite')

export const linesFiles = (roots: MachineRoots): Map<string, { readonly lines: string; readonly tool: Tool }> =>
  new Map([
    [claudeFolder(roots, 'history.jsonl'), { lines: 'sessionId', tool: 'claude' }],
    [join(roots.codexHome, 'history.jsonl'), { lines: 'session_id', tool: 'codex' }],
    [join(roots.codexHome, 'session_index.jsonl'), { lines: 'id', tool: 'codex' }],
  ])

export const watchedFolders = (roots: MachineRoots): { readonly folder: string; readonly depth: number }[] => [
  { folder: claudeFolder(roots), depth: 1 },
  ...['projects', 'file-history', 'tasks', 'session-env', 'plans', 'paste-cache'].map((name) => ({ folder: claudeFolder(roots, name), depth: Infinity })),
  { folder: roots.claudeTmp, depth: 4 },
  { folder: roots.codexHome, depth: 1 },
  { folder: join(roots.codexHome, 'sessions'), depth: Infinity },
]

const isTransient = (path: string): boolean => basename(path).startsWith('.') || /\.tmp\.[0-9a-f]+$/.test(path)

export const historyOf = (mod: string, device: string): string => `${mod}@${device}`

type Rule = { readonly glob: Bun.Glob; readonly isNegated: boolean; readonly isFolderOnly: boolean }
const rulesOf = new WeakMap<readonly string[], readonly Rule[]>()

function isRebuildable(data: DataFolder, path: string): boolean {
  let rules = rulesOf.get(data.rebuildable)
  if (rules === undefined) {
    rules = data.rebuildable.flatMap((line) => {
      if (line.trim() === '' || line.startsWith('#')) return []
      const isNegated = line.startsWith('!')
      const pattern = (isNegated ? line.slice(1) : line).replace(/^\\(?=[#!])/, '')
      const body = pattern.replace(/\/+$/, '')
      return [{ glob: new Bun.Glob(body.includes('/') ? body.replace(/^\//, '') : `**/${body}`), isNegated, isFolderOnly: body !== pattern }]
    })
    rulesOf.set(data.rebuildable, rules)
  }
  const parts = path.slice(data.folder.length + 1).split(sep)
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const prefix = parts.slice(0, depth).join('/')
    const isFolder = depth < parts.length
    let isIgnored = false
    for (const rule of rules) if ((isFolder || !rule.isFolderOnly) && rule.glob.match(prefix)) isIgnored = !rule.isNegated
    if (isIgnored) return true
  }
  return false
}

export function ownerOf(path: string, roots: MachineRoots, folders: readonly DataFolder[] = []): Owner | undefined {
  const data = folders.find(({ folder }) => path.startsWith(folder + sep))
  if (data !== undefined) return isRebuildable(data, path) ? undefined : { mod: data.mod }
  const lines = linesFiles(roots).get(path)
  if (lines !== undefined) return lines
  if (isTransient(path)) return undefined
  const under = (folder: string): string[] => (path.startsWith(folder + sep) ? path.slice(folder.length + 1).split(sep) : [])
  const project = under(claudeFolder(roots, 'projects'))
  if (project.length === 2 && project[1]?.endsWith('.jsonl') === true) {
    const session = project[1].slice(0, -'.jsonl'.length)
    return ID.test(session) ? { session, tool: 'claude', isTranscript: true } : undefined
  }
  if (project.length > 2 && ID.test(project[1] ?? '')) return { session: project[1] ?? '', tool: 'claude', isTranscript: false }
  for (const name of ['file-history', 'session-env', 'tasks']) {
    const [folder = '', ...rest] = under(claudeFolder(roots, name))
    if (rest.length === 0) continue
    if (ID.test(folder)) return { session: folder, tool: 'claude', isTranscript: false }
    const prefix = /^session-([0-9a-f]{8})$/.exec(folder)?.[1]
    if (name === 'tasks' && prefix !== undefined) return { prefix }
  }
  if (under(claudeFolder(roots, 'plans')).length > 0 || under(claudeFolder(roots, 'paste-cache')).length === 1) return { named: true }
  const output = under(roots.claudeTmp)
  if (output.length === 4 && ID.test(output[1] ?? '') && output[2] === 'tasks' && output[3]?.endsWith('.output') === true) return { session: output[1] ?? '', tool: 'claude', isTranscript: false }
  const rollout = under(join(roots.codexHome, 'sessions')).length > 0 ? ROLLOUT.exec(basename(path))?.[1] : undefined
  if (rollout !== undefined) return { session: rollout, tool: 'codex', isTranscript: true }
  return undefined
}

const failedListings = new Set<string>()
const listingFailed = (folder: string, error: unknown): void => {
  const line = `anyhost lists no file in ${folder}: ${error instanceof Error ? error.message : String(error)}`
  if ((error as NodeJS.ErrnoException).code === 'ENOENT' || failedListings.has(line)) return
  failedListings.add(line)
  console.error(`${new Date().toISOString()} ${line}`)
}

const STATS_AT_ONCE = 256

export async function filesUnder(folder: string, depth = Infinity): Promise<{ readonly path: string; readonly mtimeMs: number }[]> {
  const files: { path: string; mtimeMs: number }[] = []
  const left = [{ folder, depth }]
  for (let next = left.pop(); next !== undefined; next = left.pop()) {
    const { folder: here, depth: below } = next
    const entries = await readdir(here, { withFileTypes: true }).catch((error: unknown) => void listingFailed(here, error))
    if (entries === undefined) continue
    for (const entry of entries) if (entry.isDirectory() && below > 1) left.push({ folder: join(here, entry.name), depth: below - 1 })
    const paths = entries.filter((entry) => entry.isFile()).map((entry) => join(here, entry.name))
    for (let from = 0; from < paths.length; from += STATS_AT_ONCE) {
      const batch = paths.slice(from, from + STATS_AT_ONCE)
      files.push(...(await Promise.all(batch.map(async (path) => ({ path, mtimeMs: (await stat(path).catch(() => undefined))?.mtimeMs ?? 0 })))))
    }
  }
  return files
}

export async function transcriptsOn(roots: MachineRoots): Promise<Map<string, { readonly tool: Tool; readonly paths: string[] }>> {
  const found = new Map<string, { readonly tool: Tool; readonly paths: string[] }>()
  const folders = [{ folder: claudeFolder(roots, 'projects'), depth: 2 }, { folder: join(roots.codexHome, 'sessions'), depth: Infinity }]
  for (const { folder, depth } of folders) {
    for (const { path } of await filesUnder(folder, depth)) {
      const owner = ownerOf(path, roots)
      if (owner === undefined || !('isTranscript' in owner) || !owner.isTranscript) continue
      const entry = found.get(owner.session) ?? { tool: owner.tool, paths: [] }
      entry.paths.push(path)
      found.set(owner.session, entry)
    }
  }
  return found
}

const sessionFilesUnder = async (folder: string): Promise<string[]> => (await filesUnder(folder)).map(({ path }) => path).filter((path) => !isTransient(path))

const foldersIn = async (folder: string): Promise<string[]> => {
  try {
    return (await readdir(folder, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(folder, entry.name))
  } catch (error) {
    listingFailed(folder, error)
    return []
  }
}

export async function filesOf(session: string, tool: Tool, roots: MachineRoots): Promise<string[]> {
  const lines = [...linesFiles(roots)].filter(([, file]) => file.tool === tool).map(([path]) => path)
  if (tool === 'codex') {
    const sessions = join(roots.codexHome, 'sessions')
    const named = await Array.fromAsync(new Bun.Glob(`**/rollout-*${session}.jsonl*`).scan({ cwd: sessions, onlyFiles: true })).catch((error: unknown) => {
      listingFailed(sessions, error)
      return []
    })
    const rollouts = named.map((path) => join(sessions, path)).filter((path) => ROLLOUT.exec(basename(path))?.[1] === session)
    return [...rollouts, ...lines, codexState(roots)]
  }
  const short = session.slice(0, 8)
  const projects = await foldersIn(claudeFolder(roots, 'projects'))
  const temporary = await foldersIn(roots.claudeTmp)
  const found = await Promise.all([
    ...projects.map(async (project) => [...((await Bun.file(join(project, `${session}.jsonl`)).exists()) ? [join(project, `${session}.jsonl`)] : []), ...(await sessionFilesUnder(join(project, session)))]),
    ...[claudeFolder(roots, 'file-history', session), claudeFolder(roots, 'tasks', session), claudeFolder(roots, 'tasks', `session-${short}`), claudeFolder(roots, 'session-env', session)].map(sessionFilesUnder),
    ...temporary.map(async (folder) => (await sessionFilesUnder(join(folder, session, 'tasks'))).filter((path) => path.endsWith('.output'))),
  ])
  return [...found.flat(), ...lines]
}

const viewOf = (bytes: Uint8Array | string): Buffer => (typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
const PLAN_MARK = Buffer.from('"planFilePath":"')
const PASTE_MARK = Buffer.from('"contentHash":"')
const PLAN_PATH_BYTES = 64 * 1024

export function namedIn(bytes: Uint8Array, roots: MachineRoots): string[] {
  const view = viewOf(bytes)
  const named: string[] = []
  for (let at = view.indexOf(PLAN_MARK); at >= 0; at = view.indexOf(PLAN_MARK, at + PLAN_MARK.length)) {
    const quoted = /^"(?:[^"\\]|\\.)*"/.exec(view.toString('utf8', at + PLAN_MARK.length - 1, at + PLAN_MARK.length + PLAN_PATH_BYTES))?.[0]
    const plan = quoted === undefined ? '' : (JSON.parse(quoted) as string)
    if (plan.startsWith('/')) named.push(plan)
  }
  for (let at = view.indexOf(PASTE_MARK); at >= 0; at = view.indexOf(PASTE_MARK, at + PASTE_MARK.length)) {
    const hash = /^([0-9a-f]+)"/.exec(view.toString('latin1', at + PASTE_MARK.length, at + PASTE_MARK.length + 130))?.[1]
    if (hash !== undefined) named.push(claudeFolder(roots, 'paste-cache', `${hash}.txt`))
  }
  return named
}

const marks = (...texts: readonly string[]): readonly Buffer[] => texts.map((text) => Buffer.from(text))

function lastLineOf<T>(view: Buffer, markers: readonly Buffer[], read: (line: string) => T | undefined): T | undefined {
  for (let before = view.length; before > 0; ) {
    const at = Math.max(...markers.map((marker) => view.lastIndexOf(marker, before - 1)))
    if (at < 0) return undefined
    const start = view.lastIndexOf(10, at) + 1
    const newline = view.indexOf(10, at)
    const found = read(view.toString('utf8', start, newline < 0 ? view.length : newline))
    if (found !== undefined) return found
    before = start
  }
  return undefined
}

function firstLineOf<T>(view: Buffer, markers: readonly Buffer[], read: (line: string) => T | undefined): T | undefined {
  for (let from = 0; from < view.length; ) {
    const found = markers.map((marker) => view.indexOf(marker, from)).filter((at) => at >= 0)
    if (found.length === 0) return undefined
    const at = Math.min(...found)
    const newline = view.indexOf(10, at)
    const value = read(view.toString('utf8', view.lastIndexOf(10, at) + 1, newline < 0 ? view.length : newline))
    if (value !== undefined) return value
    if (newline < 0) return undefined
    from = newline + 1
  }
  return undefined
}

const CWD_LINE_LENGTH = 64 * 1024
const TITLES: Record<string, readonly [string, number]> = { 'custom-title': ['customTitle', 3], 'agent-name': ['agentName', 3], 'ai-title': ['aiTitle', 2], summary: ['summary', 1], 'agent-setting': ['agentSetting', 0.5] }
export const TITLE_RULES = 2

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, PROMPT_LENGTH)

function promptOf(line: string, tool: Tool): string | undefined {
  if (tool === 'claude') {
    if (!line.includes('"type":"user"')) return undefined
    const value = JSON.parse(line) as { type?: string; isMeta?: boolean; message?: { role?: string; content?: unknown } }
    if (value.type !== 'user' || value.isMeta === true || value.message?.role !== 'user') return undefined
    const content = value.message.content
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? (content as { type?: string; text?: unknown }[]).flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])) : []
    for (const text of texts) {
      const command = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]
      if (command !== undefined) return `${command} ${/<command-args>([^<]*)<\/command-args>/.exec(text)?.[1] ?? ''}`.trim()
      const told = /^\s*<anyhost from="[^"]*" reach="[^"]*">([\s\S]*)<\/anyhost>\s*$/.exec(text)?.[1]
      if (told !== undefined) return told
      if (text.trim() !== '' && !text.trimStart().startsWith('<')) return text
    }
    return undefined
  }
  if (!line.includes('"user_message"') && !line.includes('"UserMessage"')) return undefined
  const { payload } = JSON.parse(line) as { payload?: { type?: string; message?: string; item?: { type?: string; content?: { text?: string }[] } } }
  if (payload?.type === 'user_message') return payload.message
  if (payload?.type === 'item_completed' && payload.item?.type === 'UserMessage') return payload.item.content?.map((part) => part.text ?? '').join('')
  return undefined
}

function cwdOf(line: string, tool: Tool): string | undefined {
  if (!line.includes('"cwd":"')) return undefined
  if (tool === 'codex') {
    const head = line.slice(0, 120)
    if (!head.includes('"type":"session_meta"') && !head.includes('"type":"turn_context"')) return undefined
    const found = (JSON.parse(line) as { payload?: { cwd?: unknown } }).payload?.cwd
    return typeof found === 'string' ? found : undefined
  }
  if (line.length > CWD_LINE_LENGTH) return undefined
  const found = (JSON.parse(line) as { cwd?: unknown }).cwd
  return typeof found === 'string' ? found : undefined
}

function entrypointOf(line: string, tool: Tool): string | undefined {
  if (tool === 'claude') return /"entrypoint":"([^"]*)"/.exec(line.slice(0, CWD_LINE_LENGTH))?.[1]
  if (!line.slice(0, 120).includes('"type":"session_meta"')) return undefined
  return (JSON.parse(line) as { payload?: { originator?: string } }).payload?.originator
}

type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown> }
const TOOL_DETAILS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'] as const

function toolSaid(name: string, input: Record<string, unknown>): string {
  const questions = input['questions']
  const asked = Array.isArray(questions) ? (questions[0] as { question?: unknown } | undefined)?.question : undefined
  if (typeof asked === 'string') return asked
  const detail = TOOL_DETAILS.map((key) => input[key]).find((value) => typeof value === 'string' || Array.isArray(value))
  return detail === undefined ? name : `${name}: ${Array.isArray(detail) ? detail.join(' ') : String(detail)}`
}

const SAID_NOISE = /```[\w-]*|\*\*|__|`|^#+\s|[─━│┃▏▕▐▌█░▒▓┌┐└┘├┤┬┴┼═║╔╗╚╝]+/gm

const plainOf = (text: string): string => {
  const lines = text.split('\n').map((line) => line.replace(SAID_NOISE, '').replace(/\[\s*\]|\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim())
  return lines.filter((line) => /\p{L}{2}/u.test(line)).join(' ')
}

function lastSaidOf(line: string, tool: Tool): string | undefined {
  if (tool === 'claude') {
    if (!line.includes('"type":"assistant"')) return undefined
    const value = JSON.parse(line) as Line
    if (value.type !== 'assistant' || value.isSidechain === true || !Array.isArray(value.message?.content)) return undefined
    const said = (value.message.content as Block[]).map((block) => (block.type === 'text' && block.text?.trim() ? plainOf(block.text) : block.type === 'tool_use' && block.name ? toolSaid(block.name, block.input ?? {}) : undefined)).filter((each) => each !== undefined && each !== '').at(-1)
    return said === undefined ? undefined : oneLine(said)
  }
  if (!line.includes('"type":"response_item"')) return undefined
  const { payload } = JSON.parse(line) as { payload?: { type?: string; role?: string; content?: Block[]; name?: string; arguments?: string } }
  if (payload?.type === 'message' && payload.role === 'assistant') {
    const said = plainOf((payload.content ?? []).map((part) => part.text ?? '').join('\n'))
    return said === '' ? undefined : oneLine(said)
  }
  if (payload?.type !== 'function_call' || payload.name === undefined) return undefined
  const input = ((): Record<string, unknown> => {
    try {
      return JSON.parse(payload.arguments ?? '{}') as Record<string, unknown>
    } catch {
      return {}
    }
  })()
  return oneLine(toolSaid(payload.name, input))
}

function messageAtOf(line: string, tool: Tool): string | undefined {
  if (!/"type":"(user|assistant|response_item)"/.test(line)) return undefined
  const value = JSON.parse(line) as { type?: string; isMeta?: boolean; timestamp?: string }
  const isMessage = tool === 'claude' ? (value.type === 'user' || value.type === 'assistant') && value.isMeta !== true : value.type === 'response_item'
  return isMessage ? value.timestamp : undefined
}

const FORKED_FROM = '"forkedFrom":{"sessionId":"'

function sourceOf(line: string): string | undefined {
  if (!line.includes(FORKED_FROM)) return undefined
  const found = (JSON.parse(line) as { forkedFrom?: { sessionId?: unknown } }).forkedFrom?.sessionId
  return typeof found === 'string' ? found : undefined
}

const MARKS = {
  claude: { message: marks('"type":"user"', '"type":"assistant"'), prompt: marks('"type":"user"'), entrypoint: marks('"entrypoint":"'), said: marks('"type":"assistant"') },
  codex: { message: marks('"type":"response_item"'), prompt: marks('"user_message"', '"UserMessage"'), entrypoint: marks('"type":"session_meta"'), said: marks('"type":"response_item"') },
} as const
const CWD_MARK = marks('"cwd":"')
const FORK_MARK = marks(FORKED_FROM)
const META_MARK = marks('"type":"session_meta"')
const TITLE_RANKS = [...new Set(Object.values(TITLES).map(([, rank]) => rank))].sort((a, b) => b - a)

function titleOf(view: Buffer, atLeast: number): { readonly title: string; readonly titleRank: number } | undefined {
  for (const rank of TITLE_RANKS.filter((each) => each >= atLeast)) {
    const types = Object.entries(TITLES).filter(([, [, of]]) => of === rank)
    const title = lastLineOf(view, marks(...types.map(([type]) => `{"type":"${type}"`)), (line) => {
      const titled = TITLES[/^\{"type":"([a-z-]+)"/.exec(line)?.[1] ?? '']
      const value = titled?.[1] === rank ? (JSON.parse(line) as Record<string, unknown>)[titled[0]] : undefined
      return typeof value === 'string' && value.trim() !== '' ? oneLine(value) : undefined
    })
    if (title !== undefined) return { title, titleRank: rank }
  }
  return undefined
}

export function summarize(summary: Summary, text: Uint8Array | string, tool: Tool): Summary {
  const view = viewOf(text)
  const mark = tool === 'mod' ? MARKS.claude : MARKS[tool]
  const firstPrompt = summary.firstPrompt || (firstLineOf(view, mark.prompt, (line) => oneLine(promptOf(line, tool) ?? '') || undefined) ?? '')
  const promptAt = (line: string): string | undefined => (promptOf(line, tool) === undefined ? undefined : (JSON.parse(line) as { timestamp?: string }).timestamp)
  const repoOf = (line: string): string | undefined => (JSON.parse(line) as { payload?: { git?: { repository_url?: string } } }).payload?.git?.repository_url
  return {
    ...(titleOf(view, summary.titleRank) ?? { title: summary.title, titleRank: summary.titleRank }),
    firstPrompt,
    cwd: lastLineOf(view, CWD_MARK, (line) => cwdOf(line, tool)) ?? summary.cwd,
    repo: (tool === 'codex' ? lastLineOf(view, META_MARK, repoOf) : undefined) ?? summary.repo,
    entrypoint: lastLineOf(view, mark.entrypoint, (line) => entrypointOf(line, tool)) ?? summary.entrypoint,
    lastSaid: lastLineOf(view, mark.said, (line) => lastSaidOf(line, tool)) ?? summary.lastSaid,
    lastActivity: lastLineOf(view, mark.message, (line) => messageAtOf(line, tool)) ?? summary.lastActivity,
    lastPromptAt: lastLineOf(view, mark.prompt, promptAt) ?? summary.lastPromptAt,
    source: lastLineOf(view, FORK_MARK, sourceOf) ?? summary.source,
  }
}

export const transcriptOf = (claudeHome: string, session: string): string | undefined => {
  if (!existsSync(join(claudeHome, 'projects'))) return undefined
  const found = new Bun.Glob(`*/${session}.jsonl`).scanSync({ cwd: join(claudeHome, 'projects'), onlyFiles: true }).next()
  return found.done === true ? undefined : join(claudeHome, 'projects', found.value)
}

const CWD_TAIL_BYTES = 1 << 20

export async function lastFolderOf(transcript: string): Promise<string> {
  const file = Bun.file(transcript)
  const tail = await file.slice(Math.max(0, file.size - CWD_TAIL_BYTES)).text()
  const last = [...tail.matchAll(/"cwd":("(?:[^"\\]|\\.)*")/g)].at(-1)?.[1]
  return last === undefined ? '' : (JSON.parse(last) as string)
}

const CHAIN_ROOT = Buffer.from('"parentUuid":null')

type Named = { readonly uuid: string; readonly at: number }

const SCAN_BYTES = 4 * 2 ** 20

export function* uuidsIn(bytes: Uint8Array): Generator<Named> {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let from = 0; from < view.length; ) {
    const newline = view.indexOf(10, Math.min(view.length - 1, from + SCAN_BYTES))
    const to = newline < 0 ? view.length : newline + 1
    for (const match of view.toString('latin1', from, to).matchAll(/"uuid":"([0-9a-f-]{36})"/g)) yield { uuid: match[1] ?? '', at: from + match.index }
    from = to
  }
}

const lineStartOf = (bytes: Uint8Array, at: number): number => bytes.lastIndexOf(10, at) + 1

export function firstUuidIn(bytes: Uint8Array): string | undefined {
  for (const { uuid, at } of uuidsIn(bytes)) if (bytes.indexOf(10, at) >= 0) return uuid
  return undefined
}

export function forkStartsIn(bytes: Uint8Array): string[] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const starts: string[] = []
  for (let at = view.indexOf(CHAIN_ROOT); at >= 0; at = view.indexOf(CHAIN_ROOT, at)) {
    const newline = view.indexOf(10, at)
    if (newline < 0) break
    const [first] = uuidsIn(view.subarray(lineStartOf(view, at), newline))
    if (first !== undefined) starts.push(first.uuid)
    at = newline
  }
  return starts
}

export async function parentOf(transcript: string, candidates: readonly string[], most: number): Promise<string | undefined> {
  let parent: { readonly path: string; readonly rank: number; readonly bornAt: number } | undefined
  for (const path of candidates.filter((other) => basename(other) !== basename(transcript))) {
    const found = await stat(path).catch(() => undefined)
    if (found === undefined || !found.isFile() || found.size > most) continue
    const candidate = { path, rank: Number(dirname(path) !== dirname(transcript)), bornAt: found.birthtimeMs || found.mtimeMs }
    if (parent === undefined || candidate.rank < parent.rank || (candidate.rank === parent.rank && candidate.bornAt < parent.bornAt)) parent = candidate
  }
  return parent?.path
}


export const SMALLEST_CHUNK = 8 * 2 ** 20
export const CHUNK_SPAN = 4 * 2 ** 20
export const LARGEST_CHUNK = 16 * 2 ** 20
const UUID_KEY = Buffer.from('"uuid":"')
const UUID_LENGTH = 36

function cutChance(line: Buffer): number {
  const at = line.indexOf(UUID_KEY)
  const from = at + UUID_KEY.length
  const key = at >= 0 && from + UUID_LENGTH <= line.length ? line.subarray(from, from + UUID_LENGTH) : line
  return Number(BigInt.asUintN(32, BigInt(Bun.hash(key)))) / 2 ** 32
}

const PIECE_READ_BYTES = 4 * 2 ** 20

export async function* piecesFrom(path: string, from: number, to: number): AsyncGenerator<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    let buffer = Buffer.allocUnsafe(LARGEST_CHUNK + PIECE_READ_BYTES)
    let filled = 0
    for (let at = from; at < to; ) {
      if (buffer.length - filled < PIECE_READ_BYTES) buffer = Buffer.concat([buffer.subarray(0, filled), Buffer.allocUnsafe(buffer.length)])
      const { bytesRead } = await handle.read(buffer, filled, Math.min(PIECE_READ_BYTES, to - at), at)
      if (bytesRead === 0) break
      at += bytesRead
      filled += bytesRead
      const whole = at >= to ? filled : buffer.lastIndexOf(10, filled - 1) + 1
      if (whole === 0) continue
      const ends = cutsOf(buffer.subarray(0, whole))
      const kept = at >= to ? ends : ends.slice(0, -1)
      let start = 0
      for (const end of kept) {
        yield buffer.subarray(start, end)
        start = end
      }
      buffer.copyWithin(0, start, filled)
      filled -= start
    }
    if (filled > 0) yield buffer.subarray(0, filled)
  } finally {
    await handle.close()
  }
}

export function cutsOf(bytes: Uint8Array): number[] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ends: number[] = []
  let cut = 0
  for (let start = 0; start < view.length; ) {
    const newline = view.indexOf(10, start)
    const end = newline < 0 ? view.length : newline + 1
    const since = start - cut
    if (since > 0 && (since + end - start > LARGEST_CHUNK || (since >= SMALLEST_CHUNK && cutChance(view.subarray(start, end)) < (end - start) / CHUNK_SPAN))) {
      ends.push(start)
      cut = start
    }
    while (end - cut > LARGEST_CHUNK) {
      cut += LARGEST_CHUNK
      ends.push(cut)
    }
    start = end
  }
  if (cut < view.length) ends.push(view.length)
  return ends
}

export const FORK_VERSION = 1
export type Fork = { readonly version?: number; readonly session: string; readonly source: string; readonly message: string; readonly title: string; readonly time: string }

type Entry = Record<string, unknown> & { readonly type?: unknown; readonly uuid?: unknown; readonly parentUuid?: unknown; readonly sessionId?: unknown; readonly isSidechain?: unknown; readonly subtype?: unknown }

const MESSAGE_TYPES = new Set(['user', 'assistant', 'attachment', 'system', 'progress'])

function entryOf(line: string): Entry | undefined {
  try {
    const value = JSON.parse(line) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Entry) : undefined
  } catch {
    return undefined
  }
}

export async function forkedTranscript(source: Uint8Array, fork: Fork): Promise<{ readonly bytes: Uint8Array; readonly read: number }> {
  const version = fork.version ?? FORK_VERSION
  if (version !== FORK_VERSION) throw new Error(`This anyhost derives forks of version ${FORK_VERSION}, and the fork ${fork.session} is of version ${version}, which a newer anyhost wrote.`)
  return await forkedTranscriptV1(source, fork)
}

const YIELD_BYTES = 4 * 2 ** 20

type Placed = { readonly parentUuid: unknown; readonly start: number; readonly end: number }
type Gathered = { readonly messages: Map<string, Placed>; readonly replacements: unknown[]; readonly memoryModes: Entry[]; relocated: unknown; isSuppressed: boolean; read: number; readLine?: Placed }

const SPECIAL_TYPES = new Set(['history-suppression', 'content-replacement', 'memory-mode', 'relocated'])
const HEAD_KEYS = new Set(['type', 'uuid', 'parentUuid', 'isSidechain', 'sessionId'])

const isSpace = (byte: number | undefined): boolean => byte === 32 || byte === 9 || byte === 13 || byte === 10
const skipSpace = (view: Buffer, at: number, end: number): number => {
  while (at < end && isSpace(view[at])) at += 1
  return at
}

function stringEnd(view: Buffer, at: number, end: number): number {
  for (let quote = view.indexOf(34, at + 1); quote >= 0 && quote < end; quote = view.indexOf(34, quote + 1)) {
    let slashes = 0
    while (view[quote - 1 - slashes] === 92) slashes += 1
    if (slashes % 2 === 0) return quote + 1
  }
  return -1
}

function valueEnd(view: Buffer, at: number, end: number): number {
  const first = view[at]
  if (first === 34) return stringEnd(view, at, end)
  if (first !== 123 && first !== 91) {
    while (at < end && view[at] !== 44 && view[at] !== 125 && view[at] !== 93 && !isSpace(view[at])) at += 1
    return at
  }
  let depth = 0
  while (at < end) {
    const byte = view[at]
    if (byte === 34) {
      at = stringEnd(view, at, end)
      if (at < 0) return -1
      continue
    }
    if (byte === 123 || byte === 91) depth += 1
    else if (byte === 125 || byte === 93) depth -= 1
    at += 1
    if (depth === 0) return at
  }
  return -1
}

function headOf(view: Buffer, start: number, end: number): Entry | undefined {
  let at = skipSpace(view, start, end)
  if (view[at] !== 123) return undefined
  const head: Record<string, unknown> = {}
  for (at = skipSpace(view, at + 1, end); view[at] !== 125; ) {
    if (view[at] !== 34) return undefined
    const keyEnd = stringEnd(view, at, end)
    if (keyEnd < 0) return undefined
    const key = JSON.parse(view.toString('utf8', at, keyEnd)) as string
    at = skipSpace(view, keyEnd, end)
    if (view[at] !== 58) return undefined
    at = skipSpace(view, at + 1, end)
    const after = valueEnd(view, at, end)
    if (after < 0 || after === at) return undefined
    if (HEAD_KEYS.has(key)) head[key] = view[at] === 123 || view[at] === 91 ? {} : (JSON.parse(view.toString('utf8', at, after)) as unknown)
    at = skipSpace(view, after, end)
    if (view[at] === 44) at = skipSpace(view, at + 1, end)
    else if (view[at] !== 125) return undefined
  }
  return skipSpace(view, at + 1, end) === end ? head : undefined
}

async function gather(view: Buffer, fork: Fork, entryAt: (start: number, end: number) => Entry | undefined): Promise<Gathered> {
  const gathered: Gathered = { messages: new Map(), replacements: [], memoryModes: [], relocated: undefined, isSuppressed: false, read: -1 }
  for (let start = 0, yieldAt = YIELD_BYTES; start < view.length && gathered.read < 0; ) {
    if (start >= yieldAt) {
      yieldAt = start + YIELD_BYTES
      await new Promise((resolve) => setImmediate(resolve))
    }
    const newline = view.indexOf(10, start)
    if (newline < 0) break
    const head = entryAt(start, newline)
    const entry = head !== undefined && SPECIAL_TYPES.has(String(head.type)) ? entryOf(view.toString('utf8', start, newline)) : head
    const line = { parentUuid: entry?.parentUuid, start, end: newline }
    start = newline + 1
    if (entry === undefined) continue
    const isOwn = entry.sessionId === fork.source
    if (entry.type === 'history-suppression') gathered.isSuppressed = true
    else if (entry.type === 'content-replacement' && isOwn && Array.isArray(entry['replacements'])) gathered.replacements.push(...(entry['replacements'] as unknown[]))
    else if (entry.type === 'memory-mode' && isOwn) gathered.memoryModes.push(entry)
    else if (entry.type === 'relocated' && isOwn && typeof entry['relocatedCwd'] === 'string' && entry['relocatedCwd'] !== '') gathered.relocated = entry['relocatedCwd']
    else if (typeof entry.uuid === 'string' && MESSAGE_TYPES.has(String(entry.type)) && entry.isSidechain !== true) gathered.messages.set(entry.uuid, line)
    if (entry.uuid === fork.message && gathered.messages.has(fork.message)) {
      gathered.read = start
      gathered.readLine = line
    }
  }
  return gathered
}

function forkChainOf(view: Buffer, fork: Fork, gathered: Gathered): Entry[] | undefined {
  const chain: Entry[] = []
  const seen = new Set<string>()
  for (let uuid: unknown = fork.message; typeof uuid === 'string' && !seen.has(uuid); ) {
    const placed = gathered.messages.get(uuid)
    if (placed === undefined) break
    seen.add(uuid)
    const entry = entryOf(view.toString('utf8', placed.start, placed.end))
    if (entry === undefined) return undefined
    chain.unshift(entry)
    uuid = placed.parentUuid
  }
  return chain
}

async function forkedTranscriptV1(source: Uint8Array, fork: Fork): Promise<{ readonly bytes: Uint8Array; readonly read: number }> {
  const view = Buffer.from(source.buffer, source.byteOffset, source.byteLength)
  const scanned = await gather(view, fork, (start, end) => headOf(view, start, end))
  const readLine = scanned.readLine
  const isRead = readLine === undefined || entryOf(view.toString('utf8', readLine.start, readLine.end)) !== undefined
  const scannedChain = isRead && scanned.read >= 0 ? forkChainOf(view, fork, scanned) : undefined
  const parsed = scannedChain === undefined && (!isRead || scanned.read >= 0) ? await gather(view, fork, (start, end) => entryOf(view.toString('utf8', start, end))) : scanned
  const { replacements, memoryModes, relocated, isSuppressed, read } = parsed
  if (read < 0) throw new Error(`The session ${fork.source} holds no message ${fork.message} to fork from.`)
  const chain = scannedChain ?? forkChainOf(view, fork, parsed) ?? []
  const lines: unknown[] = isSuppressed ? [{ type: 'history-suppression', sessionId: fork.session, cause: 'fork_inherit', ts: fork.time }] : []
  let parentUuid: unknown = null
  for (const entry of chain) {
    const neutralized = entry.type === 'system' && entry.subtype === 'model_refusal_fallback' ? { neutralizedByFork: true } : {}
    lines.push({ ...entry, ...neutralized, sessionId: fork.session, parentUuid, isSidechain: false, sessionKind: undefined, forkedFrom: { sessionId: fork.source, messageUuid: entry.uuid } })
    if (entry.type !== 'progress') parentUuid = entry.uuid
  }
  if (replacements.length > 0) lines.push({ type: 'content-replacement', sessionId: fork.session, replacements })
  for (const mode of memoryModes) lines.push({ ...mode, sessionId: fork.session })
  if (relocated !== undefined) lines.push({ type: 'relocated', sessionId: fork.session, relocatedCwd: relocated })
  lines.push({ type: 'custom-title', customTitle: fork.title, sessionId: fork.session })
  return { bytes: new TextEncoder().encode(lines.map((line) => `${JSON.stringify(line)}\n`).join('')), read }
}

export function lastMessageIn(bytes: Uint8Array): string | undefined {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let end = view.lastIndexOf(10); end > 0; ) {
    const start = view.lastIndexOf(10, end - 1) + 1
    const line = view.subarray(start, end)
    if (line.includes('"type":"user"') || line.includes('"type":"assistant"')) {
      const entry = entryOf(line.toString('utf8'))
      if (entry !== undefined && (entry.type === 'user' || entry.type === 'assistant') && entry.isSidechain !== true && typeof entry.uuid === 'string') return entry.uuid
    }
    end = start - 1
  }
  return undefined
}

export const namesFork = (bytes: Uint8Array): boolean => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(FORKED_FROM)

export function forkIn(bytes: Uint8Array, session: string): Fork | undefined {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = view.lastIndexOf(FORKED_FROM)
  if (at < 0) return undefined
  const lineEnd = view.indexOf(10, at)
  if (lineEnd < 0) return undefined
  const forked = entryOf(view.toString('utf8', lineStartOf(view, at), lineEnd))?.['forkedFrom'] as { readonly sessionId?: unknown; readonly messageUuid?: unknown } | undefined
  if (typeof forked?.sessionId !== 'string' || typeof forked.messageUuid !== 'string') return undefined
  let title: string | undefined
  for (let start = lineEnd + 1; start < view.length && title === undefined; ) {
    const newline = view.indexOf(10, start)
    if (newline < 0) break
    const entry = entryOf(view.toString('utf8', start, newline))
    if (entry?.type === 'custom-title' && typeof entry['customTitle'] === 'string') title = entry['customTitle']
    start = newline + 1
  }
  if (title === undefined) return undefined
  const first = view.indexOf(10)
  const suppressed = first < 0 ? undefined : entryOf(view.toString('utf8', 0, first))
  const time = suppressed?.type === 'history-suppression' && typeof suppressed['ts'] === 'string' ? suppressed['ts'] : ''
  return { version: FORK_VERSION, session, source: forked.sessionId, message: forked.messageUuid, title, time }
}

type Line = { type?: string; isMeta?: boolean; isSidechain?: boolean; timestamp?: string; message?: { id?: string; role?: string; content?: unknown } }

export function messagesOf(text: string, count: number, skip = 0): Message[] {
  const messages: (Message & { readonly id: string })[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{"') || (!line.includes('"type":"user"') && !line.includes('"type":"assistant"'))) continue
    const value = JSON.parse(line) as Line
    if ((value.type !== 'user' && value.type !== 'assistant') || value.isMeta === true || value.isSidechain === true) continue
    const content = value.message?.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as { type?: string; text?: string }[]) : []
    const isWrapper = (said: string): boolean => value.type === 'user' && said.trimStart().startsWith('<') && !said.trimStart().startsWith('<anyhost ')
    const said = blocks.flatMap((block) => (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '' && !isWrapper(block.text) ? [block.text] : [])).join('\n')
    if (said === '') continue
    const id = value.message?.id ?? ''
    const last = messages.at(-1)
    if (value.type === 'assistant' && id !== '' && last?.id === id) messages[messages.length - 1] = { ...last, text: `${last.text}\n${said}` }
    else messages.push({ role: value.type, at: value.timestamp ?? '', text: said, id })
  }
  return messages.slice(0, messages.length - skip).slice(-count).map(({ role, at, text: said }) => ({ role, at, text: said }))
}

let codexNames = { modifiedAt: -1, names: new Map<string, string>() }

export async function codexNameOf(id: string, codexHome = join(homedir(), '.codex')): Promise<string | undefined> {
  const file = Bun.file(join(codexHome, 'session_index.jsonl'))
  const modifiedAt = await file.stat().then((info) => info.mtimeMs, () => undefined)
  if (modifiedAt === undefined) return undefined
  if (modifiedAt !== codexNames.modifiedAt) {
    const lines = (await file.text()).split('\n').filter((line) => line !== '')
    const names = lines.map((line) => JSON.parse(line) as { id?: string; thread_name?: string })
    codexNames = { modifiedAt, names: new Map(names.flatMap(({ id: named, thread_name: name }) => (named === undefined || !name ? [] : [[named, oneLine(name)] as const]))) }
  }
  return codexNames.names.get(id)
}
