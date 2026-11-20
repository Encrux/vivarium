//! The compositor: Wayland globals, windows (xdg toplevels → tiles), frame publishing,
//! frame-callback pacing and input routing.
use crate::frame::{self, FrameFile, Layer};
use crate::out;
use serde_json::{json, Value};
use smithay::{
    backend::{
        input::{Axis, AxisSource, ButtonState, KeyState},
        renderer::utils::{on_commit_buffer_handler, with_renderer_surface_state, CommitCounter},
    },
    delegate_compositor, delegate_cursor_shape, delegate_data_device, delegate_output, delegate_seat,
    delegate_shm, delegate_xdg_decoration, delegate_xdg_shell,
    desktop::{find_popup_root_surface, get_popup_toplevel_coords, PopupKind, PopupManager, Window, WindowSurfaceType},
    input::{
        keyboard::{FilterResult, Keycode, XkbConfig},
        pointer::{AxisFrame, ButtonEvent, CursorImageStatus, Focus, MotionEvent},
        Seat, SeatHandler, SeatState,
    },
    output::{Mode as OutputMode, Output, PhysicalProperties, Scale, Subpixel},
    reexports::{
        calloop::{
            timer::{TimeoutAction, Timer},
            LoopHandle,
        },
        wayland_protocols::xdg::{decoration::zv1::server::zxdg_toplevel_decoration_v1, shell::server::xdg_toplevel},
        wayland_server::{
            backend::{ClientData, ClientId, DisconnectReason, ObjectId},
            protocol::{wl_buffer, wl_seat, wl_surface::WlSurface},
            Client, DisplayHandle, Resource,
        },
    },
    utils::{Logical, Point, Rectangle, Serial, Size, Transform, SERIAL_COUNTER},
    wayland::{
        buffer::BufferHandler,
        compositor::{get_parent, is_sync_subsurface, with_states, with_surface_tree_upward, CompositorClientState, CompositorHandler, CompositorState, TraversalAction},
        cursor_shape::CursorShapeManagerState,
        output::{OutputHandler, OutputManagerState},
        selection::{
            data_device::{set_data_device_focus, ClientDndGrabHandler, DataDeviceHandler, DataDeviceState, ServerDndGrabHandler},
            SelectionHandler,
        },
        shell::xdg::{
            decoration::{XdgDecorationHandler, XdgDecorationState},
            PopupSurface, PositionerState, ToplevelSurface, XdgShellHandler, XdgShellState, XdgToplevelSurfaceData,
        },
        shm::{ShmHandler, ShmState},
        tablet_manager::TabletSeatHandler,
    },
};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Damage bookkeeping for one consumer of a window's content: one per shm slot (what that slot
/// last received) and one for the plugin (what it was last told about).
#[derive(Default)]
struct Tracker {
    size: Size<i32, Logical>,
    layout: Vec<(ObjectId, Rectangle<i32, Logical>)>,
    seen: HashMap<ObjectId, CommitCounter>,
}

struct Surf {
    surface: WlSurface,
    dst: Rectangle<i32, Logical>,
    buffer: Option<wl_buffer::WlBuffer>,
}

impl Tracker {
    /// What changed since this tracker was last brought up to date; brings it up to date.
    fn damage(&mut self, size: Size<i32, Logical>, surfs: &[Surf]) -> Vec<Rectangle<i32, Logical>> {
        let layout: Vec<_> = surfs.iter().map(|s| (s.surface.id(), s.dst)).collect();
        let mut d = vec![];
        if size != self.size {
            d.push(Rectangle::from_size(size));
            self.seen.clear();
        } else {
            // Surfaces that appeared, vanished or moved (popups, subsurfaces): their whole area.
            for (id, r) in &self.layout {
                if !layout.iter().any(|(i, rr)| i == id && rr == r) {
                    d.push(*r);
                }
            }
            for (id, r) in &layout {
                if !self.layout.iter().any(|(i, rr)| i == id && rr == r) {
                    d.push(*r);
                    self.seen.remove(id);
                }
            }
        }
        let mut seen = HashMap::with_capacity(surfs.len());
        for s in surfs {
            let id = s.surface.id();
            let prev = self.seen.get(&id).copied();
            let cur = with_renderer_surface_state(&s.surface, |st| {
                let (bw, bh) = st.buffer_size().map(|b| (b.w.max(1), b.h.max(1))).unwrap_or((1, 1));
                let bs = st.buffer_scale().max(1);
                for r in st.damage_since(prev).iter() {
                    // buffer → surface coords (buffer_scale / viewport), then into the frame
                    let (sx, sy) = (s.dst.size.w as f64 / (bw * bs) as f64, s.dst.size.h as f64 / (bh * bs) as f64);
                    let x0 = (r.loc.x as f64 * sx).floor() as i32;
                    let y0 = (r.loc.y as f64 * sy).floor() as i32;
                    let x1 = ((r.loc.x + r.size.w) as f64 * sx).ceil() as i32;
                    let y1 = ((r.loc.y + r.size.h) as f64 * sy).ceil() as i32;
                    d.push(Rectangle::new((s.dst.loc.x + x0, s.dst.loc.y + y0).into(), (x1 - x0, y1 - y0).into()));
                }
                st.current_commit()
            });
            if let Some(c) = cur {
                seen.insert(id, c);
            }
        }
        self.seen = seen;
        self.layout = layout;
        self.size = size;
        frame::coalesce(d, size)
    }
}

