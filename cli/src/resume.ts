import { mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { checkoutOf, openDatabase, placeFile, recordSummary } from './capture.ts'
import { HeldElsewhere, takeClaim } from './claims.ts'
import { devicesOf, type Device } from './device.ts'
import { downloadSession, listSessions, type ListedSession } from './sessions.ts'
import type { Store } from './store.ts'
import { placementOf, withCwd } from './transcript.ts'

const CHECKOUTS = join(homedir(), 'Developer')

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

async function findCheckout(remote: string): Promise<string | undefined> {
  const db = openDatabase()
  const known = db.query<{ cwd: string; repo_folder: string }, []>("select distinct cwd, repo_folder from sessions where repo != ''").all()
  db.close()
  const children = (await isFolder(CHECKOUTS)) ? (await readdir(CHECKOUTS)).map((name) => ({ cwd: join(CHECKOUTS, name), repo_folder: '' })) : []
  for (const { cwd, repo_folder } of [...known, ...children]) {
    const root = repo_folder === '' ? cwd : cwd.slice(0, -repo_folder.length - 1)
    if (sameRepo((await checkoutOf(root)).repo, remote)) return root
  }
  return undefined
}

async function localCwd(session: ListedSession): Promise<string> {
  if (session.repo === '') return (await isFolder(session.cwd)) ? session.cwd : homedir()
  let root = await findCheckout(session.repo)
  if (root === undefined) {
    root = join(CHECKOUTS, basename(repoSlug(session.repo)))
    if (await isFolder(root)) throw new Error(`${root} holds another repository than ${session.repo}, so anyhost does not clone the session's repository there. Clone it yourself, then run anyhost resume again.`)
    await mkdir(CHECKOUTS, { recursive: true })
    console.log(`Cloning ${session.repo} into ${root}`)
    await run(['git', 'clone', session.repo, root])
  }
  const cwd = join(root, session.repoFolder)
  return (await isFolder(cwd)) ? cwd : root
}

async function herdrRuns(): Promise<boolean> {
  if (Bun.which('herdr') === null) return false
  return (await run(['herdr', 'status', 'server']).catch(() => '')).includes('status: running')
}

async function openClaude(session: ListedSession, cwd: string): Promise<number> {
  if (await herdrRuns()) {
    const created = JSON.parse(await run(['herdr', 'workspace', 'create', '--cwd', cwd, '--label', session.title || session.id])) as { result: { root_pane: { pane_id: string } } }
    await run(['herdr', 'pane', 'run', created.result.root_pane.pane_id, `claude --resume ${session.id}`])
    console.log(`Resumed ${session.id} in a herdr pane in ${cwd}.`)
    return 0
  }
  return await Bun.spawn(['claude', '--resume', session.id], { cwd, stdio: ['inherit', 'inherit', 'inherit'] }).exited
}

export async function resume(store: Store, device: Device, id: string, options: { take: boolean }): Promise<number> {
  const devices = await devicesOf(store)
  const session = (await listSessions(store, devices)).find((listed) => listed.id === id)
  if (session === undefined) throw new Error(`No machine lists the session ${id}. anyhost list shows every session.`)
  if (session.tool !== 'claude') throw new Error(`${id} is a Codex session, and anyhost resumes Claude Code sessions.`)
  try {
    await takeClaim(store, id, device.id, options)
  } catch (error) {
    if (!(error instanceof HeldElsewhere)) throw error
    throw new Error(`This session continues on ${devices.get(error.device)?.name ?? error.device}. Run anyhost resume ${id} --take to continue it here.`)
  }
  const transcripts = await downloadSession(store, devices.keys(), id)
  const main = transcripts.get(id)
  if (main === undefined) throw new Error(`R2 holds no transcript of the session ${id}.`)
  const cwd = await localCwd(session)
  const db = openDatabase()
  for (const [key, bytes] of transcripts) {
    const placed = new TextEncoder().encode(withCwd(new TextDecoder().decode(bytes), cwd))
    const path = placementOf(key, cwd)
    placeFile(db, path, key, placed.length, bytes.length)
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(path, placed)
  }
  await recordSummary(db, id, 'claude', withCwd(new TextDecoder().decode(main), cwd), main.length, session.lastActivity)
  db.close()
  return await openClaude(session, cwd)
}
