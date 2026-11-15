# Changelog

What changed in each version of anyhost, for the people who use it. cmod publish releases the section for the version, and cmod's Settings shows it.

## [0.9.1] - Unreleased

### Changed
- A session that sleeps holds no process. anyhost ran a process for every session a workspace listed, up to 300 on one Mac, which took 6.6 GB and every terminal macOS can open. Claude Code now runs directly in its terminal, and a session that sleeps closes it until you open it again, as Chrome discards a tab.
- Opening a session shows Claude Code's own screen at once, never an anyhost screen in front of it.
- `anyhost run` is gone.

### Fixed
- Every session anyhost starts saves its transcript again. A program started from inside a Claude Code session passed that session's markers to herdr-core, and Claude Code saves no transcript for a session that carries them.

## [0.9.0] - 2026-11-15

### New
- The sidebar is an inbox over your projects, laid out as T3 Code's. Pinned sessions come first under their own header, each with a pin you click to unpin, then Active: sessions that need you, then everything else by its last message, however old. A session whose turn just ended comes to the top at once. Working, Snoozed and Settled are shelves at the foot of the list, however short it is, and every state has one colour and icon everywhere.
- Snooze a session from its menu: In 1 hour, In 3 hours, This evening, Tomorrow or Next week, soonest first with the time each wakes, or Custom… for a date and time or a duration. The Snoozed shelf lists the soonest wake first and shows how long is left, and Wake now brings a session back early.
- Settle a session from its menu, its hover check, or s and Cmd-Shift-S in the list. The Settled shelf lists the newest settle first, 10 at a time with Show 25 more. Unpin, Settle, Snooze and Archive each toast an undo, and undoing a settle puts back the pin and snooze it cleared.
- Archived sessions leave the sidebar for Settings, which lists them by project with Restore and Delete.
- Projects read as names: `creator-income-blueprint` shows as Creator Income Blueprint, `php-sharp` as PHP Sharp. Rename… in a project's menu sets any name, with Reset to go back, and the sidebar, the filter, the cards and the palette all show it.
- Each worktree is a workspace of its own, named after its project and branch, holding every pinned, active and working session of that worktree, asleep until you look at one. The projects pane nests a project's worktrees under it by branch: pick the project to open its first worktree, this machine's main checkout before the others, and list that worktree's sessions, with one click on the branch's chip away from every worktree's, or pick a worktree to open its workspace and list only its sessions. A session you settle, snooze or archive leaves its workspace and keeps running, and opening it brings it back. Sessions already open in a project's single space move into their worktree's workspace by themselves, with nothing restarted.
- One session can show in several tabs at once. Show beside or below this pane puts a live view of it next to any other pane, so tab 1 can hold it alone and tab 2 hold it at 70/30 with another session. Move to tab moves a session's terminal into another tab.
- A session that works in another terminal here, as in tmux, shows in its tab and continues there once its turn ends. One that runs on another connected machine shows its screen live and takes what you type. One whose machine is offline asks before it continues here from its backup.
- Tags as in Notion: create, colour, rename and delete them, and give a session several. The Board shows your sessions in columns of stages you define, or by state, and you drag a card to move it. Tags, stages and filters reach every machine.
- One filter for project, state, tag and machine, with a chip for each that one click removes. Sessions outside git are No project. Background runs, sessions in temporary folders and deleted sessions show once the filter's Also show includes them.
- In the anyhost layout, the key that opened Herdr's space picker (Cmd-P on a Mac) opens anyhost's palette instead: actions first, then your projects, then your recent sessions, searchable together, as T3 Code's command palette lays them out.
- Every list, popup and dialog of the sidebar shares one scale of text sizes, row heights, spacing and corners, so rows line up and look alike everywhere.
- New session inside a project starts at once in that project, with no question. From All projects it lists every project with each of its worktrees by its full path.
- Each card says what its session last said, asked or ran.
- anyhost runs the sidebar's footer: Machines lists every machine, adds one in a click and removes one, and Settings sets after how many idle days a session settles by itself.
- Settle and snooze, as in T3 Code. A settled session leaves the active list for the Settled shelf until its next message, and an idle session settles by itself after 7 days, a setting from 1 to 90 days or off that every machine shares. A snoozed session hides until the time you pick, a prompt to it, or its wait for your permission, and a finished turn never wakes it. `anyhost settle`, `anyhost snooze` and `anyhost settle --after` do the same from the terminal, and agents get `settle_agent` and `snooze_agent`.
- Archive is yours alone: nothing archives a session by idle time any more. A shared list that set days to archive after now settles after 7 days instead.
- Rename a project once and every machine shows the new name. `anyhost project-name` does it from the terminal.
- A session waiting on its background agents, commands or Monitors reads Working, never Done, as Claude Code itself counts it, so sleep, Archive and a move never stop it while that work runs. A session handed to the background with ← reads idle in the window it left, instead of Working for weeks. Moves, sleep and the list all read this one status, so such a session no longer blocks a move or stays awake.
- A thread you settle in T3 Code settles in anyhost too. Only a thread you archive or delete in T3 Code is archived in anyhost.
- The keyboard walks the inbox: j and k move, Enter opens, Space peeks, e archives, u marks read or unread, p pins, s settles, t tags.
- anyhost draws its own tab bar: drag a tab to reorder it, double-click to rename it, middle-click or × to close it, right-click for the session's menu with Close tab, Close other tabs, Close tabs to the right and Reopen closed tab.
- Each workspace tiles its sessions the way you pick, as Hyprland and niri do: Tabs, Scroll (side-by-side columns you scroll through), Master (one large session on the left, right or top), Dwindle, Grid, Stack (one at a time) and Board. Each workspace keeps its own mode, order and master size. The tab bar stays on top in every mode: it lists the sessions in order, a click focuses one, a drag reorders every mode, and its icons switch modes. The pane keys move focus between tiles, with shift they move the focused session, and in the anyhost layout the pane keys' modifier (Cmd-Option on a Mac) with Enter makes it the master, with M cycles the modes, with = and - sizes the master, and with , and . scrolls the strip. A narrow window shows fewer columns.
- A worktree's right-click menu starts a session in it, makes a new worktree from it on a new or existing branch, removes it, switches its workspace's mode, marks all its sessions read and copies its path, branch or repository. A project's menu starts a session, makes a worktree, renames it and shows it on another machine.
- Pins live with the session on every machine, and a pinned session never settles by itself. `anyhost pin` pins from the terminal, and `anyhost tell --keys` presses keys in a session.
- Fork, split or duplicate any session, at its end or at any of its messages: `anyhost fork <session> [--at <message>] [--open]`, and `fork_agent` for agents. The fork lists at once as `<title> (fork)`, on the machine that holds that session.
- A fork is a session of its own, never a subagent: the sidebar shows it as its own card that says `fork of <title>`, never folded under the session it came from, and so does a conversation Claude Code's `/branch` forked. `list_agents` gives each agent its `source`, the agent it was forked from, apart from its `parent`, the agent that started it with `start_agent`.
- A session's history is stored like git: each large file goes up as pieces named by their content, and every session, fork and machine shares the pieces it has in common. A fork costs a few hundred bytes however long its conversation, so 30 forks of a 400 MB conversation cost about what one copy does. A fork Claude Code makes itself uploads only what differs from its parent. Every fork lists, restores, moves and deletes as any session, also after the session it came from was deleted or lives on no machine.
- The new form turns on once every machine you have runs anyhost 0.9, so a machine still on 0.8 keeps reading and backing up every session meanwhile.
- anyhost rewrites the history it already keeps into this form, one session a minute in the background, under a daily budget that stays well inside Cloudflare's free plan, and keeps every old copy until the new one reads back byte for byte. That covers every session in your bucket, also those no machine holds, as old imports and the sessions of a machine you removed: once a machine has rewritten its own, it takes those up one at a time, holds each only while it rewrites it, and lets it go after, so any machine opens it as before, and one you open on that machine meanwhile stays yours. `anyhost doctor` shows on every machine how many sessions of your whole bucket are done.

