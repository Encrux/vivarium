/**
 * Minimal shapes for the undocumented internals we touch (types only). Every member is optional
 * and checked before use, so a future Obsidian without one loses that extra, not the plugin.
 */
import type { EventRef, Menu, TFile } from "obsidian";

export interface Point {
	x: number;
	y: number;
}
export interface Size {
	width: number;
	height: number;
}

/** A card on an Obsidian canvas. Position and size are its saved data, so always there. */
export interface CanvasNode extends Point, Size {
	file?: TFile; // file cards
	text?: string; // text cards
	url?: string; // link cards
	label?: string; // groups
	containerEl?: HTMLElement;
	nodeEl?: HTMLElement;
	contentEl?: HTMLElement;
	/** Don't detach the card's content while it's off-screen. */
	alwaysKeepLoaded?: boolean;
	getData?(): { type?: string };
	render?(): void;
	unloadChild?(): void;
	mountContent?(): void;
	/** Mounts/unmounts content by zoom level (replaced by zoom.ts for tiles). */
	updateBreakpoint?: (this: CanvasNode, ...args: unknown[]) => void;
	// ours (zoom.ts)
	vivariumLabelEl?: HTMLElement | null;
	vivariumOrigUpdateBreakpoint?: ((this: CanvasNode, ...args: unknown[]) => void) | null;
}

/** Obsidian's live canvas object (`view.canvas` of a canvas leaf). */
export interface CanvasInternal {
	wrapperEl?: HTMLElement;
	canvasEl?: HTMLElement;
	cardMenuEl?: HTMLElement;
	nodes?: Map<string, CanvasNode>;
	lastNodesInViewport?: Iterable<CanvasNode>;
	selection?: Set<CanvasNode>;
	/** Current zoom level, the one it's easing towards, and the resulting scale. */
	zoom?: number;
	tZoom?: number;
	scale?: number;
	/** At or below this zoom Canvas unmounts card content. */
	zoomBreakpoint?: number;
	markViewportChanged?: (this: CanvasInternal, ...args: unknown[]) => unknown;
	posCenter?(): Point;
	posFromClient?(p: Point): Point;
	createFileNode?(o: { pos: Point; size?: Size; position?: string; file: TFile; save?: boolean; focus?: boolean }): CanvasNode;
	showCreationMenu?: (this: CanvasInternal, menu: Menu, pos: Point, size?: Size) => void;
	selectOnly?(n: CanvasNode): void;
	requestSave?(): void;
}

/** A canvas leaf's view. */
export interface CanvasView {
	canvas?: CanvasInternal;
}

/** Workspace events Canvas adds (not in obsidian.d.ts). */
export interface CanvasWorkspaceEvents {
	on(name: "canvas:node-menu", cb: (menu: Menu, node: CanvasNode) => void): EventRef;
}

/** Electron's <webview> element: the methods exist once Electron has set it up. */
export interface WebviewElement extends HTMLElement {
	getURL?(): string;
	loadURL?(url: string): Promise<void>;
	canGoBack?(): boolean;
	canGoForward?(): boolean;
	goBack?(): void;
	goForward?(): void;
	reload?(): void;
}

/** <webview>'s "page-title-updated" event. */
export interface PageTitleEvent extends Event {
	title?: string;
}

/** xterm.js's private mouse service (term._core._mouseService): maps mouse events to cells. */
export interface XtermMouseService {
	getCoords?: (ev: { clientX: number; clientY: number }, el: HTMLElement, ...rest: unknown[]) => unknown;
	getMouseReportCoords?: (ev: { clientX: number; clientY: number }, el: HTMLElement) => unknown;
}
export interface XtermInternal {
	_core?: { _mouseService?: XtermMouseService };
}

/** The part of Electron we use, through Obsidian's window.require. */
export interface ElectronModule {
	shell: { openExternal(url: string): Promise<void> };
}
