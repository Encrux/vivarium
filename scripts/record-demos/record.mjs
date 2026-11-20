#!/usr/bin/env node
// Records the README demos (docs/media/*.mp4 + *.gif) in an isolated Obsidian instance.
//
//   npm run build && node scripts/record-demos/record.mjs [hero] [agents] [zoom]
//
// - Its own Obsidian profile (--user-data-dir), demo vault and tmux socket: nothing of yours is
//   opened, shown or touched. No app helper is installed, so the picker lists no real windows.
// - Driven over the Chrome DevTools Protocol; frames come from the page itself (Page.startScreencast),
//   so nothing else on the screen is recorded. A drawn cursor shows where the "user" points.
// - The agents demo is a real Claude Code run (Haiku; needs `claude` logged in). Waiting is sped up
//   and marked as such in the video's corner.
// macOS only (it starts /Applications/Obsidian.app).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "docs/media");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "vivarium-rec-"));
const DEMO = "/Users/Shared/vivarium-demo"; // short, neutral path: it shows up in prompts
const APP_DIR = path.join(DEMO, "app");
const VAULT = path.join(DEMO, "vault");
const SOCKET = "vivarium-demo";
const PORT = 9339;
const W = 1280, H = 800;
const OBSIDIAN = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const CLAUDE = "claude --model haiku"; // permissions: the demo project's .claude/settings.json

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[rec]", ...a);
const tmux = (...a) => execFileSync("tmux", ["-L", SOCKET, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

// ---------------------------------------------------------------- demo content

function writeDemo() {
	fs.rmSync(DEMO, { recursive: true, force: true });
	const w = (f, s) => (fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, s));

	// A tiny app with a dev server (no dependencies).
	w(path.join(APP_DIR, "package.json"), JSON.stringify({ name: "orbit", version: "0.1.0", private: true, scripts: { dev: "node server.js" } }, null, 2) + "\n");
	w(path.join(APP_DIR, "server.js"), `const http = require("http");
const fs = require("fs");

const port = 5173;
http.createServer((req, res) => {
  const t0 = Date.now();
  res.setHeader("content-type", "text/html");
  res.end(fs.readFileSync(__dirname + "/index.html"));
  console.log(\`  \\x1b[2m\${new Date().toLocaleTimeString()}\\x1b[0m GET \${req.url} \\x1b[32m200\\x1b[0m \${Date.now() - t0}ms\`);
}).listen(port, () => {
  console.log("\\n  \\x1b[1;35morbit\\x1b[0m dev server\\n");
  console.log(\`  ➜ Local:   \\x1b[36mhttp://localhost:\${port}/\\x1b[0m\`);
  console.log("  ➜ press Ctrl+C to stop\\n");
});
`);
	w(path.join(APP_DIR, "index.html"), `<!doctype html><meta charset="utf-8"><title>Orbit</title>
<style>
  body{margin:0;font:15px/1.4 -apple-system,system-ui,sans-serif;background:#0f1117;color:#e6e6ef;padding:28px}
  h1{font-size:22px;margin:0 0 4px}.sub{color:#8b8fa3;margin-bottom:22px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  .card{background:#171a23;border:1px solid #262a37;border-radius:12px;padding:16px}
  .k{color:#8b8fa3;font-size:12px;text-transform:uppercase;letter-spacing:.06em}.v{font-size:28px;font-weight:600;margin-top:6px}
  .up{color:#4ade80;font-size:13px}.chart{grid-column:1/-1;height:150px}
</style>
<h1>Orbit</h1><div class="sub">Service status · last 24 h</div>
<div class="grid">
  <div class="card"><div class="k">Requests</div><div class="v">1.28M</div><div class="up">▲ 12%</div></div>
  <div class="card"><div class="k">p95 latency</div><div class="v">84 ms</div><div class="up">▼ 9 ms</div></div>
  <div class="card"><div class="k">Errors</div><div class="v">0.02%</div><div class="up">stable</div></div>
  <div class="card chart"><svg viewBox="0 0 600 120" width="100%" height="100%" preserveAspectRatio="none">
    <polyline fill="none" stroke="#a78bfa" stroke-width="3" points="0,90 50,80 100,84 150,60 200,66 250,48 300,52 350,38 400,44 450,30 500,36 550,22 600,26"/>
    <polyline fill="none" stroke="#38bdf8" stroke-width="2" opacity=".6" points="0,100 50,96 100,98 150,90 200,92 250,84 300,88 350,80 400,82 450,76 500,78 550,70 600,72"/>
  </svg></div>
</div>`);
	// What the agents may do without asking, for this throwaway project only (forks inherit it).
	w(path.join(APP_DIR, ".claude/settings.json"), JSON.stringify({
		permissions: { defaultMode: "acceptEdits", allow: ["Bash(vivarium:*)", "Bash(curl:*)", "Bash(node:*)", "Bash(ls:*)", "Bash(cat:*)"] },
	}, null, 2));
	w(path.join(APP_DIR, "README.md"), "# Orbit\n\nA tiny status dashboard. `npm run dev` serves it on http://localhost:5173.\n");
	// A clean prompt for the demo shells (your own shell config isn't loaded).
	w(path.join(DEMO, "zdotdir/.zshrc"), `PROMPT='%F{141}%1~%f %F{245}❯%f '\nexport CLICOLOR=1\n`);

	// The vault
	const tiles = path.join(VAULT, "Vivarium");
	const term = (id, title, command) => w(path.join(tiles, `${title}.term`), JSON.stringify({ version: 1, id, title, command, cwd: APP_DIR }, null, 2) + "\n");
	const web = (id, title, url) => w(path.join(tiles, `${title}.web`), JSON.stringify({ version: 1, id, kind: "web", title, url }, null, 2) + "\n");
	const canvas = (name, nodes, edges = []) => w(path.join(VAULT, `${name}.canvas`), JSON.stringify({ nodes, edges }, null, "\t"));
	const text = (id, x, y, width, height, t, color) => ({ id, type: "text", x, y, width, height, text: t, ...(color ? { color } : {}) });
	const file = (id, x, y, width, height, f) => ({ id, type: "file", x, y, width, height, file: f });
	const group = (id, x, y, width, height, label) => ({ id, type: "group", x, y, width, height, label });

	// hero: a plan next to empty space where the programs go
	canvas("Orbit", [
		text("plan", -560, -220, 300, 440, "# Orbit\n\nStatus dashboard for our services.\n\n## This week\n- [x] Metrics cards\n- [ ] Latency chart\n- [ ] `/health` endpoint\n\n## Run it\n`npm run dev` → http://localhost:5173", "6"),
	]);

	// agents: Claude Code in a tile, with room to its right
	term("tagent01", "Claude Code", CLAUDE);
	canvas("Agents", [file("agent", -700, -260, 620, 460, "Vivarium/Claude Code.term")]);

	// zoom: a workspace of groups, with live tiles in one of them
	term("tclock01", "Build watch", `while :; do printf '\\033[2J\\033[H\\033[1;35mbuild\\033[0m  watching src/  ·  %s\\n\\n' "$(date +%T)"; for f in server.js index.html README.md package.json; do printf '  \\033[32m✓\\033[0m %-12s %sms\\n' "$f" $((RANDOM % 40 + 3)); done; sleep 1; done`);
	web("borbit01", "Orbit preview", "http://localhost:5173");
	term("tserve01", "orbit server", "npm run dev");
	const topics = {
		"Orbit": ["Roadmap", "API design", "Metrics", "On-call", "Release notes", "Incidents"],
		"Research": ["Reading list", "Experiments", "Results", "Ideas", "Datasets", "Benchmarks", "Notes", "Paper draft", "Related work"],
		"Writing": ["Blog: canvas", "Blog: tmux", "Newsletter", "Talk outline", "Drafts", "Edits"],
		"Admin": ["Travel", "Budget", "Hiring", "1:1 notes", "Team offsite", "Reviews"],
	};
	const nodes = [];
	const gx = [0, 2000], gy = [0, 1500];
	Object.entries(topics).forEach(([label, cards], gi) => {
		const ox = gx[gi % 2], oy = gy[Math.floor(gi / 2)];
		nodes.push(group(`g${gi}`, ox, oy, 1800, 1300, label));
		cards.forEach((c, i) => nodes.push(text(`c${gi}-${i}`, ox + 60 + (i % 3) * 580, oy + 60 + Math.floor(i / 3) * 290, 520, 230, `# ${c}\n\nNotes, links and todos for this topic.\n- [ ] next step\n- [x] done`)));
	});
	// Orbit's group: two rows of notes, then the live tiles
	nodes.push(file("live1", 60, 700, 560, 520, "Vivarium/orbit server.term"));
	nodes.push(file("live2", 660, 700, 520, 520, "Vivarium/Build watch.term"));
	nodes.push(file("live3", 1220, 700, 520, 520, "Vivarium/Orbit preview.web"));
	canvas("Workspace", nodes);

	// Obsidian config: the plugin, dark theme, no sidebars
	const obs = path.join(VAULT, ".obsidian");
	const plug = path.join(obs, "plugins/vivarium");
	const build = path.join(ROOT, "dev-vault/.obsidian/plugins/vivarium");
	for (const f of ["main.js", "manifest.json", "styles.css", "vivarium", "SKILL.md"]) {
		if (!fs.existsSync(path.join(build, f))) throw new Error(`missing ${f}: run npm run build first`);
		w(path.join(plug, f), fs.readFileSync(path.join(build, f)));
	}
	fs.chmodSync(path.join(plug, "vivarium"), 0o755);
	w(path.join(plug, "data.json"), JSON.stringify({
		socketName: SOCKET, tileFolder: "Vivarium", defaultCwd: APP_DIR, fontSize: 14, tileWidth: 480, tileHeight: 330,
		programs: [
			{ name: "Shell", command: "", cwd: "" },
			{ name: "Claude Code", command: "claude", cwd: "" },
			{ name: "Codex", command: "codex --no-alt-screen", cwd: "" },
			{ name: "htop", command: "htop", cwd: "" },
		],
	}, null, 2));
	w(path.join(obs, "community-plugins.json"), JSON.stringify(["vivarium"]));
	w(path.join(obs, "appearance.json"), JSON.stringify({ theme: "obsidian", accentColor: "#8b6cf6" }));
	w(path.join(obs, "app.json"), JSON.stringify({ showViewHeader: true, alwaysUpdateLinks: true, nativeMenus: false }));
	w(path.join(obs, "core-plugins.json"), JSON.stringify(["file-explorer", "canvas", "command-palette"]));

	// An isolated Obsidian profile that opens this vault (with the newest app version you have).
	const ud = path.join(WORK, "userdata");
	fs.mkdirSync(ud, { recursive: true });
	const real = path.join(os.homedir(), "Library/Application Support/obsidian");
	const asar = fs.readdirSync(real).filter((f) => /^obsidian-[\d.]+\.asar$/.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
	if (asar) fs.copyFileSync(path.join(real, asar), path.join(ud, asar));
	fs.writeFileSync(path.join(ud, "obsidian.json"), JSON.stringify({ vaults: { d3m0d3m0d3m0d3m0: { path: VAULT, ts: Date.now(), open: true } }, updateDisabled: true }));
	return ud;
}

// ---------------------------------------------------------------- CDP

class CDP {
	static async connect() {
		for (let i = 0; i < 100; i++) {
			try {
				const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
				const page = list.find((t) => t.type === "page" && t.url.startsWith("app://"));
				if (page) {
					const c = new CDP(new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 << 20 }));
					await new Promise((r, j) => (c.ws.once("open", r), c.ws.once("error", j)));
					return c;
				}
			} catch {}
			await sleep(300);
		}
		throw new Error("Obsidian didn't come up with remote debugging");
	}
	constructor(ws) {
		this.ws = ws;
		this.id = 0;
		this.pending = new Map();
		this.handlers = new Map();
		ws.on("message", (m) => {
			const msg = JSON.parse(m);
			if (msg.id && this.pending.has(msg.id)) {
				const { resolve, reject } = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
			} else if (msg.method) this.handlers.get(msg.method)?.(msg.params);
		});
	}
	send(method, params = {}) {
		const id = ++this.id;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}
	on(method, fn) {
		this.handlers.set(method, fn);
	}
	/** Run JS in Obsidian's window (an async function body; `app` is in scope). */
	async eval(body, arg) {
		const r = await this.send("Runtime.evaluate", { expression: `(async (arg) => { ${body} })(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	}
}

// ---------------------------------------------------------------- recording

class Recorder {
	constructor(cdp, name) {
		this.cdp = cdp;
		this.name = name;
		this.dir = path.join(WORK, name);
		fs.mkdirSync(this.dir, { recursive: true });
		this.frames = [];
		this.speed = []; // [timestamp, factor]
	}
	async start() {
		this.cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
			const f = path.join(this.dir, `${String(this.frames.length).padStart(6, "0")}.jpg`);
			fs.writeFileSync(f, Buffer.from(data, "base64"));
			this.frames.push({ f, t: metadata.timestamp });
			this.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
		});
		await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W * 2, maxHeight: H * 2, everyNthFrame: 1 });
	}
	/** From now on, play `factor` times faster (1 = real time). */
	setSpeed(factor) {
		this.speed.push([Date.now() / 1000, factor]);
	}
	async stop() {
		await sleep(400);
		await this.cdp.send("Page.stopScreencast");
		await sleep(200);
		return this.encode();
	}
	factorAt(t) {
		let f = 1;
		for (const [s, k] of this.speed) if (t >= s) f = k;
		return f;
	}
	encode(gifWidth = this.name === "zoom" ? 800 : 960) {
		const lines = [];
		for (let i = 0; i < this.frames.length; i++) {
			const { f, t } = this.frames[i];
			const next = this.frames[i + 1]?.t ?? t + 1.5;
			lines.push(`file '${f}'`, `duration ${((next - t) / this.factorAt(t)).toFixed(4)}`);
		}
		lines.push(`file '${this.frames[this.frames.length - 1].f}'`);
		const list = path.join(this.dir, "list.txt");
		fs.writeFileSync(list, lines.join("\n"));
		const mp4 = path.join(OUT, `${this.name}.mp4`), gif = path.join(OUT, `${this.name}.gif`);
		const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "inherit" });
		ff("-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=30,scale=${W * 2}:-2:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", mp4);
		ff("-i", mp4, "-vf", `fps=${this.name === "zoom" ? 12 : 15},scale=${gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, gif);
		const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(1) + " MB";
		log(`${this.name}: ${this.frames.length} frames → ${mb(mp4)} mp4, ${mb(gif)} gif`);
	}
}

// ---------------------------------------------------------------- the "user"

class User {
	constructor(cdp) {
		this.cdp = cdp;
		this.x = W / 2;
		this.y = H / 2;
	}
	async showCursor() {
		await this.cdp.eval(`
			document.getElementById("rec-cursor")?.remove();
			// Obsidian's "Updated 1 link" notices are noise in a demo
			if (!document.getElementById("rec-style")) document.head.createEl("style", { attr: { id: "rec-style" }, text: ".notice-container { display: none !important; }" });
			const c = document.body.createDiv({ attr: { id: "rec-cursor" } });
			c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 13.8 L10.6 20.4 L13.4 19.1 L10.4 12.7 L16.5 12.4 Z" fill="white" stroke="black" stroke-width="1.3" stroke-linejoin="round"/></svg>';
			Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: 2147483647, pointerEvents: "none", transition: "transform 80ms", willChange: "left, top" });
		`);
		await this.place(this.x, this.y);
	}
	place(x, y) {
		return this.cdp.eval(`const c = document.getElementById("rec-cursor"); if (c) { c.style.left = (arg[0] - 3) + "px"; c.style.top = (arg[1] - 2) + "px"; }`, [x, y]);
	}
	async move(x, y, ms = 550, buttons = 0) {
		const steps = Math.max(8, Math.round(ms / 16));
		const x0 = this.x, y0 = this.y;
		for (let i = 1; i <= steps; i++) {
			const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
			this.x = x0 + (x - x0) * e;
			this.y = y0 + (y - y0) * e;
			await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: this.x, y: this.y, buttons, button: buttons ? "left" : "none" });
			await this.place(this.x, this.y);
			await sleep(16);
		}
	}
	async press(x, y, { button = "left", clickCount = 1 } = {}) {
		const b = button === "left" ? 1 : 2;
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: b, clickCount });
		await this.cdp.eval(`const c = document.getElementById("rec-cursor"); if (c) c.style.transform = "scale(0.85)";`);
		await sleep(70);
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount });
		await this.cdp.eval(`const c = document.getElementById("rec-cursor"); if (c) c.style.transform = "";`);
	}
	async click(x, y, opts = {}) {
		await this.move(x, y, opts.ms);
		await sleep(120);
		await this.press(x, y, opts);
	}
	async dblclick(x, y) {
		await this.move(x, y);
		await sleep(120);
		await this.press(x, y, { clickCount: 1 });
		await sleep(60);
		await this.press(x, y, { clickCount: 2 });
	}
	async drag(x0, y0, x1, y1, ms = 900) {
		await this.move(x0, y0);
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1 });
		await this.move(x1, y1, ms, 1);
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", buttons: 0, clickCount: 1 });
	}
	async wheel(deltaY, { ctrl = false, x = this.x, y = this.y } = {}) {
		await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers: ctrl ? 2 : 0 });
	}
	async type(text, cps = 16) {
		for (const ch of text) {
			await this.cdp.send("Input.insertText", { text: ch });
			await sleep(1000 / cps * (0.6 + Math.random() * 0.8));
		}
	}
	async key(key, code = key, vk = 0, text) {
		await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) });
		await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
	}
	enter() {
		return this.key("Enter", "Enter", 13, "\r");
	}
	/** Center of the first element matching a selector (optionally containing text), in window coords. */
	async at(selector, text) {
		for (let i = 0; i < 60; i++) {
			const r = await this.cdp.eval(`
				const els = [...document.querySelectorAll(arg[0])].filter((e) => !arg[1] || e.textContent.includes(arg[1]));
				const e = els.find((e) => e.getBoundingClientRect().width > 0);
				if (!e) return null;
				const b = e.getBoundingClientRect();
				return [b.left + b.width / 2, b.top + b.height / 2];`, [selector, text]);
			if (r) return r;
			await sleep(150);
		}
		throw new Error(`not found: ${selector} ${text ?? ""}`);
	}
}

