<div align="center">

# Vivarium

**Live programs on your Obsidian Canvas.**<br>
Terminals, coding agents, dev servers and web pages as tiles next to your notes. They keep running
while you pan away, close the canvas or quit Obsidian.

<img src="docs/media/hero.gif" alt="Right-click on a canvas, add npm run dev as a terminal tile, rename it Dev server, then drag in a web tile showing the running app" width="900">

</div>

---

## What it is

Obsidian Canvas is a great place to *think*. Vivarium makes it a place to *work*: put the programs
you're working with next to the notes about them, on one infinite plane.

| Tile | What it is | Feels |
|---|---|---|
| **Terminal** | Any command (`zsh`, `claude`, `codex`, `npm run dev`, `htop`) in a real terminal, backed by tmux | Native: keystroke → echo in **0.6 ms** (p50) |
| **Web** | A real browser page inside the card (`localhost:3000`, docs, dashboards) | Native: direct input, scales with the canvas, Obsidian keeps focus |
| **App window** *(macOS, experimental; Linux in progress)* | Any app's window as a live preview; click it to work in the real window | Live preview at 60 fps; native once clicked |

Plus **semantic zoom**: zoom out and your workspace stays readable. Card headlines and group titles
are kept at screen size, like labels on a map, while live tiles freeze on their last picture.

## Highlights

### Agents can arrange the canvas

Every tile knows who it is (`$VIVARIUM_TILE`), so a coding agent running in one can open programs
next to itself, fork its own conversation into a new tile, leave notes, and read or type into
other tiles. Below, Claude Code (Haiku) gets one prompt: *"Start the dev server in a tile next to
you. Then fork yourself into a new tile and have the fork add a /health endpoint."* It opens the
server beside itself, then forks its own conversation into a new tile, which goes on to write the
endpoint. This is a real run, fast-forwarded while the agents work.

<img src="docs/media/agents.gif" alt="Claude Code in a terminal tile opens a dev server tile next to itself and forks its conversation into a second Claude Code tile, connected by a fork arrow" width="900">

```sh
vivarium add -- npm run dev            # new tile beside me, connected with an arrow
vivarium fork "try it with SQLite"     # continue this conversation in a new tile beside me
vivarium note "Plan: 1) … 2) …"        # text card beside me
vivarium send t3k9x2a "npm test" --wait  # type a command, wait until it's done, print the screen
vivarium read t3k9x2a --lines 50       # what does that program show?
```

Agents need no setup. Every tile has `vivarium` on its PATH (`~/.vivarium/bin`, also linked into
`~/.local/bin`). The plugin installs a `vivarium` [skill](https://agentskills.io) for Codex and
other harnesses that read `~/.agents/skills`, and for Claude Code in `~/.claude/skills`. Agents
pick it up when they're in a tile, and until then it costs them one line of context. You can turn
this off in the settings.

Codex's sandbox blocks the CLI (it needs Obsidian's socket and tmux), so Codex asks before each
use. **Settings → Coding agents → Codex: no sandbox prompts for safe commands** lets
`ls me read wait note fork move focus` run without asking. Commands that start or drive programs
(`add send keys rm`) still ask.

### Big workspaces stay readable

Canvas unmounts card content below ~30% zoom to stay fast, and text cards go blank. Vivarium
replaces them with each card's first heading at a readable size, then hands over to group titles
when cards become specks:

<img src="docs/media/zoom.gif" alt="Zooming out of a workspace from live terminals and a web preview: card headlines stay readable, then group titles; then into another group and back" width="900">

### Things keep running

- **Terminals live in tmux.** Quit Obsidian, reopen it: every program is still running, with its
  scrollback, its screen (including full-screen apps like `vim` and `htop`) and its cursor.
- **Even a reboot or crash is survivable.** Vivarium remembers what each tile was running. When
  Obsidian starts again, those tiles come back by themselves, without you opening their canvas:
  - **Claude Code** resumes *that tile's own conversation* (`claude --resume <session>`), not just the
    latest one, so five agents come back as five agents.
  - **Codex** does the same with `codex resume <session>`.
  - **Other programs** show their previous output, a `── restored after restart ──` divider, and
    start again in the same folder.
  - **Shells** show their previous output and open in the folder you'd `cd`'d to.

  Tiles you stopped on purpose stay stopped. Snapshots of recent output are kept per device in
  `~/.vivarium/snapshots/` (mode 0600), never in the vault.
