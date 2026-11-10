import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { captureCode, httpsRemoteOf, restoreCode } from '../src/code.ts'
import { temporaryFolder } from './memory.ts'

const SESSION = '0a1b2c3d-1111-2222-3333-444455556666'
const kept: Record<string, string | undefined> = {}

// Each test runs 20 to 60 git commands, and the 10 s push gap adds its own wait.
setDefaultTimeout(60_000)

beforeAll(() => {
  const home = temporaryFolder()
  writeFileSync(join(home, 'gitconfig'), '[user]\n\tname = test\n\temail = test@test.invalid\n[init]\n\tdefaultBranch = main\n')
  const env = { XDG_STATE_HOME: join(home, 'state'), GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  for (const [name, value] of Object.entries(env)) {
    kept[name] = process.env[name]
    process.env[name] = value
  }
})

afterAll(() => {
  for (const [name, value] of Object.entries(kept)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function sh(cwd: string, args: string[], input?: string): string {
  const done = Bun.spawnSync(['git', ...args], { cwd, env: process.env, stdin: input === undefined ? 'ignore' : Buffer.from(input), stdout: 'pipe', stderr: 'pipe' })
  if (done.exitCode !== 0) throw new Error(`git ${args.join(' ')} exited ${done.exitCode}: ${done.stderr.toString()}`)
  return done.stdout.toString()
}

function write(path: string, content: string | Uint8Array): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

// Every file under the folder but .git, with its type, executable bit, and content or link target.
function filesOf(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !relative(folder, path).split('/').includes('.git'))
    .map((path) => {
      const found = lstatSync(path)
      const what = found.isSymbolicLink() ? `link ${readlinkSync(path)}` : found.isDirectory() ? 'folder' : `file ${found.mode & 0o111 ? 'x' : '-'} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`
      return `${relative(folder, path)} ${what}`
    })
    .sort()
}

function gitStateOf(folder: string): string[] {
  return [
    sh(folder, ['log', '--all', '--format=%H']),
    sh(folder, ['status', '--porcelain=v2', '--branch']),
    sh(folder, ['stash', 'list']),
  ]
}

// A bare remote with one pushed commit on main, and a clone of it.
function repository(): { base: string; remote: string; work: string } {
  const base = temporaryFolder()
  const remote = join(base, 'remote.git')
  const seed = join(base, 'seed')
  sh(base, ['init', '-q', '--bare', remote])
  sh(base, ['init', '-q', seed])
  write(join(seed, 'a.txt'), 'a\n')
  write(join(seed, 'b.txt'), 'b\n')
  write(join(seed, 'c.txt'), 'c\n')
  write(join(seed, 'gone.txt'), 'gone\n')
  write(join(seed, 'bin.dat'), new Uint8Array([0, 1, 2, 3, 255, 0]))
  write(join(seed, '.gitignore'), '.env\nnode_modules/\n')
  sh(seed, ['add', '-A'])
  sh(seed, ['commit', '-q', '-m', 'seed'])
  sh(seed, ['push', '-q', remote, 'main'])
  const work = join(base, 'work')
  sh(base, ['clone', '-q', remote, work])
  return { base, remote, work }
}

// The session's journal as restoreCode reads it: every part record captureCode returned, by its path.
function journalOf() {
  const records = new Map<string, Uint8Array>()
  return {
    records,
    async capture(folder: string, session = SESSION): Promise<Uint8Array> {
      const captured = await captureCode(folder, session)
      if (captured === undefined) throw new Error(`captureCode returned no record for ${folder}.`)
      for (const part of captured.parts) records.set(part.path, part.bytes)
      return captured.header
    },
    restore: (header: Uint8Array, folder: string): Promise<string> =>
      restoreCode(header, async (path) => records.get(path) ?? Promise.reject(new Error(`The journal holds no ${path}.`)), folder),
  }
}

// The suite missed it: a machine with no GitHub key, as devbox, cloned a session's repository only from its ssh remote.
test("a GitHub ssh remote has an https form a machine without a GitHub key clones, and another host's has none", () => {
  expect(httpsRemoteOf('git@github.com:heyJordanParker/anyhost.git')).toBe('https://github.com/heyJordanParker/anyhost.git')
  expect(httpsRemoteOf('ssh://git@github.com/heyJordanParker/anyhost')).toBe('https://github.com/heyJordanParker/anyhost.git')
  expect(httpsRemoteOf('git@gitlab.com:a/b.git')).toBeUndefined()
  expect(httpsRemoteOf('https://github.com/a/b.git')).toBeUndefined()
})

test('the diff record round trip restores staged, partly staged and unstaged edits, new, deleted, binary, executable and linked files, branches and the stash', async () => {
  const { base, work } = repository()
  sh(work, ['switch', '-q', '-c', 'other'])
  write(join(work, 'other.txt'), 'other\n')
  sh(work, ['add', 'other.txt'])
  sh(work, ['commit', '-q', '-m', 'other branch'])
  sh(work, ['switch', '-q', '-c', 'feature', 'main'])
  write(join(work, 'feature.txt'), 'feature\n')
  sh(work, ['add', 'feature.txt'])
  sh(work, ['commit', '-q', '-m', 'unpushed'])
  write(join(work, 'stashed.txt'), 'stashed\n')
  sh(work, ['add', 'stashed.txt'])
  sh(work, ['stash', 'push', '-q', '-m', 'kept for later'])
  write(join(work, 'b.txt'), 'b staged\n')
  sh(work, ['add', 'b.txt'])
  write(join(work, 'c.txt'), 'c staged\n')
  sh(work, ['add', 'c.txt'])
  write(join(work, 'c.txt'), 'c staged, then edited again\n')
  write(join(work, 'a.txt'), 'a unstaged\n')
  write(join(work, 'notes/new.txt'), 'new and untracked\n')
  rmSync(join(work, 'gone.txt'))
  write(join(work, 'bin.dat'), new Uint8Array([9, 0, 8, 0, 7, 255]))
  write(join(work, 'run.sh'), '#!/bin/sh\necho run\n')
  chmodSync(join(work, 'run.sh'), 0o755)
  symlinkSync('a.txt', join(work, 'link'))
  write(join(work, '.env'), 'SECRET=1\n')
  write(join(work, 'node_modules/x/index.js'), 'module.exports = 1\n')

  const journal = journalOf()
  const restored = await journal.restore(await journal.capture(work), join(base, 'restored'))

  expect(restored).toBe(join(base, 'restored'))
  expect(filesOf(restored)).toEqual(filesOf(work).filter((line) => !line.startsWith('.env ') && !line.startsWith('node_modules')))
  expect(gitStateOf(restored)).toEqual(gitStateOf(work))
  expect(sh(restored, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'])).toBe(sh(work, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']))
})

test('a file rewritten with the same size in the second its index was written is captured with its new bytes', async () => {
  // The file, its index entry and the index all carry one past timestamp, as a checkout and an edit in one second leave
  // them, while the capture runs in a later second. touch -r copies a timestamp whole, to the nanosecond.
  const { base, work } = repository()
  const file = join(work, 'bin.dat')
  const tick = join(base, 'tick')
  const touch = (from: string, to: string) => expect(Bun.spawnSync(['touch', '-r', from, to]).exitCode).toBe(0)
  sh(work, ['config', 'core.trustctime', 'false'])
  const past = new Date(Date.now() - 10_000)
  utimesSync(file, past, past)
  sh(work, ['update-index', '-q', '--refresh'])
  write(tick, '')
  touch(file, tick)
  write(file, new Uint8Array([9, 0, 8, 0, 7, 255]))
  touch(tick, file)
  touch(tick, join(work, '.git/index'))
  expect(sh(work, ['diff-files', '--name-only'])).toBe('bin.dat\n')

  const journal = journalOf()
  const restored = await journal.restore(await journal.capture(work), join(base, 'restored'))

  expect([...readFileSync(join(restored, 'bin.dat'))]).toEqual([9, 0, 8, 0, 7, 255])
})

test('nothing changed since the last record gives no record', async () => {
  const { work } = repository()
  write(join(work, 'a.txt'), 'a edited\n')
  expect(await captureCode(work, SESSION)).toBeDefined()
  expect(await captureCode(work, SESSION)).toBeUndefined()
  write(join(work, 'a.txt'), 'a edited twice\n')
  expect(await captureCode(work, SESSION)).toBeDefined()
})

test('the fast-forward-only push keeps the commits a rewritten history dropped', async () => {
  const { remote, work } = repository()
  write(join(work, 'x.txt'), 'x\n')
  sh(work, ['add', 'x.txt'])
  sh(work, ['commit', '-q', '-m', 'first'])
  write(join(work, 'y.txt'), 'y\n')
  sh(work, ['add', 'y.txt'])
  sh(work, ['commit', '-q', '-m', 'second'])
  const dropped = sh(work, ['rev-parse', 'HEAD']).trim()
  await captureCode(work, SESSION)
  const before = sh(remote, ['rev-parse', `refs/anyhost/${SESSION}`]).trim()

  sh(work, ['reset', '-q', '--soft', 'origin/main'])
  sh(work, ['commit', '-q', '-m', 'first and second squashed'])
  await captureCode(work, SESSION)
  sh(work, ['reflog', 'expire', '--expire=now', '--all'])
  sh(work, ['gc', '-q', '--prune=now'])
  const after = sh(remote, ['rev-parse', `refs/anyhost/${SESSION}`]).trim()

  expect(after).not.toBe(before)
  expect(sh(remote, ['merge-base', '--is-ancestor', before, after])).toBe('')
  expect(sh(remote, ['cat-file', '-t', dropped]).trim()).toBe('commit')
  expect(sh(work, ['cat-file', '-t', dropped]).trim()).toBe('commit')
})

test('a hidden ref someone else moved is never force-pushed, and the record carries the commits as a bundle', async () => {
  const { base, remote, work } = repository()
  const foreign = sh(remote, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'someone else'], '').trim()
  sh(remote, ['update-ref', `refs/anyhost/${SESSION}`, foreign])
  write(join(work, 'x.txt'), 'x\n')
  sh(work, ['add', 'x.txt'])
  sh(work, ['commit', '-q', '-m', 'unpushed'])

  const journal = journalOf()
  const header = await journal.capture(work)
  const restored = await journal.restore(header, join(base, 'restored'))

  expect(sh(remote, ['rev-parse', `refs/anyhost/${SESSION}`]).trim()).toBe(foreign)
  expect(JSON.parse(new TextDecoder().decode(header.subarray(0, header.indexOf(10)))).bundles).toHaveLength(1)
  expect(filesOf(restored)).toEqual(filesOf(work))
  expect(gitStateOf(restored)).toEqual(gitStateOf(work))
})

test("the person's pre-push hook never runs for the hidden ref", async () => {
  const { base, remote, work } = repository()
  write(join(work, '.git/hooks/pre-push'), `#!/bin/sh\ntouch ${join(base, 'hook-ran')}\nexit 1\n`)
  chmodSync(join(work, '.git/hooks/pre-push'), 0o755)
  write(join(work, 'x.txt'), 'x\n')
  sh(work, ['add', 'x.txt'])
  sh(work, ['commit', '-q', '-m', 'unpushed'])

  await captureCode(work, SESSION)

  expect(existsSync(join(base, 'hook-ran'))).toBe(false)
  expect(sh(remote, ['rev-parse', `refs/anyhost/${SESSION}`]).trim()).toBe(sh(work, ['rev-parse', `refs/anyhost/${SESSION}`]).trim())
})

test('the sessions of one repository waiting at once go in one push, at most one push every 10 s', async () => {
  const { base, remote, work } = repository()
  write(join(remote, 'hooks/post-receive'), `#!/bin/sh\ncat >> ${join(base, 'pushes')}\necho pushed >> ${join(base, 'pushes')}\n`)
  chmodSync(join(remote, 'hooks/post-receive'), 0o755)
  write(join(work, 'x.txt'), 'x\n')
  sh(work, ['add', 'x.txt'])
  sh(work, ['commit', '-q', '-m', 'unpushed'])
  const first = '11111111-0000-0000-0000-000000000000'
  const [second, third] = ['22222222-0000-0000-0000-000000000000', '33333333-0000-0000-0000-000000000000']

  const startedAt = Date.now()
  await captureCode(work, first)
  await Promise.all([captureCode(work, second), captureCode(work, third)])
  const tookMs = Date.now() - startedAt

  const pushes = readFileSync(join(base, 'pushes'), 'utf8').split('pushed\n').filter((push) => push !== '')
  expect(pushes.map((push) => push.trim().split('\n').map((line) => line.split(' ')[2]).sort())).toEqual([[`refs/anyhost/${first}`], [`refs/anyhost/${second}`, `refs/anyhost/${third}`]])
  expect(tookMs).toBeGreaterThanOrEqual(10_000)
})

test('a repository with no remote restores its commits from the bundle in its record', async () => {
  const base = temporaryFolder()
  const work = join(base, 'work')
  sh(base, ['init', '-q', work])
  write(join(work, 'a.txt'), 'one\n')
  sh(work, ['add', 'a.txt'])
  sh(work, ['commit', '-q', '-m', 'one'])
  write(join(work, 'b.txt'), 'two\n')
  sh(work, ['add', 'b.txt'])
  sh(work, ['commit', '-q', '-m', 'two'])
  write(join(work, 'a.txt'), 'one, edited\n')

  const journal = journalOf()
  const restored = await journal.restore(await journal.capture(work), join(base, 'restored'))

  expect(filesOf(restored)).toEqual(filesOf(work))
  expect(gitStateOf(restored)).toEqual(gitStateOf(work))
})

test('a folder outside git restores the files .gitignore allows', async () => {
  const base = temporaryFolder()
  const work = join(base, 'notes')
  write(join(work, 'today.md'), '# today\n')
  write(join(work, 'deep/er/data.bin'), new Uint8Array([1, 2, 3, 0, 255]))
  write(join(work, '.gitignore'), 'secret.txt\n')
  write(join(work, 'secret.txt'), 'never leaves\n')

  const journal = journalOf()
  const restored = await journal.restore(await journal.capture(work), join(base, 'restored'))

  expect(filesOf(restored)).toEqual(filesOf(work).filter((line) => !line.startsWith('secret.txt ')))
})

test('a conflicted rebase restores its conflict stages and continues with git rebase --continue', async () => {
  const base = temporaryFolder()
  const work = join(base, 'work')
  sh(base, ['init', '-q', work])
  write(join(work, 'x.txt'), 'base\n')
  sh(work, ['add', 'x.txt'])
  sh(work, ['commit', '-q', '-m', 'base'])
  sh(work, ['switch', '-q', '-c', 'theirs'])
  write(join(work, 'x.txt'), 'theirs\n')
  sh(work, ['commit', '-q', '-am', 'theirs'])
  sh(work, ['switch', '-q', '-c', 'ours', 'main'])
  write(join(work, 'x.txt'), 'ours\n')
  sh(work, ['commit', '-q', '-am', 'ours'])
  expect(Bun.spawnSync(['git', 'rebase', '-q', 'theirs'], { cwd: work, env: process.env, stdout: 'ignore', stderr: 'ignore' }).exitCode).not.toBe(0)

  const journal = journalOf()
  const restored = await journal.restore(await journal.capture(work), join(base, 'restored'))

  expect(filesOf(restored)).toEqual(filesOf(work))
  expect(gitStateOf(restored)).toEqual(gitStateOf(work))
  write(join(restored, 'x.txt'), 'both\n')
  sh(restored, ['add', 'x.txt'])
  expect(Bun.spawnSync(['git', '-c', 'core.editor=true', 'rebase', '--continue'], { cwd: restored, env: process.env, stdout: 'ignore', stderr: 'pipe' }).exitCode).toBe(0)
  expect(sh(restored, ['log', '--format=%s', '-2'])).toBe('ours\ntheirs\n')
})

test('two sessions of one folder restore into one checkout, the second finding its state already there', async () => {
  const { base, work } = repository()
  write(join(work, 'a.txt'), 'both sessions see this edit\n')
  const [first, second] = ['44444444-0000-0000-0000-000000000000', '55555555-0000-0000-0000-000000000000']
  const journal = journalOf()
  const [firstHeader, secondHeader] = await Promise.all([journal.capture(work, first), journal.capture(work, second)])

  const target = join(base, 'restored')
  expect(await journal.restore(firstHeader, target)).toBe(target)
  expect(await journal.restore(secondHeader, target)).toBe(target)
  expect(filesOf(target)).toEqual(filesOf(work))
})

test('a session working in a subfolder restores the whole checkout and continues in that subfolder', async () => {
  const { base, work } = repository()
  write(join(work, 'app/deep/page.ts'), 'export const page = 1\n')
  write(join(work, 'a.txt'), 'edited at the root\n')

  const journal = journalOf()
  const restored = await journal.restore(await journal.capture(join(work, 'app/deep')), join(base, 'restored/app/deep'))

  expect(restored).toBe(join(base, 'restored/app/deep'))
  expect(filesOf(join(base, 'restored'))).toEqual(filesOf(work))
})

test('a part over 64 KiB is its own record, returned once, so the next change returns only a few KB', async () => {
  const { base, work } = repository()
  write(join(work, 'video.bin'), new Uint8Array(Buffer.from(createHash('sha512').update('seed').digest().toString('hex').repeat(3000))))
  const journal = journalOf()
  const first = await captureCode(work, SESSION)
  for (const part of first?.parts ?? []) journal.records.set(part.path, part.bytes)
  write(join(work, 'a.txt'), 'a small edit after the big file\n')

  const second = await captureCode(work, SESSION)
  const restored = await journal.restore(second?.header ?? new Uint8Array(), join(base, 'restored'))

  expect(first?.parts.map((part) => part.path)).toEqual([expect.stringMatching(new RegExp(`^anyhost:code/${SESSION}/parts/[0-9a-f]{64}$`))])
  expect(second?.parts).toEqual([])
  expect(second?.header.length).toBeLessThan(4096)
  expect(filesOf(restored)).toEqual(filesOf(work))
})

test('bundles are incremental: each holds only the commits since the last one', async () => {
  const base = temporaryFolder()
  const work = join(base, 'work')
  sh(base, ['init', '-q', work])
  write(join(work, 'a.txt'), 'one\n')
  sh(work, ['add', 'a.txt'])
  sh(work, ['commit', '-q', '-m', 'one'])
  const journal = journalOf()
  await journal.capture(work)
  const firstKeep = sh(work, ['rev-parse', `refs/anyhost/${SESSION}`]).trim()
  write(join(work, 'b.txt'), 'two\n')
  sh(work, ['add', 'b.txt'])
  sh(work, ['commit', '-q', '-m', 'two'])

  const second = await captureCode(work, SESSION)
  for (const part of second?.parts ?? []) journal.records.set(part.path, part.bytes)
  const restored = await journal.restore(second?.header ?? new Uint8Array(), join(base, 'restored'))

  expect(second?.parts).toHaveLength(1)
  expect(new TextDecoder().decode(second?.parts[0]?.bytes.subarray(0, 200))).toContain(`\n-${firstKeep}`)
  expect(gitStateOf(restored)).toEqual(gitStateOf(work))
})

test('the folder holding the home folder gives no record, since it holds the whole machine', async () => {
  expect(await captureCode(dirname(homedir()), SESSION)).toBeUndefined()
})

// The suite missed it: a session working in /tmp read all of /tmp as its code, which failed at other programs' folders.
test('the shared temp folder gives no record, since it holds every program’s scratch files', async () => {
  expect(await captureCode('/tmp', SESSION)).toBeUndefined()
  expect(await captureCode(tmpdir(), SESSION)).toBeUndefined()
})

test('a checkout with work of its own keeps it, and the session continues in a worktree beside it', async () => {
  const { base, remote, work } = repository()
  write(join(work, 'a.txt'), 'the session edits a\n')
  write(join(work, 'session.txt'), 'new in the session\n')
  const target = join(base, 'target')
  sh(base, ['clone', '-q', remote, target])
  write(join(target, 'b.txt'), "the person's own edit\n")
  const ownState = filesOf(target)

  const journal = journalOf()
  const restored = await journal.restore(await journal.capture(work), target)

  expect(restored).toBe(`${target}-${SESSION.slice(0, 8)}`)
  expect(filesOf(target)).toEqual(ownState)
  expect(filesOf(restored)).toEqual(filesOf(work))
  expect(sh(restored, ['status', '--porcelain=v2'])).toBe(sh(work, ['status', '--porcelain=v2']))
})
