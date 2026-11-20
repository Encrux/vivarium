/**
 * Firefox in a Linux app tile.
 *
 * Firefox is single-instance per profile: started with your desktop profile while your desktop
 * Firefox runs, it would just ask that Firefox to open a window (on your desktop, not in the tile)
 * and exit. So Firefox in a tile always runs with its own, clean, Vivarium-owned profile and with
 * `--no-remote`: it never talks to your desktop Firefox, and your desktop Firefox never hands its
 * windows to it. Nothing is copied from your profile. Logins you make inside the tile stay in the
 * tile's profile; its tabs come back when the tile does (session restore is on there).
 *
 * The profile has to be where that kind of Firefox can read and write: a snap only sees non-hidden
 * folders of your home and its own folder, a flatpak only its own data folder.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { VivariumCore } from "./core";
import { setLaunchHook } from "./linuxwindow";

export type FirefoxKind = "snap" | "flatpak" | "native";
const FLATPAK_ID = "org.mozilla.firefox";

/** Is this desktop entry id a Firefox? */
export function isFirefox(desktopId: string): boolean {
	return /^(firefox(-esr)?|firefox_firefox|org\.mozilla\.firefox)$/i.test(desktopId.replace(/\.desktop$/, ""));
}

export function firefoxKind(desktopId: string, exec = ""): FirefoxKind {
	const id = desktopId.replace(/\.desktop$/, "");
	if (id === FLATPAK_ID || /flatpak\s+run/.test(exec)) return "flatpak";
	if (id === "firefox_firefox" || /\/snap\/bin\//.test(exec)) return "snap";
	return "native";
}

/** The Vivarium profile for this kind of Firefox. */
export function profileDir(kind: FirefoxKind, home = os.homedir()): string {
	if (kind === "snap") return path.join(home, "snap/firefox/common/vivarium-profile");
	if (kind === "flatpak") return path.join(home, ".var/app", FLATPAK_ID, "vivarium-profile");
	return path.join(home, ".vivarium/firefox-profile");
}

/** Preferences of the Vivarium profile (user.js wins over prefs.js at each start). */
const USER_JS = `// Written by Vivarium for the Firefox in your tiles; rewritten at every start.
user_pref("browser.startup.page", 3); // reopen the tabs you had
user_pref("browser.sessionstore.resume_from_crash", true);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.warnOnQuit", false);
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
`;

/** How to start Firefox for a tile: its own profile (created on first use), never remoting. */
export function firefoxLaunch(desktopId: string, exec: string, tileId: string, home = os.homedir()): { argv: string[]; env: Record<string, string>; profile: string } {
	const kind = firefoxKind(desktopId, exec);
	const profile = profileDir(kind, home);
	fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(profile, "user.js"), USER_JS);
	const args = ["--no-remote", "--profile", profile];
	const env = { VIVARIUM_TILE: tileId };
	if (kind === "flatpak") return { argv: ["flatpak", "run", `--env=VIVARIUM_TILE=${tileId}`, FLATPAK_ID, ...args], env, profile };
	if (kind === "snap") return { argv: [fs.existsSync("/snap/bin/firefox") ? "/snap/bin/firefox" : "firefox", ...args], env, profile };
	return { argv: [/esr/i.test(desktopId) ? "firefox-esr" : "firefox", ...args], env, profile };
}

/** Make Firefox tiles start this way (Linux). */
export function installFirefoxLaunch(core: VivariumCore) {
	let apps: Promise<{ desktopId: string; exec: string }[]> | null = null;
	setLaunchHook((spec) => {
		if (!isFirefox(spec.app.bundleId)) return null;
		return (async () => {
			apps ??= core.helper!.request("list_apps").then((r) => r.apps).catch(() => []);
			const exec = (await apps!).find((a) => a.desktopId === spec.app.bundleId)?.exec ?? "";
			const ff = firefoxLaunch(spec.app.bundleId, exec, spec.id);
			return { argv: ff.argv, env: ff.env };
		})();
	});
}
