/**
 * TmuxHub: a single tmux control-mode client (`tmux -C`) that multiplexes every
 * program tile. Each tile is a tmux *window* (one pane) inside one session, so
 * the cost of N tiles is N tmux panes plus ONE client process and ONE pipe.
 *
 * Why control mode: no native modules (node-pty) needed, resize is a command,
 * output arrives as `%output %<pane> <octal-escaped bytes>`, and tmux can stop
 * sending output for panes we aren't showing (`refresh-client -A %p:off`).
 */
import { ChildProcess, execFile, spawn } from "child_process";
import * as fs from "fs";
import type { Launch } from "./core";

export const SESSION = "vivarium";
const HUB_WINDOW = "_hub";

export interface PaneInfo {
	tileId: string;
	windowId: string; // @3
	paneId: string; // %3
	dead: boolean;
}

export interface PaneState {
	cursorX: number;
	cursorY: number;
	alternate: boolean;
	cursorKeys: boolean; // DECCKM
	keypad: boolean;
	mouseAny: boolean;
	mouseButton: boolean;
	mouseStandard: boolean;
	mouseSgr: boolean;
	cursorVisible: boolean;
	height: number;
	width: number;
	/** Normal-screen cursor saved when the alternate screen was entered. */
	savedX: number;
	savedY: number;
}

/** `seq` increases by one for every %output line, so callers can order output against command replies. */
type OutputListener = (data: Uint8Array, seq: number) => void;

interface Pending {
	resolve: (lines: string[]) => void;
	reject: (err: Error) => void;
	lines: string[];
	seq?: number;
}

export function findTmux(configured: string): string | null {
	const candidates = [configured, "/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux", "/run/current-system/sw/bin/tmux"];
	for (const c of candidates) if (c && fs.existsSync(c)) return c;
	return null;
}

