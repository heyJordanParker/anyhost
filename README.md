# anyhost

**Every Claude Code and Codex session of every machine you work on, kept safe in Cloudflare R2 and resumed on any machine.** A dead or busy machine no longer holds your plans and ideas: each session's whole state is in R2 about a second after each write, every machine lists every session, and one command continues a session on the machine you are on, from R2 alone.

```text
$ anyhost list
SESSION                               TOOL    ENTRYPOINT  MACHINE  HOLDER  LAST ACTIVITY     REPOSITORY  FOLDER       TITLE           FIRST PROMPT
3f9c2b1e-7a4d-4c55-9b0e-2d8f61a0c7e4  claude  cli         server   -       2026-11-03 14:02  acme/shop   ~/code/shop  Checkout retry  Make the checkout retry a declined card once…
8e41d0aa-52b3-4f1e-a9c6-0b7d3e9f2c11  codex   cli         laptop   -       2026-11-03 13:40  acme/blog   ~/code/blog  -               Draft the post about the release…

$ anyhost resume 3f9c2b1e-7a4d-4c55-9b0e-2d8f61a0c7e4
```

anyhost has two parts:

- **The `anyhost` program**, one copy per machine. It uploads every file Claude Code and Codex keep for a session to R2 as it changes, and answers `anyhost list`, `anyhost resume` and `anyhost doctor`.
- **A Claude Code mod** built with [cmod](https://github.com/heyJordanParker/cmod). It runs the program as a service of the machine, from each login on, and stops a session that continues on another machine from taking prompts.

## Install

You need:

- macOS, or Linux with a machine id in `/etc/machine-id`, on arm64 or x64
- [Claude Code](https://code.claude.com)
- an R2 bucket named `anyhost` in your Cloudflare account, or another name you set as **R2 bucket** in `/config`, and an R2 API token that can read and write it
- Node.js with npm, or Bun, to install cmod

Give anyhost the R2 token as the AWS profile `r2`. `~/.aws/config` holds the endpoint:

```ini
[profile r2]
endpoint_url = https://<account id>.r2.cloudflarestorage.com
region = auto
```

A bucket in the EU jurisdiction takes `.eu.` before `r2` in that address.

and `~/.aws/credentials` the token's keys:

```ini
[r2]
aws_access_key_id = <access key id>
aws_secret_access_key = <secret access key>
```

Install cmod once, then anyhost:

```bash
npm install -g @cmodjs/cli
cmod install heyJordanParker/anyhost
```

cmod downloads the `anyhost` program from this repository's release, checks it against the release's `SHA256SUMS`, and links it into `~/.local/bin`. Start Claude Code once: the mod makes the program a service of the machine, a launchd agent on macOS or a systemd user service on Linux, which starts at each login with no Claude Code open, registers the machine in R2, and uploads each session you work in, in Claude Code or Codex. Run `anyhost doctor` to see that each part works.

## Use it

- **`anyhost list`** lists every session of every machine, the most recent first: its id, Claude Code or Codex, how it started (`cli` for an interactive session, `sdk-cli` for `claude -p`), the machine it last ran on, the machine that holds it, its last activity, repository, working folder, title, and first prompt. `anyhost list --json` prints the same as JSON.
- **`anyhost resume <session>`** continues a Claude Code or Codex session on this machine, also over `ssh <machine> anyhost resume <session>`. It takes the session for this machine and downloads it from R2. It puts back every file of the session: the transcript and its subagents, saved tool output, the plan, the task list, `/rewind`'s checkpoints, background command output, the session's prompts for the up arrow, and its name. A file the session deleted, such as a plan `/rewind` took back or a task Claude Code removed, stays gone. It finds the session's repository among your checkouts by its git remote, or clones it beside them: into the folder your checkouts share, or the **Checkouts folder** you set in `/config` (the option `checkouts`), or your home folder when it knows no checkout yet. It puts back the working folder's code, and runs `claude --resume <session>` or `codex resume <session>` there. With a herdr server running, it opens the session in a new herdr workspace instead of the current terminal.
- **A session another machine resumed** answers each prompt you type with `This session continues on <machine>.` Resume it where you are with `anyhost resume <session> --take`. The resume tells the machine that held the session with `ssh <machine> anyhost released`, so that machine refuses the next prompt at once. It needs `ssh <machine>` to log in with no password prompt, as a key does. A machine ssh cannot reach learns it when its anyhost next starts or uploads the session, so a prompt typed there before that goes through, and the session you resumed shows a toast that names that machine.
- **`anyhost doctor`** checks the AWS profile `r2`, the bucket, this machine's registration, and the program, and prints the fix for each problem.

A virtual machine cloned from another keeps its machine id, so both would write as one machine. While the original still runs anyhost, anyhost captures nothing on the clone and shows the fix: on Linux `sudo rm /etc/machine-id && sudo systemd-machine-id-setup`, then a restart. A machine you renamed keeps its id too: anyhost waits until the old name has been quiet for 10 minutes, then takes the new name by itself, and `anyhost doctor` says until when it waits.

anyhost uploads a session once one of its files changes while anyhost runs, every file from its first byte, so a running session, and an old one you resume, upload whole. It never reads the old sessions you leave alone.

anyhost uploads each write as it happens. To upload less often, set **Upload every** in `/config` (the option `uploadEvery`) to the seconds between a session's uploads: each session then uploads once per period with everything it wrote. `0`, the default, uploads every write. The program reads a change within a minute.

## How it works

The bucket holds:

```text
devices/<device id>.json                        each machine: its name, os, arch, and its home, Claude Code temp and Codex folders
sessions/<device id>/index.json                 every session the machine wrote: title, first prompt, entrypoint, folder, repository, last activity
claims/<session>.json                           the machine that holds the session
journals/<session>/hot/<start>.zst              one upload of the session: what its files gained, at byte <start> of its journal
journals/<session>/sealed/<start>-<end>.zst     the uploads of a session that went quiet, up to 64 MiB each
```

- A session's journal is every byte its files gained, in order, shared by every machine that holds the session in turn. Each upload is one zstd frame of records: the file's path, where in the file the record starts, its bytes, and the file's size and sha256 after it. A file the session deleted gets a record that says so. Replaying the records rebuilds every file, whether it grew, was written once, was rewritten, or is gone.
- The program hears each write from the operating system, puts its session on the upload queue, and uploads what the session's files gained since its last upload, one upload in flight per session. A failed upload tries again after 1 second, then less often, up to once a minute. Every 60 seconds it also checks the files it captured for a change it missed, and at its start the files that changed since it last ran.
- After an upload that changed a session, the program reads the session's working folder with git in the background and uploads its code in the uploads after, a large part in 128 KiB pieces, 4 at a time, between your lines, so a line never waits on git and reaches R2 in about a second while the code goes up. A working folder missing on the machine gets one line in the program's log, and the session's other files still upload.
- A session quiet for 10 minutes is sealed: its uploads become frames of up to 64 MiB, which are never written again.
- `anyhost resume` downloads the session's frames 16 at a time, replays them, checks each file's size and sha256 against its last record, and only then puts the files in place, with each machine's paths rewritten to this machine's. This machine then continues the same journal.
- Each upload claims its place in the journal. When two machines write the same place, one write wins, and the other machine stops uploading the session and logs that its lines from there are a fork.
- No machine keeps a copy of another machine's sessions. `anyhost list` reads one index per machine, and `anyhost resume` downloads only the session it resumes.
- The program keeps what it uploaded of each file in `~/.local/state/anyhost/anyhost.db`.
- **R2 bucket** in `/config` (the option `bucket`) names another bucket than `anyhost`, such as one for tests. Every machine names the same one. The program restarts on the new bucket within a minute of a change, and uploads each session from its first byte there once it changes again.

## Documentation

- [Releasing](docs/releasing.md): publish a version

## License

[MIT](LICENSE)
