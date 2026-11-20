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
                           ├─► Web tile       <webview> (Obsidian's Chromium)
                           │
                           └─► App tile       native helper
                                 macOS: ScreenCaptureKit → H.264 → WebCodecs; windows on a
                                        CGVirtualDisplay "stage", real window comes forward on click
                                 Linux: Vivarium's own Wayland compositor (Rust, Smithay); frames in
                                        shared memory → WebGL; input goes into the tile
```

A tile is a file in the vault (`.term`, `.web`, `.window`) shown on a canvas as a file card. The
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
(setting "Keep programs running when you log out", on by default). This only helps if you also run
`loginctl enable-linger` once.

## Agents

Every tile has `vivarium` on its PATH (`~/.vivarium/bin`, also linked into `~/.local/bin`) and
`$VIVARIUM_TILE` set to its own id. The plugin installs a `vivarium` [skill](https://agentskills.io)
into `~/.agents/skills` (Codex and other harnesses) and `~/.claude/skills` (Claude Code). Until an
agent uses it, it costs one line of context. You can turn this off in the settings.

The CLI talks to Obsidian over a local socket and to tmux, so Codex's sandbox blocks it and Codex
asks each time. The setting "Codex: no sandbox prompts for safe commands" writes
`~/.codex/rules/vivarium.rules`, which lets `ls me read wait note fork move focus` run without
asking. `add send keys rm` still ask, since they start or drive programs.

Run `vivarium help` for all commands.

## App tiles

On macOS the real window sits on an invisible virtual display and is streamed into the tile. Click
the tile and the real window comes forward over it; click the canvas to send it back. This needs
Screen Recording and Accessibility for Obsidian.

On Linux the app runs inside Vivarium's own Wayland compositor, so it lives in the tile and you use
it there. The compositor keeps running when you quit Obsidian. After a logout or reboot the apps of
open tiles are started again. Firefox runs with its own profile, separate from your normal one.
Details: [helper/linux/README.md](../helper/linux/README.md).

For anything that runs in a browser, web tiles are faster and never switch focus.

## Git and sync

| File | Holds |
|---|---|
| `.term` | `command`, `title`, `cwd` (vault-relative, `~/…`, or absolute) |
| `.web` | the page the tile is for |
| `.window` | which app |

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

| | Terminal | App tile | Web |
|---|---|---|---|
| visible | output drawn | stream at 60 fps when selected, 8 fps otherwise | live |
| off-screen or zoomed far out | output buffered, not drawn; a noisy hidden tile gets its tmux output switched off | stream stopped, last frame kept | not painted, keeps running |
| back on screen | buffer flushed, or repainted from tmux | resumes | instant |

Measured with 30 terminals each printing about 20 coloured lines per second (Obsidian 1.15,
MacBook Air):

| | |
|---|---|
| close-up, panning, zoomed to fit | 60 fps, p95 ≈ 17 ms |
| keystroke to echo | p50 0.6 ms, p95 11 ms |
| semantic zoom with 160 cards | ~60 fps |

## Caveats

- Vivarium uses Obsidian internals that the plugin API doesn't expose (`embedRegistry`,
  `canvas.showCreationMenu`, `canvas:node-menu`, `importData`). An Obsidian update can break them.
- Web tiles use Obsidian's bundled Chromium, which only updates with a new Obsidian installer, not
  with in-app updates. Be careful browsing arbitrary sites in them.
- macOS app tiles use a private API (`CGVirtualDisplay`, also used by DeskPad and BetterDisplay).
- Granting Accessibility to Obsidian lets any Obsidian plugin send input to other apps.
- tmux before 3.8 crashes when a pane is restarted with `respawn-pane` while a control client is
  attached (tmux issue 5498). Vivarium doesn't do that, but other tools on the same tmux server
  could.
