/**
 * App tiles: any native window, shown live on the canvas and used for real when you click it.
 *
 *   on the canvas  → a live preview: the real window sits on the helper's invisible "stage"
 *                    display and is streamed (ScreenCaptureKit → H.264 → WebCodecs).
 *   click the tile → the real window takes the tile's exact place on screen (the canvas zooms
 *                    to 100% first, so nothing relayouts) and your click is replayed onto it:
 *                    from then on it's the real app — native scrolling, typing, menus, resizing.
 *   leave it       → click the canvas, switch apps, or pan: it goes back to the stage. Moves and
 *                    resizes you did on the real window are adopted by the tile.
 *
 * Why not input into the stream: on macOS, typing into another app requires that app to be
 * active (so focus switches anyway), and a streamed picture is 50–80 ms behind your hand.
 * Anything Obsidian can render itself (terminals, web pages) is a direct tile instead.
 *
 * Cost model mirrors terminals: hidden → stream stopped (last frame kept); visible → low fps;
 * selected → full fps. Capture resolution follows the tile's on-screen size.
 */
import { Component, FileView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type { VivariumCore } from "./core";
import type { StreamConfig, StreamSink, VideoPacket, WindowInfo } from "./helper";

export const WINDOW_EXT = "window";
export const WINDOW_VIEW_TYPE = "vivarium-window";

export interface WindowSpec {
	version: 1;
	id: string;
	kind: "app";
	title: string;
	app: { name: string; bundleId: string; path?: string };
	/** Last window this tile showed; re-used if it still exists. */
	windowId?: number;
	/** Prefer a window whose title contains this (when re-attaching after a restart). */
	titleHint?: string;
}

/** What the canvas embed gives the surface: zooming the canvas and moving/resizing the card. */
export interface TileHost {
	/** Make the tile 100% scale on screen (returns a function that restores the previous view). */
	normalizeZoom(): (() => void) | null;
	/** Apply a move/resize (in screen points) the user did on the real window. */
	adopt(dx: number, dy: number, dw: number, dh: number): void;
}

const FPS_ACTIVE = 60;
const FPS_IDLE = 8;
const FPS_UNDER_REAL_WINDOW = 15; // keeps the preview current for a seamless hand-back
const HIDE_GRACE_MS = 300;
const RESIZE_SETTLE_MS = 300;

export class WindowSurface implements StreamSink {
	readonly el: HTMLElement;
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private statusEl: HTMLElement;
	private bannerEl: HTMLElement;
	private permTimer: number | null = null;
	private decoder: VideoDecoder | null = null;
	private needKey = true;
	private win: WindowInfo | null = null;
	private stream: number | null = null;
	private streaming = false;
	private visible = false;
	private selected = false;
	private winW = 0; // window size in points
	private winH = 0;
	private io: IntersectionObserver;
	private ro: ResizeObserver;
	private hideTimer: number | null = null;
	private resizeTimer: number | null = null;
	private lodTimer: number | null = null;
	private lastMax = 0;
	private lastFps = 0;
	private disposed = false;
	private offEvents: () => void;
	private offZoom: () => void = () => {};
	private onScreen = false;
	private tiny = false;
	private cssWidth = 0;
	host: TileHost | null = null;
	// engaged = the real window is over the tile
	private engaged = false;
	private engageRaf: number | null = null;
	private engagedAt: { x: number; y: number; width: number; height: number } | null = null;
	private restoreView: (() => void) | null = null;

	constructor(private core: VivariumCore, parent: HTMLElement, private spec: WindowSpec, private file: TFile) {
		this.el = parent.createDiv({ cls: "vivarium-window" });
		this.canvas = this.el.createEl("canvas", { cls: "vivarium-window-canvas" });
		this.ctx = this.canvas.getContext("2d", { alpha: false, desynchronized: true })!;
		this.statusEl = this.el.createDiv({ cls: "vivarium-window-status", text: "Connecting…" });
		this.bannerEl = this.el.createDiv({ cls: "vivarium-window-banner" });
		this.bannerEl.hide();
		this.buildToolbar();
		this.bindPointer();

		this.io = new IntersectionObserver((es) => {
			this.onScreen = es[es.length - 1].isIntersecting && this.el.isConnected;
			this.setVisible(this.onScreen && !this.tiny);
		});
		// Tiny on screen (zoomed far out): keep the last frame, stop streaming.
		// (no layout reads here: this runs on every zoom frame — use the cached CSS width)
		this.offZoom = core.zoom?.onZoom((scale) => {
			const tiny = this.cssWidth * scale < 160;
			if (tiny === this.tiny) return;
			this.tiny = tiny;
			this.setVisible(this.onScreen && !this.tiny);
		}) ?? (() => {});
		this.io.observe(this.el);
		this.ro = new ResizeObserver((es) => {
			this.cssWidth = es[es.length - 1].contentRect.width;
			this.onTileResize();
		});
		this.ro.observe(this.el);
		this.offEvents = core.helper!.onEvent((ev, m) => {
			if (!this.win || m.windowId !== this.win.windowId) return;
			if (ev === "disengaged") this.onDisengaged(m);
			if (ev === "handoff_ended") {
				this.el.removeClass("is-handed-off");
				if (!m.alive) this.onWindowGone();
				else if (this.visible) this.startStream();
			}
		});
	}

	// ---------- window resolution ----------

	async start() {
		try {
			const info = await this.core.helper!.refreshInfo();
			if (!info.permissions.screen) {
				this.setStatus("Vivarium needs Screen Recording permission for Obsidian.", "Grant", () =>
					this.core.helper!.request("request_permissions", { screen: true }).then(() => this.start()));
				return;
			}
			this.win = await this.resolveWindow();
			if (!this.win) return;
			this.core.claimWindow(this.win.windowId, this);
			// remember the window per device (local storage), never in the tile file
			const st = this.core.tileState<{ windowId: number; titleHint: string }>(this.spec.id);
			if (st.windowId !== this.win.windowId) {
				this.core.setTileState(this.spec.id, { windowId: this.win.windowId, titleHint: this.win.title || st.titleHint || this.spec.titleHint });
			}
			this.winW = this.win.width;
			this.winH = this.win.height;
			this.setStatus(null);
			this.core.attachedWindows.set(this.file.path, { windowId: this.win.windowId, pid: this.win.pid });
			if (!info.permissions.accessibility) this.enterViewOnly();
			else await this.park();
			if (this.visible) this.startStream();
		} catch (e) {
			this.setStatus(`Could not attach: ${(e as Error).message}`, "Retry", () => this.start());
		}
	}

	/** Live on the invisible stage display: keeps rendering, never covers your screen. */
	private async park() {
		if (!this.win) return;
		await this.core.helper!.request("park", { windowId: this.win.windowId, pid: this.win.pid }).catch((e) => console.warn("[vivarium] park failed", e));
	}

	/**
	 * Without Accessibility we can't move the window, but we can still show it live. Keep
	 * checking: the tile upgrades itself as soon as the permission takes effect.
	 */
	private enterViewOnly() {
		this.el.addClass("is-view-only");
		this.bannerEl.empty();
		this.bannerEl.show();
		this.bannerEl.createSpan({ text: "View only — allow Obsidian under Privacy & Security → Accessibility to work in this tile." });
		const b = this.bannerEl.createEl("button", { text: "Open settings" });
		b.addEventListener("pointerdown", (e) => e.stopPropagation());
		b.addEventListener("click", (e) => {
			e.stopPropagation();
			this.core.helper!.request("request_permissions", { accessibility: true }).catch(() => {});
		});
		if (this.permTimer !== null) return;
		this.permTimer = window.setInterval(async () => {
			const info = await this.core.helper!.refreshInfo().catch(() => null);
			if (!info?.permissions.accessibility || this.disposed) return;
			window.clearInterval(this.permTimer!);
			this.permTimer = null;
			this.el.removeClass("is-view-only");
			this.bannerEl.hide();
			await this.park();
		}, 2000);
	}

	private async resolveWindow(): Promise<WindowInfo | null> {
		const h = this.core.helper!;
		const list = async () => ((await h.request("list_windows")).windows as WindowInfo[]).filter((w) => w.bundleId === this.spec.app.bundleId);
		let wins = await list();
		const free = (w: WindowInfo) => !this.core.windowClaimedByOther(w.windowId, this);
		// per-device memory first; windowId/titleHint in the file only exist in older tiles
		const st = this.core.tileState<{ windowId: number; titleHint: string }>(this.spec.id);
		const rememberedId = st.windowId ?? this.spec.windowId;
		const hint = st.titleHint ?? this.spec.titleHint;
		const remembered = wins.find((w) => w.windowId === rememberedId && free(w));
		if (remembered) return remembered;
		const hinted = hint ? wins.find((w) => free(w) && w.title === hint) : undefined;
		if (hinted) return hinted;
		const anyFree = wins.find(free);
		if (anyFree && !rememberedId) return anyFree;
		// Launch the app (or ask a running one for a new window) and wait for a fresh window.
		this.setStatus(`Opening ${this.spec.app.name}…`);
		const before = new Set(wins.map((w) => w.windowId));
		const { pid } = await h.request("launch", { bundleId: this.spec.app.bundleId, path: this.spec.app.path });
		for (let i = 0; i < 40 && !this.disposed; i++) {
			await sleep(i < 10 ? 150 : 300);
			wins = await list();
			const fresh = wins.find((w) => !before.has(w.windowId) && free(w));
			if (fresh) return fresh;
			if (i === 8 && !wins.some((w) => !before.has(w.windowId))) {
				const reuse = wins.find(free);
				if (reuse) return reuse;
				await h.request("new_window", { pid }).catch(() => {});
			}
		}
		this.setStatus(`${this.spec.app.name} didn't open a window.`, "Retry", () => this.start());
		return null;
	}

	private onWindowGone() {
		this.stopStream();
		if (this.win) this.core.releaseWindow(this.win.windowId, this);
		this.win = null;
		this.setStatus(`${this.spec.app.name} window closed.`, "Reopen", () => {
			this.spec.windowId = undefined;
			this.core.setTileState(this.spec.id, { windowId: undefined });
			this.start();
		});
	}

	// ---------- streaming ----------

	private setVisible(v: boolean) {
		if (v === this.visible) return;
		this.visible = v;
		if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
		this.hideTimer = null;
		if (v) this.startStream();
		else this.hideTimer = window.setTimeout(() => !this.visible && !this.engaged && this.stopStream(), HIDE_GRACE_MS);
	}

	/** Pixel budget: what the tile occupies on screen right now (canvas zoom × DPR). */
	private wantedMax(): number {
		const r = this.el.getBoundingClientRect();
		return Math.ceil(Math.max(r.width, r.height) * window.devicePixelRatio);
	}

	private wantedFps() {
		return this.engaged ? FPS_UNDER_REAL_WINDOW : this.selected ? FPS_ACTIVE : FPS_IDLE;
	}

	private async startStream() {
		if (!this.win || this.disposed || this.el.hasClass("is-handed-off")) return;
		if (this.streaming) {
			this.core.helper!.request("keyframe", { stream: this.stream }).catch(() => {});
			return;
		}
		this.streaming = true;
		this.stream ??= this.core.helper!.allocStream(this);
		this.needKey = true;
		const max = (this.lastMax = Math.max(256, this.wantedMax()));
		try {
			const r = await this.core.helper!.request("stream_start", {
				stream: this.stream, windowId: this.win.windowId, pid: this.win.pid,
				fps: (this.lastFps = this.wantedFps()), maxWidth: max, maxHeight: max,
			});
			this.winW = r.windowWidth;
			this.winH = r.windowHeight;
			if (!this.visible && !this.engaged) this.stopStream();
		} catch (e) {
			this.streaming = false;
			const msg = (e as Error).message;
			if (/not found/.test(msg)) this.onWindowGone();
			else this.recoverStream(msg);
		}
		this.watchZoom();
	}

	private stopStream() {
		if (!this.streaming) return;
		this.streaming = false;
		if (this.lodTimer !== null) window.clearInterval(this.lodTimer);
		this.lodTimer = null;
		this.core.helper!.request("stream_stop", { stream: this.stream }).catch(() => {});
		// keep the last frame on the canvas: re-showing is instant
	}

	/** Re-request resolution when the canvas zoom changes the tile's on-screen size a lot. */
	private watchZoom() {
		if (this.lodTimer !== null) return;
		this.lodTimer = window.setInterval(() => {
			if (!this.streaming || this.engaged) return;
			const m = Math.max(256, this.wantedMax());
			if (m > this.lastMax * 1.3 || m < this.lastMax / 1.6) {
				this.lastMax = m;
				this.core.helper!.request("stream_update", { stream: this.stream, maxWidth: m, maxHeight: m }).catch(() => {});
			}
		}, 400);
	}

	private updateFps() {
		this.el.toggleClass("is-focused", this.selected);
		const fps = this.wantedFps();
		if (!this.streaming || fps === this.lastFps) return;
		this.lastFps = fps;
		this.core.helper!.request("stream_update", { stream: this.stream, fps }).catch(() => {});
	}

	onConfig(c: StreamConfig) {
		this.winW = c.windowWidth;
		this.winH = c.windowHeight;
		// Don't resize the canvas here (that clears it → flicker); the first decoded frame of the
		// new size resizes and paints it in the same task.
		this.decoder?.close();
		this.decoder = new VideoDecoder({
			output: (frame) => {
				const w = frame.displayWidth, h = frame.displayHeight;
				if (this.canvas.width !== w || this.canvas.height !== h) {
					this.canvas.width = w;
					this.canvas.height = h;
				}
				this.ctx.drawImage(frame, 0, 0, w, h);
				frame.close();
			},
			error: (e) => {
				console.warn("[vivarium] decoder", e);
				this.needKey = true;
				this.core.helper!.request("keyframe", { stream: this.stream }).catch(() => {});
			},
		});
		this.decoder.configure({ codec: c.codec, description: c.description, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
		this.needKey = true;
	}

	onPacket(p: VideoPacket) {
		const d = this.decoder;
		if (!d || d.state !== "configured") return;
		if (this.needKey && !p.keyframe) return;
		this.needKey = false;
		// Drop frames rather than queue up latency if the decoder falls behind.
		if (d.decodeQueueSize > 3 && !p.keyframe) return;
		d.decode(new EncodedVideoChunk({ type: p.keyframe ? "key" : "delta", timestamp: p.timestampUs, data: p.data }));
	}

	onEvent(ev: string, m: any) {
		if (ev === "window_closed") this.onWindowGone();
		else if (ev === "window_changed") {
			this.winW = m.windowWidth;
			this.winH = m.windowHeight;
		} else if (ev === "stream_error") this.recoverStream(m.message);
		else if (ev === "helper_exit") {
			// The helper (and its stage display) is gone, so macOS moved the window back to your
			// screens. Re-attach fully: new helper, park on the new stage, stream again.
			this.streaming = false;
			this.engaged = false;
			this.decoder?.close();
			this.decoder = null;
			if (this.win) this.core.releaseWindow(this.win.windowId, this);
			window.setTimeout(() => !this.disposed && this.start(), 500);
		}
	}

	/**
	 * Streams get interrupted by normal things: a display plugged in/out, sleep/wake, the app
	 * reopening its window. Re-attach quietly; only surface the error if it keeps failing.
	 */
	private failures: number[] = [];
	private recoverStream(message: string) {
		this.streaming = false;
		const now = Date.now();
		this.failures = this.failures.filter((t) => now - t < 30_000);
		this.failures.push(now);
		if (this.failures.length > 4) {
			this.setStatus(`Stream keeps failing: ${message}`, "Retry", () => {
				this.failures = [];
				this.setStatus(null);
				this.startStream();
			});
			return;
		}
		window.setTimeout(async () => {
			if (this.disposed || (!this.visible && !this.engaged)) return;
			// the window may have been recreated (new id) — re-resolve if it's gone
			const alive = this.win && (await this.core.helper!.request("list_windows").catch(() => ({ windows: [] }))).windows.some((w: WindowInfo) => w.windowId === this.win!.windowId);
			if (!alive) return this.onWindowGone();
			this.startStream();
		}, 300 * this.failures.length);
	}

	// ---------- tile ↔ window size ----------

	/**
	 * Resizing the card: stretch the current picture while you drag, and resize the real window
	 * once when you let go — never a stream of intermediate sizes (that made the app relayout,
	 * the stream reconfigure and the picture flicker on every step).
	 */
	private onTileResize() {
		if (this.engaged || !this.win) return;
		if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
		else this.el.addClass("is-resizing");
		this.resizeTimer = window.setTimeout(() => {
			this.resizeTimer = null;
			if (!this.win || !this.core.helper!.info?.permissions.accessibility) return this.el.removeClass("is-resizing");
			// Tile CSS px == window points: at canvas zoom 100% the stream maps 1:1.
			const w = Math.round(this.el.clientWidth), h = Math.round(this.el.clientHeight);
			if (w < 100 || h < 80 || (Math.abs(w - this.winW) < 2 && Math.abs(h - this.winH) < 2)) return this.el.removeClass("is-resizing");
			this.core.helper!.request("set_frame", { windowId: this.win.windowId, pid: this.win.pid, width: w, height: h })
				.catch(() => {})
				// keep stretching until the new size's frames arrive
				.finally(() => window.setTimeout(() => this.el.removeClass("is-resizing"), 200));
		}, RESIZE_SETTLE_MS);
	}

	// ---------- clicking in: the real window takes the tile's place ----------

	private bindPointer() {
		const c = this.canvas;
		// Only reached when the card is already selected (otherwise Canvas's content blocker is on
		// top and the embed handles the click). Click → work in the real window.
		let down: { x: number; y: number } | null = null;
		c.addEventListener("pointerdown", (e) => {
			e.stopPropagation(); // never drag the card from inside the picture
			down = { x: e.clientX, y: e.clientY };
		});
		c.addEventListener("pointerup", (e) => {
			e.stopPropagation();
			if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
				this.engage({ x: e.clientX, y: e.clientY, button: e.button, clicks: Math.max(1, e.detail) });
			}
			down = null;
		});
		c.addEventListener("mousedown", (e) => e.preventDefault());
		c.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});
	}

	/** The tile's rectangle in global screen points (what the real window must cover). */
	private screenRect() {
		const r = this.el.getBoundingClientRect();
		const cb = (window as any).electron?.remote?.getCurrentWindow?.().getContentBounds?.() ?? { x: window.screenX, y: window.screenY };
		return { x: Math.round(cb.x + r.left), y: Math.round(cb.y + r.top), width: Math.round(r.width), height: Math.round(r.height) };
	}

	private contentOrigin() {
		return (window as any).electron?.remote?.getCurrentWindow?.().getContentBounds?.() ?? { x: window.screenX, y: window.screenY };
	}

	/** Resolves once the tile has stopped moving on screen (canvas pan/zoom animations settle). */
	private async stableRect(maxMs = 600) {
		let last = this.screenRect(), same = 0;
		const t0 = performance.now();
		while (same < 3 && performance.now() - t0 < maxMs) {
			await new Promise((r) => requestAnimationFrame(r));
			const r = this.screenRect();
			same = rectClose(r, last, 0.5) ? same + 1 : 0;
			last = r;
		}
		return last;
	}

	/**
	 * Put the real window exactly where the tile is and hand it your click.
	 * `click` is in client coordinates; null = just bring the window in.
	 */
	async engage(click: { x: number; y: number; button: number; clicks: number } | null) {
		if (!this.win || this.engaged || this.el.hasClass("is-view-only")) return;
		this.engaged = true;
		// 1. 100% zoom: the real window is already the tile's size, so it only has to move — no
		//    relayout, no jump. Remember the view to zoom back out when you're done.
		let clickCanvas: { x: number; y: number } | null = null;
		if (click) {
			// remember where in the tile you clicked (fraction), so we can find it after zooming
			const r = this.el.getBoundingClientRect();
			clickCanvas = { x: (click.x - r.left) / r.width, y: (click.y - r.top) / r.height };
		}
		const tileRect = await this.stableRect();
		// At (about) 100% the real window lines up exactly with the tile. At any other zoom we
		// don't resize the window (that relayouts the app) or zoom the canvas (disorienting):
		// it comes forward at its own size, centred on the tile.
		const scale = this.el.offsetWidth ? tileRect.width / this.el.offsetWidth : 1;
		const rect = Math.abs(scale - 1) < 0.03 || !this.winW
			? tileRect
			: { x: Math.round(tileRect.x + tileRect.width / 2 - this.winW / 2), y: Math.round(tileRect.y + tileRect.height / 2 - this.winH / 2), width: Math.round(this.winW), height: Math.round(this.winH) };
		if (this.disposed || !this.win) return;
		if (rect.width < 120 || rect.height < 80) {
			this.engaged = false;
			return;
		}
		this.engagedAt = tileRect; // watched: if the tile moves on screen, hand the window back
		this.el.addClass("is-engaged");
		this.updateFps();
		const params: Record<string, any> = { windowId: this.win.windowId, pid: this.win.pid, ...rect };
		if (click && clickCanvas) {
			params.clickX = rect.x + clickCanvas.x * rect.width;
			params.clickY = rect.y + clickCanvas.y * rect.height;
			params.button = click.button;
			params.clicks = click.clicks;
		}
		try {
			await this.core.helper!.request("engage", params);
		} catch (e) {
			this.core.notice(`couldn't open ${this.spec.app.name} here: ${(e as Error).message}`);
			this.onDisengaged({});
			return;
		}
		// If the canvas pans/zooms underneath, the real window would be misaligned: hand it back.
		let movedFrames = 0;
		const watch = () => {
			if (!this.engaged || !this.engagedAt) return;
			movedFrames = rectClose(this.screenRect(), this.engagedAt, 2) ? 0 : movedFrames + 1;
			if (movedFrames >= 3) {
				this.restoreView = null; // you moved the canvas yourself: don't jump the view back
				this.core.helper!.request("disengage", { reason: "moved" }).catch(() => {});
				return;
			}
			this.engageRaf = requestAnimationFrame(watch);
		};
		this.engageRaf = requestAnimationFrame(watch);
	}

	private onDisengaged(m: { x?: number; y?: number; width?: number; height?: number; reason?: string }) {
		if (!this.engaged) return;
		this.engaged = false;
		if (this.engageRaf !== null) cancelAnimationFrame(this.engageRaf);
		this.engageRaf = null;
		this.el.removeClass("is-engaged");
		// (cards are never resized/moved automatically — you decide their size)
		this.engagedAt = null;
		void m;
		this.updateFps();
		if (this.visible) this.startStream();
	}

	select(on: boolean) {
		this.selected = on;
		this.updateFps();
	}

	// ---------- toolbar / fullscreen ----------

	private buildToolbar() {
		const bar = this.el.createDiv({ cls: "vivarium-window-toolbar" });
		const btn = (icon: string, label: string, fn: () => void) => {
			const b = bar.createDiv({ cls: "clickable-icon", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.addEventListener("pointerdown", (e) => e.stopPropagation());
			b.addEventListener("pointerup", (e) => e.stopPropagation());
			b.addEventListener("click", (e) => {
				e.stopPropagation();
				fn();
			});
		};
		btn("maximize", "Full screen", () => this.fullscreen());
	}

	/** Hand the real window over in true fullscreen; the tile resumes when you leave it. */
	async fullscreen() {
		if (!this.win) return;
		if (!this.core.helper!.info?.permissions.accessibility) {
			this.core.notice("full screen needs the Accessibility permission for Obsidian");
			this.core.helper!.request("request_permissions", { accessibility: true }).catch(() => {});
			return;
		}
		if (this.engaged) await this.core.helper!.request("disengage", { reason: "fullscreen" }).catch(() => {});
		this.stopStream();
		this.el.addClass("is-handed-off");
		await this.core.helper!.request("fullscreen", { windowId: this.win.windowId, pid: this.win.pid, on: true }).catch((e) => {
			this.el.removeClass("is-handed-off");
			this.core.notice(`full screen failed: ${e.message}`);
			this.startStream();
		});
	}

	private setStatus(msg: string | null, action?: string, fn?: () => void) {
		this.statusEl.empty();
		this.statusEl.toggle(!!msg);
		if (!msg) return;
		this.statusEl.createSpan({ text: msg });
		if (action && fn) {
			const b = this.statusEl.createEl("button", { text: action, cls: "mod-cta" });
			b.addEventListener("pointerdown", (e) => e.stopPropagation());
			b.addEventListener("click", (e) => {
				e.stopPropagation();
				fn();
			});
		}
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		if (this.engaged) this.core.helper!.request("disengage", { reason: "closed" }).catch(() => {});
		this.stopStream();
		if (this.stream !== null) this.core.helper!.freeStream(this.stream);
		if (this.win) this.core.releaseWindow(this.win.windowId, this);
		this.offEvents();
		this.offZoom();
		this.io.disconnect();
		this.ro.disconnect();
		if (this.lodTimer !== null) window.clearInterval(this.lodTimer);
		if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
		if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
		if (this.permTimer !== null) window.clearInterval(this.permTimer);
		this.decoder?.close();
		this.el.remove();
	}
}

/** Canvas card / note embed for `.window` files. */
export class WindowEmbed extends Component {
	private surface: WindowSurface | null = null;
	private obs: MutationObserver | null = null;

	constructor(private core: VivariumCore, private ctx: { containerEl: HTMLElement }, private file: TFile) {
		super();
		ctx.containerEl.addClass("vivarium-embed");
	}

	/** The canvas + card this embed lives in (canvas internals: node.contentEl is our container). */
	private findNode(): { canvas: any; node: any } | null {
		for (const leaf of this.core.app.workspace.getLeavesOfType("canvas")) {
			const canvas = (leaf.view as any).canvas;
			if (!canvas?.nodes) continue;
			for (const node of canvas.nodes.values()) if (node.contentEl === this.ctx.containerEl) return { canvas, node };
		}
		return null;
	}

	async loadFile() {
		if (this.surface) return;
		const spec = await readWindowSpec(this.core, this.file);
		if (!spec) {
			this.ctx.containerEl.createDiv({ cls: "vivarium-term-error", text: `${this.file.name} is not a valid app tile.` });
			return;
		}
		if (!this.core.helper) {
			this.ctx.containerEl.createDiv({ cls: "vivarium-term-error", text: "App tiles need the Vivarium helper, which isn't built for this platform yet." });
			return;
		}
		const surface = (this.surface = new WindowSurface(this.core, this.ctx.containerEl, spec, this.file));
		surface.host = {
			normalizeZoom: () => {
				const f = this.findNode();
				if (!f) return null;
				const { canvas, node } = f;
				if (Math.abs(canvas.scale - 1) < 0.02) return null;
				const prev = { x: canvas.tx ?? canvas.x, y: canvas.ty ?? canvas.y, zoom: canvas.tZoom ?? canvas.zoom };
				canvas.setViewport(node.x + node.width / 2, node.y + node.height / 2, 0);
				return () => canvas.setViewport(prev.x, prev.y, prev.zoom);
			},
			adopt: (dx, dy, dw, dh) => {
				const f = this.findNode();
				if (!f) return;
				const { canvas, node } = f;
				const k = 1 / (canvas.scale || 1); // screen points → canvas units
				node.moveAndResize({ x: node.x + dx * k, y: node.y + dy * k, width: node.width + dw * k, height: node.height + dh * k });
				canvas.requestSave();
			},
		};
		surface.start();
		const hook = () => {
			const nodeEl = this.ctx.containerEl.closest(".canvas-node") as HTMLElement | null;
			if (!nodeEl) return false;
			this.obs = new MutationObserver(() => surface.select(nodeEl.hasClass("is-focused")));
			this.obs.observe(nodeEl, { attributes: true, attributeFilter: ["class"] });
			// First click on an unselected card lands on Canvas's content blocker (it selects the card).
			// A click — not a drag, which moves the card — on the picture also opens the real window.
			let down: { x: number; y: number; t: number } | null = null;
			const onPicture = (t: EventTarget | null) => t instanceof HTMLElement && (t.hasClass("canvas-node-content-blocker") || this.ctx.containerEl.contains(t));
			this.registerDomEvent(nodeEl, "pointerdown", (e: PointerEvent) => {
				down = e.button === 0 && onPicture(e.target) ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
			}, { capture: true });
			this.registerDomEvent(nodeEl, "pointerup", (e: PointerEvent) => {
				const d = down;
				down = null;
				if (!d || !(e.target instanceof HTMLElement) || !e.target.hasClass("canvas-node-content-blocker")) return;
				if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || performance.now() - d.t > 500) return;
				surface.engage({ x: e.clientX, y: e.clientY, button: 0, clicks: 1 });
			}, { capture: true });
			return true;
		};
		if (!hook()) {
			const t = window.setInterval(() => hook() && window.clearInterval(t), 100);
			this.register(() => window.clearInterval(t));
		}
	}

	onunload() {
		this.obs?.disconnect();
		this.surface?.dispose();
		this.surface = null;
	}
}

export async function readWindowSpec(core: VivariumCore, file: TFile): Promise<WindowSpec | null> {
	try {
		const raw = JSON.parse(await core.app.vault.cachedRead(file));
		if (!raw?.id || !raw?.app?.bundleId) return null;
		return { version: 1, kind: "app", id: raw.id, title: raw.title ?? file.basename, app: raw.app, windowId: raw.windowId, titleHint: raw.titleHint };
	} catch {
		return null;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type R = { x: number; y: number; width: number; height: number };
const rectClose = (a: R, b: R, tol: number) =>
	Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;


/** Opening a `.window` file in a tab shows the same live app. */
export class WindowView extends FileView {
	private surface: WindowSurface | null = null;

	constructor(leaf: WorkspaceLeaf, private core: VivariumCore) {
		super(leaf);
	}

	getViewType() {
		return WINDOW_VIEW_TYPE;
	}

	getIcon() {
		return "app-window";
	}

	canAcceptExtension(ext: string) {
		return ext === WINDOW_EXT;
	}

	async onLoadFile(file: TFile) {
		this.contentEl.empty();
		this.contentEl.addClass("vivarium-view");
		const spec = await readWindowSpec(this.core, file);
		if (!spec || !this.core.helper) return;
		this.surface = new WindowSurface(this.core, this.contentEl, spec, file);
		this.surface.start();
	}

	async onUnloadFile() {
		this.surface?.dispose();
		this.surface = null;
	}
}
