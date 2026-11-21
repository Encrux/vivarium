// Obsidian's own lint rules (the community directory's automated review checks the same).
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	globalIgnores(["node_modules", "dev-vault", "scripts", "bin", "esbuild.config.mjs", "eslint.config.mjs", "**/*.js"]),
	...obsidianmd.configs.recommended,
	{ languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
]);
