import { homedir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'

export type Tool = 'claude' | 'codex'
export type Root = { readonly tool: Tool; readonly folder: string }
export type Summary = { readonly title: string; readonly titleRank: number; readonly firstPrompt: string; readonly cwd: string; readonly repo: string }

const PROMPT_LENGTH = 300

export const roots = (home = homedir()): Root[] => [
  { tool: 'claude', folder: join(home, '.claude', 'projects') },
  { tool: 'codex', folder: join(home, '.codex', 'sessions') },
]

export function keyOf(root: Root, path: string): string | undefined {
  if (!path.endsWith('.jsonl')) return undefined
  if (root.tool === 'codex') return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(basename(path))?.[1]
  const parts = relative(root.folder, path).split(sep)
  if (parts.length < 2 || parts[0] === '..') return undefined
  return parts.slice(1).join('/').slice(0, -'.jsonl'.length)
}

export const sessionOf = (key: string): string => key.split('/')[0] ?? key

export const projectFolder = (cwd: string, home = homedir()): string => join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))

const CWD = /"cwd":("(?:[^"\\]|\\.)*")/g
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

export function summarize(summary: Summary, text: string, tool: Tool): Summary {
  let { title, titleRank, firstPrompt, cwd, repo } = summary
  for (const line of text.split('\n')) {
    if (line === '') continue
    cwd = cwdOf(line, tool) ?? cwd
    if (firstPrompt === '') firstPrompt = oneLine(promptOf(line, tool) ?? '')
    const type = /^\{"type":"([a-z-]+)"/.exec(line)?.[1]
    const titled = type === undefined ? undefined : TITLES[type]
    if (titled !== undefined && titled[1] >= titleRank) {
      const value = (JSON.parse(line) as Record<string, unknown>)[titled[0]]
      if (typeof value === 'string' && value.trim() !== '') [title, titleRank] = [oneLine(value), titled[1]]
    }
    if (tool === 'codex' && line.includes('"type":"session_meta"')) repo =(JSON.parse(line) as { payload?: { git?: { repository_url?: string } } }).payload?.git?.repository_url ?? repo
  }
  return { title, titleRank, firstPrompt, cwd, repo }
}

let codexNames = { modifiedAt: -1, names: new Map<string, string>() }

export async function codexNameOf(id: string, home = homedir()): Promise<string | undefined> {
  const file = Bun.file(join(home, '.codex', 'session_index.jsonl'))
  const modifiedAt = await file.stat().then((info) => info.mtimeMs, () => undefined)
  if (modifiedAt === undefined) return undefined
  if (modifiedAt !== codexNames.modifiedAt) {
    const lines = (await file.text()).split('\n').filter((line) => line !== '')
    const names = lines.map((line) => JSON.parse(line) as { id?: string; thread_name?: string })
    codexNames = { modifiedAt, names: new Map(names.flatMap(({ id: named, thread_name: name }) => (named === undefined || !name ? [] : [[named, oneLine(name)] as const]))) }
  }
  return codexNames.names.get(id)
}

export const withCwd =(text: string, cwd: string): string => text.replace(CWD, () => `"cwd":${JSON.stringify(cwd)}`)
