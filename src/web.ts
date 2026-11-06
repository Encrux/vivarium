/**
 * Web tiles: a real Chromium page *inside* the canvas (Electron <webview>), not a streamed window.
 * Clicks, typing, scrolling, hover and drag are native and immediate, it scales with the canvas
 * and Obsidian keeps focus. Logins persist in their own profile ("persist:vivarium").
 *
 * Pages stay alive while the card exists (Canvas would otherwise detach off-screen cards, and a
 * detached <webview> reloads), but stop painting while off-screen or tiny.
 */
import { Component, FileView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type { VivariumCore } from "./core";

export const WEB_EXT = "web";
export const WEB_VIEW_TYPE = "vivarium-web";
export const WEB_PARTITION = "persist:vivarium";

export interface WebSpec {
	version: 1;
	id: string;
	kind: "web";
	title: string;
	url: string;
}

/** Turn what you typed into a URL: "localhost:3000" → http://…, "example.com" → https://… */
export function normalizeUrl(q: string): string | null {
	const s = q.trim();
	if (!s || /\s/.test(s)) return null;
	if (/^(https?|file):\/\//i.test(s)) return s;
	if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(s)) return "http://" + s;
	if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) return "https://" + s;
	return null;
}

export async function readWebSpec(core: VivariumCore, file: TFile): Promise<WebSpec | null> {
	try {
		const raw = JSON.parse(await core.app.vault.cachedRead(file));
		if (!raw?.id || typeof raw.url !== "string") return null;
		return { version: 1, kind: "web", id: raw.id, title: raw.title ?? file.basename, url: raw.url };
	} catch {
		return null;
	}
}

class WebSurface {
	readonly el: HTMLElement;
	private wv: any; // Electron WebviewTag
	private urlInput: HTMLInputElement;
	private backBtn!: HTMLElement;
	private fwdBtn!: HTMLElement;
	private io: IntersectionObserver;
	private saveTimer: number | null = null;
	private offZoom: () => void;
	private onScreen = true;
	private tiny = false;
	private cssWidth = 0;
	private ro: ResizeObserver;

	constructor(private core: VivariumCore, parent: HTMLElement, private spec: WebSpec, private file: TFile) {
		this.el = parent.createDiv({ cls: "vivarium-web" });
		const bar = this.el.createDiv({ cls: "vivarium-web-bar" });
		const btn = (icon: string, label: string, fn: () => void) => {
			const b = bar.createDiv({ cls: "clickable-icon", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.addEventListener("pointerdown", (e) => e.stopPropagation());
			b.addEventListener("click", (e) => (e.stopPropagation(), fn()));
			return b;
		};
		this.backBtn = btn("arrow-left", "Back", () => this.wv.canGoBack() && this.wv.goBack());
		this.fwdBtn = btn("arrow-right", "Forward", () => this.wv.canGoForward() && this.wv.goForward());
		btn("rotate-cw", "Reload", () => this.wv.reload());
		this.urlInput = bar.createEl("input", { cls: "vivarium-web-url", attr: { type: "text", spellcheck: "false" } });
		this.urlInput.value = spec.url;
		this.urlInput.addEventListener("pointerdown", (e) => e.stopPropagation());
		this.urlInput.addEventListener("keydown", (e) => {
			e.stopPropagation(); // typing an address must not trigger canvas shortcuts
			if (e.key === "Enter") {
				const u = normalizeUrl(this.urlInput.value) ?? `https://duckduckgo.com/?q=${encodeURIComponent(this.urlInput.value)}`;
				this.wv.loadURL(u);
				this.wv.focus();
			} else if (e.key === "Escape") {
				this.urlInput.value = this.wv.getURL?.() ?? spec.url;
				this.urlInput.blur();
			}
		});
		this.urlInput.addEventListener("focus", () => this.urlInput.select());
		btn("external-link", "Open in your browser", () => window.open(this.wv.getURL?.() ?? spec.url));
		btn("maximize", "Full screen (Esc to leave)", () => this.el.requestFullscreen().catch(() => {}));

		const wv = (this.wv = document.createElement("webview") as any);
		wv.setAttribute("partition", WEB_PARTITION);
		wv.setAttribute("allowpopups", "");
		wv.setAttribute("src", spec.url);
		wv.addClass("vivarium-web-view");
		this.el.appendChild(wv);
		const nav = () => {
			const u = wv.getURL();
			if (document.activeElement !== this.urlInput) this.urlInput.value = u;
			this.backBtn.toggleClass("is-disabled", !wv.canGoBack());
			this.fwdBtn.toggleClass("is-disabled", !wv.canGoForward());
			this.persist(u, undefined);
		};
		wv.addEventListener("did-navigate", nav);
		wv.addEventListener("did-navigate-in-page", nav);
		wv.addEventListener("page-title-updated", (e: any) => this.persist(undefined, e.title));

		// Off-screen or tiny: stop painting (the page keeps running, nothing reloads).
		this.io = new IntersectionObserver((es) => {
			this.onScreen = es[es.length - 1].isIntersecting;
			this.applyVisibility();
		});
		this.io.observe(this.el);
		this.ro = new ResizeObserver((es) => (this.cssWidth = es[es.length - 1].contentRect.width));
		this.ro.observe(this.el);
		this.offZoom = core.zoom?.onZoom((scale) => {
			const tiny = this.cssWidth * scale < 120;
			if (tiny !== this.tiny) {
				this.tiny = tiny;
				this.applyVisibility();
			}
		}) ?? (() => {});
	}

	private applyVisibility() {
		this.el.toggleClass("is-dormant", !this.onScreen || this.tiny);
	}

	/** Remember where you are (debounced; only when something actually changed). */
	private persist(url?: string, title?: string) {
		if (url && url !== "about:blank") this.spec.url = url;
		if (title) this.spec.title = title;
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			this.core.app.vault.modify(this.file, JSON.stringify(this.spec, null, 2) + "\n").catch(() => {});
		}, 1500);
	}

