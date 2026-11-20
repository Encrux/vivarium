//! vivarium-helper (Linux): a headless Wayland compositor whose windows become Vivarium app tiles.
//!
//! Spawned by the Obsidian plugin; talks the protocol in out.rs / README.md over stdin/stdout.
//! It never shows a window itself: apps it launches connect to our Wayland socket, each xdg
//! toplevel is composited into its own shared-memory frame, and the plugin draws that frame on
//! the canvas and sends input back. Exits when stdin closes; the apps lose their display with it.
mod apps;
mod frame;
mod keymap;
mod out;
mod state;

use serde_json::{json, Value};
use smithay::reexports::{
    calloop::{channel, generic::Generic, EventLoop, Interest, Mode, PostAction},
    wayland_server::Display,
};
use smithay::wayland::socket::ListeningSocketSource;
use state::{ClientState, Options, State};
use std::io::BufRead;
use std::sync::Arc;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Remove our frame files and leave. Used on stdin EOF, stdout EPIPE and SIGTERM/SIGINT/SIGHUP.
pub fn shutdown() -> ! {
    let prefix = format!("vivarium-{}-", std::process::id());
    if let Ok(rd) = std::fs::read_dir(frame::shm_dir()) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    std::process::exit(0)
}

enum Msg {
    Request(Value),
    AppExited(i32, Option<i32>),
}

fn usage() -> ! {
    eprintln!(
        "usage: vivarium-helper-linux [--socket NAME] [--fps N] [--xkb-layout us] [--xkb-variant V] [--xkb-options O] [--xkb-model M]\n\
         Speaks the Vivarium helper protocol on stdin/stdout (see helper/linux/README.md)."
    );
    std::process::exit(2)
}

fn main() {
    let mut opts = Options {
        fps: 60,
        xkb_layout: std::env::var("VIVARIUM_XKB_LAYOUT").unwrap_or_else(|_| "us".into()),
        xkb_variant: std::env::var("VIVARIUM_XKB_VARIANT").unwrap_or_default(),
        xkb_options: std::env::var("VIVARIUM_XKB_OPTIONS").ok(),
        xkb_model: String::new(),
    };
    let mut socket_name: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut val = || args.next().unwrap_or_else(|| usage());
        match a.as_str() {
            "--socket" => socket_name = Some(val()),
            "--fps" => opts.fps = val().parse().unwrap_or_else(|_| usage()),
            "--xkb-layout" => opts.xkb_layout = val(),
            "--xkb-variant" => opts.xkb_variant = val(),
            "--xkb-options" => opts.xkb_options = Some(val()),
            "--xkb-model" => opts.xkb_model = val(),
            "--version" => {
                println!("{VERSION}");
                return;
            }
            _ => usage(),
        }
    }

    // SIGTERM/SIGINT/SIGHUP → clean shutdown on a dedicated thread (sigwait), so frame files
    // don't outlive us. Blocked before any other thread exists so all of them inherit the mask;
    // spawned apps get a clean mask (see apps::launch).
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for s in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::sigaddset(&mut set, s);
        }
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        let set_copy = set;
        std::thread::spawn(move || {
            let mut sig = 0;
            libc::sigwait(&set_copy, &mut sig);
            shutdown();
        });
    }
    frame::sweep_stale();

    let mut event_loop: EventLoop<'static, State> = EventLoop::try_new().expect("event loop");
    let display: Display<State> = Display::new().expect("wayland display");
    let dh = display.handle();

    let listener = match &socket_name {
        Some(n) => ListeningSocketSource::with_name(n),
        None => ListeningSocketSource::new_auto(),
    }
    .unwrap_or_else(|e| {
        out::log(format!("cannot create wayland socket (is XDG_RUNTIME_DIR set?): {e}"));
        std::process::exit(1)
    });
    let socket = listener.socket_name().to_string_lossy().into_owned();
    let handle = event_loop.handle();
    handle
        .insert_source(listener, |stream, _, st: &mut State| {
            let _ = st.dh.insert_client(stream, Arc::new(ClientState { compositor_state: Default::default() }));
        })
        .expect("socket source");
    handle
        .insert_source(Generic::new(display, Interest::READ, Mode::Level), |_, display, st| {
            // SAFETY: the display is never dropped while the loop runs.
            unsafe { display.get_mut().dispatch_clients(st).ok() };
            Ok(PostAction::Continue)
        })
        .expect("display source");

    // stdin: one JSON request per line, parsed off the loop thread.
    let (tx, rx) = channel::channel::<Msg>();
    let stdin_tx = tx.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if stdin_tx.send(Msg::Request(v)).is_err() {
                    break;
                }
            }
        }
        shutdown();
    });
    let child_tx = tx;
    handle
        .insert_source(rx, move |ev, _, st| {
            if let channel::Event::Msg(m) = ev {
                match m {
                    Msg::Request(req) => handle_request(st, &req, &child_tx),
                    Msg::AppExited(pid, code) => out::event("app_exited", json!({"pid": pid, "code": code})),
                }
            }
        })
        .expect("stdin source");

    let mut state = State::new(dh, handle, socket.clone(), &opts);
    out::log(format!("WAYLAND_DISPLAY={socket}"));
    out::event("ready", json!({"platform": "linux", "version": VERSION, "socket": socket}));
    event_loop.run(None, &mut state, |st| st.flush()).expect("event loop");
}

