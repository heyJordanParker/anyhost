import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type * as Protocol from '../../relay/protocol.ts'
import { checkoutOf, continueJournal, isCodePart, journalOf, linesOf, markUntold, recordSummary, sha256, stopJournal, tailOf, workingFolderOf, writeIndex, type Capture, type FileState, type IndexedSession } from './capture.ts'
import { claimsOf, HeldElsewhere, takeClaim } from './claims.ts'
import { statusOf } from './claude.ts'
import { devicesOf, type MachineRoots } from './device.ts'
import { relocate, type Roots } from './relocate.ts'
import { runSession } from './runner.ts'
import { downloadJournal, indexesOf, listSessions, type ListedSession, type Replayed, type ReplayedFile } from './sessions.ts'
import { codexState, linesFiles, ownerOf, type Tool } from './transcript.ts'

const NOTHING = new Uint8Array()

export const repoSlug = (remote: string): string =>
  remote
    .trim()
    .replace(/\.git$/, '')
    .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/, '')
    .replace(/^[^@/]+@([^:/]+):/, '$1/')

const sameRepo = (a: string, b: string): boolean => repoSlug(a).toLowerCase() === repoSlug(b).toLowerCase()

const isFolder = (path: string): Promise<boolean> => stat(path).then((found) => found.isDirectory(), () => false)

async function run(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`${argv.join(' ')} exited with ${code}: ${error.trim() || output.trim()}`)
  return output
}

// The checkout roots of the sessions this machine wrote or restored in a repository.
const knownCheckouts = (capture: Capture): string[] =>
  capture.db
    .query<{ cwd: string; repo_folder: string }, []>("select distinct cwd, repo_folder from sessions where repo != ''")
    .all()
    .map(({ cwd, repo_folder }) => (repo_folder === '' ? cwd : cwd.slice(0, -repo_folder.length - 1)))

// The deepest folder that holds both paths, `/` when they share none.
function sharedFolder(a: string, b: string): string {
  const [left, right] = [a.split('/'), b.split('/')]
  const same = left.findIndex((part, index) => part !== right[index])
  return left.slice(0, same < 0 ? left.length : same).join('/') || '/'
}

// The folder this machine keeps its checkouts in, where resume clones a missing repository: `chosen`, the person's
// `checkouts` option, else the folder the checkouts of this machine's sessions share, else the home folder.
function checkoutsOf(capture: Capture, chosen: string): string {
  if (chosen !== '') return chosen
  const shared = knownCheckouts(capture).map((root) => dirname(root)).reduce<string | undefined>((folder, parent) => (folder === undefined ? parent : sharedFolder(folder, parent)), undefined)
  return shared === undefined || shared === '/' ? capture.roots.home : shared
}

async function findCheckout(capture: Capture, remote: string, checkouts: string): Promise<string | undefined> {
  const children = (await isFolder(checkouts)) ? (await readdir(checkouts)).map((name) => join(checkouts, name)) : []
  for (const root of [...knownCheckouts(capture), ...children]) {
    if (sameRepo((await checkoutOf(root)).repo, remote)) return root
  }
  return undefined
}

// The checkout a session works in: its repository's root, or its working folder outside git. A session with no working
// folder has the home folder, since relocate takes only absolute roots.
const checkoutOfEntry = (entry: Pick<IndexedSession, 'cwd' | 'repo' | 'repoFolder'>, home: string): string =>
  (entry.repo !== '' && entry.repoFolder !== '' ? entry.cwd.slice(0, -entry.repoFolder.length - 1) : entry.cwd) || home

// How restore rewrites each record: its writer's roots, and the file each `/rewind` backup of the session holds by
// backup name, for the backups whose file lies under Claude Code's or Codex's own folders.
type Writers = { readonly rootsOf: (device: string) => Roots; readonly tracked: ReadonlyMap<string, string> }

