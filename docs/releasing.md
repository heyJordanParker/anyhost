# Releasing

A push to `main` that raises the version releases it. The [CI workflow](../.github/workflows/ci.yml) tests the push on macOS and on Linux, then runs `cmod publish`, which builds the `anyhost` program, attaches it to a GitHub release, and points the mod's marketplace at the new version. Claude Code then updates everyone who installed anyhost.

## Release a version

1. Raise `version` in `.claude-plugin/plugin.json`. The `anyhost` program prints the same version, because it reads that file when it is built.
2. Add a `## [<version>] - <date>` section to `CHANGELOG.md` with what changed for the people who use anyhost. `cmod publish` refuses a version without one.
3. Run `bun test`, `bun run --cwd cli check`, `bun run --cwd relay check` and `cmod check .`, then commit.
4. Push to `main`.

CI then:

1. runs `bun run --cwd cli check`, `bun run --cwd relay check`, `bun test` and `cmod check .` on macOS and on Linux, where it first starts the runner user's systemd, which runs each `claude --bg` and `claude attach` in a scope;
2. releases only once both passed, and skips the release when the tag `v<version>` exists, so a push that keeps the version releases nothing;
3. runs `cmod publish .`, which:
   - builds the mod's release from the committed files `package.json` `files` lists, bundles its hooks, and validates it with `claude plugin validate --strict`;
   - runs `bun run build` in `cli/` for every machine `package.json`'s `os` and `cpu` allow, which compiles `anyhost-darwin-arm64`, `anyhost-darwin-x64`, `anyhost-linux-arm64`, and `anyhost-linux-x64` with `bun build --compile`;
   - writes `SHA256SUMS` for the release archive and the program;
   - commits `.claude-plugin/marketplace.json`, tags `v<version>`, pushes the tag and the `release` branch, and creates the GitHub release with every file attached and the version's changelog section as its notes.

## Release from your Mac

With Bun, Claude Code, cmod, and `gh` logged in with push access:

```bash
cmod publish --dry-run .
```

The dry run builds the release into a temporary folder and prints what it would release. It changes no tracked file and pushes nothing. Then:

```bash
cmod publish .
```

## Check a release

```bash
gh release view --repo heyJordanParker/anyhost
cmod update anyhost
anyhost --version
```
