import esbuild from "esbuild";
import { builtinModules } from "node:module";
import fs from "fs";

const prod = process.argv[2] === "production";
// Output straight into the dev vault so a rebuild + plugin reload is the whole loop.
const outdir = "dev-vault/.obsidian/plugins/vivarium";
fs.mkdirSync(outdir, { recursive: true });

const ctx = await esbuild.context({
	entryPoints: { main: "src/main.ts", styles: "src/styles.css" },
	bundle: true,
	external: ["obsidian", "electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	loader: { ".md": "text" },
	outdir,
	// Credits for what's bundled (MIT requires keeping the notices with the code).
	banner: {
		js: "/* Vivarium, MIT License. Includes xterm.js, @xterm/addon-fit and @xterm/addon-web-links: MIT License, Copyright (c) 2017-2019 The xterm.js authors, (c) 2014-2016 SourceLair Private Company, (c) 2012-2013 Christopher Jeffrey. See THIRD_PARTY_NOTICES.md in the source repository. */",
	},
	plugins: [
		{
			// The CLI (a plain Node script without a file ending) goes into main.js as text: an install
			// from the community directory only contains main.js, manifest.json and styles.css.
			name: "cli-as-text",
			setup(b) {
				b.onLoad({ filter: /[\\/]bin[\\/]vivarium$/ }, (a) => ({ contents: fs.readFileSync(a.path, "utf8"), loader: "text" }));
			},
		},
		{
			name: "copy-manifest",
			setup(b) {
				b.onEnd(() => fs.copyFileSync("manifest.json", `${outdir}/manifest.json`));
			},
		},
	],
});
if (prod) { await ctx.rebuild(); await ctx.dispose(); } else { await ctx.watch(); }