pub struct Win {
    pub id: u32,
    pub window: Window,
    pub pid: i32,
    pub mapped: bool,
    pub visible: bool,
    fb: Option<FrameFile>,
    fb_gen: u32,
    front: usize,
    pub seq: u32,
    /// published a frame the plugin hasn't acked yet: don't publish again, don't pace the app
    outstanding: bool,
    dirty: bool,
    trackers: [Tracker; 3], // slot 0, slot 1, plugin
    pub stats: Stats,
    /// first commit not yet published (commit → frame_ready latency)
    dirty_since: Option<Instant>,
    /// front slot holds a complete frame of the current size (for diffing)
    front_valid: bool,
    front_size: Size<i32, Logical>,
}

/// Counters for `stats` (measurements, not needed by the plugin).
#[derive(Default, Clone)]
pub struct Stats {
    pub commits: u64,
    pub frames: u64,
    pub compose_us: u64,
    pub compose_max_us: u64,
    pub composed_px: u64,
    pub reported_px: u64,
    pub frame_callbacks_sent: u64,
    pub commit_to_publish_us: u64,
    pub commit_to_publish_max_us: u64,
    pub unchanged: u64,
    pub diff_us: u64,
}

impl Stats {
    pub fn json(&self) -> Value {
        json!({"commits": self.commits, "frames": self.frames, "composeUsTotal": self.compose_us,
               "composeUsMax": self.compose_max_us,
               "composeUsPerFrame": if self.frames > 0 { self.compose_us / self.frames } else { 0 },
               "composedPx": self.composed_px, "reportedPx": self.reported_px,
               "frameCallbackTicks": self.frame_callbacks_sent,
               "commitToPublishUsAvg": if self.frames > 0 { self.commit_to_publish_us / self.frames } else { 0 },
               "commitToPublishUsMax": self.commit_to_publish_max_us,
               "commitsWithoutVisibleChange": self.unchanged,
               "diffUsTotal": self.diff_us})
    }
}

impl Win {
    fn surface(&self) -> &WlSurface {
        self.window.toplevel().unwrap().wl_surface()
    }

    fn info(&self) -> Value {
        let (title, app_id) = title_app(self.window.toplevel().unwrap());
        let g = self.window.geometry();
        json!({"windowId": self.id, "pid": self.pid, "app": app_id, "appId": app_id, "bundleId": app_id,
               "title": title, "width": g.size.w, "height": g.size.h, "onScreen": self.visible})
    }

    /// Everything to draw, bottom to top, in frame coordinates (origin = xdg window geometry, so
    /// client-side shadows outside the geometry are cropped away).
    fn surfaces(&self) -> Vec<Surf> {
        let geo = self.window.geometry();
        let mut out = vec![];
        let mut walk = |root: &WlSurface, origin: Point<i32, Logical>| {
            with_surface_tree_upward(
                root,
                origin,
                |_, states, loc| {
                    let view = states.data_map.get::<smithay::backend::renderer::utils::RendererSurfaceStateUserData>().and_then(|d| d.lock().unwrap().view());
                    match view {
                        Some(v) => TraversalAction::DoChildren(*loc + v.offset),
                        None => TraversalAction::SkipChildren, // unmapped parent hides its children
                    }
                },
                |surface, states, loc| {
                    let Some(d) = states.data_map.get::<smithay::backend::renderer::utils::RendererSurfaceStateUserData>() else { return };
                    let d = d.lock().unwrap();
                    let (Some(v), Some(b)) = (d.view(), d.buffer()) else { return };
                    let wl: &wl_buffer::WlBuffer = b;
                    out.push(Surf { surface: surface.clone(), dst: Rectangle::new(*loc + v.offset, v.dst), buffer: Some(wl.clone()) });
                },
                |_, _, _| true,
            );
        };
        walk(self.surface(), Point::from((0, 0)) - geo.loc);
        for (popup, location) in PopupManager::popups_for_surface(self.surface()) {
            walk(popup.wl_surface(), location - popup.geometry().loc);
        }
        out
    }
}

