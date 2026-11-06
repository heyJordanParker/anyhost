import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import type { MachineRoots } from './device.ts'

export type Tool = 'claude' | 'codex'
export type Summary = {
  readonly title: string
  readonly titleRank: number
  readonly firstPrompt: string
  readonly cwd: string
  readonly repo: string
  readonly entrypoint: string
}

// Who a file belongs to:
// - `session`: the path names its session, and `isTranscript` says it is the session's own transcript
// - `prefix`: `tasks/session-<8 hex>/` names the first 8 hex digits of the session id
// - `lines`: a file every session writes lines to, each naming its session in the key `lines`
// - `named`: a plan or a pasted text, which belongs to the sessions whose files name it
export type Owner =
  | { readonly session: string; readonly tool: Tool; readonly isTranscript: boolean }
  | { readonly prefix: string }
  | { readonly lines: string; readonly tool: Tool }
  | { readonly named: true }

const PROMPT_LENGTH = 300
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ROLLOUT = /^rollout-.*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

const claudeFolder = (roots: MachineRoots, ...parts: string[]): string => join(roots.claudeHome, ...parts)

// Codex keeps a thread's row in this database. Its JSON form is the session's record of it.
export const codexState = (roots: MachineRoots): string => join(roots.codexHome, 'state_5.sqlite')

export const linesFiles = (roots: MachineRoots): Map<string, { readonly lines: string; readonly tool: Tool }> =>
  new Map([
    [claudeFolder(roots, 'history.jsonl'), { lines: 'sessionId', tool: 'claude' }],
    [join(roots.codexHome, 'history.jsonl'), { lines: 'session_id', tool: 'codex' }],
    [join(roots.codexHome, 'session_index.jsonl'), { lines: 'id', tool: 'codex' }],
  ])

// The folders the program watches. `jobs/` holds no file of a session: `jobs/<8 hex>/state.json` is the record of a job
// this machine's Claude Code daemon ran, which names a job that never ran on any other machine.
export const watchedFolders = (roots: MachineRoots): { readonly folder: string; readonly isRecursive: boolean }[] => [
  { folder: claudeFolder(roots), isRecursive: false },
  ...['projects', 'file-history', 'tasks', 'session-env', 'plans', 'paste-cache'].map((name) => ({ folder: claudeFolder(roots, name), isRecursive: true })),
  { folder: roots.claudeTmp, isRecursive: true },
  { folder: roots.codexHome, isRecursive: false },
  { folder: join(roots.codexHome, 'sessions'), isRecursive: true },
]

export function ownerOf(path: string, roots: MachineRoots): Owner | undefined {
  const lines = linesFiles(roots).get(path)
  if (lines !== undefined) return lines
  // a dotfile such as `.lock`, or the temp file of an atomic write, `custom-title.json.tmp.2cbcf23f`
  if (basename(path).startsWith('.') || /\.tmp\.[0-9a-f]+$/.test(path)) return undefined
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
  // background output: <temp root>/<encoded working folder>/<session>/tasks/<task>.output
  const output = under(roots.claudeTmp)
  if (output.length === 4 && ID.test(output[1] ?? '') && output[2] === 'tasks' && output[3]?.endsWith('.output') === true) return { session: output[1] ?? '', tool: 'claude', isTranscript: false }
  const rollout = under(join(roots.codexHome, 'sessions')).length > 0 ? ROLLOUT.exec(basename(path))?.[1] : undefined
  if (rollout !== undefined) return { session: rollout, tool: 'codex', isTranscript: true }
  return undefined
}

async function filesUnder(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.') && !/\.tmp\.[0-9a-f]+$/.test(entry.name)).map((entry) => join(entry.parentPath, entry.name))
}

