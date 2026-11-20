#!/usr/bin/env node
// End-to-end test + measurements for the Linux helper. Plays the plugin's role: spawns the
// helper, launches real apps on its Wayland socket, reads their shm frames the way the plugin
// will (fs.readSync of the damaged rows into a reused Buffer), acks frames, sends input.
//
//   node test/harness.mjs [--app gtk4-demo|gtk3-demo|foot|all] [--out DIR] [--bin PATH]
//
// Writes PNGs of the frames to --out (default test/out) and prints a JSON summary at the end.
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
	process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1] ?? true]] : a), []),
);
const BIN = args.bin || path.join(here, "..", "target", "release", "vivarium-helper-linux");
const OUT = args.out || path.join(here, "out");
const W = 1280, H = 800;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };
const r2 = (x) => Math.round(x * 100) / 100;
const has = (cmd) => { try { execFileSync("sh", ["-c", `command -v ${cmd}`]); return true; } catch { return false; } };

// ---------- helper client (same framing as src/helper.ts) ----------
class Helper {
	constructor(bin) {
		this.proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
		this.buf = Buffer.alloc(0);
		this.nextId = 1;
		this.pending = new Map();
		this.events = [];
		this.waiters = [];
		this.windows = new Map(); // windowId → { fd, path, w, h, stride, pixels, seq, frames, lastFrameAt }
		this.autoAck = true;
		this.readNs = 0n;
		this.readBytes = 0;
		this.proc.stdout.on("data", (c) => this.onData(c));
		this.proc.stderr.on("data", (d) => { if (args.verbose) process.stderr.write(d); });
		this.proc.on("exit", (code) => { this.exited = code; });
	}
	onData(chunk) {
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
		let off = 0;
		while (this.buf.length - off >= 5) {
			const len = this.buf.readUInt32BE(off);
			if (this.buf.length - off < 4 + len) break;
			const type = this.buf[off + 4];
			const p = this.buf.subarray(off + 5, off + 4 + len);
			off += 4 + len;
			if (type === 1) this.onJson(JSON.parse(p.toString("utf8")));
			else if (type === 3) this.onFrame(p);
		}
		this.buf = off < this.buf.length ? Buffer.from(this.buf.subarray(off)) : Buffer.alloc(0);
	}
	onJson(m) {
		if (m.id !== undefined && this.pending.has(m.id)) {
			const r = this.pending.get(m.id);
			this.pending.delete(m.id);
			return m.ok ? r.resolve(m) : r.reject(new Error(m.error));
		}
		if (m.ev === "frame_buffer") {
			const w = this.win(m.windowId);
			if (w.fd !== undefined) fs.closeSync(w.fd);
			w.fd = fs.openSync(m.path, "r");
			w.path = m.path;
		}
		this.emit({ kind: "event", ...m });
	}
	win(id) {
		if (!this.windows.has(id)) this.windows.set(id, { frames: 0, seq: 0, pixels: null, w: 0, h: 0 });
		return this.windows.get(id);
	}
	onFrame(p) {
		const t = now();
		const id = p.readUInt32BE(0), seq = p.readUInt32BE(4), w = p.readUInt32BE(8), h = p.readUInt32BE(12);
		const stride = p.readUInt32BE(16), offset = Number(p.readBigUInt64BE(20)), n = p.readUInt16BE(30);
		const rects = [];
		for (let i = 0; i < n; i++) rects.push([0, 4, 8, 12].map((o) => p.readUInt32BE(32 + i * 16 + o)));
		const win = this.win(id);
		if (!win.pixels || win.w !== w || win.h !== h) {
			win.pixels = Buffer.alloc(stride * h); // reused across frames
			win.w = w; win.h = h; win.stride = stride;
		}
		// The plugin's read path: only the damaged rows, one contiguous readSync per rect.
		const t0 = process.hrtime.bigint();
		for (const [, y, , rh] of rects) {
			fs.readSync(win.fd, win.pixels, y * stride, rh * stride, offset + y * stride);
			this.readBytes += rh * stride;
		}
		this.readNs += process.hrtime.bigint() - t0;
		win.seq = seq; win.frames++; win.lastFrameAt = t; win.offset = offset;
		if (this.autoAck) this.send("frame_ack", { windowId: id, seq });
		this.emit({ kind: "frame", windowId: id, seq, w, h, rects, t });
	}
	emit(e) {
		this.events.push(e);
		this.waiters = this.waiters.filter((wt) => (wt.pred(e) ? (wt.resolve(e), false) : true));
	}
	waitFor(pred, ms = 10000, what = "event") {
		return new Promise((resolve, reject) => {
			const wt = { pred, resolve };
			this.waiters.push(wt);
			setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== wt); reject(new Error(`timeout waiting for ${what}`)); }, ms);
		});
	}
	request(op, params = {}) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.proc.stdin.write(JSON.stringify({ id, op, ...params }) + "\n");
		});
	}
	send(op, params) { this.proc.stdin.write(JSON.stringify({ op, ...params }) + "\n"); }
	close() { this.proc.stdin.end(); }
}

