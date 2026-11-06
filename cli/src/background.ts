// Claude Code's background sessions on this machine. Claude Code's daemon runs each one in a terminal of its own, so the
// session outlives anyhost and every viewer, and `claude attach <id>` shows it in any terminal, `id` being the first 8
// characters of the session's id.

// A service gets the person's Claude Code in CLAUDE_CODE_EXECPATH, which cmod sets, and a command finds it on PATH.
const claude = (): string => process.env['CLAUDE_CODE_EXECPATH'] || 'claude'

// A session Claude Code runs here, as `claude agents --json` lists it. Only a background session has `id`.
export type RunningSession = {
  readonly pid: number
  readonly id?: string
  readonly sessionId: string
  readonly kind: 'background' | 'interactive'
  readonly cwd: string
  readonly status?: string
  readonly state?: string
}

// `claude attach` under a terminal of this program's. Bun's terminal gives its child no controlling terminal, so a
// resize signals nobody, and `resize` sends the child SIGWINCH itself (worker-spec W2).
export type AttachedTerminal = {
  write(bytes: Uint8Array): void
  resize(cols: number, rows: number): void
  readonly exited: Promise<number>
  close(): void
}

async function run(argv: readonly string[], cwd?: string): Promise<string> {
  const child = Bun.spawn([...argv], { ...(cwd === undefined ? {} : { cwd }), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`${argv.join(' ')} exited with ${code}: ${error.trim() || output.trim()}`)
  return output
}

export const runningSessions = async (): Promise<RunningSession[]> => JSON.parse(await run([claude(), 'agents', '--json'])) as RunningSession[]

// Starts the session in Claude Code's background in `cwd`, the folder it continues in, and answers the id `claude
// attach` takes. On Linux it starts in a systemd scope of its own, because systemd stops every process of a service's
// cgroup when the service restarts, and Claude Code's daemon, which the first background session starts, would go
// with it (worker-spec W5). A scope of that name that is still there holds the daemon, which a bare start reaches.
export async function startInBackground(session: string, cwd: string): Promise<string> {
  const id = session.slice(0, 8)
  const command = [claude(), '--bg', '--resume', session]
  if (process.platform !== 'linux' || Bun.which('systemd-run') === null) await run(command, cwd)
  else {
    await run(['systemd-run', '--user', '--scope', '--quiet', '--collect', '--unit', `anyhost-claude-${id}`, ...command], cwd).catch(async (error: unknown) => {
      if (!String(error).includes('already loaded')) throw error
      await run(command, cwd)
    })
  }
  return id
}

export function attachTerminal(id: string, cwd: string, { cols, rows }: { readonly cols: number; readonly rows: number }, onOutput: (bytes: Uint8Array) => void): AttachedTerminal {
  const terminal = new Bun.Terminal({ cols, rows, name: 'xterm-256color', data: (_terminal, bytes) => onOutput(bytes) })
  // Claude Code draws truecolor for a terminal that says it takes it, as the viewer's does
  const child = Bun.spawn([claude(), 'attach', id], { cwd, terminal, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } })
  return {
    write: (bytes) => void terminal.write(bytes),
    resize(columns, lines) {
      terminal.resize(columns, lines)
      child.kill('SIGWINCH')
    },
    exited: child.exited.finally(() => terminal.close()),
    close: () => child.kill(),
  }
}
