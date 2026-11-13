# Changelog

What changed in each version of anyhost, for the people who use it. cmod publish releases the section for the version, and cmod's Settings shows it.

## [0.8.5] - 2026-11-13

### Fixed
- A machine whose database says it is up to date but lacks a column backs up again. anyhost now adds every column its database lacks as it starts, so `anyhost doctor`'s `backup: SQLiteError: no such column: replaced` goes away by itself.

## [0.8.4] - 2026-11-13

### Added
- anyhost keeps each mod's data folder in R2 as it keeps your sessions, so a dead machine no longer takes a mod's data with it, such as totalrecall's chat or the inbox's items. It uploads only what each file gained, and leaves out the files cmod says the mod rebuilds by itself, such as totalrecall's indexes. This needs a cmod that answers `cmod data`, and until then anyhost keeps no data folder.
- `anyhost resume --data <mod> --from <machine>` places that machine's copy of a mod's data folder into this machine's, which must hold no file. This machine keeps that folder as its own from then on.

### Fixed
- An older anyhost that starts on a machine by accident can no longer change that machine's sessions in R2. Your relay remembers the newest anyhost each machine connected with and refuses an older one, which exits, and `anyhost doctor` names both versions. Run `cmod update anyhost` to fix it, or join the machine again with `anyhost join` to run an older anyhost on purpose. anyhost updates your relay by itself for this.

## [0.8.3] - 2026-11-13

### Fixed
- Your sessions take far less space in R2. A copy of a file or of your uncommitted code that a newer copy replaced is dropped once it is a week old, so a long session no longer keeps every old copy. A session restored afterwards has the same files and code. anyhost updates your relay by itself for this.
- An update of anyhost no longer uploads every active session whole again. anyhost now updates its database in place.
- A slow request no longer fails after 10 seconds with ECONNRESET. anyhost's program now waits as long as the answer takes.
- A restart of anyhost's program no longer opens the Connect your machines step, nor shows an error at your next prompt. Both wait for the program to answer again.
- A session a screen shows is never stopped while anyhost still reads whether it is shown.

## [0.8.2] - 2026-11-13

### Fixed
- A move that fails no longer closes and reopens the session. The move now pauses the session's Claude Code instead of ending it, and ends it only once the other machine runs the session. When the move fails or you press Keep it here, the same Claude Code goes on, with its screen and anything typed meanwhile.
- Archiving several sessions in the Herdr pane no longer shows them back for a moment. Archive, Restore, Delete and Mark unread take effect at once and stay, and a failed one puts the card back and says why.
- An archived session whose terminal is still open stays archived.
- Sessions T3 Code settled or archived are archived in anyhost too, on every machine.
- A T3 Code session that is not running no longer says it is working in T3 Code.
- An agent that stops at a permission prompt always tells the agent that started it, even when its machine missed the change, within a minute at most.

## [0.8.1] - 2026-11-12

### Fixed
- A move no longer drops the note a finished background command sends the session, nor a prompt typed while the move uploads. Both run, and the move waits for their turn before it stops the session.

## [0.8.0] - 2026-11-12

### Fixed
- A move never runs a session on two machines at once. The machine a session leaves now stops its copy before the other machine starts one, once the turn has ended, so a prompt typed during the move can no longer run on the old machine and be lost. A move that fails opens the session here again.
- A click on a session another connected machine runs never takes it from that machine, even when the sidebar's list is a few seconds old. The open answers that the session opens there.
- A turn a sleeping laptop took after another machine took the session is kept, not lost. When that laptop next opens the session, the turn becomes a session of its own, titled "Conflicted copy of …", listed beside the original.
- A frame a relay restart let through after a takeover no longer stops the new machine from backing up the session.
- A session started on another machine never starts twice, even when that machine's anyhost restarts while it answers.
- The warning that another machine may take one more prompt shows once, not each time anyhost checks the session.

### Faster
- The sidebar's refresh every 30 seconds downloads the session lists and the shared list only when they changed, instead of every time.
- Sealing a quiet session no longer downloads what this machine just uploaded.

## [0.7.3] - 2026-11-12

### New
- Agents replace Claude Code's own subagents. `delete_agent` deletes an agent wherever it is held. `read_agent` with `messages` reads an agent's last messages, so an agent reads a child's answer as its last message, whether it still runs or not. `list_agents` shows who started each agent and on which machine, and `children_of: "me"` lists an agent's own children. A child's first message names its parent and that machine, so it reports back when it is done or stuck. A child that waits at a permission prompt tells its parent which keys answer it.
- `anyhost tell <session> --messages <count>` prints a session's last messages, and `anyhost delete` deletes a session wherever it is held.

