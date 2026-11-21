# Contributing

Issues and suggestions are welcome. This is a personal project, so replies may take a while.

## Building

```sh
npm install
npm run dev     # rebuild on change into dev-vault/
npm run build   # typecheck + build once
npm run lint    # Obsidian's lint rules (the community directory checks the same)
```

Open `dev-vault/` as a vault, or install into another one with `sh scripts/update.sh <vault>`.
Turn the plugin off and on to reload it. `update.sh` remembers the vault.

## Layout

| Path | What |
|---|---|
| `src/` | the plugin (TypeScript) |
| `bin/vivarium` | the CLI that tiles and agents use (bundled into `main.js`, installed by the agent setting) |
| `skill/SKILL.md` | the agent skill the plugin installs |
| `scripts/` | install/update, version bump, demo recording, crash reports |

App tiles (other programs' windows, with native helpers for macOS and Linux) live on the
[`app-tiles`](https://github.com/Encrux/vivarium/tree/app-tiles) branch.

## Releasing

```sh
npm version patch   # or minor / major: updates package.json, manifest.json, versions.json and tags
git push && git push --tags
```

The tag starts the Release workflow, which builds the plugin and creates a draft GitHub release
with `main.js`, `manifest.json` and `styles.css`. Check it and publish it. Obsidian's community
directory picks up new releases from there.

## Other tools

- `node scripts/record-demos/record.mjs [hero|agents|zoom]` re-records the README videos in an
  isolated Obsidian instance (macOS). The agents demo runs Claude Code for real.
- `sh scripts/tmux-crash.sh` prints a stack trace of the latest tmux crash (Ubuntu) and copies it to
  the clipboard.
