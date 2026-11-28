/**
 * The one Node call a test of this package makes (row-tone-contrast.test.ts
 * reads the theme's CSS and BantoGrid.svelte as text). The package has no
 * `@types/node` on purpose (the library itself is browser code), so the
 * signature is declared here instead of adding a dependency.
 */
declare module 'node:fs' {
	export function readFileSync(path: URL, encoding: 'utf8'): string;
}
