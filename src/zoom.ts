/**
 * Semantic zoom for Canvas.
 *
 * Below its zoom threshold Canvas unmounts card content (that's how it stays fast): text cards
 * go blank, file names shrink with the canvas until they're unreadable. For organizing big
 * workspaces you want the opposite of "everything shrinks" — like a map, labels should stay
 * legible however far you zoom out. So, below the threshold:
 *
 *   text cards → their first heading (or first line), sized in *screen* pixels
 *   group titles and file-card names → same, so sections stay labelled
 *   Vivarium tiles (terminals, apps) → stay mounted, frozen on their last picture (no streaming)
 *
 * Cost: one CSS variable write per viewport change (quantized), plain text labels created once
 * per zoom-out, no per-frame work per card.
 */
import { TFile } from "obsidian";

const LABEL_CLASS = "vivarium-zoom-label";
const OUT_CLASS = "vivarium-zoomed-out";
const FAR_CLASS = "vivarium-zoomed-far";
const VERY_FAR_CLASS = "vivarium-zoomed-veryfar";

type AnyNode = any;
type AnyCanvas = any;

export interface ZoomListener {
	(scale: number): void;
}

export class SemanticZoom {
	private hooked = new Map<AnyCanvas, () => void>();
	private listeners = new Set<ZoomListener>();

	constructor(private isTileNode: (n: AnyNode) => boolean, private labelForFile: (f: TFile) => string | null) {}

