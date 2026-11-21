import { App, Modal, Setting, SuggestModal } from "obsidian";
import type { Program } from "./core";
import { normalizeUrl } from "./web";

const CUSTOM = Symbol("custom");
export type Choice = Program | typeof CUSTOM | { kind: "web"; url: string };
export type Picked = { kind: "program"; program: Program } | { kind: "web"; url: string };
const isProgram = (c: Choice): c is Program => typeof c === "object" && !("kind" in c);

/** "Add program…" picker: fuzzy-filter presets, Enter adds. Last entry runs any command. */
export class ProgramPicker extends SuggestModal<Choice> {
	constructor(
		app: App,
		private programs: Program[],
		private onPickAny: (p: Picked) => void,
	) {
		super(app);
		this.setPlaceholder("Add program to canvas…");
		this.setInstructions([
			{ command: "↵", purpose: "add" },
			{ command: "type", purpose: "a command not in the list to run it directly" },
		]);
	}

	getSuggestions(query: string): Choice[] {
		const q = query.toLowerCase().trim();
		const m = (...xs: string[]) => !q || xs.some((x) => x.toLowerCase().includes(q));
		const progs = this.programs.filter((p) => m(p.name, p.command));
		// a URL or "localhost:3000" → a web page right on the canvas (first: it's what you typed)
		const url = normalizeUrl(query);
		const web = url ? [{ kind: "web" as const, url }] : !q || "web page browser".includes(q) ? [{ kind: "web" as const, url: "" }] : [];
		return [...web, ...progs, CUSTOM];
	}

	renderSuggestion(c: Choice, el: HTMLElement) {
		if (c === CUSTOM) {
			const q = this.inputEl.value.trim();
			el.createDiv({ text: q ? `Run "${q}"` : "Custom command…" });
			el.createEl("small", { text: "Runs in a login shell in a new tile", cls: "vivarium-suggest-sub" });
			return;
		}
		if (!isProgram(c)) {
			el.createDiv({ text: c.url ? `Open ${c.url}` : "Web page…" });
			el.createEl("small", { text: "Browser right on the canvas · type a URL to open it directly", cls: "vivarium-suggest-sub" });
			return;
		}
		el.createDiv({ text: c.name });
		el.createEl("small", { text: c.command || "Login shell", cls: "vivarium-suggest-sub" });
	}

	private onPick = (p: Program) => this.onPickAny({ kind: "program", program: p });

	onChooseSuggestion(c: Choice) {
		if (c !== CUSTOM && !isProgram(c) && c.kind === "web" && !c.url) {
			// "Web page…" without a URL: ask for one
			const m = new UrlModal(this.app, (u) => this.onPickAny({ kind: "web", url: u }));
			return m.open();
		}
		if (c !== CUSTOM && !isProgram(c)) return this.onPickAny(c);
		if (c !== CUSTOM) return this.onPick(c);
		const q = this.inputEl.value.trim();
		if (q) return this.onPick({ name: q.split(/\s+/)[0], command: q, cwd: "" });
		new CustomProgramModal(this.app, this.onPick).open();
	}
}

class CustomProgramModal extends Modal {
	constructor(app: App, private onPick: (p: Program) => void) {
		super(app);
	}

	onOpen() {
		const p: Program = { name: "", command: "", cwd: "" };
		this.setTitle("Custom program");
		const submit = () => {
			if (!p.command.trim()) return;
			this.close();
			this.onPick({ ...p, name: p.name || p.command.split(/\s+/)[0] });
		};
		new Setting(this.contentEl).setName("Command").addText((t) => {
			t.setPlaceholder("npm run dev").onChange((v) => (p.command = v));
			t.inputEl.addEventListener("keydown", (e) => e.key === "Enter" && submit());
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(this.contentEl).setName("Title").addText((t) => t.setPlaceholder("Dev server").onChange((v) => (p.name = v)));
		new Setting(this.contentEl).setName("Working directory").setDesc("Empty = default from settings").addText((t) => t.setPlaceholder("~/code/project").onChange((v) => (p.cwd = v)));
		new Setting(this.contentEl).addButton((b) => b.setButtonText("Add").setCta().onClick(submit));
	}
}

class UrlModal extends Modal {
	constructor(app: App, private onPick: (url: string) => void) {
		super(app);
	}

	onOpen() {
		this.setTitle("Web page");
		let v = "";
		const submit = () => {
			const u = normalizeUrl(v);
			if (!u) return;
			this.close();
			this.onPick(u);
		};
		new Setting(this.contentEl).setName("Address").addText((t) => {
			t.setPlaceholder("localhost:3000 or example.com").onChange((x) => (v = x));
			t.inputEl.addEventListener("keydown", (e) => e.key === "Enter" && submit());
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(this.contentEl).addButton((b) => b.setButtonText("Open").setCta().onClick(submit));
	}
}
