/**
 * SessionKeeper: makes a reboot or crash as painless as possible.
 *
 * tmux keeps programs alive across Obsidian restarts, but a machine restart ends them. So while
 * you work, every few seconds (cheap: one tmux query + one `ps`), we remember per tile:
 *   - whether it's running, what's in the foreground (shell / Claude Code / other program),
 *   - the shell's current folder,
 *   - for Claude Code: *that tile's* session id (from ~/.claude/sessions/<pid>.json),
 * and every 30 s a snapshot of its recent output (outside the vault, ~/.vivarium/snapshots).
 *
 * After a restart, tiles that were running come back on their own (see restoreAll / launchFor):
 * Claude Code via `claude --resume <its session>`, everything else with its old output on screen,
 * a divider, and the program started again in the same folder.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { VivariumCore, Launch, TileSpec } from "./core";

export interface RunState {
	running?: boolean;
	fg?: "shell" | "agent" | "program";
	cwd?: string;
	agent?: { kind: "claude"; sessionId: string };
}

const TICK_MS = 10_000;
const SNAPSHOT_MS = 30_000;
const SNAPSHOT_LINES = 1500;
const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "nu", "login"]);

const q = (s: string) => "'" + s.replace(/'/g, `'\\''`) + "'";

export class SessionKeeper {
	private tickTimer: number | null = null;
	private snapTimer: number | null = null;
	private lastSnap = new Map<string, string>();
	private busy = false;

	constructor(private core: VivariumCore) {}

	start() {
		window.setTimeout(() => this.tick(), 3000);
		this.tickTimer = window.setInterval(() => this.tick(), TICK_MS);
		this.snapTimer = window.setInterval(() => this.snapshot(), SNAPSHOT_MS);
	}

	stop() {
		if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
		if (this.snapTimer !== null) window.clearInterval(this.snapTimer);
		this.tickTimer = this.snapTimer = null;
	}

	snapPath(tileId: string) {
		const vault = this.core.app.vault.getName().replace(/[^\w.-]+/g, "_");
		return path.join(os.homedir(), ".vivarium", "snapshots", vault, `${tileId}.ans`);
	}

	/** Remember what each tile is running (only writes when something changed). */
	async tick() {
		const hub = this.core.hub;
		if (this.busy || !hub.connected || !hub.allPanes().length) return;
		this.busy = true;
		try {
			const [rows, tree] = await Promise.all([hub.listPaneInfo(), processTree()]);
			for (const r of rows) {
				const prev = this.core.tileState<RunState>(r.tileId);
				const sessionId = r.dead ? null : findClaudeSession(r.panePid, tree);
				const fg: RunState["fg"] = r.dead ? undefined : sessionId ? "agent" : SHELLS.has(path.basename(r.command).replace(/^-/, "")) ? "shell" : "program";
				const next: RunState = {
					running: !r.dead,
					fg,
					cwd: r.cwd || prev.cwd,
					agent: sessionId ? { kind: "claude", sessionId } : undefined,
				};
				if (JSON.stringify(next) !== JSON.stringify({ running: prev.running, fg: prev.fg, cwd: prev.cwd, agent: prev.agent })) {
					this.core.setTileState(r.tileId, next as Record<string, unknown>);
				}
			}
		} catch (e) {
			console.debug("[vivarium] keeper tick", e);
		} finally {
			this.busy = false;
		}
	}

	/** Save recent output of tiles whose screen changed since the last snapshot. */
	async snapshot() {
		const hub = this.core.hub;
		if (!hub.connected || !hub.allPanes().length) return;
		try {
			const rows = await hub.listPaneInfo();
			for (const r of rows) {
				if (r.dead) continue;
				const key = `${r.historySize}:${r.cursorY}:${r.activity}`;
				if (this.lastSnap.get(r.tileId) === key) continue;
				this.lastSnap.set(r.tileId, key);
				const text = await hub.captureForSnapshot(r.paneId, SNAPSHOT_LINES);
				const file = this.snapPath(r.tileId);
				fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
				fs.writeFileSync(file, text, { mode: 0o600 });
			}
		} catch (e) {
			console.debug("[vivarium] snapshot", e);
		}
	}

	/** Forget a tile you stopped on purpose: it must not come back after a restart. */
	forget(tileId: string) {
		this.core.setTileState(tileId, { running: false, fg: undefined, agent: undefined });
		this.lastSnap.delete(tileId);
		try {
			fs.unlinkSync(this.snapPath(tileId));
		} catch {}
	}

	/**
	 * How to start a tile whose tmux window doesn't exist. Normally: fresh. If it was running
	 * when the machine went down: restored (see file header).
	 */
	launchFor(spec: TileSpec): { launch: Launch; cwd: string; restored: boolean } {
		const fresh = { launch: this.core.launch(spec), cwd: this.core.resolveCwd(spec.cwd), restored: false };
		const st = this.core.tileState<RunState>(spec.id);
		if (!st.running) return fresh;
		const shell = process.env.SHELL || "/bin/zsh";
		const cwd = st.cwd && fs.existsSync(st.cwd) ? st.cwd : fresh.cwd;
		if (st.fg === "agent" && st.agent?.kind === "claude" && /^[\w-]{8,}$/.test(st.agent.sessionId)) {
			// keep the tile's own flags (model etc.), swap in "resume this exact conversation"
			const own = spec.command.trim();
			const base = own.startsWith("claude") ? own.replace(/\s+(--resume|-r|--continue|-c)(\s+[\w-]{8,})?/g, "") : "claude";
			return { launch: { command: `${shell} -l`, typeIn: `${base} --resume ${st.agent.sessionId}` }, cwd, restored: true };
		}
		const snap = this.snapPath(spec.id);
		const replay = fs.existsSync(snap) ? `cat ${q(snap)}; printf '\\n\\033[2m── restored after restart ──\\033[0m\\n\\n'; ` : "";
		return {
			launch: { command: `/bin/sh -c ${q(`${replay}exec ${shell} -l`)}`, typeIn: st.fg === "program" ? spec.command.trim() || null : null },
			cwd,
			restored: true,
		};
	}

	/** On startup: bring back every tile that was running, without waiting for its canvas. */
	async restoreAll() {
		const files = this.core.app.vault.getFiles().filter((f) => f.extension === "term");
		const wanted: TileSpec[] = [];
		for (const f of files) {
			const spec = await this.core.readSpec(f);
			if (spec && this.core.tileState<RunState>(spec.id).running) wanted.push(spec);
		}
		if (!wanted.length || !this.core.tmuxAvailable()) return;
		await this.core.hub.ensureConnected();
		await this.core.hub.refreshPanes();
		let n = 0;
		for (const spec of wanted) {
			if (this.core.hub.getPane(spec.id)) continue; // still alive (Obsidian restart only)
			const { launch, cwd } = this.launchFor(spec);
			await this.core.hub.ensureWindow(spec.id, launch, cwd, 120, 36).catch((e) => console.warn("[vivarium] restore", e));
			n++;
		}
		if (n) this.core.notice(`restored ${n} program${n === 1 ? "" : "s"} after restart`);
	}
}

