<script lang="ts">
	import '../app.css';
	import * as m from '$lib/paraglide/messages';
	import { bantoReady } from '$lib/banto/setup'; // initBanto() (+ EventProvider) before any route guard runs (spec §3, §11.1)
	import { initLocale } from '$lib/banto/locale'; // registers the Paraglide client strategy + syncs <html lang> (ADR-0005)
	import { settings } from '$lib/settings.svelte';
	import ToastHost from '$lib/components/ToastHost.svelte';

	let { children } = $props();

	// Start theme handling (applies persisted mode, watches OS changes) and sync
	// <html lang> to the persisted locale (ADR-0005; the strategy itself is
	// registered at locale.ts import time, above, before any message renders).
	$effect(() => {
		settings.init();
		initLocale();
	});
</script>

{#await bantoReady}
	<p class="banto-splash">{m['app.starting']()}</p>
{:then}
	{@render children()}
	<ToastHost />
{/await}

<style>
	.banto-splash {
		min-height: 100vh;
		display: grid;
		place-items: center;
		color: var(--banto-text-muted);
	}
</style>