fn title_app(t: &ToplevelSurface) -> (String, String) {
    with_states(t.wl_surface(), |s| {
        let a = s.data_map.get::<XdgToplevelSurfaceData>().unwrap().lock().unwrap();
        (a.title.clone().unwrap_or_default(), a.app_id.clone().unwrap_or_default())
    })
}

#[allow(dead_code)]
pub struct State {
    // Several of these are never read, but own their Wayland globals.
    pub start: Instant,
    pub dh: DisplayHandle,
    pub handle: LoopHandle<'static, State>,
    pub socket: String,
    pub compositor_state: CompositorState,
    pub xdg_shell_state: XdgShellState,
    pub xdg_decoration_state: XdgDecorationState,
    pub shm_state: ShmState,
    pub output_state: OutputManagerState,
    pub seat_state: SeatState<State>,
    pub data_device_state: DataDeviceState,
    pub cursor_shape_state: CursorShapeManagerState,
    pub popups: PopupManager,
    pub seat: Seat<State>,
    pub output: Output,
    pub wins: Vec<Win>,
    next_id: u32,
    /// launch {width, height}: first window of that pid starts at this size
    pub size_hints: HashMap<i32, Size<i32, Logical>>,
    frame_interval: Duration,
    tick_armed: bool,
    last_tick: Instant,
    layout_changed: bool,
    pointer_win: Option<u32>,
    last_cursor: String,
}

pub struct ClientState {
    pub compositor_state: CompositorClientState,
}
impl ClientData for ClientState {
    fn initialized(&self, _: ClientId) {}
    fn disconnected(&self, _: ClientId, _: DisconnectReason) {}
}

pub struct Options {
    pub fps: u32,
    pub xkb_layout: String,
    pub xkb_variant: String,
    pub xkb_options: Option<String>,
    pub xkb_model: String,
}

impl State {
    pub fn new(dh: DisplayHandle, handle: LoopHandle<'static, State>, socket: String, opts: &Options) -> Self {
        let compositor_state = CompositorState::new::<Self>(&dh);
        let xdg_shell_state = XdgShellState::new::<Self>(&dh);
        let xdg_decoration_state = XdgDecorationState::new::<Self>(&dh);
        // Only the two mandatory formats (ARGB8888/XRGB8888): exactly what we can blit as-is.
        // No linux-dmabuf global in M0, so every client renders into shm.
        let shm_state = ShmState::new::<Self>(&dh, vec![]);
        let output_state = OutputManagerState::new_with_xdg_output::<Self>(&dh);
        let mut seat_state = SeatState::new();
        let data_device_state = DataDeviceState::new::<Self>(&dh);
        let cursor_shape_state = CursorShapeManagerState::new::<Self>(&dh);
        let mut seat: Seat<Self> = seat_state.new_wl_seat(&dh, "vivarium");
        let xkb = XkbConfig {
            layout: &opts.xkb_layout,
            variant: &opts.xkb_variant,
            model: &opts.xkb_model,
            options: opts.xkb_options.clone(),
            ..Default::default()
        };
        // Clients repeat keys themselves (wl_keyboard.repeat_info), so the plugin must drop DOM
        // auto-repeat keydowns.
        seat.add_keyboard(xkb, 400, 30).expect("xkb keymap");
        seat.add_pointer();

        // One big virtual monitor. Its size only bounds what apps think they may grow to.
        let output = Output::new(
            "vivarium".into(),
            PhysicalProperties { size: (0, 0).into(), subpixel: Subpixel::Unknown, make: "Vivarium".into(), model: "Tiles".into() },
        );
        let mode = OutputMode { size: (3840, 2160).into(), refresh: opts.fps as i32 * 1000 };
        let _global = output.create_global::<Self>(&dh);
        output.change_current_state(Some(mode), Some(Transform::Normal), Some(Scale::Integer(1)), Some((0, 0).into()));
        output.set_preferred(mode);

        Self {
            start: Instant::now(),
            dh,
            handle,
            socket,
            compositor_state,
            xdg_shell_state,
            xdg_decoration_state,
            shm_state,
            output_state,
            seat_state,
            data_device_state,
            cursor_shape_state,
            popups: PopupManager::default(),
            seat,
            output,
            wins: vec![],
            next_id: 1,
            size_hints: HashMap::new(),
            frame_interval: Duration::from_secs_f64(1.0 / opts.fps.max(1) as f64),
            tick_armed: false,
            last_tick: Instant::now(),
            layout_changed: false,
            pointer_win: None,
            last_cursor: String::new(),
        }
    }