### Fixed
- A session's first 8 characters open every session `anyhost list` shows, a session no machine has opened since it was imported too, where `anyhost open` said no session's id began with them.
- anyhost no longer stops answering for seconds at a time on a busy Mac. The sidebar no longer reads "Can't reach anyhost" while it lists dozens of open sessions, and backups and the relay connection keep going meanwhile.
- A history rewrite that anyhost stopped in the middle, as at a restart, waits a day before it tries again, instead of starting over at every start, and anyhost deletes the space such a rewrite left on disk.
- A session whose backup a machine had lost track of, as after its database was rebuilt, backs up its new lines at once instead of uploading the whole session twice and hiding the new lines until it went quiet.
- Archive closes the session's tab and takes it off the list, with a toast to restore it. Delete asks first, never runs on a working session, and can be undone.
- Archive works from every menu, the tab bar's too, from e and from the tab's ×, whatever the session is doing. A session that works or waits stops once its turn ends.
- A finished session reads Done, never "Working 12h", when a session it opened in a terminal works on its own.
- A card shows its project and branch in every filter, as it does under All projects, so its first line never sits empty but for its state. A Board card names its project in every scope too.
- Leaving a session where it runs, at "any other key leaves it there", no longer archives it, and neither does closing a pane that only shows a session another pane runs.
- The sidebar no longer shows "could not be re-rendered" errors as you click around.
- The sidebar, the tab bar and the Board stay drawn and answer every click on a machine under heavy load, with hundreds of sessions: no more "could not be re-rendered" banner over the tab bar or the inbox, and the inbox never goes back to "Reading your sessions…" while a read runs, fails or times out. A reload draws your whole list at once.
- The sidebar refreshes in one call instead of two, and no longer waits up to 5 seconds on a slow machine.
- A click on a sleeping session shows its tab instead of opening a second one.
- The inbox never moves under your pointer: new rows wait behind a `new` marker until you look away.
- Opening a session on the machine it lives on resumes it right there, on your code as it is now. It no longer downloads it from R2 or rewinds its code, whatever anyhost's database remembers.
- No restore ever makes a worktree or changes your checkout. A session continues on the checkout you have, and a repository the machine lacks is cloned as the remote has it now. Only a move of a running session brings its uncommitted changes, and only onto a checkout with none of its own.
- A Codex session shows once, instead of twice with a click that opened another space each time.
- While anyhost restarts, the sidebar no longer stacks an error toast for each session it could not mark read. It marks them once anyhost answers again.
- After a Herdr or herdr-core restart, every tab and split comes back as you left it, each session asleep in its own pane, with no second pane beside it. This now works with no Herdr window open too, as anyhost itself puts each session back.
- Many Herdr windows on one machine no longer race each other: anyhost alone archives a session whose pane you closed, keeps a session awake while any window shows it, and marks it read once.
- A session whose runner ended by itself is no longer archived as if you had closed its pane.
- A session woken while anyhost restarts continues in its own folder, instead of the folder its terminal started in.
- A sleeping session starts Claude Code the moment you look at its tab, instead of asking you to type.
- Opening a session that works in another terminal, as in tmux, asks before it moves it: Enter moves it once its turn ends, any other key leaves it there. An idle one moves at once.
- A session nobody named is called by the first line of its first message, with file paths shortened to their file name, everywhere it is listed.
- Archiving a session takes it off the list at once, and its undo toast appears only once the archive went through.
- Agents control each other on two layers. `sleep_agent` stops an agent, `read_agent` pages back through its whole history, and `show_agent` puts its terminal on your screen: focused, peeked, in a tab, beside or below your pane, or hidden while it runs on. `anyhost sleep` and `anyhost show` do the same from a shell.
- The sidebar updates the moment a session changes: a new session, a rename, a `/cd`, a turn that starts or ends.
- A Codex session shows as the same card as a Claude Code session, matched to its terminal.
- A finished agent says Done until you answer it, seen or not; one you haven't looked at has a bold title.
- Every session row has the same three lines, and a session outside a project never shows a branch.
- The project counts add up to All projects.
- Projects sit above the inbox in the sidebar.
- Sessions glide to their new place in the sidebar, fade in as they arrive and fade out as they leave, as in T3 Code. Opening a shelf brings it into view.
- A list filtered to a project says the project's name under the search, with × back to All projects.
- Picking one project and then another quickly never jumps the screen back to the first.
- Peek shows the real Claude Code session in a popup, with Keep to make it a tab.
- Sleep in a session's menu stops its Claude Code now and keeps its tab. It wakes when you bring it into view or type.
- New stage… in a session's Stage menu, the same search-or-create picker as tags.
- An archived session stays archived until it gets a new message. Background backups and Claude Code closing no longer bring it back as Done.
- Every card says what its session last said, including sessions backed up before anyone kept that, and they sort by their last message instead of their last backup. anyhost reads only the start and end of each transcript to catch up, once.
- A Codex session whose rollout Codex already compressed goes up to R2 with that rollout, and lists its folder, prompt and last reply.
- A session the Claude app opened with a hidden note before your first message is named by your own words.
- Closing a session's tab is instant: the tab leaves, the next one shows and the card archives in the same click, while Claude Code stops in the background. The toast and Cmd-Shift-T reopen it, with its name on the tab.
- A message from another agent never moves a session you run in tmux or a plain terminal. It says where the session runs and leaves it there.
- A session never runs twice on one machine. Opening or waking a session that Claude Code already runs in another terminal here, as in tmux, starts no second Claude Code, even when anyhost restarts or its answer is lost while it waits for that copy's turn to end. The tab says which process runs it, and a key closes the tab or puts it back to sleep.
- When Herdr shows a session of another project by itself, as at a notification click, the sidebar's project follows it.
- A session opens at its pane's size, so Claude Code never draws a frame at the wrong size first, and the sleeping screen never draws over it.
- A Codex session no longer offers Sleep, which only Claude Code sessions do.
- A session carries the name Claude Code gives it everywhere: its /rename, its generated title, or the agent it runs as, such as `cto`, instead of its first message.
- A session no longer fails to open with `setRawMode failed with errno: 5` when anyhost reads your login shell's environment as it starts.
- A working Claude Code session reads as working from Claude Code itself, so a card no longer flips state between two sources.
- A session idle in another terminal says it moves here, instead of claiming it works there.
- A session running in a tab always has its row, even one archived before.
- Sessions on the Working, Snoozed and Settled shelves look like every other session.
- The Board opens from the palette as a view of your workspace, and no longer sits as a button in the sidebar. Its stage headers and Add stage look like the rest of the sidebar.
- A session whose backup R2 already holds, such as one you imported, backs up from the end of that backup the first time a machine captures it, whether or not a machine holds it. Its new lines restore at once, instead of hiding behind the old backup until a full upload 20 minutes later. A machine that meets another machine's write as it starts a session's backup goes on after it, instead of stopping that session's backup.

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