// ---------------------------------------------------------------- helpers in Obsidian

async function openCanvas(cdp, name) {
	await cdp.eval(`
		const f = app.vault.getAbstractFileByPath(arg + ".canvas");
		const leaf = app.workspace.getLeaf(false);
		await leaf.openFile(f);
		app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse();
		document.querySelectorAll(".workspace-tab-header-container .workspace-tab-header:not(.is-active) .workspace-tab-header-inner-close-button").forEach((b) => b.click());
	`, name);
	await sleep(800);
}

/** Viewport: canvas point (x, y) at the center, at zoom z (log2: 0 = 100%). Animates. */
async function view(cdp, x, y, z, wait = 900) {
	await cdp.eval(`const c = app.workspace.activeLeaf.view.canvas; c.tx = arg[0]; c.ty = arg[1]; c.tZoom = arg[2]; c.markViewportChanged();`, [x, y, z]);
	await sleep(wait);
}

/** Text on a tile's tmux screen (for waiting on programs). */
function screen(tileId) {
	try {
		return tmux("capture-pane", "-p", "-J", "-t", `vivarium:=${tileId}`);
	} catch {
		return "";
	}
}
async function until(fn, ms = 60000, every = 250) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const v = await fn();
		if (v) return v;
		await sleep(every);
	}
	throw new Error("timed out waiting");
}
const tileIds = () => {
	try {
		return tmux("list-windows", "-t", "vivarium", "-F", "#{window_name}").split("\n").filter((n) => n && n !== "_hub");
	} catch {
		return [];
	}
};

