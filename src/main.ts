import { Component, ItemView, Menu, Plugin, PluginSettingTab, Setting, TFile, App, setIcon } from "obsidian";
import { VivariumCore, VivariumSettings, DEFAULT_SETTINGS, Program, TILE_EXT } from "./core";
import { TermEmbed, TermView, VIEW_TYPE } from "./embed";
import { Picked, ProgramPicker } from "./programs";
import { WINDOW_EXT, WindowEmbed, WindowView, WINDOW_VIEW_TYPE } from "./window";
import { WEB_EXT, WebEmbed, WebView, WEB_VIEW_TYPE } from "./web";
import type { AppInfo, WindowInfo } from "./helper";
import { installCli, syncCodexRules, syncSkill } from "./agents";
import { ControlServer } from "./control";
import { SemanticZoom } from "./zoom";
import { hookTileLabel, renameTile } from "./label";

// Minimal shapes for Obsidian's (undocumented) canvas internals we touch.
interface CanvasNode {
	file?: TFile;
	x: number;
	y: number;
	width: number;
	height: number;
}
interface Canvas {
	wrapperEl: HTMLElement;
	cardMenuEl: HTMLElement;
	selection: Set<CanvasNode>;
	posCenter(): { x: number; y: number };
	createFileNode(o: { pos: { x: number; y: number }; size?: { width: number; height: number }; position?: string; file: TFile; save?: boolean; focus?: boolean }): CanvasNode;
	showCreationMenu(menu: Menu, pos: { x: number; y: number }, size?: { width: number; height: number }): void;
	selectOnly(n: CanvasNode): void;
	requestSave(): void;
}

export default class VivariumPlugin extends Plugin {
	settings!: VivariumSettings;
	core!: VivariumCore;
	private unpatch: (() => void) | null = null;
	private control: ControlServer | null = null;
	zoom!: SemanticZoom;

	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		const pluginDir = `${(this.app.vault.adapter as any).getBasePath()}/${this.manifest.dir}`;
		this.core = new VivariumCore(this.app, this.settings, pluginDir);
		this.setUpAgents(pluginDir);
		this.core.initTrust();
		this.zoom = new SemanticZoom(
			(n) => [TILE_EXT, WINDOW_EXT, WEB_EXT].includes(n.file?.extension),
			(f) => ([TILE_EXT, WINDOW_EXT, WEB_EXT].includes(f.extension) ? f.basename : null),
		);
		this.core.zoom = this.zoom;

		this.registerView(VIEW_TYPE, (leaf) => new TermView(leaf, this.core));
		this.registerExtensions([TILE_EXT], VIEW_TYPE);
		const registry = (this.app as any).embedRegistry;
		registry.registerExtension(TILE_EXT, (ctx: any, file: TFile) => this.withLabel(new TermEmbed(this.core, ctx, file), ctx, file));
		this.register(() => registry.unregisterExtension(TILE_EXT));
		// App tiles (any native window), when the helper exists for this platform.
		this.registerView(WINDOW_VIEW_TYPE, (leaf) => new WindowView(leaf, this.core));
		this.registerExtensions([WINDOW_EXT], WINDOW_VIEW_TYPE);
		registry.registerExtension(WINDOW_EXT, (ctx: any, file: TFile) => this.withLabel(new WindowEmbed(this.core, ctx, file), ctx, file));
		this.register(() => registry.unregisterExtension(WINDOW_EXT));
		// Web tiles: a real browser page inside the canvas.
		this.registerView(WEB_VIEW_TYPE, (leaf) => new WebView(leaf, this.core));
		this.registerExtensions([WEB_EXT], WEB_VIEW_TYPE);
		registry.registerExtension(WEB_EXT, (ctx: any, file: TFile) => this.withLabel(new WebEmbed(this.core, ctx, file), ctx, file));
		this.register(() => registry.unregisterExtension(WEB_EXT));

		this.addCommand({
			id: "add-program",
			name: "Add program to canvas…",
			checkCallback: (checking) => {
				const canvas = this.activeCanvas();
				if (!canvas) return false;
				if (!checking) this.pickProgram(canvas, canvas.posCenter(), "center");
				return true;
			},
		});
		this.settings.programs.forEach((p, i) =>
			this.addCommand({
				id: `add-program-${i}`,
				name: `Add ${p.name} to canvas`,
				checkCallback: (checking) => {
					const canvas = this.activeCanvas();
					if (!canvas) return false;
					if (!checking) this.addProgram(canvas, p, canvas.posCenter(), "center");
					return true;
				},
			}),
		);
		this.addCommand({
			id: "restart-program",
			name: "Restart program in selected tile",
			checkCallback: (checking) => this.withSelectedTile(checking, (f) => this.restartTile(f)),
		});
		this.addCommand({
			id: "kill-program",
			name: "Stop program in selected tile",
			checkCallback: (checking) => this.withSelectedTile(checking, (f) => this.stopTile(f)),
		});
		this.addCommand({
			id: "cleanup",
			name: "Stop programs whose tile file was deleted",
			callback: () => this.cleanupOrphans(),
		});

