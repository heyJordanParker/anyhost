# WHY

anyhost keeps every Claude Code and Codex session of every machine the Architect works on in Cloudflare R2, lists every session on every machine, and resumes a session on any machine from R2 alone, so a dead or busy machine never holds his history hostage. Its Herdr pane is his one inbox of agents across all his machines.

# Facts

## The parts

- The repository root is a cmod mod. `src/mod.ts` defines it: Claude Code's hooks, the setup Step, the `anyhost serve` service and the agent tools in `src/agents.ts`. `node_modules/@cmodjs/core/docs/` documents the installed cmod.
- `cli/` is the `anyhost` program, TypeScript on Bun. `anyhost serve` runs once per machine as a cmod service and is the only process that owns state: `anyhost.db` in the state folder, the uploads, the relay socket and every session terminal. The mod, the commands and the pane reach it through the unix socket `serve.sock` (`serveSocket` in `serve.ts`).
- `relay/` is a Cloudflare Worker with one Durable Object, the Pool, which each person uploads into his own Cloudflare account (`connect.ts`). It routes messages between machines, keeps devices and claims in SQLite and fronts the R2 bucket. `relay/protocol.ts` is the wire contract, and only `cli/src/relay.ts` opens the relay's socket and object routes.
- `herdr/anyhost/` is the Herdr app pane, gpui-kit JavaScript run in QuickJS: the inbox, projects, tab bar, Board and palette. The install step copies it into the Herdr app's `mods/anyhost/`.
- Every session runs in a terminal of herdr-core (`hc`), with Claude Code as the terminal's own program. `CLAUDE_START` in `claude.ts` is a perl script that execs Claude Code, because Bun has no exec and an anyhost process left in every terminal costs a process per session.

## Commands

- CI runs these on macOS and Linux:
  - `bun run --cwd cli check` type-checks the program.
  - `bun run --cwd relay check` type-checks the Worker against Cloudflare's types.
  - `bun run --cwd cli test` runs `cli/tests/`, each file in its own worker, slowest first by `cli/tests/timings.json`. CI splits it into 3 shards per system with `--shard`, balanced by the same file.
  - `cmod check .` type-checks, lints with oxlint and runs the mod's and the relay's tests.
- `bun run --cwd cli check` and `bun run --cwd cli test` build `relay/dist/relay.js` first, which the program embeds as text. `bun install --cwd relay` comes before the program's tests, which load Miniflare from there.
- `herdr-app check herdr/anyhost` loads the pane once.
- `bun test --timings tests/timings.json --update-timings ./tests` in `cli/` records each file's time again, after a file's time changes by a lot.
- A release raises only `.claude-plugin/plugin.json`'s `version`. A push to `main` publishes `v<version>` once CI passes on both systems. `docs/releasing.md` holds the steps.

## Code

- The oxlint plugin `lint/anyhost.js` enforces the house rules: no comments, `env` on every `Bun.spawn` in `cli/src`, and in the pane the `UI` table's tokens and primitives and no action in a shared key. A fact the code cannot show goes in this file.
- The pane has one design language: T3 Code's sidebar on the Herdr app's type scale, all of it in the `UI` table at the top of `herdr/anyhost/main.js`.
- `anyhost.db`'s shape changes only by a new step in `MIGRATIONS` in `capture.ts`.
- `ownerOf` in `transcript.ts` is the one definition of which files belong to a session.

## The models the Architecture copies

- Sessions follow T3 Code's `ProviderSessionManager.ts` and Chrome's discarded tabs. A session is live while Claude Code runs in a terminal labelled `anyhost.session=<id>`, or discarded with no process. The program discards an idle session no screen showed for 24 hours (`ANYHOST_STOP_MS`), so a day's scrollback survives, and an open, a click or a message starts it again (`terminalOf` in `move.ts`).
- The list and its states follow T3 Code's sidebar (`Sidebar.logic.ts`). Settled and snoozed are computed on read from shared marks, so no machine settles a session by its own judgment.
- A session's files live in R2 as a journal of zstd frames under `journals/<session>/`, as Litestream streams a database. Large logs go up as content-addressed `chunks/<sha256>`, which no machine deletes. Journals seal and compact as Kafka compacts a log (`rewriteJournal` in `capture.ts`).
- Placement is Kubernetes' desired state. The Pool's claims row holds the holder (`device`), the machine the session should run on (`wanted`), a start's `spec` and the last `error`, and each program reconciles every session against it (`placeSession` in `move.ts`). Only the holder writes a session's journal: every frame carries `holder`, and the Pool refuses another machine's with 409.
- Marks, pins, tags, parents, project names and preferences live in `shared.json` in R2. Every change is an intent applied to the newest copy with an etag (`updateObject` in `shared.ts`), as Kubernetes' Server-Side Apply. A mark holds while its `at` is at or after the session's last activity.
- The pane's changes go through one queue, `anyhost.outbox`, as Replicache's pending mutations, and it follows the list with `anyhost list --wait <version>`, as a Kubernetes watch.
- Undo follows Gmail's Undo Send: an action with an undo toast waits in `anyhost.outbox` while the toast shows (`isHeld`), and undo drops it unsent (`undoHeld`).
- `relocate` rewrites every path of the writer's machine into this machine's, so a moved session reads as if it ran here.

