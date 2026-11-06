# Campus for Obsidian

Live program tiles on Obsidian Canvas: shells, Claude Code, Codex, dev servers, `htop`.
They keep running when you pan away, close the canvas or quit Obsidian. Inspired by
FlutterFlow's Campus, built on Obsidian's own Canvas.

Desktop only (macOS/Linux). Needs `tmux` (`brew install tmux`).

## Install (local)

```sh
npm install
npm run build                     # builds into dev-vault/.obsidian/plugins/campus
ln -s "$PWD/dev-vault/.obsidian/plugins/campus" "<your vault>/.obsidian/plugins/campus"
```

Then enable **Campus** under Settings → Community plugins. To put the CLI on your PATH:

```sh
ln -s "$PWD/bin/campus" /opt/homebrew/bin/campus
```

## Adding programs

All of these open the same picker. Type to filter the presets, or type any command and press ↵ to run it:

| Where | How |
|---|---|
| Command palette | **Campus: Add program to canvas…** (placed at the viewport center) |
| Right-click on empty canvas | **Add program…** in Canvas's own menu (placed where you clicked) |
| Canvas toolbar | the `>_` button. Click it to open the picker, or drag it to where the tile should go |
| Hotkeys | each preset gets a command (e.g. **Add Claude Code to canvas**) you can bind a key to |

Presets, the default working directory and the font are in the plugin settings.

## Using tiles

- **Click** a tile to type into it. **Click the canvas** to leave. While a tile is focused it gets
  your keys, wheel and mouse (Space doesn't pan, Backspace doesn't delete the card). `⌘` shortcuts
  such as ⌘P still reach Obsidian.
- **Move** a focused tile by its label or border. Text selection inside a focused tile works at any zoom.
- **Unfocused** tiles never steal the wheel, so you can pan across a crowded canvas freely.
- Each tile is a small `.term` file in `Campus/` (settings → Tile folder). Open it in a tab, or
  embed it in a note with `![[Claude Code.term]]`. Every view shows the same live program.
- Right-click a tile for **Restart program**, **Stop program** and **Copy tmux attach command**.
  Deleting the `.term` file stops its program. **Stop programs whose tile file was deleted** cleans up leftovers.
- With *Keep a shell after the program exits* on (the default), the command is typed into your
  login shell: Ctrl+C gets you a prompt in the same directory, and ↑ runs the command again.

## Agents (`campus` CLI)

Inside a tile, `$CAMPUS_TILE` is that tile's id, so an agent can arrange the canvas around itself:

```sh
campus add -- npm run dev             # new tile beside me, connected with an arrow
campus note "Plan: 1) … 2) …"         # text card beside me
campus read t3k9x2a --lines 50        # what does that program show?
campus send t3k9x2a "npm test"        # type a command (+ Enter)
campus keys t3k9x2a C-c               # send keys
campus ls | move | focus | rm | attach
```

Telling an agent "you're in a Campus tile; run `campus help`" is enough for it to start using this.
Canvas operations go through a private socket (`~/.campus/<vault>.sock`, mode 0600). Program I/O
goes straight to tmux, so `read`, `send` and `attach` work even while Obsidian is closed.

## How it works

```
Canvas file card ──► TermEmbed ──► TerminalSurface (xterm.js, DOM renderer)
                                          │  keystrokes: send-keys -H        ▲ %output (raw bytes)
                                          ▼                                  │
                           TmuxHub: ONE `tmux -C` control-mode client  ──────┘
                                          │
                      tmux server (-L campus), session "campus", one window per tile
```

- **No native modules.** tmux control mode replaces node-pty: output arrives as escaped bytes on
  one pipe, and resizing is a command.
- **Persistence for free.** Programs live in the tmux server. On reopen a tile is repainted from a
  tmux snapshot: history, the screen, full-screen apps like vim, less and TUIs (including the screen
  underneath them), cursor and key modes.
- **Sizes are owned by the plugin** (`window-size manual`): one tile, one size, no fighting with
  other clients.

### Performance model

Tiles only cost something while you can see them:

| State | What happens |
|---|---|
| visible | output is written into xterm |
| off-screen, zoomed out past Canvas's breakpoint, or a background tab | raw bytes are buffered (cap 256 KB); nothing is parsed or rendered |
| hidden and noisy (cap exceeded) | buffer dropped, and tmux stops sending that pane's output entirely |
| shown again | flush the small buffer, or repaint from a tmux snapshot |

- **One process for all tiles.** All tiles share one tmux client, so 30 tiles mean one extra process.
- **DOM renderer.** Text stays crisp at every canvas zoom, and there's no WebGL context limit.
- **Contained layout.** Each tile uses `contain: strict`, so its layout and paint stay isolated from the rest of the canvas.

Measured with 30 tiles, each printing about 20 coloured lines/s (Obsidian 1.15, M-series MacBook Air):

| Scenario | Result |
|---|---|
| close-up (4 live) | 60 fps, p95 17.4 ms, 0 long tasks |
| panning across the grid at 1:1 | 60 fps, p95 17.2 ms |
| zoomed to fit (all 30 on screen, below the breakpoint) | 60 fps |
| zoom sweep through the breakpoint | about 37 fps. The same sweep over 30 plain markdown cards gives about 22 fps, so the cost is Canvas mounting content, not the tiles |
| keystroke → echo | p50 0.6 ms, p95 11 ms |

## Sharing

Live terminals are local by nature. For collaboration, the [Relay](https://relay.md) plugin syncs
`.canvas` files with live cursors. Collaborators see the layout and notes, and each person's
programs run on their own machine. To show someone a running program, `tmux -L campus attach -t campus:<id>`
over SSH works today.

## Caveats

- Uses undocumented Obsidian internals (`embedRegistry`, `canvas.showCreationMenu`, `canvas:node-menu`,
  `importData`). An Obsidian update can break them; each touch point is small and isolated in `main.ts` and `control.ts`.
- Tested on Obsidian 1.15.0 with tmux 3.8 on macOS.

## Development

`npm run dev` rebuilds on change into `dev-vault/`. Open `dev-vault` as a vault and toggle the
plugin to reload it. `npm run build` typechecks and builds once.
