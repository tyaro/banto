/**
 * Unseen-change badge counts for sidebar navigation entries
 * (choiapp-feedback-2026-09 §4.1; Svelte 5 runes). Same "module singleton
 * populated by the app shell" pattern as `$lib/settings.svelte.ts` /
 * `$lib/toast.svelte.ts`.
 *
 * Ownership split:
 * - `routes/(app)/+layout.svelte` WIRES the store: it subscribes to
 *   admin-core's `onInvalidate` bus (spec §3.4 - fired both by this
 *   client's own mutations and by `resource_changed` server events, spec
 *   §3.5) for every `NavItem` that declares a `badgeResource`
 *   ($lib/navigation.ts), increments while the user is elsewhere, and
 *   clears a path's count when navigation lands on it.
 * - `Sidebar.svelte` only READS `count(path)` to render the badge.
 *
 * App authors who want a badge on their own nav entry set `badgeResource`
 * on the entry (anything that goes through admin-core's `invalidate()` -
 * form saves, `resource_changed` SSE/Tauri events - feeds it), or call
 * `increment(path)` themselves from any provider-layer code for sources
 * outside the invalidate bus.
 *
 * Deliberately NOT persisted: a badge is a "changed since you last
 * looked in this session" hint, not durable unread state.
 */

/** Matches Sidebar.svelte's `isActive`: `/items` owns `/items` and `/items/...`. */
function pathOwns(navPath: string, pathname: string): boolean {
	return pathname === navPath || pathname.startsWith(navPath + '/');
}

class NavBadgeStore {
	/** Keyed by `NavItem.path`. Missing key = 0 = no badge rendered. */
	#counts = $state<Record<string, number>>({});

	count(path: string): number {
		return this.#counts[path] ?? 0;
	}

	increment(path: string): void {
		this.#counts[path] = (this.#counts[path] ?? 0) + 1;
	}

	/** Clear the badge of the nav entry that owns `pathname` (if any). */
	clearFor(pathname: string): void {
		for (const key of Object.keys(this.#counts)) {
			if (pathOwns(key, pathname)) delete this.#counts[key];
		}
	}
}

export const navBadges = new NavBadgeStore();
export { pathOwns };