const foldersIn = async (folder: string): Promise<string[]> =>
  (await readdir(folder, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => join(folder, entry.name))

// Every file of a session that exists now, and the files it will write to whose names are known: the program
// captures a session it sees for the first time from byte 0 of each.
export async function filesOf(session: string, tool: Tool, roots: MachineRoots): Promise<string[]> {
  const lines = [...linesFiles(roots)].filter(([, file]) => file.tool === tool).map(([path]) => path)
  if (tool === 'codex') return [...lines, codexState(roots)]
  const short = session.slice(0, 8)
  const projects = await foldersIn(claudeFolder(roots, 'projects'))
  const temporary = await foldersIn(roots.claudeTmp)
  const found = await Promise.all([
    ...projects.map(async (project) => [...((await Bun.file(join(project, `${session}.jsonl`)).exists()) ? [join(project, `${session}.jsonl`)] : []), ...(await filesUnder(join(project, session)))]),
    ...[claudeFolder(roots, 'file-history', session), claudeFolder(roots, 'tasks', session), claudeFolder(roots, 'tasks', `session-${short}`), claudeFolder(roots, 'session-env', session)].map(filesUnder),
    ...temporary.map(async (folder) => (await filesUnder(join(folder, session, 'tasks'))).filter((path) => path.endsWith('.output'))),
  ])
  return [...found.flat(), ...lines]
}

// The plans and pasted texts a session's bytes name: Claude Code's `planFilePath` and history's `contentHash`.
export function namedIn(text: string, roots: MachineRoots): string[] {
  const plans = [...text.matchAll(/"planFilePath":("(?:[^"\\]|\\.)*")/g)].map((match) => JSON.parse(match[1] ?? '""') as string)
  const pastes = [...text.matchAll(/"contentHash":"([0-9a-f]+)"/g)].map((match) => claudeFolder(roots, 'paste-cache', `${match[1]}.txt`))
  return [...plans.filter((plan) => plan.startsWith('/')), ...pastes]
}

const CWD_LINE_LENGTH = 64 * 1024
const TITLES: Record<string, readonly [string, number]> = { 'custom-title': ['customTitle', 3], 'ai-title': ['aiTitle', 2], summary: ['summary', 1] }

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, PROMPT_LENGTH)

function promptOf(line: string, tool: Tool): string | undefined {
  if (tool === 'claude') {
    if (!line.includes('"type":"user"')) return undefined
    const value = JSON.parse(line) as { type?: string; isMeta?: boolean; message?: { role?: string; content?: unknown } }
    if (value.type !== 'user' || value.isMeta === true || value.message?.role !== 'user') return undefined
    const content = value.message.content
    const text = typeof content === 'string' ? content : Array.isArray(content) ? (content as { type?: string; text?: string }[]).find((block) => block.type === 'text')?.text : undefined
    return text === undefined || text.trimStart().startsWith('<') ? undefined : text
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

// How the session started: Claude Code's `entrypoint` (`cli`, `sdk-cli`), Codex's `source` (`cli`, `vscode`, `exec`).
function entrypointOf(line: string, tool: Tool): string | undefined {
  if (tool === 'claude') return /"entrypoint":"([^"]*)"/.exec(line.slice(0, CWD_LINE_LENGTH))?.[1]
  if (!line.slice(0, 120).includes('"type":"session_meta"')) return undefined
  return (JSON.parse(line) as { payload?: { source?: string } }).payload?.source
}

export function summarize(summary: Summary, text: string, tool: Tool): Summary {
  let { title, titleRank, firstPrompt, cwd, repo, entrypoint } = summary
  for (const line of text.split('\n')) {
    if (line === '') continue
    cwd = cwdOf(line, tool) ?? cwd
    if (firstPrompt === '') firstPrompt = oneLine(promptOf(line, tool) ?? '')
    if (entrypoint === '') entrypoint = entrypointOf(line, tool) ?? ''
    const type = /^\{"type":"([a-z-]+)"/.exec(line)?.[1]
    const titled = type === undefined ? undefined : TITLES[type]
    if (titled !== undefined && titled[1] >= titleRank) {
      const value = (JSON.parse(line) as Record<string, unknown>)[titled[0]]
      if (typeof value === 'string' && value.trim() !== '') [title, titleRank] = [oneLine(value), titled[1]]
    }
    if (tool === 'codex' && line.includes('"type":"session_meta"')) repo = (JSON.parse(line) as { payload?: { git?: { repository_url?: string } } }).payload?.git?.repository_url ?? repo
  }
  return { title, titleRank, firstPrompt, cwd, repo, entrypoint }
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
