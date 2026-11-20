/**
 * Local control socket so agents (Claude Code, Codex, scripts) can arrange the canvas:
 * the `vivarium` CLI talks newline-delimited JSON over a unix socket in ~/.vivarium/ (0700).
 * Reading/typing into programs doesn't need this: the CLI goes straight to tmux.
 */
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { TFile } from "obsidian";
import type VivariumPlugin from "./main";
import { TILE_EXT } from "./core";
import { resumeCommand } from "./keeper";

type Req = { op: string; [k: string]: any };
type Rect = { x: number; y: number; width: number; height: number };

export function socketDir() {
	return path.join(os.homedir(), ".vivarium");
}

export class ControlServer {
	private server: net.Server | null = null;
	readonly sockPath: string;

	constructor(private plugin: VivariumPlugin) {
		const vault = this.plugin.app.vault.getName().replace(/[^\w.-]+/g, "_");
		this.sockPath = path.join(socketDir(), `${vault}.sock`);
	}

	start() {
		try {
			fs.mkdirSync(socketDir(), { recursive: true, mode: 0o700 });
			if (fs.existsSync(this.sockPath)) fs.unlinkSync(this.sockPath);
		} catch (e) {
			console.warn("[vivarium] control socket setup failed", e);
			return;
		}
		this.server = net.createServer((sock) => {
			let buf = "";
			sock.on("data", (d) => {
				buf += d.toString("utf8");
				let nl;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (!line.trim()) continue;
					this.handle(line).then((res) => sock.write(JSON.stringify(res) + "\n"));
				}
			});
			sock.on("error", () => {});
		});
		this.server.on("error", (e) => console.warn("[vivarium] control socket error", e));
		this.server.listen(this.sockPath, () => fs.chmodSync(this.sockPath, 0o600));
	}

	stop() {
		this.server?.close();
		this.server = null;
		try {
			fs.unlinkSync(this.sockPath);
		} catch {}
	}

	private async handle(line: string): Promise<any> {
		let req: Req;
		try {
			req = JSON.parse(line);
		} catch {
			return { ok: false, error: "bad json" };
		}
		try {
			const fn = (this as any)["op_" + req.op];
			if (typeof fn !== "function") return { ok: false, error: `unknown op ${req.op}` };
			return { ok: true, ...(await fn.call(this, req)) };
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
	}

	// ---------- helpers ----------

	/** Open canvases, the one you're looking at first (a tile can be on several). */
	private canvases(): any[] {
		const all = this.plugin.app.workspace.getLeavesOfType("canvas").map((l) => (l.view as any).canvas).filter(Boolean);
		const active = this.plugin.activeCanvas();
		return active && all.includes(active) ? [active, ...all.filter((c) => c !== active)] : all;
	}

	/** Find the canvas node showing a tile (by tile id) across open canvases. */
	private async findTile(id: string): Promise<{ canvas: any; node: any; file: TFile } | null> {
		for (const canvas of this.canvases()) {
			for (const node of canvas.nodes.values()) {
				const f: TFile | undefined = node.file;
				if (f?.extension !== TILE_EXT) continue;
				const spec = await this.plugin.core.readSpec(f);
				if (spec?.id === id) return { canvas, node, file: f };
			}
		}
		return null;
	}

	private targetCanvas(): any {
		const active = this.plugin.activeCanvas();
		if (active) return active;
		const all = this.canvases();
		if (!all.length) throw new Error("no canvas is open in Obsidian");
		return all[0];
	}

	/** First free spot next to `near` (right, below, left, above, then further right). */
	private placeNear(canvas: any, near: Rect, w: number, h: number): { x: number; y: number } {
		const gap = 40;
		const rects: Rect[] = [...canvas.nodes.values()].map((n: any) => ({ x: n.x, y: n.y, width: n.width, height: n.height }));
		const free = (x: number, y: number) => !rects.some((r) => x < r.x + r.width + gap / 2 && x + w + gap / 2 > r.x && y < r.y + r.height + gap / 2 && y + h + gap / 2 > r.y);
		const cands = [
			{ x: near.x + near.width + gap, y: near.y },
			{ x: near.x, y: near.y + near.height + gap },
			{ x: near.x - w - gap, y: near.y },
			{ x: near.x, y: near.y - h - gap },
		];
		for (const c of cands) if (free(c.x, c.y)) return c;
		for (let i = 2; i < 50; i++) {
			const c = { x: near.x + i * (w + gap), y: near.y };
			if (free(c.x, c.y)) return c;
		}
		return cands[0];
	}

	private async nodeInfo(canvas: any, node: any) {
		const base = { canvas: canvas.view?.file?.path, nodeId: node.id, x: node.x, y: node.y, width: node.width, height: node.height };
		const f: TFile | undefined = node.file;
		if (f?.extension === TILE_EXT) {
			const spec = await this.plugin.core.readSpec(f);
			const pane = spec ? this.plugin.core.hub.getPane(spec.id) : undefined;
			// title: the name on the card (the file name), which is what you see and rename
			return { ...base, kind: "program", id: spec?.id, title: f.basename, command: spec?.command, file: f.path, running: !!pane && !pane.dead };
		}
		if (f) return { ...base, kind: "file", file: f.path };
		if (node.text !== undefined) return { ...base, kind: "text", text: String(node.text).slice(0, 200) };
		if (node.url) return { ...base, kind: "link", url: node.url };
		return { ...base, kind: "group", label: node.label };
	}

	// ---------- ops ----------

	async op_ping() {
		return { vault: this.plugin.app.vault.getName() };
	}

	async op_list(req: Req) {
		await this.plugin.core.hub.ensureConnected().catch(() => {});
		const out = [];
		for (const canvas of this.canvases()) for (const n of canvas.nodes.values()) {
			const info = await this.nodeInfo(canvas, n);
			if (!req.programsOnly || info.kind === "program") out.push(info);
		}
		return { nodes: out };
	}

	/** Add a program tile. `near` = tile id to place next to (and connect with an edge). */
	async op_add(req: Req) {
		const s = this.plugin.settings;
		const w = req.width ?? s.tileWidth, h = req.height ?? s.tileHeight;
		let canvas: any, pos: { x: number; y: number }, nearNode: any = null;
		const near = req.near ? await this.findTile(req.near) : null;
		// Never connect to some other tile by accident: an id that isn't on a canvas is an error.
		if (req.near && !near && req.nearExplicit) throw new Error(`tile ${req.near} is not on an open canvas`);
		const warning = req.near && !near ? `tile ${req.near} is not on an open canvas: placed on the active canvas, without an arrow` : undefined;
		if (near) {
			canvas = near.canvas;
			nearNode = near.node;
			pos = req.x !== undefined ? { x: req.x, y: req.y ?? 0 } : this.placeNear(canvas, nearNode, w, h);
		} else {
			canvas = this.targetCanvas();
			const c = canvas.posCenter();
			pos = req.x !== undefined ? { x: req.x, y: req.y ?? 0 } : this.placeNear(canvas, { x: c.x - w / 2, y: c.y - h / 2, width: 0, height: 0 }, w, h);
			if (req.x === undefined && ![...canvas.nodes.values()].length) pos = { x: c.x - w / 2, y: c.y - h / 2 };
		}
		const program = { name: req.title || String(req.command || "Shell").split(/\s+/)[0] || "Shell", command: req.command ?? "", cwd: req.cwd ?? "" };
		const file = await this.plugin.core.createTileFile(program);
		const node = canvas.createFileNode({ pos, file, size: { width: w, height: h }, focus: false });
		if (nearNode && req.edge !== false) this.connect(canvas, nearNode, node, req.label);
		canvas.requestSave();
		const spec = await this.plugin.core.readSpec(file);
		if (req.reveal !== false) canvas.panIntoView?.(node.getBBox());
		return { id: spec?.id, title: file.basename, file: file.path, nodeId: node.id, x: node.x, y: node.y, warning };
	}

	/** Who am I: a tile's card, folder and coding-agent conversation. */
	async op_me(req: Req) {
		if (!req.id) throw new Error("not inside a Vivarium tile ($VIVARIUM_TILE is not set)");
		const t = await this.findTile(req.id);
		const live = await this.plugin.core.keeper.inspect(req.id).catch(() => null);
		const card: any = t ? await this.nodeInfo(t.canvas, t.node) : null;
		return { id: req.id, title: card?.title, canvas: card?.canvas ?? null, cwd: live?.cwd, agent: live?.agent ?? null, running: !!live };
	}

	/**
	 * Continue a tile's coding-agent conversation in a new tile next to it (codex fork / claude
	 * --fork-session), linked with a "fork" arrow. `session`: the agent's own id for itself (Codex
	 * passes $CODEX_THREAD_ID to its commands), else we look at what runs in the tile.
	 */
	async op_fork(req: Req) {
		const t = await this.findTile(req.id);
		if (!t) throw new Error(`tile ${req.id} is not on an open canvas`);
		const spec = await this.plugin.core.readSpec(t.file);
		const live = await this.plugin.core.keeper.inspect(req.id);
		let agent = live?.agent ?? null;
		if (req.session && /^[\w-]{8,}$/.test(req.session)) agent = { kind: req.kind === "claude" ? "claude" : (agent?.kind ?? "codex"), sessionId: req.session };
		if (!agent) throw new Error("no Codex or Claude Code conversation found in this tile (Codex only has one after the first message)");
		const command = resumeCommand(spec?.command.trim() ?? "", agent, true, req.prompt ?? "");
		return this.op_add({ op: "add", command, title: req.title || `${t.file.basename} fork`, cwd: live?.cwd, near: req.id, nearExplicit: true, label: "fork" });
	}

	/** Add a text card (agents leaving notes/plans next to their tile). */
	async op_note(req: Req) {
		const near = req.near ? await this.findTile(req.near) : null;
		const canvas = near?.canvas ?? this.targetCanvas();
		const w = req.width ?? 360, h = req.height ?? 200;
		const pos = req.x !== undefined ? { x: req.x, y: req.y ?? 0 } : near ? this.placeNear(canvas, near.node, w, h) : canvas.posCenter();
		const node = canvas.createTextNode({ pos, size: { width: w, height: h }, text: String(req.text ?? ""), focus: false });
		if (req.color) node.setColor?.(String(req.color));
		if (near && req.edge !== false) this.connect(canvas, near.node, node, req.label);
		canvas.requestSave();
		return { nodeId: node.id, x: node.x, y: node.y };
	}

	async op_move(req: Req) {
		const t = await this.findTile(req.id);
		if (!t) throw new Error(`tile ${req.id} not on an open canvas`);
		const n = t.node;
		n.moveAndResize({ x: req.x ?? n.x, y: req.y ?? n.y, width: req.width ?? n.width, height: req.height ?? n.height });
		t.canvas.requestSave();
		return { x: n.x, y: n.y, width: n.width, height: n.height };
	}

	async op_focus(req: Req) {
		const t = await this.findTile(req.id);
		if (!t) throw new Error(`tile ${req.id} not on an open canvas`);
		t.canvas.zoomToBbox?.(t.node.getBBox());
		t.canvas.selectOnly(t.node);
		return {};
	}

	/** Stop the program, remove the card and delete the tile file. */
	async op_rm(req: Req) {
		const t = await this.findTile(req.id);
		await this.plugin.core.stopTile(req.id);
		if (t) {
			t.canvas.removeNode(t.node);
			t.canvas.requestSave();
			await this.plugin.app.vault.delete(t.file);
		}
		return {};
	}

	private connect(canvas: any, from: any, to: any, label?: string) {
		const dx = to.x + to.width / 2 - (from.x + from.width / 2);
		const dy = to.y + to.height / 2 - (from.y + from.height / 2);
		const horiz = Math.abs(dx) >= Math.abs(dy);
		const fromSide = horiz ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top";
		const toSide = horiz ? (dx > 0 ? "left" : "right") : dy > 0 ? "top" : "bottom";
		const id = Math.random().toString(16).slice(2, 18);
		// importData merges by id: existing nodes (and their live terminals) are untouched.
		canvas.importData({ nodes: [], edges: [{ id, fromNode: from.id, fromSide, toNode: to.id, toSide, ...(label ? { label } : {}) }] }, false);
	}
}