    fn now_ms(&self) -> u32 {
        self.start.elapsed().as_millis() as u32
    }

    pub fn win(&self, id: u32) -> Option<&Win> {
        self.wins.iter().find(|w| w.id == id)
    }
    fn win_mut(&mut self, id: u32) -> Option<&mut Win> {
        self.wins.iter_mut().find(|w| w.id == id)
    }
    fn win_for_root(&mut self, root: &WlSurface) -> Option<&mut Win> {
        self.wins.iter_mut().find(|w| w.surface() == root)
    }

    /// Toplevel that owns this surface (through subsurface parents and popup chains).
    fn toplevel_of(&self, surface: &WlSurface) -> Option<WlSurface> {
        let mut root = surface.clone();
        while let Some(p) = get_parent(&root) {
            root = p;
        }
        if let Some(popup) = self.popups.find_popup(&root) {
            return find_popup_root_surface(&popup).ok();
        }
        Some(root)
    }

    pub fn list_windows(&self) -> Value {
        Value::from(self.wins.iter().filter(|w| w.mapped).map(|w| w.info()).collect::<Vec<_>>())
    }

    // ---- frames ----

    /// After every event-loop dispatch: publish what changed, so a commit becomes a frame_ready
    /// within the same loop iteration.
    pub fn flush(&mut self) {
        self.popups.cleanup();
        if std::mem::take(&mut self.layout_changed) {
            for w in &mut self.wins {
                w.dirty = true;
            }
        }
        for i in 0..self.wins.len() {
            let w = &self.wins[i];
            if w.mapped && w.visible && w.dirty && !w.outstanding {
                self.publish(i);
            }
        }
        let _ = self.dh.flush_clients();
    }

    fn publish(&mut self, i: usize) {
        let w = &mut self.wins[i];
        w.dirty = false;
        let size = w.window.geometry().size;
        if size.w <= 0 || size.h <= 0 {
            return;
        }
        let surfs = w.surfaces();
        let stride = size.w as usize * 4;
        let bytes = stride * size.h as usize;
        if w.fb.as_ref().is_none_or(|f| f.capacity < bytes) {
            // Grow with headroom so interactive resizing doesn't make a new file every step.
            let want = (size.w as usize + 256) * 4 * (size.h as usize + 256);
            w.fb_gen += 1;
            match FrameFile::create(w.id, w.fb_gen, want) {
                Ok(f) => {
                    out::event("frame_buffer", json!({"windowId": w.id, "path": f.path.to_string_lossy(), "bytes": frame::HEADER + 2 * f.capacity}));
                    w.fb = Some(f);
                    w.trackers = Default::default();
                    w.front_valid = false;
                }
                Err(e) => {
                    out::log(format!("frame buffer for window {}: {e}", w.id));
                    return;
                }
            }
        }
        let report = w.trackers[2].damage(size, &surfs);
        if report.is_empty() {
            w.dirty_since = None;
            return; // committed but nothing visible changed
        }
        let back = 1 - w.front;
        let redraw = w.trackers[back].damage(size, &surfs);
        let layers: Vec<Layer> = surfs.into_iter().filter_map(|s| Some(Layer { buffer: s.buffer?, dst: s.dst })).collect();
        let fb = w.fb.as_mut().unwrap();
        let t0 = Instant::now();
        {
            let slot = fb.slot_mut(back);
            for r in &redraw {
                frame::composite(slot, stride, *r, &layers);
            }
        }
        let t_diff = Instant::now();
        // Report only what really changed versus the frame the plugin has (the front slot).
        let report: Vec<_> = if w.front_valid && w.front_size == size {
            let (s0, s1) = fb.slots();
            let (new, old) = if back == 0 { (s0, s1) } else { (s1, s0) };
            // Only for "repaint everything" damage (GTK4, Mesa's software EGL): clients with
            // precise damage (foot, GTK3) gain little and the compare isn't free.
            let half = (size.w as i64 * size.h as i64) / 2;
            report
                .iter()
                .filter_map(|r| if (r.size.w as i64 * r.size.h as i64) >= half { frame::shrink_to_diff(new, old, stride, *r) } else { Some(*r) })
                .collect()
        } else {
            report
        };
        let us = t0.elapsed().as_micros() as u64;
        w.stats.diff_us += t_diff.elapsed().as_micros() as u64;
        if report.is_empty() {
            // Pixel-identical to what the plugin shows: nothing to publish. The back slot now
            // equals the front one, so neither needs fixing up.
            w.dirty_since = None;
            w.stats.unchanged += 1;
            return;
        }
        let s = &mut w.stats;
        s.frames += 1;
        s.compose_us += us;
        s.compose_max_us = s.compose_max_us.max(us);
        s.composed_px += redraw.iter().map(|r| (r.size.w * r.size.h) as u64).sum::<u64>();
        s.reported_px += report.iter().map(|r| (r.size.w * r.size.h) as u64).sum::<u64>();
        w.seq = w.seq.wrapping_add(1);
        fb.publish_header(back as u32, w.seq, size.w as u32, size.h as u32, stride as u32);
        let rects: Vec<[u32; 4]> = report.iter().map(|r| [r.loc.x as u32, r.loc.y as u32, r.size.w as u32, r.size.h as u32]).collect();
        out::frame_ready(w.id, w.seq, size.w as u32, size.h as u32, stride as u32, fb.slot_offset(back) as u64, &rects);
        w.front = back;
        w.front_valid = true;
        w.front_size = size;
        w.outstanding = true;
        if let Some(t) = w.dirty_since.take() {
            let us = t.elapsed().as_micros() as u64;
            w.stats.commit_to_publish_us += us;
            w.stats.commit_to_publish_max_us = w.stats.commit_to_publish_max_us.max(us);
        }
    }

