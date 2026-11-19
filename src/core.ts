import { App, Notice, normalizePath, TFile } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { findTmux, TmuxHub } from "./tmux";
import { TerminalSurface, themeFromCss } from "./terminal";
import { HelperClient, helperBinary } from "./helper";
import type { SemanticZoom } from "./zoom";
import { SessionKeeper } from "./keeper";

export interface Program {
	name: string;
	command: string;
	/** Working directory; empty = settings.defaultCwd. `~` expands to $HOME. */
	cwd: string;
}

export interface VivariumSettings {
	tmuxPath: string;
	socketName: string;
	tileFolder: string;
	defaultCwd: string;
	fontSize: number;
	fontFamily: string;
	scrollback: number;
	restoreLines: number;
	optionIsMeta: boolean;
	keepShellAfterExit: boolean;
	tileWidth: number;
	tileHeight: number;
	programs: Program[];
}

export const DEFAULT_SETTINGS: VivariumSettings = {
	tmuxPath: "",
	socketName: "vivarium",
	tileFolder: "Vivarium",
	defaultCwd: "",
	fontSize: 13,
	fontFamily: "",
	scrollback: 5000,
	restoreLines: 1000,
	optionIsMeta: false,
	keepShellAfterExit: true,
	tileWidth: 640,
	tileHeight: 400,
	programs: [
		{ name: "Shell", command: "", cwd: "" },
		{ name: "Claude Code", command: "claude", cwd: "" },
		// Codex's default full-screen mode keeps its history out of the terminal's scrollback, and
		// the wheel then recalls old prompts. Inline, the tile scrolls through the conversation.
		{ name: "Codex", command: "codex --no-alt-screen", cwd: "" },
		{ name: "htop", command: "htop", cwd: "" },
	],
};

/** Contents of a `.term` file. The file is the tile's identity; tmux holds its live state. */
export interface TileSpec {
	version: 1;
	id: string;
	title: string;
	command: string;
	/** Portable working directory (see portableCwd): "", ".", "sub/dir", "~/…" or absolute. */
	cwd: string;
}

export const TILE_EXT = "term";

export interface Launch {
	/** Process tmux runs in the pane. */
	command: string;
	/** Text typed into that process once started (then Enter), or null. */
	typeIn: string | null;
}

export class VivariumCore {
	hub: TmuxHub;
	readonly sizeOwners = new Map<string, TerminalSurface>();
	private surfaces = new Set<TerminalSurface>();
	private cachedTheme: ReturnType<typeof themeFromCss> | null = null;

	/** Native helper for app tiles; null when not built for this platform. */
	helper: HelperClient | null = null;
	zoom: SemanticZoom | null = null;
	/** Remembers what tiles run, so a reboot/crash can restore them (see keeper.ts). */
	readonly keeper = new SessionKeeper(this);
	private claims = new Map<number, unknown>(); // windowId → surface showing it
	/** .window file path → the real window it shows (for "delete tile → give the window back"). */
	readonly attachedWindows = new Map<string, { windowId: number; pid: number }>();

	constructor(public app: App, public settings: VivariumSettings, private pluginDir: string) {
		this.hub = this.makeHub();
		const bin = helperBinary(pluginDir);
		if (bin) this.helper = new HelperClient(bin);
	}

	private makeHub(): TmuxHub {
		const tmux = findTmux(this.settings.tmuxPath);
		const conf = this.writeTmuxConf();
		const hub = new TmuxHub(tmux ?? "tmux", this.settings.socketName || "vivarium", conf);
		hub.onPanesChanged = () => this.surfaces.forEach((s) => s.onPanesChanged());
		// The tmux server died (crash, OOM, killed) and took every program with it: bring back what
		// was running, agents with their own conversation, as after a reboot.
		hub.onServerRestarted = () => {
			this.keeper.restoreAll("after tmux stopped unexpectedly").catch((e) => console.warn("[vivarium] restore", e));
		};
		hub.vaultName = this.app.vault.getName();
		return hub;
	}

	tmuxAvailable(): boolean {
		return findTmux(this.settings.tmuxPath) !== null;
	}