	onZoom(fn: ZoomListener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	hook(canvas: AnyCanvas) {
		if (this.hooked.has(canvas) || typeof canvas.markViewportChanged !== "function") return;
		const orig = canvas.markViewportChanged;
		let raf: number | null = null;
		const self = this;
		// Instance-level wrap (not the prototype): Canvas calls this whenever pan/zoom changes.
		// Canvas eases zoom/pan towards a target (tZoom) over several frames after one wheel event,
		// without calling markViewportChanged again: keep updating until it arrives, or the state
		// (zoomed out or not) would be decided on a zoom level that's already gone.
		const tick = () => {
			raf = null;
			self.update(canvas);
			const moving = typeof canvas.tZoom === "number" && Math.abs(canvas.zoom - canvas.tZoom) > 0.002;
			if (moving) raf = requestAnimationFrame(tick);
		};
		canvas.markViewportChanged = function (...args: any[]) {
			const r = orig.apply(this, args);
			if (raf === null) raf = requestAnimationFrame(tick);
			return r;
		};
		this.hooked.set(canvas, () => {
			canvas.markViewportChanged = orig;
			canvas.wrapperEl?.removeClass(OUT_CLASS);
			canvas.wrapperEl?.removeClass(FAR_CLASS);
			canvas.wrapperEl?.removeClass(VERY_FAR_CLASS);
			this.overlays.get(canvas)?.layer.remove();
			this.overlays.delete(canvas);
			for (const n of canvas.nodes?.values() ?? []) {
				n.vivariumLabelEl?.remove();
				n.vivariumLabelEl = null;
				(n.containerEl as HTMLElement | undefined)?.removeClass("vivarium-has-label");
				if (n.vivariumOrigUpdateBreakpoint) {
					n.updateBreakpoint = n.vivariumOrigUpdateBreakpoint;
					n.vivariumOrigUpdateBreakpoint = null;
				}
			}
		});
		this.update(canvas);
	}

	private lastOut = new WeakMap<AnyCanvas, boolean>();
	private lastInv = new WeakMap<AnyCanvas, number>();
	private lastFar = new WeakMap<AnyCanvas, boolean>();
	private lastVeryFar = new WeakMap<AnyCanvas, boolean>();
	private overlays = new WeakMap<AnyCanvas, { layer: HTMLElement; byNode: Map<AnyNode, { el: HTMLElement; key: string }> }>();

	/** One small element per group, in a layer above all cards (few groups → cheap to sync). */
	private syncGroupOverlays(canvas: AnyCanvas) {
		let o = this.overlays.get(canvas);
		if (!o) {
			o = { layer: canvas.canvasEl.createDiv({ cls: "vivarium-group-overlays" }), byNode: new Map() };
			this.overlays.set(canvas, o);
		}
		if (o.layer.parentElement !== canvas.canvasEl || o.layer !== canvas.canvasEl.lastElementChild) canvas.canvasEl.appendChild(o.layer);
		const seen = new Set<AnyNode>();
		for (const n of canvas.nodes.values()) {
			if (typeof n.label !== "string" || !n.label || n.getData?.().type !== "group") continue;
			seen.add(n);
			const key = `${n.x},${n.y},${n.width},${n.height},${n.label}`;
			let e = o.byNode.get(n);
			if (e && e.key === key) continue;
			if (!e) {
				const el = o.layer.createDiv({ cls: "vivarium-group-overlay" });
				el.createSpan();
				e = { el, key: "" };
				o.byNode.set(n, e);
			}
			e.key = key;
			e.el.style.transform = `translate(${n.x}px, ${n.y}px)`;
			e.el.style.width = `${n.width}px`;
			e.el.style.height = `${n.height}px`;
			(e.el.firstChild as HTMLElement).textContent = n.label;
		}
		for (const [n, e] of o.byNode) if (!seen.has(n)) (e.el.remove(), o.byNode.delete(n));
	}
	private settle = new WeakMap<AnyCanvas, number>();

	private update(canvas: AnyCanvas) {
		const scale: number = canvas.scale || 1;
		const out = canvas.zoom <= canvas.zoomBreakpoint;
		// Quantize so labels only relayout when their size changes noticeably (25% steps).
		const STEP = 1.25;
		const inv = Math.pow(STEP, Math.round(Math.log(1 / scale) / Math.log(STEP)));
		if (this.lastInv.get(canvas) !== inv) {
			// Re-sizing labels means re-laying-out their text: do it when the zoom gesture pauses
			// (like map apps), not on every frame of a pinch.
			const wasOut = this.lastOut.get(canvas);
			const apply = () => {
				this.lastInv.set(canvas, inv);
				canvas.wrapperEl.style.setProperty("--vivarium-inv-scale", inv.toFixed(3));
				// one shared cap (~11% of a typical card's width), instead of per-card measuring
				canvas.wrapperEl.style.setProperty("--vivarium-max-label", `${Math.round(this.typicalWidth(canvas) * 0.11)}px`);
			};
			window.clearTimeout(this.settle.get(canvas));
			if (!this.lastInv.has(canvas) || wasOut !== out) apply(); // first time / crossing: now
			else this.settle.set(canvas, window.setTimeout(apply, 120));
		}
		if (this.lastOut.get(canvas) !== out) {
			this.lastOut.set(canvas, out);
			canvas.wrapperEl.toggleClass(OUT_CLASS, out);
		}
		// cards smaller than ~50 px on screen: no readable label fits; leave it to group titles
		const cardPx = this.typicalWidth(canvas) * scale;
		const far = out && cardPx < 50;
		if (this.lastFar.get(canvas) !== far) {
			this.lastFar.set(canvas, far);
			canvas.wrapperEl.toggleClass(FAR_CLASS, far);
		}
		// cards are specks: group titles above their group would collide (the gaps are a few px)
		const veryFar = out && cardPx < 25;
		if (this.lastVeryFar.get(canvas) !== veryFar) {
			this.lastVeryFar.set(canvas, veryFar);
			canvas.wrapperEl.toggleClass(VERY_FAR_CLASS, veryFar);
		}
		if (veryFar) this.syncGroupOverlays(canvas);
		// Cards on screen that are new or edited since their label was made (cheap check).
		if (out && !far) for (const n of canvas.lastNodesInViewport ?? canvas.nodes.values()) if (this.prepared.get(n) !== this.source(n)) this.prepare(n);
		for (const l of this.listeners) l(scale);
	}

	private widthCache = new WeakMap<AnyCanvas, { n: number; w: number }>();
	/** 30th-percentile card width (recomputed only when the card count changes). */
	private typicalWidth(canvas: AnyCanvas): number {
		const size = canvas.nodes?.size ?? 0;
		const c = this.widthCache.get(canvas);
		if (c && c.n === size) return c.w;
		const ws = [...(canvas.nodes?.values() ?? [])].filter((n: AnyNode) => typeof n.text === "string" || n.file).map((n: AnyNode) => n.width).sort((a, b) => a - b);
		const w = ws.length ? ws[Math.floor(ws.length * 0.3)] : 300;
		this.widthCache.set(canvas, { n: size, w });
		return w;
	}

	/** node → the text its label was made from. Per plugin instance, so a reload starts fresh. */
	private prepared = new WeakMap<AnyNode, string>();

	private source(n: AnyNode): string {
		return typeof n.text === "string" ? n.text : n.file?.path ?? n.url ?? "";
	}

	/** Make/refresh a card's zoomed-out label (only for cards that are new or changed). */
	private prepare(n: AnyNode) {
		this.prepared.set(n, this.source(n));
		if (this.isTileNode(n)) {
			// Keep Vivarium tiles mounted at every zoom: they show their last picture; the tiles
			// themselves stop streaming/rendering while tiny (see zoom listeners).
			if (!n.vivariumOrigUpdateBreakpoint) {
				n.vivariumOrigUpdateBreakpoint = n.updateBreakpoint;
				n.updateBreakpoint = function () {
					this.mountContent?.();
				};
				n.mountContent?.();
			}
			return;
		}
		const label = this.labelFor(n);
		if (!label) {
			n.vivariumLabelEl?.remove();
			n.vivariumLabelEl = null;
			(n.containerEl as HTMLElement | undefined)?.removeClass("vivarium-has-label");
			return;
		}
		const host: HTMLElement | undefined = n.containerEl ?? n.nodeEl;
		if (!host) return;
		let el: HTMLElement = n.vivariumLabelEl;
		if (!el || el.parentElement !== host) {
			el?.remove();
			el = n.vivariumLabelEl = host.createDiv({ cls: LABEL_CLASS });
			host.addClass("vivarium-has-label"); // plain class instead of :has() (cheap to style)
		}
		if (el.textContent !== label.text) el.textContent = label.text;
		el.dataset.level = String(label.level);
	}

	private labelFor(n: AnyNode): { text: string; level: number } | null {
		if (typeof n.text === "string") return headline(n.text);
		if (n.file instanceof TFile) {
			const t = this.labelForFile(n.file) ?? n.file.basename;
			return { text: t, level: 3 };
		}
		if (typeof n.url === "string") {
			try {
				return { text: new URL(n.url).hostname.replace(/^www\./, ""), level: 4 };
			} catch {
				return { text: n.url, level: 4 };
			}
		}
		return null; // groups: their own label element is enlarged via CSS
	}

	dispose() {
		for (const undo of this.hooked.values()) undo();
		this.hooked.clear();
		this.listeners.clear();
	}
}

/** First markdown heading of a text card (level 1–6), else its first line as body text (7). */
export function headline(md: string): { text: string; level: number } | null {
	let first: string | null = null;
	for (const raw of md.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("---") || line.startsWith("```")) continue;
		const h = /^(#{1,6})\s+(.*)$/.exec(line);
		if (h) return { text: clean(h[2]), level: h[1].length };
		first ??= line;
	}
	return first ? { text: clean(first), level: 7 } : null;
}

function clean(s: string): string {
	return s
		.replace(/!\[\[[^\]]*\]\]/g, "")
		.replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, a, b) => b || a)
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[*_`~=]+/g, "")
		.replace(/^[-+>]\s+/, "")
		.trim()
		.slice(0, 120);
}