// ---------------------------------------------------------------- the demos

async function hero(cdp, user) {
	await openCanvas(cdp, "Orbit");
	await view(cdp, 110, 40, -0.25, 1200);
	const rec = new Recorder(cdp, "hero");
	await user.showCursor();
	await rec.start();
	await sleep(900);

	// 1. right-click → Add program… → a command
	await user.click(385, 237, { button: "right" });
	await sleep(500);
	const [mx, my] = await user.at(".menu-item", "Add program");
	await user.click(mx, my);
	await sleep(500);
	await user.type("npm run dev");
	await sleep(400);
	await user.enter();
	await until(() => tileIds().some((id) => /localhost:5173/.test(screen(id))), 15000);
	await sleep(1400);

	// 2. rename it: double-click its name
	const [lx, ly] = await user.at(".canvas-node-label", "npm");
	await user.dblclick(lx, ly);
	await sleep(500);
	await cdp.eval(`document.querySelector(".modal input")?.select()`);
	await user.type("Dev server", 12);
	await sleep(300);
	await user.enter();
	await sleep(1000);

	// 3. a web tile from the toolbar button: drag it to where the page should go
	const [bx, by] = await user.at(".vivarium-card-menu-button");
	await user.drag(bx, by, 822, 237, 1100);
	await sleep(500);
	await user.type("localhost:5173");
	await sleep(500);
	await user.enter();
	await sleep(2600);

	// 4. step back to see it all
	await user.move(700, 420);
	await view(cdp, 370, 140, -0.72, 1600);
	await sleep(1500);
	await rec.stop();
}

