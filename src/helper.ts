/**
 * Client for the native helper (helper/macos: Swift, helper/linux: Rust). One process for
 * all app tiles. Protocol: JSON lines in; framed messages out
 * ([u32 BE len][u8 type][payload]; type 1 JSON, type 2 video packet (macOS), type 3 frame
 * ready (Linux: pixels are in a shared-memory file, see helper/linux/README.md)).
 *
 * macOS: a child process on stdin/stdout, gone with Obsidian (windows go back to your desktop).
 * Linux: a daemon on a unix socket, like tmux: the apps in your tiles live *inside* it (it is
 * their display), so it must outlive Obsidian. We connect, or start it and connect; closing
 * Obsidian or reloading the plugin only disconnects.
 */
import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

/** One frame of a Linux app window (type 3 message); `rects` = [x, y, w, h] × n. */
export interface FrameMsg {
	windowId: number;
	seq: number;
	width: number;
	height: number;
	stride: number;
	offset: number;
	rects: number[];
}

/** Where the Linux daemon listens: per vault, in the per-user runtime dir. */
export function helperSocketPath(vaultPath: string): string {
	const dir = process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : os.tmpdir();
	let h = 5381;
	for (const c of vaultPath) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
	return path.join(dir, `vivarium-helper-${h.toString(36)}.sock`);
}

interface Conn {
	write(s: string): void;
	alive(): boolean;
	close(): void;
}

export interface VideoPacket {
	keyframe: boolean;
	timestampUs: number;
	data: Uint8Array;
}

export interface StreamConfig {
	stream: number;
	codec: string;
	description: Uint8Array;
	width: number;
	height: number;
	windowWidth: number;
	windowHeight: number;
}

export interface StreamSink {
	onConfig(c: StreamConfig): void;
	onPacket(p: VideoPacket): void;
	onEvent(ev: string, msg: any): void;
}

export interface WindowInfo {
	windowId: number;
	pid: number;
	app: string;
	bundleId: string;
	title: string;
	width: number;
	height: number;
	onScreen: boolean;
}

export interface AppInfo {
	name: string;
	bundleId: string;
	path: string;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export function helperBinary(pluginDir: string): string | null {
	const name = process.platform === "darwin" ? "vivarium-helper-macos" : process.platform === "linux" ? `vivarium-helper-linux-${process.arch}` : null;
	if (!name) return null;
	const p = path.join(pluginDir, name);
	return fs.existsSync(p) ? p : null;
}

export class HelperClient {
	private proc: ChildProcess | null = null;
	private conn: Conn | null = null;
	private buf: Buffer = Buffer.alloc(0);
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private sinks = new Map<number, StreamSink>();
	private frameSinks = new Map<number, (f: FrameMsg) => void>();
	private nextStream = 1;
	private starting: Promise<any> | null = null;
	private listeners = new Set<(ev: string, msg: any) => void>();
	info: { platform: string; version: string; instance?: string; gpu?: any; permissions: { screen: boolean; accessibility: boolean } } | null = null;
	private disposed = false;

	/** `socketPath`: talk to (or start) the Linux daemon there instead of a child process. */
	constructor(private binary: string, private socketPath: string | null = null) {}

	ensure(): Promise<any> {
		if (this.conn?.alive() && this.info) return Promise.resolve(this.info);
		if (!this.starting) this.starting = this.start().finally(() => (this.starting = null));
		return this.starting;
	}

	private async start() {
		if (this.disposed) throw new Error("helper disposed");
		this.buf = Buffer.alloc(0);
		const conn = this.socketPath ? await this.connectDaemon(this.socketPath) : this.spawnChild();
		this.conn = conn;
		// Talk to *this* connection directly: going through request() would wait on ensure(), i.e.
		// on ourselves, and deadlock if the process dies during startup.
		const r = await this.requestOn(conn, "hello", {});
		this.info = r;
		return this.info;
	}

	private spawnChild(): Conn {
		const proc = spawn(this.binary, [], { stdio: ["pipe", "pipe", "pipe"] });
		this.proc = proc;
		proc.stdout!.on("data", (c: Buffer) => this.onData(c));
		proc.stderr!.on("data", (d) => console.debug("[vivarium-helper]", String(d).trim()));
		const conn: Conn = {
			write: (s) => proc.stdin!.write(s),
			alive: () => proc.exitCode === null && !proc.killed,
			close: () => {
				proc.stdin?.end();
				proc.kill();
			},
		};
		proc.on("exit", (code) => this.lost(conn, `helper exited (${code})`));
		return conn;
	}