// Each machine's roots for the session: its home folders as it joined the relay with them, its checkout from its index.
function writersOf(devices: ReadonlyMap<string, Protocol.Device>, indexes: ReadonlyMap<string, readonly IndexedSession[]>, session: ListedSession): (device: string) => Roots {
  return (device) => {
    const roots = devices.get(device)?.roots
    if (roots === undefined) throw new Error(`The session ${session.id} holds records of the device ${device}, and the relay knows no machine of that id, so anyhost cannot rewrite its paths.`)
    return { ...roots, checkout: checkoutOfEntry(indexes.get(device)?.find((entry) => entry.id === session.id) ?? session, roots.home) }
  }
}

// Where the session's working folder goes on this machine: in the checkout of its repository found by remote, or
// in the folder this machine keeps checkouts in; outside git, where relocate moves its path from the writer's home,
// temp root and other roots to this machine's.
export async function localFolder(capture: Capture, session: Pick<IndexedSession, 'repo' | 'repoFolder' | 'cwd'>, writer: MachineRoots, chosen: string): Promise<string> {
  const { home } = capture.roots
  if (session.repo !== '') {
    const checkouts = checkoutsOf(capture, chosen)
    return join((await findCheckout(capture, session.repo, checkouts)) ?? join(checkouts, basename(repoSlug(session.repo))), session.repoFolder)
  }
  if (session.cwd === '') return home
  // the folder is the writer's checkout itself, which no root of this machine names yet
  return relocate(NOTHING, session.cwd, { ...writer, checkout: writer.home }, { ...capture.roots, checkout: home }).path
}

// Clones the repository a session works in when this machine has no checkout of it where the session continues in
// `cwd`, on `branch` when one is named.
export async function cloneMissing(session: Pick<IndexedSession, 'repo' | 'repoFolder'>, cwd: string, home: string, branch = ''): Promise<void> {
  const checkout = checkoutOfEntry({ ...session, cwd }, home)
  if (session.repo === '' || (await isFolder(checkout))) return
  console.log(`Cloning ${session.repo} into ${checkout}`)
  await run(['git', 'clone', ...(branch === '' ? [] : ['--branch', branch]), session.repo, checkout])
}

async function readStaged(file: ReplayedFile, offset: number, size: number): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(file.staged).slice(offset, offset + size).arrayBuffer())
}

// The file each `/rewind` backup holds, by backup name, from the `trackedFileBackups` of the session's transcripts. Only
// a file named by its absolute path can lie outside the working folder, such as a plan in Claude Code's `plans/`.
async function trackedFilesOf(replayed: Replayed, session: string): Promise<Map<string, string>> {
  const tracked = new Map<string, string>()
  for (const [path, file] of replayed.files) {
    if (!path.endsWith(`${session}.jsonl`)) continue
    for (const match of (await Bun.file(file.staged).text()).matchAll(/"(\/(?:[^"\\]|\\.)*)":\{"backupFileName":"([^"]+)"/g)) tracked.set(match[2] ?? '', JSON.parse(`"${match[1]}"`) as string)
  }
  return tracked
}

// The path whose rules rewrite a record's bytes: a code part never changes, and a backup of a file under Claude Code's
// or Codex's own folders changes as that file does, so `/rewind` never writes another machine's paths back. Every
// other backup keeps its bytes, as relocate keeps `file-history/`.
function rulesPathOf(path: string, from: Roots, writers: Writers): string | undefined {
  if (isCodePart(path)) return undefined
  const tracked = path.includes('/file-history/') ? writers.tracked.get(basename(path)) : undefined
  if (tracked === undefined) return path
  const isState = [from.claudeHome, from.codexHome, from.claudeTmp].some((root) => tracked.startsWith(`${root}/`))
  return isState ? tracked : path
}

