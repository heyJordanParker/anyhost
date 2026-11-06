import { expect, test } from 'bun:test'
import { relocate, type Roots } from '../src/relocate.ts'

const mac: Roots = { home: '/Users/alice', claudeHome: '/Users/alice/.claude', claudeTmp: '/private/tmp/claude-501', codexHome: '/Users/alice/.codex', checkout: '/Users/alice/code/app' }
const linux: Roots = { home: '/home/al', claudeHome: '/home/al/.claude', claudeTmp: '/tmp/claude-1000', codexHome: '/home/al/.codex', checkout: '/home/al/src/app' }

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const moved = (content: string, path = '/Users/alice/.claude/projects/-Users-alice-code-app/s.jsonl', from = mac, to = linux): string => text(relocate(new TextEncoder().encode(content), path, from, to).bytes)

test("a transcript line names this machine's home, temp root, checkout and project folder everywhere", () => {
  const line = JSON.stringify({
    type: 'user',
    cwd: '/Users/alice/code/app',
    message: { role: 'user', content: 'Read /Users/alice/code/app/README.md and ~/.claude/projects/-Users-alice-code-app/memory/MEMORY.md' },
    toolUseResult: { persistedOutputPath: '/Users/alice/.claude/projects/-Users-alice-code-app/s/tool-results/b1.txt' },
    attachment: { prompt: '<task-notification>\n<output-file>/private/tmp/claude-501/-Users-alice-code-app/s/tasks/b2.output</output-file>' },
  })
  const assistant = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'The plan sits at /Users/alice/.claude/plans/p.md.', signature: 'c2lnbmVk' }, { type: 'tool_use', input: { file_path: '/tmp/claude-501/-Users-alice-code-app/s/tasks/b2.output' } }] } })

  expect(moved(`${line}\n${assistant}\n`)).toBe(
    `${JSON.stringify({
      type: 'user',
      cwd: '/home/al/src/app',
      message: { role: 'user', content: 'Read /home/al/src/app/README.md and ~/.claude/projects/-home-al-src-app/memory/MEMORY.md' },
      toolUseResult: { persistedOutputPath: '/home/al/.claude/projects/-home-al-src-app/s/tool-results/b1.txt' },
      attachment: { prompt: '<task-notification>\n<output-file>/tmp/claude-1000/-home-al-src-app/s/tasks/b2.output</output-file>' },
    })}\n${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'The plan sits at /home/al/.claude/plans/p.md.', signature: 'c2lnbmVk' }, { type: 'tool_use', input: { file_path: '/tmp/claude-1000/-home-al-src-app/s/tasks/b2.output' } }] } })}\n`,
  )
})

test('a root matches only at a path boundary', () => {
  const from: Roots = { ...mac, home: '/Users/al', claudeHome: '/Users/al/.claude', codexHome: '/Users/al/.codex', checkout: '/Users/al' }
  const content = '{"a":"/Users/alice /data/Users/al /Users/al.bak /Users/al-old -Users-alfred x-Users-al","b":"/Users/al","c":"\\n/Users/al/x","d":"file:///Users/al/y","e":"(/Users/al)"}\n'

  expect(moved(content, '/Users/al/.claude/history.jsonl', from)).toBe('{"a":"/Users/alice /data/Users/al /Users/al.bak /Users/al-old -Users-alfred x-Users-al","b":"/home/al","c":"\\n/home/al/x","d":"file:///home/al/y","e":"(/home/al)"}\n')
})

test('every macOS root changes in both forms, with /private and without it', () => {
  // macOS's root user lives in /var/root, and a session in /tmp/trwork records its folder as /private/tmp/trwork
  const root: Roots = { home: '/var/root', claudeHome: '/var/root/.claude', claudeTmp: '/tmp/claude-0', codexHome: '/var/root/.codex', checkout: '/private/tmp/trwork' }
  const content = '{"a":"/private/var/root/notes","b":"/private/var/root/.claude/plans/p.md","c":"/var/root/.codex/x","d":"/private/tmp/claude-0/y","e":"/tmp/trwork/a.ts","f":"projects/-tmp-trwork/s.jsonl","g":"/private/var/rooted","h":"/tmp/claude-01"}\n'

  expect(moved('{"a":"/private/tmp/claude-501/x","b":"/tmp/claude-501/y","c":"/tmp/claude-5012"}\n')).toBe('{"a":"/tmp/claude-1000/x","b":"/tmp/claude-1000/y","c":"/tmp/claude-5012"}\n')
  expect(moved(content, '/var/root/.claude/history.jsonl', root)).toBe('{"a":"/home/al/notes","b":"/home/al/.claude/plans/p.md","c":"/home/al/.codex/x","d":"/tmp/claude-1000/y","e":"/home/al/src/app/a.ts","f":"projects/-home-al-src-app/s.jsonl","g":"/private/var/rooted","h":"/tmp/claude-01"}\n')
})