	/** Connect to the daemon; start it if nobody answers. */
	private async connectDaemon(sockPath: string): Promise<Conn> {
		let sock = await connectUnix(sockPath).catch(() => null);
		if (!sock) {
			for (const how of daemonCommands(this.binary, sockPath)) {
				startDetached(how.cmd, how.args);
				for (let i = 0; i < 30 && !sock; i++) {
					await sleep(i < 10 ? 50 : 150);
					sock = await connectUnix(sockPath).catch(() => null);
				}
				if (sock) break;
			}
		}
		if (!sock) throw new Error(`the app helper didn't start (log: ${helperLogPath()})`);
		const s = sock;
		s.setNoDelay?.(true);
		s.on("data", (c: Buffer) => this.onData(c));
		const conn: Conn = {
			write: (line) => s.write(line),
			alive: () => !s.destroyed,
			close: () => s.end(),
		};
		s.on("close", () => this.lost(conn, "helper disconnected"));
		s.on("error", () => {});
		return conn;
	}

	/** The connection (or child) went away: fail what's pending, tell everyone. */
	private lost(conn: Conn, why: string) {
		if (this.conn !== conn) return;
		this.conn = null;
		this.proc = null;
		this.info = null;
		for (const p of this.pending.values()) p.reject(new Error(why));
		this.pending.clear();
		for (const [id, s] of this.sinks) s.onEvent("helper_exit", { stream: id });
		if (!this.disposed) for (const l of this.listeners) l("disconnected", { reason: why });
	}

	/** Permissions can change while we run (you toggle them in System Settings): ask again. */
	async refreshInfo() {
		await this.ensure();
		const r = await this.request("hello");
		this.info = r;
		return r as NonNullable<HelperClient["info"]>;
	}

	request(op: string, params: Record<string, any> = {}): Promise<any> {
		const conn = this.conn;
		if (!conn?.alive() || !this.info) return this.ensure().then(() => this.request(op, params));
		return this.requestOn(conn, op, params);
	}

	private requestOn(conn: Conn, op: string, params: Record<string, any>): Promise<any> {
		if (!conn.alive()) return Promise.reject(new Error("helper not running"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			conn.write(JSON.stringify({ id, op, ...params }) + "\n");
		}).then((r: any) => {
			if (!r.ok) throw new Error(r.error || `${op} failed`);
			return r;
		});
	}

	/** Fire-and-forget (input events, frame acks): no reply, minimal latency. */
	send(op: string, params: Record<string, any>) {
		if (this.conn?.alive()) this.conn.write(JSON.stringify({ op, ...params }) + "\n");
	}

	/** Frames of one window (Linux). Frames nobody takes are acked right away, or the window would stall. */
	onFrame(windowId: number, fn: (f: FrameMsg) => void): () => void {
		this.frameSinks.set(windowId, fn);
		return () => {
			if (this.frameSinks.get(windowId) === fn) this.frameSinks.delete(windowId);
		};
	}

	get connected() {
		return !!this.conn?.alive() && !!this.info;
	}