// A file as the machine with `to` roots has it, one record at a time: each record's bytes rewritten from its writer's roots.
async function* viewOf(file: ReplayedFile, writers: Writers, to: Roots): AsyncGenerator<Uint8Array> {
  for (const segment of file.segments) {
    const bytes = await readStaged(file, segment.offset, segment.size)
    const from = writers.rootsOf(segment.device)
    const rules = rulesPathOf(segment.path, from, writers)
    yield rules === undefined ? bytes : relocate(bytes, rules, from, to).bytes
  }
}

// Every file must be what its last writer had after its last record: its size and sha256.
async function checkFile(file: ReplayedFile, writers: Writers): Promise<void> {
  const { device, path, after } = file.last
  const hasher = new Bun.CryptoHasher('sha256')
  let size = 0
  for await (const part of viewOf(file, writers, writers.rootsOf(device))) {
    hasher.update(part)
    size += part.length
  }
  const found = hasher.digest('hex')
  if (size !== after.size || found !== after.sha256) {
    throw new Error(`${path} rebuilds to ${size} bytes with sha256 ${found}, and its last record says ${after.size} bytes with sha256 ${after.sha256}, so anyhost places nothing of the session.`)
  }
}

// Lines another session wrote stay. The session's lines the file lacks are appended.
async function mergeLines(path: string, placed: Uint8Array): Promise<void> {
  const local = existsSync(path) ? await Bun.file(path).text() : ''
  const present = new Set(local.split('\n'))
  const missing = new TextDecoder().decode(placed).split('\n').filter((line) => line !== '' && !present.has(line))
  await mkdir(dirname(path), { recursive: true })
  if (missing.length > 0) await appendFile(path, `${local === '' || local.endsWith('\n') ? '' : '\n'}${missing.map((line) => `${line}\n`).join('')}`)
}

// A Codex thread's row goes into this machine's Codex database. A machine Codex never ran on has none, and the
// session's session_index.jsonl line names the thread instead.
function placeCodexRow(path: string, placed: Uint8Array): void {
  if (!existsSync(path)) return
  const row = JSON.parse(new TextDecoder().decode(placed)) as Record<string, unknown>
  const db = new Database(path)
  try {
    db.run('pragma busy_timeout = 5000')
    const columns = new Set(db.query<{ name: string }, []>('pragma table_info(threads)').all().map(({ name }) => name))
    for (const key of db.query<{ table: string; from: string; to: string }, []>('pragma foreign_key_list(threads)').all()) {
      if (row[key.from] !== null && db.query(`select 1 from "${key.table}" where "${key.to}" = ?`).get(row[key.from] as string) === null) row[key.from] = null
    }
    const names = Object.keys(row).filter((name) => columns.has(name))
    db.query(`insert or replace into threads (${names.map((name) => `"${name}"`).join(', ')}) values (${names.map(() => '?').join(', ')})`).run(...(names.map((name) => row[name]) as SQLQueryBindings[]))
  } finally {
    db.close()
  }
}

// Places a replayed file at its path on this machine and answers what this machine uploaded of it.
async function placeFile(session: string, file: ReplayedFile, writers: Writers, here: Roots): Promise<FileState> {
  const path = relocate(NOTHING, file.last.path, writers.rootsOf(file.last.device), here).path
  const lines = linesFiles(here).get(path)
  const known = { journalSize: file.size, mtime: 0 }
  if (lines !== undefined || path === codexState(here)) {
    const parts: Uint8Array[] = []
    for await (const part of viewOf(file, writers, here)) parts.push(part)
    const placed = Buffer.concat(parts)
    if (lines === undefined) placeCodexRow(path, placed)
    else await mergeLines(path, placed)
    const local = lines === undefined ? placed : linesOf(await Bun.file(path).text(), lines.lines, session)
    return { session, path, ...known, localSize: local.length, tail: tailOf(local), sha256: sha256(local) }
  }
  await mkdir(dirname(path), { recursive: true })
  // 'w' empties a copy this machine already has, such as its own longer transcript of a session it takes back
  const handle = await open(path, 'w')
  const hasher = new Bun.CryptoHasher('sha256')
  let size = 0
  let tail: Uint8Array = NOTHING
  try {
    for await (const part of viewOf(file, writers, here)) {
      for (let at = 0; at < part.length; ) at += (await handle.write(part, at)).bytesWritten
      hasher.update(part)
      size += part.length
      tail = tailOf(Buffer.concat([tail, tailOf(part)]))
    }
  } finally {
    await handle.close()
  }
  return { session, path, ...known, localSize: size, tail: Uint8Array.from(tail), sha256: hasher.digest('hex'), mtime: (await stat(path)).mtimeMs }
}

