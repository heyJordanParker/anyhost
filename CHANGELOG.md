# Changelog

What changed in each version of anyhost, for the people who use it. cmod publish releases the section for the version, and cmod's Settings shows it.

## [0.4.0] - 2026-11-10

### Added
- Every session anyhost moves or starts runs in a terminal of herdr-core, so the Herdr app on any of your machines and Herdr mobile show it and type into it.
- **The anyhost pane of the Herdr app** is an inbox of every agent on every machine: the ones that came back to you on top, each with its project, title, machine and what it does now (Working, Needs you, Done, Asleep), then shelves for the working and older agents and your machines. Clicking an agent shows its terminal, or resumes it here or on the machine that holds it, **Move** sends it to another machine, **+** copies the command that joins a new machine, and the pen starts a new agent here. anyhost installs the pane into the Herdr app at each start.
- Claude manages your agents from any session: it lists every machine and agent with what each does now, starts an agent on any machine with its first message, messages an agent or reads its screen wherever it runs, answers its permission prompt, moves it, takes it onto this machine when its own machine is offline, and adds or removes a machine. A session you make your CTO or project manager starts and steers the others, and a worker's message back names it, so the CTO hears when it is done or stuck. `anyhost tell <session> [text]` types into a session from a terminal, and `anyhost new` takes a first message and starts on this machine too.
- A Claude Code session idle for 15 minutes ends its process and keeps its screen, and your next key or message resumes the same conversation, does the work, and sleeps again. A session running a background command stays up until the command ends, and a `/loop` that runs at least every 15 minutes keeps its session awake. Sessions anyhost opens, and every Claude Code the Herdr app starts, sleep this way, so many open sessions no longer keep a laptop busy.

### Changed
- A moved session keeps the Claude Code command and flags it ran with, instead of starting as a plain background job.
- A session's copy that ignores its stop ends 10 seconds later, so a move reaches the other machine instead of waiting a minute and failing.
- `anyhost doctor` checks that herdr-core is installed, as no session moves to or starts on a machine without it.
- `anyhost resume` of a session this machine holds opens it from its own files, which are as new as your history or newer, instead of restoring over them, and refuses a session that already runs here.
- `anyhost list` and `anyhost machines` answer through the running anyhost, so the Herdr pane's refresh no longer opens a connection to your relay each minute.

### Removed
- `anyhost attach`, its streams through the relay and its direct connections over Tailscale and the local network. The Herdr app shows every session instead, so `anyhost doctor` no longer checks your terminal app's Local Network access.

## [0.3.0] - 2026-11-08

### Added
- **Connect your machines**, one step on the mod's install page while the machine is not joined: **Connect Cloudflare** sets your relay up in your own Cloudflare account with your Cloudflare login and joins the machine, and on every other machine you paste the command or link **Add a machine** gives. An account your Cloudflare login reaches where you may not read Workers, such as a client's, is left out, and the step says so. `anyhost connect` and `anyhost join <link>` do the same from a terminal.
- **`/machines`** lists every machine joined to your relay, connected or when it was last seen, gives the install command with a fresh invite and a **Copy** button, and removes another machine. `anyhost machines`, `anyhost machines --invite` and `anyhost machines --remove <machine>` do the same from a terminal.
- The option **Join with** (`join`): `cmod install heyJordanParker/anyhost --option 'join=<link>'` joins the machine as anyhost starts, then empties the option, so the next machine needs nothing but the pasted command.
- A relay older than this anyhost is updated with the machine's Cloudflare login. Without one, a relay that answers an older protocol shows Connect your machines again, and a relay that is only an older version keeps taking the machine's uploads, with the failed update and its fix, `anyhost connect`, in `anyhost doctor`.
- **`anyhost attach <session>`** shows a session that runs in Claude Code's background on another machine and types into it, through your relay, and straight from that machine, encrypted, whenever the two reach each other over Tailscale or your local network. It moves between the two ways by itself with no keystroke lost. When the machine's own view of the session is killed, as by running out of memory, every viewer gets it back within seconds, and a viewer hears that the session stopped only once it did. On Linux, when the Claude Code background service anyhost started on the machine is stopped, every viewer of its sessions hears they stopped. `anyhost doctor` says when macOS keeps your terminal app off the local network.
- **`/move <machine>`** and **`anyhost move <session> <machine>`** move a running session to another machine, which runs it in Claude Code's background, and a herdr pane shows it there with no command typed. Moving it back is the same command. A machine that is offline or cannot take the session leaves it running where it was, with a toast that says why, and **Keep it here** keeps it while the move waits. A folder Claude Code trusts here is trusted there too.
- **`anyhost new <machine> <folder>`** starts a session on another machine in the same repository and shows it here.