	onEvent(fn: (ev: string, msg: any) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	allocStream(sink: StreamSink): number {
		const id = this.nextStream++;
		this.sinks.set(id, sink);
		return id;
	}

	freeStream(id: number) {
		this.sinks.delete(id);
	}

	private onData(chunk: Buffer) {
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
		let off = 0;
		while (this.buf.length - off >= 5) {
			const len = this.buf.readUInt32BE(off);
			if (this.buf.length - off < 4 + len) break;
			const type = this.buf[off + 4];
			const payload = this.buf.subarray(off + 5, off + 4 + len);
			off += 4 + len;
			if (type === 3) this.onFrameMsg(payload);
			else if (type === 2) this.onVideo(payload);
			else if (type === 1) this.onJson(payload);
		}
		this.buf = off < this.buf.length ? Buffer.from(this.buf.subarray(off)) : Buffer.alloc(0);
	}

	private onFrameMsg(p: Buffer) {
		if (p.length < 32) return;
		const windowId = p.readUInt32BE(0), seq = p.readUInt32BE(4);
		const sink = this.frameSinks.get(windowId);
		if (!sink) {
			this.send("frame_ack", { windowId, seq });
			return;
		}
		const n = p.readUInt16BE(30);
		const rects: number[] = new Array(n * 4);
		for (let i = 0; i < n * 4 && 32 + i * 4 + 4 <= p.length; i++) rects[i] = p.readUInt32BE(32 + i * 4);
		sink({
			windowId, seq,
			width: p.readUInt32BE(8), height: p.readUInt32BE(12), stride: p.readUInt32BE(16),
			offset: Number(p.readBigUInt64BE(20)),
			rects,
		});
	}

	private onVideo(p: Buffer) {
		const stream = p.readUInt32BE(0);
		const sink = this.sinks.get(stream);
		if (!sink) return;
		const keyframe = (p[4] & 1) === 1;
		const ts = Number(p.readBigUInt64BE(5));
		// copy: the frame buffer is reused for the next chunk
		sink.onPacket({ keyframe, timestampUs: ts, data: new Uint8Array(p.subarray(13)) });
	}

	private onJson(p: Buffer) {
		let m: any;
		try {
			m = JSON.parse(p.toString("utf8"));
		} catch {
			return;
		}
		if (m.id !== undefined && this.pending.has(m.id)) {
			const pend = this.pending.get(m.id)!;
			this.pending.delete(m.id);
			pend.resolve(m);
			return;
		}
		if (!m.ev) return;
		if (m.ev === "stream_config") {
			const sink = this.sinks.get(m.stream);
			sink?.onConfig({ ...m, description: Uint8Array.from(Buffer.from(m.description, "base64")) });
			return;
		}
		if (m.stream !== undefined) this.sinks.get(m.stream)?.onEvent(m.ev, m);
		for (const l of this.listeners) l(m.ev, m);
	}

	/** Plugin unloads. A child (macOS) ends with us; the Linux daemon keeps the apps running. */
	dispose() {
		this.disposed = true;
		const c = this.conn;
		this.conn = null;
		c?.close();
		this.proc = null;
	}
}

export function helperLogPath() {
	return path.join(os.homedir(), ".vivarium", "helper.log");
}

/**
 * How to start the Linux daemon, best first. In its own systemd scope when there is a user
 * systemd: then it isn't part of Obsidian's (app) cgroup, so quitting Obsidian, or a desktop that
 * cleans up an app's processes when it quits, leaves it alone. Plain detached process otherwise.
 */
function daemonCommands(binary: string, sockPath: string): { cmd: string; args: string[] }[] {
	const args = ["--listen", sockPath];
	const out: { cmd: string; args: string[] }[] = [];
	const runtime = process.env.XDG_RUNTIME_DIR;
	const systemdRun = ["/usr/bin/systemd-run", "/bin/systemd-run"].find((p) => fs.existsSync(p));
	if (systemdRun && runtime && fs.existsSync(path.join(runtime, "systemd"))) {
		out.push({ cmd: systemdRun, args: ["--user", "--scope", "--quiet", "--collect", `--unit=vivarium-helper-${process.pid}-${Date.now()}`, "--", binary, ...args] });
	}
	out.push({ cmd: binary, args });
	return out;
}

function startDetached(cmd: string, args: string[]) {
	const log = helperLogPath();
	let fd: number | "ignore" = "ignore";
	try {
		fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
		// keep the log small: start over when it gets big
		if (fs.existsSync(log) && fs.statSync(log).size > 2_000_000) fs.truncateSync(log, 0);
		fd = fs.openSync(log, "a", 0o600);
	} catch {}
	const env = { ...process.env };
	delete env.VIVARIUM_TILE; // Obsidian may have been started from a tile; apps must not inherit that
	delete env.ELECTRON_RUN_AS_NODE;
	try {
		const child = spawn(cmd, args, { detached: true, stdio: ["ignore", fd, fd], env, cwd: os.homedir() });
		child.on("error", () => {});
		child.unref();
	} catch (e) {
		console.warn("[vivarium] starting helper", e);
	} finally {
		if (typeof fd === "number") fs.closeSync(fd);
	}
}

function connectUnix(p: string): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		if (!fs.existsSync(p)) return reject(new Error("no socket"));
		const s = net.createConnection(p);
		s.once("connect", () => {
			s.removeAllListeners("error");
			resolve(s);
		});
		s.once("error", reject);
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