// Opens the session in this terminal, in the folder it continues in: Claude Code under the runner, which ends its
// process while it rests and resumes it at the next key, and Codex as it is.
export async function openSession(tool: Tool, id: string, cwd: string): Promise<number> {
  process.chdir(cwd)
  if (tool === 'claude') return await runSession(['claude'], id)
  return await Bun.spawn(['codex', 'resume', id], { stdio: ['inherit', 'inherit', 'inherit'] }).exited
}

// The session to open here and its folder. One this machine holds opens from its own files, which are as new as R2's
// or newer, and every other restores. One that runs here already opens nowhere else, as two Claude Codes would write
// one transcript.
export async function resumeHere(capture: Capture, id: string, options: { take: boolean; checkouts: string }): Promise<{ tool: Tool; cwd: string }> {
  if ((await statusOf(capture.roots.claudeHome, id)) !== undefined) throw new Error(`${id.slice(0, 8)} runs on ${capture.device.name} already. The Herdr app shows its terminal.`)
  const journal = journalOf(capture.db, id)
  const cwd = workingFolderOf(capture.db, id)
  if (journal !== undefined && journal.holder === '' && cwd !== '' && (await claimsOf(capture.relay, id)).get(id)?.id === capture.device.id) return { tool: journal.tool, cwd }
  const { session, cwd: restored } = await restore(capture, id, options)
  return { tool: session.tool, cwd: restored }
}