// ---------- tiny PNG writer (BGRA premultiplied → RGBA) ----------
function writePng(file, pixels, w, h, stride) {
	const raw = Buffer.alloc((w * 4 + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (w * 4 + 1)] = 0;
		for (let x = 0; x < w; x++) {
			const s = y * stride + x * 4, d = y * (w * 4 + 1) + 1 + x * 4;
			const a = pixels[s + 3], un = (v) => (a === 0 ? 0 : Math.min(255, Math.round((v * 255) / a)));
			raw[d] = un(pixels[s + 2]); raw[d + 1] = un(pixels[s + 1]); raw[d + 2] = un(pixels[s]); raw[d + 3] = a;
		}
	}
	const chunk = (type, data) => {
		const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
	fs.writeFileSync(file, Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 3 })), chunk("IEND", Buffer.alloc(0)),
	]));
}

// ---------- CPU accounting from /proc ----------
const CLK = Number(execFileSync("getconf", ["CLK_TCK"]).toString().trim());
function cpuTicks(pid) {
	try {
		const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
		// utime + stime + cutime + cstime (fields 14-17): children that exited count too
		return Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14]);
	} catch { return NaN; }
}
/** CPU % (of one core) of the given pids over `ms`, plus frames published meanwhile. */
async function measureCpu(h, pids, ms, windowId) {
	const before = pids.map(cpuTicks), f0 = h.win(windowId).frames, t0 = now();
	await sleep(ms);
	const dt = (now() - t0) / 1000;
	// a short-lived child that is gone by now reads as NaN: its time is in its parent's cutime
	const cpu = pids.map((p, i) => ((cpuTicks(p) - before[i]) / CLK / dt) * 100).map((x) => (Number.isFinite(x) ? x : 0));
	return {
		helperCpuPct: r2(cpu[0]),
		appCpuPct: r2(cpu.slice(1).reduce((a, b) => a + b, 0)),
		framesPerSec: r2((h.win(windowId).frames - f0) / dt),
	};
}
function descendants(pid) {
	// the app may be a shell wrapper; count its children too
	try {
		const kids = execFileSync("sh", ["-c", `cat /proc/${pid}/task/*/children 2>/dev/null`]).toString().trim().split(/\s+/).filter(Boolean).map(Number);
		return [pid, ...kids.flatMap(descendants)];
	} catch { return [pid]; }
}