### Fixed
- Clicking a session that runs in tmux, Herdr's terminal app or a plain terminal, on any machine, never moves it by itself. It shows Move it here, and the move waits until the session's turn, its background commands and its permission prompts have ended, then stops that copy and resumes the session in the Herdr app. The original always closes, so the session never runs twice.
- Two clicks or messages at once no longer open two terminals of one session.
- A move that waits longer than the Herdr app's 10-minute limit for a command no longer fails with an error. The screen shows "Moves here once its turn ends" until it arrives.

## [0.7.2] - 2026-11-12

### Fixed
- No session runs twice anymore. A message or a click on a session whose live Claude Code ran outside its anyhost terminal, as in tmux beside an older anyhost's sleeping copy, typed into that sleeping copy and started a second one. anyhost now uses a session's terminal only while every live Claude Code of the session is its own, and otherwise stops every copy once its turn ends and continues the session in one new terminal.
- The errors on every prompt, and the Archive button that did nothing, are gone. anyhost's background program spent all of its time starting git for code backups and re-reading every session's record, so it answered seconds late or not at all. It now reads a session's code at most once a minute and lists folders off its main thread, and `/status` answers in 35 ms at the 99th percentile on a Mac with 61 live sessions.
- Archive, the session list and the machine list wait out a reconnect to the relay instead of failing with "anyhost connects to the relay at …".
- Clicking a session that runs in another terminal shows "This session is working in another terminal" with Move it here, as a T3 Code session does, and moves nothing by itself.
- The sidebar draws every session with one card, with t3code's colored status: Working, Pending Approval and Completed. Working sessions stay in the list, and only background runs fold away.

## [0.7.1] - 2026-11-12

### Fixed
- No update can drop a session from your history again. An older anyhost that opened this machine's database dropped what it knew of its sessions, and the next index it uploaded listed 5 of them. Each machine's index now keeps every session it ever listed. At each start, anyhost lists again every session that has a backup in R2 and a transcript on this machine. An older anyhost now refuses a newer database whole instead of emptying it.
- Every session this Mac lost from the list on 2026-11-12 is listed again: 254 came back from their transcripts and backups at the first start.
- Resuming a session in your home folder no longer asks whether you trust the folder. anyhost passes Claude Code the trust you gave the session, as Claude Code does for a copy it relaunches, and sessions in the home folder now stop after 8 idle hours like any other.
- A failed refresh of the session list keeps the list it last read and shows one toast, instead of printing the error in the sidebar.

## [0.7.0] - 2026-11-11

### Fixed
- Backups no longer stop for the day on Cloudflare's free plan. Every refresh of the session list read where every session lives from the relay, 2.8 million rows an hour, until Cloudflare refused the relay at 16:49 UTC. Each machine now learns of each change once, as the relay sends it, and lists from its own copy.
- Codex compressing its old transcripts no longer adds thousands of empty sessions: a session starts once a transcript of it exists, and a compressed `.jsonl.zst` is still its transcript, so a Codex session keeps its history after 7 idle days.
- Sessions that ran in two folders show again, with their first prompt and folder, in Sessions or Archived.
- A used-up free plan shows as one line, saying uploads wait on disk until 00:00 UTC, instead of one error per session.

### Added
- **Archived sessions** in place of the Settled shelf: a dated list of every archived session, with Background and Deleted below it. Archive, Restore and Delete work from a card's hover and its right-click menu, and Claude's `archive_agent` and `anyhost archive` do the same.
- A session shows **Done** once its turn ends after you last looked at it, on every machine, and **Mark unread** brings that back, as t3code does.
- The right-click menu follows t3code's: Pin and Move to, Mark unread and Copy, then Archive, Restore and Delete.
- Clicking a session shows its screen at once, and its terminal takes its place as soon as it draws. A session T3 Code runs shows Open in T3 Code and Move it here instead of a terminal.
- A **Projects** tab groups the active sessions of every machine by repository.

### Changed
- An idle session stops its Claude Code after 8 hours with nobody looking, and the next open or message resumes it.
- Connect your machines opens Cloudflare's R2 page with a button, which works over ssh too, and anyhost needs cmod 6.

## [0.6.0] - 2026-11-11

### Added
- Clicking any session in the Herdr app opens it, wherever it is: one you run in tmux comes into the Herdr app once its turn ends, one whose folder is gone comes back in a folder that exists, and one on another machine opens there.
- Sessions an agent started fold into that agent's card as "3 subagents", and open with a click.
- The sidebar has a Sessions tab and a Spaces tab, each the full height, and the Herdr app remembers which one you looked at.
- `anyhost open <session>` and Claude's `open_agent` run a session on this machine in the Herdr app and say which terminal, in place of `take_agent`.