/** Quote an argument for the tmux command parser (double quotes; `$` and `~` would expand otherwise). */
export function tq(s: string): string {
	return '"' + s.replace(/[\\"$]/g, (m) => "\\" + m) + '"';
}

/** tq for arguments tmux expands as formats (new-window -n and -c): `#(cmd)` there would run cmd. */
export function tqLiteral(s: string): string {
	return tq(s.replace(/#/g, "##"));
}

/** Decode tmux's octal escaping (`\ooo` for bytes < 0x20 and backslash). Input is raw bytes. */
function decodeOctal(buf: Uint8Array, start: number, end: number): Uint8Array {
	const out = new Uint8Array(end - start);
	let o = 0;
	for (let i = start; i < end; i++) {
		const b = buf[i];
		if (b === 0x5c /* \ */ && i + 3 < end) {
			const d1 = buf[i + 1] - 48, d2 = buf[i + 2] - 48, d3 = buf[i + 3] - 48;
			if (d1 >= 0 && d1 < 8 && d2 >= 0 && d2 < 8 && d3 >= 0 && d3 < 8) {
				out[o++] = (d1 << 6) | (d2 << 3) | d3;
				i += 3;
				continue;
			}
		}
		out[o++] = b;
	}
	return out.subarray(0, o);
}

const PREFIX_OUTPUT = Buffer.from("%output %");
const PREFIX_EXTOUTPUT = Buffer.from("%extended-output %");

export class TmuxHub {
	private proc: ChildProcess | null = null;
	private queue: Pending[] = [];
	private current: Pending | null = null;
	private inBlock = false;
	private partial: Buffer | null = null;
	private listeners = new Map<string, Set<OutputListener>>(); // paneId -> listeners
	private panes = new Map<string, PaneInfo>(); // tileId -> pane
	private paneOutputOn = new Map<string, boolean>();
	private connecting: Promise<void> | null = null;
	private disposed = false;
	private decoder = new TextDecoder();
	/** Count of %output lines seen; see OutputListener. */
	outputSeq = 0;
	/** Called when a pane's dead-state or the window set changes. */
	onPanesChanged: () => void = () => {};
	/** Set while connect() runs on a spawned control client (see cmdSeq). */
	private connectingProc: ChildProcess | null = null;
	/** PID of the tmux server we're attached to: a different one after a reconnect means it died. */
	private serverPid: string | null = null;
	/** Why the last control client went away (tmux's %exit reason or its stderr), for error messages. */
	private exitReason = "";
	private reconnectTimer: number | null = null;
	/**
	 * The tmux server went away and a new one took its place: every program in it ended. Called
	 * once the new connection is up (the keeper brings the tiles that were running back).
	 */
	onServerRestarted: () => void = () => {};
	/** Exposed to programs as $VIVARIUM_VAULT so the CLI inside a tile talks to the right vault. */
	vaultName = "";
	/** Put first on every tile's PATH (where the vivarium CLI lives). */
	pathPrefix = "";
	/** The plugin's control socket, exposed as $VIVARIUM_SOCKET so the CLI in a tile talks to the right vault. */
	controlSocket = "";
	/**
	 * Linux: start the tmux server in its own systemd user scope instead of inside Obsidian's
	 * (the desktop puts each app in a scope, and stops it when you log out). With lingering
	 * enabled (`loginctl enable-linger`) programs then keep running after you log out.
	 */
	ownScope = false;

	constructor(private tmuxPath: string, private socket: string, private confPath: string) {}

	private args(...a: string[]): string[] {
		return ["-L", this.socket, "-f", this.confPath, ...a];
	}

	/** Run a one-off tmux command outside the control connection. */
	exec(...a: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile(this.tmuxPath, this.args(...a), { env: this.env() }, (err, stdout, stderr) => {
				if (err) reject(new Error(stderr || err.message));
				else resolve(stdout);
			});
		});
	}

	/** Run tmux in a fresh transient systemd user scope (see ownScope). */
	private execScoped(a: string[]): Promise<string> {
		const unit = `vivarium-tmux-${this.socket.replace(/[^\w-]/g, "_")}-${Date.now()}`;
		return new Promise((resolve, reject) => {
			execFile("systemd-run", ["--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, this.tmuxPath, ...this.args(...a)], { env: this.env(), timeout: 10_000 }, (err, stdout, stderr) => {
				if (err) reject(new Error(stderr || err.message));
				else resolve(stdout);
			});
		});
	}

	private env(): NodeJS.ProcessEnv {
		// Obsidian launched from the Dock has a minimal PATH; login shells inside panes fix PATH themselves,
		// but the tmux server itself should start with something sane.
		const env = { ...process.env };
		const extra = ["/opt/homebrew/bin", "/usr/local/bin", `${env.HOME}/.local/bin`];
		env.PATH = [...extra, env.PATH ?? "/usr/bin:/bin"].join(":");
		delete env.TMUX;
		return env;
	}

	ensureConnected(): Promise<void> {
		if (this.proc) return Promise.resolve();
		if (!this.connecting) {
			this.connecting = this.connect().finally(() => (this.connecting = null));
		}
		return this.connecting;
	}

	private async connect(): Promise<void> {
		if (this.disposed) throw new Error("hub disposed");
		// Create the session (idempotently) with a placeholder window so the session survives
		// when every tile is closed.
		// (-A on an existing session acts like attach and fails without a terminal: that's fine.)
		const newSession = ["new-session", "-A", "-d", "-s", SESSION, "-n", HUB_WINDOW, "sh -c 'while :; do sleep 86400; done'"];
		let created = "";
		const running = this.ownScope && (await this.exec("has-session", "-t", SESSION).then(() => true, () => false));
		if (this.ownScope && !running) {
			// the server forks from this client, so it lands in the new scope; fall back to a plain start
			created = await this.execScoped(newSession).then(
				() => "",
				(e: Error) => e.message.trim(),
			);
			if (created) console.warn("[vivarium] systemd-run failed, starting tmux normally:", created);
		}
		if (!this.ownScope || created) {
			created = await this.exec(...newSession).then(
				() => "",
				(e: Error) => e.message.trim(),
			);
		}
		// If the session doesn't exist now, tmux itself failed (e.g. its server crashed on start):
		// say so, rather than leaving tiles waiting on a server that isn't there.
		await this.exec("has-session", "-t", SESSION).catch(() => {
			throw new Error(created || "tmux could not create its session");
		});
		await this.exec("source-file", this.confPath).catch(() => {});
		const pid = (await this.exec("display-message", "-p", "-t", SESSION, "#{pid}").catch(() => "")).trim();
		const serverRestarted = !!pid && this.serverPid !== null && pid !== this.serverPid;
		if (pid) this.serverPid = pid;

		const proc = spawn(this.tmuxPath, this.args("-C", "attach-session", "-t", SESSION), {
			stdio: ["pipe", "pipe", "pipe"],
			env: this.env(),
		});
		this.proc = proc;
		this.connectingProc = proc;
		this.inBlock = false;
		this.partial = null; // a half line from a client that died must not prefix the new one's output
		this.exitReason = "";
		// Only the current client's output counts (a dead one can still flush its pipe).
		proc.stdout.on("data", (chunk: Buffer) => this.proc === proc && this.onData(chunk));
		proc.stderr.on("data", (d) => {
			const msg = String(d).trim();
			if (msg) this.exitReason = msg;
			console.warn("[vivarium] tmux:", msg);
		});
		proc.on("exit", (code, signal) => {
			if (this.proc !== proc) return;
			this.proc = null;
			const reason = this.exitReason || (signal ? `signal ${signal}` : `code ${code}`);
			console.warn(`[vivarium] tmux control client exited (${reason})`);
			const err = new Error(`tmux control client exited (${reason})`);
			this.current?.reject(err);
			this.current = null;
			for (const p of this.queue) p.reject(err);
			this.queue = [];
			this.paneOutputOn.clear();
			// Listeners stay registered; reconnect (and keep trying if tmux is down for a moment).
			if (!this.disposed) this.reconnectSoon(0);
		});

		try {
			// Pause panes whose output we fall >2s behind on, instead of buffering unboundedly in tmux.
			await this.cmd("refresh-client -f pause-after=3").catch(() => {});
			// Get notified when a pane dies (program exited, remain-on-exit keeps the window).
			await this.cmd(`refresh-client -B ${tq("dead:%*:#{pane_dead}")}`).catch(() => {});
			await this.refreshPanes();
			// Default: output off for every pane until a surface subscribes.
			for (const p of this.panes.values()) await this.setPaneOutput(p.paneId, this.listeners.has(p.paneId));
		} finally {
			this.connectingProc = null;
		}
		if (serverRestarted) {
			console.warn("[vivarium] the tmux server was replaced (it crashed or was killed)");
			window.setTimeout(() => this.onServerRestarted(), 0);
		}
	}

	private reconnectSoon(attempt: number) {
		if (this.disposed || this.reconnectTimer !== null || attempt > 20) return;
		const delay = [500, 1000, 2000, 5000][Math.min(attempt, 3)];
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			if (this.disposed || this.proc) return;
			this.ensureConnected()
				.then(() => this.resubscribeAll())
				.catch((e) => {
					console.warn("[vivarium] tmux reconnect failed", e);
					this.reconnectSoon(attempt + 1);
				});
		}, delay);
	}

	private async resubscribeAll() {
		await this.refreshPanes();
		for (const paneId of this.listeners.keys()) await this.setPaneOutput(paneId, true).catch(() => {});
	}

	/** Send a command over the control connection; resolves with its output lines. */
	cmd(command: string): Promise<string[]> {
		return this.cmdSeq(command).then((r) => r.lines);
	}

	/** Like cmd(), but also returns outputSeq at the moment the reply ended. */
	cmdSeq(command: string): Promise<{ lines: string[]; seq: number }> {
		const proc = this.proc;
		// The control client died while connect() itself was talking to it: waiting for a
		// reconnect here would wait on connect(), i.e. on ourselves.
		if (!proc && this.connectingProc) return Promise.reject(new Error(`tmux control client exited${this.exitReason ? ` (${this.exitReason})` : ""}`));
		if (!proc) return this.ensureConnected().then(() => this.cmdSeq(command));
		return new Promise((resolve, reject) => {
			const p: Pending = { resolve: (lines) => resolve({ lines, seq: p.seq ?? this.outputSeq }), reject, lines: [] };
			this.queue.push(p);
			proc.stdin!.write(command.replace(/\n/g, " ") + "\n");
		});
	}

	private onData(chunk: Buffer) {
		let buf = this.partial ? Buffer.concat([this.partial, chunk]) : chunk;
		let start = 0;
		for (;;) {
			const nl = buf.indexOf(0x0a, start);
			if (nl < 0) break;
			let end = nl;
			if (end > start && buf[end - 1] === 0x0d) end--;
			this.onLine(buf, start, end);
			start = nl + 1;
		}
		this.partial = start < buf.length ? Buffer.from(buf.subarray(start)) : null;
	}

	private onLine(buf: Buffer, start: number, end: number) {
		// Hot path first: %output lines, parsed as bytes without string conversion.
		if (buf[start] === 0x25 /* % */) {
			let pfxLen = 0;
			if (end - start > PREFIX_OUTPUT.length && buf.compare(PREFIX_OUTPUT, 0, PREFIX_OUTPUT.length, start, start + PREFIX_OUTPUT.length) === 0) pfxLen = PREFIX_OUTPUT.length;
			else if (buf.compare(PREFIX_EXTOUTPUT, 0, PREFIX_EXTOUTPUT.length, start, Math.min(end, start + PREFIX_EXTOUTPUT.length)) === 0) pfxLen = PREFIX_EXTOUTPUT.length;
			if (pfxLen) {
				const idStart = start + pfxLen - 1; // include '%'
				const sp = buf.indexOf(0x20, idStart);
				if (sp < 0 || sp > end) return;
				const paneId = buf.toString("latin1", idStart, sp);
				let dataStart = sp + 1;
				if (pfxLen === PREFIX_EXTOUTPUT.length) {
					// %extended-output %p <age> ... : <data>
					const colon = buf.indexOf(" : ", sp);
					if (colon < 0 || colon > end) return;
					dataStart = colon + 3;
				}
				const seq = ++this.outputSeq;
				const ls = this.listeners.get(paneId);
				if (ls && ls.size) {
					const data = decodeOctal(buf, dataStart, end);
					for (const l of ls) l(data, seq);
				}
				return;
			}
		}
		const line = this.decoder.decode(buf.subarray(start, end));
		if (line.startsWith("%begin")) {
			// `%begin <time> <num> <flags>`: flags=1 means the block answers one of our commands.
			const ours = line.split(" ")[3] === "1";
			this.inBlock = true;
			this.current = ours ? this.queue.shift() ?? null : null;
			return;
		}
		if (this.inBlock && (line.startsWith("%end") || line.startsWith("%error"))) {
			this.inBlock = false;
			const cur = this.current;
			this.current = null;
			if (!cur) return;
			cur.seq = this.outputSeq;
			if (line.startsWith("%error")) cur.reject(new Error(cur.lines.join("\n") || "tmux error"));
			else cur.resolve(cur.lines);
			return;
		}
		if (this.inBlock) {
			this.current?.lines.push(line);
			return;
		}
		if (line.startsWith("%pause ")) {
			// We fell behind; resume immediately (the surface resyncs on demand).
			const paneId = line.slice(7).trim();
			this.cmd(`refresh-client -A ${tq(paneId + ":continue")}`).catch(() => {});
			return;
		}
		if (line.startsWith("%subscription-changed dead") || line.startsWith("%window-close") || line.startsWith("%unlinked-window-close") || line.startsWith("%window-add") || line.startsWith("%unlinked-window-add")) {
			this.refreshPanesSoon();
			return;
		}
		if (line.startsWith("%exit")) {
			const reason = line.slice(5).trim();
			if (reason) this.exitReason = reason;
			this.proc?.kill();
		}
	}

	private refreshTimer: number | null = null;
	private refreshPanesSoon() {
		if (this.refreshTimer !== null) return;
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.refreshPanes().catch(() => {});
		}, 50);
	}

	async refreshPanes(): Promise<void> {
		const lines = await this.cmd(`list-windows -t ${tq(SESSION)} -F ${tq("#{window_name} #{window_id} #{pane_id} #{pane_dead}")}`);
		const next = new Map<string, PaneInfo>();
		for (const l of lines) {
			const [tileId, windowId, paneId, dead] = l.split(" ");
			if (!tileId || tileId === HUB_WINDOW) continue;
			next.set(tileId, { tileId, windowId, paneId, dead: dead === "1" });
		}
		this.panes = next;
		this.onPanesChanged();
	}

	get connected(): boolean {
		return this.proc !== null;
	}

	/** Per-tile process facts for the SessionKeeper (one tmux round trip). */
	async listPaneInfo(): Promise<{ tileId: string; paneId: string; panePid: number; cwd: string; command: string; dead: boolean; historySize: number; cursorY: number; activity: string }[]> {
		const lines = await this.cmd(
			`list-windows -t ${tq(SESSION)} -F ${tq("#{window_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_dead}\t#{history_size}\t#{cursor_y}\t#{window_activity}")}`,
		);
		return lines
			.map((l) => l.split("\t"))
			.filter((a) => a[0] && a[0] !== HUB_WINDOW)
			.map(([tileId, paneId, pid, cwd, command, dead, hist, cy, act]) => ({
				tileId, paneId, panePid: +pid, cwd, command, dead: dead === "1", historySize: +hist, cursorY: +cy, activity: act,
			}));
	}

	/** Recent output with colours, wrapped lines joined (so it reflows at any width). */
	async captureForSnapshot(paneId: string, lines: number): Promise<string> {
		const out = await this.cmd(`capture-pane -p -e -J -t ${tq(paneId)} -S ${-lines}`);
		// eslint-disable-next-line no-control-regex -- strips terminal colour codes (ESC [ … m)
		while (out.length && !out[out.length - 1].replace(/\x1b\[[0-9;]*m/g, "").trim()) out.pop();
		return out.join("\n") + "\n";
	}

	getPane(tileId: string): PaneInfo | undefined {
		return this.panes.get(tileId);
	}

	allPanes(): PaneInfo[] {
		return [...this.panes.values()];
	}

	/** Create the tmux window for a tile if it doesn't exist yet. */
	private creating = new Map<string, Promise<PaneInfo>>();

	/** One window per tile, even if a canvas and the startup restore ask at the same moment. */
	ensureWindow(tileId: string, launch: Launch, cwd: string, cols: number, rows: number): Promise<PaneInfo> {
		const inflight = this.creating.get(tileId);
		if (inflight) return inflight;
		const p = this.createWindow(tileId, launch, cwd, cols, rows).finally(() => this.creating.delete(tileId));
		this.creating.set(tileId, p);
		return p;
	}

	private async createWindow(tileId: string, launch: Launch, cwd: string, cols: number, rows: number): Promise<PaneInfo> {
		await this.ensureConnected();
		let pane = this.panes.get(tileId);
		if (pane) return pane;
		await this.refreshPanes();
		pane = this.panes.get(tileId);
		if (pane) return pane;
		const dir = cwd && fs.existsSync(cwd) ? cwd : process.env.HOME ?? "/";
		// Sizes are owned by the plugin (one tile = one size), not negotiated between clients. A new
		// window takes default-size (control clients don't count towards sizing), so the program
		// starts at its final size; then we pin it (window-size manual for that window only).
		await this.cmd(`set-option -g default-size ${cols}x${rows}`).catch(() => {});
		const lines = await this.cmd(
			`new-window -d -P -F ${tq("#{window_id} #{pane_id}")} -t ${tq(SESSION + ":")} -n ${tqLiteral(tileId)} -c ${tqLiteral(dir)} -e VIVARIUM_TILE=${tq(tileId)} -e VIVARIUM_VAULT=${tq(this.vaultName)} -e VIVARIUM_TMUX_SOCKET=${tq(this.socket)}${this.controlSocket ? ` -e VIVARIUM_SOCKET=${tq(this.controlSocket)}` : ""}${this.pathPrefix ? ` -e PATH=${tq(this.pathPrefix + ":" + this.env().PATH)}` : ""} ${tq(launch.command)}`,
		);
		const [windowId, paneId] = (lines[0] ?? "").split(" ");
		// Pin this window's size, so a terminal attaching to it (`vivarium attach`) doesn't resize it.
		await this.cmd(`set-option -w -t ${tq(windowId)} window-size manual`).catch(() => {});
		await this.cmd(`resize-window -t ${tq(windowId)} -x ${cols} -y ${rows}`).catch(() => {});
		pane = { tileId, windowId, paneId, dead: false };
		this.panes.set(tileId, pane);
		this.paneOutputOn.set(paneId, true); // new windows start with output on
		await this.typeIn(paneId, launch);
		return pane;
	}

	async killWindow(tileId: string): Promise<void> {
		const pane = this.panes.get(tileId);
		if (!pane) return;
		this.panes.delete(tileId);
		await this.cmd(`kill-window -t ${tq(pane.windowId)}`).catch(() => {});
	}

	private async typeIn(paneId: string, launch: Launch) {
		if (!launch.typeIn) return;
		// Wait for the shell's first output (its prompt), otherwise the tty echoes our typeahead
		// before the prompt and the command shows up twice.
		await new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				un();
				window.clearTimeout(timer);
				window.setTimeout(resolve, 40);
			};
			const un = this.subscribe(paneId, finish);
			const timer = window.setTimeout(finish, 3000);
		});
		await this.cmd(`send-keys -t ${tq(paneId)} -l ${tq(launch.typeIn)}`);
		await this.cmd(`send-keys -t ${tq(paneId)} Enter`);
	}

	/**
	 * Start a tile's program again in a new window. Not `respawn-pane`: tmux before 3.8 crashes
	 * (the whole server, every tile with it) when a respawned pane prints to a control-mode client
	 * (tmux issue 5498; Ubuntu 26.04 ships 3.6a). The window keeps its name, so the tile finds it.
	 */
	async respawn(tileId: string, launch: Launch, cwd: string): Promise<PaneInfo | null> {
		const pane = this.panes.get(tileId);
		if (!pane) return null;
		const size = await this.cmd(`display-message -p -t ${tq(pane.windowId)} ${tq("#{window_width} #{window_height}")}`).catch(() => [] as string[]);
		const [cols, rows] = (size[0] ?? "").split(" ").map((n) => parseInt(n, 10));
		await this.killWindow(tileId);
		return this.ensureWindow(tileId, launch, cwd, cols > 0 ? cols : 100, rows > 0 ? rows : 30);
	}

	async resize(pane: PaneInfo, cols: number, rows: number): Promise<void> {
		await this.cmd(`resize-window -t ${tq(pane.windowId)} -x ${cols} -y ${rows}`);
	}

	private async setPaneOutput(paneId: string, on: boolean): Promise<void> {
		if (this.paneOutputOn.get(paneId) === on) return;
		this.paneOutputOn.set(paneId, on);
		await this.cmd(`refresh-client -A ${tq(paneId + (on ? ":on" : ":off"))}`);
	}

	/** Subscribe to a pane's output. Turns tmux output for the pane on while anyone listens. */
	subscribe(paneId: string, listener: OutputListener): () => void {
		let set = this.listeners.get(paneId);
		if (!set) this.listeners.set(paneId, (set = new Set()));
		set.add(listener);
		this.setPaneOutput(paneId, true).catch(() => {});
		return () => {
			const s = this.listeners.get(paneId);
			if (!s) return;
			s.delete(listener);
			if (s.size === 0) {
				this.listeners.delete(paneId);
				if (this.proc) this.setPaneOutput(paneId, false).catch(() => {});
			}
		};
	}

	/** Write user input to a pane. ASCII goes as hex keys, other text as a UTF-8 literal. */
	sendInput(paneId: string, data: string): Promise<unknown> {
		const parts: string[] = [];
		let hex: string[] = [];
		let lit = "";
		const flushHex = () => {
			if (hex.length) parts.push(`send-keys -t ${tq(paneId)} -H ${hex.join(" ")}`);
			hex = [];
		};
		const flushLit = () => {
			if (lit) parts.push(`send-keys -t ${tq(paneId)} -l ${tq(lit)}`);
			lit = "";
		};
		for (const ch of data) {
			const cp = ch.codePointAt(0)!;
			if (cp < 0x80) {
				flushLit();
				hex.push(cp.toString(16).padStart(2, "0"));
				if (hex.length >= 256) flushHex();
			} else {
				flushHex();
				lit += ch;
				if (lit.length >= 256) flushLit();
			}
		}
		flushHex();
		flushLit();
		return Promise.all(parts.map((p) => this.cmd(p)));
	}

	/**
	 * Snapshot a pane for (re)painting a surface: screen + history with escapes, plus modes.
	 * `seq` is the outputSeq at the time of the screen capture: output with seq <= it is already
	 * contained in the snapshot, output after it is not.
	 */
	async capture(paneId: string, historyLines: number): Promise<{ text: string; normalText: string | null; state: PaneState; seq: number }> {
		const fmt =
			"#{cursor_x} #{cursor_y} #{alternate_on} #{keypad_cursor_flag} #{keypad_flag} #{mouse_any_flag} #{mouse_button_flag} #{mouse_standard_flag} #{mouse_sgr_flag} #{cursor_flag} #{pane_height} #{pane_width} #{alternate_saved_x} #{alternate_saved_y}";
		const t = tq(paneId);
		const stateP = this.cmd(`display-message -p -t ${t} ${tq(fmt)}`);
		const screenP = this.cmdSeq(`capture-pane -p -e -t ${t} -S ${-historyLines}`);
		// In alternate-screen mode (vim, less, TUIs) the plain capture is the alternate screen and
		// `-a` gives the normal screen underneath, which reappears when the app exits.
		const normalP = this.cmd(`capture-pane -p -e -a -q -t ${t}`);
		const [stateLines, screen, normal] = await Promise.all([stateP, screenP, normalP]);
		const n = (stateLines[0] ?? "").split(" ").map((x) => parseInt(x, 10) || 0);
		const state: PaneState = {
			cursorX: n[0], cursorY: n[1], alternate: n[2] === 1, cursorKeys: n[3] === 1, keypad: n[4] === 1,
			mouseAny: n[5] === 1, mouseButton: n[6] === 1, mouseStandard: n[7] === 1, mouseSgr: n[8] === 1,
			cursorVisible: n[9] === 1, height: n[10], width: n[11], savedX: n[12], savedY: n[13],
		};
		// capture -e starts each line from default attributes; make xterm do the same.
		const join = (lines: string[]) => lines.map((l) => "\x1b[0m" + l).join("\r\n");
		return { text: join(screen.lines), normalText: state.alternate && normal.length ? join(normal) : null, state, seq: screen.seq };
	}

	async capturePlain(paneId: string, lines: number): Promise<string> {
		return (await this.cmd(`capture-pane -p -t ${tq(paneId)} -S ${-lines}`)).join("\n");
	}

	dispose() {
		this.disposed = true;
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
		// Detach only: the tmux server and every program keep running across Obsidian restarts.
		this.proc?.stdin?.end();
		this.proc?.kill();
		this.proc = null;
	}
}
