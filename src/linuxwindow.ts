/**
 * App tiles on Linux.
 *
 * The helper (helper/linux) is the display server of the apps in your tiles: a headless Wayland
 * compositor. Each app window is drawn into a shared-memory frame file (two slots, see
 * helper/linux/README.md); per new frame we get a small message with the rectangles that changed,
 * read just those rows from the file, ack the frame (so the app can draw the next one) and upload
 * the rectangles into a WebGL texture. There is no "real window" to hand over to like on macOS:
 * the tile *is* the window, so mouse and keyboard go straight into it.
 *
 *   visible on screen      → frames flow (≤ 60 fps, as fast as the app draws and we ack)
 *   off screen / tiny      → the helper stops asking the app to draw: it idles, costs nothing
 *   tile resized           → the window is resized to the tile (once you let go)
 *
 * Which window a tile shows: apps are started with VIVARIUM_TILE=<tile id> in their environment
 * and the helper reports that "tag" per window, so a tile finds its window again after Obsidian
 * restarts (the helper keeps running, see helper.ts). After a reboot or logout the helper and its
 * apps are gone: tiles that had a window open start their app again (restoreLinuxApps).
 */
import * as fs from "fs";
import type { TFile } from "obsidian";
import { execFile } from "child_process";
import type { VivariumCore } from "./core";
import type { FrameMsg, WindowInfo } from "./helper";
import type { WindowSpec, TileHost } from "./window";

const HIDE_GRACE_MS = 300;
const RESIZE_SETTLE_MS = 250;
const LAUNCH_TIMEOUT_MS = 30_000;

interface LinuxWin extends WindowInfo {
	tag?: string | null;
	appId?: string;
}

/** What we remember per tile on this device (never in the tile file). */
interface LinuxTileState {
	instance: string; // helper run the window id belongs to
	windowId: number;
	titleHint: string;
	/** a window was open (restore it after a reboot); false once you closed it */
	open: boolean;
}

// ---------------------------------------------------------------- launching (shared)

const launching = new Map<string, Promise<LinuxWin | null>>();

/**
 * Per-app launch customization (e.g. how a browser gets its own profile so it opens in the tile
 * instead of remoting into the desktop instance). Returns launch params to use instead of the
 * desktop entry, or null for the default.
 */
type LaunchHook = (spec: WindowSpec, params: Record<string, any>) => Promise<Record<string, any>> | null;
let launchHook: LaunchHook | null = null;
export function setLaunchHook(h: LaunchHook | null) {
	launchHook = h;
}

async function listWindows(core: VivariumCore): Promise<LinuxWin[]> {
	return ((await core.helper!.request("list_windows")).windows ?? []) as LinuxWin[];
}

/** The tile's window, if the app is running: tagged with the tile id, or the one we remember. */
async function findWindow(core: VivariumCore, spec: WindowSpec, isFree: (w: LinuxWin) => boolean): Promise<LinuxWin | null> {
	const wins = await listWindows(core);
	const tagged = wins.filter((w) => w.tag === spec.id && isFree(w)).sort((a, b) => a.windowId - b.windowId);
	if (tagged.length) return tagged[0];
	const st = core.tileState<LinuxTileState>(spec.id);
	const instance = core.helper!.info?.instance;
	if (st.windowId && instance && st.instance === instance) {
		const w = wins.find((x) => x.windowId === st.windowId && isFree(x));
		if (w) return w;
	}
	return null;
}

/** Start the tile's app (once, even if asked again meanwhile) and wait for its window. */
function launchApp(core: VivariumCore, spec: WindowSpec, size: { width: number; height: number }, isFree: (w: LinuxWin) => boolean): Promise<LinuxWin | null> {
	const running = launching.get(spec.id);
	if (running) return running;
	const p = (async () => {
		const h = core.helper!;
		const before = new Set((await listWindows(core)).map((w) => w.windowId));
		const params: Record<string, any> = { width: Math.round(size.width), height: Math.round(size.height), env: { VIVARIUM_TILE: spec.id } };
		const desktopId = spec.app.bundleId;
		const custom = launchHook?.(spec, params);
		if (custom) Object.assign(params, await custom);
		else params.desktopId = desktopId;
		const { pid } = await h.request("launch", params);
		const t0 = Date.now();
		while (Date.now() - t0 < LAUNCH_TIMEOUT_MS) {
			await sleep(Date.now() - t0 < 2000 ? 150 : 400);
			const wins = await listWindows(core);
			const fresh = wins.filter((w) => !before.has(w.windowId) && isFree(w));
			// ours for sure (tag), else a new window of the process we started, else of this app
			const pick = fresh.find((w) => w.tag === spec.id) ?? fresh.find((w) => w.pid === pid) ?? fresh.find((w) => sameApp(w, desktopId));
			if (pick) return pick;
		}
		return null;
	})().finally(() => launching.delete(spec.id));
	launching.set(spec.id, p);
	return p;
}

