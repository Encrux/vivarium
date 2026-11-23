/**
 * TerminalSurface: one xterm.js view onto one tmux pane.
 *
 * Performance model (the reason this file is shaped the way it is):
 *  - Visible  → output is written straight into xterm.
 *  - Hidden   → (off-screen, canvas zoomed out past its breakpoint, background tab)
 *               raw bytes are buffered in memory, nothing is parsed or rendered.
 *  - Stale    → the hidden buffer exceeded its cap: we drop it and tell tmux to stop
 *               sending output for this pane altogether. A hidden noisy build costs ~0.
 *  - On show  → flush the small buffer, or (if stale) repaint from a tmux snapshot.
 * The xterm instance itself survives hide/show, so panning back is instant.
 */
import { Scope } from "obsidian";
import { Terminal, ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { VivariumCore } from "./core";
import type { PaneInfo } from "./tmux";
import type { Launch } from "./core";
import type { ElectronModule, XtermInternal } from "./internal";

const HIDDEN_BUFFER_CAP = 256 * 1024;
const HIDE_GRACE_MS = 150;

type Mode = "live" | "hidden" | "stale";

export interface SurfaceOptions {
	/** How to (re)start the program fresh (Restart program). */
	launch: Launch;
	/** How to start it if its tmux window doesn't exist yet: fresh, or restored after a reboot. */
	startLaunch?: Launch;
	startCwd?: string;
	/** How "Restart" starts it (e.g. a coding agent with its own conversation); default: launch/cwd. */
	relaunch?: () => { launch: Launch; cwd: string };
	cwd: string;
	tileId: string;
	/** Ask before starting a tile this device hasn't run (e.g. it arrived by git pull). */
	consent?: { needed: () => boolean; grant: () => void; command: string; cwd: string };
}

export class TerminalSurface {
	readonly el: HTMLElement;
	private term: Terminal;
	private fit = new FitAddon();
	private pane: PaneInfo | null = null;
	private unsubscribe: (() => void) | null = null;
	private mode: Mode = "hidden";
	private buffer: { data: Uint8Array; seq: number }[] = [];
	private bufferBytes = 0;
	private needsRepaint = true;
	private visible = false;
	private hideTimer: number | null = null;
	private io: IntersectionObserver;
	private ro: ResizeObserver;
	private resizeRaf: number | null = null;
	private lastSize = "";
	private disposed = false;
	private overlayEl: HTMLElement | null = null;
	private repainting: Promise<void> | null = null;
	private unregister: () => void;
	private offZoom: () => void = () => {};
	/** On screen per IntersectionObserver; `visible` additionally requires readable size. */
	private onScreen = false;
	private tiny = false;

	constructor(private core: VivariumCore, parent: HTMLElement, private opts: SurfaceOptions) {
		this.el = parent.createDiv({ cls: "vivarium-term" });
		const s = core.settings;
		this.term = new Terminal({
			fontFamily: core.fontFamily(),
			fontSize: s.fontSize,
			lineHeight: 1.1,
			scrollback: s.scrollback,
			cursorBlink: true,
			allowProposedApi: false,
			macOptionIsMeta: s.optionIsMeta,
			theme: core.theme(),
			// Links a program marks up itself (OSC 8, e.g. Codex, ls --hyperlink): click opens them.
			linkHandler: { activate: (_e, uri) => openLink(uri), allowNonHttpProtocols: false },
			// DOM renderer (default): crisp at every canvas zoom level (CSS transform scales vectors),
			// and no WebGL context limit (~16 per page) to run into with many tiles.
		});
		this.term.loadAddon(this.fit);
		// A program clearing the scrollback (ESC[3J) is about to redraw it: Codex does this on every
		// resize, reprinting the whole conversation for the new width. If you had scrolled up, xterm
		// would keep the view pinned to the (new) top while the reprint pours in below. Follow the
		// bottom instead, where the reprint ends up.
		this.term.parser.registerCsiHandler({ final: "J" }, (params) => {
			if (params[0] === 3) this.term.scrollToBottom();
			return false; // xterm still does the clearing itself
		});
		// Plain URLs in the output (also when wrapped over several lines): click opens them.
		this.term.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri)));
		this.term.open(this.el);
		this.patchMouseForCssScale();
		this.isolateEvents();

		this.term.onData((d) => {
			if (this.pane) this.core.hub.sendInput(this.pane.paneId, d).catch(() => {});
		});
		this.term.onBinary((d) => {
			if (this.pane) this.core.hub.sendInput(this.pane.paneId, d).catch(() => {});
		});

		this.io = new IntersectionObserver((entries) => {
			const e = entries[entries.length - 1];
			this.onScreen = e.isIntersecting && this.el.isConnected;
			this.setVisible(this.onScreen && !this.tiny);
		});
		// Zoomed far out the text is unreadable: freeze on the last picture, buffer output.
		// (no layout reads here: this runs on every zoom frame)
		this.offZoom = core.zoom?.onZoom((scale) => {
			const tiny = scale * this.core.settings.fontSize < 4;
			if (tiny === this.tiny) return;
			this.tiny = tiny;
			this.setVisible(this.onScreen && !this.tiny);
		}) ?? (() => {});
		this.io.observe(this.el);
		this.ro = new ResizeObserver(() => this.scheduleFit());
		this.ro.observe(this.el);
		this.el.addEventListener("focusin", () => this.claimSize());

		this.unregister = core.registerSurface(this);
	}

	get tileId() {
		return this.opts.tileId;
	}

	async start(): Promise<void> {
		// Wait until we're laid out so a new program starts at the tile's real size (no initial
		// reflow, no zsh "%" partial-line marker). Existing tmux windows don't care.
		const consent = this.opts.consent;
		if (consent?.needed()) {
			// Already running here (e.g. started from the CLI)? Then just show it.
			const running = await this.core.hub.ensureConnected().then(() => this.core.hub.refreshPanes()).then(() => !!this.core.hub.getPane(this.opts.tileId), () => false);
			if (!running) return this.showConsent(consent);
		}
		if (!this.core.hub.getPane(this.opts.tileId)) await this.waitForLayout();
		if (this.disposed) return;
		if (this.el.clientWidth > 10) this.fit.fit();
		const { cols, rows } = this.proposeSize();
		try {
			this.pane = await this.core.hub.ensureWindow(this.opts.tileId, this.opts.startLaunch ?? this.opts.launch, this.opts.startCwd ?? this.opts.cwd, cols, rows);
		} catch (e) {
			this.showOverlay(`Could not start tmux: ${(e as Error).message}`, true, "Retry");
			return;
		}
		this.needsRepaint = true;
		this.updateDeadState();
		if (this.visible) this.goLive();
	}

	/** Called by core when tmux reports pane changes (death, respawn, close). */
	onPanesChanged() {
		const p = this.core.hub.getPane(this.opts.tileId);
		if (!p && this.pane) {
			// Window was killed (e.g. from the CLI or `exit` with remain-on-exit off).
			this.detachStream();
			this.pane = null;
			this.showOverlay("Program closed", true);
			return;
		}
		if (p && !this.pane && !this.disposed) {
			// the program came back (e.g. restored after a restart): attach to it
			this.pane = p;
			this.hideOverlay();
			this.needsRepaint = true;
			this.lastSize = ""; // a new window: tell it this tile's size
			if (this.visible) this.goLive();
			this.updateDeadState();
			return;
		}
		if (p && this.pane && p.paneId !== this.pane.paneId) {
			this.detachStream();
			this.pane = p;
			this.needsRepaint = true;
			this.lastSize = "";
			if (this.visible) this.goLive();
		}
		this.updateDeadState();
	}

	private updateDeadState() {
		const p = this.pane && this.core.hub.getPane(this.opts.tileId);
		if (p?.dead) this.showOverlay("Program exited", true);
		else if (p) this.hideOverlay();
	}

	// ---------- visibility & streaming ----------

	private setVisible(v: boolean) {
		if (v === this.visible) return;
		this.visible = v;
		if (!v) this.takeKeys(false); // off screen: the keyboard goes back to the canvas
		if (this.hideTimer !== null) {
			window.clearTimeout(this.hideTimer);
			this.hideTimer = null;
		}
		if (v) {
			this.goLive();
		} else {
			// Small grace period so a quick pan across doesn't churn subscriptions.
			this.hideTimer = window.setTimeout(() => {
				this.hideTimer = null;
				if (!this.visible && this.mode === "live") this.mode = "hidden";
			}, HIDE_GRACE_MS);
		}
	}

	private goLive() {
		if (!this.pane || this.disposed) return;
		this.scheduleFit();
		if (!this.unsubscribe) {
			this.mode = "hidden"; // buffer while we (maybe) repaint
			this.unsubscribe = this.core.hub.subscribe(this.pane.paneId, (d, seq) => this.onOutput(d, seq));
		}
		if (this.mode === "stale") this.needsRepaint = true;
		if (this.needsRepaint) {
			this.repaint();
			return;
		}
		this.flushBuffer();
		this.mode = "live";
	}

	private onOutput(data: Uint8Array, seq: number) {
		if (this.mode === "live") {
			this.term.write(data);
			return;
		}
		if (this.mode === "stale") return;
		this.buffer.push({ data, seq });
		this.bufferBytes += data.length;
		if (this.bufferBytes > HIDDEN_BUFFER_CAP && !this.repainting) {
			// Too much happened while hidden: stop the stream entirely and repaint on show.
			this.buffer = [];
			this.bufferBytes = 0;
			this.mode = "stale";
			this.needsRepaint = true;
			this.detachStream();
		}
	}

	private flushBuffer() {
		if (!this.buffer.length) return;
		const chunks = this.buffer;
		this.buffer = [];
		this.bufferBytes = 0;
		for (const c of chunks) this.term.write(c.data);
	}

	private detachStream() {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	/** Repaint xterm from a tmux snapshot (screen + history + terminal modes). */
	private repaint() {
		if (this.repainting || !this.pane) return;
		const pane = this.pane;
		this.repainting = (async () => {
			try {
				this.mode = "hidden"; // buffer until the snapshot is painted
				// Subscribe before snapshotting so nothing falls in a gap; output already contained
				// in the snapshot (seq <= snap.seq) is dropped afterwards.
				if (!this.unsubscribe) this.unsubscribe = this.core.hub.subscribe(pane.paneId, (d, seq) => this.onOutput(d, seq));
				// Make the pane match this tile's size *before* snapshotting, otherwise a 30-row
				// snapshot written into a 24-row xterm scrolls the screen out of view.
				await this.syncSizeNow();
				if (this.disposed || this.pane !== pane) return;
				const snap = await this.core.hub.capture(pane.paneId, this.core.settings.restoreLines);
				if (this.disposed || this.pane !== pane) return;
				const st = snap.state;
				this.buffer = this.buffer.filter((c) => c.seq > snap.seq);
				this.bufferBytes = this.buffer.reduce((n, c) => n + c.data.length, 0);
				let out = "\x1bc"; // full reset
				if (st.alternate) {
					// Normal screen first (it reappears when the app exits), with its saved cursor.
					if (snap.normalText) out += snap.normalText + `\x1b[${st.savedY + 1};${st.savedX + 1}H`;
					out += "\x1b[?1049h\x1b[H";
				}
				out += snap.text;
				out += `\x1b[${st.cursorY + 1};${st.cursorX + 1}H`;
				if (st.cursorKeys) out += "\x1b[?1h";
				if (st.keypad) out += "\x1b=";
				if (st.mouseStandard) out += "\x1b[?1000h";
				if (st.mouseButton) out += "\x1b[?1002h";
				if (st.mouseAny) out += "\x1b[?1003h";
				if (st.mouseSgr) out += "\x1b[?1006h";
				if (!st.cursorVisible) out += "\x1b[?25l";
				this.term.write(out);
				this.needsRepaint = false;
				if (this.visible) {
					this.flushBuffer();
					this.mode = "live";
				} else {
					this.mode = "hidden";
				}
			} catch (e) {
				console.warn("[vivarium] repaint failed", e);
			} finally {
				this.repainting = null;
			}
		})();
	}

	// ---------- sizing ----------

	private waitForLayout(): Promise<void> {
		return new Promise((resolve) => {
			const t0 = performance.now();
			const check = () => {
				if (this.disposed || (this.el.isConnected && this.el.clientWidth > 10 && this.el.clientHeight > 10) || performance.now() - t0 > 2000) resolve();
				else window.requestAnimationFrame(check);
			};
			check();
		});
	}

	private proposeSize(): { cols: number; rows: number } {
		const dims = this.fit.proposeDimensions();
		const cols = dims && isFinite(dims.cols) ? dims.cols : 100;
		const rows = dims && isFinite(dims.rows) ? dims.rows : 30;
		return { cols: Math.max(20, cols), rows: Math.max(5, rows) };
	}

	private scheduleFit() {
		if (this.resizeRaf !== null) return;
		this.resizeRaf = window.requestAnimationFrame(() => {
			this.resizeRaf = null;
			if (!this.visible || this.disposed || !this.el.isConnected) return;
			if (this.el.clientWidth < 10 || this.el.clientHeight < 10) return;
			this.fit.fit();
			this.sendSizeIfOwner();
		});
	}

	/** Fit now and wait until tmux has the new size (used before snapshots). */
	private async syncSizeNow() {
		if (!this.pane || !this.el.isConnected || this.el.clientWidth < 10 || this.el.clientHeight < 10) return;
		this.fit.fit();
		const owner = this.core.sizeOwners.get(this.pane.paneId);
		if (owner && owner !== this && owner.isVisible()) return;
		this.core.sizeOwners.set(this.pane.paneId, this);
		const key = `${this.term.cols}x${this.term.rows}`;
		if (key === this.lastSize) return;
		this.lastSize = key;
		await this.core.hub.resize(this.pane, this.term.cols, this.term.rows).catch(() => {});
	}

	private claimSize() {
		if (!this.pane) return;
		this.core.sizeOwners.set(this.pane.paneId, this);
		this.lastSize = "";
		this.sendSizeIfOwner();
	}

	private sendSizeIfOwner() {
		if (!this.pane) return;
		const owner = this.core.sizeOwners.get(this.pane.paneId);
		if (owner && owner !== this && owner.isVisible()) return;
		this.core.sizeOwners.set(this.pane.paneId, this);
		const key = `${this.term.cols}x${this.term.rows}`;
		if (key === this.lastSize) return;
		this.lastSize = key;
		this.core.hub.resize(this.pane, this.term.cols, this.term.rows).catch(() => {});
	}

	isVisible() {
		return this.visible;
	}

	// ---------- canvas integration details ----------

	/**
	 * Canvas scales nodes with a CSS transform. xterm maps mouse position → cell using
	 * unscaled cell sizes, so selection/clicks drift when zoomed. Un-scale the coordinates.
	 */
	private patchMouseForCssScale() {
		const ms = (this.term as unknown as XtermInternal)._core?._mouseService;
		if (!ms || typeof ms.getCoords !== "function") return;
		const unscale = (ev: { clientX: number; clientY: number }, element: HTMLElement) => {
			const rect = element.getBoundingClientRect();
			const sx = element.offsetWidth ? rect.width / element.offsetWidth : 1;
			const sy = element.offsetHeight ? rect.height / element.offsetHeight : 1;
			if (Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001) return ev;
			return { clientX: rect.left + (ev.clientX - rect.left) / sx, clientY: rect.top + (ev.clientY - rect.top) / sy };
		};
		const getCoords = ms.getCoords.bind(ms);
		ms.getCoords = (ev: { clientX: number; clientY: number }, el: HTMLElement, ...rest: unknown[]) => getCoords(unscale(ev, el), el, ...rest);
		const report = ms.getMouseReportCoords?.bind(ms);
		if (report) ms.getMouseReportCoords = (ev: { clientX: number; clientY: number }, el: HTMLElement) => report(unscale(ev, el), el);
	}

	/**
	 * Which keys Obsidian may have while you type in a terminal: only its own chords, so its hotkeys
	 * keep working. macOS: Cmd+… (not copy/paste/cut/select-all). Elsewhere Ctrl+… belongs to the
	 * shell (Ctrl+C, Ctrl+W, Ctrl+R, …), so Obsidian gets Ctrl+Shift+… (not copy/paste), the way
	 * Linux terminals split it.
	 */
	private static forObsidian(e: KeyboardEvent): boolean {
		const k = e.key.toLowerCase();
		if (process.platform === "darwin") return e.metaKey && !["c", "v", "x", "a"].includes(k);
		return e.ctrlKey && e.shiftKey && !["c", "v"].includes(k);
	}

	/**
	 * Obsidian handles hotkeys before the key reaches us (a capturing listener on the window), and
	 * Canvas's handlers (arrows nudge the card, Shift+1 zooms, …) only skip <input>s and
	 * contenteditable, not xterm's <textarea>. So while the terminal has focus, a keymap scope of
	 * ours sits on top: it leaves every key to the terminal except Obsidian's own chords, which go
	 * to the app's global hotkeys, skipping Canvas.
	 */
	private keyScope: Scope | null = null;
	private takeKeys(on: boolean) {
		const keymap = this.core.app.keymap;
		if (on && !this.keyScope) {
			const scope = new Scope(this.core.app.scope);
			// true = "handled, but let the key through" (false would preventDefault it); undefined
			// falls through to the parent (global hotkeys).
			scope.register(null, null, (e) => {
				// Canvas can drop a focused terminal from the page (zoomed out, scrolled away) without
				// a focusout: if focus isn't ours any more, step aside instead of holding the keys.
				if (!this.el.isConnected || !this.el.contains(activeDocument.activeElement)) {
					this.takeKeys(false);
					return undefined;
				}
				return TerminalSurface.forObsidian(e) ? undefined : true;
			});
			keymap.pushScope(scope);
			this.keyScope = scope;
		} else if (!on && this.keyScope) {
			keymap.popScope(this.keyScope);
			this.keyScope = null;
		}
	}

	/** Keep keystrokes/clipboard from reaching canvas shortcuts (Space=pan, Backspace=delete, paste=new card). */
	private isolateEvents() {
		const stop = (e: Event) => e.stopPropagation();
		if (process.platform !== "darwin") {
			// Linux terminals copy with Ctrl+Shift+C (Ctrl+C is the shell's interrupt). Ctrl+Shift+V
			// already pastes: Chromium turns it into a paste event, which xterm handles.
			this.term.attachCustomKeyEventHandler((e) => {
				if (e.type === "keydown" && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
					if (this.term.hasSelection()) navigator.clipboard.writeText(this.term.getSelection()).catch(() => {});
					e.preventDefault();
					return false;
				}
				return true;
			});
		}
		this.el.addEventListener("focusin", () => this.takeKeys(true));
		this.el.addEventListener("focusout", (e) => {
			if (!this.el.contains(e.relatedTarget as Node | null)) this.takeKeys(false);
		});
		const keyStop = (e: KeyboardEvent) => {
			if (TerminalSurface.forObsidian(e)) return;
			e.stopPropagation();
		};
		this.el.addEventListener("keydown", keyStop);
		this.el.addEventListener("keyup", keyStop);
		this.el.addEventListener("keypress", stop);
		for (const t of ["copy", "paste", "cut"]) this.el.addEventListener(t, stop);
		// Pointer events only reach us when the card is focused (otherwise Canvas's content
		// blocker sits on top). Keep them: a text selection must not drag the card. The card
		// can still be moved by its label or border.
		this.el.addEventListener("pointerdown", stop);
		// Only when focused do we own the wheel; otherwise the content blocker lets the canvas pan.
		this.el.addEventListener("wheel", (e) => {
			if (this.el.contains(activeDocument.activeElement)) e.stopPropagation();
		}, { passive: true });
	}

	focus() {
		this.term.focus();
	}

	blur() {
		this.term.blur();
	}

	applyAppearance() {
		this.term.options.theme = this.core.theme();
		this.term.options.fontFamily = this.core.fontFamily();
		this.term.options.fontSize = this.core.settings.fontSize;
		this.term.options.macOptionIsMeta = this.core.settings.optionIsMeta;
		this.lastSize = "";
		this.scheduleFit();
	}

	private showOverlay(msg: string, restart: boolean, label = "Restart") {
		this.hideOverlay();
		const o = (this.overlayEl = this.el.createDiv({ cls: "vivarium-term-overlay" }));
		o.createSpan({ text: msg });
		if (restart) {
			const b = o.createEl("button", { text: label, cls: "mod-cta" });
			b.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.restart();
			});
		}
	}

	/** "Start this?" for a tile this device never ran: shows exactly what would run, and where. */
	private showConsent(c: NonNullable<SurfaceOptions["consent"]>) {
		this.hideOverlay();
		const o = (this.overlayEl = this.el.createDiv({ cls: "vivarium-term-overlay vivarium-consent" }));
		o.createDiv({ text: "Not started on this device yet. It would run:" });
		o.createEl("code", { text: c.command });
		o.createDiv({ cls: "vivarium-consent-cwd", text: `in ${c.cwd}` });
		const b = o.createEl("button", { text: "Start", cls: "mod-cta" });
		b.addEventListener("click", (e) => {
			e.stopPropagation();
			c.grant();
			this.hideOverlay();
			void this.start();
		});
	}

	private hideOverlay() {
		this.overlayEl?.remove();
		this.overlayEl = null;
	}

	async restart() {
		this.hideOverlay();
		const { launch, cwd } = this.opts.relaunch?.() ?? { launch: this.opts.launch, cwd: this.opts.cwd };
		// A new window for the program (see TmuxHub.respawn), started at this tile's size.
		this.detachStream();
		this.pane = null;
		this.term.reset();
		this.lastSize = "";
		await this.core.hub.killWindow(this.opts.tileId);
		this.opts.startLaunch = launch;
		this.opts.startCwd = cwd;
		// A tile this device hasn't agreed to run yet shows its Start button (with the command) instead.
		await this.start();
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
		if (this.resizeRaf !== null) window.cancelAnimationFrame(this.resizeRaf);
		this.io.disconnect();
		this.ro.disconnect();
		this.offZoom();
		this.detachStream();
		if (this.pane && this.core.sizeOwners.get(this.pane.paneId) === this) this.core.sizeOwners.delete(this.pane.paneId);
		this.unregister();
		this.takeKeys(false);
		this.term.dispose();
		this.el.remove();
	}
}

/** Open a link from a terminal in your default browser (not inside Obsidian). */
function openLink(uri: string) {
	if (!/^(https?|mailto):/i.test(uri)) return;
	try {
		// Obsidian's renderer has Node/Electron: shell.openExternal hands the URL to the system
		// (xdg-open on Linux, Launch Services on macOS) → your default browser.
		// (no window.require → throws → the fallback below)
		const { shell } = (window as unknown as { require: (m: "electron") => ElectronModule }).require("electron");
		shell.openExternal(uri).catch(() => window.open(uri));
	} catch {
		window.open(uri);
	}
}

export function themeFromCss(el: HTMLElement): ITheme {
	const cs = getComputedStyle(el);
	const v = (n: string, fb: string) => cs.getPropertyValue(n).trim() || fb;
	return {
		background: v("--background-primary", "#1e1e1e"),
		foreground: v("--text-normal", "#dcddde"),
		cursor: v("--text-accent", "#7f6df2"),
		cursorAccent: v("--background-primary", "#1e1e1e"),
		selectionBackground: v("--text-selection", "rgba(127,109,242,0.35)"),
	};
}
