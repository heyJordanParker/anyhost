# Changelog

What changed in each version of anyhost, for the people who use it. cmod publish releases the section for the version, and cmod's Settings shows it.

## [Unreleased]

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
