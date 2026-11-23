import { Component, FileSystemAdapter, ItemView, Menu, Modal, Plugin, PluginSettingTab, Setting, SettingDefinitionItem, TFile, App, setIcon } from "obsidian";
import { VivariumCore, VivariumSettings, DEFAULT_SETTINGS, Program, TILE_EXT } from "./core";
import { TermEmbed, TermView, VIEW_TYPE } from "./embed";
import { Picked, ProgramPicker } from "./programs";
import { WEB_EXT, WebEmbed, WebView, WEB_VIEW_TYPE } from "./web";
import { BIN_DIR, lingerEnabled, syncAgentIntegration, syncCodexRules } from "./agents";
import { ControlServer } from "./control";
import { SemanticZoom } from "./zoom";
import { hookTileLabel, renameTile } from "./label";
import type { CanvasInternal, CanvasNode, CanvasView, CanvasWorkspaceEvents } from "./internal";

const TILE_EXTS = [TILE_EXT, WEB_EXT];

// Obsidian's canvas internals are undocumented (shapes in internal.ts). Everything that uses
// them checks they exist first, so a future Obsidian without one loses that extra, not the plugin.
/** A canvas we can put cards on: the parts of Canvas we need to put a card where you are. */
type Canvas = CanvasInternal & Required<Pick<CanvasInternal, "posCenter" | "createFileNode">>;

function canAddCards(c: CanvasInternal | undefined): c is Canvas {
	return !!c && typeof c.posCenter === "function" && typeof c.createFileNode === "function";
}

const isTileFile = (f: TFile | undefined) => !!f && TILE_EXTS.includes(f.extension);
interface EmbedRegistry {
	registerExtension(ext: string, make: (ctx: { containerEl: HTMLElement }, file: TFile) => Component): void;
	unregisterExtension(ext: string): void;
}

export default class VivariumPlugin extends Plugin {
	settings!: VivariumSettings;
	core!: VivariumCore;
	private unpatch: (() => void) | null = null;
	private control: ControlServer | null = null;
	zoom!: SemanticZoom;

