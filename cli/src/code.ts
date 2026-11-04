import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { stateFolder } from './device.ts'

// GitHub recommends at most 6 pushes a minute per repository.
const PUSH_GAP_MS = 10_000
// GitHub refuses a file over 100 MiB, so commits that carry one reach the journal as a bundle.
const LARGEST_PUSHED_FILE = 100 * 1024 * 1024
// A push, fetch or clone ends after 10 minutes: 750 MB at the 1.26 MB/s uplink measured on anyhost's first upload.
const NETWORK_MS = 10 * 60_000
// A part over 64 KiB is its own journal record, written once, so a change elsewhere never uploads it again.
const PART_LIMIT = 64 * 1024
const EMPTY_TREE: Readonly<Record<string, string>> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
}
// What git keeps in a worktree's git folder while a merge, rebase, cherry-pick or revert waits on the person.
const OPERATION_FILES = ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'SQUASH_MSG', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']
const ANYHOST = { GIT_AUTHOR_NAME: 'anyhost', GIT_AUTHOR_EMAIL: 'anyhost@anyhost.invalid', GIT_COMMITTER_NAME: 'anyhost', GIT_COMMITTER_EMAIL: 'anyhost@anyhost.invalid' }
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }

type Stage = { readonly path: string; readonly mode: string; readonly stage: string; readonly id: string }
type Trees = { readonly index: string; readonly worktree: string; readonly conflicts: readonly Stage[] }
type Remote = { readonly name: string; readonly url: string }
type Stashed = { readonly id: string; readonly message: string }

type CodeRecord = {
  readonly session: string
  readonly kind: 'repo' | 'folder'
  readonly subfolder: string
  readonly head: string | null
  readonly branch: string | null
  readonly upstream: string | null
  readonly trees: { readonly index: string; readonly worktree: string }
  readonly conflicts: readonly Stage[]
  readonly remote: Remote | null
  readonly keep: string | null
  readonly branches: Readonly<Record<string, string>>
  readonly stash: readonly Stashed[]
  // Parts by sha256: the staged and unstaged diffs as file patches, conflict blobs by git id, operation files, bundles.
  readonly staged: readonly string[]
  readonly unstaged: readonly string[]
  readonly blobs: Readonly<Record<string, string>>
  readonly operation: readonly (readonly [string, string])[]
  readonly bundles: readonly string[]
  // Every part the header names: inline ones follow the header line in this order, records are journal records.
  readonly parts: readonly (readonly [string, number, 'inline' | 'record'])[]
}

type Part = { readonly hash: string; readonly size: number; readonly bytes?: Uint8Array }

/** A code record: the header, and the parts over 64 KiB the session's journal does not hold yet, each its own record. */
export type CodeCapture = { readonly header: Uint8Array; readonly parts: readonly { readonly path: string; readonly bytes: Uint8Array }[] }

type Repository = {
  readonly kind: 'repo' | 'folder'
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly subfolder: string
  readonly gitDir: string
  readonly commonDir: string
  readonly index: string
  readonly emptyTree: string
}

type Ran = { readonly code: number | null; readonly out: Uint8Array; readonly err: string }
type RunOptions = { readonly input?: Uint8Array | string; readonly env?: Readonly<Record<string, string>>; readonly deadline?: number }

const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const linesOf = (bytes: Uint8Array): string[] => textOf(bytes).split('\n').filter((line) => line !== '')
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

async function run(repo: Pick<Repository, 'cwd' | 'env'>, args: readonly string[], options: RunOptions = {}): Promise<Ran> {
  const child = Bun.spawn(['git', ...args], {
    cwd: repo.cwd,
    env: { ...process.env, ...GIT_ENV, ...repo.env, ...options.env },
    stdin: options.input === undefined ? 'ignore' : typeof options.input === 'string' ? new TextEncoder().encode(options.input) : options.input,
    stdout: 'pipe',
    stderr: 'pipe',
    ...(options.deadline === undefined ? {} : { timeout: options.deadline }),
  })
  const [out, err, code] = await Promise.all([new Response(child.stdout).bytes(), new Response(child.stderr).text(), child.exited])
  if (child.signalCode !== null) return { code: null, out, err: `ended by ${child.signalCode}${options.deadline === undefined ? '' : `, its limit being ${options.deadline / 60_000} minutes`}` }
  return { code, out, err: err.trim() }
}

async function git(repo: Pick<Repository, 'cwd' | 'env'>, args: readonly string[], options: RunOptions = {}): Promise<Uint8Array> {
  const done = await run(repo, args, options)
  if (done.code !== 0) throw new Error(`git ${args.join(' ')} in ${repo.cwd} ${done.code === null ? done.err : `exited ${done.code}: ${done.err}`}`)
  return done.out
}

const valueOf = async (repo: Repository, args: readonly string[], options?: RunOptions): Promise<string> => textOf(await git(repo, args, options)).trim()

async function commitOf(repo: Repository, name: string): Promise<string | null> {
  const done = await run(repo, ['rev-parse', '-q', '--verify', `${name}^{commit}`])
  return done.code === 0 ? textOf(done.out).trim() : null
}

