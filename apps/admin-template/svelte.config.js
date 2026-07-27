import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Base path for the static build. Empty for the Tauri desktop app and the
// LAN embedded-server (both serve at the site root). Set `BASE_PATH` (e.g.
// `/banto`) only for the GitHub Pages **project site** demo build, which is
// served under `https://<user>.github.io/<repo>/`.
const base = process.env.BASE_PATH ?? '';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		paths: { base },
		// Tauri has no SSR server: static build with SPA fallback (spec §8.1).
		// `index.html` serves as the SPA fallback for all three targets (Tauri
		// asset protocol, LAN `static_router`, and the Pages root). For the
		// GitHub Pages project site, the demo workflow additionally copies
		// `index.html` -> `404.html` so deep links (e.g. `/banto/items`) that
		// Pages routes to `404.html` load the same SPA.
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			fallback: 'index.html'
		})
	}
};

export default config;
