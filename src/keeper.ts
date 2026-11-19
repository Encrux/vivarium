/**
 * SessionKeeper: makes a reboot or crash as painless as possible.
 *
 * tmux keeps programs alive across Obsidian restarts, but a machine restart ends them. So while
 * you work, every few seconds (cheap: one tmux query + one `ps`), we remember per tile:
 *   - whether it's running, what's in the foreground (shell / coding agent / other program),
 *   - the shell's current folder,
 *   - for Claude Code and Codex: *that tile's* session id (see findAgent),
 * and every 30 s a snapshot of its recent output (outside the vault, ~/.vivarium/snapshots).
 *
 * After a restart, tiles that were running come back on their own (see restoreAll / launchFor):
 * Claude Code via `claude --resume <its session>`, Codex via `codex resume <its session>`, everything else with its old output on screen,
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
	agent?: { kind: "claude" | "codex"; sessionId: string };
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
				const agent = r.dead ? null : await findAgent(r.panePid, tree);
				const fg: RunState["fg"] = r.dead ? undefined : agent ? "agent" : SHELLS.has(path.basename(r.command).replace(/^-/, "")) ? "shell" : "program";
				const next: RunState = {
					running: !r.dead,
					fg,
					cwd: r.cwd || prev.cwd,
					// A dead pane keeps the conversation it last ran, so "Restart" can resume it.
					agent: agent ?? (r.dead ? prev.agent : undefined),
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
		const resume = st.fg === "agent" && st.agent && /^[\w-]{8,}$/.test(st.agent.sessionId) ? resumeCommand(spec.command.trim(), st.agent) : null;
		if (resume) return { launch: { command: `${shell} -l`, typeIn: resume }, cwd, restored: true };
		const snap = this.snapPath(spec.id);
		const replay = fs.existsSync(snap) ? `cat ${q(snap)}; printf '\\n\\033[2m── restored after restart ──\\033[0m\\n\\n'; ` : "";
		return {
			launch: { command: `/bin/sh -c ${q(`${replay}exec ${shell} -l`)}`, typeIn: st.fg === "program" ? spec.command.trim() || null : null },
			cwd,
			restored: true,
		};
	}

	/**
	 * How "Restart" starts a tile: a coding agent comes back with its own conversation (that's what
	 * you lost), anything else starts fresh.
	 */
	restartFor(spec: TileSpec): { launch: Launch; cwd: string } {
		const fresh = { launch: this.core.launch(spec), cwd: this.core.resolveCwd(spec.cwd) };
		const st = this.core.tileState<RunState>(spec.id);
		const resume = st.agent && /^[\w-]{8,}$/.test(st.agent.sessionId) ? resumeCommand(spec.command.trim(), st.agent) : null;
		if (!resume) return fresh;
		const shell = process.env.SHELL || "/bin/zsh";
		const cwd = st.cwd && fs.existsSync(st.cwd) ? st.cwd : fresh.cwd;
		return { launch: { command: `${shell} -l`, typeIn: resume }, cwd };
	}

	/** On startup, or after the tmux server died: bring back every tile that was running, without waiting for its canvas. */
	async restoreAll(why = "after restart") {
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
		if (n) this.core.notice(`restored ${n} program${n === 1 ? "" : "s"} ${why}`);
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

/** The command that reopens this tile's conversation, keeping the tile's own flags (model etc.). */
function resumeCommand(own: string, agent: NonNullable<RunState["agent"]>): string | null {
	if (agent.kind === "claude") {
		const base = own.startsWith("claude") ? own.replace(/\s+(--resume|-r|--continue|-c)(\s+[\w-]{8,})?/g, "") : "claude";
		return `${base} --resume ${agent.sessionId}`;
	}
	if (agent.kind === "codex") {
		// `codex resume <id> [flags]`. Only carry over plain flags: a prompt or another subcommand
		// in the tile's command must not end up as part of the resume.
		const [bin, ...rest] = own.split(/\s+/).filter(Boolean);
		const flags = bin && path.basename(bin) === "codex" && rest.every((t) => t.startsWith("-")) ? rest : [];
		return ["codex", "resume", agent.sessionId, ...flags].join(" ");
	}
	return null;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Files a running Codex holds open that name its thread (= session): the transcript it appends to
 *  (sessions/YYYY/MM/DD/rollout-<time>-<thread>[_<rollout>].jsonl), and its writer lock. */
const CODEX_OPEN_FILE = [
	new RegExp(`/rollout-\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d-(${UUID})(?:_${UUID})?\\.jsonl$`, "i"),
	new RegExp(`/thread-writer-locks/(${UUID})\\.lock$`, "i"),
];

/**
 * The coding agent running below this pane's shell, and its session:
 *   - Claude Code writes ~/.claude/sessions/<pid>.json.
 *   - Codex has no such file, but keeps its transcript (and a lock named after it) open while it
 *     runs, so we ask the OS which files the codex process has open. Before your first message
 *     there is no transcript yet, and nothing to resume either.
 */
async function findAgent(rootPid: number, tree: Tree): Promise<RunState["agent"] | null> {
	const children = new Map<number, number[]>();
	for (const [pid, p] of tree) (children.get(p.ppid) ?? children.set(p.ppid, []).get(p.ppid)!).push(pid);
	const dir = path.join(os.homedir(), ".claude", "sessions");
	const codex: number[] = [];
	const stack = [rootPid];
	for (let guard = 0; stack.length && guard < 500; guard++) {
		const pid = stack.pop()!;
		if (pid !== rootPid) {
			try {
				const d = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), "utf8"));
				if (typeof d.sessionId === "string") return { kind: "claude", sessionId: d.sessionId };
			} catch {}
			if (path.basename(tree.get(pid)?.comm ?? "") === "codex") codex.push(pid);
		}
		stack.push(...(children.get(pid) ?? []));
	}
	for (const pid of codex) {
		const files = await openFiles(pid);
		for (const re of CODEX_OPEN_FILE) {
			for (const f of files) {
				const m = re.exec(f);
				if (m) return { kind: "codex", sessionId: m[1].toLowerCase() };
			}
		}
	}
	return null;
}

/** Paths a process has open (Linux: /proc; macOS: lsof). Empty if we can't tell. */
function openFiles(pid: number): Promise<string[]> {
	if (process.platform === "linux") {
		const fdDir = `/proc/${pid}/fd`;
		try {
			return Promise.resolve(
				fs.readdirSync(fdDir).map((fd) => {
					try {
						return fs.readlinkSync(path.join(fdDir, fd));
					} catch {
						return "";
					}
				}),
			);
		} catch {
			return Promise.resolve([]);
		}
	}
	return new Promise((resolve) => {
		execFile("lsof", ["-n", "-P", "-Fn", "-p", String(pid)], { timeout: 3000, maxBuffer: 4 << 20 }, (_err, out) => {
			resolve(String(out ?? "").split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1)));
		});
	});
}