async function openRepository(cwd: string, kind: Repository['kind'], env: Readonly<Record<string, string>> = {}): Promise<Repository | undefined> {
  const asked = await run({ cwd, env }, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir', '--git-path', 'index', '--show-prefix', '--show-object-format'])
  if (asked.code !== 0 && asked.err.includes('not a git repository')) return undefined
  if (asked.code !== 0) throw new Error(`git rev-parse in ${cwd} exited ${asked.code}: ${asked.err}`)
  const [top = '', gitDir = '', commonDir = '', index = '', prefix = '', format = 'sha1'] = textOf(asked.out).split('\n')
  return { kind, cwd: top, env, subfolder: prefix.replace(/\/$/, ''), gitDir, commonDir, index, emptyTree: EMPTY_TREE[format] ?? EMPTY_TREE['sha1'] ?? '' }
}

// A folder outside git gets its own git folder in anyhost's state, so git walks, hashes and diffs it as it does a checkout.
async function folderRepository(folder: string): Promise<Repository> {
  const gitDir = join(stateFolder(), 'folders', `${sha256(await realpath(folder)).slice(0, 16)}.git`)
  if (!(await exists(gitDir))) await git({ cwd: folder, env: {} }, ['init', '-q', '--bare', gitDir])
  const repo = await openRepository(folder, 'folder', { GIT_DIR: gitDir, GIT_WORK_TREE: folder })
  if (repo === undefined) throw new Error(`git refused ${gitDir} as the git folder of ${folder}.`)
  return repo
}

async function repositoryOf(folder: string): Promise<Repository | undefined> {
  const found = await openRepository(folder, 'repo')
  if (found !== undefined) return found
  // The home folder and every folder above it hold the person's whole machine, never a session's code.
  if (!relative(await realpath(folder), await realpath(homedir())).startsWith('..')) return undefined
  return await folderRepository(folder)
}

// A copy of an index keeps the index's modified time. git trusts an entry's stat data only when the file was modified
// before the index was written, so a newer time would hide an edit of the same size made in that second.
async function copyIndex(from: string, to: string): Promise<void> {
  const { atime, mtime } = await stat(from)
  await copyFile(from, to)
  await utimes(to, atime, mtime)
}

// The index tree with every conflicted path at its HEAD version, the worktree tree of every file .gitignore allows,
// and the conflict stages, all read from a copy of the index, so capture never takes the session's index.lock.
async function treesOf(repo: Repository, head: string | null): Promise<Trees> {
  const temp = await mkdtemp(join(tmpdir(), 'anyhost-code-'))
  try {
    const index = join(temp, 'index')
    if (await exists(repo.index)) await copyIndex(repo.index, index)
    const env = { GIT_INDEX_FILE: index }
    const conflicts = textOf(await git(repo, ['ls-files', '-s', '-z'], { env }))
      .split('\0')
      .filter((entry) => entry !== '' && !/^\d+ [0-9a-f]+ 0\t/.test(entry))
      .map((entry) => {
        const [meta = '', path = ''] = entry.split('\t')
        const [mode = '', id = '', stage = ''] = meta.split(' ')
        return { path, mode, stage, id }
      })
    if (conflicts.length > 0) {
      const paths = [...new Set(conflicts.map(({ path }) => path))]
      const zero = '0'.repeat(repo.emptyTree.length)
      const inHead = head === null ? [] : textOf(await git(repo, ['ls-tree', '-z', '--full-tree', head, '--', ...paths], { env: { GIT_LITERAL_PATHSPECS: '1' } })).split('\0').filter((entry) => entry !== '')
      const atHead = inHead.map((entry) => {
        const [meta = '', path = ''] = entry.split('\t')
        const [mode = '', , id = ''] = meta.split(' ')
        return `${mode} ${id} 0\t${path}`
      })
      await git(repo, ['update-index', '-z', '--index-info'], { env, input: [...paths.map((path) => `0 ${zero}\t${path}`), ...atHead].map((line) => `${line}\0`).join('') })
    }
    const staged = repo.kind === 'folder' ? repo.emptyTree : await valueOf(repo, ['write-tree'], { env })
    await git(repo, ['add', '-A', '--', ':/'], { env })
    const worktree = await valueOf(repo, ['write-tree'], { env })
    // A folder outside git keeps its index, so the next capture rehashes only the files that changed.
    if (repo.kind === 'folder') await copyIndex(index, repo.index)
    return { index: staged, worktree, conflicts }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

async function operationFilesOf(repo: Repository): Promise<[string, Uint8Array][]> {
  const files: [string, Uint8Array][] = []
  for (const name of OPERATION_FILES) {
    const path = join(repo.gitDir, name)
    const found = await stat(path).catch(() => undefined)
    if (found === undefined) continue
    // gpg_sign_opt copies this machine's commit.gpgSign, so the machine that continues the rebase signs by its own config.
    const paths = found.isDirectory()
      ? (await readdir(path, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile() && entry.name !== 'gpg_sign_opt').map((entry) => join(entry.parentPath, entry.name))
      : [path]
    for (const file of paths.sort()) files.push([`git/${relative(repo.gitDir, file)}`, new Uint8Array(await readFile(file))])
  }
  return files
}

// Every remote with its configured URL, before insteadOf, and without the password an https URL can carry.
async function remotesOf(repo: Repository): Promise<Remote[]> {
  const urls = await run(repo, ['config', '-z', '--get-regexp', '^remote\\..+\\.url$'])
  if (urls.code !== 0 && urls.code !== 1) throw new Error(`git config --get-regexp remote urls in ${repo.cwd} exited ${urls.code}: ${urls.err}`)
  return textOf(urls.out)
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [key = '', url = ''] = entry.split('\n')
      return { name: key.slice('remote.'.length, -'.url'.length), url: url.replace(/^(https?:\/\/)[^/@]*@/, '$1') }
    })
}

async function refsOf(repo: Repository) {
  const head = await commitOf(repo, 'HEAD')
  const symbolic = textOf((await run(repo, ['symbolic-ref', '-q', 'HEAD'])).out).trim()
  const refs = linesOf(await git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:remotename)', 'refs/heads', 'refs/stash'])).map((line) => line.split('\0'))
  const branches = Object.fromEntries(refs.filter(([name = '']) => name.startsWith('refs/heads/')).map(([name = '', id = '']) => [name.slice('refs/heads/'.length), id]))
  const current = refs.find(([name]) => name === symbolic)
  const stash = refs.some(([name]) => name === 'refs/stash')
    ? linesOf(await git(repo, ['log', '-g', '--format=%H%x00%gs', 'refs/stash'])).map((line) => {
        const [id = '', message = ''] = line.split('\0')
        return { id, message }
      })
    : []
  const remotes = await remotesOf(repo)
  const remote = remotes.find(({ name }) => name === current?.[3]) ?? remotes.find(({ name }) => name === 'origin') ?? remotes[0] ?? null
  return {
    head,
    branch: symbolic.startsWith('refs/heads/') ? symbolic.slice('refs/heads/'.length) : null,
    upstream: current?.[2] || null,
    branches,
    stash,
    remote,
  }
}

// The commits a merge, rebase, cherry-pick or revert in progress names, so the keep ref holds them too.
async function operationCommitsOf(repo: Repository, files: readonly [string, Uint8Array][]): Promise<string[]> {
  const ids = files.flatMap(([, bytes]) => {
    const lines = textOf(bytes).trim().split('\n')
    return lines.every((line) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(line)) ? lines : []
  })
  if (ids.length === 0) return []
  const types = linesOf(await git(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: `${ids.join('\n')}\n` }))
  return types.filter((line) => line.endsWith(' commit')).map((line) => line.split(' ')[0] ?? '')
}

// The keep ref, refs/anyhost/<session>: an empty-tree commit whose parents are the previous keep commit and every tip
// no remote branch holds, so the ref only moves forward and git gc never prunes a captured commit.
async function keepCommits(repo: Repository, session: string, tips: readonly string[]): Promise<string | null> {
  const ref = `refs/anyhost/${session}`
  const kept = await commitOf(repo, ref)
  if (tips.length === 0) return kept
  const loose = new Set(linesOf(await git(repo, ['rev-list', ...tips, '--not', '--remotes', ...(kept === null ? [] : [kept])])))
  const fresh = [...new Set(tips.filter((tip) => loose.has(tip)))]
  if (fresh.length === 0) return kept
  const parents = [...(kept === null ? [] : [kept]), ...fresh].flatMap((id) => ['-p', id])
  const keep = await valueOf(repo, ['commit-tree', '--no-gpg-sign', repo.emptyTree, ...parents, '-m', `anyhost keeps the commits of session ${session}`], { env: ANYHOST })
  await git(repo, ['update-ref', '-m', 'anyhost', ref, keep, kept ?? '0'.repeat(repo.emptyTree.length)])
  return keep
}

type Push = { readonly refs: Set<string>; readonly refused: Promise<Map<string, string>> }
type PushQueue = { startedAt: number; previous: Promise<unknown>; waiting: Push | undefined }
const pushQueues = new Map<string, PushQueue>()
const pushedKeeps = new Map<string, string>()

// Every ref of one repository's sessions waiting at once goes in one push, at most one push every 10 s.
// --no-verify: the person's pre-push hook guards what they publish on their branches; it would run their tests or
// linters on every capture and refuse work in progress, while the hidden ref publishes no branch.
async function pushRefs(repo: Repository, remote: string, refs: readonly string[]): Promise<Map<string, string>> {
  const done = await run(repo, ['push', '--porcelain', '--no-verify', '--no-follow-tags', '--no-signed', '--recurse-submodules=no', remote, ...refs.map((ref) => `${ref}:${ref}`)], { deadline: NETWORK_MS })
  const answers = new Map(
    textOf(done.out)
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((fields) => fields.length === 3)
      .map(([flag = '', spec = '', summary = '']) => [spec.split(':')[1] ?? '', { flag, summary }] as const),
  )
  return new Map(
    refs.flatMap((ref) => {
      const answer = answers.get(ref)
      if (answer !== undefined && [' ', '*', '='].includes(answer.flag)) return []
      return [[ref, `git push ${remote} ${ref} answered ${answer?.summary ?? (done.code === null ? done.err : `exit ${done.code}: ${done.err}`)}`] as const]
    }),
  )
}

function pushRef(repo: Repository, remote: string, ref: string): Promise<string | undefined> {
  const key = `${repo.commonDir}\0${remote}`
  const queue = pushQueues.get(key) ?? { startedAt: 0, previous: Promise.resolve(), waiting: undefined }
  pushQueues.set(key, queue)
  if (queue.waiting === undefined) {
    const refs = new Set<string>()
    const refused = queue.previous.then(async () => {
      await Bun.sleep(Math.max(0, queue.startedAt + PUSH_GAP_MS - Date.now()))
      queue.waiting = undefined
      queue.startedAt = Date.now()
      return await pushRefs(repo, remote, [...refs])
    })
    queue.waiting = { refs, refused }
    queue.previous = refused.catch(() => undefined)
  }
  queue.waiting.refs.add(ref)
  return queue.waiting.refused.then((answers) => answers.get(ref))
}

// Why the remote does not hold the keep commit, or undefined once it does.
async function pushKeep(repo: Repository, remote: Remote, session: string, keep: string): Promise<string | undefined> {
  const key = `${repo.commonDir}\0${remote.name}\0${session}`
  if (pushedKeeps.get(key) === keep) return undefined
  const omitted = linesOf(await git(repo, ['rev-list', '--objects', `--filter=blob:limit=${LARGEST_PUSHED_FILE + 1}`, '--filter-print-omitted', keep, '--not', '--remotes'])).filter((line) => line.startsWith('~'))
  if (omitted.length > 0) return `its commits hold ${omitted.length === 1 ? 'a file' : `${omitted.length} files`} over the 100 MiB GitHub takes in a push`
  const refused = await pushRef(repo, remote.name, `refs/anyhost/${session}`)
  if (refused === undefined) pushedKeeps.set(key, keep)
  return refused
}

const partOf = (bytes: Uint8Array): Part => ({ hash: sha256(bytes), size: bytes.length, bytes })
const partPath = (session: string, hash: string): string => `anyhost:code/${session}/parts/${hash}`

// What the session's journal holds for this repository: the part records captureCode returned or restoreCode read, and
// the chain of bundles since the remote last held the session's commits.
type Journaled = { readonly parts: readonly string[]; readonly bundles: readonly Part[]; readonly bundled: string | null }
const journaledPath = (repo: Repository, session: string): string => join(stateFolder(), 'code', session, `${sha256(repo.commonDir).slice(0, 16)}.json`)

async function journaledOf(repo: Repository, session: string): Promise<Journaled> {
  const found = await readFile(journaledPath(repo, session), 'utf8').catch(() => undefined)
  return found === undefined ? { parts: [], bundles: [], bundled: null } : (JSON.parse(found) as Journaled)
}

async function saveJournaled(repo: Repository, session: string, journaled: Journaled): Promise<void> {
  await mkdir(dirname(journaledPath(repo, session)), { recursive: true })
  await writeFile(journaledPath(repo, session), JSON.stringify(journaled))
}

// Each changed file over 64 KiB gets its own patch, so an unchanged big file keeps its part's hash and is never
// diffed again once the journal holds it. The other files share one patch.
const bigPatches = new Map<string, Part>()

async function patchesOf(repo: Repository, from: string, to: string, journaled: ReadonlySet<string>): Promise<Part[]> {
  if (from === to) return []
  const raw = textOf(await git(repo, ['diff-tree', '-r', '-z', '--no-renames', from, to])).split('\0')
  const entries: { readonly key: string; readonly path: string; readonly ids: readonly string[] }[] = []
  for (let at = 0; at + 1 < raw.length; at += 2) {
    const [oldMode = '', newMode = '', oldId = '', newId = ''] = (raw[at] ?? '').slice(1).split(' ')
    entries.push({ key: [raw[at + 1], oldMode, newMode, oldId, newId].join('\0'), path: raw[at + 1] ?? '', ids: [oldId, newId].filter((id) => !/^0+$/.test(id)) })
  }
  const ids = [...new Set(entries.flatMap((entry) => entry.ids))]
  const sizes = new Map(
    ids.length === 0 ? [] : linesOf(await git(repo, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: `${ids.join('\n')}\n` })).map((line) => [line.split(' ')[0] ?? '', Number(line.split(' ')[1])] as const),
  )
  const big = entries.filter((entry) => entry.ids.some((id) => (sizes.get(id) ?? 0) > PART_LIMIT))
  const patch = async (pathspecs: readonly string[]): Promise<Part> => partOf(await git(repo, ['diff-tree', '-p', '--binary', '--full-index', '--no-renames', from, to, '--', ...pathspecs]))
  const parts = big.length < entries.length ? [await patch(big.map((entry) => `:(exclude,literal)${entry.path}`))] : []
  for (const entry of big) {
    const known = bigPatches.get(entry.key)
    const part = known !== undefined && journaled.has(known.hash) ? known : await patch([`:(literal)${entry.path}`])
    bigPatches.set(entry.key, { hash: part.hash, size: part.size })
    parts.push(part)
  }
  return parts
}