## The limits the code is shaped around

- Cloudflare's Free plan allows 100,000 Worker requests a day, then answers 429 `error code: 1027` until 00:00 UTC (`isDailyLimit` in `relay.ts`). Journal rewrites stop for the day at `REWRITE_OPS_PER_DAY`.
- The Pool's SQLite allows 5,000,000 rows read a day on the Free plan, so the `claims` op reads only the rows under a prefix.
- R2's free tier allows 1,000,000 Class A requests a month, so the option `uploadEvery` defaults to 5 seconds.
- The Pool counts a socket alive only while it heard from it within `LIVE_MS`, because Cloudflare keeps a sleeping machine's half-open socket listed.
- A ping the Pool answers with `setWebSocketAutoResponse` never wakes it, so only its alarm notices a silent socket. The alarm runs every `LIVE_MS` while two or more machines are connected, at most 1,920 times a day, and tells the other machines the silent one's link went dead as `presence`.
- Bun 1.4.4's `fs.watch` on macOS registers its FSEventStream on the calling thread, which freezes while fseventsd stops answering (Bun issue #43870). So every watch runs in a separate watcher process (`WATCHER` in `serve.ts`).
- macOS refuses a unix socket path over 104 bytes, so a test's `XDG_STATE_HOME` stays short.
- Claude Code's record `sessions/<pid>.json` is the program's source of a session's status (`busy`, `shell`, `waiting`, `idle`, `parkedJobId`), read only through `recordedSessions` and `recordAt` in `claude.ts`. Claude Code can leave bytes after a record's JSON and stop rewriting it, so `jsonOf` reads the first value.
- Claude Code saves no transcript under a parent Claude Code's `CLAUDE_CODE_CHILD_SESSION`, so every anyhost process drops `CLAUDE_MARKERS` as it starts.
- herdr-core gives new terminals the environment its core started with, which `hc server restart` keeps and a stop and start replaces.
- workerd delivers the Pool's own close of a hibernated socket that never sent a frame only when the Pool is evicted, 10 s or more later (workerd issue #7566). So the program pings as its socket opens, and so does the relay tests' socket. A test reads a silent machine from the `devices` op, not from its socket's close. The relay's tests give the Pool `LIVE_MS` as a binding of 3 s, and the test socket ends with `terminate()`, as the program's does.
- The Herdr app interrupts a render after 50 ms and an event after 500 ms (`Budgets` in gpui-kit's `sandbox.rs`), so a render only draws a model built in a task (`computeModel` in `main.js`). The interrupt runs no `catch` and no `finally` and ends the task, so the pane holds no flag across an `await`, builds cards one step per `sync` (`building`), and takes each list it reads in a timer of its own (`receive`), never in the task that follows the list.

## Tests

- `cli/tests/times.ts`, which `cli/bunfig.toml` preloads, shortens the program's waits for every test and every program a test starts, through `ANYHOST_*_MS` variables such as `ANYHOST_LIVE_MS`, which `memoryRelay` hands the Pool as `LIVE_MS`. A test reads each wait from there.
- Tests take `test` from `cli/tests/test.ts`, whose `whenTestEnds` cleans up each test. The files `concurrentTestGlob` in `cli/bunfig.toml` lists run 4 tests at once, with `test.serial` for one that changes process-wide state. A file that times the test process's own thread stays off the list.
- Every process a test starts goes through `spawnForTest` and every folder comes from `temporaryFolder`, both in `cli/tests/program.ts`. A file fails when it leaves a process behind (`processesLeftBehind`).
- Tests run against `memoryRelay` in `cli/tests/memory.ts`, the real Worker and Pool in Miniflare, and a fake herdr-core (`fakeHc`, `coreSays`), so no test reaches a real relay or the machine's herdr-core. `connect.test.ts` answers every Cloudflare call with a stand-in, and every test bucket is `anyhost-test`, never `anyhost`.
- Bun 1.4.4's `mock.module` leaks into the other test files of a run, so no test uses it. Its `toMatchObject` writes each `expect.any(…)` into the received value, so a test reads a value before it matches it.
- A look at the pane runs in its own Herdr app: `env HERDR_APP_HOME=/tmp/<short> HC_SESSION=test-<name> XDG_STATE_HOME=/tmp/<short> HOME=/tmp/<short>/home herdr-app`, with the pane and the anyhost layout copied in and a stand-in at `<home>/.local/share/cmod/programs/anyhost`. `hc server stop` with the same `HC_SESSION` and `XDG_STATE_HOME` ends its herdr-core.