    pub fn frame_ack(&mut self, id: u32, seq: u32) {
        if let Some(w) = self.win_mut(id) {
            if w.seq == seq {
                w.outstanding = false;
            }
        }
        self.arm_tick();
    }

    pub fn set_visible(&mut self, id: u32, visible: bool) -> bool {
        let Some(w) = self.win_mut(id) else { return false };
        if visible && !w.visible {
            // The plugin may have dropped its texture while hidden: next frame is a full one.
            w.trackers[2] = Tracker::default();
            w.front_valid = false; // don't diff the full frame away
            w.dirty = true;
            w.outstanding = false;
        }
        w.visible = visible;
        self.arm_tick();
        true
    }

    /// Frame callbacks are the apps' clock. Visible windows get one per tick (≤ fps) once the
    /// plugin consumed the previous frame; hidden windows get none, so well-behaved apps stop
    /// drawing altogether. The timer only runs while someone waits for a callback.
    pub fn arm_tick(&mut self) {
        if self.tick_armed {
            return;
        }
        self.tick_armed = true;
        let delay = (self.last_tick + self.frame_interval).saturating_duration_since(Instant::now());
        let _ = self.handle.insert_source(Timer::from_duration(delay), |_, _, st| {
            st.tick();
            TimeoutAction::Drop
        });
    }

    fn tick(&mut self) {
        self.tick_armed = false;
        self.last_tick = Instant::now();
        let time = self.start.elapsed();
        let output = self.output.clone();
        for w in &mut self.wins {
            if w.visible && !w.outstanding {
                w.stats.frame_callbacks_sent += 1;
                w.window.send_frame(&output, time, Some(Duration::ZERO), |_, _| Some(output.clone()));
            }
        }
        let _ = self.dh.flush_clients();
    }

    // ---- window management ----

    pub fn resize(&mut self, id: u32, w: i32, h: i32) -> bool {
        let Some(win) = self.win(id) else { return false };
        let t = win.window.toplevel().unwrap();
        t.with_pending_state(|s| s.size = Some((w.max(1), h.max(1)).into()));
        t.send_pending_configure();
        true
    }

    pub fn close(&mut self, id: u32) -> bool {
        let Some(win) = self.win(id) else { return false };
        win.window.toplevel().unwrap().send_close();
        true
    }

    /// Keyboard focus + xdg "activated" (focused look) on one window, none on the others.
    pub fn focus(&mut self, id: Option<u32>) {
        let kb = self.seat.get_keyboard().unwrap();
        if kb.is_grabbed() {
            return; // a popup (menu) owns the keyboard until it closes
        }
        let target = id.and_then(|id| self.win(id)).map(|w| w.surface().clone());
        if kb.current_focus() != target {
            kb.set_focus(self, target.clone(), SERIAL_COUNTER.next_serial());
        }
        for w in &self.wins {
            let active = Some(w.surface()) == target.as_ref();
            if w.window.set_activated(active) {
                w.window.toplevel().unwrap().send_pending_configure();
            }
        }
    }

