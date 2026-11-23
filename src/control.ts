/**
 * Local control socket so agents (Claude Code, Codex, scripts) can arrange the canvas:
 * the `vivarium` CLI talks newline-delimited JSON over a unix socket in ~/.vivarium/ (0700, ours).
 * Reading/typing into programs doesn't need this: the CLI goes straight to tmux.
 *
 * Canvas changes are made to the .canvas file (JSON Canvas, an open format) through the vault
 * API, not to Canvas's in-memory model. An open canvas merges such a change by node id, so tiles
 * already on it keep running untouched. Before writing we save the open canvas, so a change you
 * just made there isn't overwritten. Only zooming to a tile needs the open canvas itself.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { TextFileView, TFile, WorkspaceLeaf } from "obsidian";
import type VivariumPlugin from "./main";
import { TILE_EXT } from "./core";
import { resumeCommand } from "./keeper";

type Req = { op: string; [k: string]: unknown };
type Rect = { x: number; y: number; width: number; height: number };
interface CanvasNodeData extends Rect {
	id: string;
	type: string;
	file?: string;
	text?: string;
	url?: string;
	label?: string;
	color?: string;
}
interface CanvasEdgeData {
	id: string;
	fromNode: string;
	fromSide?: string;
	toNode: string;
	toSide?: string;
	label?: string;
}
interface CanvasData {
	nodes: CanvasNodeData[];
	edges: CanvasEdgeData[];
}
/** Optional extras from the open canvas (undocumented; each may be missing in a future Obsidian). */
interface LiveCanvas {
	posCenter?(): { x: number; y: number };
	zoomToBbox?(b: { minX: number; minY: number; maxX: number; maxY: number }): void;
	panIntoView?(b: { minX: number; minY: number; maxX: number; maxY: number }): void;
}

export function socketDir() {
	return path.join(os.homedir(), ".vivarium");
}