// ---------- the read path, measured on its own ----------
function benchRead() {
	const stride = W * 4, bytes = stride * H;
	const file = path.join("/dev/shm", `vivarium-bench-${process.pid}`);
	fs.writeFileSync(file, Buffer.alloc(4096 + 2 * bytes, 7));
	const fd = fs.openSync(file, "r");
	const buf = Buffer.alloc(bytes);
	const time = (n, fn) => { const t = []; for (let i = 0; i < n; i++) { const a = process.hrtime.bigint(); fn(i); t.push(Number(process.hrtime.bigint() - a) / 1e6); } return t; };
	time(20, () => fs.readSync(fd, buf, 0, bytes, 4096)); // warm up
	const full = time(300, (i) => fs.readSync(fd, buf, 0, bytes, 4096 + (i & 1) * bytes));
	const rows = time(300, (i) => fs.readSync(fd, buf, 0, 40 * stride, 4096 + 100 * stride)); // a 40-row damage band
	const viaMap = time(50, () => { const b = fs.readFileSync(file); return b.length; }); // what NOT to do
	fs.closeSync(fd); fs.unlinkSync(file);
	return {
		frame: `${W}x${H} BGRA (${(bytes / 1048576).toFixed(2)} MiB)`,
		fullReadMs: { median: r2(median(full)), p95: r2(pct(full, 0.95)) },
		fullReadGBps: r2(bytes / (median(full) / 1000) / 1e9),
		rows40ReadMs: { median: r2(median(rows) * 1000) / 1000 },
		readFileSyncWholeFileMs: r2(median(viaMap)),
	};
}

// ---------- per-app scenario ----------
const APPS = {
	// GTK4's default renderer (GL; on a compositor without dmabuf that is Mesa llvmpipe, i.e. CPU)
	"gtk4-demo": { argv: ["gtk4-demo"], env: {}, keys: ["ArrowDown", "ArrowUp"], click: [700, 400], menu: [1115, 22] },
	// GTK4 with its cairo (plain CPU, damage-tracked) renderer
	"gtk4-demo-cairo": { argv: ["gtk4-demo"], env: { GSK_RENDERER: "cairo" }, keys: ["ArrowDown", "ArrowUp"], click: [700, 400], menu: [1115, 22] },
	"gtk3-demo": { argv: ["gtk3-demo"], env: {}, keys: ["ArrowDown", "ArrowUp"], click: [700, 400] },
	// foot: type characters, each one is a redraw of a few cells
	foot: { argv: ["foot", "-o", "cursor.blink=no"], env: {}, keys: ["KeyA", "KeyB", "KeyC", "Backspace"], click: [300, 300] },
	// a terminal that prints continuously: an app that never stops drawing on its own
	"foot-busy": { argv: ["foot", "-o", "cursor.blink=no", "sh", "-c", "while :; do date +%s.%N; sleep 0.005; done"], env: {}, keys: [], click: null },
};

