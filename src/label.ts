/**
 * Tile names on the canvas. A tile is a file (`Shell 2.term`), and Canvas labels non-note files
 * with their full name. We show the name without the ending, and let you rename a tile by
 * double-clicking its name (or "Rename tile…" in its menu).
 *
 * Only plain DOM is touched: the card's `.canvas-node-label`, whose text Canvas sets to the file
 * name. If Canvas changes that, labels just show the ending again; nothing breaks.
 */
import { App, Component, Modal, Notice, Setting, TFile, normalizePath } from "obsidian";

/** Keep the card's name label free of the file ending; double-click it to rename. */
export function hookTileLabel(app: App, owner: Component, containerEl: HTMLElement, file: TFile) {
	let nodeEl: HTMLElement | null = null;
	let labelEl: HTMLElement | null = null;
	const labelObserver = new MutationObserver(() => tidy());
	const tidy = () => {
		if (labelEl && labelEl.textContent === file.name) labelEl.textContent = file.basename;
	};
	const onDblClick = (e: MouseEvent) => {
		// Canvas would open the file in a tab; for a tile, a double-click on its name renames it.
		e.preventDefault();
		e.stopImmediatePropagation();
		renameTile(app, file);
	};
	const attachLabel = () => {
		const el = nodeEl?.querySelector<HTMLElement>(":scope > .canvas-node-label") ?? null;
		if (el === labelEl) return tidy();
		labelEl?.removeEventListener("dblclick", onDblClick, true);
		labelObserver.disconnect();
		labelEl = el;
		if (!el) return;
		el.addEventListener("dblclick", onDblClick, true);
		el.setAttribute("aria-label", "Double-click to rename");
		labelObserver.observe(el, { childList: true, characterData: true, subtree: true });
		tidy();
	};
	// Canvas (re)creates the label as a direct child of the card: watch the card itself, not its
	// content (a terminal repaints constantly).
	const nodeObserver = new MutationObserver(() => attachLabel());
	const hook = () => {
		nodeEl = containerEl.closest<HTMLElement>(".canvas-node");
		if (!nodeEl) return false;
		nodeObserver.observe(nodeEl, { childList: true });
		attachLabel();
		return true;
	};
	if (!hook()) {
		// containerEl may not be inside the card yet on first load (not on a canvas at all: no label)
		let tries = 0;
		const t = window.setInterval(() => (hook() || ++tries > 50) && window.clearInterval(t), 100);
		owner.register(() => window.clearInterval(t));
	}
	owner.register(() => {
		nodeObserver.disconnect();
		labelObserver.disconnect();
		labelEl?.removeEventListener("dblclick", onDblClick, true);
		if (labelEl && labelEl.textContent === file.basename) labelEl.textContent = file.name;
	});
}

/** Ask for a new name and rename the tile's file (Obsidian updates canvases that show it). */
export function renameTile(app: App, file: TFile) {
	new RenameModal(app, file).open();
}

class RenameModal extends Modal {
	constructor(app: App, private file: TFile) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Rename tile");
		let value = this.file.basename;
		const submit = async () => {
			const name = value.trim();
			if (!name || name === this.file.basename) return this.close();
			if (/[\\/:]/.test(name)) return void new Notice("A tile name can't contain / \\ or :");
			const dir = this.file.parent && this.file.parent.path !== "/" ? this.file.parent.path + "/" : "";
			const target = normalizePath(`${dir}${name}.${this.file.extension}`);
			if (this.app.vault.getAbstractFileByPath(target)) return void new Notice(`There's already a tile called "${name}" here.`);
			try {
				await this.app.fileManager.renameFile(this.file, target);
				this.close();
			} catch (e) {
				new Notice(`Could not rename: ${(e as Error).message}`);
			}
		};
		new Setting(this.contentEl).addText((t) => {
			t.setValue(value).onChange((v) => (value = v));
			t.inputEl.addClass("vivarium-rename-input");
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					void submit();
				}
			});
			window.setTimeout(() => {
				t.inputEl.focus();
				t.inputEl.select();
			}, 0);
		});
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Rename").setCta().onClick(() => submit()));
	}

	onClose() {
		this.contentEl.empty();
	}
}
