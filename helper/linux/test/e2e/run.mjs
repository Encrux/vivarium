// End-to-end on Linux: real Obsidian (Xvfb, software GL) + the plugin + the helper daemon + foot.
//   helper/linux/scripts/test-e2e.sh
// Checks: a .window tile shows its app (WebGL frames), typing reaches the app, quitting and
// reopening Obsidian re-attaches the tile to the *same* running app, after a "logout" (Obsidian
// and helper killed) the app is started again, and closing the app leaves the tile closed.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const PORT = 9333;
const VAULT = "/tmp/e2e/vault";
const UD = "/tmp/e2e/userdata";
const OUT = "/src/test/out/e2e";
const TILE = "tile-e2e";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok: !!ok, detail });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
};
async function until(fn, ms = 20000, every = 200) {
	const t = Date.now();
	while (Date.now() - t < ms) {
		try {
			const v = await fn();
			if (v) return v;
		} catch {}
		await sleep(every);
	}
	return null;
}
const pgrep = (pat) => { try { return execFileSync("pgrep", ["-f", pat], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number); } catch { return []; } };

// ---------------------------------------------------------------- vault

function writeVault() {
	fs.rmSync("/tmp/e2e", { recursive: true, force: true });
	const w = (p, s) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s));
	const plug = path.join(VAULT, ".obsidian/plugins/vivarium");
	fs.mkdirSync(plug, { recursive: true });
	for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join("/plugin", f), path.join(plug, f));
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	fs.copyFileSync("/src/target/release/vivarium-helper-linux", path.join(plug, `vivarium-helper-linux-${arch}`));
	fs.chmodSync(path.join(plug, `vivarium-helper-linux-${arch}`), 0o755);
	w(path.join(plug, "data.json"), JSON.stringify({ socketName: "vivarium-e2e" }));
	w(path.join(VAULT, ".obsidian/community-plugins.json"), JSON.stringify(["vivarium"]));
	w(path.join(VAULT, ".obsidian/core-plugins.json"), JSON.stringify(["file-explorer", "canvas"]));
	w(path.join(VAULT, ".obsidian/app.json"), JSON.stringify({ nativeMenus: false }));
	w(path.join(VAULT, "Vivarium/Foot.window"), JSON.stringify({ version: 1, id: TILE, kind: "app", title: "Foot", app: { name: "Foot", bundleId: "foot" } }, null, 2));
	w(path.join(VAULT, "Test.canvas"), JSON.stringify({ nodes: [{ id: "n1", type: "file", file: "Vivarium/Foot.window", x: -320, y: -200, width: 640, height: 400 }], edges: [] }));
	fs.mkdirSync(UD, { recursive: true });
	w(path.join(UD, "obsidian.json"), JSON.stringify({ vaults: { e2ee2ee2ee2ee2e0: { path: VAULT, ts: Date.now(), open: true } }, updateDisabled: true }));
	fs.mkdirSync(OUT, { recursive: true });
}

// ---------------------------------------------------------------- Obsidian + CDP

let obsidian = null;
function startObsidian() {
	obsidian = spawn("xvfb-run", ["-a", "-s", "-screen 0 1400x900x24", "/opt/obsidian/obsidian", "--no-sandbox", `--user-data-dir=${UD}`, `--remote-debugging-port=${PORT}`, "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"], {
		stdio: ["ignore", "ignore", "pipe"],
		env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
	});
	obsidian.stderr.on("data", (d) => { if (process.env.E2E_VERBOSE) process.stderr.write(d); });
}
async function stopObsidian() {
	const pids = pgrep("/opt/obsidian/obsidian");
	for (const p of pids) try { process.kill(p, "SIGTERM"); } catch {}
	await until(() => pgrep("/opt/obsidian/obsidian").length === 0, 10000);
	for (const p of pgrep("/opt/obsidian/obsidian")) try { process.kill(p, "SIGKILL"); } catch {}
	await sleep(500);
}

