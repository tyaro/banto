/**
 * Server hooks. The app has no server at run time (`ssr = false`, adapter-static, spec §8.1):
 * this runs only where SvelteKit renders the empty SPA shell from `app.html` - once at build
 * time for the `index.html` fallback, and per request under `vite dev`.
 *
 * Its job (Issue #1024): fill app.html's `%banto.locales%` (the locale list and the fallback
 * locale, for the first script) and `%banto.bootStatus%` with the "loading" wording of
 * every locale, taken from the dictionary through Paraglide (conventions §13), as a JSON object
 * keyed by locale. app.html's inline script picks the entry for `<html lang>` before the app's
 * script has loaded, which is why the wording cannot come from the client bundle. A locale
 * added to `project.inlang` is picked up here without touching this file.
 */
import type { Handle } from '@sveltejs/kit/hooks';
import * as m from '#lib/paraglide/messages.js';
import { baseLocale, locales } from '#lib/paraglide/runtime.js';

const BOOT_STATUS = '%banto.bootStatus%';
const LOCALES = '%banto.locales%';

/** The display locale a visitor with nothing usable stored gets: 'ja' (ADR-0005), else the base locale. */
const fallback = (locales as readonly string[]).includes('ja') ? 'ja' : baseLocale;

/** Escape for a double-quoted HTML attribute value. */
function escapeAttribute(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

const bootStatus = escapeAttribute(
	JSON.stringify(
		Object.fromEntries(locales.map((locale) => [locale, m['common.loading']({}, { locale })]))
	)
);

const localeList = escapeAttribute(JSON.stringify({ locales, fallback }));

export const handle: Handle = ({ event, resolve }) =>
	resolve(event, {
		// A function replacement: the wording is not a `$`-pattern.
		transformPageChunk: ({ html }) =>
			html.replace(BOOT_STATUS, () => bootStatus).replace(LOCALES, () => localeList)
	});