async function scenario(h, name) {
	const spec = APPS[name];
	const res = { app: name };
	const before = new Set([...h.windows.keys()]);
	const tLaunch = now();
	// HARNESS_APP_ENV='{"WAYLAND_DEBUG":"1"}' adds variables to every launched app
	const env = { ...spec.env, ...JSON.parse(process.env.HARNESS_APP_ENV || "{}") };
	const { pid } = await h.request("launch", { argv: spec.argv, env, width: W, height: H });
	const added = await h.waitFor((e) => e.ev === "window_added" && e.pid === pid, 15000, `${name} window`);
	const id = added.windowId;
	// Windows the test didn't ask for (dialogs, demo windows): hidden, as the plugin would do
	// for windows no tile claims.
	const extra = new Set();
	const onExtra = (e) => {
		if (e.ev === "window_added" && e.pid === pid && e.windowId !== id) {
			extra.add(e.windowId);
			h.request("set_visible", { windowId: e.windowId, visible: false }).catch(() => {});
		}
		return false;
	};
	h.waitFor(onExtra, 600000, "").catch(() => {});
	res.window = { id, title: added.title, appId: added.appId, size: [added.width, added.height] };
	await h.waitFor((e) => e.kind === "frame" && e.windowId === id, 10000, `${name} first frame`);
	res.launchToFirstFrameMs = Math.round(now() - tLaunch);
	await sleep(1500); // let it settle (fonts, icons, first layout passes)
	const win = h.win(id);
	res.frameSize = [win.w, win.h];
	writePng(path.join(OUT, `${name}-0.png`), win.pixels, win.w, win.h, win.stride);
	const snapshot = Buffer.from(win.pixels);
	const pids = [h.proc.pid, ...descendants(pid)];

	// Input → frame latency: send a key (or click), time until the next frame_ready.
	const lat = [];
	const inputs = spec.keys.length ? spec.keys : [];
	for (let i = 0; i < 30 && inputs.length; i++) {
		const code = inputs[i % inputs.length];
		await sleep(60); // apart, so each frame is caused by one input
		const seq0 = win.seq, t0 = now();
		h.send("key", { windowId: id, code, down: true });
		h.send("key", { windowId: id, code, down: false });
		try {
			const f = await h.waitFor((e) => e.kind === "frame" && e.windowId === id && e.seq > seq0, 2000, "frame after key");
			lat.push(f.t - t0);
		} catch { /* no visible change for this key */ }
	}
	if (lat.length) res.keyToFrameMs = { n: lat.length, median: r2(median(lat)), p95: r2(pct(lat, 0.95)), min: r2(Math.min(...lat)) };
	if (spec.click) {
		const cl = [];
		for (let i = 0; i < 6; i++) {
			await sleep(150);
			const seq0 = win.seq, t0 = now();
			h.send("mouse", { windowId: id, kind: "down", x: spec.click[0], y: spec.click[1] + (i % 2) * 40, button: 0 });
			h.send("mouse", { windowId: id, kind: "up", x: spec.click[0], y: spec.click[1] + (i % 2) * 40, button: 0 });
			try {
				const f = await h.waitFor((e) => e.kind === "frame" && e.windowId === id && e.seq > seq0, 2000, "frame after click");
				cl.push(f.t - t0);
			} catch {}
		}
		if (cl.length) res.clickToFrameMs = { n: cl.length, median: r2(median(cl)), min: r2(Math.min(...cl)) };
	}
	await sleep(500);
	writePng(path.join(OUT, `${name}-1.png`), win.pixels, win.w, win.h, win.stride);

	// A menu (xdg_popup with a grab): it must show up inside the window's frame, and a click
	// outside must close it again.
	if (spec.menu) {
		const before = Buffer.from(win.pixels);
		h.send("mouse", { windowId: id, kind: "down", x: spec.menu[0], y: spec.menu[1], button: 0 });
		h.send("mouse", { windowId: id, kind: "up", x: spec.menu[0], y: spec.menu[1], button: 0 });
		await sleep(1000);
		writePng(path.join(OUT, `${name}-menu.png`), win.pixels, win.w, win.h, win.stride);
		let n = 0;
		for (let i = 0; i < before.length; i += 4) if (before.readUInt32LE(i) !== win.pixels.readUInt32LE(i)) n++;
		res.menuPixelsChanged = n;
		h.send("mouse", { windowId: id, kind: "down", x: 600, y: 500, button: 0 });
		h.send("mouse", { windowId: id, kind: "up", x: 600, y: 500, button: 0 });
		await sleep(800);
		let m = 0;
		for (let i = 0; i < before.length; i += 4) if (before.readUInt32LE(i) !== win.pixels.readUInt32LE(i)) m++;
		res.menuClosedPixelsStillDifferent = m;
	}
	let changed = 0;
	for (let i = 0; i < snapshot.length; i += 4) if (snapshot.readUInt32LE(i) !== win.pixels.readUInt32LE(i)) changed++;
	res.pixelsChangedByInput = changed;
	res.frameChanged = changed > 0 || (spec.keys.length === 0);

	// Resize: configure → new frame at the new size.
	await h.request("resize", { windowId: id, width: 900, height: 600 });
	const rf = await h.waitFor((e) => e.kind === "frame" && e.windowId === id && e.w === 900, 5000, "resized frame").catch(() => null);
	res.resizeOk = !!rf;
	if (rf) writePng(path.join(OUT, `${name}-resized.png`), win.pixels, win.w, win.h, win.stride);
	await h.request("resize", { windowId: id, width: W, height: H });
	await h.waitFor((e) => e.kind === "frame" && e.windowId === id && e.w === W, 5000, "resized back").catch(() => null);
	await sleep(800);

	// CPU while visible & idle, then hidden. Idle starts 11 s after the last input: GTK blinks
	// (and animates) the text cursor for 10 s after typing.
	const tail = h.events.filter((e) => e.kind === "frame" && e.windowId === id).slice(-4);
	res.sampleDamage = tail.map((e) => e.rects);
	res.justAfterInput = await measureCpu(h, pids, 3000, id);
	await sleep(8000);
	res.idleVisible = await measureCpu(h, pids, 4000, id);
	writePng(path.join(OUT, `${name}-idle.png`), win.pixels, win.w, win.h, win.stride);
	await h.request("set_visible", { windowId: id, visible: false });
	await sleep(300);
	res.hidden = await measureCpu(h, pids, 4000, id);
	const unhidden = h.waitFor((e) => e.kind === "frame" && e.windowId === id, 3000, "frame after unhide").catch(() => null);
	await h.request("set_visible", { windowId: id, visible: true });
	const back = await unhidden;
	res.unhideFullFrame = back ? back.rects.some(([x, y, w, hh]) => x === 0 && y === 0 && w === win.w && hh === win.h) : false;

	const st = await h.request("stats", { windowId: id }).catch(() => null);
	if (st) res.helperStats = st.stats;

	res.extraWindows = extra.size;
	for (const x of extra) await h.request("close", { windowId: x }).catch(() => {});
	await h.request("close", { windowId: id });
	await h.waitFor((e) => e.ev === "window_removed" && e.windowId === id, 5000, "window_removed").then(() => (res.closeOk = true)).catch(() => (res.closeOk = false));
	try { process.kill(-pid, "SIGKILL"); } catch {}
	try { process.kill(pid, "SIGKILL"); } catch {}
	await sleep(300);
	return res;
}