class CDP {
	static async connect() {
		for (let i = 0; i < 150; i++) {
			try {
				const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
				const page = list.find((t) => t.type === "page" && t.url.startsWith("app://"));
				if (page) {
					const c = new CDP(new WebSocket(page.webSocketDebuggerUrl));
					await new Promise((r, j) => { c.ws.addEventListener("open", r, { once: true }); c.ws.addEventListener("error", j, { once: true }); });
					await c.send("Runtime.enable");
					return c;
				}
			} catch {}
			await sleep(300);
		}
		throw new Error("no Obsidian page on CDP");
	}
	constructor(ws) {
		this.ws = ws;
		this.id = 1;
		this.pending = new Map();
		ws.addEventListener("message", (e) => {
			const m = JSON.parse(e.data);
			if (m.id && this.pending.has(m.id)) {
				const p = this.pending.get(m.id);
				this.pending.delete(m.id);
				m.error ? p.j(new Error(m.error.message)) : p.r(m.result);
			}
		});
	}
	send(method, params = {}) {
		const id = this.id++;
		return new Promise((r, j) => { this.pending.set(id, { r, j }); this.ws.send(JSON.stringify({ id, method, params })); });
	}
	async eval(body) {
		const r = await this.send("Runtime.evaluate", { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
		return r.result.value;
	}
	close() { try { this.ws.close(); } catch {} }
}

async function openVault() {
	startObsidian();
	const cdp = await CDP.connect();
	await until(() => cdp.eval(`return !!(window.app && app.workspace && app.workspace.layoutReady)`), 30000);
	// restricted mode prompt on first open of the vault
	for (let i = 0; i < 30; i++) {
		if (await cdp.eval(`return !!app.plugins?.plugins?.vivarium`)) break;
		await cdp.eval(`const b = [...document.querySelectorAll("button")].find((b) => /Trust author/i.test(b.textContent)); b?.click();`);
		await sleep(400);
	}
	await until(() => cdp.eval(`return !!app.plugins?.plugins?.vivarium?.core`), 20000);
	await cdp.eval(`document.querySelectorAll(".modal-close-button").forEach((b) => b.click())`);
	return cdp;
}

async function openCanvas(cdp) {
	await cdp.eval(`await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath("Test.canvas")); return true;`);
}

/** The tile's state: status text, canvas size, tile rect, per-device state. */
async function tile(cdp) {
	return cdp.eval(`
		const el = document.querySelector(".vivarium-window.is-linux");
		if (!el) return null;
		const c = el.querySelector("canvas"), s = el.querySelector(".vivarium-window-status");
		const r = c.getBoundingClientRect();
		const core = app.plugins.plugins.vivarium.core;
		return { status: s && s.style.display !== "none" ? s.textContent : "", w: c.width, h: c.height, cssW: el.clientWidth, cssH: el.clientHeight,
			rect: { x: r.left, y: r.top, width: r.width, height: r.height }, state: core.tileState("${TILE}"),
			instance: core.helper?.info?.instance ?? null };`);
}

// ---------------------------------------------------------------- pixels

function decodePng(buf) {
	let off = 8, w = 0, h = 0, ct = 0;
	const idat = [];
	while (off < buf.length) {
		const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
		if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
		if (type === "IDAT") idat.push(data);
		off += 12 + len;
	}
	const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(w * h * 4);
	let prev = Buffer.alloc(stride);
	for (let y = 0; y < h; y++) {
		const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
		for (let i = 0; i < stride; i++) {
			const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
			const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
			line[i] = (line[i] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
		}
		for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) out[(y * w + x) * 4 + k] = k < bpp ? line[x * bpp + k] : 255;
		prev = line;
	}
	return { w, h, px: out };
}

/** Screenshot of the tile's picture; how much of it isn't the background colour. */
async function shot(cdp, name) {
	const t = await tile(cdp);
	const r = t.rect;
	const res = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: r.x + 2, y: r.y + 2, width: r.width - 4, height: r.height - 4, scale: 1 } });
	const buf = Buffer.from(res.data, "base64");
	fs.writeFileSync(path.join(OUT, `${name}.png`), buf);
	const img = decodePng(buf);
	const counts = new Map();
	for (let i = 0; i < img.px.length; i += 4 * 3) {
		const k = (img.px[i] >> 3) << 10 | (img.px[i + 1] >> 3) << 5 | (img.px[i + 2] >> 3);
		counts.set(k, (counts.get(k) || 0) + 1);
	}
	const total = img.px.length / 12, top = Math.max(...counts.values());
	return { img, colors: counts.size, nonBackground: 1 - top / total };
}
function diffShots(a, b) {
	let d = 0;
	const n = Math.min(a.img.px.length, b.img.px.length);
	for (let i = 0; i < n; i += 4) if (Math.abs(a.img.px[i] - b.img.px[i]) + Math.abs(a.img.px[i + 1] - b.img.px[i + 1]) + Math.abs(a.img.px[i + 2] - b.img.px[i + 2]) > 30) d++;
	return d / (n / 4);
}

