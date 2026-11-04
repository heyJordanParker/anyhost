# Changelog

What changed in each version of anyhost, for the people who use it. cmod publish releases the section for the version, and cmod's Settings shows it.

## [Unreleased]

### Changed
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