    // ---- input ----

    pub fn pointer_motion(&mut self, id: u32, x: f64, y: f64) -> Result<(), String> {
        let w = self.win(id).ok_or("no such window")?;
        let geo = w.window.geometry();
        let pos: Point<f64, Logical> = (x, y).into();
        // Each window is its own little coordinate space with the frame's origin at (0,0).
        let under = w
            .window
            .surface_under(pos + geo.loc.to_f64(), WindowSurfaceType::ALL)
            .map(|(s, loc)| (s, (loc - geo.loc).to_f64()));
        self.pointer_win = Some(id);
        let ptr = self.seat.get_pointer().unwrap();
        let time = self.now_ms();
        ptr.motion(self, under, &MotionEvent { location: pos, serial: SERIAL_COUNTER.next_serial(), time });
        ptr.frame(self);
        Ok(())
    }

    pub fn pointer_button(&mut self, id: u32, x: f64, y: f64, button: u32, down: bool) -> Result<(), String> {
        self.pointer_motion(id, x, y)?;
        let ptr = self.seat.get_pointer().unwrap();
        if down && !ptr.is_grabbed() {
            self.focus(Some(id));
        }
        let time = self.now_ms();
        let state = if down { ButtonState::Pressed } else { ButtonState::Released };
        ptr.button(self, &ButtonEvent { button, state, serial: SERIAL_COUNTER.next_serial(), time });
        ptr.frame(self);
        Ok(())
    }

    /// dx/dy in pixels, DOM sign convention (positive = content moves up / scroll down), which is
    /// also Wayland's.
    pub fn pointer_axis(&mut self, id: u32, x: f64, y: f64, dx: f64, dy: f64) -> Result<(), String> {
        self.pointer_motion(id, x, y)?;
        let ptr = self.seat.get_pointer().unwrap();
        let mut f = AxisFrame::new(self.now_ms()).source(AxisSource::Wheel);
        for (axis, v) in [(Axis::Horizontal, dx), (Axis::Vertical, dy)] {
            if v != 0.0 {
                // A wheel notch is 120 v120 units; browsers report ~100 px per notch.
                f = f.value(axis, v).v120(axis, (v * 1.2).round() as i32);
            }
        }
        ptr.axis(self, f);
        ptr.frame(self);
        Ok(())
    }

    pub fn key(&mut self, id: Option<u32>, evdev: u32, down: bool) {
        if let Some(id) = id {
            let kb = self.seat.get_keyboard().unwrap();
            let want = self.win(id).map(|w| w.surface().clone());
            if want.is_some() && kb.current_focus() != want && !kb.is_grabbed() {
                self.focus(Some(id));
            }
        }
        let kb = self.seat.get_keyboard().unwrap();
        let time = self.now_ms();
        let state = if down { KeyState::Pressed } else { KeyState::Released };
        kb.input::<(), _>(self, Keycode::new(evdev + 8), state, SERIAL_COUNTER.next_serial(), time, |_, _, _| FilterResult::Forward);
    }

    pub fn set_keymap(&mut self, layout: &str, variant: &str, model: &str, options: Option<String>) -> Result<(), String> {
        let kb = self.seat.get_keyboard().unwrap();
        let cfg = XkbConfig { layout, variant, model, options, ..Default::default() };
        kb.set_xkb_config(self, cfg).map_err(|e| format!("{e:?}"))
    }

    fn unconstrain_popup(&self, popup: &PopupSurface) {
        let Ok(root) = find_popup_root_surface(&PopupKind::Xdg(popup.clone())) else { return };
        let Some(w) = self.wins.iter().find(|w| w.surface() == &root) else { return };
        // Keep popups inside the window's own frame: the tile is all the "screen" there is.
        let mut target = Rectangle::from_size(w.window.geometry().size);
        target.loc -= get_popup_toplevel_coords(&PopupKind::Xdg(popup.clone()));
        popup.with_pending_state(|s| s.geometry = s.positioner.get_unconstrained_geometry(target));
    }
}

// ---- Smithay handlers ----

