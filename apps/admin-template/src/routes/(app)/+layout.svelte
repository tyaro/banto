<script lang="ts">
	import { untrack } from 'svelte';
	import { goto, invalidateAll, onNavigate } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { getSessionController, notify, onInvalidate } from '@banto/admin-core';
	import { hasUnsavedChanges } from '@banto/forms';
	import * as m from '$lib/paraglide/messages';
	import { guardWindowClose } from '$lib/banto/windowCloseGuard';
	import { isLeavingForLogin, leaveForLogin } from '$lib/banto/logout.svelte';
	import { OWNER_CHANGE_POLICY, watchOwnerChanges } from '$lib/banto/ownerChange';
	import { isNavigationSettled } from '$lib/banto/navigationSettled.svelte';
	import Header from '$lib/components/Header.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import { commandPaletteStore } from '$lib/commandPalette.svelte';
	import { watchRecentCommandOwner } from '$lib/recentCommands';
	import { navItems } from '$lib/navigation';
	import { navBadges } from '$lib/navBadges.svelte';

	let { children, data } = $props();

	// Issue #215/#255 (4th review): a page belongs to the session it was
	// built for. When the session ends or its owner changes while a page is
	// open (a revocation followed by the automatic move to the public viewer,
	// another identity confirmed on a guard re-run), SvelteKit re-runs the
	// loads but keeps the SAME page component - its in-memory state (a
	// list's search terms and sort, the highlighted row, a detail form's
	// unsaved input) would survive into the next session and could even be
	// saved back on its behalf. So the page is shown only while the session
	// generation its loads confirmed (`data.sessionGeneration`, from
	// `+layout.ts`) is still the live one, and is rebuilt from scratch
	// (`{#key}`) once the next session's loads complete. Between the end of
	// one session and those loads (a moment, until the guard redirects or
	// confirms the next identity) nothing of the old page is on screen. A
	// guard re-run that confirms the same session keeps the generation, so an
	// ordinary `invalidateAll()` never rebuilds the page.
	//
	// Issue #290: the key also carries the route params. SvelteKit reuses the
	// page component for a move between two URLs of the SAME route (items/1 ->
	// items/2: only its `params` update), so a page that reads its id once at
	// setup (the items detail page) would keep the previous record's form,
	// attachments and save target under the new URL. A new param value is a
	// new page. The params of different routes never coincide, and a move to
	// another route already rebuilds the page, so this only adds the
	// same-route/other-id case.

	// Issue #214: while any page's unsaved-changes guard is pending, also
	// ask before the desktop window closes. Watched only while something is
	// unsaved - see windowCloseGuard.ts's doc comment for why (no-op outside
	// Tauri). `$derived` so the effect re-runs only when the boolean flips,
	// not on every keystroke that re-evaluates a form's `isDirty`.
	const unsaved = $derived(hasUnsavedChanges());
	$effect(() => {
		if (!unsaved) return;
		return guardWindowClose(hasUnsavedChanges, () => m['unsaved.confirmClose']());
	});

	// Issue #260 (design §6.1 wiring ①, since 実装-2): whenever the session
	// controller's generation differs from the one this page's load confirmed,
	// re-run the loads (`invalidateAll()`), which confirm the session again
	// and send the screen to /login, a publicViewer grant session, the retryable
	// error page, or the rebuilt page of the (new) user. This covers every
	// way the generation moves - a background revocation confirmed `none`
	// (Issue #241, formerly `onSessionEnded`), an ending confirmed before this
	// layout mounted (S-34/S-74: checked on mount), and another tab's login
	// that goes unknown -> active without ever passing `none` (S-79, and the
	// same user again, S-80). `requestedFor` keeps one invalidation per
	// generation (a load that confirms the same generation again, or a slow
	// one, does not stack them). The login target is a forced navigation for
	// the unsaved-changes guard (`$lib/unsavedChanges.ts`).
	// While this tab is logging out (or leaving for /login under the
	// 'relogin' policy below), no re-load: that sequence goes to /login
	// itself, and an invalidation started here would win over the navigation
	// (`$lib/banto/logout.svelte.ts`). `isLeavingForLogin()` is reactive, so a
	// generation change skipped meanwhile is handled once it ends if the
	// layout is still mounted (another session was confirmed instead, or the
	// logout could not be confirmed).
	// Issue #326: nor while a navigation is in flight (another tab's login or
	// a background revocation can land in the middle of one, and this layout
	// is mounted at the end of one). An `invalidateAll()` started then makes
	// SvelteKit abort the navigation - the user's move is lost - and skip
	// `beforeNavigate`, the unsaved-changes guard, afterwards
	// (`$lib/banto/navigationSettled.svelte.ts`). `isNavigationSettled()` is
	// reactive too: once the navigation completes, this compares the
	// generation ITS load confirmed and re-runs only if that one is stale.
	const sessionController = getSessionController();
	let requestedFor = -1;
	$effect(() => {
		const generation = sessionController.snapshot.generation;
		if (isLeavingForLogin()) return;
		if (!isNavigationSettled()) return;
		if (generation !== data.sessionGeneration && requestedFor !== generation) {
			requestedFor = generation;
			void invalidateAll();
		}
	});

	// Issue #260 (実装-3, design §6.1 wiring ②, #257): another tab logged in
	// as a different user. The controller keeps the change until it is
	// handled (`snapshot.pendingOwnerChange`), so a change confirmed while
	// this layout was not mounted (the 503 page in between, S-81) is
	// reported on mount; a confirmed `none` discards it (S-83). Wiring ①
	// already rebuilds the screen for the new user; this only tells them (or,
	// with `'relogin'`, sends them to /login). The shared token is never
	// cleared here (I-17). Wiring ③ - a confirmation that fails after the
	// switch - is the load's 503 (`+layout.ts`): not left automatically
	// (S-36/S-60).
	// `untrack`: runs once per mount (the subscription does the rest), not
	// again on every snapshot this reads.
	$effect(() =>
		untrack(() =>
			watchOwnerChanges(sessionController, {
				policy: OWNER_CHANGE_POLICY,
				notify: (policy) =>
					notify(
						'info',
						policy === 'relogin' ? m['session.ownerChangedRelogin']() : m['session.ownerChanged']()
					),
				goToLogin: () => leaveForLogin(() => goto(`${base}/login`))
			})
		)
	);

	// Command palette history is per user (#258): dropped on a confirmed
	// `none`, and another owner's entry dropped once an owner is confirmed
	// (the same hygiene the controller does for the list view state). The
	// owner check on read is the safety boundary; this only avoids lingering.
	$effect(() => untrack(() => watchRecentCommandOwner(sessionController)));

	// Nav badge wiring (see $lib/navBadges.svelte.ts's doc comment for the
	// ownership split). Subscribed once for the app shell's lifetime; the
	// handler reads `page.url.pathname` non-reactively at event time - an
	// invalidation for the resource of the page currently on screen is not
	// an "unseen" change (the page's own list resource refetches it live),
	// so it never increments. A reconnect 'resync' (#289) is no known change
	// either and never increments.
	$effect(() => {
		const unsubscribes = navItems
			.filter((item) => item.badgeResource !== undefined)
			.map((item) =>
				onInvalidate(item.badgeResource as string, (_resource, reason) =>
					navBadges.noteInvalidation(item.path, page.url.pathname, reason)
				)
			);
		return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
	});

	// Landing on a page marks its nav entry's changes as seen. `untrack`
	// keeps `pathname` as this effect's only dependency (conventions §8):
	// `clearFor` both reads and writes the store's count map, which would
	// otherwise re-trigger this effect on every badge increment.
	$effect(() => {
		const pathname = page.url.pathname;
		untrack(() => navBadges.clearFor(pathname));
	});

	// View Transitions on page navigation (design.md §11.1). The
	// startViewTransition existence check is the only branch - unsupporting
	// browsers (older LAN clients) fall through to SvelteKit's normal instant
	// swap. Also skipped under prefers-reduced-motion, on top of the token
	// mechanism in banto.css that already zeroes --banto-duration-* there
	// (belt and suspenders: this skips starting a transition at all, rather
	// than starting one that resolves to a 0ms crossfade).
	onNavigate((navigation) => {
		if (!document.startViewTransition) return;
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});

	// <=900px sidebar overlay (visual-refresh-design.md §8.1). Local state
	// here (not a new global store, per the design doc) - passed down to
	// Sidebar/Header as props. Distinct from `settings.sidebarCollapsed`
	// (the >900px fold), which is a persisted, unrelated setting.
	let overlayOpen = $state(false);

	function closeOverlay(): void {
		overlayOpen = false;
	}

	function toggleOverlay(): void {
		overlayOpen = !overlayOpen;
	}

	// Close on navigation success (design.md §8.1). `page.url.pathname` is
	// reactive via $app/state; this effect fires whenever it changes,
	// including the no-op case where the overlay is already closed.
	$effect(() => {
		// Bare read registers `pathname` as this effect's dependency.
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		page.url.pathname;
		closeOverlay();
	});

	// Ctrl+K / Cmd+K (spec M16): a global toggle registered here (the app
	// shell), not inside CommandPalette itself - it must keep working to
	// CLOSE the palette while focus is inside its own search input (or any
	// other input/textarea on the page), which a listener scoped to just the
	// palette component couldn't do once it's unmounted.
	//
	// Escape also closes the sidebar overlay here (design.md §8.1), unless
	// the command palette is open - that owns Escape itself while visible.
	function handleKeydown(event: KeyboardEvent): void {
		if (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			commandPaletteStore.toggle();
			return;
		}
		if (event.key === 'Escape' && overlayOpen && !commandPaletteStore.open) {
			closeOverlay();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="shell">
	<Sidebar {overlayOpen} />
	{#if overlayOpen}
		<button
			type="button"
			class="overlay-backdrop"
			aria-label={m['shell.closeSidebar']()}
			onclick={closeOverlay}
		></button>
	{/if}
	<div class="main">
		<Header {overlayOpen} onToggleOverlay={toggleOverlay} />
		<main>
			{#if data.sessionGeneration === sessionController.snapshot.generation}
				{#key `${data.sessionGeneration}:${JSON.stringify(page.params)}`}
					{@render children()}
				{/key}
			{/if}
		</main>
	</div>
</div>

{#if commandPaletteStore.open}
	<CommandPalette />
{/if}

<style>
	.shell {
		display: flex;
		min-height: 100vh;
	}

	.main {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	main {
		flex: 1;
		padding: 1.25rem;
	}

	.overlay-backdrop {
		display: none;
	}

	@media (max-width: 900px) {
		.overlay-backdrop {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 850;
			margin: 0;
			padding: 0;
			border: none;
			cursor: default;
			/* No --banto-* scrim token exists (out of this unit's scope to add
			   one to packages/theme) - matches CommandPalette.svelte's existing
			   overlay backdrop value exactly, a dimming film that intentionally
			   stays black in both themes rather than tracking --banto-text
			   (which is near-white in dark mode). */
			background: rgb(0 0 0 / 0.35);
		}
	}
</style>