function sameApp(w: LinuxWin, desktopId: string) {
	const id = desktopId.replace(/\.desktop$/, "").toLowerCase();
	const app = (w.appId || w.app || "").toLowerCase();
	return !!app && (app === id || id.endsWith("." + app) || id.split(/[._-]/).includes(app));
}

/**
 * After a reboot/logout (helper gone, so are its apps): start the apps of tiles that had a
 * window open, without waiting for you to open their canvas. A tile you closed stays closed.
 */
export async function restoreLinuxApps(core: VivariumCore, files: TFile[], readSpec: (f: TFile) => Promise<WindowSpec | null>) {
	if (!core.helper) return;
	const specs: WindowSpec[] = [];
	for (const f of files) {
		const spec = await readSpec(f);
		if (spec && core.tileState<LinuxTileState>(spec.id).open) specs.push(spec);
	}
	if (!specs.length) return;
	await core.helper.ensure();
	let n = 0;
	for (const spec of specs) {
		if (await findWindow(core, spec, () => true)) continue;
		n++;
		launchApp(core, spec, { width: 900, height: 620 }, (w) => !core.windowClaimedByOther(w.windowId, null)).catch((e) => console.warn("[vivarium] restore app", e));
	}
	if (n) core.notice(`reopening ${n} app${n === 1 ? "" : "s"}`);
}

// ---------------------------------------------------------------- keyboard layout

let keymapSent: string | null = null;

/** Your desktop's keyboard layout, so keys in a tile type what they type everywhere else. */
function detectXkb(): Promise<{ layout: string; variant: string; options: string } | null> {
	const run = (cmd: string, args: string[]) => new Promise<string>((res) => execFile(cmd, args, { timeout: 1500 }, (e, out) => res(e ? "" : String(out))));
	return (async () => {
		// GNOME (Ubuntu): [('xkb', 'de+nodeadkeys'), ('xkb', 'us')]
		const g = await run("gsettings", ["get", "org.gnome.desktop.input-sources", "sources"]);
		const m = /\('xkb',\s*'([^']+)'\)/.exec(g);
		const opts = /\[(.*)\]/.exec(await run("gsettings", ["get", "org.gnome.desktop.input-sources", "xkb-options"]))?.[1]?.replace(/'/g, "").replace(/\s/g, "") ?? "";
		if (m) {
			const [layout, variant = ""] = m[1].split("+");
			return { layout, variant, options: opts };
		}
		const l = await run("localectl", ["status"]);
		const layout = /X11 Layout:\s*(\S+)/.exec(l)?.[1];
		if (layout) return { layout: layout.split(",")[0], variant: (/X11 Variant:\s*(\S+)/.exec(l)?.[1] ?? "").split(",")[0], options: /X11 Options:\s*(\S+)/.exec(l)?.[1] ?? "" };
		const s = await run("setxkbmap", ["-query"]);
		const sl = /layout:\s*(\S+)/.exec(s)?.[1];
		if (sl) return { layout: sl.split(",")[0], variant: (/variant:\s*(\S+)/.exec(s)?.[1] ?? "").split(",")[0], options: /options:\s*(\S+)/.exec(s)?.[1] ?? "" };
		return null;
	})();
}

async function ensureKeymap(core: VivariumCore) {
	const inst = core.helper?.info?.instance ?? "";
	if (keymapSent === inst) return;
	keymapSent = inst;
	const k = await detectXkb().catch(() => null);
	if (k) await core.helper!.request("set_keymap", { layout: k.layout, variant: k.variant, model: "", options: k.options || undefined }).catch((e) => console.warn("[vivarium] keymap", e));
}