/** One socket per vault, named after it, plus a hash of its path (two vaults can share a name). */
export function socketPath(vaultName: string, vaultPath: string) {
	const hash = crypto.createHash("sha256").update(vaultPath).digest("hex").slice(0, 8);
	return path.join(socketDir(), `${vaultName.replace(/[^\w.-]+/g, "_")}-${hash}.sock`);
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const newId = () => crypto.randomBytes(8).toString("hex");
const bbox = (r: Rect) => ({ minX: r.x, minY: r.y, maxX: r.x + r.width, maxY: r.y + r.height });

export class ControlServer {
	private server: net.Server | null = null;
	readonly sockPath: string;

	constructor(private plugin: VivariumPlugin) {
		this.sockPath = socketPath(plugin.app.vault.getName(), plugin.core.vaultPath());
	}

	start() {
		const dir = socketDir();
		try {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			// Only we may connect: the folder must be ours and closed to others (mkdir doesn't fix an
			// existing folder's mode).
			const st = fs.statSync(dir);
			if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
			if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
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
					void this.handle(line).then((res) => sock.write(JSON.stringify(res) + "\n"));
				}
			});
			sock.on("error", () => {});
		});
		this.server.on("error", (e) => console.warn("[vivarium] control socket error", e));
		this.server.listen(this.sockPath, () => {
			try {
				fs.chmodSync(this.sockPath, 0o600);
			} catch {
			// best effort
		}
		});
	}

	stop() {
		this.server?.close();
		this.server = null;
		try {
			fs.unlinkSync(this.sockPath);
		} catch {
			// best effort
		}
	}

	private readonly ops: Record<string, (req: Req) => Promise<Record<string, unknown>>> = {
		ping: () => this.opPing(),
		list: (r) => this.opList(r),
		add: (r) => this.opAdd(r),
		me: (r) => this.opMe(r),
		fork: (r) => this.opFork(r),
		note: (r) => this.opNote(r),
		move: (r) => this.opMove(r),
		focus: (r) => this.opFocus(r),
		rm: (r) => this.opRm(r),
	};

	private async handle(line: string): Promise<Record<string, unknown>> {
		let req: Req;
		try {
			req = JSON.parse(line) as Req;
		} catch {
			return { ok: false, error: "bad json" };
		}
		try {
			const fn = this.ops[String(req.op)];
			if (!fn) return { ok: false, error: `unknown op ${String(req.op)}` };
			return { ok: true, ...(await fn(req)) };
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
	}

	// ---------- canvases (files) ----------

	private canvasLeaves(): WorkspaceLeaf[] {
		return this.plugin.app.workspace.getLeavesOfType("canvas");
	}

	/** Open canvas files, the one you're looking at first. */
	private openCanvasFiles(): TFile[] {
		const files: TFile[] = [];
		const active = this.plugin.app.workspace.getActiveFile();
		if (active?.extension === "canvas") files.push(active);
		for (const leaf of this.canvasLeaves()) {
			const f = leaf.view instanceof TextFileView ? leaf.view.file : null;
			if (f && !files.includes(f)) files.push(f);
		}
		return files;
	}

	private async read(file: TFile): Promise<CanvasData> {
		try {
			const d = JSON.parse((await this.plugin.app.vault.read(file)) || "{}") as Partial<CanvasData>;
			return { nodes: Array.isArray(d.nodes) ? d.nodes : [], edges: Array.isArray(d.edges) ? d.edges : [] };
		} catch {
			return { nodes: [], edges: [] };
		}
	}

	/** Change a canvas file. An open view of it is saved first, so your latest edit there is kept. */
	private async write(file: TFile, change: (d: CanvasData) => void) {
		for (const leaf of this.canvasLeaves()) {
			if (leaf.view instanceof TextFileView && leaf.view.file === file) await leaf.view.save();
		}
		await this.plugin.app.vault.process(file, (raw) => {
			let d: Record<string, unknown> = {};
			try {
				d = (JSON.parse(raw || "{}") as Record<string, unknown>) ?? {};
			} catch {
			// best effort
		}
			const data: CanvasData = { nodes: Array.isArray(d.nodes) ? (d.nodes as CanvasNodeData[]) : [], edges: Array.isArray(d.edges) ? (d.edges as CanvasEdgeData[]) : [] };
			change(data);
			return JSON.stringify({ ...d, nodes: data.nodes, edges: data.edges }, null, "\t");
		});
	}

	/** The open canvas's live object, for optional extras only (see LiveCanvas). */
	private live(file: TFile): LiveCanvas | null {
		for (const leaf of this.canvasLeaves()) {
			if (leaf.view instanceof TextFileView && leaf.view.file === file) {
				const c = (leaf.view as unknown as { canvas?: LiveCanvas }).canvas;
				return c ?? null;
			}
		}
		return null;
	}

	/** The tile's file and the open canvas showing it (the active one first). */
	private async findTile(id: string): Promise<{ canvas: TFile; node: CanvasNodeData; file: TFile } | null> {
		for (const canvas of this.openCanvasFiles()) {
			for (const node of (await this.read(canvas)).nodes) {
				if (node.type !== "file" || !node.file?.endsWith("." + TILE_EXT)) continue;
				const f = this.plugin.app.vault.getFileByPath(node.file);
				if (!f) continue;
				const spec = await this.plugin.core.readSpec(f);
				if (spec?.id === id) return { canvas, node, file: f };
			}
		}
		return null;
	}

	private targetCanvas(): TFile {
		const all = this.openCanvasFiles();
		if (!all.length) throw new Error("no canvas is open in Obsidian");
		return all[0];
	}

	/** First free spot next to `near` (right, below, left, above, then further right). */
	private placeNear(nodes: Rect[], near: Rect, w: number, h: number): { x: number; y: number } {
		const gap = 40;
		const free = (x: number, y: number) => !nodes.some((r) => x < r.x + r.width + gap / 2 && x + w + gap / 2 > r.x && y < r.y + r.height + gap / 2 && y + h + gap / 2 > r.y);
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

	/** Where a new card goes when it isn't placed next to a tile: the middle of the view if we can tell, else right of everything. */
	private placeFree(canvas: TFile, nodes: Rect[], w: number, h: number): { x: number; y: number } {
		const c = this.live(canvas)?.posCenter?.();
		if (c) return nodes.length ? this.placeNear(nodes, { x: c.x - w / 2, y: c.y - h / 2, width: 0, height: 0 }, w, h) : { x: c.x - w / 2, y: c.y - h / 2 };
		if (!nodes.length) return { x: 0, y: 0 };
		const right = Math.max(...nodes.map((n) => n.x + n.width));
		const top = Math.min(...nodes.map((n) => n.y));
		return { x: right + 40, y: top };
	}

	private edge(from: Rect & { id: string }, to: Rect & { id: string }, label?: string): CanvasEdgeData {
		const dx = to.x + to.width / 2 - (from.x + from.width / 2);
		const dy = to.y + to.height / 2 - (from.y + from.height / 2);
		const horiz = Math.abs(dx) >= Math.abs(dy);
		const fromSide = horiz ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top";
		const toSide = horiz ? (dx > 0 ? "left" : "right") : dy > 0 ? "top" : "bottom";
		return { id: newId(), fromNode: from.id, fromSide, toNode: to.id, toSide, ...(label ? { label } : {}) };
	}

	private async nodeInfo(canvas: TFile, node: CanvasNodeData) {
		const base = { canvas: canvas.path, nodeId: node.id, x: node.x, y: node.y, width: node.width, height: node.height };
		if (node.type === "file" && node.file) {
			const f = this.plugin.app.vault.getFileByPath(node.file);
			if (f?.extension === TILE_EXT) {
				const spec = await this.plugin.core.readSpec(f);
				const pane = spec ? this.plugin.core.hub.getPane(spec.id) : undefined;
				// title: the name on the card (the file name), which is what you see and rename
				return { ...base, kind: "program", id: spec?.id, title: f.basename, command: spec?.command, file: f.path, running: !!pane && !pane.dead };
			}
			return { ...base, kind: "file", file: node.file };
		}
		if (node.type === "text") return { ...base, kind: "text", text: String(node.text ?? "").slice(0, 200) };
		if (node.type === "link") return { ...base, kind: "link", url: node.url };
		return { ...base, kind: "group", label: node.label };
	}

	// ---------- ops ----------

	private async opPing() {
		return { vault: this.plugin.app.vault.getName() };
	}

	private async opList(req: Req) {
		await this.plugin.core.hub.ensureConnected().catch(() => {});
		const out = [];
		for (const canvas of this.openCanvasFiles()) {
			for (const n of (await this.read(canvas)).nodes) {
				const info = await this.nodeInfo(canvas, n);
				if (!req.programsOnly || info.kind === "program") out.push(info);
			}
		}
		return { nodes: out };
	}

	/** Add a program tile. `near` = tile id to place next to (and connect with an edge). */
	private async opAdd(req: Req) {
		const s = this.plugin.settings;
		const w = num(req.width) ?? s.tileWidth, h = num(req.height) ?? s.tileHeight;
		const nearId = str(req.near);
		const near = nearId ? await this.findTile(nearId) : null;
		// Never connect to some other tile by accident: an id that isn't on a canvas is an error.
		if (nearId && !near && req.nearExplicit) throw new Error(`tile ${nearId} is not on an open canvas`);
		const warning = nearId && !near ? `tile ${nearId} is not on an open canvas: placed on the active canvas, without an arrow` : undefined;
		const canvas = near?.canvas ?? this.targetCanvas();
		const command = str(req.command) ?? "";
		const program = { name: str(req.title) || command.split(/\s+/)[0] || "Shell", command, cwd: str(req.cwd) ?? "" };
		const file = await this.plugin.core.createTileFile(program);
		const node: CanvasNodeData = { id: newId(), type: "file", file: file.path, x: 0, y: 0, width: w, height: h };
		await this.write(canvas, (d) => {
			const nearNode = near ? d.nodes.find((n) => n.id === near.node.id) : undefined;
			const x = num(req.x);
			const pos = x !== undefined ? { x, y: num(req.y) ?? 0 } : nearNode ? this.placeNear(d.nodes, nearNode, w, h) : this.placeFree(canvas, d.nodes, w, h);
			Object.assign(node, pos);
			d.nodes.push(node);
			if (nearNode && req.edge !== false) d.edges.push(this.edge(nearNode, node, str(req.label)));
		});
		const spec = await this.plugin.core.readSpec(file);
		if (req.reveal !== false) window.setTimeout(() => this.live(canvas)?.panIntoView?.(bbox(node)), 200);
		return { id: spec?.id, title: file.basename, file: file.path, nodeId: node.id, x: node.x, y: node.y, warning };
	}

	/** Who am I: a tile's card, folder and coding-agent conversation. */
	private async opMe(req: Req) {
		const id = str(req.id);
		if (!id) throw new Error("not inside a Vivarium tile ($VIVARIUM_TILE is not set)");
		const t = await this.findTile(id);
		const live = await this.plugin.core.keeper.inspect(id).catch(() => null);
		const card = t ? await this.nodeInfo(t.canvas, t.node) : null;
		return { id, title: card && "title" in card ? card.title : undefined, canvas: card?.canvas ?? null, cwd: live?.cwd, agent: live?.agent ?? null, running: !!live };
	}

	/**
	 * Continue a tile's coding-agent conversation in a new tile next to it (codex fork / claude
	 * --fork-session), linked with a "fork" arrow. `session`: the agent's own id for itself (Codex
	 * passes $CODEX_THREAD_ID to its commands), else we look at what runs in the tile.
	 */
	private async opFork(req: Req) {
		const id = str(req.id) ?? "";
		const t = await this.findTile(id);
		if (!t) throw new Error(`tile ${id} is not on an open canvas`);
		const spec = await this.plugin.core.readSpec(t.file);
		const live = await this.plugin.core.keeper.inspect(id);
		let agent = live?.agent ?? null;
		const session = str(req.session);
		if (session && /^[\w-]{8,}$/.test(session)) agent = { kind: req.kind === "claude" ? "claude" : (agent?.kind ?? "codex"), sessionId: session };
		if (!agent) throw new Error("no Codex or Claude Code conversation found in this tile (Codex only has one after the first message)");
		// The fork keeps the tile's command-line flags (e.g. a model, or a sandbox setting) only when
		// an agent forks its own conversation: the call comes from that tile, and the conversation is
		// the one running there. Otherwise an agent could put another tile's flags, say "no sandbox",
		// on its own conversation. Without them, the fork starts with the harness's defaults.
		const own = str(req.from) === id && !!live?.agent && live.agent.sessionId === agent.sessionId && live.agent.kind === agent.kind;
		const base = own ? (spec?.command.trim() ?? "") : agent.kind;
		const command = resumeCommand(base, agent, true, str(req.prompt) ?? "");
		return this.opAdd({ op: "add", command, title: str(req.title) || `${t.file.basename} fork`, cwd: live?.cwd, near: id, nearExplicit: true, label: "fork" });
	}

	/** Add a text card (agents leaving notes/plans next to their tile). */
	private async opNote(req: Req) {
		const nearId = str(req.near);
		const near = nearId ? await this.findTile(nearId) : null;
		const canvas = near?.canvas ?? this.targetCanvas();
		const w = num(req.width) ?? 360, h = num(req.height) ?? 200;
		const node: CanvasNodeData = { id: newId(), type: "text", text: str(req.text) ?? "", x: 0, y: 0, width: w, height: h, ...(str(req.color) ? { color: str(req.color) } : {}) };
		await this.write(canvas, (d) => {
			const nearNode = near ? d.nodes.find((n) => n.id === near.node.id) : undefined;
			const x = num(req.x);
			Object.assign(node, x !== undefined ? { x, y: num(req.y) ?? 0 } : nearNode ? this.placeNear(d.nodes, nearNode, w, h) : this.placeFree(canvas, d.nodes, w, h));
			d.nodes.push(node);
			if (nearNode && req.edge !== false) d.edges.push(this.edge(nearNode, node, str(req.label)));
		});
		return { nodeId: node.id, x: node.x, y: node.y };
	}

	private async opMove(req: Req) {
		const id = str(req.id) ?? "";
		const t = await this.findTile(id);
		if (!t) throw new Error(`tile ${id} not on an open canvas`);
		let out: Rect = t.node;
		await this.write(t.canvas, (d) => {
			const n = d.nodes.find((x) => x.id === t.node.id);
			if (!n) return;
			n.x = num(req.x) ?? n.x;
			n.y = num(req.y) ?? n.y;
			n.width = num(req.width) ?? n.width;
			n.height = num(req.height) ?? n.height;
			out = n;
		});
		return { x: out.x, y: out.y, width: out.width, height: out.height };
	}

	/** Zoom to a tile: needs the open canvas (no file equivalent). */
	private async opFocus(req: Req) {
		const id = str(req.id) ?? "";
		const t = await this.findTile(id);
		if (!t) throw new Error(`tile ${id} not on an open canvas`);
		const live = this.live(t.canvas);
		if (!live?.zoomToBbox) throw new Error("zooming to a tile isn't supported by this version of Obsidian");
		live.zoomToBbox(bbox(t.node));
		return {};
	}

	/** Stop the program, remove the card (and its arrows) and delete the tile file. */
	private async opRm(req: Req) {
		const id = str(req.id) ?? "";
		const t = await this.findTile(id);
		await this.plugin.core.stopTile(id);
		if (t) {
			await this.write(t.canvas, (d) => {
				d.nodes = d.nodes.filter((n) => n.id !== t.node.id);
				d.edges = d.edges.filter((e) => e.fromNode !== t.node.id && e.toNode !== t.node.id);
			});
			await this.plugin.app.fileManager.trashFile(t.file);
		}
		return {};
	}
}
