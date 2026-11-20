# Contributing

Issues and suggestions are welcome. This is a personal project, so replies may take a while.

## Building

```sh
npm install
npm run dev                  # rebuild on change into dev-vault/
npm run build                # typecheck + build once
npm run build:helper         # macOS app-tile helper (Swift)
npm run build:helper-linux   # Linux app-tile helper (Rust)
```

Open `dev-vault/` as a vault, or install into another one with `sh scripts/update.sh <vault>`.
Turn the plugin off and on to reload it. `update.sh` remembers the vault, and on Linux it builds
the Rust helper when cargo is installed.

## Layout

| Path | What |
|---|---|
| `src/` | the plugin (TypeScript) |
| `bin/vivarium` | the CLI that tiles and agents use |
| `skill/SKILL.md` | the agent skill the plugin installs |
| `helper/macos/` | app-tile helper for macOS (Swift) |
| `helper/linux/` | app-tile helper for Linux (Rust, Smithay) |
| `scripts/` | install/update, demo recording, crash reports |

Both helpers speak the same protocol with the plugin, see
`helper/macos/Sources/VivariumHelper/Protocol.swift` and `helper/linux/README.md`.

## Testing the Linux helper

Runs in Docker, so it works on macOS too:

```sh
helper/linux/scripts/docker-test.sh   # build, unit tests, app harness (latency, CPU)
helper/linux/scripts/test-daemon.sh   # daemon: reconnects, cleanup
helper/linux/scripts/test-e2e.sh      # a real Linux Obsidian with the plugin and a helper app
```

## Other tools

- `node scripts/record-demos/record.mjs [hero|agents|zoom]` re-records the README videos in an
  isolated Obsidian instance (macOS). The agents demo runs Claude Code for real.
- `sh scripts/tmux-crash.sh` prints a stack trace of the latest tmux crash (Ubuntu) and copies it to
  the clipboard.