async function clickTile(cdp, fx = 0.5, fy = 0.5) {
	const t = await tile(cdp);
	const x = t.rect.x + t.rect.width * fx, y = t.rect.y + t.rect.height * fy;
	for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}
async function typeText(cdp, text) {
	for (const ch of text) {
		const enter = ch === "\n";
		const code = enter ? "Enter" : ch === " " ? "Space" : /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : /\d/.test(ch) ? `Digit${ch}` : ch === "_" ? "Minus" : "";
		const shift = /[A-Z_]/.test(ch);
		if (shift) await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: "ShiftLeft", key: "Shift", modifiers: 8 });
		await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", code, key: enter ? "Enter" : ch, text: enter ? "\r" : ch, modifiers: shift ? 8 : 0 });
		await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code, key: enter ? "Enter" : ch, modifiers: shift ? 8 : 0 });
		if (shift) await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code: "ShiftLeft", key: "Shift" });
		await sleep(15);
	}
}

// ---------------------------------------------------------------- the test

writeVault();
let cdp;
try {
	// 1. first open: the helper daemon starts, the tile launches foot and shows it
	cdp = await openVault();
	const t0 = Date.now();
	await openCanvas(cdp);
	const shown = await until(async () => { const t = await tile(cdp); return t && !t.status && t.w > 0 ? t : null; }, 30000);
	check("tile shows the app", !!shown, shown ? `${Date.now() - t0} ms from opening the canvas, frame ${shown.w}×${shown.h}, tile ${Math.round(shown.rect.width)}×${Math.round(shown.rect.height)}` : JSON.stringify(await tile(cdp)));
	await sleep(1500);
	const s1 = await shot(cdp, "1-shown");
	check("picture has content", s1.nonBackground > 0.002 && s1.colors > 2, `${(s1.nonBackground * 100).toFixed(2)}% non-background, ${s1.colors} colours`);
	const daemons = pgrep("vivarium-helper-linux.*--listen");
	const foots = pgrep("^foot");
	check("one helper daemon, one foot", daemons.length === 1 && foots.length === 1, `daemons ${daemons}, foot ${foots}`);
	check("window size = tile size (CSS px)", shown && Math.abs(shown.w - shown.cssW) <= 2 && Math.abs(shown.h - shown.cssH) <= 2, shown ? `frame ${shown.w}×${shown.h}, tile ${shown.cssW}×${shown.cssH}` : "");
	// resize the card: the app follows once you let go
	await cdp.eval(`const leaf = app.workspace.getLeavesOfType("canvas")[0]; const c = leaf.view.canvas; const n = [...c.nodes.values()][0];
		n.moveAndResize({ x: n.x, y: n.y, width: 800, height: 500 }); return true;`);
	const resized = await until(async () => { const t = await tile(cdp); return Math.abs(t.w - t.cssW) <= 2 && Math.abs(t.h - t.cssH) <= 2 && t.cssW > 700 ? t : null; }, 8000);
	check("resizing the card resizes the app", !!resized, resized ? `frame ${resized.w}×${resized.h}, tile ${resized.cssW}×${resized.cssH}` : JSON.stringify(await tile(cdp)));

	// 2. typing reaches the app: select the card, then click into the picture and type
	await clickTile(cdp);
	await sleep(400);
	await clickTile(cdp);
	await sleep(300);
	const focused = await cdp.eval(`return document.activeElement?.classList.contains("vivarium-window-canvas") ?? false`);
	await typeText(cdp, "echo VIVARIUM_E2E_OK\n");
	await sleep(1200);
	const s2 = await shot(cdp, "2-typed");
	check("typing reaches the app", focused && diffShots(s1, s2) > 0.003, `focused ${focused}, ${(diffShots(s1, s2) * 100).toFixed(2)}% of the picture changed`);

	// 3. quit and reopen Obsidian: same daemon, same foot, the tile re-attaches
	const before = await tile(cdp);
	cdp.close();
	await stopObsidian();
	check("app survives Obsidian quitting", pgrep("^foot").join() === foots.join() && pgrep("vivarium-helper-linux.*--listen").join() === daemons.join());
	cdp = await openVault();
	await openCanvas(cdp);
	const again = await until(async () => { const t = await tile(cdp); return t && !t.status && t.w > 0 ? t : null; }, 30000);
	await sleep(1000);
	const s3 = again ? await shot(cdp, "3-reopened") : null;
	check("reopened Obsidian re-attaches to the same window", again && again.state.windowId === before.state.windowId && again.instance === before.instance && pgrep("^foot").join() === foots.join(),
		again ? `window ${again.state.windowId} (was ${before.state.windowId}), helper run ${again.instance} (was ${before.instance}), foot ${pgrep("^foot")} (was ${foots}), picture ${(s3.nonBackground * 100).toFixed(2)}% non-background, ${s3 ? (diffShots(s2, s3) * 100).toFixed(2) : "?"}% different from before quitting` : JSON.stringify(await tile(cdp)));

	// 4. "logout": Obsidian and the helper (and so foot) are killed; next start reopens the app
	cdp.close();
	await stopObsidian();
	for (const p of pgrep("vivarium-helper-linux.*--listen")) process.kill(p, "SIGTERM");
	await until(() => pgrep("vivarium-helper-linux.*--listen").length === 0 && pgrep("^foot").length === 0, 8000);
	check("logout simulated (helper + app gone)", pgrep("^foot").length === 0);
	cdp = await openVault();
	// no canvas opened: restoreLinuxApps starts it by itself
	const restarted = await until(() => pgrep("^foot").length === 1, 20000);
	check("after the logout the app is started again (canvas not even open)", !!restarted);
	await openCanvas(cdp);
	const back = await until(async () => { const t = await tile(cdp); return t && !t.status && t.w > 0 ? t : null; }, 30000);
	check("…and its tile shows it", !!back && back.instance !== before.instance && pgrep("^foot").length === 1, back ? `new helper run ${back.instance}` : JSON.stringify(await tile(cdp)));

	// 5. closing the app (exit in foot) leaves the tile closed, and it stays closed
	await sleep(800);
	await clickTile(cdp);
	await sleep(300);
	await clickTile(cdp);
	await sleep(300);
	await typeText(cdp, "exit\n");
	const closed = await until(async () => { const t = await tile(cdp); return t && /closed/i.test(t.status) ? t : null; }, 10000);
	check("closing the app → tile says closed, won't reopen by itself", !!closed && closed.state.open === false, closed ? closed.status : JSON.stringify(await tile(cdp)));
} catch (e) {
	check("no exceptions", false, e.stack || String(e));
} finally {
	try { if (cdp) { const r = await cdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, "last.png"), Buffer.from(r.data, "base64")); } } catch {}
	cdp?.close();
	await stopObsidian();
	for (const p of pgrep("vivarium-helper-linux.*--listen")) try { process.kill(p, "SIGTERM"); } catch {}
	fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));
	const failed = results.filter((r) => !r.ok).length;
	console.log(failed ? `${failed} FAILED` : "all ok");
	process.exit(failed ? 1 : 0);
}