fn u32_of(req: &Value, k: &str) -> Option<u32> {
    req.get(k).and_then(|v| v.as_u64()).map(|v| v as u32)
}
fn f64_of(req: &Value, k: &str) -> f64 {
    req.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0)
}

fn handle_request(st: &mut State, req: &Value, child_tx: &channel::Sender<Msg>) {
    let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
    let win = u32_of(req, "windowId");
    let need_win = || win.ok_or_else(|| "windowId required".to_string());
    let r: Result<Value, String> = (|| match op {
        "hello" => Ok(json!({"platform": "linux", "version": VERSION, "socket": st.socket,
                             "permissions": {"screen": true, "accessibility": true}})),
        "list_windows" => {
            let mut wins = st.list_windows();
            if let (Some(pid), Some(a)) = (req.get("pid").and_then(|p| p.as_i64()), wins.as_array_mut()) {
                a.retain(|w| w["pid"].as_i64() == Some(pid));
            }
            Ok(json!({"windows": wins}))
        }
        "list_apps" => Ok(json!({"apps": apps::list_json()})),
        "launch" => {
            let child = apps::launch(req, &st.socket)?;
            let pid = child.id() as i32;
            if let (Some(w), Some(h)) = (u32_of(req, "width"), u32_of(req, "height")) {
                st.size_hints.insert(pid, (w as i32, h as i32).into());
            }
            // Reap it and tell the plugin; one parked thread per app is cheap and simple.
            let tx = child_tx.clone();
            std::thread::spawn(move || {
                let mut child = child;
                let code = child.wait().ok().and_then(|s| s.code());
                let _ = tx.send(Msg::AppExited(pid, code));
            });
            Ok(json!({"pid": pid}))
        }
        "set_visible" => {
            let v = req.get("visible").and_then(|v| v.as_bool()).unwrap_or(true);
            if st.set_visible(need_win()?, v) { Ok(json!({})) } else { Err("no such window".into()) }
        }
        "frame_ack" => {
            st.frame_ack(need_win()?, u32_of(req, "seq").unwrap_or(0));
            Ok(json!({}))
        }
        "resize" | "set_frame" => {
            let w = req.get("width").and_then(|v| v.as_f64()).ok_or("width required")?;
            let h = req.get("height").and_then(|v| v.as_f64()).ok_or("height required")?;
            if st.resize(need_win()?, w.round() as i32, h.round() as i32) { Ok(json!({})) } else { Err("no such window".into()) }
        }
        "close" => {
            if st.close(need_win()?) { Ok(json!({})) } else { Err("no such window".into()) }
        }
        "focus" => {
            st.focus(win);
            Ok(json!({}))
        }
        "mouse" => {
            let id = need_win()?;
            let (x, y) = (f64_of(req, "x"), f64_of(req, "y"));
            match req.get("kind").and_then(|k| k.as_str()).unwrap_or("move") {
                "down" | "up" => {
                    let b = keymap::button(req.get("button").and_then(|b| b.as_u64()).unwrap_or(0));
                    let down = req["kind"] == "down";
                    st.pointer_button(id, x, y, b, down)?;
                }
                _ => st.pointer_motion(id, x, y)?,
            }
            Ok(json!({}))
        }
        "click" => {
            // macOS-compatible convenience: down + up at a point.
            let id = need_win()?;
            let (x, y) = (f64_of(req, "x"), f64_of(req, "y"));
            let b = keymap::button(req.get("button").and_then(|b| b.as_u64()).unwrap_or(0));
            for _ in 0..req.get("clicks").and_then(|c| c.as_u64()).unwrap_or(1).max(1) {
                st.pointer_button(id, x, y, b, true)?;
                st.pointer_button(id, x, y, b, false)?;
            }
            Ok(json!({}))
        }
        "scroll" => {
            st.pointer_axis(need_win()?, f64_of(req, "x"), f64_of(req, "y"), f64_of(req, "dx"), f64_of(req, "dy"))?;
            Ok(json!({}))
        }
        "key" => {
            let code = req.get("code").and_then(|c| c.as_str()).ok_or("code (KeyboardEvent.code) required")?;
            let ev = keymap::evdev(code).ok_or_else(|| format!("unknown key code {code}"))?;
            st.key(win, ev, req.get("down").and_then(|d| d.as_bool()).unwrap_or(true));
            Ok(json!({}))
        }
        "set_keymap" => {
            let s = |k: &str| req.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let opts = req.get("options").and_then(|v| v.as_str()).map(String::from);
            st.set_keymap(&s("layout"), &s("variant"), &s("model"), opts)?;
            Ok(json!({}))
        }
        "stats" => {
            let w = st.win(need_win()?).ok_or("no such window")?;
            Ok(json!({"stats": w.stats.json()}))
        }
        _ => Err(format!("unknown op {op}")),
    })();
    out::reply(req, r);
}