// Takes the claim, downloads and replays the session's journal, checks every file against its last writer, restores
// the working folder's code, and places every file with its paths rewritten to this machine's. The relay tells the
// machine that held the session, which stops capturing it and refuses its prompts with this machine's name, at once
// or as it next connects. Answers the session and the folder it continues in. `checkouts` is the person's option of
// that name. A take with `if` takes the session only from the claim of that `at`, as a move's does, and fails with
// `HeldElsewhere` before it places anything once its holder took it again since.
export async function restore(capture: Capture, id: string, options: { take: boolean; if?: { readonly at: string }; checkouts?: string }): Promise<{ session: ListedSession; cwd: string }> {
  const { relay, db, roots } = capture
  const devices = await devicesOf(relay)
  const [indexes, claims] = await Promise.all([indexesOf(relay, devices.keys()), claimsOf(relay, id)])
  const session = (await listSessions(relay, { devices, indexes, claims })).find((entry) => entry.id === id)
  if (session === undefined) throw new Error(`No machine lists the session ${id}. anyhost list shows every session.`)
  // A session only the machine it started on wrote is that machine's by capture alone, so a resume takes it. Once
  // another machine resumed it, which lists it then, taking it needs --take.
  const hasMoved = [...indexes.values()].filter((index) => index.some((entry) => entry.id === id)).length > 1
  const claim = await takeClaim(relay, id, { take: options.take || !hasMoved, ...(options.take && options.if !== undefined ? { if: options.if } : {}) }).catch((error: unknown) => {
    // only a fenced take is refused, and its caller names why
    if (!(error instanceof HeldElsewhere) || options.take) throw error
    throw new Error(`This session continues on ${error.holder.name}. Run anyhost resume ${id} --take to continue it here.`)
  })
  const rootsOf = writersOf(devices, indexes, session)
  const folder = await localFolder(capture, session, rootsOf(session.device), options.checkouts ?? '')
  const provisional: Roots = { ...roots, checkout: checkoutOfEntry({ ...session, cwd: folder }, roots.home) }
  const staging = join(dirname(db.filename), 'restore', id)
  await rm(staging, { recursive: true, force: true })
  const named = new Map<string, string>()
  const replayed = await downloadJournal(relay, id, staging, ({ device: writer, path }) => {
    const key = `${writer}\0${path}`
    if (!named.has(key)) named.set(key, relocate(NOTHING, path, rootsOf(writer), provisional).path)
    return named.get(key) ?? path
  })
  const writers: Writers = { rootsOf, tracked: await trackedFilesOf(replayed, id) }
  // Journals earlier versions uploaded hold Claude Code's job record `jobs/<8 hex>/state.json`, which names a job only
  // the writer's daemon ran, so nothing under `jobs/` is checked, placed or deleted here.
  const jobs = `${join(roots.claudeHome, 'jobs')}/`
  const files = [...replayed.files].filter(([path]) => !path.startsWith(jobs))
  const deleted = [...replayed.deleted].filter((path) => !path.startsWith(jobs))
  // A lines file is shared by every session, and its writer's view of the session's lines can hold lines the journal
  // never got, such as the prompts that machine refused while another one held the session. So nothing checks it, and
  // placing it appends the session's lines this machine lacks.
  for (const [path, file] of files) if (!linesFiles(roots).has(path)) await checkFile(file, writers)
  const code = [...replayed.code.values()].at(-1)
  if (code !== undefined && sha256(code.bytes) !== code.header.after?.sha256) throw new Error(`The code record of ${code.header.path} does not hash to the sha256 its header says.`)
  const readPart = async (path: string): Promise<Uint8Array> => {
    const part = replayed.files.get(path)
    if (part === undefined) throw new Error(`The code of ${id} names the part ${path}, which its journal does not hold.`)
    return new Uint8Array(await Bun.file(part.staged).arrayBuffer())
  }
  let cwd = folder
  if (code !== undefined) cwd = await capture.restoreCode(code.bytes, readPart, folder)
  else await cloneMissing(session, folder, roots.home)
  await mkdir(cwd, { recursive: true })
  const here: Roots = { ...roots, checkout: checkoutOfEntry({ ...session, cwd }, roots.home) }
  stopJournal(db, id, session.tool, `anyhost resume is placing the files of ${id}, and stopped there.`)
  const placed: FileState[] = []
  for (const [path, file] of files) {
    // a code part stays in the journal: this machine holds it, so capture never uploads it again
    if (isCodePart(path)) placed.push({ session: id, path, journalSize: file.size, localSize: file.size, tail: NOTHING, sha256: file.last.after.sha256, mtime: 0 })
    else placed.push(await placeFile(id, file, writers, here))
  }
  // a file the session deleted is gone here too, and capture knows it, so it uploads the file whole if it comes back
  for (const path of deleted) {
    await rm(path, { force: true })
    placed.push({ session: id, path, journalSize: 0, localSize: 0, tail: NOTHING, sha256: '', mtime: 0 })
  }
  continueJournal(db, { session: id, tool: session.tool, end: replayed.end, sealed: replayed.sealedEnd }, placed)
  const transcript = placed.find(({ path }) => {
    const owner = ownerOf(path, roots)
    return owner !== undefined && 'isTranscript' in owner && owner.isTranscript
  })
  await recordSummary(capture, id, session.tool, transcript === undefined ? '' : await Bun.file(transcript.path).text(), replayed.end, session.lastActivity)
  // this machine lists the session at once, so taking it back from here needs --take
  await writeIndex(capture)
  await rm(staging, { recursive: true, force: true })
  if (claim.previous !== undefined && !claim.told) markUntold(db, id, claim.previous.name)
  return { session, cwd }
}