- **Even tmux crashing is survivable.** If the tmux server dies, Vivarium reconnects and brings
  back what was running the same way.
- **Attach from anywhere:** `tmux -L vivarium attach -t vivarium:<id>`, or `vivarium attach`.
- **Web tiles remember their page** and keep their logins (own browser profile).

## Install

Vivarium isn't in the community plugin directory (yet). Build it from source:

**Requirements:** Obsidian 1.5+ (desktop), Node 20+, `tmux` (`brew install tmux` / `sudo apt install tmux`).
App tiles on macOS additionally need macOS 14+ and the Xcode Command Line Tools.

```sh
git clone git@github.com:Encrux/vivarium.git && cd vivarium
npm run build:helper                       # macOS only, optional: the helper for app tiles
sh scripts/update.sh ~/path/to/your/vault  # builds and installs into the vault
```

Then enable **Vivarium** under Settings → Community plugins. To update later, run
`sh scripts/update.sh` again (it remembers the vault) and turn the plugin off and on.

The `vivarium` CLI and the agent skill install themselves when the plugin loads.

## Using it

**Add a tile.** All of these open the same picker. Type a command, a URL or an app name:

| Where | How |
|---|---|
| Right-click on empty canvas | **Add program…**, next to Canvas's own *Add card / note / media* |
| Canvas toolbar | the `>_` button: click it to open the picker, drag it to drop a tile where you release |
| Command palette | **Vivarium: Add program to canvas…** |
| Hotkeys | each preset (Shell, Claude Code, Codex, htop, …) has its own command you can bind |

**Work in it.** Click a tile to select it, then click or type inside it. Unselected tiles never take
your scroll wheel, so panning a crowded canvas stays smooth. While a terminal has focus, every key
goes to the program (arrows, Ctrl+C, Ctrl+R, …) except Obsidian's own shortcuts: Cmd+… on macOS,
Ctrl+Shift+… on Linux, where Ctrl+Shift+C / V copy and paste, as in other Linux terminals.
Clicking a link in a terminal opens it in your default browser.

**Name it.** Double-click a tile's name (or right-click → *Rename tile…*). Each tile is a small file
in `Vivarium/` (`.term`, `.web`, `.window`). Open it in a tab, embed it in a note with
`![[htop.term]]`, or delete it to stop the program.

**Coding agents.** The *Codex* preset runs `codex --no-alt-screen`, so the tile scrolls through the
conversation like a normal terminal. (Codex's full-screen mode keeps its history to itself; there,
the wheel recalls old prompts.)

**App tiles (macOS).** Pick an app (Safari, Simulator, Figma, …) in the picker. The real window
lives on an invisible virtual display and is streamed into the tile. Click the tile and the real
window comes forward over it, so you use the actual app. Click the canvas to send it back. This
needs **Screen Recording** and **Accessibility** for Obsidian (System Settings → Privacy & Security).
Prefer **web tiles** for anything that runs in a browser: they're instant and never switch focus.

## Vaults in git (or synced)

Committing tiles is safe, and it's a good way to back up your canvases. A tile file is a recipe
(command, title, folder), not the running program:

| File | Holds |
|---|---|
| `.term` | `command`, `title`, `cwd` (vault-relative, `~/…`, or absolute) |
| `.web` | the page the tile is *for* |
| `.window` | which app (bundle id) |

**Nothing runs just because a file arrived.** A terminal tile starts by itself only on a device
where it was created, or where you pressed its **Start** button once. That button shows exactly
what would run and where. If a pull or sync changes a tile's command, it asks again. So a
`git pull`, a shared folder or a compromised sync can't run commands on your machine by putting
tiles in your vault.

Running state never goes into the vault, so committing doesn't produce noise. That includes
scrollback, snapshots, agent sessions, logins and which window a tile shows. All of it stays per
device: in `~/.vivarium/` and Obsidian's local storage. A tile file only changes when you change
the tile. Typing a new address into a web tile *is* such a change, so that one is saved.

Vivarium is built for one machine. On another machine the canvas looks the same, but a coding
agent starts a fresh conversation there. To keep tiles out of git entirely, add to `.gitignore`:

```gitignore
Vivarium/          # tile files (the canvases then show missing-file cards elsewhere)
```

