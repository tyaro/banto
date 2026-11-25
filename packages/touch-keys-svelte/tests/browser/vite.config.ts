import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Serves the browser fixture page (touch-keypad-design §14.3). The page imports
// `@banto/theme` / `@banto/ui` sources by relative path, so the dev server may read
// the whole workspace.
export default defineConfig({
	root: dirname,
	plugins: [svelte({ configFile: false, preprocess: vitePreprocess() })],
	server: {
		fs: { allow: [path.resolve(dirname, '../../../..')] }
	}
});
