# vivarium-helper-linux

The Linux counterpart of `helper/macos`. Instead of capturing windows of the desktop, it **is**
the display server for the apps in your tiles: a small, headless Wayland compositor (Rust,
[Smithay](https://github.com/Smithay/smithay) 0.7). Apps launched through it connect to its
Wayland socket; every xdg toplevel becomes one tile. Each window is composited into its own
shared-memory frame that the plugin reads pixel-exactly (no video encoding), and input comes back
from the plugin as JSON.

It never opens a window of its own, so it runs the same under an X11 or a Wayland desktop session,
and needs no permissions. When there is a GPU render node it lets apps render on the GPU
(linux-dmabuf, see "GPU" below).

Status: **M1**: used by the plugin (`src/linuxwindow.ts`): app tiles on Linux, a daemon that
outlives Obsidian, apps restarted after a logout/reboot, GPU-rendered clients.

## Build and run

Ubuntu 26.04 (x86_64 or arm64):

```sh
sudo apt install cargo rustc pkg-config libxkbcommon-dev libgbm-dev   # build
sudo apt install libxkbcommon0 xkb-data libgbm1 libegl1                # run (already on any desktop)
cd helper/linux
cargo build --release --locked
```

`scripts/update.sh` does this for you on Linux when `cargo` is installed. The binary is
`target/release/vivarium-helper-linux` (~2.7 MB, stripped); the build copies it into the plugin
folder as `vivarium-helper-linux-<process.arch>` (`-x64`, `-arm64`), where `src/helper.ts` finds
it. No GPU wanted, or no libgbm-dev: `cargo build --release --locked --no-default-features`
(clients then always render into shared memory).

Rust ≥ 1.85 (Ubuntu 26.04 ships 1.93). Native dependencies: libxkbcommon and libgbm (dynamically
linked), libEGL (loaded at runtime, only if there's a render node). Everything else is Rust
(Smithay's pure-Rust Wayland server, no libwayland). Nothing is arch-specific. Checked:
linux/arm64 natively, and linux/amd64 under emulation (`docker build --platform linux/amd64`):
it builds, the unit tests pass, and the foot scenario of the harness passes.

## Daemon: apps outlive Obsidian

The apps in your tiles are clients of this compositor, so whatever ends the helper ends them. The
plugin therefore doesn't spawn it as a child but talks to it as a **daemon**, like tmux:

```
vivarium-helper-linux --listen $XDG_RUNTIME_DIR/vivarium-helper-<vault hash>.sock
```

- The plugin connects; if nobody answers it starts the daemon (detached, log in
  `~/.vivarium/helper.log`) and connects. Same protocol as on stdio, over the socket.
- **One client at a time**: a new connection replaces the old one (Obsidian restarted, plugin
  reloaded). Without a client, every window is hidden: no frames, no frame callbacks, so apps idle.
  On connect the daemon sends `ready` and then `window_added` (+ `frame_buffer`) for every window.
- Window ids restart at 1 in every daemon run; `ready`/`hello` carry an `instance` id, and the
  plugin only trusts a remembered window id from the same instance. Windows also carry a `tag`:
  `VIVARIUM_TILE` from the environment of the app's process (or its nearest ancestor that has it).
  The plugin launches every app with its tile's id there, so a tile finds its window again by tag.
- SIGTERM/SIGINT end it (frame files and socket removed, apps lose their display); SIGHUP is
  ignored. With no client, no windows and no running apps for 2 minutes it exits by itself
  (`VIVARIUM_IDLE_EXIT=<seconds>` to change).
- When a user systemd is running, the plugin starts it in its own transient scope
  (`systemd-run --user --scope`), so it isn't part of Obsidian's cgroup: quitting Obsidian, or a
  desktop that cleans up an app's leftover processes when the app quits, doesn't take it along.

**What survives what**

| | daemon + apps | what the tiles do |
|---|---|---|
| Obsidian quits / reloads the plugin | keep running (frames pause) | re-attach to the same windows on the next start |
| Daemon crashes or is killed | gone | reopen their apps (start a new daemon) |
| Log out, then back in | gone: logging out ends the user's processes (systemd stops `user@.service` once your last session ends) | Vivarium reopens the apps of tiles that had a window open, at startup, before you open their canvas. Your app's own session restore brings back its state (Firefox: tabs). |
| Log out with `loginctl enable-linger` | the user manager stays, and with it the daemon's scope: apps keep running | re-attach as after an Obsidian restart. (Some desktops kill everything of your session on logout regardless: `KillUserProcesses=yes` in logind.conf.) |
| Reboot | gone | reopen their apps, as after a logout |

A tile you closed (its app quit or its window was closed while Vivarium watched) is remembered as
closed and doesn't come back by itself; it shows "Open".

After updating the helper binary, a running daemon keeps the old version until it exits:
`pkill -f 'vivarium-helper-linux.*--listen'` (that closes the apps in your tiles).

## GPU

With a render node (`/dev/dri/renderD*`, override with `--render-node` or
`VIVARIUM_RENDER_NODE`, disable with `--no-gpu`/`VIVARIUM_NO_GPU=1`) the helper creates an EGL
display on it (GBM) and a GLES renderer, and advertises `zwp_linux_dmabuf_v1` (v4 feedback with
that node as main device). Clients' EGL/Vulkan then allocate their buffers on the GPU and render
there instead of in Mesa's software rasterizer. On commit, a dmabuf buffer is imported
(EGLImage, cached per buffer) and only its **damaged** rectangles are read back (glReadPixels
through a pixel buffer object, Smithay's `ExportMem`) into a CPU copy of that surface, which then
takes the shm buffer's place in the normal compositor: frames, damage and the plugin side are
unchanged. The readback is the price of handing frames to another process (Electron's WebGL can't
import dmabufs); it costs about a memcpy of the damaged area, against rasterizing the whole window
on the CPU.

`hello`/`ready` report `gpu: {enabled, device, dmabuf, imports, readbackPx, readbackUs, failures}`.
No render node (VMs, containers): no dmabuf global; clients use shm as before.

`VIVARIUM_GPU=software` uses Mesa's software EGL device instead and sends *shm* buffers through the
same GL import + readback (there's no device to allocate dmabufs on): that's how the GL path is
tested without a GPU (`test/gpu-check.mjs`: frames must be identical to the CPU path).

Try it by hand (stdin closes → helper exits, so keep it open):

```sh
(echo '{"id":1,"op":"launch","command":"gtk4-demo","width":1280,"height":800}'; sleep 600) \
  | target/release/vivarium-helper-linux | xxd | head
```

### Test in Docker (what M0 was measured with)

```sh
helper/linux/scripts/docker-test.sh          # build + unit tests + test/harness.mjs, all apps
helper/linux/scripts/docker-test.sh shell    # poke around
HARNESS_ARGS="--app foot" helper/linux/scripts/docker-test.sh
```

The image is Ubuntu 26.04 with gtk4-demo, gtk3-demo, foot and Node 22. The harness writes PNGs
of the frames plus `summary.json` to `test/out/`.

More tests:

```sh
helper/linux/scripts/test-daemon.sh   # daemon mode with the plugin's real client (src/helper.ts)
helper/linux/scripts/test-e2e.sh      # real Linux Obsidian (Xvfb) + plugin + daemon + foot, over CDP
# in the image: node test/gpu-check.mjs [app…]   GL import/readback path vs CPU path, pixel-exact
```

`test-e2e.sh` checks that a `.window` tile shows its app, follows the card's size, gets your
typing, re-attaches to the *same* app after Obsidian quits and starts again, reopens the app after a
"logout" (Obsidian and daemon killed), and stays closed once you closed the app. Screenshots in
`test/out/e2e/`.

Options: `--listen PATH` (daemon), `--no-gpu`, `--render-node PATH`, `--socket NAME` (default: first free `wayland-N` in `$XDG_RUNTIME_DIR`), `--fps N`
(frame-callback rate, default 60), `--xkb-layout/--xkb-variant/--xkb-options/--xkb-model`
(also `VIVARIUM_XKB_LAYOUT`, `VIVARIUM_XKB_VARIANT`, `VIVARIUM_XKB_OPTIONS`; default `us`).

## How it works

- **Globals**: `wl_compositor`, `wl_subcompositor`, `wl_shm` (ARGB8888/XRGB8888 only), `xdg_wm_base`
  (toplevels + popups, with popup grabs), `zxdg_decoration_manager_v1` (always server-side: the
  tile has the title bar), `wl_seat` (pointer + keyboard), `wl_output` + `xdg_output` (one
  3840×2160 virtual output, scale 1), `wl_data_device_manager` (clipboard *between apps in the
  helper*), `wp_cursor_shape_manager_v1`, and `zwp_linux_dmabuf_v1` when there's a render node
  (see "GPU"; otherwise every client renders into shm).
- **Tiles look like tiles**: toplevels are configured as tiled on all four edges, so GTK/libadwaita
  drop their shadows and rounded corners, and with no maximize/minimize capabilities GTK hides
  those buttons. The frame is the xdg window geometry, so client-side shadows are cropped anyway.
- **Compositing** is a plain CPU blit of the shm buffers into the window's frame (copy for the
  bottom surface, premultiplied src-over for subsurfaces and popups above it). Popups are
  constrained to the window's own rectangle, so menus are part of the tile's frame. Only damaged
  areas are redrawn, tracked per slot (buffer age), and the damage reported to the plugin is
  shrunk to the pixels that really differ from the frame it already has (see "Measurements" for
  why).
- **Pacing**: frame callbacks are the apps' clock. A visible window gets one per tick (≤ `--fps`)
  once the plugin has acked its previous frame; a hidden window gets none, so well-behaved apps
  stop drawing entirely. The tick timer only runs while somebody waits for a callback.
- **Input**: pointer events are delivered to the surface under the point (popups first);
  keyboard input goes to the focused window (a button press focuses + activates it) through an
  xkb keymap. `KeyboardEvent.code` → evdev keycode is a fixed table (`src/keymap.rs`).

## Protocol

Same framing as the macOS helper:

- plugin → helper: one JSON object per line on stdin (daemon: on the socket). A request with an
  `id` gets exactly one reply `{id, ok: true, ...}` or `{id, ok: false, error}`; without `id`
  it's fire-and-forget (use that for input and `frame_ack`).
- helper → plugin: `[u32 BE length][u8 type][payload]` on stdout (daemon: on the socket), length = 1 + payload length.
  Type 1 = JSON (replies and events; events have `ev`). Type 3 = frame ready (binary, below).
  Type 2 (H.264) is macOS-only.

### Requests

| op | params | reply |
|---|---|---|
| `hello` | | `{platform: "linux", version, socket, instance, pid, gpu, permissions: {screen: true, accessibility: true}}` (`instance`: random per helper run, window ids are only meaningful with it) |
| `launch` | `command` (shell string) **or** `argv: [...]` **or** `desktopId` (e.g. `"org.gnome.TextEditor"`); optional `env: {K: V \| null}`, `cwd`, `width`, `height` (initial size of the app's first window) | `{pid}` |
| `list_apps` | | `{apps: [{name, desktopId, bundleId (= desktopId), exec, icon}]}` from the XDG `.desktop` dirs (incl. flatpak exports) |
| `list_windows` | optional `pid` | `{windows: [{windowId, pid, app, appId, bundleId, title, width, height, onScreen, tag}]}` (`app`/`bundleId` = xdg app_id, `onScreen` = visible flag, `tag` = `VIVARIUM_TILE` of the app's process or its nearest ancestor, else null) |
| `set_visible` | `windowId, visible` | `{}`. Default for new windows: visible (daemon without a client: hidden). Mark windows that no tile shows as hidden. Becoming visible always re-sends `frame_buffer` and then yields a full frame. |
| `frame_ack` | `windowId, seq` | (send without `id`) The plugin is done reading frame `seq`. The helper publishes nothing new for that window until then. |
| `resize` (alias `set_frame`) | `windowId, width, height` | `{}`; xdg configure; the next frames come at the new size |
| `close` | `windowId` | `{}`; xdg close (the app may ask to save first) |
| `focus` | `windowId` (omit/null = none) | `{}`; keyboard focus + "activated" look |
| `mouse` | `windowId, kind: "move"\|"down"\|"up"\|"drag"\|"leave", x, y, button` | x/y in frame pixels (top-left of the frame), `button` in DOM numbering (0 left, 1 middle, 2 right, 3 back, 4 forward). `down` also focuses the window. `drag` = `move`. `leave`: the pointer left the tile (no surface hovered). |
| `click` | `windowId, x, y, button, clicks` | down+up, `clicks` times |
| `scroll` | `windowId, x, y, dx, dy` | pixels, DOM sign (positive dy = scroll down), sent as wheel axis events |
| `key` | `code` (DOM `KeyboardEvent.code`), `down`, optional `windowId` (focuses it first) | Modifiers are keys too: send ShiftLeft etc. down/up like any other key. **Drop DOM auto-repeat (`e.repeat`)**: clients repeat by themselves. On blur, send `down:false` for keys still held. |
| `set_keymap` | `layout, variant, model, options` (xkb names) | `{}` |
| `stats` | `windowId` | counters used by the harness (`commits, frames, composeUs*, composedPx, reportedPx, commitToPublishUs*, …`) |

### Events (type 1, `ev`)

| ev | fields |
|---|---|
| `ready` | `platform, version, socket, instance, pid, gpu` (first message after start; daemon: first message on every connection, followed by `window_added` + `frame_buffer` for the windows that already exist) |
| `window_added` | `windowId, pid, app, appId, bundleId, title, width, height, onScreen, tag, parentId?` (a toplevel mapped its first buffer; `parentId` for dialogs) |
| `window_removed` | `windowId` (destroyed or unmapped; an unmapped window that maps again comes back with a new `window_added`, same id) |
| `title_changed` | `windowId, title, appId` |
| `frame_buffer` | `windowId, path, bytes`: (re)open this file for the window's frames. Comes before the first frame and whenever the file is replaced (it grows when the window outgrows it; the old one is unlinked). |
| `cursor` | `windowId, name`: CSS cursor name (`default`, `text`, `pointer`, `ew-resize`, …, `none`) |
| `app_exited` | `pid, code` (a process started with `launch` ended) |

### Frame ready (type 3)

Big-endian like the rest of the framing:

```
u32 windowId
u32 seq        +1 per published frame of this window
u32 width      frame size in pixels
u32 height
u32 stride     bytes per row (= width * 4)
u64 offset     byte offset of row 0 in the window's frame file
u16 format     0 = BGRA8, premultiplied alpha (wl_shm ARGB8888 memory order)
u16 nrects
nrects × { u32 x, u32 y, u32 w, u32 h }   what changed since the previous frame of this window
```

Binary because it is the one hot message (up to 60/s per visible window): the plugin parses it
with `readUInt32BE` on the chunk it already has, no `JSON.parse` and no garbage per frame.

### Frame file

`/dev/shm/vivarium-<helperPid>-w<windowId>-<generation>` (falls back to `$XDG_RUNTIME_DIR`),
mode 0600, removed when the window goes and when the helper exits (files of crashed helpers are
swept at the next start).

```
0     "VVFB"   u32 version=1   u32 format   u32 front slot      (little-endian header,
16    u64 slot0 offset   u64 slot1 offset   u64 slot capacity    informational; the
40    u32 seq   u32 width   u32 height   u32 stride              message is authoritative)
4096  slot 0: height rows of stride bytes
4096 + capacity: slot 1
```

**No torn frames, no locks**: the helper alternates between the two slots and only writes the
slot that is not the last published one. It publishes the next frame of a window only after
`frame_ack` for the previous one, so while the plugin reads slot A, the helper can only be
writing slot B. Rows are tightly packed, so the damaged rows of a rect are one contiguous range.

### Plugin read path (what `src/linuxwindow.ts` and `test/harness.mjs` do)

```js
// on frame_buffer: fd = fs.openSync(path, "r")
// on frame ready:
for (const [x, y, w, h] of rects)            // reused Buffer of width*height*4 per window
  fs.readSync(fd, pixels, y * stride, h * stride, offset + y * stride);
helper.send("frame_ack", { windowId, seq });  // right after reading, before uploading
gl.texSubImage2D(... rows y..y+h ...)         // BGRA: swizzle in the shader (.bgra), premultipliedAlpha
```

Reading whole rows keeps it one syscall per rect; columns outside `x..x+w` are unchanged
anyway. Ack as soon as the bytes are in your Buffer (not after drawing) to keep the pipeline
full. Every frame must be acked, also for tiles that are hidden or being torn down, or that
window stops updating.

## Measurements

M0, Docker linux/arm64 on an Apple-silicon Mac (8 vCPUs, shared with another busy container,
load ≈ 11, so latencies are pessimistic). Frames are 1280×800. `test/out/summary.json` has the
full numbers after a run.

| | foot | gtk3-demo | gtk4-demo (cairo) | gtk4-demo (GL → llvmpipe) |
|---|---|---|---|---|
| launch → first frame | 53 ms | 466 ms | 198 ms | 2471 ms |
| key → frame_ready, median / p95 | 3.7 / 15 ms | 23 / 40 ms | 26 / 45 ms | 32 / 50 ms |
| helper compose per frame (avg) | 0.9 ms | 1.2 ms | 1.35 ms | 1.3 ms |
| idle, visible: helper / app CPU | 0 / 0 % | 0 / 0 % | 0 / 0 % | 0 / 0 % |

- Hidden costs nothing: a terminal printing continuously (`foot-busy`) runs at 56 fps with the
  helper at 9.7 % CPU; hidden, it gets 0 frames and the helper drops to 0 % (foot's own CPU stays
  ~45 %: it still parses the shell's output, it just stops drawing).
- Plugin read path (Node 22, `fs.readSync` into a reused Buffer): full 1280×800 frame 1.15 ms
  median, 2.6 ms p95 (3.5 GB/s); a 40-row damage band 0.013 ms. `readFileSync` of the whole file
  is 2.4 ms: don't.
- Blit routines (`cargo test --release -- --ignored --nocapture bench`): 1280×800 memcpy 0.24 ms,
  XRGB copy 0.24-0.5 ms, src-over blend 3-4 ms (only popups/subsurfaces blend).
- GTK4 damages its whole surface on every frame (both renderers). Diffing against the front slot
  (only for rects covering ≥ half the frame) costs ~0.7 ms and cuts what the plugin reads and
  uploads 10× (gtk4-demo: 144 M composited px → 15 M reported px).

## App compatibility notes

- `launch` sets `WAYLAND_DISPLAY` to our socket, `GDK_BACKEND=wayland`, `QT_QPA_PLATFORM=wayland`,
  `MOZ_ENABLE_WAYLAND=1`, `SDL_VIDEODRIVER=wayland`, `ELECTRON_OZONE_PLATFORM_HINT=wayland`,
  `XDG_SESSION_TYPE=wayland`, and removes `DISPLAY`, so nothing can fall back to the desktop's X
  server. Apps start in their own session (`setsid`).
- Keep the default socket name (`wayland-N`): snap's `wayland` interface only allows sockets
  matching `$XDG_RUNTIME_DIR/wayland-*`. Flatpak picks up `WAYLAND_DISPLAY` from `flatpak run`'s
  environment.
- **Single-instance apps** hand the request to an instance that already runs on the desktop
  and exit, so no window appears here: GApplication apps (most GNOME apps, via D-Bus),
  gnome-terminal (D-Bus activated server), Firefox (remoting: use
  `firefox --new-instance --profile <dir>`), Chromium/Electron (profile lock: use
  `--user-data-dir=<dir>`). A per-helper D-Bus session bus would fix the GApplication case but
  cut apps off the desktop's portals/keyring; still to decide. The plugin has a per-app launch
  hook for this (`setLaunchHook` in `src/linuxwindow.ts`). Firefox tiles use it (`src/firefox.ts`):
  `--no-remote --profile <a clean Vivarium-owned profile>` (`~/.vivarium/firefox-profile`; snap:
  `~/snap/firefox/common/vivarium-profile`; flatpak: `~/.var/app/org.mozilla.firefox/vivarium-profile`),
  created on first launch, session restore on. Nothing is copied from your own profile. Being one
  profile with `--no-remote`, only one Firefox tile can run at a time (a second one gets Firefox's
  "already running" message).
- **No render node → no GPU** for clients: Mesa falls back to llvmpipe (software GL) for GL/Vulkan
  clients. GTK4's default GL renderer then works but costs more than its cairo renderer (see the
  report); `env: {GSK_RENDERER: "cairo"}` on `launch` is the cheap option there.
- X11-only apps don't run (no Xwayland yet).

## Known gaps

- HiDPI: the output is scale 1, so on a 2× screen tiles are drawn at half resolution and
  scaled up (needs output scale 2 / fractional-scale-v1 + viewporter, frame in device pixels).
- Popups are constrained inside the window (menus can't extend beyond the tile).
- The dmabuf path is only tested here with a software EGL device and shm buffers (no render node
  in Docker): it needs a real GPU run. Readback is synchronous per commit; a frame-delayed PBO
  pipeline could hide it on slow GPUs.
- Closing a tile closes its window (`close`); an app that then asks "save changes?" shows that
  dialog in a window without a tile.
- Xwayland for X11-only apps, clipboard bridge to the desktop, text-input/IME, drag and drop,
  touch, `xdg_activation`, presentation-time.