test("a project folder in the checkout's subfolder, in the temp root or under another project keeps naming the same folder", () => {
  const content = '{"a":"projects/-Users-alice-code-app-web","b":"-private-tmp-claude-501--Users-alice-code-app-s-scratchpad","c":"-Users-alice-notes","d":"-Users-alice-code-application"}\n'

  expect(moved(content)).toBe('{"a":"projects/-home-al-src-app-web","b":"-tmp-claude-1000--home-al-src-app-s-scratchpad","c":"-home-al-notes","d":"-home-al-code-application"}\n')
})

test("a file's path moves to this machine's folders", () => {
  const where = (path: string): string => relocate(new Uint8Array(), path, mac, linux).path

  expect(where('/Users/alice/.claude/projects/-Users-alice-code-app/s.jsonl')).toBe('/home/al/.claude/projects/-home-al-src-app/s.jsonl')
  expect(where('/Users/alice/.claude/projects/-Users-alice-code-app-web/s/subagents/agent-a1.jsonl')).toBe('/home/al/.claude/projects/-home-al-src-app-web/s/subagents/agent-a1.jsonl')
  expect(where('/private/tmp/claude-501/-Users-alice-code-app/s/tasks/b2.output')).toBe('/tmp/claude-1000/-home-al-src-app/s/tasks/b2.output')
  expect(where('/Users/alice/.codex/sessions/2026/11/04/rollout-x.jsonl')).toBe('/home/al/.codex/sessions/2026/11/04/rollout-x.jsonl')
  expect(where('/Users/alice/.claude/history.jsonl')).toBe('/home/al/.claude/history.jsonl')
})

test("Codex's home moves on its own when it sits outside the home", () => {
  const to: Roots = { ...linux, codexHome: '/srv/codex-al' }
  const moved = relocate(new TextEncoder().encode('{"type":"session_meta","payload":{"cwd":"/Users/alice/code/app","rollout":"/Users/alice/.codex/sessions/r.jsonl"}}\n'), '/Users/alice/.codex/sessions/r.jsonl', mac, to)

  expect(moved.path).toBe('/srv/codex-al/sessions/r.jsonl')
  expect(text(moved.bytes)).toBe('{"type":"session_meta","payload":{"cwd":"/home/al/src/app","rollout":"/srv/codex-al/sessions/r.jsonl"}}\n')
})

test("Claude Code's folder moves on its own when CLAUDE_CONFIG_DIR puts it outside the home, and its backups keep their bytes", () => {
  const to: Roots = { ...linux, claudeHome: '/srv/claude-al' }
  const where = (path: string): string => relocate(new Uint8Array(), path, mac, to).path
  const backup = new TextEncoder().encode('root=/Users/alice/.claude\n')

  expect(where('/Users/alice/.claude/projects/-Users-alice-code-app/s.jsonl')).toBe('/srv/claude-al/projects/-home-al-src-app/s.jsonl')
  expect(moved('{"plan":"/Users/alice/.claude/plans/p.md","home":"/Users/alice/notes"}\n', undefined, mac, to)).toBe('{"plan":"/srv/claude-al/plans/p.md","home":"/home/al/notes"}\n')
  expect(relocate(backup, '/Users/alice/.claude/file-history/s/0a1b@v1', mac, to)).toEqual({ path: '/srv/claude-al/file-history/s/0a1b@v1', bytes: backup })
})

