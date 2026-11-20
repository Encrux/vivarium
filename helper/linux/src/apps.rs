//! Launching apps onto our Wayland socket, and the installed apps (.desktop entries).
use serde_json::{json, Value};
use std::collections::HashMap;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// Environment that makes toolkits pick Wayland (and therefore us) instead of the desktop's X11
/// or Wayland session. DISPLAY is removed so nothing falls back to the host X server.
pub fn wayland_env(cmd: &mut Command, socket: &str) {
    cmd.env("WAYLAND_DISPLAY", socket)
        .env("GDK_BACKEND", "wayland")
        .env("QT_QPA_PLATFORM", "wayland")
        .env("MOZ_ENABLE_WAYLAND", "1")
        .env("SDL_VIDEODRIVER", "wayland")
        .env("CLUTTER_BACKEND", "wayland")
        .env("ELECTRON_OZONE_PLATFORM_HINT", "wayland")
        .env("XDG_SESSION_TYPE", "wayland")
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_SOCKET");
}

/// `launch {command}` (shell string), `{argv: [...]}` or `{desktopId}` → spawned pid.
/// `env: {K: V}` adds/overrides variables (null removes one).
pub fn launch(req: &Value, socket: &str) -> Result<std::process::Child, String> {
    let argv: Vec<String> = if let Some(a) = req.get("argv").and_then(|a| a.as_array()) {
        a.iter().filter_map(|s| s.as_str().map(String::from)).collect()
    } else if let Some(c) = req.get("command").and_then(|c| c.as_str()) {
        vec!["/bin/sh".into(), "-c".into(), c.into()]
    } else if let Some(id) = req.get("desktopId").and_then(|c| c.as_str()) {
        let e = find_desktop(id).ok_or_else(|| format!("no desktop entry {id}"))?;
        exec_argv(&e.exec)
    } else {
        return Err("command, argv or desktopId required".into());
    };
    let (prog, args) = argv.split_first().ok_or("empty command")?;
    let mut cmd = Command::new(prog);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit());
    wayland_env(&mut cmd, socket);
    if let Some(env) = req.get("env").and_then(|e| e.as_object()) {
        for (k, v) in env {
            match v.as_str() {
                Some(s) => cmd.env(k, s),
                None => cmd.env_remove(k),
            };
        }
    }
    if let Some(cwd) = req.get("cwd").and_then(|c| c.as_str()) {
        cmd.current_dir(cwd);
    }
    // Own session: a terminal-generated SIGINT/SIGHUP to the plugin's group shouldn't hit apps.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            // We block SIGTERM & co. for our sigwait thread; apps must not inherit that.
            let mut set: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut set);
            libc::pthread_sigmask(libc::SIG_SETMASK, &set, std::ptr::null_mut());
            Ok(())
        });
    }
    cmd.spawn().map_err(|e| format!("{prog}: {e}"))
}

pub struct DesktopEntry {
    pub id: String,
    pub name: String,
    pub exec: String,
    pub icon: String,
}

fn app_dirs() -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let data_home = std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| format!("{home}/.local/share"));
    let data_dirs = std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
    std::iter::once(data_home.as_str())
        .chain(data_dirs.split(':'))
        .chain(["/var/lib/flatpak/exports/share", &format!("{home}/.local/share/flatpak/exports/share")])
        .map(|d| PathBuf::from(d).join("applications"))
        .collect()
}

fn parse(id: String, text: &str) -> Option<DesktopEntry> {
    let mut in_main = false;
    let mut kv = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_main = line == "[Desktop Entry]";
            continue;
        }
        if !in_main {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            kv.entry(k.trim().to_string()).or_insert_with(|| v.trim().to_string());
        }
    }
    let yes = |k: &str| kv.get(k).is_some_and(|v| v == "true");
    if kv.get("Type").map(String::as_str) != Some("Application") || yes("NoDisplay") || yes("Hidden") || yes("Terminal") {
        return None;
    }
    Some(DesktopEntry {
        id,
        name: kv.get("Name")?.clone(),
        exec: kv.get("Exec")?.clone(),
        icon: kv.get("Icon").cloned().unwrap_or_default(),
    })
}

/// All visible apps; earlier dirs win for the same id (XDG precedence).
pub fn list() -> Vec<DesktopEntry> {
    let mut seen = std::collections::HashSet::new();
    let mut out = vec![];
    for dir in app_dirs() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".desktop") || !seen.insert(name.clone()) {
                continue;
            }
            if let Some(d) = std::fs::read_to_string(e.path()).ok().and_then(|t| parse(name, &t)) {
                out.push(d);
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

pub fn list_json() -> Value {
    Value::from(
        list()
            .into_iter()
            .map(|d| json!({"name": d.name, "desktopId": d.id, "bundleId": d.id, "exec": d.exec, "icon": d.icon}))
            .collect::<Vec<_>>(),
    )
}

fn find_desktop(id: &str) -> Option<DesktopEntry> {
    let file = if id.ends_with(".desktop") { id.to_string() } else { format!("{id}.desktop") };
    app_dirs().into_iter().find_map(|d| {
        let t = std::fs::read_to_string(d.join(&file)).ok()?;
        parse(file.clone(), &t)
    })
}

/// Desktop-entry Exec → argv: quotes, backslash escapes, field codes (%f %U …) dropped.
fn exec_argv(exec: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut has = false;
    let mut quoted = false;
    let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                has = true;
            }
            '\\' if quoted => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                }
            }
            '%' => match chars.next() {
                Some('%') => cur.push('%'),
                _ => {} // field codes expand to nothing: we never pass files/URLs
            },
            c if c.is_whitespace() && !quoted => {
                if has || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                has = false;
            }
            c => cur.push(c),
        }
    }
    if has || !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exec() {
        assert_eq!(exec_argv("foot %U"), vec!["foot"]);
        assert_eq!(exec_argv(r#"env A=1 "/opt/My App/app" --x %f"#), vec!["env", "A=1", "/opt/My App/app", "--x"]);
        assert_eq!(exec_argv("gtk4-demo"), vec!["gtk4-demo"]);
    }
}