impl CompositorHandler for State {
    fn compositor_state(&mut self) -> &mut CompositorState {
        &mut self.compositor_state
    }
    fn client_compositor_state<'a>(&self, client: &'a Client) -> &'a CompositorClientState {
        &client.get_data::<ClientState>().unwrap().compositor_state
    }
    fn commit(&mut self, surface: &WlSurface) {
        // Keeps the attached buffer (released when replaced) and accumulates its damage.
        on_commit_buffer_handler::<Self>(surface);

        // xdg: the first commit (no buffer yet) asks for the initial configure.
        if let Some(w) = self.wins.iter().find(|w| w.surface() == surface) {
            let t = w.window.toplevel().unwrap();
            if !t.is_initial_configure_sent() {
                t.send_configure();
            }
        }
        self.popups.commit(surface);
        if let Some(PopupKind::Xdg(p)) = self.popups.find_popup(surface) {
            if !p.is_initial_configure_sent() {
                let _ = p.send_configure();
            }
            self.layout_changed = true;
        }

        if is_sync_subsurface(surface) {
            return; // applied (and seen again here) when its parent commits
        }
        let Some(root) = self.toplevel_of(surface) else { return };
        let output = self.output.clone();
        let Some(w) = self.win_for_root(&root) else { return };
        w.window.on_commit();
        let has_buffer = with_renderer_surface_state(&root, |s| s.buffer().is_some()).unwrap_or(false);
        if !w.mapped && has_buffer {
            w.mapped = true;
            output.enter(&root);
            let mut info = w.info();
            if let Some(p) = w.window.toplevel().unwrap().parent() {
                let parent = self.wins.iter().find(|x| x.surface() == &p).map(|x| x.id);
                info["parentId"] = json!(parent);
            }
            out::event("window_added", info);
        } else if w.mapped && !has_buffer {
            // Unmapped (null buffer): the window is gone until it maps again.
            w.mapped = false;
            w.fb = None;
            w.outstanding = false;
            out::event("window_removed", json!({"windowId": w.id}));
            return;
        }
        let Some(w) = self.win_for_root(&root) else { return };
        w.dirty = true;
        w.dirty_since.get_or_insert_with(Instant::now);
        w.stats.commits += 1;
        if w.visible {
            self.arm_tick();
        }
    }
}

impl BufferHandler for State {
    fn buffer_destroyed(&mut self, _: &wl_buffer::WlBuffer) {}
}
impl ShmHandler for State {
    fn shm_state(&self) -> &ShmState {
        &self.shm_state
    }
}

impl XdgShellHandler for State {
    fn xdg_shell_state(&mut self) -> &mut XdgShellState {
        &mut self.xdg_shell_state
    }

    fn new_toplevel(&mut self, surface: ToplevelSurface) {
        let pid = surface.wl_surface().client().and_then(|c| c.get_credentials(&self.dh).ok()).map(|c| c.pid).unwrap_or(0);
        let hint = self.size_hints.remove(&pid);
        surface.with_pending_state(|s| {
            // "Tiled" on all edges: CSD apps (GTK, libadwaita) drop their shadows and rounded
            // corners, like in a tiling WM. No maximize/minimize/fullscreen capabilities: GTK
            // hides those buttons.
            for st in [xdg_toplevel::State::TiledLeft, xdg_toplevel::State::TiledRight, xdg_toplevel::State::TiledTop, xdg_toplevel::State::TiledBottom] {
                s.states.set(st);
            }
            s.size = hint;
            s.bounds = Some((3840, 2160).into());
        });
        let id = self.next_id;
        self.next_id += 1;
        self.wins.push(Win {
            id,
            window: Window::new_wayland_window(surface),
            pid,
            mapped: false,
            visible: true,
            fb: None,
            fb_gen: 0,
            front: 1,
            seq: 0,
            outstanding: false,
            dirty: false,
            trackers: Default::default(),
            stats: Stats::default(),
            dirty_since: None,
            front_valid: false,
            front_size: Size::default(),
        });
    }

    fn toplevel_destroyed(&mut self, surface: ToplevelSurface) {
        if let Some(i) = self.wins.iter().position(|w| w.surface() == surface.wl_surface()) {
            let w = self.wins.remove(i);
            if w.mapped {
                out::event("window_removed", json!({"windowId": w.id}));
            }
        }
    }

    fn title_changed(&mut self, surface: ToplevelSurface) {
        if let Some(w) = self.wins.iter().find(|w| w.surface() == surface.wl_surface() && w.mapped) {
            let (title, app_id) = title_app(&surface);
            out::event("title_changed", json!({"windowId": w.id, "title": title, "appId": app_id}));
        }
    }

    fn app_id_changed(&mut self, surface: ToplevelSurface) {
        self.title_changed(surface);
    }

    fn new_popup(&mut self, surface: PopupSurface, _positioner: PositionerState) {
        self.unconstrain_popup(&surface);
        let _ = self.popups.track_popup(PopupKind::Xdg(surface));
    }