		// Right-click on empty canvas (and drag-an-edge-into-empty-space) → "Add program…".
		this.registerEvent(this.app.workspace.on("layout-change", () => this.hookCanvases()));
		this.app.workspace.onLayoutReady(() => {
			this.hookCanvases();
			// After a reboot/crash: bring back what was running (Claude Code resumes its own session).
			this.core.keeper.restoreAll().catch((e) => console.warn("[vivarium] restore", e)).finally(() => this.core.keeper.start());
			// If the plugin was (re)enabled with canvases open, their .term cards show the old
			// (or no) embed; rebuild them with ours.
			this.forEachTermNode((n) => {
				n.unloadChild?.();
				n.render?.();
			});
		});

		// Right-click a tile → restart / stop / copy attach command.
		this.registerEvent(
			(this.app.workspace as any).on("canvas:node-menu", (menu: Menu, node: CanvasNode) => {
				const f = node.file;
				if (!f || ![TILE_EXT, WINDOW_EXT, WEB_EXT].includes(f.extension)) return;
				menu.addItem((i) => i.setSection("vivarium").setTitle("Rename tile…").setIcon("pencil").onClick(() => renameTile(this.app, f)));
				if (f.extension !== TILE_EXT) return;
				menu.addItem((i) => i.setSection("vivarium").setTitle("Restart program").setIcon("rotate-ccw").onClick(() => this.restartTile(f)));
				menu.addItem((i) => i.setSection("vivarium").setTitle("Stop program").setIcon("square").onClick(() => this.stopTile(f)));
				menu.addItem((i) =>
					i.setSection("vivarium").setTitle("Copy tmux attach command").setIcon("copy").onClick(async () => {
						const spec = await this.core.readSpec(f);
						if (!spec) return;
						await navigator.clipboard.writeText(`tmux -L ${this.settings.socketName} attach -t vivarium:${spec.id}`);
						this.core.notice("attach command copied");
					}),
				);
			}),
		);

		// Deleting a tile file stops its program (the card on the canvas just references the file).
		this.registerEvent(
			this.app.vault.on("delete", (f) => {
				if (!(f instanceof TFile) || f.extension !== TILE_EXT) return;
				const id = this.idCache.get(f.path);
				if (id) this.core.stopTile(id).catch(() => {});
			}),
		);
		this.registerEvent(this.app.vault.on("create", (f) => f instanceof TFile && f.extension === TILE_EXT && this.cacheId(f)));
		// Deleting an app tile hands its window back to your desktop (the app keeps running).
		this.registerEvent(
			this.app.vault.on("delete", (f) => {
				const w = this.core.attachedWindows.get(f.path);
				if (!w) return;
				this.core.attachedWindows.delete(f.path);
				this.core.helper?.request("unpark", w).catch(() => {});
			}),
		);
		this.registerEvent(this.app.vault.on("rename", (f, old) => {
			const id = this.idCache.get(old);
			if (id) {
				this.idCache.delete(old);
				this.idCache.set(f.path, id);
			}
			// The tile's name is its file name: keep the title stored inside (`vivarium ls`) in step.
			if (f instanceof TFile && f.extension === TILE_EXT) {
				this.app.vault
					.process(f, (raw) => {
						try {
							const d = JSON.parse(raw);
							if (!d || typeof d !== "object" || d.title === f.basename) return raw;
							return JSON.stringify({ ...d, title: f.basename }, null, 2) + "\n";
						} catch {
							return raw;
						}
					})
					.catch(() => {});
			}
		}));
		this.app.workspace.onLayoutReady(() => this.app.vault.getFiles().filter((f) => f.extension === TILE_EXT).forEach((f) => this.cacheId(f)));