	private writeTmuxConf(): string {
		const conf = path.join(this.pluginDir, "tmux.conf");
		const body = [
			"# Written by the Vivarium plugin; regenerated on load.",
			"set -g status off",
			`set -g history-limit ${Math.max(this.settings.restoreLines, 20000)}`,
			"set -g default-terminal xterm-256color",
			"set -g remain-on-exit on",
			"set -g allow-rename off",
			"set -g automatic-rename off",
			"set -g escape-time 0",
			"set -g focus-events on",
			// No global `window-size manual` here: tmux 3.6 crashes on start with it. Each tile's window
			// is set to manual on its own instead (see TmuxHub.createWindow).
			"set-environment -g COLORTERM truecolor",
			"set-environment -g TERM_PROGRAM vivarium",
			"",
		].join("\n");
		try {
			fs.mkdirSync(this.pluginDir, { recursive: true });
			fs.writeFileSync(conf, body);
		} catch (e) {
			console.warn("[vivarium] could not write tmux.conf", e);
		}
		return conf;
	}

	registerSurface(s: TerminalSurface): () => void {
		this.surfaces.add(s);
		return () => this.surfaces.delete(s);
	}

	surfacesFor(tileId: string): TerminalSurface[] {
		return [...this.surfaces].filter((s) => s.tileId === tileId);
	}

	theme() {
		return (this.cachedTheme ??= themeFromCss(document.body));
	}

	fontFamily(): string {
		if (this.settings.fontFamily) return this.settings.fontFamily;
		const mono = getComputedStyle(document.body).getPropertyValue("--font-monospace").trim();
		return mono || "Menlo, Monaco, 'Courier New', monospace";
	}

	onAppearanceChanged() {
		this.cachedTheme = null;
		this.surfaces.forEach((s) => s.applyAppearance());
	}

	vaultPath(): string {
		return (this.app.vault.adapter as any).getBasePath?.() ?? process.env.HOME ?? "/";
	}

	/**
	 * How a working directory is stored in a tile file: portable, so a committed vault works on
	 * another machine. "" = the default (settings / vault), "." or "sub/dir" = inside the vault,
	 * "~/…" = inside your home folder, anything else stays absolute.
	 */
	portableCwd(cwd: string): string {
		if (!cwd.trim()) return "";
		const abs = path.resolve(this.resolveCwd(cwd));
		const vault = path.resolve(this.vaultPath());
		const home = process.env.HOME ? path.resolve(process.env.HOME) : null;
		if (abs === vault) return ".";
		if (abs.startsWith(vault + path.sep)) return path.relative(vault, abs);
		if (home && abs === home) return "~";
		if (home && abs.startsWith(home + path.sep)) return "~/" + path.relative(home, abs);
		return abs;
	}

	// ---- per-device tile state (never in the vault: no git churn, nothing machine-specific synced) ----
	private stateCache: Record<string, Record<string, unknown>> | null = null;
	private stateTimer: number | null = null;

	tileState<T = Record<string, unknown>>(id: string): Partial<T> {
		this.stateCache ??= (this.app.loadLocalStorage("vivarium-tile-state") as Record<string, Record<string, unknown>>) ?? {};
		return (this.stateCache[id] ?? {}) as Partial<T>;
	}

	setTileState(id: string, patch: Record<string, unknown> | null) {
		this.stateCache ??= (this.app.loadLocalStorage("vivarium-tile-state") as Record<string, Record<string, unknown>>) ?? {};
		if (patch === null) delete this.stateCache[id];
		else this.stateCache[id] = { ...this.stateCache[id], ...patch };
		if (this.stateTimer !== null) window.clearTimeout(this.stateTimer);
		this.stateTimer = window.setTimeout(() => {
			this.stateTimer = null;
			this.app.saveLocalStorage("vivarium-tile-state", this.stateCache);
		}, 500);
	}

	resolveCwd(cwd: string): string {
		let c = cwd || this.settings.defaultCwd || this.vaultPath();
		if (c.startsWith("~")) c = path.join(process.env.HOME ?? "/", c.slice(1));
		if (!path.isAbsolute(c)) c = path.join(this.vaultPath(), c);
		return c;
	}