// ---------------------------------------------------------------- the tile

export class LinuxWindowSurface {
	readonly el: HTMLElement;
	host: TileHost | null = null;
	private canvas: HTMLCanvasElement;
	private gl: FrameGL | null;
	private statusEl: HTMLElement;
	private win: LinuxWin | null = null;
	private fd: number | null = null;
	private fbPath = "";
	private pixels = Buffer.alloc(0);
	private frameW = 0;
	private frameH = 0;
	private visible = false;
	private sentVisible: boolean | null = null;
	private onScreen = false;
	private tiny = false;
	private cssWidth = 0;
	private disposed = false;
	private io: IntersectionObserver;
	private ro: ResizeObserver;
	private hideTimer: number | null = null;
	private resizeTimer: number | null = null;
	private offEvents: () => void;
	private offFrames: () => void = () => {};
	private offZoom: () => void = () => {};
	private keysDown = new Set<string>();
	private moveRaf: number | null = null;
	private lastMove: { x: number; y: number } | null = null;
	private starting = false;

	constructor(private core: VivariumCore, parent: HTMLElement, private spec: WindowSpec, private file: TFile) {
		this.el = parent.createDiv({ cls: "vivarium-window is-linux" });
		this.canvas = this.el.createEl("canvas", { cls: "vivarium-window-canvas", attr: { tabindex: "0" } });
		this.gl = FrameGL.create(this.canvas);
		this.statusEl = this.el.createDiv({ cls: "vivarium-window-status", text: "Connecting…" });
		this.bindInput();

		this.io = new IntersectionObserver((es) => {
			this.onScreen = es[es.length - 1].isIntersecting && this.el.isConnected;
			this.setVisible(this.onScreen && !this.tiny);
		});
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
		this.offEvents = core.helper!.onEvent((ev, m) => this.onHelperEvent(ev, m));
	}

	// ---------- finding / starting the window ----------

	async start() {
		if (this.starting || this.disposed) return;
		this.starting = true;
		try {
			if (!this.gl) {
				this.setStatus("App tiles need WebGL2, which isn't available in this Obsidian.");
				return;
			}
			await this.core.helper!.ensure();
			void ensureKeymap(this.core);
			const free = (w: LinuxWin) => !this.core.windowClaimedByOther(w.windowId, this);
			let w = await findWindow(this.core, this.spec, free);
			if (!w) {
				// This tile's app runs, but another view of the same tile holds its window: usually
				// the old embed of a canvas that is being re-rendered, about to let go. Never start a
				// second copy for that; wait, and if it stays (the tile is open twice), offer to move it.
				const held = await findWindow(this.core, this.spec, () => true);
				if (held) {
					for (let i = 0; i < 25 && !this.disposed && this.core.windowClaimedByOther(held.windowId, this); i++) await sleep(100);
					if (this.disposed) return;
					if (this.core.windowClaimedByOther(held.windowId, this)) {
						this.setStatus(`${this.spec.app.name} is shown in another view of this tile.`, "Show here", () => {
							this.core.claimWindow(held.windowId, this);
							this.start();
						});
						return;
					}
					w = held;
				}
			}
			if (!w) {
				const st = this.core.tileState<LinuxTileState>(this.spec.id);
				if (st.open === false) {
					this.showClosed();
					return;
				}
				this.setStatus(`Opening ${this.spec.app.name}…`);
				w = await launchApp(this.core, this.spec, this.tileSize(), free);
				if (!w) {
					this.setStatus(`${this.spec.app.name} didn't open a window.`, "Retry", () => this.start());
					return;
				}
			}
			if (this.disposed) return;
			this.bind(w);
		} catch (e) {
			this.setStatus(`Could not start: ${(e as Error).message}`, "Retry", () => this.start());
		} finally {
			this.starting = false;
		}
	}