function encode(record: Omit<CodeRecord, 'parts'>, parts: readonly Part[], records: ReadonlySet<string>): Uint8Array {
  const inline = parts.filter((part) => !records.has(part.hash))
  const header = JSON.stringify({ ...record, parts: parts.map((part) => [part.hash, part.size, records.has(part.hash) ? 'record' : 'inline'] as const) } satisfies CodeRecord)
  return Buffer.concat([Buffer.from(`${header}\n`), ...inline.map((part) => part.bytes ?? new Uint8Array())])
}

async function decode(header: Uint8Array, readPart: (path: string) => Promise<Uint8Array>): Promise<{ record: CodeRecord; parts: Map<string, Uint8Array> }> {
  const end = header.indexOf(10)
  const record = JSON.parse(textOf(header.subarray(0, end))) as CodeRecord
  const parts = new Map<string, Uint8Array>()
  let at = end + 1
  for (const [hash, size, where] of record.parts) {
    if (where === 'inline') {
      parts.set(hash, header.subarray(at, at + size))
      at += size
    }
  }
  if (at !== header.length) throw new Error(`The code record of session ${record.session} holds ${header.length} bytes, and its inline parts end at byte ${at}.`)
  const records = record.parts.filter(([, , where]) => where === 'record')
  await Promise.all(records.map(async ([hash]) => parts.set(hash, await readPart(partPath(record.session, hash)))))
  for (const [hash, size] of record.parts) {
    const bytes = parts.get(hash) ?? new Uint8Array()
    if (bytes.length !== size || sha256(bytes) !== hash) throw new Error(`Part ${hash} of session ${record.session}'s code record came back as ${bytes.length} bytes with sha256 ${sha256(bytes)}.`)
  }
  return { record, parts }
}