async function main() {
	const summary = { arch: process.arch, node: process.version, read: benchRead(), apps: [] };
	const h = new Helper(BIN);
	const ready = await h.waitFor((e) => e.ev === "ready", 5000, "ready");
	summary.socket = ready.socket;
	const hello = await h.request("hello");
	summary.hello = { platform: hello.platform, version: hello.version };
	const want = args.app && args.app !== "all" ? [args.app] : Object.keys(APPS);
	for (const name of want) {
		if (!has(APPS[name].argv[0])) { summary.apps.push({ app: name, skipped: "not installed" }); continue; }
		try {
			const r = await scenario(h, name);
			summary.apps.push(r);
			console.error(`[harness] ${name}: ok`);
		} catch (e) {
			summary.apps.push({ app: name, error: String(e.message || e) });
			console.error(`[harness] ${name}: ${e.message}`);
		}
	}
	summary.readPathTotal = { bytes: h.readBytes, ms: r2(Number(h.readNs) / 1e6) };
	const list = await h.request("list_windows");
	summary.leftoverWindows = list.windows.length;
	h.close();
	await sleep(300);
	summary.helperExitedOnStdinClose = h.exited !== undefined;
	summary.shmFilesLeft = fs.readdirSync("/dev/shm").filter((f) => f.startsWith(`vivarium-${h.proc.pid}-`)).length;
	// keep number arrays on one line
	const text = JSON.stringify(summary, null, 2).replace(/\[\s+([-\d.,\s]+?)\s+\]/g, (_, a) => `[${a.split(/,\s*/).join(", ")}]`);
	fs.writeFileSync(path.join(OUT, "summary.json"), text);
	console.log(text);
	const failed = summary.apps.filter((a) => a.error || (a.frameChanged === false));
	process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
