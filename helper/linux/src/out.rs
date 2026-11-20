//! helper → plugin: framed messages, the same framing as the macOS helper.
//!
//!   [u32 BE length][u8 type][payload]      length counts the type byte + payload
//!     type 1  JSON (UTF-8): replies (carry the request's `id`) and events (carry `ev`)
//!     type 3  frame ready (binary, see `frame_ready`)
//!
//! Where they go: stdout (spawned by the plugin, `--stdio`, the harness) or the one connected
//! client of the daemon's unix socket (`--listen`). Without a client, messages are dropped: the
//! plugin gets the current state again when it (re)connects.
//!
//! Everything is written from the event-loop thread, one write per message, flushed at once:
//! frame-ready latency matters more than syscall count, and messages are small.
use serde_json::{Map, Value};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

pub const TYPE_JSON: u8 = 1;
pub const TYPE_FRAME: u8 = 3;

static SINK: Mutex<Option<Box<dyn Write + Send>>> = Mutex::new(None);
/// stdio mode: losing the plugin means shutting down. Daemon mode: just drop the client.
static DAEMON: AtomicBool = AtomicBool::new(false);
static LOST: AtomicBool = AtomicBool::new(false);

pub fn use_stdout() {
    *SINK.lock().unwrap() = Some(Box::new(std::io::stdout()));
}

pub fn set_daemon() {
    DAEMON.store(true, Ordering::Relaxed);
}

/// The daemon's current client (None: nobody connected).
pub fn set_sink(w: Option<Box<dyn Write + Send>>) {
    *SINK.lock().unwrap() = w;
    LOST.store(false, Ordering::Relaxed);
}

/// A write to the client failed since the last call (daemon mode).
pub fn take_lost() -> bool {
    LOST.swap(false, Ordering::Relaxed)
}

fn frame(ty: u8, payload: &[u8]) {
    let mut msg = Vec::with_capacity(payload.len() + 5);
    msg.extend_from_slice(&(payload.len() as u32 + 1).to_be_bytes());
    msg.push(ty);
    msg.extend_from_slice(payload);
    let mut sink = SINK.lock().unwrap();
    let Some(out) = sink.as_mut() else { return };
    if out.write_all(&msg).and_then(|_| out.flush()).is_err() {
        if DAEMON.load(Ordering::Relaxed) {
            *sink = None;
            LOST.store(true, Ordering::Relaxed);
        } else {
            // The plugin went away; nothing left to do (apps die with our socket, see README).
            drop(sink);
            crate::shutdown();
        }
    }
}

pub fn json(v: &Value) {
    frame(TYPE_JSON, &serde_json::to_vec(v).unwrap_or_default());
}

pub fn event(name: &str, fields: Value) {
    let mut o = match fields {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    o.insert("ev".into(), Value::from(name));
    json(&Value::Object(o));
}

/// Reply to a request; requests without `id` are fire-and-forget and get none.
pub fn reply(req: &Value, result: Result<Value, String>) {
    let Some(id) = req.get("id") else { return };
    let mut o = Map::new();
    o.insert("id".into(), id.clone());
    match result {
        Ok(Value::Object(m)) => {
            o.insert("ok".into(), Value::Bool(true));
            o.extend(m);
        }
        Ok(_) => {
            o.insert("ok".into(), Value::Bool(true));
        }
        Err(e) => {
            o.insert("ok".into(), Value::Bool(false));
            o.insert("error".into(), Value::from(e));
        }
    }
    json(&Value::Object(o));
}

/// Frame ready (type 3), all integers big-endian like the rest of the framing:
///
///   u32 windowId
///   u32 seq          increases by 1 per published frame of this window
///   u32 width        frame size in pixels
///   u32 height
///   u32 stride       bytes per row (width * 4 today)
///   u64 offset       byte offset of the frame's first row in the window's shm file
///   u16 format       0 = BGRA8 premultiplied (wl_shm ARGB8888 byte order)
///   u16 nrects       damage rectangles since the previous frame_ready of this window
///   nrects × { u32 x, u32 y, u32 w, u32 h }
///
/// Binary because it is the one hot message (up to 60/s per visible window) and the plugin can
/// parse it with a DataView without allocating; JSON would cost a stringify + parse + garbage on
/// the renderer's main thread for every frame.
#[allow(clippy::too_many_arguments)]
pub fn frame_ready(window: u32, seq: u32, w: u32, h: u32, stride: u32, offset: u64, rects: &[[u32; 4]]) {
    let mut p = Vec::with_capacity(32 + rects.len() * 16);
    for v in [window, seq, w, h, stride] {
        p.extend_from_slice(&v.to_be_bytes());
    }
    p.extend_from_slice(&offset.to_be_bytes());
    p.extend_from_slice(&0u16.to_be_bytes());
    p.extend_from_slice(&(rects.len() as u16).to_be_bytes());
    for r in rects {
        for v in r {
            p.extend_from_slice(&v.to_be_bytes());
        }
    }
    frame(TYPE_FRAME, &p);
}

pub fn log(msg: impl AsRef<str>) {
    eprintln!("[vivarium-helper] {}", msg.as_ref());
}