const recorded = new Map<string, string>()

/**
 * The working folder's state as one code record. The header holds `{head, branch, upstream, trees}` and the rest, and
 * names every part by sha256: the staged diff against HEAD and the unstaged diff against the index (untracked files as
 * .gitignore allows) as file patches, conflict stages, the files of an operation in progress, and incremental git
 * bundles while the remote does not hold the session's commits. Parts up to 64 KiB follow the header line; larger ones
 * and every bundle are returned as records at anyhost:code/<session>/parts/<sha256>, each only the first time.
 * The journal must hold every returned part before the header that names it.
 * Unpushed commits go to the hidden ref refs/anyhost/<session> on the repository's remote first.
 * Returns undefined when nothing changed since the session's last record, or for the home folder and the folders above it.
 */
export async function captureCode(folder: string, session: string): Promise<CodeCapture | undefined> {
  if (!(await exists(folder))) throw new Error(`Session ${session} works in ${folder}, which no longer exists, so anyhost keeps its last code record.`)
  const repo = await repositoryOf(resolve(folder))
  if (repo === undefined) return undefined
  const refs = repo.kind === 'repo' ? await refsOf(repo) : { head: null, branch: null, upstream: null, branches: {}, stash: [], remote: null }
  const operation = repo.kind === 'repo' ? await operationFilesOf(repo) : []
  const trees = await treesOf(repo, refs.head)
  const tips = [refs.head, ...Object.values(refs.branches), ...refs.stash.map(({ id }) => id), ...(await operationCommitsOf(repo, operation))].filter((id) => id !== null)
  const keep = repo.kind === 'repo' ? await keepCommits(repo, session, tips) : null
  const record = { session, kind: repo.kind, subfolder: repo.subfolder, ...refs, trees: { index: trees.index, worktree: trees.worktree }, conflicts: trees.conflicts, keep }
  const fingerprint = sha256(JSON.stringify([record, operation.map(([name, bytes]) => [name, sha256(bytes)])]))
  if (recorded.get(session) === fingerprint) return undefined

  const journaled = await journaledOf(repo, session)
  const held = new Set(journaled.parts)
  const headTree = refs.head === null ? repo.emptyTree : await valueOf(repo, ['rev-parse', `${refs.head}^{tree}`])
  const staged = await patchesOf(repo, headTree, trees.index, held)
  const unstaged = await patchesOf(repo, trees.index, trees.worktree, held)
  const blobs = new Map<string, Part>()
  for (const { id } of trees.conflicts) blobs.set(id, partOf(await git(repo, ['cat-file', 'blob', id])))
  const files = operation.map(([name, bytes]) => [name, partOf(bytes)] as const)
  const { bundles, bundled } = await bundlesOf(repo, session, keep, refs.remote, journaled)
  const parts = new Map([...staged, ...unstaged, ...blobs.values(), ...files.map(([, part]) => part), ...bundles].map((part) => [part.hash, part]))
  // Bundles are records at any size: the chain grows, and an inline bundle would ride along in every later header.
  const records = new Set([...[...parts.values()].filter((part) => part.size > PART_LIMIT), ...bundles].map((part) => part.hash))
  const header = encode(
    {
      ...record,
      staged: staged.map((part) => part.hash),
      unstaged: unstaged.map((part) => part.hash),
      blobs: Object.fromEntries([...blobs].map(([id, part]) => [id, part.hash])),
      operation: files.map(([name, part]) => [name, part.hash]),
      bundles: bundles.map((part) => part.hash),
    },
    [...parts.values()],
    records,
  )
  const fresh = [...parts.values()].filter((part) => records.has(part.hash) && !held.has(part.hash))
  await saveJournaled(repo, session, { parts: [...held, ...fresh.map((part) => part.hash)], bundles: bundles.map(({ hash, size }) => ({ hash, size })), bundled })
  recorded.set(session, fingerprint)
  return { header, parts: fresh.map((part) => ({ path: partPath(session, part.hash), bytes: part.bytes ?? new Uint8Array() })) }
}

