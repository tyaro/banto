import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Minimal config: only what `vitest` needs (spec §9: Vitest for logic-layer tests).
// Same shape as the other packages, so a later `.svelte.ts` (ADR-0020 §6) needs no change here.
export default defineConfig({
	plugins: [svelte()],
	test: {
		environment: 'node'
	}
});