	focus() {
		this.wv?.focus();
	}

	dispose() {
		this.io.disconnect();
		this.ro.disconnect();
		this.offZoom();
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.core.app.vault.modify(this.file, JSON.stringify(this.spec, null, 2) + "\n").catch(() => {});
		}
		this.el.remove();
	}
}

/** Canvas card / note embed for `.web` files. */
export class WebEmbed extends Component {
	private surface: WebSurface | null = null;

	constructor(private core: VivariumCore, private ctx: { containerEl: HTMLElement }, private file: TFile) {
		super();
		ctx.containerEl.addClass("vivarium-embed");
	}

	async loadFile() {
		if (this.surface) return;
		const spec = await readWebSpec(this.core, this.file);
		if (!spec) {
			this.ctx.containerEl.createDiv({ cls: "vivarium-term-error", text: `${this.file.name} is not a valid web tile.` });
			return;
		}
		this.surface = new WebSurface(this.core, this.ctx.containerEl, spec, this.file);
		// Keep the card attached when off-screen: a detached <webview> would reload its page.
		const keep = () => {
			for (const leaf of this.core.app.workspace.getLeavesOfType("canvas")) {
				for (const n of (leaf.view as any).canvas?.nodes?.values() ?? []) {
					if (n.contentEl === this.ctx.containerEl) {
						n.alwaysKeepLoaded = true;
						return true;
					}
				}
			}
			return false;
		};
		if (!keep()) {
			const t = window.setInterval(() => keep() && window.clearInterval(t), 200);
			this.register(() => window.clearInterval(t));
		}
		const nodeEl = () => this.ctx.containerEl.closest(".canvas-node");
		// Selecting the card focuses the page, so one click → you can type/scroll in it.
		const obs = new MutationObserver(() => nodeEl()?.hasClass("is-focused") && this.surface?.focus());
		window.setTimeout(() => {
			const el = nodeEl();
			if (el) obs.observe(el, { attributes: true, attributeFilter: ["class"] });
		}, 0);
		this.register(() => obs.disconnect());
	}

	onunload() {
		this.surface?.dispose();
		this.surface = null;
	}
}

/** Opening a `.web` file in a tab shows the page full-size. */
export class WebView extends FileView {
	private surface: WebSurface | null = null;

	constructor(leaf: WorkspaceLeaf, private core: VivariumCore) {
		super(leaf);
	}

	getViewType() {
		return WEB_VIEW_TYPE;
	}

	getIcon() {
		return "globe";
	}

	canAcceptExtension(ext: string) {
		return ext === WEB_EXT;
	}

	async onLoadFile(file: TFile) {
		this.contentEl.empty();
		this.contentEl.addClass("vivarium-view");
		const spec = await readWebSpec(this.core, file);
		if (spec) this.surface = new WebSurface(this.core, this.contentEl, spec, file);
	}

	async onUnloadFile() {
		this.surface?.dispose();
		this.surface = null;
	}
}