### Changed
- anyhost keeps your sessions through a relay in your own Cloudflare account, a Worker and a Durable Object bound to your R2 bucket, instead of an R2 API token in the AWS profile `r2`. No machine holds an R2 key any more, and anyhost no longer reads `~/.aws`. Each machine joins the relay once and keeps one connection to it, which carries every upload, and an upload over 1 MiB goes beside it straight into the bucket.
- A machine that takes a session over tells the machine that held it through the relay, instead of over `ssh`, so the old machine refuses its very next prompt even when the two machines cannot reach each other. A machine that was not connected hears it the moment it connects again, before it uploads anything. `anyhost released` is gone.
- A drop of the connection or a relay that cannot be reached loses no line: the program keeps every change, connects again at once, then less often up to once a minute, and the first upload after that carries everything. An upload the relay took before the connection dropped is never stored twice.
- `anyhost doctor` checks that the machine joined your relay and that the relay answers this anyhost's protocol, instead of the AWS profile and the bucket.
- **R2 bucket** leaves `/config`: the relay names its bucket. Your sessions stay in the bucket you named there. Connect Cloudflare binds your new relay to the bucket that holds this machine's history: of every bucket, `anyhost` too, the one where anyhost 0.2 last wrote this machine's record, else the one where it last wrote any machine's record, else `anyhost`. The step says which bucket and why, and names every other bucket that holds 0.2's records, whose sessions stay where they are. The relay takes your machines and which machine holds each session from its bucket.
- A renamed machine connects under its new name at once, instead of waiting 10 minutes for the old name to go quiet.
- `anyhost list` names the machine that holds every session, also one no other machine resumed.
- A removed machine's sessions stay listed and resumable, and a machine's Claude Code, temp and Codex folders follow it at each connect, so a session moves right after `CLAUDE_CONFIG_DIR` changed.

### Fixed
- anyhost costs close to nothing while your sessions sit idle. It reads your options only after Claude Code's settings change, instead of running `claude plugin list` every minute, and reads its relay login again only after a join. Each minute it checks only the sessions that wrote in the last 10 minutes for a change it missed, and every session at its start and once an hour, so a write it never heard about still uploads.
- A session whose uploads R2 lost part of uploads its files whole again from there, once, instead of reading its uploads every minute. A move does the same first, so the other machine restores every line, and keeps the session running here when it can't. When the machine no longer has the session's transcript, `anyhost doctor` says what a restore lacks and how to bring it back.
- A prompt waits at most 1.5 seconds on anyhost's check of which machine holds the session, and goes on with the last answer when the program is slow, instead of up to 10 seconds and an error toast. Sealing a quiet session no longer stops the program from answering while it compresses.
- A session moved back to a machine that ran it before starts there in seconds, as anyhost no longer copies one machine's record of a Claude Code background job to another.
- A removed machine, or one whose token the relay no longer knows, forgets its relay login, so `anyhost doctor` says only that it is not joined instead of also saying it is joined, and it joins again like a new machine.
- A session you worked in outside a repository and outside your home folder, such as a scratch folder under Claude Code's temp folder, resumes on another machine in that machine's matching folder, instead of in the first machine's own path, made anew there. A path macOS names with or without `/private`, such as `/private/tmp/notes` and `/tmp/notes`, now moves to the other machine's folders in both forms, for the home folder, Claude Code's and Codex's folders and the session's folder alike.

## [0.2.2] - 2026-11-05

### Fixed
- A session with a large file that compresses poorly, such as a big saved tool output, uploads on a slow connection, instead of failing at 2 minutes on every try and never reaching R2. Each upload now gets 2 minutes plus as long as its size takes at 100 KB/s, and an upload the network dropped still fails and tries again.

## [0.2.1] - 2026-11-05

### Changed
- **Upload every** defaults to 5 seconds instead of `0`: each session uploads at most once every 5 seconds, with everything it wrote, so a line reaches R2 within about 5 seconds. On a Mac that runs Claude Code all day, uploading every write took 1,258,076 uploads in 30 days, past R2's free 1,000,000 write requests a month, and 5 seconds takes 411,952. Set **Upload every** to `0` in `/config` to upload every write again.

## [0.2.0] - 2026-11-05