	private bind(w: LinuxWin) {
		this.win = w;
		this.core.claimWindow(w.windowId, this);
		this.core.attachedWindows.set(this.file.path, { windowId: w.windowId, pid: w.pid });
		this.core.setTileState(this.spec.id, { instance: this.core.helper!.info?.instance ?? "", windowId: w.windowId, titleHint: w.title || "", open: true });
		this.setStatus(null);
		this.offFrames();
		this.offFrames = this.core.helper!.onFrame(w.windowId, (f) => this.onFrame(f));
		// Start from a clean slate whatever the helper thinks: hidden → shown makes it send the
		// frame file again and then a full frame (the app may have drawn before we bound to it).
		this.core.helper!.send("set_visible", { windowId: w.windowId, visible: false });
		this.sentVisible = false;
		this.pushVisible();
		// the window takes the tile's size (tile CSS px == app logical px at 100% zoom)
		const s = this.tileSize();
		if (s.width >= 100 && s.height >= 80 && (Math.abs(s.width - w.width) > 2 || Math.abs(s.height - w.height) > 2)) {
			this.core.helper!.request("resize", { windowId: w.windowId, ...s }).catch(() => {});
		}
	}

	private unbind() {
		this.offFrames();
		this.offFrames = () => {};
		if (this.win) this.core.releaseWindow(this.win.windowId, this);
		this.win = null;
		this.closeFd();
	}

	private showClosed() {
		this.setStatus(`${this.spec.app.name} is closed.`, "Open", () => {
			this.core.setTileState(this.spec.id, { open: true });
			this.start();
		});
	}

	private onHelperEvent(ev: string, m: any) {
		if (ev === "disconnected") {
			// Obsidian lost the helper (it crashed, or was stopped): reconnect, or start it again
			// (then the apps start again too).
			this.unbind();
			this.setStatus("Reconnecting…");
			window.setTimeout(() => !this.disposed && this.start(), 800);
			return;
		}
		if (ev === "ready" && !this.win && !this.starting) {
			window.setTimeout(() => !this.disposed && !this.win && this.start(), 200);
			return;
		}
		if (!this.win || m.windowId !== this.win.windowId) return;
		if (ev === "frame_buffer") this.openFd(m.path);
		else if (ev === "cursor") this.canvas.style.cursor = cssCursor(m.name);
		else if (ev === "title_changed") this.win.title = m.title;
		else if (ev === "window_removed") this.onWindowGone();
	}

	private async onWindowGone() {
		const gone = this.win;
		this.unbind();
		// The app may have replaced its window (some do on startup or when switching modes).
		await sleep(1200);
		if (this.disposed || this.win) return;
		const again = await findWindow(this.core, this.spec, (w) => w.windowId !== gone?.windowId && !this.core.windowClaimedByOther(w.windowId, this)).catch(() => null);
		if (again) return this.bind(again);
		// You closed it (or the app quit): don't bring it back by itself after a restart.
		this.core.setTileState(this.spec.id, { open: false, windowId: undefined });
		this.showClosed();
	}

	// ---------- frames ----------

	private openFd(p: string) {
		if (p === this.fbPath && this.fd !== null) return;
		this.closeFd();
		try {
			this.fd = fs.openSync(p, "r");
			this.fbPath = p;
		} catch (e) {
			console.warn("[vivarium] frame file", e);
		}
	}

	private closeFd() {
		if (this.fd !== null) fs.closeSync(this.fd);
		this.fd = null;
		this.fbPath = "";
	}

	private onFrame(f: FrameMsg) {
		const h = this.core.helper!;
		if (this.fd === null || !this.gl || this.disposed) {
			h.send("frame_ack", { windowId: f.windowId, seq: f.seq });
			return;
		}
		const need = f.stride * f.height;
		if (this.pixels.length < need) this.pixels = Buffer.alloc(need);
		const resized = f.width !== this.frameW || f.height !== this.frameH;
		// Read the changed rows straight from the frame file (one read per rectangle).
		try {
			for (let i = 0; i + 3 < f.rects.length; i += 4) {
				const y = f.rects[i + 1], rh = f.rects[i + 3];
				fs.readSync(this.fd, this.pixels, y * f.stride, rh * f.stride, f.offset + y * f.stride);
			}
		} catch (e) {
			h.send("frame_ack", { windowId: f.windowId, seq: f.seq });
			console.warn("[vivarium] frame read", e);
			return;
		}
		// Ack before uploading: the helper can compose the next frame into the other slot meanwhile.
		h.send("frame_ack", { windowId: f.windowId, seq: f.seq });
		if (resized) {
			this.frameW = f.width;
			this.frameH = f.height;
			this.canvas.width = f.width;
			this.canvas.height = f.height;
		}
		this.gl.upload(this.pixels, f.width, f.height, f.stride, f.rects, resized);
		this.gl.draw();
	}

