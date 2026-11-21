import { Component, FileView, TFile, WorkspaceLeaf } from "obsidian";
import type { VivariumCore } from "./core";
import { TILE_EXT } from "./core";
import { TerminalSurface } from "./terminal";

export const VIEW_TYPE = "vivarium-term";

async function mount(core: VivariumCore, parent: HTMLElement, file: TFile): Promise<TerminalSurface | null> {
	const spec = await core.readSpec(file);
	if (!spec) {
		parent.createDiv({ cls: "vivarium-term-error", text: `${file.name} is not a valid program tile.` });
		return null;
	}
	if (!core.tmuxAvailable()) {
		parent.createDiv({ cls: "vivarium-term-error", text: "tmux not found. Install it (brew install tmux) or set its path in Vivarium settings." });
		return null;
	}
	const start = core.keeper.launchFor(spec); // fresh, or restored after a reboot
	const surface = new TerminalSurface(core, parent, {
		tileId: spec.id, launch: core.launch(spec), cwd: core.resolveCwd(spec.cwd), startLaunch: start.launch, startCwd: start.cwd,
		relaunch: () => core.keeper.restartFor(spec),
		consent: {
			needed: () => !core.isTrusted(spec),
			grant: () => core.trust(spec),
			command: spec.command.trim() || "login shell",
			cwd: start.cwd,
		},
	});
	void surface.start();
	return surface;
}

/**
 * Embed used by canvas file cards and `![[x.term]]` in notes. Canvas keeps this component
 * alive while the card exists and only detaches its DOM when off-screen / zoomed out,
 * which the surface notices via IntersectionObserver.
 */
export class TermEmbed extends Component {
	private surface: TerminalSurface | null = null;
	private nodeObserver: MutationObserver | null = null;

	constructor(private core: VivariumCore, private ctx: { containerEl: HTMLElement }, private file: TFile) {
		super();
		ctx.containerEl.addClass("vivarium-embed");
	}

	async loadFile() {
		if (this.surface) return;
		this.surface = await mount(this.core, this.ctx.containerEl, this.file);
		if (!this.surface) return;
		this.watchCanvasFocus();
	}

	/** On canvas: focusing the card (click) focuses the terminal, so one click → type. */
	private watchCanvasFocus() {
		const tryHook = () => {
			const nodeEl = this.ctx.containerEl.closest(".canvas-node");
			if (!nodeEl || this.nodeObserver) return !!nodeEl;
			let wasFocused = nodeEl.hasClass("is-focused");
			this.nodeObserver = new MutationObserver(() => {
				const f = nodeEl.hasClass("is-focused");
				if (f === wasFocused) return;
				wasFocused = f;
				if (f) this.surface?.focus();
				else this.surface?.blur();
			});
			this.nodeObserver.observe(nodeEl, { attributes: true, attributeFilter: ["class"] });
			if (wasFocused) this.surface?.focus();
			return true;
		};
		if (!tryHook()) {
			// containerEl may not be inside the node yet on first load.
			const t = window.setInterval(() => tryHook() && window.clearInterval(t), 100);
			this.register(() => window.clearInterval(t));
		}
	}

	onunload() {
		this.nodeObserver?.disconnect();
		this.surface?.dispose();
		this.surface = null;
	}
}

/** Opening a `.term` file in a tab shows the same live program. */
export class TermView extends FileView {
	private surface: TerminalSurface | null = null;

	constructor(leaf: WorkspaceLeaf, private core: VivariumCore) {
		super(leaf);
		this.navigation = true;
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getIcon() {
		return "terminal-square";
	}

	canAcceptExtension(ext: string) {
		return ext === TILE_EXT;
	}

	async onLoadFile(file: TFile) {
		this.contentEl.empty();
		this.contentEl.addClass("vivarium-view");
		this.surface = await mount(this.core, this.contentEl, file);
		this.surface?.focus();
	}

	async onUnloadFile() {
		this.surface?.dispose();
		this.surface = null;
		this.contentEl.empty();
	}
}
