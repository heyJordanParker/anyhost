# anyhost

**Every Claude Code and Codex session of every machine you work on, kept safe in your own Cloudflare account and resumed on any machine.** A dead or busy machine no longer holds your plans and ideas: each session's whole state is in your R2 bucket within about 5 seconds of each write, every machine lists every session, and one command continues a session on the machine you are on, from the bucket alone.

```text
$ anyhost list
SESSION                               TOOL    ENTRYPOINT  MACHINE  HOLDER  LAST ACTIVITY     REPOSITORY  FOLDER       TITLE           FIRST PROMPT
3f9c2b1e-7a4d-4c55-9b0e-2d8f61a0c7e4  claude  cli         server   -       2026-11-03 14:02  acme/shop   ~/code/shop  Checkout retry  Make the checkout retry a declined card once…
8e41d0aa-52b3-4f1e-a9c6-0b7d3e9f2c11  codex   cli         laptop   -       2026-11-03 13:40  acme/blog   ~/code/blog  -               Draft the post about the release…

$ anyhost resume 3f9c2b1e-7a4d-4c55-9b0e-2d8f61a0c7e4
```

anyhost has three parts:

- **The `anyhost` program**, one copy per machine. It uploads every file Claude Code and Codex keep for a session to your relay as it changes, and answers `anyhost list`, `anyhost resume`, `anyhost move` and `anyhost doctor`. Each session it opens runs in a terminal of [herdr-core](https://herdr.dev), so the Herdr app on any of your machines and Herdr mobile show it and type into it, and a session idle for 15 minutes ends its Claude Code and resumes at your next key.
- **A Claude Code mod** built with [cmod](https://github.com/heyJordanParker/cmod). It runs the program as a service of the machine, from each login on, and stops a session that continues on another machine from taking prompts.
- **The relay**, in your own Cloudflare account: one Worker and one Durable Object that keep every session in your R2 bucket, `anyhost` or the one anyhost 0.2 kept your sessions in, and carry every message between your machines. No machine holds an R2 key.

## Install

You need:

- macOS, or Linux with a machine id in `/etc/machine-id`, on arm64 or x64
- [Claude Code](https://code.claude.com)
- the [Herdr app](https://herdr.dev), or herdr-core alone on a server: `curl -fsSL https://releases.herdr.dev/core/install.sh | sh`. A session moves to or starts on a machine only when herdr-core runs there.
- a Cloudflare account. When R2 is off in it, **Connect Cloudflare** links you to Cloudflare's page that turns it on.
- Node.js with npm, or Bun, to install cmod

Install cmod once, then anyhost:

```bash
npm install -g @cmodjs/cli
cmod install heyJordanParker/anyhost
```

cmod downloads the `anyhost` program from this repository's release, checks it against the release's `SHA256SUMS`, and links it into `~/.local/bin`. Start Claude Code once: the mod makes the program a service of the machine, a launchd agent on macOS or a systemd user service on Linux, which starts at each login with no Claude Code open, and uploads each session you work in, in Claude Code or Codex.

Until a machine joins your relay, the mod's install page shows one step, **Connect your machines**:

- On your first machine, or any machine where you have a Cloudflare login, press **Connect Cloudflare**. It logs `cf`, Cloudflare's own command, in to your account when it is not, so you approve Cloudflare's page once, then deploys the relay into your account and joins the machine, showing each call as it runs. The relay keeps your sessions in the bucket that holds this machine's history from anyhost 0.2: `anyhost`, or the one you named in its **R2 bucket** option. anyhost 0.2 wrote a record of each machine into its bucket every 5 minutes, so the relay picks the bucket where this machine's record was written last, else the bucket where any machine's record was written last, else `anyhost`. The step names that bucket and why, and the relay's first start reads 0.2's machines and which machine holds each session from it. The step also names every other bucket that holds 0.2's records, whose sessions stay where they are. A relay already there, as new as this anyhost's or newer, gets only a new setup code. A relay that answers anything but its version, as past Cloudflare's daily limit of 100,000 requests, gets nothing, and the step says what it answered, so you connect again later. When your login reaches several accounts, the one that holds your relay is used, else you pick the one. An account where you may not read Workers, such as a client's, is left out, and the step says so. An account that never turned R2 on gets a link to Cloudflare's R2 page and a **Next** button. `anyhost connect` does the same from a terminal.
- Every other machine you add from a joined one: **Add a machine** in `/machines` or the Herdr pane, or ask Claude there. Pick a machine of your Tailscale network, or type how ssh reaches it (`devbox`, `me@10.0.0.7`), and anyhost installs herdr-core, cmod and anyhost there over ssh and joins it, which takes a few minutes, while `/machines` shows how it goes. Every machine's herdr-core then reaches every other, so the Herdr app on any of them shows the others' spaces and agents. A machine ssh doesn't reach joins with the command `anyhost machines --invite` prints: `cmod install heyJordanParker/anyhost --option 'join=<link>'`. anyhost joins with the link as its program starts, then empties the option, and the step waits for that join. A link that joins no relay, as one past its 10 minutes, shows on the step with why, and `anyhost doctor` prints it too: paste the command of a new invite into the step. On a machine that has anyhost already, paste the command or its link into the step, or run `anyhost join <link>`. A link joins one machine, within 10 minutes.

A machine joins once: it keeps the relay's address in `~/.local/state/anyhost/relay.json` and its own token with cmod's secrets. Until it joins, anyhost keeps what its sessions write and uploads nothing. A program that finds your relay older than it needs updates it with this machine's Cloudflare login. A relay that answers an older protocol than the program speaks takes none of the machine's uploads until then, so a machine without a Cloudflare login shows the step again. A relay that is only an older version keeps the machine connected and uploading while the program updates it, and when the update fails, as with no Cloudflare login on the machine, only `anyhost doctor` shows it, with `anyhost connect` as its fix. Run `anyhost doctor` to see that each part works.

## Use it

- **`anyhost list`** lists every session of every machine, the most recent first: its id, Claude Code or Codex, how it started (`cli` for an interactive session, `sdk-cli` for `claude -p`), the machine it last ran on, the machine that holds it, its last activity, repository, working folder, title, and first prompt. `anyhost list --json` prints the same as JSON.
- **`anyhost resume <session>`** continues a Claude Code or Codex session on this machine. It takes the session for this machine and downloads it from your bucket. It puts back every file of the session: the transcript and its subagents, saved tool output, the plan, the task list, `/rewind`'s checkpoints, background command output, the session's prompts for the up arrow, and its name. A file the session deleted, such as a plan `/rewind` took back or a task Claude Code removed, stays gone. It finds the session's repository among your checkouts by its git remote, or clones it beside them: into the folder your checkouts share, or the **Checkouts folder** you set in `/config` (the option `checkouts`), or your home folder when it knows no checkout yet. A working folder outside a repository goes to the same place among this machine's folders, such as under your home folder or Claude Code's temp folder. It puts back the working folder's code, and runs `claude --resume <session>` or `codex resume <session>` there. A Claude Code session runs under `anyhost run`, which ends Claude Code once the session sat idle for 15 minutes with no key typed, keeps the screen, and resumes the same session at your next key. A session running a background command stays up until the command ends.
- **Claude manages your agents.** In any Claude Code session, Claude can list every machine and agent with what each does now (working, idle, or waiting at a permission prompt), start an agent on any machine with its first message, message an agent or read its screen wherever it runs, answer its permission prompt, move it, take it onto this machine when its own machine is offline, and add or remove a machine. Ask a session to be your CTO or project manager, and it starts and steers the others. A message from one agent names the agent that sent it, so a worker reports back to its CTO when it is done or stuck. An idle agent takes a message at once, wherever it runs. `anyhost tell <session> [text]` and `anyhost new <machine> <folder> [prompt]` do the same from a terminal.
- **The anyhost pane of the Herdr app** takes the place of its Agents list: every session of every machine, the ones that need you first, with search, the working ones on a shelf, and the ones you settled on another. Clicking a session shows its terminal when it runs, else opens it in the space of its project, here or on the machine that holds it, and **Move** sends it to another machine. **Settle** puts a session away on every machine, and a session idle for 7 days settles by itself, which the clock on the Settled shelf changes or turns off. The pen starts a session in a project you pick, on this machine or the one you picked last. A session with no message yet stays off the list, as in Claude Code's `/resume`. anyhost installs the pane into the Herdr app at each start, and makes every Claude Code the Herdr app starts run under `anyhost run`, which ends an idle Claude Code's process after 15 minutes and starts it again as you open the session or a message comes, so many open sessions cost nothing and none ever looks asleep.
- **`/move <machine>`** in a Claude Code session, or **`anyhost move <session> <machine>`** in a terminal, moves a session this machine runs to another of your machines, which runs it in a terminal of herdr-core from then on, with the same Claude Code command and flags. anyhost waits for the session's turn to end and refuses each prompt meanwhile, uploads everything of the session, and the other machine takes the session, puts back its files and code as `anyhost resume` does, and starts it. Then the session's Claude Code here ends, and the Herdr app on any machine shows the session where it runs now. When the other machine is offline before it took the session, or cannot take it, the session keeps running here, and its toast says why. Once the other machine took the session, the move waits for it however long it stays offline, as it may run the session already. When another machine takes the session during the move, the move ends and the session continues there. Until the other machine answers, **Keep it here** in the session's toast keeps the session here. A move `anyhost move` started shows that toast in the session at its next prompt, and Ctrl-C ends only `anyhost move`, not the move. The move says it moved once the session's Claude Code here has stopped, and says why when it could not stop it. A folder Claude Code trusts here is trusted there too, so the session starts in a repository that machine never opened.
- **`anyhost new <machine> <folder> [prompt]`** starts a new session on a machine, this one too, in its checkout of the repository `<folder>` is in, cloned on the same branch when it has none, and trusted there when Claude Code trusts `<folder>` here, in a terminal of herdr-core that the Herdr app shows, and types `prompt` into it as its first message.
- **A session another machine resumed** answers each prompt you type with `This session continues on <machine>.` Resume it where you are with `anyhost resume <session> --take`. A session only the machine it started on has written needs no `--take`. The relay tells the machine that held the session at once, so it refuses its next prompt. A machine whose anyhost was not connected hears it the moment it connects again, before it uploads anything, and the session you resumed shows a toast that names that machine, which may take one more prompt meanwhile.
- **`/machines`** in Claude Code lists every machine joined to your relay, whether it is connected or when it was last seen, and adds a machine or removes one. `anyhost machines` prints the same list, `anyhost machines --invite` the command that joins one more machine, and `anyhost machines --remove <machine>` removes one. A removed machine stops uploading at once, forgets its relay login, so `anyhost doctor` there says it is not joined, and shows the step again, and the sessions it wrote stay listed and resumable from every other machine. It joins again with a new invite.
- **`anyhost doctor`** checks that this machine joined your relay, that the relay answers the protocol this anyhost speaks, this machine's id, the program, and herdr-core, and prints the fix for each problem.

A virtual machine cloned from another keeps its machine id, so both would write as one machine. While the original is connected, the relay refuses the clone, and anyhost captures nothing there and shows the fix: on Linux `sudo rm /etc/machine-id && sudo systemd-machine-id-setup`, then a restart. A machine you renamed keeps its id and connects under its new name.

anyhost uploads a session once one of its files changes while anyhost runs, every file from its first byte, so a running session, and an old one you resume, upload whole. It never reads the old sessions you leave alone.

anyhost uploads each session at most once every 5 seconds, with everything it wrote since its last upload. **Upload every** in `/config` (the option `uploadEvery`) sets those seconds, and `0` uploads every write as it happens, about a second after it. The program reads a change within a minute.

Every upload of a session is one write request to R2, and R2's free tier holds 1,000,000 of them a month. The uploads of all the sessions one upload round carries travel to the relay as one message on the machine's connection. On a Mac that runs Claude Code all day, uploading every write took 1,258,076 uploads in 30 days, about $1.16 over the free tier, and the 5-second default takes 411,952.

## How it works

The bucket holds:

```text
sessions/<device id>/index.json                 every session the machine wrote: title, first prompt, entrypoint, folder, repository, last activity
journals/<session>/hot/<start>.zst              one upload of the session: what its files gained, at byte <start> of its journal
journals/<session>/sealed/<start>-<end>.zst     the uploads of a session that went quiet, up to 64 MiB each
```

The relay's Durable Object keeps your machines, with each one's name, os, arch and home, Claude Code, Claude Code temp and Codex folders as it last connected, when it was removed, and which machine holds each session.

- A session's journal is every byte its files gained, in order, shared by every machine that holds the session in turn. Each upload is one zstd frame of records: the file's path, where in the file the record starts, its bytes, and the file's size and sha256 after it. A file the session deleted gets a record that says so. Replaying the records rebuilds every file, whether it grew, was written once, was rewritten, or is gone.
- The program hears each write from the operating system, puts its session on the upload queue, and every 5 seconds uploads what each queued session's files gained since its last upload, one upload in flight per session. A failed upload tries again at the next one. Every 60 seconds it also checks the files of the sessions that wrote in the last 10 minutes for a change it missed, and at its start and once an hour every file it captured, so a session you left alone costs nothing in between.
- After an upload that changed a session, the program reads the session's working folder with git in the background and uploads its code in the uploads after, so an upload never waits on git. At **Upload every** `0` a large part goes up in 128 KiB pieces, 4 at a time, between your lines, so a line reaches R2 in about a second while the code goes up, and a failed upload tries again after 1 second, then less often, up to once a minute. A working folder missing on the machine gets one line in the program's log, and the session's other files still upload.
- A session quiet for 10 minutes is sealed: its uploads become frames of up to 64 MiB, which are never written again. When R2 lost part of a session's uploads, the program uploads every file of the session whole again from there, once, so a restore reads all of it. A move does the same before the other machine restores the session, and keeps the session running here when that leaves a hole. When the session's transcript is gone from the machine too, `anyhost doctor` names the part a restore lacks.
- `anyhost resume` downloads the session's frames up to 1 MiB of them a request, 16 requests at a time, replays them, checks each file's size and sha256 against its last record, and only then puts the files in place, with each machine's paths rewritten to this machine's. This machine then continues the same journal.
- Each upload claims its place in the journal, and the relay refuses an upload of a session another machine holds. When two machines write the same place, one write wins, and the other machine stops uploading the session and logs that its lines from there are a fork.
- Each machine keeps one connection to the relay, which carries its uploads, its reads and the relay's messages, and opens again at once when it drops. An upload larger than 1 MiB goes beside it, straight into the bucket. When the relay cannot be reached, the program keeps every change, and the first upload after the connection is back carries all of it.
- A session's screen and keys never cross the relay: herdr-core runs the session's terminal, and the Herdr app and Herdr mobile reach it through herdr's own connection to that machine.
- No machine keeps a copy of another machine's sessions. `anyhost list` reads one index per machine, and `anyhost resume` downloads only the session it resumes.
- The program keeps what it uploaded of each file in `~/.local/state/anyhost/anyhost.db`.

## Documentation

- [Releasing](docs/releasing.md): publish a version

## License

[MIT](LICENSE)
