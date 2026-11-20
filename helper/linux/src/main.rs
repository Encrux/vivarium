//! vivarium-helper (Linux): a headless Wayland compositor whose windows become Vivarium app tiles.
//!
//! It never shows a window itself: apps it launches connect to our Wayland socket, each xdg
//! toplevel is composited into its own shared-memory frame, and the plugin draws that frame on
//! the canvas and sends input back. Protocol: out.rs / README.md.
//!
//! Two ways to run:
//!   (default) stdio: spawned by its client, talks over stdin/stdout, exits when stdin closes
//!             (the apps lose their display with it). The test harness uses this.
//!   --listen PATH: a daemon on a unix socket, like tmux. The plugin connects (and reconnects
//!             after Obsidian restarts); app windows live on while nobody is connected, with
//!             frames paused. Exits on SIGTERM, or when it has had no client, no windows and no
//!             apps for a while.
mod apps;
mod frame;
mod gpu;
mod keymap;
mod out;
mod state;

use serde_json::{json, Value};
use smithay::reexports::{
    calloop::{
        channel,
        generic::Generic,
        timer::{TimeoutAction, Timer},
        EventLoop, Interest, Mode, PostAction,
    },
    wayland_server::Display,
};
use smithay::wayland::socket::ListeningSocketSource;
use state::{ClientState, Options, State};
use std::io::BufRead;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;
use std::time::{Duration, Instant};

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Remove our frame files (and the daemon socket) and leave. Used on stdin EOF, stdout EPIPE,
/// SIGTERM/SIGINT/SIGHUP and the daemon's idle exit.
pub fn shutdown() -> ! {
    let prefix = format!("vivarium-{}-", std::process::id());
    if let Ok(rd) = std::fs::read_dir(frame::shm_dir()) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    if let Some(p) = LISTEN_PATH.get() {
        let _ = std::fs::remove_file(p);
    }
    std::process::exit(0)
}

static LISTEN_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();

enum Msg {
    /// a request line, from client generation `.1` (0 = stdin)
    Request(Value, u64),
    AppExited(i32, Option<i32>),
    Client(UnixStream),
    ClientGone(u64),
}

/// Daemon without client, windows or apps for this long: leave.
const IDLE_EXIT: Duration = Duration::from_secs(120);