### Fixed
- A session on your screen never sleeps, in every pane of a split, and one comes awake the moment it shows.
- A session that wakes draws on a clean screen, instead of over what the old one left.
- A session working in your home folder never sleeps, as Claude Code asks you to trust that folder again at every start.
- A session nobody typed in no longer shows in any list.
- Project icons are t3code's two-letter tiles.

## [0.5.1] - 2026-11-10

### Fixed
- A session that comes back to a machine continues in the folder it ran in there, instead of a new worktree beside another checkout of its repository.
- A new session's first message waits for Claude Code's screen to settle, instead of failing the start when Claude Code was still drawing.
- A session moved to a Mac never waits on macOS's privacy prompt for Desktop, Documents or Downloads, which held the move for good on a Mac with nobody at its screen.
- A session that ran on one machine in two folders, as a checkout and later a worktree beside it, moves and resumes everywhere, instead of failing its restore with `past its 0 bytes`, and the machine keeps no old copy that could go up over its history.
- A machine reaches your other machines in the Herdr app even when their names have capitals, which herdr-core refused.
- A move that fails after the other machine took the session comes back to the machine it left, even when that machine's anyhost restarted during the move, instead of staying held where nothing runs it.
- A public GitHub repository clones and fetches over https with none of your git config, so a machine whose config sends GitHub to ssh through an agent that asks at its screen, such as 1Password, never waits on it.

## [0.5.0] - 2026-11-10

### Added
- **Add a machine** installs anyhost on another machine over ssh and joins it, with no command to paste: pick one of your Tailscale network in `/machines` or the Herdr pane, type how ssh reaches it, or ask Claude. It installs herdr-core and cmod there too, and every machine's herdr-core reaches the others, so the Herdr app on any machine shows them all.
- **The Herdr pane takes the place of the Agents list**, after t3code's sidebar: search, the sessions that need you first, a Working shelf, and a Settled shelf. **Settle** puts a session away on every machine, and one idle for 7 days settles by itself, which you change or turn off from the shelf's clock. The pen starts a session in a project you pick, on this machine or the machine you picked last.
- A restart of your machine keeps your sessions where they were: each comes back resting in its own space and tab, and wakes as you open it.

### Changed
- A session opens in the space of its project in the Herdr app, beside its project's other tabs, instead of a tab of whatever space you were in.
- A session that wakes keeps its model and effort and its whole cached conversation, and never sends its first message again.
- A session with no message yet stays off every list, so opening one never starts an empty session.
- A session that began with a slash command is named after the command instead of its id.
- A new session in a folder Claude Code doesn't trust yet waits in its terminal for your answer, and takes its first message once you trust the folder, instead of failing after a minute.
- A machine with no GitHub key clones a session's GitHub repository over https, so a public repository needs nothing and a private one the machine's git login.

### Fixed
- Claude Code draws at the size of its window after a resize, instead of the size before it.
- A session working in `/tmp` moves and backs up without reading all of `/tmp` as its code.

## [0.4.0] - 2026-11-10

### Added
- Every session anyhost moves or starts runs in a terminal of herdr-core, so the Herdr app on any of your machines and Herdr mobile show it and type into it.
- **The anyhost pane of the Herdr app** is an inbox of every agent on every machine: the ones that came back to you on top, each with its project, title, machine and what it does now (Working, Needs you, Done), then shelves for the working and older agents and your machines. Clicking an agent shows its terminal, or resumes it here or on the machine that holds it, **Move** sends it to another machine, **+** copies the command that joins a new machine, and the pen starts a new agent here. anyhost installs the pane into the Herdr app at each start.
- Claude manages your agents from any session: it lists every machine and agent with what each does now, starts an agent on any machine with its first message, messages an agent or reads its screen wherever it runs, answers its permission prompt, moves it, takes it onto this machine when its own machine is offline, and adds or removes a machine. A session you make your CTO or project manager starts and steers the others, and a worker's message back names it, so the CTO hears when it is done or stuck. `anyhost tell <session> [text]` types into a session from a terminal, and `anyhost new` takes a first message and starts on this machine too.
- A Claude Code session idle for 15 minutes ends its process and keeps its screen, and opening it in the Herdr app or Herdr mobile, your next key, or a message resumes the same conversation, so it is ready before you type, does the work, and rests again. Nothing shows the rest: a resting session reads as idle everywhere. A session running a background command stays up until the command ends, and a `/loop` that runs at least every 15 minutes keeps its session awake. Sessions anyhost opens, and every Claude Code the Herdr app starts, sleep this way, so many open sessions no longer keep a laptop busy.

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