### Changed
- The `anyhost` program runs as a service of the machine, a launchd agent on macOS or a systemd user service on Linux, so it captures from each login on, also sessions you work in with no Claude Code open, such as Codex's. The first Claude Code session after the update makes the service.
- **R2 bucket** in `/config` names the bucket anyhost keeps sessions in, instead of `ANYHOST_BUCKET`, which anyhost no longer reads. Set it before the update when you used `ANYHOST_BUCKET`. A new bucket restarts the program within a minute, and each session uploads from its first byte there once it changes again.
- anyhost keeps each session's whole state, not only its transcript: subagents, saved tool output, the plan, the task list, `/rewind`'s checkpoints, background command output, the session's prompt history and pasted text, its environment, and the agent view's entry. A Codex session keeps its thread's entry and name too. `anyhost resume` puts every file back, so the session continues on another machine as it was.
- Each write reaches R2 about a second after it happens, instead of within 30 seconds, also while the session's repository commits. An upload that fails tries again by itself after 1 second, then less often, up to once a minute.
- A new session is listed on every machine about a second after its first write, instead of within a minute.
- A session is one journal shared by every machine, compressed with zstd, and checked file by file when it is restored.
- When two machines write a session at once, the second stops uploading it and logs that its lines are a fork, instead of mixing both.
- `anyhost list` shows how each session started: `cli` for an interactive session, `sdk-cli` for `claude -p`.
- A transcript rewritten before its end uploads whole, instead of stopping with an error.
- `anyhost resume` clones a repository this machine lacks beside the checkouts it already has, or into the **Checkouts folder** you set in `/config`, instead of into `~/Developer`.
- A working folder's code catches up in R2 2 to 3 times as fast, 4 pieces at a time, and each line still reaches R2 in about a second meanwhile.

### Fixed
- anyhost finds Claude Code's sessions in `CLAUDE_CONFIG_DIR` when you set it, as Claude Code does, instead of only in `~/.claude`, and `anyhost resume` puts them in the Claude Code folder of the machine it runs on.
- A file the session deleted, such as a plan `/rewind` took back or a task Claude Code removed, stays gone after `anyhost resume`, also on a machine that still had it.
- A Codex session resumed on a machine Codex never ran on keeps its name in `codex resume`'s list, instead of taking a new one after its next turn.
- A session whose working folder is missing on a machine still uploads its files there, and the program's log says once that it keeps no code of that folder.
- A long session no longer stalls every upload on its machine for 10 seconds each minute once it goes quiet: anyhost reads its uploads 16 at a time to seal them, not all at once.
- The first prompt on a machine after another machine took its session over is refused every time. It went through when R2 took more than 5 seconds to say which machine holds the session. `anyhost resume --take` now tells the machine that held the session over ssh, and each prompt checks this machine's own record, with no wait on R2. A machine ssh cannot reach learns it when its program next starts or uploads the session, and the session resumed here shows a toast that names that machine.
- A check of who holds the session that fails lets the prompt through and shows a toast that says why.

### Added
- **Upload every** in `/config` sets the seconds between a session's uploads. `0`, the default, uploads every write.
- `anyhost resume` continues a Codex session too, with `codex resume`.
- A session keeps its working folder's code in R2, and `anyhost resume` puts it back before it opens the session.

## [0.1.1] - 2026-11-03

### Changed
- A renamed machine keeps anyhost running. It waits until its old name has been quiet for 10 minutes, then takes the new name by itself, with no Retry. `anyhost doctor` says until when it waits. A machine cloned from one that still runs anyhost captures nothing and shows the fix once a session.
- A session id Claude Code wrote into two project folders keeps both files in R2, and `anyhost resume` puts each back in its own folder.
- `anyhost doctor` shows only the problems that still hold.
- A dropped network connection no longer stops uploads until a restart: each request to R2 gives up after 2 minutes, and the next pass tries again.
- anyhost uploads a transcript once it grows while anyhost runs, from its first byte. It no longer uploads every old transcript at its first start.

## [0.1.0] - 2026-11-03

### Added
- Every Claude Code and Codex session on a machine is kept in Cloudflare R2, byte for byte, within 30 seconds of each new line. One `anyhost` program per machine reads only the bytes a transcript gained.
- `anyhost list` lists every session of every machine: its title, first prompt, machine, repository, working folder, last activity and the machine that holds it. `--json` prints the same as JSON.
- `anyhost resume <session>` continues a Claude Code session on this machine. It finds the session's repository by its git remote, or clones it into `~/Developer`, and opens `claude --resume` there, in a herdr pane when a herdr server runs.
- A session another machine resumed refuses prompts with `This session continues on <machine>.` `anyhost resume <session> --take` takes it back.
- `anyhost doctor` checks the AWS profile `r2`, the bucket, this machine's registration and the program, and prints the fix for each problem.
- A machine cloned from another, which keeps its machine id, refuses to run with the fix while the original runs. A renamed machine takes its new name once the old name has been quiet for 10 minutes.
- The first start uploads every transcript the machine already has, behind the sessions you work in.