async function agents(cdp, user) {
	await openCanvas(cdp, "Agents");
	// Start Claude before recording; accept its folder-trust prompt if it asks.
	await until(() => /trust|for shortcuts|Try "|>\s*$/m.test(screen("tagent01")), 60000);
	if (/trust/i.test(screen("tagent01")) && !/Try "/.test(screen("tagent01"))) {
		// newer Claude Code puts "No, continue without these permissions" first: pick the "Yes" line
		if (/❯\s*No/.test(screen("tagent01"))) tmux("send-keys", "-t", "vivarium:=tagent01", "Down");
		await sleep(300);
		tmux("send-keys", "-t", "vivarium:=tagent01", "Enter");
		await until(() => /for shortcuts|Try "/.test(screen("tagent01")), 30000);
	}
	await view(cdp, -160, -40, -0.3, 1200);
	const rec = new Recorder(cdp, "agents");
	await user.showCursor();
	await rec.start();
	await sleep(800);

	const [tx, ty] = await user.at(".canvas-node .vivarium-term");
	await user.click(tx, ty + 40);
	await sleep(300);
	await user.click(tx, ty + 40);
	await sleep(400);
	// the first click selects the card, the second focuses the terminal; make sure it did
	await until(() => cdp.eval(`return !!document.activeElement?.closest(".vivarium-term")`), 3000).catch(async () => {
		await cdp.eval(`document.querySelector(".canvas-node .vivarium-term textarea")?.focus()`);
	});
	const TASK = "Start the dev server in a tile next to you. Then fork yourself into a new tile and have the fork add a /health endpoint.";
	await user.type(TASK, 22);
	await sleep(500);
	// if the keystrokes didn't reach the terminal, type the task through tmux instead
	if (!/dev server in a tile/.test(screen("tagent01"))) {
		console.log("[rec] typing didn't reach the tile; sending via tmux");
		tmux("send-keys", "-t", "vivarium:=tagent01", "-l", TASK);
		await sleep(800);
		if (!/dev server in a tile/.test(screen("tagent01"))) console.log("[rec] still not there; tile screen:\n" + screen("tagent01"));
	}
	await user.enter();
	await user.move(W - 200, H - 120, 900);

	// Real run, fast-forwarded while the agents work. If an agent asks for permission anyway,
	// answer "Yes" the way you would (it stays visible in the video).
	rec.setSpeed(3);
	const approver = setInterval(() => {
		for (const id of tileIds()) if (/Do you want to proceed\?/.test(screen(id))) tmux("send-keys", "-t", `vivarium:=${id}`, "Enter");
	}, 1500);
	const before = new Set(tileIds());
	await until(() => tileIds().filter((id) => !before.has(id)).length >= 2, 180000, 500);
	await sleep(2000);
	const fork = await until(() => tileIds().find((id) => !before.has(id) && /claude/i.test(screen(id) + tmux("display-message", "-p", "-t", `vivarium:=${id}`, "#{pane_current_command}"))), 30000, 500).catch(() => null);
	if (fork) {
		// wait until the fork is done (no "esc to interrupt" for a few seconds), or give up after a while
		let idle = 0;
		await until(() => ((idle = /esc to interrupt/i.test(screen(fork)) ? 0 : idle + 1), idle >= 4), 180000, 1000).catch(() => {});
	}
	await sleep(1500);
	clearInterval(approver);
	rec.setSpeed(1);
	await view(cdp, -60, 160, -0.75, 1600);
	await sleep(1800);
	await rec.stop();
}

async function zoom(cdp, user) {
	await openCanvas(cdp, "Workspace");
	// Start on the live tiles, and only record once they show something.
	await view(cdp, 900, 990, -0.5, 1500);
	await until(() => /localhost:5173/.test(screen("tserve01")) && /watching/.test(screen("tclock01")), 30000);
	// the page tile loaded before its server was up: load it again
	await cdp.eval(`document.querySelectorAll("webview").forEach((w) => w.reload())`);
	await sleep(3000);
	const rec = new Recorder(cdp, "zoom");
	await user.showCursor();
	await user.move(700, 470, 200);
	await rec.start();
	await sleep(1800);
	// Out: cards turn into headlines, then into group titles. (Camera moves animate like a pinch.)
	await view(cdp, 1500, 1150, -2.0, 2400); // Orbit + neighbours: headlines
	await view(cdp, 1900, 1400, -3.1, 2600); // everything: group titles
	await sleep(600);
	// Into another group, then back to where we started.
	await user.move(880, 300, 700);
	await view(cdp, 2900, 500, -1.0, 2600); // Research, close enough to read
	await view(cdp, 900, 990, -0.5, 2800); // live tiles again
	await sleep(1800);
	await rec.stop();
}

// ---------------------------------------------------------------- main

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ["hero", "agents", "zoom"];
const demos = { hero, agents, zoom, idle: async (cdp) => openCanvas(cdp, "Workspace") }; // idle: just open (debugging with REC_KEEP=1)
try {
	execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
} catch {}
const userData = writeDemo();
log("demo vault:", VAULT);
// Keep rendering when the window is covered by others (Chromium pauses occluded windows).
const obsidian = spawn(OBSIDIAN, [`--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
	env: { ...process.env, ZDOTDIR: path.join(DEMO, "zdotdir"), SHELL: "/bin/zsh" },
	stdio: "ignore",
});
let cdp;
try {
	cdp = await CDP.connect();
	await cdp.send("Page.enable");
	await cdp.send("Runtime.enable");
	// Window size, and past Obsidian's first-run prompts (trust this vault's plugins).
	// Electron has no window-bounds CDP API: fix the page's size instead (the window can be larger).
	await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
	await until(() => cdp.eval(`return !!(window.app && app.workspace && app.workspace.layoutReady)`).catch(() => false), 30000);
	for (let i = 0; i < 20; i++) {
		const clicked = await cdp.eval(`const b = [...document.querySelectorAll("button")].find((b) => /Trust author/i.test(b.textContent)); b?.click(); return !!b;`);
		if (clicked) break;
		if (await cdp.eval(`return !!app.plugins?.plugins?.vivarium`)) break;
		await sleep(300);
	}
	await until(() => cdp.eval(`return !!app.plugins?.plugins?.vivarium`), 20000);
	await cdp.eval(`document.querySelectorAll(".modal-close-button").forEach((b) => b.click())`);
	const user = new User(cdp);
	for (const name of wanted) {
		log("recording", name);
		await demos[name](cdp, user);
	}
} catch (e) {
	// what did it look like when it went wrong?
	const shot = await cdp?.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
	if (shot) fs.writeFileSync(path.join(WORK, "failed.png"), Buffer.from(shot.data, "base64"));
	console.error("[rec] failed:", e.message, shot ? `(screenshot: ${path.join(WORK, "failed.png")})` : "");
	process.exitCode = 1;
} finally {
	cdp?.ws.close();
	if (process.env.REC_KEEP) await new Promise(() => {}); // leave it open for debugging
	obsidian.kill();
	try {
		execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
	} catch {}
	log("frames kept in", WORK);
}