	// ---------- visibility / size ----------

	private setVisible(v: boolean) {
		if (v === this.visible) return;
		this.visible = v;
		if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
		this.hideTimer = null;
		if (v) this.pushVisible();
		else this.hideTimer = window.setTimeout(() => !this.visible && this.pushVisible(), HIDE_GRACE_MS);
	}

	private pushVisible() {
		if (!this.win || this.sentVisible === this.visible) return;
		this.sentVisible = this.visible;
		this.core.helper!.request("set_visible", { windowId: this.win.windowId, visible: this.visible }).catch(() => {});
	}

	private tileSize() {
		return { width: Math.round(this.el.clientWidth) || 900, height: Math.round(this.el.clientHeight) || 620 };
	}

	private onTileResize() {
		if (!this.win) return;
		if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
		this.resizeTimer = window.setTimeout(() => {
			this.resizeTimer = null;
			if (!this.win) return;
			const s = this.tileSize();
			if (s.width < 100 || s.height < 80 || (Math.abs(s.width - this.frameW) < 2 && Math.abs(s.height - this.frameH) < 2)) return;
			this.core.helper!.request("resize", { windowId: this.win.windowId, ...s }).catch(() => {});
		}, RESIZE_SETTLE_MS);
	}

	// ---------- input ----------

	/** Client point → frame pixel (the picture fills the tile; the canvas zoom scales both). */
	private toFrame(e: { clientX: number; clientY: number }) {
		const r = this.canvas.getBoundingClientRect();
		const fw = this.frameW || r.width, fh = this.frameH || r.height;
		return { x: ((e.clientX - r.left) / (r.width || 1)) * fw, y: ((e.clientY - r.top) / (r.height || 1)) * fh };
	}

	private bindInput() {
		const c = this.canvas;
		const h = () => this.core.helper!;
		const id = () => this.win?.windowId;
		// Only reached when the card is selected (otherwise Canvas's content blocker takes the click
		// and selects the card): from then on the mouse belongs to the app.
		c.addEventListener("pointerdown", (e) => {
			e.stopPropagation();
			if (id() === undefined) return;
			c.focus({ preventScroll: true });
			c.setPointerCapture(e.pointerId);
			const p = this.toFrame(e);
			h().send("mouse", { windowId: id(), kind: "down", x: p.x, y: p.y, button: e.button });
		});
		c.addEventListener("pointerup", (e) => {
			e.stopPropagation();
			if (id() === undefined) return;
			const p = this.toFrame(e);
			h().send("mouse", { windowId: id(), kind: "up", x: p.x, y: p.y, button: e.button });
		});
		c.addEventListener("pointermove", (e) => {
			if (id() === undefined) return;
			this.lastMove = this.toFrame(e);
			// at most one motion per frame: apps don't need more and it keeps the pipe short
			if (this.moveRaf !== null) return;
			this.moveRaf = requestAnimationFrame(() => {
				this.moveRaf = null;
				if (this.lastMove && id() !== undefined) h().send("mouse", { windowId: id(), kind: "move", x: this.lastMove.x, y: this.lastMove.y });
			});
		});
		c.addEventListener("pointerleave", () => {
			if (id() !== undefined) h().send("mouse", { windowId: id(), kind: "leave" });
		});
		c.addEventListener(
			"wheel",
			(e) => {
				if (id() === undefined || !this.el.closest(".canvas-node.is-focused, .vivarium-view")) return; // unselected: the canvas pans/zooms
				e.preventDefault();
				e.stopPropagation();
				const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
				const p = this.toFrame(e);
				h().send("scroll", { windowId: id(), x: p.x, y: p.y, dx: e.deltaX * k, dy: e.deltaY * k });
			},
			{ passive: false },
		);
		c.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});
		c.addEventListener("mousedown", (e) => e.preventDefault());
		const key = (e: KeyboardEvent, down: boolean) => {
			if (id() === undefined || !e.code) return;
			e.preventDefault();
			e.stopPropagation(); // Obsidian's and Canvas's shortcuts must not see keys meant for the app
			if (down && e.repeat) return; // the app repeats keys itself
			if (down) this.keysDown.add(e.code);
			else if (!this.keysDown.delete(e.code)) return;
			h().send("key", { windowId: id(), code: e.code, down });
		};
		c.addEventListener("keydown", (e) => key(e, true));
		c.addEventListener("keyup", (e) => key(e, false));
		c.addEventListener("focus", () => id() !== undefined && h().send("focus", { windowId: id() }));
		c.addEventListener("blur", () => {
			// release what's still held, or the app thinks Shift is stuck
			for (const code of this.keysDown) h().send("key", { windowId: id(), code, down: false });
			this.keysDown.clear();
		});
	}

	select(on: boolean) {
		this.el.toggleClass("is-focused", on);
		if (!on && document.activeElement === this.canvas) this.canvas.blur();
	}

	// ---------- misc ----------

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
		// Hidden while no tile shows it; the app keeps running (Obsidian restarts find it again).
		if (this.win) this.core.helper!.request("set_visible", { windowId: this.win.windowId, visible: false }).catch(() => {});
		this.unbind();
		this.offEvents();
		this.offZoom();
		this.io.disconnect();
		this.ro.disconnect();
		if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
		if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
		if (this.moveRaf !== null) cancelAnimationFrame(this.moveRaf);
		this.gl?.dispose();
		this.el.remove();
	}
}

