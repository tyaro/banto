<script lang="ts">
	import { onNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import Header from '$lib/components/Header.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import { commandPaletteStore } from '$lib/commandPalette.svelte';

	let { children } = $props();

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
			aria-label="サイドバーを閉じる"
			onclick={closeOverlay}
		></button>
	{/if}
	<div class="main">
		<Header {overlayOpen} onToggleOverlay={toggleOverlay} />
		<main>
			{@render children()}
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
