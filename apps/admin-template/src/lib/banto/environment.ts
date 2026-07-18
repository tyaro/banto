/**
 * Environment detection for the three spec §11.1 runtime environments
 * (Tauri webview / embedded-server LAN browser / plain vite dev-preview).
 * Pure detection only - which providers get wired as a RESULT of these
 * checks lives in setup.ts (the composition root). Split out of setup.ts
 * (improvement-plan-2026-07.md P3-4) so app authors editing resources never
 * scroll through probe internals. Import these via `./setup` (which
 * re-exports them) unless you are setup.ts itself - keeping one public
 * entry point for the app.
 */

/** True inside the Tauri webview, false in a plain browser tab (spec §11.1). */
export function isTauri(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Shared with the `*Admin.ts` modules (spec M10's `/api/users/*` calls need the same CSRF header every other fetch() here sends). */
export const CSRF_HEADER = { 'X-Banto-Client': 'banto' } as const;

/**
 * Is this plain-browser tab being served by the embedded Banto server
 * (`banto-server`/`admin-template-core::rest`, spec §11.1), as opposed to a
 * bare `vite dev`/`vite preview` tab with no Banto backend at all? Probed by
 * calling the one `/api` route that needs no auth token
 * (`GET /api/auth/check`): any HTTP response at all (`200` with a boolean
 * body when unauthenticated/authenticated, or an unexpected `401`/`403`)
 * means an `/api/*` route answered on the other end. A network error (no
 * server listening) or anything that isn't a plain HTTP response (e.g.
 * `vite dev`'s dev server 404ing with an HTML page for an unknown path)
 * means this is not our server. Never true inside Tauri - `isTauri()` is
 * checked first there and takes priority.
 */
export async function isEmbeddedServer(): Promise<boolean> {
	if (isTauri()) return false;
	try {
		const response = await fetch(`${location.origin}/api/auth/check`, { headers: CSRF_HEADER });
		return response.status === 200 || response.status === 401;
	} catch {
		return false;
	}
}
