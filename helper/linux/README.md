# vivarium-helper-linux

The Linux counterpart of `helper/macos`. Instead of capturing windows of the desktop, it **is**
the display server for the apps in your tiles: a small, headless Wayland compositor (Rust,
[Smithay](https://github.com/Smithay/smithay) 0.7). Apps launched through it connect to its
Wayland socket; every xdg toplevel becomes one tile. Each window is composited into its own
shared-memory frame that the plugin reads pixel-exactly (no video encoding), and input comes back
from the plugin as JSON.

It never opens a window or touches the GPU, so it runs the same under an X11 or a Wayland desktop
session, and needs no permissions.

Status: **M0** (compositor, protocol, test harness). The plugin side (`src/`) does not use it yet.

## Build and run

Ubuntu 26.04 (x86_64 or arm64):

```sh
sudo apt install cargo rustc pkg-config libxkbcommon-dev   # build
sudo apt install libxkbcommon0 xkb-data                    # run (already on any desktop)
cd helper/linux
cargo build --release --locked
```

The binary is `target/release/vivarium-helper-linux` (~2 MB, stripped). `src/helper.ts` looks
for `vivarium-helper-linux-<process.arch>` (`-x64`, `-arm64`) in the plugin folder, next to
`main.js`; copy it there under that name.

Rust ≥ 1.85 (Ubuntu 26.04 ships 1.93). The only native dependency is libxkbcommon (dynamically
linked); everything else is Rust (Smithay's pure-Rust Wayland server, no libwayland). Nothing is
arch-specific; the code is plain safe-ish Rust plus libc calls available on every Linux. Checked:
linux/arm64 natively, and linux/amd64 under emulation (`docker build --platform linux/amd64`):
it builds, the unit tests pass, and the foot scenario of the harness passes.

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

Options: `--socket NAME` (default: first free `wayland-N` in `$XDG_RUNTIME_DIR`), `--fps N`
(frame-callback rate, default 60), `--xkb-layout/--xkb-variant/--xkb-options/--xkb-model`
(also `VIVARIUM_XKB_LAYOUT`, `VIVARIUM_XKB_VARIANT`, `VIVARIUM_XKB_OPTIONS`; default `us`).

## How it works

- **Globals**: `wl_compositor`, `wl_subcompositor`, `wl_shm` (ARGB8888/XRGB8888 only), `xdg_wm_base`
  (toplevels + popups, with popup grabs), `zxdg_decoration_manager_v1` (always server-side: the
  tile has the title bar), `wl_seat` (pointer + keyboard), `wl_output` + `xdg_output` (one
  3840×2160 virtual output, scale 1), `wl_data_device_manager` (clipboard *between apps in the
  helper*), `wp_cursor_shape_manager_v1`. **No linux-dmabuf**: every client renders into shm.
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

- plugin → helper: one JSON object per line on stdin. A request with an `id` gets exactly one
  reply `{id, ok: true, ...}` or `{id, ok: false, error}`; without `id` it's fire-and-forget
  (use that for input and `frame_ack`).
- helper → plugin: `[u32 BE length][u8 type][payload]` on stdout, length = 1 + payload length.
  Type 1 = JSON (replies and events; events have `ev`). Type 3 = frame ready (binary, below).
  Type 2 (H.264) is macOS-only.

### Requests

| op | params | reply |
|---|---|---|
| `hello` | | `{platform: "linux", version, socket, permissions: {screen: true, accessibility: true}}` |
| `launch` | `command` (shell string) **or** `argv: [...]` **or** `desktopId` (e.g. `"org.gnome.TextEditor"`); optional `env: {K: V \| null}`, `cwd`, `width`, `height` (initial size of the app's first window) | `{pid}` |
| `list_apps` | | `{apps: [{name, desktopId, bundleId (= desktopId), exec, icon}]}` from the XDG `.desktop` dirs (incl. flatpak exports) |
| `list_windows` | optional `pid` | `{windows: [{windowId, pid, app, appId, bundleId, title, width, height, onScreen}]}` (`app`/`bundleId` = xdg app_id, `onScreen` = visible flag) |
| `set_visible` | `windowId, visible` | `{}`. Default for new windows: visible. Mark windows that no tile shows as hidden. Becoming visible always yields a full frame. |
| `frame_ack` | `windowId, seq` | (send without `id`) The plugin is done reading frame `seq`. The helper publishes nothing new for that window until then. |
| `resize` (alias `set_frame`) | `windowId, width, height` | `{}`; xdg configure; the next frames come at the new size |
| `close` | `windowId` | `{}`; xdg close (the app may ask to save first) |
| `focus` | `windowId` (omit/null = none) | `{}`; keyboard focus + "activated" look |
| `mouse` | `windowId, kind: "move"\|"down"\|"up"\|"drag", x, y, button` | x/y in frame pixels (top-left of the frame), `button` in DOM numbering (0 left, 1 middle, 2 right, 3 back, 4 forward). `down` also focuses the window. `drag` = `move`. |
| `click` | `windowId, x, y, button, clicks` | down+up, `clicks` times |
| `scroll` | `windowId, x, y, dx, dy` | pixels, DOM sign (positive dy = scroll down), sent as wheel axis events |
| `key` | `code` (DOM `KeyboardEvent.code`), `down`, optional `windowId` (focuses it first) | Modifiers are keys too: send ShiftLeft etc. down/up like any other key. **Drop DOM auto-repeat (`e.repeat`)**: clients repeat by themselves. On blur, send `down:false` for keys still held. |
| `set_keymap` | `layout, variant, model, options` (xkb names) | `{}` |
| `stats` | `windowId` | counters used by the harness (`commits, frames, composeUs*, composedPx, reportedPx, commitToPublishUs*, …`) |

### Events (type 1, `ev`)

| ev | fields |
|---|---|
| `ready` | `platform, version, socket` (first message after start) |
| `window_added` | `windowId, pid, app, appId, bundleId, title, width, height, onScreen, parentId?` (a toplevel mapped its first buffer; `parentId` for dialogs) |
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

### Plugin read path (what `test/harness.mjs` does)

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
  cut apps off the desktop's portals/keyring; to decide in M1.
- **No dmabuf → no GPU** for clients: Mesa falls back to llvmpipe (software GL) for GL/Vulkan
  clients. GTK4's default GL renderer then works but costs more than its cairo renderer (see the
  report); `env: {GSK_RENDERER: "cairo"}` on `launch` is the cheap option until M2.
- X11-only apps don't run (no Xwayland yet).

## Known gaps

M1 (plugin integration): WebGL tile renderer (texture per window, BGRA swizzle, premultiplied),
tile ↔ window lifecycle via `window_added`/`window_removed`/`pid`, `set_visible` from canvas
viewport culling, cursor from `cursor` events, HiDPI (output scale 2 / fractional-scale-v1 +
viewporter, frame in device pixels), popups that extend beyond the window (today they are
constrained inside it), a long-lived helper so app windows survive a plugin reload.

M2: linux-dmabuf + GPU readback (or dmabuf import straight into the plugin) so GL/Vulkan apps
render on the GPU, Xwayland for X11-only apps, clipboard bridge to the desktop, text-input/IME,
drag and drop, touch, `xdg_activation`, presentation-time.
