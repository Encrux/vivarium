/**
 * Agent integration (opt-in: Settings → Coding agents, or the one-time prompt). Coding agents in
 * tiles (Codex, Claude Code, anything that runs shell commands) can then use the `vivarium` CLI:
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
import SKILL_MD from "../skill/SKILL.md";
// @ts-ignore: bundled as text by esbuild (see esbuild.config.mjs)
import CLI from "../bin/vivarium";

const SKILL = SKILL_MD as string;
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
	} catch {
			// best effort
		}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, mode ? { mode } : undefined);
	if (mode) fs.chmodSync(file, mode);
	return true;
}

const LOCAL_LINK = path.join(os.homedir(), ".local", "bin", "vivarium");

/** Put the CLI where every tile finds it (its folder goes first on each tile's PATH). */
export function installCli() {
	writeIfChanged(path.join(BIN_DIR, "vivarium.js"), CLI as string);
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
	const target = path.join(BIN_DIR, "vivarium");
	let current: string | null = null;
	try {
		current = fs.readlinkSync(LOCAL_LINK);
	} catch {
			// best effort
		}
	if (current === target) return;
	if (current === null && fs.existsSync(LOCAL_LINK)) return; // a real file of yours: leave it
	if (current !== null && !current.includes("vivarium")) return; // a link of yours to something else
	try {
		fs.mkdirSync(path.dirname(LOCAL_LINK), { recursive: true });
		if (current !== null) fs.unlinkSync(LOCAL_LINK); // an old or dangling vivarium link
		fs.symlinkSync(target, LOCAL_LINK);
	} catch (e) {
		console.warn("[vivarium] could not link the CLI into ~/.local/bin", e);
	}
}

/** Remove the CLI and our ~/.local/bin link (never a file of yours with the same name). */
export function removeCli() {
	try {
		if (fs.readlinkSync(LOCAL_LINK) === path.join(BIN_DIR, "vivarium")) fs.unlinkSync(LOCAL_LINK);
	} catch {
			// best effort
		}
	fs.rmSync(BIN_DIR, { recursive: true, force: true });
}

/** Turn the whole agent integration on or off: CLI, skill, and (if wanted) the Codex rule. */
export function syncAgentIntegration(on: boolean, codexRules: boolean): string[] {
	try {
		if (on) installCli();
		else removeCli();
	} catch (e) {
		console.warn("[vivarium] CLI", e);
	}
	syncCodexRules(on && codexRules);
	return syncSkill(on);
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
		const theirs = fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes("Written by the Vivarium plugin");
		if (on && !theirs) writeIfChanged(file, CODEX_RULES);
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
