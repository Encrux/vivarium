/**
 * Client for the native helper (helper/macos: Swift, helper/linux: Rust). One process for
 * all app tiles. Protocol: JSON lines to stdin; framed messages from stdout
 * ([u32 BE len][u8 type][payload]; type 1 JSON, type 2 video packet).
 */
import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

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
	private buf: Buffer = Buffer.alloc(0);
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private sinks = new Map<number, StreamSink>();
	private nextStream = 1;
	private starting: Promise<any> | null = null;
	private listeners = new Set<(ev: string, msg: any) => void>();
	info: { platform: string; version: string; permissions: { screen: boolean; accessibility: boolean } } | null = null;
	private disposed = false;

	constructor(private binary: string) {}

	ensure(): Promise<any> {
		if (this.proc && this.info) return Promise.resolve(this.info);
		if (!this.starting) this.starting = this.start().finally(() => (this.starting = null));
		return this.starting;
	}

	private async start() {
		if (this.disposed) throw new Error("helper disposed");
		const proc = spawn(this.binary, [], { stdio: ["pipe", "pipe", "pipe"] });
		this.proc = proc;
		this.buf = Buffer.alloc(0);
		proc.stdout!.on("data", (c: Buffer) => this.onData(c));
		proc.stderr!.on("data", (d) => console.debug("[vivarium-helper]", String(d).trim()));
		proc.on("exit", (code) => {
			if (this.proc !== proc) return;
			this.proc = null;
			this.info = null;
			for (const p of this.pending.values()) p.reject(new Error(`helper exited (${code})`));
			this.pending.clear();
			for (const [id, s] of this.sinks) s.onEvent("helper_exit", { stream: id });
		});
		// Talk to *this* process directly: going through request() would wait on ensure(), i.e. on
		// ourselves, and deadlock if the process dies during startup.
		const r = await this.requestOn(proc, "hello", {});
		this.info = r;
		return this.info;
	}

	/** Permissions can change while we run (you toggle them in System Settings): ask again. */
	async refreshInfo() {
		await this.ensure();
		const r = await this.request("hello");
		this.info = r;
		return r as NonNullable<HelperClient["info"]>;
	}

	request(op: string, params: Record<string, any> = {}): Promise<any> {
		const proc = this.proc;
		if (!proc || !this.info) return this.ensure().then(() => this.request(op, params));
		return this.requestOn(proc, op, params);
	}

	private requestOn(proc: ChildProcess, op: string, params: Record<string, any>): Promise<any> {
		if (proc.exitCode !== null || proc.killed) return Promise.reject(new Error("helper not running"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			proc.stdin!.write(JSON.stringify({ id, op, ...params }) + "\n");
		}).then((r: any) => {
			if (!r.ok) throw new Error(r.error || `${op} failed`);
			return r;
		});
	}

	/** Fire-and-forget (input events): no reply, minimal latency. */
	send(op: string, params: Record<string, any>) {
		this.proc?.stdin!.write(JSON.stringify({ op, ...params }) + "\n");
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
			if (type === 2) this.onVideo(payload);
			else if (type === 1) this.onJson(payload);
		}
		this.buf = off < this.buf.length ? Buffer.from(this.buf.subarray(off)) : Buffer.alloc(0);
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

	dispose() {
		this.disposed = true;
		this.proc?.stdin?.end();
		this.proc?.kill();
		this.proc = null;
	}
}
