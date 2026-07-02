<script lang="ts">
	import '../app.css';
	import '$lib/banto/setup'; // side-effect: initBanto() before any route guard runs (spec §3)
	import { settings } from '$lib/settings.svelte';
	import ToastHost from '$lib/components/ToastHost.svelte';

	let { children } = $props();

	// Start theme handling (applies persisted mode, watches OS changes).
	$effect(() => {
		settings.init();
	});
</script>

{@render children()}
<ToastHost />