fn usage() -> ! {
    eprintln!(
        "usage: vivarium-helper-linux [--listen PATH] [--socket NAME] [--fps N] [--no-gpu] [--render-node /dev/dri/renderD128]\n\
         \x20                             [--xkb-layout us] [--xkb-variant V] [--xkb-options O] [--xkb-model M]\n\
         Speaks the Vivarium helper protocol on stdin/stdout, or with --listen as a daemon on a unix socket\n\
         (see helper/linux/README.md)."
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
        gpu: std::env::var("VIVARIUM_NO_GPU").is_err(),
        render_node: std::env::var("VIVARIUM_RENDER_NODE").ok(),
    };
    let mut socket_name: Option<String> = None;
    let mut listen: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut val = || args.next().unwrap_or_else(|| usage());
        match a.as_str() {
            "--socket" => socket_name = Some(val()),
            "--listen" => listen = Some(val()),
            "--fps" => opts.fps = val().parse().unwrap_or_else(|_| usage()),
            "--no-gpu" => opts.gpu = false,
            "--render-node" => opts.render_node = Some(val()),
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
    // spawned apps get a clean mask (see apps::launch). The daemon ignores SIGHUP: it must not
    // die with the terminal or session that started it.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for s in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::sigaddset(&mut set, s);
        }
        if listen.is_some() {
            libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        }
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        let set_copy = set;
        let daemon = listen.is_some();
        std::thread::spawn(move || loop {
            let mut sig = 0;
            libc::sigwait(&set_copy, &mut sig);
            if daemon && sig == libc::SIGHUP {
                continue;
            }
            shutdown();
        });
    }
    frame::sweep_stale();

    // Daemon: one per socket path. If one already answers there, we're not needed.
    let listener = listen.as_ref().map(|p| {
        if UnixStream::connect(p).is_ok() {
            out::log(format!("already running at {p}"));
            std::process::exit(0);
        }
        let _ = std::fs::remove_file(p);
        let l = UnixListener::bind(p).unwrap_or_else(|e| {
            out::log(format!("cannot listen on {p}: {e}"));
            std::process::exit(1)
        });
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
        let _ = LISTEN_PATH.set(p.clone());
        out::set_daemon();
        l
    });
    let daemon = listener.is_some();
    if !daemon {
        out::use_stdout();
    }

    let mut event_loop: EventLoop<'static, State> = EventLoop::try_new().expect("event loop");
    let display: Display<State> = Display::new().expect("wayland display");
    let dh = display.handle();

    let wl_listener = match &socket_name {
        Some(n) => ListeningSocketSource::with_name(n),
        None => ListeningSocketSource::new_auto(),
    }
    .unwrap_or_else(|e| {
        out::log(format!("cannot create wayland socket (is XDG_RUNTIME_DIR set?): {e}"));
        std::process::exit(1)
    });
    let socket = wl_listener.socket_name().to_string_lossy().into_owned();
    let handle = event_loop.handle();
    handle
        .insert_source(wl_listener, |stream, _, st: &mut State| {
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

    // Requests: one JSON object per line, read off the loop thread.
    let (tx, rx) = channel::channel::<Msg>();
    if let Some(l) = listener {
        let accept_tx = tx.clone();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                if accept_tx.send(Msg::Client(s)).is_err() {
                    break;
                }
            }
        });
    } else {
        let stdin_tx = tx.clone();
        std::thread::spawn(move || {
            read_requests(std::io::stdin().lock(), 0, &stdin_tx);
            shutdown();
        });
    }
    let child_tx = tx;
    // The daemon's one client: a new connection replaces the previous one (Obsidian restarted,
    // or the plugin reloaded before the old socket noticed).
    let mut generation = 0u64;
    let mut current: Option<UnixStream> = None;
    handle
        .insert_source(rx, move |ev, _, st| {
            let channel::Event::Msg(m) = ev else { return };
            match m {
                Msg::Request(req, g) => {
                    if g == generation {
                        handle_request(st, &req, &child_tx)
                    }
                }
                Msg::AppExited(pid, code) => {
                    st.children = st.children.saturating_sub(1);
                    out::event("app_exited", json!({"pid": pid, "code": code}))
                }
                Msg::Client(stream) => {
                    if let Some(old) = current.take() {
                        let _ = old.shutdown(std::net::Shutdown::Both);
                    }
                    generation += 1;
                    let (Ok(w), Ok(r)) = (stream.try_clone(), stream.try_clone()) else { return };
                    // A client that stops reading must not stall the compositor for long.
                    let _ = w.set_write_timeout(Some(Duration::from_secs(2)));
                    out::set_sink(Some(Box::new(w)));
                    current = Some(stream);
                    let (g, tx) = (generation, child_tx.clone());
                    std::thread::spawn(move || {
                        read_requests(std::io::BufReader::new(r), g, &tx);
                        let _ = tx.send(Msg::ClientGone(g));
                    });
                    st.client_connected();
                    out::event("ready", ready(st));
                    st.announce_windows();
                }
                Msg::ClientGone(g) => {
                    if g == generation && current.is_some() {
                        current = None;
                        out::set_sink(None);
                        st.client_gone();
                    }
                }
            }
        })
        .expect("request source");

    let mut state = State::new(dh, handle.clone(), socket.clone(), &opts);
    state.has_client = !daemon;
    out::log(format!("WAYLAND_DISPLAY={socket} gpu={}", state.gpu_info()));
    if daemon {
        // Leave when nobody needs us any more (no client, no windows, no apps we started).
        let idle_exit = std::env::var("VIVARIUM_IDLE_EXIT").ok().and_then(|s| s.parse().ok()).map(Duration::from_secs).unwrap_or(IDLE_EXIT);
        let every = (idle_exit / 4).clamp(Duration::from_secs(1), Duration::from_secs(15));
        let _ = handle.insert_source(Timer::from_duration(every), move |_, _, st| {
            if st.has_client || !st.wins.is_empty() || st.children > 0 {
                st.idle_since = None;
            } else if st.idle_since.get_or_insert_with(Instant::now).elapsed() >= idle_exit {
                out::log("idle: no client, windows or apps; exiting");
                shutdown();
            }
            TimeoutAction::ToDuration(every)
        });
    } else {
        out::event("ready", ready(&state));
    }
    event_loop
        .run(None, &mut state, |st| {
            if out::take_lost() {
                st.client_gone(); // a write to the client failed: treat it as gone (its reader notices too)
            }
            st.flush()
        })
        .expect("event loop");
}

fn read_requests(r: impl BufRead, generation: u64, tx: &channel::Sender<Msg>) {
    for line in r.lines() {
        let Ok(line) = line else { break };
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            if tx.send(Msg::Request(v, generation)).is_err() {
                break;
            }
        }
    }
}

fn ready(st: &State) -> Value {
    json!({"platform": "linux", "version": VERSION, "socket": st.socket, "instance": st.instance,
           "pid": std::process::id(), "gpu": st.gpu_info()})
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
        "hello" => Ok(json!({"platform": "linux", "version": VERSION, "socket": st.socket, "instance": st.instance,
                             "pid": std::process::id(), "gpu": st.gpu_info(),
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
            st.children += 1;
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
                "leave" => st.pointer_leave(),
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
