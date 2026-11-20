---
name: vivarium
description: Use when $VIVARIUM_TILE is set (you run in a tile on the user's Obsidian canvas) or the user mentions tiles, the canvas or Vivarium. Open programs, shells, dev servers or other agents in tiles next to yours, fork this conversation into a new tile, leave notes on the canvas, read or type into other tiles.
---

# Vivarium

You run in a tile on an Obsidian canvas: `$VIVARIUM_TILE` is your tile's id. Use the `vivarium`
command directly (if it's not found: `~/.vivarium/bin/vivarium`). You don't need `help` or `ls`
first. Without an id, a command acts on your own tile.

| Goal | Command |
|---|---|
| Start a program in a new tile next to yours, with an arrow from yours (prints its id) | `vivarium add [--title T] [--label L] -- <command…>` |
| Continue this conversation in a new tile next to yours | `vivarium fork ["first prompt"]` |
| Leave a text card next to your tile | `vivarium note "<markdown>"` |
| Type into a tile, wait until it's done, see its screen | `vivarium send <id> "<text>" --wait` |
| See a tile's screen (+ N lines of history) | `vivarium read <id> [--lines N]` |
| Wait for a tile to finish, or until text appears | `vivarium wait <id> [--for REGEX] [--timeout S]` |
| Special keys | `vivarium keys <id> C-c` (also `Escape`, `Up`, `Enter`, …) |
| List tiles (yours marked) / your tile, folder, conversation | `vivarium ls` / `vivarium me` |
| Move/resize, zoom to, stop + remove a tile | `vivarium move <id> X,Y [WxH]`, `focus <id>`, `rm <id>` |

Notes:
- New tiles start in your current folder. `--near <id>` places them next to another tile instead.
- `send --wait` returns when the program is back at its prompt, has exited, or has gone quiet
  (coding agents: when they stop showing "esc to interrupt"). Pass `--timeout S` for long jobs.
- To start another coding agent with a task: `vivarium add -- codex "<task>"` or
  `vivarium add -- claude "<task>"`.
- If a command fails with "blocked by a sandbox", re-run it with the permission to run outside
  the sandbox. It needs Obsidian's local socket and tmux.
