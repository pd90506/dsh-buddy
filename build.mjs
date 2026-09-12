/**
 * Build every half.
 *
 * Host rows are bundled to `lib/<row>.js` as ESM with every `@deepseek-ai/*`
 * dependency left external, so the plugin shares the harness's own copies of the
 * settings, storage and typert services rather than loading a second one —
 * module identity is load-bearing for the typert registry and the domain spec.
 *
 * The browser half is bundled to `lib/client.js` in dsh's `__ModuleLoader__`
 * factory format: a CJS body wrapped in a factory whose `require` resolves
 * platform seeds (`react`, `react/jsx-runtime`).
 *
 * DSH transforms nothing it loads, so TypeScript and JSX must both be gone by
 * the time the artifacts land.
 */
import { build } from "esbuild";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { dependencies = {}, peerDependencies = {} } = require("./package.json");

/** Runtime deps stay external so the harness supplies one shared copy. */
const hostExternal = [...Object.keys(dependencies), ...Object.keys(peerDependencies), "node:*"];

/**
 * Host entries. Each row is its own artifact so a profile can disable one
 * without loading the other. Tasks 3 and 6 append to this list as the rows
 * are written; it is deliberately explicit rather than a directory scan, so a
 * mistyped path fails the build instead of silently producing no artifact.
 */
const hostEntries = [["src/index.ts", "lib/index.js"]];

for (const [entry, outfile] of hostEntries) {
	await build({
		entryPoints: [entry],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		external: hostExternal,
		logLevel: "info",
	});
}