test("the state_5.sqlite row's JSON form names this machine's rollout, working folder and sandbox", () => {
  const row = { id: 't1', rollout_path: '/Users/alice/.codex/sessions/r.jsonl', cwd: '/Users/alice/code/app', title: 'Fix /Users/alice/code/app/a.ts', sandbox_policy: '{"writable_roots":["/Users/alice/code/app"]}' }
  const moved = relocate(new TextEncoder().encode(JSON.stringify(row)), '/Users/alice/.codex/state_5.sqlite', mac, linux)

  expect(moved.path).toBe('/home/al/.codex/state_5.sqlite')
  expect(JSON.parse(text(moved.bytes))).toEqual({ id: 't1', rollout_path: '/home/al/.codex/sessions/r.jsonl', cwd: '/home/al/src/app', title: 'Fix /home/al/src/app/a.ts', sandbox_policy: '{"writable_roots":["/home/al/src/app"]}' })
})

test('a plan and saved output name this machine, while file backups and binary files keep their bytes', () => {
  const plan = new TextEncoder().encode('# Plan\n\nEdit /Users/alice/code/app/a.ts\n')
  const backup = new TextEncoder().encode('root=/Users/alice/code/app\n')
  const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, ...new TextEncoder().encode('IHDR /Users/alice/x')])
  const outputTail = new Uint8Array([0xa9, ...new TextEncoder().encode(' wrote /Users/alice/code/app/out.txt\n')])

  expect(text(relocate(plan, '/Users/alice/.claude/plans/p.md', mac, linux).bytes)).toBe('# Plan\n\nEdit /home/al/src/app/a.ts\n')
  expect(text(relocate(plan, '/Users/alice/.claude/projects/-Users-alice-code-app/s/tool-results/b1.txt', mac, linux).bytes)).toBe('# Plan\n\nEdit /home/al/src/app/a.ts\n')
  expect(relocate(backup, '/Users/alice/.claude/file-history/s/0a1b@v1', mac, linux)).toEqual({ path: '/home/al/.claude/file-history/s/0a1b@v1', bytes: backup })
  expect(relocate(image, '/Users/alice/.claude/projects/-Users-alice-code-app/s/tool-results/i.png', mac, linux).bytes).toBe(image)
  // an appended record of background output that starts inside a character still changes
  expect(Buffer.from(relocate(outputTail, '/private/tmp/claude-501/-Users-alice-code-app/s/tasks/b2.output', mac, linux).bytes)).toEqual(Buffer.from([0xa9, ...new TextEncoder().encode(' wrote /home/al/src/app/out.txt\n')]))
})

test('every byte outside a path stays as the writer wrote it', () => {
  const content = '{\n  "cwd": "/Users/alice/code/app",\n  "note": "\\u00e9t\\u00e9 🚆 \\"/Users/alice\\"\\t",\n  "n": 1.50\n}\nnot json /Users/alice\n'

  expect(moved(content, '/Users/alice/.claude/projects/-Users-alice-code-app/s/subagents/agent-a1.meta.json')).toBe('{\n  "cwd": "/home/al/src/app",\n  "note": "\\u00e9t\\u00e9 🚆 \\"/home/al\\"\\t",\n  "n": 1.50\n}\nnot json /home/al\n')
})

test('a session run in the home folder moves with the home', () => {
  const from: Roots = { ...mac, checkout: mac.home }
  const to: Roots = { ...linux, checkout: linux.home }

  expect(moved('{"cwd":"/Users/alice","p":"projects/-Users-alice/s.jsonl"}\n', '/Users/alice/.claude/projects/-Users-alice/s.jsonl', from, to)).toBe('{"cwd":"/home/al","p":"projects/-home-al/s.jsonl"}\n')
})

test("a file from this machine's own roots is placed as it is", () => {
  const bytes = new TextEncoder().encode('{"cwd":"/Users/alice/code/app"}\n')

  expect(relocate(bytes, '/Users/alice/.claude/history.jsonl', mac, { ...mac })).toEqual({ path: '/Users/alice/.claude/history.jsonl', bytes })
})

test('a root that is not an absolute path is refused', () => {
  expect(() => relocate(new Uint8Array(), '/x', mac, { ...linux, checkout: 'src/app' })).toThrow('relocate: to.checkout must be an absolute path without a trailing slash, got "src/app"')
  expect(() => relocate(new Uint8Array(), '/x', { ...mac, home: '/Users/alice/' }, linux)).toThrow('relocate: from.home must be an absolute path without a trailing slash, got "/Users/alice/"')
})