type Tree = Map<number, { ppid: number; comm: string }>;

function processTree(): Promise<Tree> {
	return new Promise((resolve) => {
		execFile("ps", ["-A", "-o", "pid=,ppid=,comm="], { maxBuffer: 4 << 20 }, (err, out) => {
			const t: Tree = new Map();
			if (!err) {
				for (const line of out.split("\n")) {
					const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
					if (m) t.set(+m[1], { ppid: +m[2], comm: m[3] });
				}
			}
			resolve(t);
		});
	});
}

/** A Claude Code process below this pane's shell → its session id (from ~/.claude/sessions/<pid>.json). */
function findClaudeSession(rootPid: number, tree: Tree): string | null {
	const children = new Map<number, number[]>();
	for (const [pid, p] of tree) (children.get(p.ppid) ?? children.set(p.ppid, []).get(p.ppid)!).push(pid);
	const dir = path.join(os.homedir(), ".claude", "sessions");
	const stack = [rootPid];
	for (let guard = 0; stack.length && guard < 500; guard++) {
		const pid = stack.pop()!;
		if (pid !== rootPid) {
			try {
				const d = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), "utf8"));
				if (typeof d.sessionId === "string") return d.sessionId;
			} catch {}
		}
		stack.push(...(children.get(pid) ?? []));
	}
	return null;
}