// The bundles that carry the session's commits while the remote does not hold them: the chain so far, and a new bundle
// of the commits since the last one whenever the keep commit moved. A push the remote takes ends the chain.
async function bundlesOf(repo: Repository, session: string, keep: string | null, remote: Remote | null, journaled: Journaled): Promise<{ bundles: Part[]; bundled: string | null }> {
  const chain = journaled.bundles.map(({ hash, size }) => ({ hash, size }))
  if (keep === null) return { bundles: [], bundled: null }
  if (journaled.bundled === keep) return { bundles: chain, bundled: keep }
  const refused = remote === null ? undefined : await pushKeep(repo, remote, session, keep)
  if (remote !== null && refused === undefined) return { bundles: [], bundled: null }
  if (refused !== undefined) console.warn(`anyhost keeps the commits of session ${session} in its journal, because ${refused}.`)
  const since = journaled.bundled !== null && (await commitOf(repo, journaled.bundled)) !== null ? [`^${journaled.bundled}`] : []
  const bundle = partOf(await git(repo, ['bundle', 'create', '-q', '-', `refs/anyhost/${session}`, ...since, '--not', '--remotes']))
  return { bundles: [...(since.length === 0 ? [] : chain), bundle], bundled: keep }
}

const sameTrees = (a: Trees, b: CodeRecord): boolean => a.index === b.trees.index && a.worktree === b.trees.worktree && JSON.stringify(a.conflicts) === JSON.stringify(b.conflicts)