	/**
	 * How tmux starts a tile. With "keep shell" on, we start your login shell and *type* the
	 * command into it, exactly as if you had: Ctrl+C returns to a prompt, ↑ re-runs it, and PATH,
	 * aliases and functions match your normal terminal. Otherwise the program is the pane's
	 * process and the tile shows "exited" when it ends.
	 */
	launch(spec: TileSpec): Launch {
		const shell = process.env.SHELL || "/bin/zsh";
		const cmd = spec.command.trim();
		if (!cmd) return { command: `${shell} -l`, typeIn: null };
		if (this.settings.keepShellAfterExit) return { command: `${shell} -l`, typeIn: cmd };
		const q = (s: string) => "'" + s.replace(/'/g, `'\\''`) + "'";
		return { command: `${shell} -lic ${q(cmd)}`, typeIn: null };
	}

	async readSpec(file: TFile): Promise<TileSpec | null> {
		try {
			const raw = JSON.parse(await this.app.vault.cachedRead(file));
			if (!raw || typeof raw.id !== "string") return null;
			return { version: 1, id: raw.id, title: raw.title ?? file.basename, command: raw.command ?? "", cwd: raw.cwd ?? "" };
		} catch {
			return null;
		}
	}

	/** Create a new `.term` file for a program. */
	async createTileFile(program: Program): Promise<TFile> {
		const id = "t" + Math.random().toString(36).slice(2, 9);
		const folder = normalizePath(this.settings.tileFolder || "Vivarium");
		if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {});
		const base = (program.name || "Program").replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || "Program";
		let p = normalizePath(`${folder}/${base}.${TILE_EXT}`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(p); i++) p = normalizePath(`${folder}/${base} ${i}.${TILE_EXT}`);
		const spec: TileSpec = { version: 1, id, title: program.name, command: program.command, cwd: this.portableCwd(program.cwd) };
		return this.app.vault.create(p, JSON.stringify(spec, null, 2) + "\n");
	}

	async killTile(spec: TileSpec) {
		await this.stopTile(spec.id);
	}

	/** Stop a tile's program on purpose: it also won't be restored after a restart. */
	async stopTile(tileId: string) {
		this.keeper.forget(tileId);
		await this.hub.killWindow(tileId);
	}

	notice(msg: string) {
		new Notice(`Vivarium: ${msg}`);
	}

	claimWindow(id: number, owner: unknown) {
		this.claims.set(id, owner);
	}

	releaseWindow(id: number, owner: unknown) {
		if (this.claims.get(id) === owner) this.claims.delete(id);
	}

	windowClaimedByOther(id: number, owner: unknown) {
		const c = this.claims.get(id);
		return c !== undefined && c !== owner;
	}

	/** Create a `.web` tile file for a page. */
	async createWebFile(url: string, title?: string): Promise<TFile> {
		const id = "b" + Math.random().toString(36).slice(2, 9);
		const folder = normalizePath(this.settings.tileFolder || "Vivarium");
		if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {});
		let host = title || url;
		try {
			const u = new URL(url);
			// local files: their name; web: the host (github.com, localhost:3000)
			host = title || (u.protocol === "file:" ? decodeURIComponent(u.pathname.split("/").pop() || "file") : u.host) || url;
		} catch {}
		const base = host.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim().slice(0, 60) || "Web";
		let p = normalizePath(`${folder}/${base}.web`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(p); i++) p = normalizePath(`${folder}/${base} ${i}.web`);
		return this.app.vault.create(p, JSON.stringify({ version: 1, id, kind: "web", title: base, url }, null, 2) + "\n");
	}

	/** Create a `.window` tile file for an app (optionally pinned to an existing window). */
	async createWindowFile(app: { name: string; bundleId: string; path?: string }, windowId?: number, titleHint?: string): Promise<TFile> {
		const id = "w" + Math.random().toString(36).slice(2, 9);
		const folder = normalizePath(this.settings.tileFolder || "Vivarium");
		if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {});
		const base = (app.name || "App").replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || "App";
		let p = normalizePath(`${folder}/${base}.window`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(p); i++) p = normalizePath(`${folder}/${base} ${i}.window`);
		// which window it shows is per-device state, not part of the (committable) file
		if (windowId !== undefined) this.setTileState(id, { windowId, titleHint });
		const spec = { version: 1, id, kind: "app", title: app.name, app };
		return this.app.vault.create(p, JSON.stringify(spec, null, 2) + "\n");
	}

	dispose() {
		this.keeper.stop();
		if (this.stateTimer !== null) {
			window.clearTimeout(this.stateTimer);
			this.app.saveLocalStorage("vivarium-tile-state", this.stateCache);
		}
		this.hub.dispose();
		this.helper?.dispose();
	}
}
