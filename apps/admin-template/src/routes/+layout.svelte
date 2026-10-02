<script lang="ts">
	import '../app.css';
	import { bantoReady } from '$lib/banto/setup'; // initBanto() (+ EventProvider) before any route guard runs (spec §3, §11.1)
	import { initLocale } from '$lib/banto/locale'; // registers the Paraglide client strategy + syncs <html lang> (ADR-0005)
	import { settings } from '$lib/settings.svelte';
	import ToastHost from '$lib/components/ToastHost.svelte';
	import StartupSplash from '$lib/components/StartupSplash.svelte';

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
	<StartupSplash />
{:then}
	{@render children()}
	<ToastHost />
{/await}
