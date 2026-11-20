// The daemon mode with the plugin's real client (src/helper.ts, bundled by scripts/test-daemon.sh):
// apps survive the plugin going away, frames pause without a client, a reconnecting plugin gets
// the windows (with their tile tags) back, a second client replaces the first, SIGTERM cleans up,
// an unused daemon exits by itself.
//   node test/daemon.mjs        (in the Docker image; needs test/out/helper-client.mjs)
import fs from "node:fs";
import path from "node:path";
import { HelperClient } from "./out/helper-client.mjs";

const BIN = path.resolve(process.env.HELPER_BIN || "target/release/vivarium-helper-linux");
const SOCK = path.join(process.env.XDG_RUNTIME_DIR || "/tmp", "vivarium-helper-test.sock");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok: !!ok, detail });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
};
// a zombie counts as gone: in the container nobody reaps orphans (PID 1 is a shell); systemd does on a desktop
const alive = (pid) => {
	try { process.kill(pid, 0); } catch { return false; }
	try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
};
const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(50); } return null; };

/** Frames of one window: read the changed rows like linuxwindow.ts does, ack, count. */
function watchFrames(client, windowId) {
	const st = { fd: null, frames: 0, last: null, fullFrames: 0, pixels: Buffer.alloc(0) };
	const off1 = client.onEvent((ev, m) => {
		if (ev === "frame_buffer" && m.windowId === windowId) { if (st.fd !== null) fs.closeSync(st.fd); st.fd = fs.openSync(m.path, "r"); }
	});
	const off2 = client.onFrame(windowId, (f) => {
		if (st.pixels.length < f.stride * f.height) st.pixels = Buffer.alloc(f.stride * f.height);
		for (let i = 0; i < f.rects.length; i += 4) {
			const y = f.rects[i + 1], h = f.rects[i + 3];
			if (st.fd !== null) fs.readSync(st.fd, st.pixels, y * f.stride, h * f.stride, f.offset + y * f.stride);
		}
		client.send("frame_ack", { windowId, seq: f.seq });
		const covered = f.rects.length === 4 && f.rects[0] === 0 && f.rects[1] === 0 && f.rects[2] === f.width && f.rects[3] === f.height;
		if (covered) st.fullFrames++;
		st.frames++;
		st.last = { ...f, at: performance.now() };
	});
	st.stop = () => { off1(); off2(); if (st.fd !== null) fs.closeSync(st.fd); };
	return st;
}

try { fs.unlinkSync(SOCK); } catch {}

// 1. first connect starts the daemon
const t0 = performance.now();
const c1 = new HelperClient(BIN, SOCK);
const info = await c1.ensure();
check("connect starts the daemon", info?.platform === "linux" && info.instance && fs.existsSync(SOCK), `${Math.round(performance.now() - t0)} ms, instance ${info?.instance}, gpu ${JSON.stringify(info?.gpu)}`);
const daemonPid = info.pid;

// 2. an app launched for a tile carries the tile's tag
const added = new Promise((res) => c1.onEvent((ev, m) => ev === "window_added" && res(m)));
const { pid: appPid } = await c1.request("launch", { argv: ["foot", "-o", "cursor.blink=no"], env: { VIVARIUM_TILE: "tile-A" }, width: 640, height: 400 });
const win = await Promise.race([added, sleep(15000).then(() => null)]);
check("window_added has the tile tag", win?.tag === "tile-A", JSON.stringify({ windowId: win?.windowId, tag: win?.tag, app: win?.app }));
const listed = (await c1.request("list_windows")).windows;
check("list_windows has the tag", listed.some((w) => w.windowId === win.windowId && w.tag === "tile-A"));