async function check(repo: Repository, record: CodeRecord): Promise<void> {
  const trees = await treesOf(repo, record.head)
  if (!sameTrees(trees, record)) {
    throw new Error(`The restored ${repo.cwd} hashes to index ${trees.index} and worktree ${trees.worktree}, and session ${record.session} recorded index ${record.trees.index} and worktree ${record.trees.worktree}.`)
  }
}

// Applies the file patches as one patch: to the index and the worktree for the staged diff, to the worktree alone after it.
async function apply(repo: Repository, patches: readonly string[], parts: ReadonlyMap<string, Uint8Array>, index: boolean): Promise<void> {
  if (patches.length === 0) return
  await git(repo, ['apply', ...(index ? ['--index'] : []), '--whitespace=nowarn', '-'], { input: Buffer.concat(patches.map((hash) => parts.get(hash) ?? new Uint8Array())) })
}

const besideOf = (folder: string, session: string): string => `${folder}-${session.slice(0, 8)}`

async function isEmptyFolder(folder: string): Promise<boolean> {
  return (await readdir(folder).catch(() => [])).length === 0
}

async function holdsFolder(folder: string, record: CodeRecord): Promise<boolean> {
  const repo = await folderRepository(folder)
  if ((await treesOf(repo, null)).worktree !== record.trees.worktree) return false
  await rememberJournaled(repo, record)
  return true
}

// A folder outside git restores into the folder when it is empty, and beside it when it holds other files.
async function restoreFolder(record: CodeRecord, parts: ReadonlyMap<string, Uint8Array>, folder: string): Promise<string> {
  let target = folder
  if (!(await isEmptyFolder(folder))) {
    if (await holdsFolder(folder, record)) return folder
    target = besideOf(folder, record.session)
    if (!(await isEmptyFolder(target))) {
      if (await holdsFolder(target, record)) return target
      throw new Error(`${folder} and ${target} both hold files of their own, so session ${record.session}'s folder has nowhere to go.`)
    }
    console.log(`${folder} holds files of its own, so session ${record.session}'s folder restores into ${target}.`)
  }
  await mkdir(target, { recursive: true })
  const repo = await folderRepository(target)
  await apply(repo, record.unstaged, parts, false)
  await check(repo, record)
  await rememberJournaled(repo, record)
  return target
}

// The parts and bundles a restore read are in the session's journal, so this machine's next capture names them and
// continues the bundle chain instead of writing them again.
async function rememberJournaled(repo: Repository, record: CodeRecord): Promise<void> {
  const sizes = new Map(record.parts.map(([hash, size]) => [hash, size]))
  const bundles = record.bundles.map((hash) => ({ hash, size: sizes.get(hash) ?? 0 }))
  const parts = record.parts.filter(([, , where]) => where === 'record').map(([hash]) => hash)
  await saveJournaled(repo, record.session, { parts, bundles, bundled: bundles.length === 0 ? null : record.keep })
}

// The checkout at root: the one there, or a clone of the session's remote (an empty repository without one).
async function checkoutAt(root: string, record: CodeRecord): Promise<{ repo: Repository; fresh: boolean }> {
  const found = (await exists(root)) ? await openRepository(root, 'repo') : undefined
  if (found !== undefined && (await realpath(found.cwd)) === (await realpath(root))) return { repo: found, fresh: false }
  if (!(await isEmptyFolder(root))) throw new Error(`${root} holds files and no checkout of its own, so session ${record.session}'s code does not restore there.`)
  await mkdir(dirname(root), { recursive: true })
  if (record.remote === null) await git({ cwd: dirname(root), env: {} }, ['init', '-q', root])
  else {
    console.log(`Cloning ${record.remote.url} into ${root}`)
    await git({ cwd: dirname(root), env: {} }, ['clone', '-q', '--no-checkout', '--origin', record.remote.name, record.remote.url, root], { deadline: NETWORK_MS })
  }
  const repo = await openRepository(root, 'repo')
  if (repo === undefined) throw new Error(`git made ${root}, and it is not a checkout.`)
  return { repo, fresh: true }
}