	async onload() {
		const saved = ((await this.loadData()) ?? {}) as Partial<VivariumSettings> & { agentSkill?: boolean };
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		// Before the agent integration was opt-in it was on by default (setting "agentSkill"):
		// keep it for people who already had it.
		if (saved.agentIntegration === undefined && saved.agentSkill !== undefined) {
			this.settings.agentIntegration = saved.agentSkill;
			this.settings.agentPromptShown = true;
		}
		const adapter = this.app.vault.adapter;
		const pluginDir = adapter instanceof FileSystemAdapter ? `${adapter.getBasePath()}/${this.manifest.dir}` : (this.manifest.dir ?? "");
		this.core = new VivariumCore(this.app, this.settings, pluginDir);
		this.core.initTrust();
		this.zoom = new SemanticZoom(
			(n) => isTileFile(n.file),
			(f) => (TILE_EXTS.includes(f.extension) ? f.basename : null),
		);
		this.core.zoom = this.zoom;
		// Agents/CLI: `vivarium add`, `vivarium note`, … (see bin/vivarium). Tiles get its path.
		this.control = new ControlServer(this);
		this.core.hub.controlSocket = this.control.sockPath;
		if (this.settings.agentIntegration) syncAgentIntegration(true, this.settings.codexRules);

		this.registerView(VIEW_TYPE, (leaf) => new TermView(leaf, this.core));
		this.registerExtensions([TILE_EXT], VIEW_TYPE);
		// Web tiles: a real browser page inside the canvas.
		this.registerView(WEB_VIEW_TYPE, (leaf) => new WebView(leaf, this.core));
		this.registerExtensions([WEB_EXT], WEB_VIEW_TYPE);
		// Live tiles inside canvas cards. Obsidian has no public API for how a file is shown inside a
		// card; without this, tiles still open in their own tab.
		const registry = (this.app as unknown as { embedRegistry?: EmbedRegistry }).embedRegistry;
		if (registry?.registerExtension) {
			registry.registerExtension(TILE_EXT, (ctx, file) => this.withLabel(new TermEmbed(this.core, ctx, file), ctx, file));
			registry.registerExtension(WEB_EXT, (ctx, file) => this.withLabel(new WebEmbed(this.core, ctx, file), ctx, file));
			this.register(() => {
				registry.unregisterExtension(TILE_EXT);
				registry.unregisterExtension(WEB_EXT);
			});
		} else {
			console.warn("[vivarium] this Obsidian version doesn't let plugins show files in canvas cards; tiles open in tabs only");
		}

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
		this.registerProgramCommands();
		this.addCommand({
			id: "restart-program",
			name: "Restart program in selected tile",
			checkCallback: (checking) => this.withSelectedTile(checking, (f) => void this.restartTile(f)),
		});
		this.addCommand({
			id: "kill-program",
			name: "Stop program in selected tile",
			checkCallback: (checking) => this.withSelectedTile(checking, (f) => void this.stopTile(f)),
		});
		this.addCommand({
			id: "cleanup",
			name: "Stop programs whose tile file was deleted",
			callback: () => void this.cleanupOrphans(),
		});
		this.addCommand({
			id: "stop-all",
			name: "Stop all programs",
			callback: () =>
				new ConfirmModal(this.app, "Stop all programs?", "Every program running in a tile ends. (Closing Obsidian doesn't end them, this does.) The tiles stay on your canvases; press Start to run them again.", "Stop all", () => void this.core.stopAll()).open(),
		});
		this.addCommand({
			id: "remove-installed-files",
			name: "Remove files installed outside the vault",
			callback: () =>
				new ConfirmModal(
					this.app,
					"Remove files outside the vault?",
					"Turns off the agent integration and deletes what Vivarium put outside this vault: the vivarium command (~/.vivarium/bin, ~/.local/bin/vivarium), the agent skill (~/.agents/skills/vivarium, ~/.claude/skills/vivarium), the Codex rule, and this vault's saved terminal output (~/.vivarium/snapshots). Files of yours with the same names are left alone.",
					"Remove",
					() => {
						this.settings.snapshots = false;
						this.core.keeper.deleteSnapshots();
						void this.setAgentIntegration(false);
						this.core.notice('removed. Programs that are running keep running: "Stop all programs" ends them.');
					},
				).open(),
		});

		// Right-click on empty canvas (and drag-an-edge-into-empty-space) → "Add program…".
		this.registerEvent(this.app.workspace.on("layout-change", () => this.hookCanvases()));
		this.app.workspace.onLayoutReady(() => {
			this.hookCanvases();
			// After a reboot/crash: bring back what was running (Claude Code resumes its own session).
			this.core.keeper.restoreAll().catch((e) => console.warn("[vivarium] restore", e)).finally(() => this.core.keeper.start());
			if (!this.settings.agentPromptShown) this.offerAgentIntegration();
			// If the plugin was (re)enabled with canvases open, their .term cards show the old
			// (or no) embed; rebuild them with ours.
			this.forEachTermNode((n) => {
				n.unloadChild?.();
				n.render?.();
			});
		});

		// Right-click a tile → restart / stop / copy attach command.
		this.registerEvent(
			(this.app.workspace as unknown as CanvasWorkspaceEvents).on("canvas:node-menu", (menu: Menu, node: CanvasNode) => {
				const f = node.file;
				if (!f || !TILE_EXTS.includes(f.extension)) return;
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
		this.registerEvent(this.app.vault.on("create", (f) => {
			if (f instanceof TFile && f.extension === TILE_EXT) void this.cacheId(f);
		}));
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
							const d = JSON.parse(raw) as { title?: unknown } | null;
							if (!d || typeof d !== "object" || d.title === f.basename) return raw;
							return JSON.stringify({ ...d, title: f.basename }, null, 2) + "\n";
						} catch {
							return raw;
						}
					})
					.catch(() => {});
			}
		}));
		this.app.workspace.onLayoutReady(() => this.app.vault.getFiles().filter((f) => f.extension === TILE_EXT).forEach((f) => void this.cacheId(f)));

		this.registerEvent(this.app.workspace.on("css-change", () => this.core.onAppearanceChanged()));
		this.control.start();
		this.addSettingTab(new VivariumSettingTab(this.app, this));
	}

	onunload() {
		this.unpatch?.();
		this.zoom?.dispose();
		this.forEachTermNode((n) => n.unloadChild?.());
		this.control?.stop();
		activeDocument.querySelectorAll(".vivarium-card-menu-button").forEach((el) => el.remove());
		this.core.dispose();
	}

	/** Once: ask whether coding agents in tiles should get the vivarium CLI and skill (it writes outside the vault). */
	private offerAgentIntegration() {
		this.settings.agentPromptShown = true;
		void this.saveSettings();
		new ConfirmModal(
			this.app,
			"Let coding agents use the canvas?",
			"Coding agents in tiles (Claude Code, Codex, …) can then open tiles next to themselves, fork their conversation into a new tile and read other tiles, with the vivarium command. For that, Vivarium installs the command into ~/.vivarium/bin (linked from ~/.local/bin) and a short skill that tells agents about it into ~/.agents/skills and ~/.claude/skills. You can change this any time in Settings → Vivarium.",
			"Turn on",
			() => void this.setAgentIntegration(true),
			"Not now",
		).open();
	}

	async setAgentIntegration(on: boolean) {
		this.settings.agentIntegration = on;
		const added = syncAgentIntegration(on, this.settings.codexRules);
		this.core.hub.pathPrefix = on ? BIN_DIR : "";
		await this.saveSettings();
		if (on && added.length) this.core.notice("agents in tiles started from now on can use the vivarium command.");
	}

	private programCommandIds: string[] = [];
	/** One command per program in the list (to bind hotkeys), kept in step with the list. */
	registerProgramCommands() {
		for (const id of this.programCommandIds) this.removeCommand(id);
		this.programCommandIds = this.settings.programs.map((p, i) => {
			const id = `add-program-${i}`;
			this.addCommand({
				id,
				name: `Add ${p.name} to canvas`,
				checkCallback: (checking) => {
					const canvas = this.activeCanvas();
					if (!canvas?.posCenter) return false;
					if (!checking) void this.addProgram(canvas, p, canvas.posCenter(), "center");
					return true;
				},
			});
			return id;
		});
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

	private forEachTermNode(fn: (n: CanvasNode) => void) {
		for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
			const canvas = (leaf.view as unknown as CanvasView).canvas;
			if (!canvas?.nodes) continue;
			for (const n of canvas.nodes.values()) if (isTileFile(n.file)) fn(n);
		}
	}

	activeCanvas(): Canvas | null {
		const view = this.app.workspace.getActiveViewOfType(ItemView);
		const canvas = view?.getViewType() === "canvas" ? (view as unknown as CanvasView).canvas : undefined;
		// missing in a future Obsidian → no picker
		return canAddCards(canvas) ? canvas : null;
	}

	private hookCanvases() {
		for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
			const canvas = (leaf.view as unknown as CanvasView).canvas;
			if (!canvas) continue;
			// the menu item and the button add cards: only where we can
			if (canAddCards(canvas)) {
				this.patchCanvasPrototype(canvas);
				this.addCardMenuButton(canvas);
			}
			this.zoom.hook(canvas);
		}
	}

	private patchCanvasPrototype(canvas: Canvas) {
		if (this.unpatch) return;
		// shared by every canvas, which are all like this one
		const proto = Object.getPrototypeOf(canvas) as { showCreationMenu?: (this: Canvas, menu: Menu, pos: { x: number; y: number }, size?: { width: number; height: number }) => void };
		const orig = proto.showCreationMenu;
		if (typeof orig !== "function") return;
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- the patched method needs its own `this` (the canvas)
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
			const win = activeWindow;
			const ghost = activeDocument.body.createDiv({ cls: "vivarium-drag-ghost is-hidden" });
			const move = (e: PointerEvent) => {
				if (!moved && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) > 6) moved = true;
				if (!moved) return;
				ghost.removeClass("is-hidden");
				ghost.setCssStyles({ left: `${e.clientX}px`, top: `${e.clientY}px` });
			};
			const up = (e: PointerEvent) => {
				win.removeEventListener("pointermove", move);
				win.removeEventListener("pointerup", up);
				ghost.remove();
				if (!moved) return this.pickProgram(canvas, canvas.posCenter(), "center");
				if (!canvas.posFromClient || !canvas.wrapperEl) return;
				const rect = canvas.wrapperEl.getBoundingClientRect();
				if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
				this.pickProgram(canvas, canvas.posFromClient({ x: e.clientX, y: e.clientY }), undefined);
			};
			win.addEventListener("pointermove", move);
			win.addEventListener("pointerup", up);
		});
	}

	pickProgram(canvas: Canvas, pos: { x: number; y: number }, position?: string, size?: { width: number; height: number }) {
		new ProgramPicker(this.app, this.settings.programs, (p) => void this.addPicked(canvas, p, pos, position, size)).open();
	}

	private addPicked(canvas: Canvas, p: Picked, pos: { x: number; y: number }, position?: string, size?: { width: number; height: number }) {
		if (p.kind === "program") return this.addProgram(canvas, p.program, pos, position, size);
		return this.addWebTile(canvas, p.url, pos, position, size);
	}

	async addWebTile(canvas: Canvas, url: string, pos: { x: number; y: number }, position?: string, size?: { width: number; height: number }) {
		const file = await this.core.createWebFile(url);
		const node = canvas.createFileNode({ pos, position, file, size: size ?? { width: 1000, height: 700 } });
		canvas.selectOnly?.(node);
		canvas.requestSave?.();
	}

	async addProgram(canvas: Canvas, program: Program, pos: { x: number; y: number }, position?: string, size?: { width: number; height: number }) {
		if (!this.core.tmuxAvailable()) {
			this.core.notice("tmux not found. Install it with `brew install tmux` or set its path in settings.");
			return;
		}
		const file = await this.core.createTileFile(program);
		void this.cacheId(file);
		const node = canvas.createFileNode({
			pos,
			position,
			file,
			size: size ?? { width: this.settings.tileWidth, height: this.settings.tileHeight },
		});
		canvas.selectOnly?.(node);
		canvas.requestSave?.();
	}

	private withSelectedTile(checking: boolean, fn: (f: TFile) => void): boolean {
		const canvas = this.activeCanvas();
		let file: TFile | null = null;
		if (canvas?.selection?.size === 1) file = [...canvas.selection][0].file ?? null;
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

class ConfirmModal extends Modal {
	constructor(app: App, private heading: string, private body: string, private cta: string, private onYes: () => void, private cancel = "Cancel") {
		super(app);
	}

	onOpen() {
		this.setTitle(this.heading);
		this.contentEl.createEl("p", { text: this.body });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(this.cancel).onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(this.cta)
					.setCta()
					.onClick(() => {
						this.close();
						this.onYes();
					}),
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

type SettingRow = { name: string; desc?: string; render: (setting: Setting) => void };
type SettingSection = { heading: string; items: SettingRow[] };

class VivariumSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: VivariumPlugin) {
		super(app, plugin);
	}

	/** Obsidian 1.13+: the settings, searchable from Obsidian's settings search. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.sections().map((g) => ({ type: "group" as const, heading: g.heading, items: g.items.map((r) => ({ name: r.name, desc: r.desc, render: r.render })) }));
	}

	/** Before Obsidian 1.13 (documented fallback): the same settings, built by hand. */
	display() {
		const { containerEl } = this;
		containerEl.empty();
		for (const g of this.sections()) {
			new Setting(containerEl).setName(g.heading).setHeading();
			for (const r of g.items) {
				const st = new Setting(containerEl).setName(r.name);
				if (r.desc) st.setDesc(r.desc);
				r.render(st);
			}
		}
	}

	private refresh() {
		const t = this as unknown as { update?: () => void };
		if (typeof t.update === "function") t.update();
		else this.display();
	}

	private sections(): SettingSection[] {
		const s = this.plugin.settings;
		const save = () => void this.plugin.saveSettings();
		const linger = process.platform === "linux" ? lingerEnabled() : null;
		const restart: SettingRow[] = [
			{
				name: "Show previous output",
				desc: "Saves recent terminal output to ~/.vivarium/snapshots (readable only by you) every 30 seconds, so a tile shows it again after a reboot. Turning it off deletes the saved output.",
				render: (st) => void
					st.addToggle((t) =>
						t.setValue(s.snapshots).onChange((v) => {
							s.snapshots = v;
							if (!v) this.plugin.core.keeper.deleteSnapshots();
							save();
						}),
					),
			},
		];
		if (process.platform === "linux") {
			restart.push({
				name: "Keep programs running when you log out",
				desc:
					"Starts tmux in its own systemd scope instead of Obsidian's, so logging out doesn't end your programs. " +
					(linger === false ? "Also needs lingering, which is off: run `loginctl enable-linger` once. " : linger ? "Lingering is on, so this works. " : "Also needs lingering (`loginctl enable-linger`). ") +
					"Without it, programs end at logout and start again with Obsidian. Takes effect the next time tmux starts.",
				render: (st) => void st.addToggle((t) => t.setValue(s.ownScope).onChange((v) => ((s.ownScope = v), save()))),
			});
		}
		return [
			{
				heading: "Programs",
				items: [
					{
						name: "Program list",
						desc: "One per line: name | command | working directory (optional). An empty command opens your login shell. Each program gets a command you can bind a hotkey to.",
						render: (st) => void
							st.addTextArea((t) => {
								t.inputEl.rows = 8;
								t.inputEl.addClass("vivarium-programs-input");
								t.setValue(s.programs.map((p) => [p.name, p.command, p.cwd].filter((x, i) => i < 2 || x).join(" | ")).join("\n"));
								t.onChange((v) => {
									s.programs = v
										.split("\n")
										.map((l) => l.split("|").map((x) => x.trim()))
										.filter((a) => a[0])
										.map(([name, command = "", cwd = ""]) => ({ name, command, cwd }));
									this.plugin.registerProgramCommands();
									save();
								});
							}),
					},
					{
						name: "Default working directory",
						desc: "Where programs start when they don't name one. Empty: the vault folder.",
						render: (st) => void st.addText((t) => t.setPlaceholder("~/code").setValue(s.defaultCwd).onChange((v) => ((s.defaultCwd = v), save()))),
					},
					{
						name: "Keep a shell after the program exits",
						desc: "For example, quitting Claude Code leaves you at a prompt in the same folder instead of an ended tile.",
						render: (st) => void st.addToggle((t) => t.setValue(s.keepShellAfterExit).onChange((v) => ((s.keepShellAfterExit = v), save()))),
					},
					{
						name: "Tile folder",
						desc: "Where new tile files are created.",
						render: (st) => void st.addText((t) => t.setValue(s.tileFolder).onChange((v) => ((s.tileFolder = v), save()))),
					},
				],
			},
			{
				heading: "Coding agents",
				items: [
					{
						name: "Let coding agents use the canvas",
						desc:
							"Agents in tiles (Claude Code, Codex, …) get the vivarium command, to open tiles next to themselves, fork their conversation and read other tiles. " +
							"Installs the command into ~/.vivarium/bin (linked from ~/.local/bin) and a skill into ~/.agents/skills and ~/.claude/skills. Turning it off removes them.",
						render: (st) => void
							st.addToggle((t) =>
								t.setValue(s.agentIntegration).onChange(async (v) => {
									await this.plugin.setAgentIntegration(v);
									this.refresh();
								}),
							),
					},
					{
						name: "Codex: no sandbox prompts for safe commands",
						desc: "Codex's sandbox blocks the vivarium command, so Codex asks before each use. This lets ls, me, read, wait, note, fork, move and focus run without asking (~/.codex/rules/vivarium.rules). add, send, keys and rm still ask, since they start or drive programs. Needs the setting above.",
						render: (st) => void
							st.setDisabled(!s.agentIntegration).addToggle((t) =>
								t
									.setValue(s.codexRules)
									.setDisabled(!s.agentIntegration)
									.onChange((v) => {
										s.codexRules = v;
										syncCodexRules(v && s.agentIntegration);
										save();
									}),
							),
					},
				],
			},
			{ heading: "After a restart", items: restart },
			{
				heading: "Terminal",
				items: [
					{ name: "Font size", render: (st) => void st.addSlider((sl) => sl.setLimits(8, 24, 1).setValue(s.fontSize).onChange((v) => ((s.fontSize = v), save()))) },
					{
						name: "Font family",
						desc: "Empty: Obsidian's monospace font.",
						render: (st) => void st.addText((t) => t.setValue(s.fontFamily).onChange((v) => ((s.fontFamily = v), save()))),
					},
					{
						name: "Option key as Meta",
						desc: "Off keeps ⌥ for typing characters like @ { } [ ] on non-US layouts.",
						render: (st) => void st.addToggle((t) => t.setValue(s.optionIsMeta).onChange((v) => ((s.optionIsMeta = v), save()))),
					},
					{
						name: "Lines restored on reopen",
						desc: "History repainted from tmux when a tile is reopened. Fewer lines show faster.",
						render: (st) => void st.addText((t) => t.setValue(String(s.restoreLines)).onChange((v) => ((s.restoreLines = Math.max(0, parseInt(v) || 0)), save()))),
					},
				],
			},
			{
				heading: "tmux",
				items: [
					{
						name: "tmux path",
						desc: this.plugin.core.tmuxAvailable() ? "Found." : "tmux not found. Install it (brew install tmux, sudo apt install tmux) or enter its path.",
						render: (st) => void st.addText((t) => t.setPlaceholder("/opt/homebrew/bin/tmux").setValue(s.tmuxPath).onChange((v) => ((s.tmuxPath = v), save()))),
					},
					{
						name: "Socket name",
						desc: `Programs run on the tmux server "-L ${s.socketName}". Attach from any terminal: tmux -L ${s.socketName} attach -t vivarium`,
						render: (st) => void st.addText((t) => t.setValue(s.socketName).onChange((v) => ((s.socketName = v || "vivarium"), save()))),
					},
				],
			},
		];
	}
}
