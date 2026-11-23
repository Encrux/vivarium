# How Vivarium works

## Overview

```
Canvas file card ─► Embed ─┬─► Terminal tile  xterm.js ◄──────────────────────┐
                           │                       │ keys (send-keys)          │ output
                           │                       ▼                           │
                           │      one tmux control-mode client (tmux -C) ──────┘
                           │                       │
                           │      tmux server (-L vivarium), one window per tile
                           │
                           └─► Web tile       <webview> (Obsidian's Chromium)

vivarium CLI ─► local socket ─► plugin ─► edits the .canvas file (JSON Canvas)
            └─► tmux directly (read, send, keys, wait)
```

A tile is a file in the vault (`.term`, `.web`) shown on a canvas as a file card. The
file holds what to run. Everything about the running program stays on the device.

## Terminal tiles

All terminal tiles share one tmux server (socket `vivarium`) and one control-mode connection.
Obsidian only draws them, so programs keep running when you quit Obsidian, with their scrollback,
screen and cursor. You can attach from any terminal with `vivarium attach` or
`tmux -L vivarium attach -t vivarium:<id>`.

The Codex preset runs `codex --no-alt-screen`, so the tile scrolls through the conversation like a
normal terminal.

## Coming back after a restart

Every 10 seconds Vivarium notes, per tile, whether it's running, what's in the foreground (shell,
coding agent or another program), the shell's folder, and for Claude Code and Codex the tile's own
conversation id. Every 30 seconds it saves recent output to `~/.vivarium/snapshots/` (mode 0600,
never in the vault).

When Obsidian starts after a reboot or crash, tiles that were running start again, without you
opening their canvas:

- Claude Code: `claude --resume <that tile's session>`
- Codex: `codex resume <that tile's session>`
- other programs: previous output, a `restored after restart` divider, then the command again
- shells: previous output, in the folder you were in

Tiles you stopped yourself stay stopped. If the tmux server dies while Obsidian runs, Vivarium
reconnects and restores the same way.

### Logging out (Linux)

A logout ends programs like a reboot, and they come back the same way. Logout kills processes in
no particular order, for example an agent a moment before its shell. So anything that ended within
45 seconds of the last check counts as ended by the logout, and gets restored.

To keep programs running through a logout, Vivarium starts tmux in its own systemd user scope
(setting "Keep programs running when you log out", off by default). This only helps if you also run
`loginctl enable-linger` once.

## Agents

The agent integration is off until you turn it on (Vivarium asks once). Then the plugin installs:

- the `vivarium` command into `~/.vivarium/bin`, linked from `~/.local/bin`. Every tile also gets
  that folder first on its PATH, `$VIVARIUM_TILE` set to its own id and `$VIVARIUM_SOCKET` to the
  plugin's socket.
- a `vivarium` [skill](https://agentskills.io) into `~/.agents/skills` (Codex and other harnesses)
  and `~/.claude/skills` (Claude Code). Until an agent uses it, it costs one line of context.

Turning it off removes them. Files of yours with the same names are never touched.

The command talks to the plugin over a unix socket in `~/.vivarium` (a folder only you can open).
Canvas changes (`add`, `note`, `move`, `rm`) are written to the `.canvas` file through Obsidian's
vault API. An open canvas merges such a change by card id, so the tiles already on it keep running;
Vivarium saves the open canvas first so a change you just made isn't lost. Reading and typing into
tiles (`read`, `send`, `keys`, `wait`) goes straight to tmux.

Codex's sandbox blocks the command, so Codex asks each time. The setting "Codex: no sandbox
prompts for safe commands" writes `~/.codex/rules/vivarium.rules`, which lets
`ls me read wait note fork move focus` run without asking. `add send keys rm` still ask, since they
start or drive programs.

A fork keeps its tile's command-line flags (a model, a sandbox setting) only when an agent forks its
own conversation. Forking another tile's conversation starts without them, with the agent's
defaults, so an agent can't borrow another tile's "no sandbox" flag.

Run `vivarium help` for all commands.

## Obsidian internals

Showing a live tile inside a canvas card has no public plugin API, so Vivarium uses a few
undocumented parts of Obsidian: the embed registry (tiles in cards), the canvas's right-click menu
and card toolbar ("Add program…", the `>_` button), its view position (where a new tile goes, and
zooming to a tile) and its zoom level (semantic zoom). Each is checked before use: if a future
Obsidian changes one, that feature switches off and the rest keeps working. Everything the CLI and
agents change on a canvas goes through the documented `.canvas` file format instead.

## Git and sync

| File | Holds |
|---|---|
| `.term` | `command`, `title`, `cwd` (vault-relative, `~/…`, or absolute) |
| `.web` | the page the tile is for |

A terminal tile starts by itself only on a device where it was created, or where you pressed its
Start button once. The button shows what would run and where. If a pull or sync changes the
command, it asks again. So a pull, a shared folder or a compromised sync can't run commands on your
machine.

Running state never goes into the vault: scrollback, snapshots, agent sessions, logins and which
window a tile shows stay in `~/.vivarium/` and Obsidian's local storage. A tile file only changes
when you change the tile, for example by typing a new address into a web tile.

On another machine the canvas looks the same, but agents start a fresh conversation there. To keep
tiles out of git, add `Vivarium/` to `.gitignore` (canvases then show missing-file cards elsewhere).

Commands are stored as typed and web tiles store their URL, so keep secrets out of both (watch for
`?token=…` links, e.g. Jupyter).

## Performance

A tile only costs something while you can see it:

| | Terminal | Web |
|---|---|---|
| visible | output drawn | live |
| off-screen or zoomed far out | output buffered, not drawn; a noisy hidden tile gets its tmux output switched off | not painted, keeps running |
| back on screen | buffer flushed, or repainted from tmux | instant |

Measured with 30 terminals each printing about 20 coloured lines per second (Obsidian 1.15,
MacBook Air):

| | |
|---|---|
| close-up, panning, zoomed to fit | 60 fps, p95 ≈ 17 ms |
| keystroke to echo | p50 0.6 ms, p95 11 ms |
| semantic zoom with 160 cards | ~60 fps |

## Caveats

- Vivarium uses Obsidian internals the plugin API doesn't expose (see above). An Obsidian update
  can switch those features off until Vivarium is updated.
- Web tiles use Obsidian's bundled Chromium, which only updates with a new Obsidian installer, not
  with in-app updates. Be careful browsing arbitrary sites in them.
- tmux before 3.8 crashes when a pane is restarted with `respawn-pane` while a control client is
  attached (tmux issue 5498). Vivarium doesn't do that, but other tools on the same tmux server
  could.