// 3. frames over the socket, key → frame latency
let fw = watchFrames(c1, win.windowId);
await c1.request("set_visible", { windowId: win.windowId, visible: true });
await until(() => fw.frames > 0);
await sleep(500);
const lat = [];
for (let i = 0; i < 20; i++) {
	const before = fw.frames;
	const ts = performance.now();
	c1.send("key", { windowId: win.windowId, code: i % 2 ? "Backspace" : "KeyA", down: true });
	c1.send("key", { windowId: win.windowId, code: i % 2 ? "Backspace" : "KeyA", down: false });
	if (await until(() => fw.frames > before, 2000)) lat.push(fw.last.at - ts);
	await sleep(60);
}
lat.sort((a, b) => a - b);
check("frames over the socket", fw.frames > 0 && lat.length >= 15, `${fw.frames} frames, key→frame median ${lat[lat.length >> 1]?.toFixed(2)} ms, p95 ${lat[Math.floor(lat.length * 0.95)]?.toFixed(2)} ms (n=${lat.length})`);
fw.stop();

// 4. the plugin goes away (Obsidian quits): daemon and app live on
c1.dispose();
await sleep(1500);
check("daemon survives the client", alive(daemonPid) && fs.existsSync(SOCK));
check("app survives the client", alive(appPid));

// 5. a new plugin connects: same daemon, windows announced with tags, paused until visible
const c2 = new HelperClient(BIN, SOCK);
const announced = [];
c2.onEvent((ev, m) => ev === "window_added" && announced.push(m));
const info2 = await c2.ensure();
check("reconnects to the same daemon", info2.instance === info.instance && info2.pid === daemonPid);
await until(() => announced.length, 3000);
check("windows re-announced with tags", announced.some((w) => w.windowId === win.windowId && w.tag === "tile-A"));
fw = watchFrames(c2, win.windowId);
c2.send("key", { windowId: win.windowId, code: "KeyB", down: true });
c2.send("key", { windowId: win.windowId, code: "KeyB", down: false });
await sleep(700);
check("no frames until a tile shows it", fw.frames === 0, `${fw.frames} frames`);
// Like a tile binding after the connect-time announcements: it learns the frame file when it
// makes the window visible (set_visible re-sends frame_buffer), so it can read the full frame.
await c2.request("set_visible", { windowId: win.windowId, visible: true });
const gotFull = await until(() => fw.frames > 0 && fw.fullFrames > 0 && fw.fd !== null, 3000);
const lit = fw.pixels.some((b, i) => i % 4 !== 3 && b !== 0);
check("visible again → frame file + a full frame", !!gotFull && lit, `${fw.frames} frames, ${fw.fullFrames} full, file ${fw.fd !== null}, has pixels ${lit}`);

// 6. another client (a second Obsidian window/plugin reload race) replaces the first
let c2lost = false;
c2.onEvent((ev) => ev === "disconnected" && (c2lost = true));
const c3 = new HelperClient(BIN, SOCK);
await c3.ensure();
await until(() => c2lost, 3000);
check("newer client replaces the older", c2lost);
fw.stop();

// 7. SIGTERM (logout/shutdown): apps lose their display, files and socket are cleaned up
let c3lost = false;
c3.onEvent((ev) => ev === "disconnected" && (c3lost = true));
process.kill(daemonPid, "SIGTERM");
await until(() => !alive(daemonPid), 5000);
await until(() => c3lost, 3000);
await until(() => !alive(appPid), 5000);
const leftovers = fs.readdirSync("/dev/shm").filter((f) => f.startsWith(`vivarium-${daemonPid}-`));
check("SIGTERM: daemon gone, client told, app gone, nothing left", !alive(daemonPid) && c3lost && !alive(appPid) && !fs.existsSync(SOCK) && leftovers.length === 0, `app alive ${alive(appPid)}, socket ${fs.existsSync(SOCK)}, shm files ${leftovers.length}`);
c3.dispose();

// 8. a daemon nobody uses (no client, no windows, no apps) exits by itself
process.env.VIVARIUM_IDLE_EXIT = "3";
const c4 = new HelperClient(BIN, SOCK);
const info4 = await c4.ensure();
c4.dispose();
const exited = await until(() => !alive(info4.pid), 12000);
check("idle daemon exits", !!exited && !fs.existsSync(SOCK));

const failed = results.filter((r) => !r.ok);
fs.mkdirSync("test/out", { recursive: true });
fs.writeFileSync("test/out/daemon.json", JSON.stringify({ results }, null, 1));
console.log(failed.length ? `${failed.length} FAILED` : "all ok");
process.exit(failed.length ? 1 : 0);