/** Smithay/cursor-shape names are CSS cursor names, mostly. */
function cssCursor(name: string): string {
	const map: Record<string, string> = { "context-menu": "context-menu", "dnd-ask": "alias", "dnd-none": "no-drop", "all-resize": "move" };
	return map[name] ?? name ?? "default";
}

// ---------------------------------------------------------------- WebGL

/**
 * One texture per tile. Frames are BGRA (premultiplied): uploaded as RGBA bytes, swapped back in
 * the shader. Only changed rectangles are uploaded (texSubImage2D with UNPACK_ROW_LENGTH, straight
 * from the rows we read), so a blinking cursor costs a few hundred bytes, not a frame.
 */
export class FrameGL {
	private tex: WebGLTexture;
	private texW = 0;
	private texH = 0;

	static create(canvas: HTMLCanvasElement): FrameGL | null {
		const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, desynchronized: true } as WebGLContextAttributes);
		return gl ? new FrameGL(gl) : null;
	}

	private constructor(private gl: WebGL2RenderingContext) {
		const vs = `#version 300 es
			out vec2 uv;
			void main() {
				vec2 p = vec2(float((gl_VertexID & 1) << 1), float(gl_VertexID & 2));
				uv = vec2(p.x * 0.5, p.y * 0.5);
				gl_Position = vec4(p.x - 1.0, 1.0 - p.y, 0.0, 1.0);
			}`;
		const fs = `#version 300 es
			precision mediump float;
			in vec2 uv;
			uniform sampler2D t;
			out vec4 color;
			void main() { color = vec4(texture(t, uv).bgr, 1.0); }`;
		const prog = gl.createProgram()!;
		for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
			const s = gl.createShader(type)!;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			gl.attachShader(prog, s);
		}
		gl.linkProgram(prog);
		gl.useProgram(prog);
		this.tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, this.tex);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
	}

	upload(pixels: Buffer, w: number, h: number, stride: number, rects: number[], full: boolean) {
		const gl = this.gl;
		gl.bindTexture(gl.TEXTURE_2D, this.tex);
		if (w !== this.texW || h !== this.texH) {
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
			this.texW = w;
			this.texH = h;
		}
		gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride / 4);
		const view = new Uint8Array(pixels.buffer, pixels.byteOffset, stride * h);
		if (full) {
			gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
			gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, view);
		} else {
			for (let i = 0; i + 3 < rects.length; i += 4) {
				const [x, y, rw, rh] = [rects[i], rects[i + 1], rects[i + 2], rects[i + 3]];
				if (rw <= 0 || rh <= 0) continue;
				gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
				gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, view.subarray(y * stride, (y + rh) * stride));
			}
		}
		gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
		gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
	}

	draw() {
		const gl = this.gl;
		gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	dispose() {
		this.gl.deleteTexture(this.tex);
		this.gl.getExtension("WEBGL_lose_context")?.loseContext();
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
