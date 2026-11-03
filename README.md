# anyhost

**Every Claude Code and Codex session of every machine you work on, kept safe in Cloudflare R2 and resumed on any machine.** A dead or busy machine no longer holds your plans and ideas: each session's exact history is in R2 within 30 seconds of each new line, every machine lists every session, and one command continues a Claude Code session on the machine you are on.

```text
$ anyhost list
SESSION                               TOOL    MACHINE    HOLDER     LAST ACTIVITY     REPOSITORY             FOLDER                TITLE           FIRST PROMPT
3f9c2b1e-7a4d-4c55-9b0e-2d8f61a0c7e4  claude  devbox     -          2026-11-03 14:02  heyJordanParker/shop   ~/Developer/shop      Checkout retry  Make the checkout retry a declined card once…
8e41d0aa-52b3-4f1e-a9c6-0b7d3e9f2c11  codex   mac        -          2026-11-03 13:40  heyJordanParker/blog   ~/Developer/blog      -               Draft the post about the release…

$ anyhost resume 3f9c2b1e-7a4d-4c55-9b0e-2d8f61a0c7e4
```

anyhost has two parts:

- **The `anyhost` program**, one copy per machine. It uploads the new bytes of every transcript under `~/.claude/projects` and `~/.codex/sessions` to R2, and answers `anyhost list`, `anyhost resume` and `anyhost doctor`.
- **A Claude Code mod** built with [cmod](https://github.com/heyJordanParker/cmod). It starts the program for the machine and stops a session that continues on another machine from taking prompts.

## Install

You need:

- macOS, or Linux with a machine id in `/etc/machine-id`, on arm64 or x64
- [Claude Code](https://code.claude.com)
- an R2 bucket named `anyhost` in your Cloudflare account, and an R2 API token that can read and write it
- Node.js with npm, or Bun, to install cmod

Give anyhost the R2 token as the AWS profile `r2`. `~/.aws/config` holds the endpoint:

```ini
[profile r2]
endpoint_url = https://<account id>.eu.r2.cloudflarestorage.com
region = auto
```

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

cmod downloads the `anyhost` program from this repository's release, checks it against the release's `SHA256SUMS`, and links it into `~/.local/bin`. Start Claude Code: the mod starts the program, which registers the machine in R2 and uploads every session the machine has. Run `anyhost doctor` to see that each part works.

## Use it

- **`anyhost list`** lists every session of every machine, the most recent first: its id, Claude Code or Codex, the machine it last ran on, the machine that holds it, its last activity, repository, working folder, title, and first prompt. `anyhost list --json` prints the same as JSON.
- **`anyhost resume <session>`** continues a Claude Code session on this machine, also over `ssh <machine> anyhost resume <session>`. It takes the session for this machine, downloads its transcript, finds the session's repository among your checkouts by its git remote or clones it into `~/Developer`, and runs `claude --resume <session>` there. With a herdr server running, it opens the session in a new herdr workspace instead of the current terminal.
- **A session another machine resumed** answers each prompt you type with `This session continues on <machine>.` Resume it where you are with `anyhost resume <session> --take`.
- **`anyhost doctor`** checks the AWS profile `r2`, the bucket, this machine's registration, and the program, and prints the fix for each problem.

A virtual machine cloned from another keeps its machine id, so both would write as one machine. While the original still runs anyhost, anyhost refuses to run on the clone and prints the fix: on Linux `sudo rm /etc/machine-id && sudo systemd-machine-id-setup`, then a restart. A machine you renamed keeps its id too: anyhost takes the new name once the old name has been quiet for 10 minutes, and until then its error names the time to press Retry.

The first start uploads every transcript the machine already has. Sessions you work in keep uploading within 30 seconds while it runs, and the rest goes out in the time left in each pass, about 20 seconds of every 30.

## How it works

The bucket holds:

```text
devices/<device id>.json                          each machine: its name, os and arch
sessions/<device id>/index.json                   every session the machine wrote: title, first prompt, folder, repository, last activity
sessions/<device id>/<session>/<start>-<end>.jsonl bytes [start, end) of the session's transcript
claims/<session>.json                             the machine that holds the session
```

- The program keeps how far it read each transcript in `~/.local/state/anyhost/anyhost.db`, hears file changes from the operating system, and every 30 seconds uploads the whole lines a transcript gained. A session quiet for 10 minutes has its pieces merged into one object.
- No machine keeps a copy of another machine's sessions. `anyhost list` reads one index per machine, and `anyhost resume` downloads only the session it resumes.
- After a resume, the new machine continues the transcript from the byte it downloaded, so the session's history stays one transcript across machines.
- `ANYHOST_BUCKET` names another bucket, such as one for tests.

## Documentation

- [Releasing](docs/releasing.md): publish a version

## License

[MIT](LICENSE)
