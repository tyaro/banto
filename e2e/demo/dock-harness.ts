/**
 * Shared harness for the `ThreePaneDock` specs on /tree/workspace-dock (`dock-persistent-*`):
 * the module URLs the spec imports through the dev server's `/@fs/` (the `demo` project runs
 * `vite dev`).
 */
import type { Page } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dockDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../packages/dock-svelte'
);
const svelteDir = path.dirname(
	createRequire(path.join(dockDir, 'package.json')).resolve('svelte/package.json')
);
const fsUrl = (file: string): string => `/@fs/${file.replaceAll('\\', '/').replace(/^\//, '')}`;

const SOURCE_URLS = {
	dock: fsUrl(path.join(dockDir, 'src/index.ts')),
	svelte: fsUrl(path.join(svelteDir, 'src/index-client.js'))
};

export interface DockUrls {
	dock: string;
	svelte: string;
}

/**
 * The package's entry and `svelte` as the app's own imports resolve them. `svelte` must be the
 * SAME runtime instance the dock's compiled components use, or a raw snippet rendered later (a
 * tab's content re-created by a switch or `resetLayout`) runs outside that runtime's effects and
 * throws `Cannot read properties of null (reading 'nodes')`: the dev server pre-bundles `svelte`
 * (`/node_modules/.vite/deps/svelte.js?v=...`), so the page looks that URL up among the modules
 * it loaded, and falls back to the source entry where it is not bundled.
 */
export async function dockUrls(page: Page): Promise<DockUrls> {
	const bundled = await page.evaluate(
		() =>
			performance
				.getEntriesByType('resource')
				.map((entry) => entry.name)
				.find((name) => /\/node_modules\/\.vite\/deps\/svelte\.js(\?|$)/.test(name)) ?? null
	);
	return { ...SOURCE_URLS, svelte: bundled ?? SOURCE_URLS.svelte };
}