> **Don't put secrets in tiles.** Commands are stored verbatim in `.term` files, and web tiles
> store their URL (watch out for `?token=…` links, e.g. Jupyter). Use your shell's environment
> (`.zshrc`, a secrets manager) instead.

## How it works

```
Canvas file card ─► Embed ─┬─► Terminal tile  xterm.js (DOM renderer) ◄─────────┐
                           │                       │ keys (send-keys)              │ raw bytes
                           │                       ▼                               │
                           │      ONE tmux control-mode client (tmux -C) ─────────┘
                           │                       │
                           │      tmux server (-L vivarium), one window per tile
                           │
                           ├─► Web tile       <webview> (Chromium, in-process with Obsidian)
                           │
                           └─► App tile       WebCodecs H.264 decoder ◄── native helper (Swift)
                                                   ScreenCaptureKit → VideoToolbox (hardware)
                                                   windows parked on a CGVirtualDisplay "stage"
```

**Performance is a feature.** Every tile only costs something while you can see it:

| State | Terminal | App window | Web |
|---|---|---|---|
| visible | output written to xterm | stream at 60 fps (selected) / 8 fps | live |
| off-screen / zoomed far out | raw bytes buffered, nothing parsed or painted; a noisy hidden tile gets tmux output switched off entirely | stream stopped, last frame kept | not painted, keeps running |
| back on screen | flush the buffer, or repaint from a tmux snapshot | resume | instant |

Measured with **30 terminals each printing ~20 coloured lines/s** (Obsidian 1.15, MacBook Air):

| | |
|---|---|
| close-up / panning across the grid / zoomed to fit | **60 fps**, p95 ≈ 17 ms, no long tasks |
| keystroke → echo | **p50 0.6 ms**, p95 11 ms |
| semantic zoom on 160 cards: panning / zooming through all levels | **60 fps** / ~60 fps |

## Platform status

| | macOS | Linux |
|---|---|---|
| Terminal tiles | ✅ | ✅ (Ubuntu 26.04, tmux 3.6a) |
| Web tiles | ✅ | should work; untested |
| App tiles | ✅ experimental | in progress: a native Wayland helper |
| `vivarium` CLI + agent skill | ✅ | ✅ |

Windows isn't supported (no tmux).

## Caveats

- **Uses Obsidian internals** that plugins can't reach through the public API: `embedRegistry`,
  `canvas.showCreationMenu`, `canvas:node-menu`, `importData`. An Obsidian update can break them.
  Each touch point is small and isolated.
- **Web tiles run Obsidian's bundled Chromium,** which only updates when you install a new Obsidian
  release, not with in-app updates. Keep that in mind before browsing arbitrary sites in them.
- **App tiles rely on a private macOS API** (`CGVirtualDisplay`, also used by DeskPad and
  BetterDisplay). Using an app still switches focus to it, as macOS requires.
- **Granting Accessibility to Obsidian** lets any Obsidian plugin post input to other apps.
- **tmux before 3.8 crashes** when a pane is restarted with `respawn-pane` while a control client is
  attached (tmux issue 5498). Vivarium never does that (Restart opens a new window), but other
  tools attached to the same tmux server could.

## Development

```sh
npm run dev            # rebuild on change into dev-vault/
npm run build          # typecheck + build once
npm run build:helper   # rebuild the Swift helper (macOS)
npm run build:helper-linux   # rebuild the Rust helper (Linux; scripts/update.sh does it when cargo is installed)
```

Linux app tiles: `helper/linux/README.md` (daemon, GPU path, what survives logout/reboot), tested
end to end with a real Linux Obsidian in Docker by `helper/linux/scripts/test-e2e.sh`.

Open `dev-vault/` as a vault, or install into another one with `sh scripts/update.sh <vault>`.
Toggle the plugin to reload it. `node scripts/record-demos/record.mjs` re-records the README videos
in an isolated Obsidian instance (macOS). `sh scripts/tmux-crash.sh` prints a stack trace of the latest tmux
crash (Ubuntu). The helper speaks a small JSON-lines / framed-binary protocol over stdin/stdout
(`helper/macos/Sources/VivariumHelper/Protocol.swift`), so a Linux helper can slot in behind the
same plugin code.

---

<sub>Inspired by FlutterFlow's <a href="https://campus.flutterflow.io/">Campus</a>, built on Obsidian's own Canvas.</sub>
