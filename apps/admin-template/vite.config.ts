import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		// i18n compile (ADR-0005, docs/i18n-plan.md §4.1). Runs on dev/build and
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
	// Fixed port so tauri.conf.json's devUrl always matches.
	server: {
		port: 1420,
		strictPort: true
	},
	clearScreen: false
});
