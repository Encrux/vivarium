import esbuild from "esbuild";
import builtins from "builtin-modules";
import fs from "fs";

const prod = process.argv[2] === "production";
// Output straight into the dev vault so a rebuild + plugin reload is the whole loop.
const outdir = "dev-vault/.obsidian/plugins/vivarium";
fs.mkdirSync(outdir, { recursive: true });

const ctx = await esbuild.context({
	entryPoints: { main: "src/main.ts", styles: "src/styles.css" },
	bundle: true,
	external: ["obsidian", "electron", ...builtins],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	loader: { ".md": "text" },
	outdir,
	plugins: [{
		name: "copy-manifest",
		setup(b) { b.onEnd(() => {
			fs.copyFileSync("manifest.json", `${outdir}/manifest.json`);
			fs.copyFileSync("bin/vivarium", `${outdir}/vivarium`);
			fs.chmodSync(`${outdir}/vivarium`, 0o755);
			fs.copyFileSync("skill/SKILL.md", `${outdir}/SKILL.md`);
			const mac = "helper/macos/.build/release/vivarium-helper";
			if (fs.existsSync(mac)) {
				// Replace, never overwrite in place: macOS caches code signatures per file and
				// SIGKILLs a binary whose bytes changed under it ("Code Signature Invalid").
				const dst = `${outdir}/vivarium-helper-macos`, tmp = `${dst}.tmp`;
				fs.copyFileSync(mac, tmp);
				fs.renameSync(tmp, dst);
			}
			// Linux helper (built by scripts/update.sh or `npm run build:helper-linux`), named per arch.
			const linux = "helper/linux/target/release/vivarium-helper-linux";
			if (process.platform === "linux" && fs.existsSync(linux)) {
				// Replace, never overwrite in place: a running daemon has the old file open (ETXTBSY).
				const dst = `${outdir}/vivarium-helper-linux-${process.arch}`, tmp = `${dst}.tmp`;
				fs.copyFileSync(linux, tmp);
				fs.chmodSync(tmp, 0o755);
				fs.renameSync(tmp, dst);
			}
		}); },
	}],
});
if (prod) { await ctx.rebuild(); await ctx.dispose(); } else { await ctx.watch(); }
