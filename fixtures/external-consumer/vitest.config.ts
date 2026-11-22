import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

// `@banto/charts/testing`（#852）を、外部の派生アプリと同じ経路（Git 依存）で
// 読む試験の設定。`@banto/*` はソース（.svelte / .ts）で配布されるので、vitest に
// 外部化させず変換させる（`server.deps.inline`）。README の設定と同じ形。
export default defineConfig({
	plugins: [svelte(), svelteTesting()],
	test: {
		environment: 'jsdom',
		include: ['tests/**/*.test.ts'],
		server: { deps: { inline: [/@banto\//] } }
	}
});
