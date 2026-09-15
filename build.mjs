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
 * platform seeds (`react`, `react/jsx-runtime`, `@deepseek-ai/dsh-client-ui-primitives`).
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
const hostEntries = [
	["src/index.ts", "lib/index.js"],
	["src/store/index.ts", "lib/store.js"],
	["src/persona/index.ts", "lib/persona.js"],
	["src/skills/index.ts", "lib/skills.js"],
	["src/skills-agent/index.ts", "lib/skills-agent.js"],
	["src/telegram/index.ts", "lib/telegram.js"],
];

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

/**
 * The `__ModuleLoader__` envelope.
 *
 * The CJS body esbuild emits lands *inside* the factory, so the `require` it
 * calls for the externals is the factory's own parameter — the loader's resolver
 * for platform seeds — and `module`/`exports` are function-local. Nothing but
 * the single `load(...)` call is left at the top level of the artifact.
 */
const banner = `window.__ModuleLoader__.load({
	id: "dsh-buddy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;`;

const footer = `		return module.exports;
	}
});`;

await build({
	entryPoints: ["src/client/index.tsx"],
	outfile: "lib/client.js",
	bundle: true,
	format: "cjs",
	platform: "browser",
	target: "es2022",
	jsx: "automatic",
	// The shared UI kit is a platform seed too: bundling a copy would give
	// look-alike buttons instead of the harness's own.
	external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"],
	banner: { js: banner },
	footer: { js: footer },
	logLevel: "info",
});