// The session's commits: from the record's bundles, oldest first, or from refs/anyhost/<session> on the remote. A checkout
// that was here fetches the remote first, since the session's HEAD can be a commit pushed after this checkout's last fetch.
async function fetchCommits(repo: Repository, record: CodeRecord, parts: ReadonlyMap<string, Uint8Array>, fresh: boolean): Promise<void> {
  const ref = `refs/anyhost/${record.session}`
  let source = record.remote?.name
  if (record.remote !== null && !fresh) {
    const url = record.remote.url
    source = (await remotesOf(repo)).find((remote) => remote.url === url)?.name
    await git(repo, ['fetch', '-q', ...(source === undefined ? [url, 'refs/heads/*'] : [source])], { deadline: NETWORK_MS })
    source ??= url
  }
  if (record.bundles.length > 0) {
    const temp = await mkdtemp(join(tmpdir(), 'anyhost-bundle-'))
    try {
      for (const hash of record.bundles) {
        await writeFile(join(temp, 'commits.bundle'), parts.get(hash) ?? new Uint8Array())
        await git(repo, ['fetch', '-q', join(temp, 'commits.bundle'), `${ref}:${ref}`])
      }
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  } else if (record.keep !== null && source !== undefined) await git(repo, ['fetch', '-q', source, `${ref}:${ref}`], { deadline: NETWORK_MS })
}

// Whose uncommitted work a checkout holds: the session's state already, none, or work of its own.
async function workIn(place: Repository, record: CodeRecord): Promise<'session' | 'none' | 'own'> {
  const head = await commitOf(place, 'HEAD')
  const trees = await treesOf(place, head)
  if (head === record.head && sameTrees(trees, record)) return 'session'
  const headTree = head === null ? place.emptyTree : await valueOf(place, ['rev-parse', `${head}^{tree}`])
  const isClean = trees.index === headTree && trees.worktree === headTree && trees.conflicts.length === 0 && (await operationFilesOf(place)).length === 0
  return isClean ? 'none' : 'own'
}

// Where the session continues: the checkout itself when it holds no work of its own, else a git worktree beside it,
// so the person's own work stays as it was.
async function placeOf(repo: Repository, record: CodeRecord): Promise<{ readonly work: Repository; readonly isSame: boolean }> {
  const here = await workIn(repo, record)
  if (here !== 'own') return { work: repo, isSame: here === 'session' }
  const beside = besideOf(repo.cwd, record.session)
  if (await exists(beside)) {
    const there = await openRepository(beside, 'repo')
    if (there === undefined || there.commonDir !== repo.commonDir) throw new Error(`${beside} holds something other than a worktree of ${repo.cwd}, so session ${record.session} has nowhere to continue.`)
    const work = await workIn(there, record)
    if (work === 'own') throw new Error(`${repo.cwd} and its worktree ${beside} both hold work of their own, so session ${record.session} has nowhere to continue.`)
    return { work: there, isSame: work === 'session' }
  }
  if (record.head === null) throw new Error(`${repo.cwd} holds work of its own, and session ${record.session}'s checkout has no commit to start a worktree from.`)
  await git(repo, ['worktree', 'add', '-q', '--detach', '--no-checkout', beside, record.head])
  console.log(`${repo.cwd} holds work of its own, so session ${record.session} continues in the new worktree ${beside}.`)
  const added = await openRepository(beside, 'repo')
  if (added === undefined) throw new Error(`git worktree add made ${beside}, and it is not a checkout.`)
  return { work: added, isSame: false }
}

async function checkedOutElsewhere(repo: Repository): Promise<Set<string>> {
  const here = await realpath(repo.cwd)
  const blocks = textOf(await git(repo, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0')
  const elsewhere = new Set<string>()
  for (const block of blocks) {
    const fields = block.split('\0')
    const path = fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length)
    const branch = fields.find((field) => field.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length)
    if (path === undefined || branch === undefined) continue
    if ((await realpath(path).catch(() => path)) !== here) elsewhere.add(branch)
  }
  return elsewhere
}

// A fresh clone takes every branch as recorded. A checkout that was here moves a branch only forward, and never one
// another worktree has checked out.
async function moveBranches(repo: Repository, record: CodeRecord, fresh: boolean): Promise<void> {
  const elsewhere = await checkedOutElsewhere(repo)
  for (const [name, id] of Object.entries(record.branches)) {
    const current = await commitOf(repo, `refs/heads/${name}`)
    if (current === id) continue
    if (elsewhere.has(name)) console.log(`${name} is checked out in another worktree, so it stays at ${current?.slice(0, 8)} and session ${record.session} keeps ${id.slice(0, 8)} on refs/anyhost/${record.session}.`)
    else if (fresh || current === null || (await run(repo, ['merge-base', '--is-ancestor', current, id])).code === 0) await git(repo, ['update-ref', `refs/heads/${name}`, id])
    else console.log(`${name} has moved here to ${current.slice(0, 8)}, apart from session ${record.session}'s ${id.slice(0, 8)}, so it stays, and refs/anyhost/${record.session} keeps the session's commits.`)
  }
  const branch = record.branch === null ? null : `refs/heads/${record.branch}`
  if (record.head === null) {
    if (branch !== null) await git(repo, ['symbolic-ref', 'HEAD', branch])
  } else if (branch !== null && !elsewhere.has(record.branch ?? '') && (await commitOf(repo, branch)) === record.head) await git(repo, ['symbolic-ref', 'HEAD', branch])
  else {
    await git(repo, ['update-ref', '--no-deref', 'HEAD', record.head])
    if (branch !== null) console.log(`HEAD is detached at ${record.head.slice(0, 8)}, because ${record.branch} could not move here.`)
  }
  if (!fresh) return
  // A clone made its default branch; the session's checkout has exactly the branches it recorded.
  for (const name of linesOf(await git(repo, ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads']))) {
    if (!(name in record.branches) && name !== record.branch) await git(repo, ['branch', '-q', '-D', name])
  }
}

async function restoreStash(repo: Repository, record: CodeRecord): Promise<void> {
  const here = (await commitOf(repo, 'refs/stash')) === null ? [] : linesOf(await git(repo, ['log', '-g', '--format=%H', 'refs/stash']))
  for (const { id, message } of [...record.stash].reverse()) if (!here.includes(id)) await git(repo, ['stash', 'store', '-q', '-m', message, id])
}

async function restoreConflicts(repo: Repository, record: CodeRecord, parts: ReadonlyMap<string, Uint8Array>): Promise<void> {
  if (record.conflicts.length === 0) return
  for (const id of new Set(record.conflicts.map((stage) => stage.id))) {
    const written = await valueOf(repo, ['hash-object', '-w', '--stdin'], { input: parts.get(record.blobs[id] ?? '') ?? new Uint8Array() })
    if (written !== id) throw new Error(`The conflict stage ${id} of session ${record.session} came back as ${written}.`)
  }
  const zero = '0'.repeat(repo.emptyTree.length)
  const lines = [...new Set(record.conflicts.map(({ path }) => `0 ${zero}\t${path}`)), ...record.conflicts.map(({ path, mode, stage, id }) => `${mode} ${id} ${stage}\t${path}`)]
  await git(repo, ['update-index', '-z', '--index-info'], { input: lines.map((line) => `${line}\0`).join('') })
}

async function restoreOperation(repo: Repository, record: CodeRecord, parts: ReadonlyMap<string, Uint8Array>): Promise<void> {
  for (const [name, hash] of record.operation) {
    const path = join(repo.gitDir, name.slice('git/'.length))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, parts.get(hash) ?? new Uint8Array())
  }
}

/**
 * Restores a code record captureCode made into the session's working folder on this machine, reading each part the
 * header names as a journal record through readPart, and returns the folder the session continues in: the same folder,
 * or the same place in a new worktree or folder beside the checkout when the checkout there holds work of its own.
 * Throws when a part does not hash to its name, or the result does not hash to the trees the capture recorded.
 */
export async function restoreCode(header: Uint8Array, readPart: (path: string) => Promise<Uint8Array>, folder: string): Promise<string> {
  const { record, parts } = await decode(header, readPart)
  const target = resolve(folder)
  if (record.kind === 'folder') return await restoreFolder(record, parts, target)
  const { subfolder } = record
  if (subfolder !== '' && !target.endsWith(`${sep}${subfolder}`)) throw new Error(`${target} does not end in ${subfolder}, the folder session ${record.session} worked in under its checkout.`)
  const root = subfolder === '' ? target : target.slice(0, -subfolder.length - 1)
  const { repo, fresh } = await checkoutAt(root, record)
  await fetchCommits(repo, record, parts, fresh)
  if (record.head !== null && (await commitOf(repo, record.head)) === null) {
    throw new Error(`Session ${record.session}'s HEAD ${record.head.slice(0, 8)} is on neither ${record.remote?.url ?? 'a remote'} nor refs/anyhost/${record.session}.`)
  }
  const localHead = fresh ? null : await commitOf(repo, 'HEAD')
  if (localHead !== null && record.head !== null && (await run(repo, ['merge-base', localHead, record.head])).code !== 0) {
    throw new Error(`${root} holds a checkout that shares no history with session ${record.session}'s ${record.head.slice(0, 8)}.`)
  }
  const { work, isSame } = fresh ? { work: repo, isSame: false } : await placeOf(repo, record)
  await moveBranches(work, record, fresh)
  if (!isSame) {
    if (record.head !== null) await git(work, ['reset', '-q', '--hard'])
    await apply(work, record.staged, parts, true)
    await apply(work, record.unstaged, parts, false)
    await restoreConflicts(work, record, parts)
  }
  await restoreStash(work, record)
  await restoreOperation(work, record, parts)
  const isOnBranch = record.branch !== null && textOf((await run(work, ['symbolic-ref', '-q', 'HEAD'])).out).trim() === `refs/heads/${record.branch}`
  if (isOnBranch && record.upstream !== null && (await run(work, ['branch', '-q', `--set-upstream-to=${record.upstream}`, record.branch ?? ''])).code !== 0) {
    console.log(`${record.branch} tracked ${record.upstream}, which this checkout does not have.`)
  }
  await check(work, record)
  await rememberJournaled(work, record)
  return join(work.cwd === repo.cwd ? root : besideOf(root, record.session), subfolder)
}
