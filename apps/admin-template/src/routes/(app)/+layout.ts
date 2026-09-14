import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { getAuthProvider } from '@banto/admin-core';
import { bantoReady } from '$lib/banto/setup';
import { syncLocaleFromProvider } from '$lib/banto/locale';
import { sessionStore } from '$lib/session.svelte';
import { settings } from '$lib/settings.svelte';
import { publicNavItems } from '$lib/navigation';

// Auth guard for the whole (app) group (spec §8.1), backed by
// AuthProvider.check() (spec §3.3). Must wait for provider
// selection/detection (spec §11.1's three-way environment probe) to finish
// before getAuthProvider() is safe to call.
//
// M10 RBAC: also populates `sessionStore` (identity + role) here, right
// after the session is confirmed valid, so every page/component under (app)
// can read `sessionStore.role` synchronously - see session.svelte.ts's doc
// comment for the ordering guarantee this relies on.
//
// viewer-public-plan §3.1-6 (ADR-0012): when there is no valid session at
// all, a LAN client is not immediately bounced to /login anymore - if
// `server.viewerPublic` is ON, `enterPublicViewer()` mints the synthetic
// `{id:'public',role:'viewer'}` session over the SAME bearer-token path
// every other session uses (no new auth route, no provider-layer branching -
// conventions §10). Only the HTTP provider implements `status()`'s
// `viewerPublic` field and `enterPublicViewer()`; Tauri/demo leave both
// undefined, so `status?.()`/`enterPublicViewer?.()` fall through to
// `undefined`/`false` there and the guard behaves exactly as before.
export async function load({ url }) {
	await bantoReady;
	const authProvider = getAuthProvider();
	if (!(await authProvider.check())) {
		const status = await authProvider.status?.();
		const entered = status?.viewerPublic ? await authProvider.enterPublicViewer?.() : false;
		if (!entered) {
			redirect(307, `${base}/login`);
		}
	}
	await sessionStore.load();

	// viewer-public-plan §3.1-6: a public-viewer session may only browse the
	// nav allowlist (`navigation.ts`'s `NavItem.publicViewer`) - RBAC's
	// `viewer` role remains the real data-access boundary (ADR-0012 §帰結),
	// this only keeps the SCREEN a bookmarked/typed URL lands on inside the
	// allowed area, same intent as `users/+page.ts`'s own role redirect but
	// applied to every path under (app) at once.
	if (sessionStore.publicViewer) {
		const pathname = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
		const allowed = publicNavItems().some(
			(item) => pathname === item.path || pathname.startsWith(item.path + '/')
		);
		if (!allowed) {
			const firstPublicNavItem = publicNavItems()[0];
			if (firstPublicNavItem) redirect(307, `${base}${firstPublicNavItem.path}`);
		}
	}

	// M12: now that the session is confirmed, pull theme settings from the
	// UiSettingsProvider (settings DB) - a value saved from another
	// client/session beats this tab's localStorage cache. Fire-and-forget:
	// navigation must not wait on (or fail with) a settings read. Locale (ADR-0005)
	// rides the same path with its own key.
	void settings.syncFromProvider();
	void syncLocaleFromProvider();
}