    fn reposition_request(&mut self, surface: PopupSurface, positioner: PositionerState, token: u32) {
        surface.with_pending_state(|s| {
            s.geometry = positioner.get_geometry();
            s.positioner = positioner;
        });
        self.unconstrain_popup(&surface);
        surface.send_repositioned(token);
    }

    fn popup_destroyed(&mut self, _surface: PopupSurface) {
        self.layout_changed = true;
    }

    /// Menus: grab pointer + keyboard for the popup chain, as a desktop compositor would, so a
    /// click outside closes the menu and arrow keys go to it.
    fn grab(&mut self, surface: PopupSurface, seat: wl_seat::WlSeat, serial: Serial) {
        let Some(seat) = Seat::<State>::from_resource(&seat) else { return };
        let kind = PopupKind::Xdg(surface);
        let Ok(root) = find_popup_root_surface(&kind) else { return };
        let Ok(mut grab) = self.popups.grab_popup(root, kind, &seat, serial) else { return };
        if let Some(kb) = seat.get_keyboard() {
            if kb.is_grabbed() && !(kb.has_grab(serial) || kb.has_grab(grab.previous_serial().unwrap_or(serial))) {
                grab.ungrab(smithay::desktop::PopupUngrabStrategy::All);
                return;
            }
            kb.set_focus(self, grab.current_grab(), serial);
            kb.set_grab(self, smithay::desktop::PopupKeyboardGrab::new(&grab), serial);
        }
        if let Some(ptr) = seat.get_pointer() {
            if ptr.is_grabbed() && !(ptr.has_grab(serial) || ptr.has_grab(grab.previous_serial().unwrap_or_else(|| grab.serial()))) {
                grab.ungrab(smithay::desktop::PopupUngrabStrategy::All);
                return;
            }
            ptr.set_grab(self, smithay::desktop::PopupPointerGrab::new(&grab), serial, Focus::Keep);
        }
    }
}

/// Server-side decorations whenever the client supports xdg-decoration (Qt, foot, …): the tile
/// already has a title bar. GTK doesn't implement the protocol and keeps its header bar.
impl XdgDecorationHandler for State {
    fn new_decoration(&mut self, toplevel: ToplevelSurface) {
        toplevel.with_pending_state(|s| s.decoration_mode = Some(zxdg_toplevel_decoration_v1::Mode::ServerSide));
        if toplevel.is_initial_configure_sent() {
            toplevel.send_pending_configure();
        }
    }
    fn request_mode(&mut self, toplevel: ToplevelSurface, _mode: zxdg_toplevel_decoration_v1::Mode) {
        self.new_decoration(toplevel);
    }
    fn unset_mode(&mut self, toplevel: ToplevelSurface) {
        self.new_decoration(toplevel);
    }
}

impl SeatHandler for State {
    type KeyboardFocus = WlSurface;
    type PointerFocus = WlSurface;
    type TouchFocus = WlSurface;

    fn seat_state(&mut self) -> &mut SeatState<State> {
        &mut self.seat_state
    }

    /// Cursor as a CSS cursor name for the tile (cursor-shape protocol / named cursors). Apps
    /// that draw their own cursor surface get "default" in M0.
    fn cursor_image(&mut self, _seat: &Seat<Self>, image: CursorImageStatus) {
        let name = match image {
            CursorImageStatus::Hidden => "none".to_string(),
            CursorImageStatus::Named(icon) => icon.name().to_string(),
            CursorImageStatus::Surface(_) => "default".to_string(),
        };
        if name != self.last_cursor {
            self.last_cursor = name.clone();
            out::event("cursor", json!({"windowId": self.pointer_win, "name": name}));
        }
    }

    fn focus_changed(&mut self, seat: &Seat<Self>, focused: Option<&WlSurface>) {
        let client = focused.and_then(|s| self.dh.get_client(s.id()).ok());
        set_data_device_focus(&self.dh, seat, client);
    }
}
impl TabletSeatHandler for State {}

impl SelectionHandler for State {
    type SelectionUserData = ();
}
impl DataDeviceHandler for State {
    fn data_device_state(&self) -> &DataDeviceState {
        &self.data_device_state
    }
}
impl ClientDndGrabHandler for State {}
impl ServerDndGrabHandler for State {}
impl OutputHandler for State {}

delegate_compositor!(State);
delegate_shm!(State);
delegate_xdg_shell!(State);
delegate_xdg_decoration!(State);
delegate_seat!(State);
delegate_data_device!(State);
delegate_output!(State);
delegate_cursor_shape!(State);
