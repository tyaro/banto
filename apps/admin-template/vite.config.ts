import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		// i18n compile (ADR-0005). Runs on dev/build and
		// (re)generates src/lib/paraglide/ from project.inlang + messages/*.json.
		// `strategy` MUST stay in sync with the `paraglide:compile` script in
		// package.json (used by `pnpm check`, which never runs Vite). `custom-banto`
		// is registered in src/lib/banto/locale.ts and resolves the locale entirely
		// client-side (ja default); `baseLocale` (en) is the server/prerender
		// fallback for the empty adapter-static SPA shell.
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			strategy: ['custom-banto', 'baseLocale'],
			emitTsDeclarations: true
		}),
		sveltekit()
	],
	// `@banto/*` ships source (exports point at `./src/index.ts` and raw
	// `.svelte.ts` runes modules are published as-is; docs/publishing.md,
	// ADR-0007). In a DERIVED app the packages become real node_modules deps
	// (git tag + `path:`), so Vite's dev dependency optimizer (Rolldown)
	// prebundles them - and vite-plugin-svelte's optimizer module path
	// (`compileSvelteModule`) hands `.svelte.ts` straight to
	// `svelte.compileModule` WITHOUT preprocessing, so TS-only syntax like
	// `import type` throws "Unexpected token" (js_parse_error) → HTTP 500
	// (issue #150). Excluding them routes the files through the normal dev
	// transform (Vite core strips the TS, then compile-module's `enforce:'post'`
	// plugin compiles) instead. In THIS repo `@banto/*` resolve to workspace
	// symlinks (realpath outside node_modules), so they are never prebundled and
	// this exclude is a no-op here - it exists for adopters.
	// INVARIANT (docs/conventions.md): every `@banto/*` dep that ships a
	// `.svelte.ts` under src/ MUST be listed here. verify:architecture enforces
	// this. Packages with only `.svelte` components (charts/attachments/report)
	// are fine - those go through the preprocessing path.
	optimizeDeps: {
		exclude: [
			'@banto/admin-core',
			'@banto/dock-svelte',
			'@banto/forms',
			'@banto/grid-svelte',
			'@banto/tree-svelte'
		]
	},
	// Fixed port so tauri.conf.json's devUrl always matches.
	server: {
		port: 1420,
		strictPort: true
	},
	clearScreen: false
});
