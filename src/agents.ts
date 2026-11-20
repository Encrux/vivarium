/**
 * Coding agents in tiles (Codex, Claude Code, anything that runs shell commands) can use the
 * `vivarium` CLI. Two things make that work without any setup:
 *
 *  1. The CLI is findable: a copy lives in ~/.vivarium/bin (with a launcher that falls back to
 *     Obsidian's own Node when `node` isn't installed). That folder goes first on each tile's
 *     PATH, which survives most shell profiles but not all (some rebuild PATH from scratch), so
 *     we also link it into ~/.local/bin (on PATH by default on Ubuntu and many setups) unless
 *     something else is there, and the skill names the full path as a fallback.
 *  2. A skill teaches agents about it. Skills (the open Agent Skills format: a SKILL.md) only cost
 *     the agent one line of context until it needs them, unlike an MCP server whose tool schemas
 *     sit in every request. Installed for:
 *       ~/.agents/skills/vivarium   Codex and other harnesses that read the shared location
 *       ~/.claude/skills/vivarium   Claude Code
 *     We only ever write or remove a skill folder that we created (marker file).
 *
 * Optionally (off by default, it's a permission change): a Codex rule that lets the read-only and
 * canvas commands run outside Codex's sandbox without asking (~/.codex/rules/vivarium.rules).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
// @ts-ignore: bundled as text by esbuild
import SKILL from "../skill/SKILL.md";

const MARKER = ".installed-by-vivarium";

export const BIN_DIR = path.join(os.homedir(), ".vivarium", "bin");

export const CODEX_RULES = `# Written by the Vivarium plugin (Settings → Vivarium → Agents). Lets Codex run these vivarium
# commands outside its sandbox without asking: they need Obsidian's socket and tmux, which the
# sandbox blocks. Commands that start or drive programs (add, send, keys, rm, attach) still ask.
prefix_rule(
    pattern = ["vivarium", ["ls", "me", "read", "wait", "note", "fork", "move", "focus", "help"]],
    decision = "allow",
    justification = "Vivarium canvas: read tiles, add notes, fork this conversation",
)
`;

function skillDirs(): string[] {
	const home = os.homedir();
	return [path.join(home, ".agents", "skills", "vivarium"), path.join(home, ".claude", "skills", "vivarium")];
}

function writeIfChanged(file: string, text: string, mode?: number): boolean {
	try {
		if (fs.readFileSync(file, "utf8") === text) return false;
	} catch {}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, mode ? { mode } : undefined);
	if (mode) fs.chmodSync(file, mode);
	return true;
}

/** Put the CLI where every tile finds it (its folder goes first on each tile's PATH). */
export function installCli(pluginDir: string) {
	const src = path.join(pluginDir, "vivarium");
	if (!fs.existsSync(src)) return;
	writeIfChanged(path.join(BIN_DIR, "vivarium.js"), fs.readFileSync(src, "utf8"));
	writeIfChanged(path.join(BIN_DIR, "SKILL.md"), SKILL); // for `vivarium setup` outside Obsidian
	const q = (s: string) => "'" + s.replace(/'/g, `'\\''`) + "'";
	writeIfChanged(
		path.join(BIN_DIR, "vivarium"),
		[
			"#!/bin/sh",
			"# Installed by the Vivarium Obsidian plugin.",
			`cli=${q(path.join(BIN_DIR, "vivarium.js"))}`,
			'command -v node >/dev/null 2>&1 && exec node "$cli" "$@"',
			"# no Node installed: Obsidian is Electron, which can run as Node",
			`ELECTRON_RUN_AS_NODE=1 exec ${q(process.execPath)} "$cli" "$@"`,
			"",
		].join("\n"),
		0o755,
	);
	const link = path.join(os.homedir(), ".local", "bin", "vivarium");
	const target = path.join(BIN_DIR, "vivarium");
	let current: string | null = null;
	try {
		current = fs.readlinkSync(link);
	} catch {}
	if (current === target) return;
	if (current === null && fs.existsSync(link)) return; // a real file of yours: leave it
	try {
		fs.mkdirSync(path.dirname(link), { recursive: true });
		if (current !== null) fs.unlinkSync(link); // an old or dangling vivarium link
		fs.symlinkSync(target, link);
	} catch (e) {
		console.warn("[vivarium] could not link the CLI into ~/.local/bin", e);
	}
}

/** Install (or remove) the skill. Returns the folders changed. */
export function syncSkill(on: boolean): string[] {
	const changed: string[] = [];
	for (const dir of skillDirs()) {
		const ours = fs.existsSync(path.join(dir, MARKER));
		try {
			if (on) {
				if (fs.existsSync(dir) && !ours) continue; // someone else's skill called vivarium: leave it
				const a = writeIfChanged(path.join(dir, "SKILL.md"), SKILL);
				writeIfChanged(path.join(dir, MARKER), "This folder is managed by the Vivarium Obsidian plugin.\n");
				if (a) changed.push(dir);
			} else if (ours) {
				fs.rmSync(dir, { recursive: true, force: true });
				changed.push(dir);
			}
		} catch (e) {
			console.warn("[vivarium] skill", dir, e);
		}
	}
	return changed;
}

export function syncCodexRules(on: boolean) {
	const file = path.join(os.homedir(), ".codex", "rules", "vivarium.rules");
	try {
		if (on) writeIfChanged(file, CODEX_RULES);
		else if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("Written by the Vivarium plugin")) fs.unlinkSync(file);
	} catch (e) {
		console.warn("[vivarium] codex rules", e);
	}
}

/** Linux: whether systemd keeps this user's services running after logout (`loginctl enable-linger`). null = can't tell. */
export function lingerEnabled(): boolean | null {
	const user = os.userInfo().username;
	if (!fs.existsSync("/var/lib/systemd/linger")) return null;
	return fs.existsSync(`/var/lib/systemd/linger/${user}`);
}