		this.registerEvent(this.app.workspace.on("css-change", () => this.core.onAppearanceChanged()));
		// Agents/CLI: `vivarium add`, `vivarium note`, … (see bin/vivarium).
		this.control = new ControlServer(this);
		this.control.start();
		this.addSettingTab(new VivariumSettingTab(this.app, this));
	}

	onunload() {
		this.unpatch?.();
		this.zoom?.dispose();
		this.forEachTermNode((n) => n.unloadChild?.());
		this.control?.stop();
		document.querySelectorAll(".vivarium-card-menu-button").forEach((el) => el.remove());
		this.core.dispose();
	}

	/** The vivarium CLI on every tile's PATH, and a skill so coding agents know it (see agents.ts). */
	private setUpAgents(pluginDir: string) {
		try {
			installCli(pluginDir);
		} catch (e) {
			console.warn("[vivarium] could not install the CLI", e);
		}
		const added = syncSkill(this.settings.agentSkill);
		if (added.length && this.settings.agentSkill) {
			const home = process.env.HOME ?? "";
			this.core.notice(`coding agents in tiles can now use the vivarium CLI (skill in ${added.map((d) => d.replace(home, "~")).join(", ")}). Turn off in settings.`);
		}
		syncCodexRules(this.settings.codexRules);
	}

	/** Every tile card: name without the file ending, double-click the name to rename. */
	private withLabel<T extends Component>(embed: T, ctx: { containerEl: HTMLElement }, file: TFile): T {
		hookTileLabel(this.app, embed, ctx.containerEl, file);
		return embed;
	}

	// File deletion fires after the file is gone, so remember each tile's id up front.
	private idCache = new Map<string, string>();
	private async cacheId(f: TFile) {
		const spec = await this.core.readSpec(f);
		if (spec) this.idCache.set(f.path, spec.id);
	}

	private forEachTermNode(fn: (n: any) => void) {
		for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
			const canvas = (leaf.view as any).canvas;
			if (!canvas?.nodes) continue;
			for (const n of canvas.nodes.values()) if ([TILE_EXT, WINDOW_EXT, WEB_EXT].includes(n.file?.extension)) fn(n);
		}
	}

	activeCanvas(): Canvas | null {
		const view = this.app.workspace.getActiveViewOfType(ItemView);
		return view?.getViewType() === "canvas" ? ((view as any).canvas as Canvas) : null;
	}

	private hookCanvases() {
		for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
			const canvas = (leaf.view as any).canvas as Canvas | undefined;
			if (!canvas) continue;
			this.patchCanvasPrototype(canvas);
			this.addCardMenuButton(canvas);
			this.zoom.hook(canvas);
		}
	}

	private patchCanvasPrototype(canvas: Canvas) {
		if (this.unpatch) return;
		const proto = Object.getPrototypeOf(canvas);
		const orig = proto.showCreationMenu;
		if (typeof orig !== "function") return;
		const plugin = this;
		proto.showCreationMenu = function (this: Canvas, menu: Menu, pos: { x: number; y: number }, size?: { width: number; height: number }) {
			orig.call(this, menu, pos, size);
			menu.addItem((i) =>
				i.setTitle("Add program…").setSection("create").setIcon("terminal-square").onClick(() => plugin.pickProgram(this, pos, undefined, size)),
			);
		};
		this.unpatch = () => {
			proto.showCreationMenu = orig;
		};
	}

	/** A button in the canvas's bottom card toolbar: click → picker, drag → drop a program where you release. */
	private addCardMenuButton(canvas: Canvas) {
		const menuEl = canvas.cardMenuEl;
		if (!menuEl || menuEl.querySelector(".vivarium-card-menu-button")) return;
		const btn = menuEl.createDiv({ cls: "canvas-card-menu-button mod-draggable vivarium-card-menu-button", attr: { "aria-label": "Drag to add program", "data-tooltip-position": "top" } });
		setIcon(btn, "terminal-square");
		btn.addEventListener("pointerdown", (down) => {
			if (down.button !== 0) return;
			down.preventDefault();
			let moved = false;
			const ghost = document.body.createDiv({ cls: "vivarium-drag-ghost" });
			ghost.style.display = "none";
			const move = (e: PointerEvent) => {
				if (!moved && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) > 6) moved = true;
				if (!moved) return;
				ghost.style.display = "";
				ghost.style.left = `${e.clientX}px`;
				ghost.style.top = `${e.clientY}px`;
			};
			const up = (e: PointerEvent) => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				ghost.remove();
				if (!moved) return this.pickProgram(canvas, canvas.posCenter(), "center");
				const rect = canvas.wrapperEl.getBoundingClientRect();
				if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
				this.pickProgram(canvas, (canvas as any).posFromClient({ x: e.clientX, y: e.clientY }), undefined);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		});
	}

	async pickProgram(canvas: Canvas, pos: { x: number; y: number }, position?: string, size?: { width: number; height: number }) {
		// Open windows + installed apps come from the helper; don't let a slow helper delay the picker.
		let windows: WindowInfo[] = [], apps: AppInfo[] = [];
		const h = this.core.helper;
		if (h) {
			const lists = Promise.all([h.request("list_windows"), (this.appsCache ??= h.request("list_apps").then((r) => r.apps))]);
			const r = await Promise.race([lists, new Promise<null>((res) => setTimeout(() => res(null), 600))]).catch(() => null);
			if (r) {
				windows = r[0].windows;
				apps = r[1];
			}
		}
		new ProgramPicker(this.app, this.settings.programs, (p) => this.addPicked(canvas, p, pos, position, size), windows, apps).open();
	}

	private appsCache: Promise<AppInfo[]> | null = null;

	private addPicked(canvas: Canvas, p: Picked, pos: { x: number; y: number }, position?: string, size?: { width: number; height: number }) {
		if (p.kind === "program") return this.addProgram(canvas, p.program, pos, position, size);
		if (p.kind === "web") return this.addWebTile(canvas, p.url, pos, position, size);
		if (p.kind === "window") return this.addWindowTile(canvas, { name: p.win.app, bundleId: p.win.bundleId }, pos, position, p.win);
		return this.addWindowTile(canvas, { name: p.app.name, bundleId: p.app.bundleId, path: p.app.path }, pos, position);
	}

	async addWebTile(canvas: Canvas, url: string, pos: { x: number; y: number }, position?: string, size?: { width: number; height: number }) {
		const file = await this.core.createWebFile(url);
		const node = canvas.createFileNode({ pos, position, file, size: size ?? { width: 1000, height: 700 } });
		canvas.selectOnly(node);
		canvas.requestSave();
	}

	async addWindowTile(canvas: Canvas, app: { name: string; bundleId: string; path?: string }, pos: { x: number; y: number }, position?: string, win?: WindowInfo) {
		const file = await this.core.createWindowFile(app, win?.windowId, win?.title);
		// Tile starts at the window's own size (shrunk to a sensible canvas size), so it maps 1:1 at 100% zoom.
		let w = win?.width ?? 900, h = win?.height ?? 620;
		const k = Math.min(1, 1000 / w, 720 / h);
		w = Math.round(w * k);
		h = Math.round(h * k);
		const node = canvas.createFileNode({ pos, position, file, size: { width: w, height: h } });
		canvas.selectOnly(node);
		canvas.requestSave();
	}

	async addProgram(canvas: Canvas, program: Program, pos: { x: number; y: number }, position?: string, size?: { width: number; height: number }) {
		if (!this.core.tmuxAvailable()) {
			this.core.notice("tmux not found. Install it with `brew install tmux` or set its path in settings.");
			return;
		}
		const file = await this.core.createTileFile(program);
		this.cacheId(file);
		const node = canvas.createFileNode({
			pos,
			position,
			file,
			size: size ?? { width: this.settings.tileWidth, height: this.settings.tileHeight },
		});
		canvas.selectOnly(node);
		canvas.requestSave();
	}

	private withSelectedTile(checking: boolean, fn: (f: TFile) => void): boolean {
		const canvas = this.activeCanvas();
		let file: TFile | null = null;
		if (canvas && canvas.selection.size === 1) file = [...canvas.selection][0].file ?? null;
		else {
			const f = this.app.workspace.getActiveFile();
			if (f?.extension === TILE_EXT && !canvas) file = f;
		}
		if (!file || file.extension !== TILE_EXT) return false;
		if (!checking) fn(file);
		return true;
	}

	private async restartTile(f: TFile) {
		const spec = await this.core.readSpec(f);
		if (!spec) return;
		const surfaces = this.core.surfacesFor(spec.id);
		if (surfaces.length) await surfaces[0].restart();
		else {
			const { launch, cwd } = this.core.keeper.restartFor(spec);
			await this.core.hub.respawn(spec.id, launch, cwd);
		}
	}

	private async stopTile(f: TFile) {
		const spec = await this.core.readSpec(f);
		if (spec) await this.core.killTile(spec);
	}

	private async cleanupOrphans() {
		await this.core.hub.ensureConnected();
		await this.core.hub.refreshPanes();
		const live = new Set<string>();
		for (const f of this.app.vault.getFiles()) {
			if (f.extension !== TILE_EXT) continue;
			const spec = await this.core.readSpec(f);
			if (spec) live.add(spec.id);
		}
		const orphans = this.core.hub.allPanes().filter((p) => !live.has(p.tileId));
		for (const p of orphans) await this.core.stopTile(p.tileId);
		this.core.notice(`stopped ${orphans.length} orphaned program${orphans.length === 1 ? "" : "s"}`);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.core.onAppearanceChanged();
	}
}

class VivariumSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: VivariumPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl).setName("Programs").setHeading();
		new Setting(containerEl)
			.setName("Program list")
			.setDesc("One per line: Name | command | working directory (optional). Empty command = login shell. Changes to the list's commands apply after reloading the plugin.")
			.addTextArea((t) => {
				t.inputEl.rows = 8;
				t.inputEl.addClass("vivarium-programs-input");
				t.setValue(s.programs.map((p) => [p.name, p.command, p.cwd].filter((x, i) => i < 2 || x).join(" | ")).join("\n"));
				t.onChange((v) => {
					s.programs = v
						.split("\n")
						.map((l) => l.split("|").map((x) => x.trim()))
						.filter((a) => a[0])
						.map(([name, command = "", cwd = ""]) => ({ name, command, cwd }));
					save();
				});
			});
		new Setting(containerEl)
			.setName("Default working directory")
			.setDesc("Where programs start when they don't specify one. Empty = vault folder.")
			.addText((t) => t.setPlaceholder("~/code").setValue(s.defaultCwd).onChange((v) => ((s.defaultCwd = v), save())));
		new Setting(containerEl)
			.setName("Keep a shell after the program exits")
			.setDesc("E.g. quitting Claude Code leaves you at a prompt in the same directory instead of a dead tile.")
			.addToggle((t) => t.setValue(s.keepShellAfterExit).onChange((v) => ((s.keepShellAfterExit = v), save())));
		new Setting(containerEl).setName("Coding agents").setHeading();
		new Setting(containerEl)
			.setName("Teach coding agents about Vivarium")
			.setDesc("Installs a \"vivarium\" skill for Codex (~/.agents/skills) and Claude Code (~/.claude/skills), so agents in tiles can open tiles, fork their conversation and read other tiles. Costs agents one line of context until they use it.")
			.addToggle((t) => t.setValue(s.agentSkill).onChange((v) => ((s.agentSkill = v), syncSkill(v), save())));
		new Setting(containerEl)
			.setName("Codex: no sandbox prompts for safe commands")
			.setDesc("Codex's sandbox blocks the vivarium CLI, so it asks before each use. This lets ls, me, read, wait, note, fork, move and focus run without asking (~/.codex/rules/vivarium.rules). add, send, keys and rm still ask: they start or drive programs outside the sandbox.")
			.addToggle((t) => t.setValue(s.codexRules).onChange((v) => ((s.codexRules = v), syncCodexRules(v), save())));
		new Setting(containerEl)
			.setName("Tile folder")
			.setDesc("Where new .term tile files are created.")
			.addText((t) => t.setValue(s.tileFolder).onChange((v) => ((s.tileFolder = v), save())));

		new Setting(containerEl).setName("Terminal").setHeading();
		new Setting(containerEl).setName("Font size").addSlider((sl) => sl.setLimits(8, 24, 1).setValue(s.fontSize).setDynamicTooltip().onChange((v) => ((s.fontSize = v), save())));
		new Setting(containerEl)
			.setName("Font family")
			.setDesc("Empty = Obsidian's monospace font.")
			.addText((t) => t.setValue(s.fontFamily).onChange((v) => ((s.fontFamily = v), save())));
		new Setting(containerEl)
			.setName("Option key as Meta")
			.setDesc("Off keeps ⌥ for typing characters like @ { } [ ] on non-US layouts.")
			.addToggle((t) => t.setValue(s.optionIsMeta).onChange((v) => ((s.optionIsMeta = v), save())));
		new Setting(containerEl)
			.setName("Lines restored on reopen")
			.setDesc("History repainted from tmux when a tile is reopened. Lower = faster to show.")
			.addText((t) => t.setValue(String(s.restoreLines)).onChange((v) => ((s.restoreLines = Math.max(0, parseInt(v) || 0)), save())));

		new Setting(containerEl).setName("tmux").setHeading();
		new Setting(containerEl)
			.setName("tmux path")
			.setDesc(this.plugin.core.tmuxAvailable() ? "Found." : "tmux not found — install with `brew install tmux` or enter its path.")
			.addText((t) => t.setPlaceholder("/opt/homebrew/bin/tmux").setValue(s.tmuxPath).onChange((v) => ((s.tmuxPath = v), save())));
		new Setting(containerEl)
			.setName("Socket name")
			.setDesc(`Programs live on tmux server "-L ${s.socketName}". Attach from any terminal: tmux -L ${s.socketName} attach -t vivarium`)
			.addText((t) => t.setValue(s.socketName).onChange((v) => ((s.socketName = v || "vivarium"), save())));
	}
}
