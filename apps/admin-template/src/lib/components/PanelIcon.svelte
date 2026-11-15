<script lang="ts">
	import type { Component } from 'svelte';
	import {
		ChartColumn,
		ChartLine,
		ChartNoAxesCombined,
		ChartPie,
		NotepadText
	} from '@lucide/svelte';

	let { icon, size = 16 }: { icon: string; size?: number } = $props();

	// Dock layouts persist icon strings. Resolve older emoji values as well so
	// previously saved layouts switch to the same line icons without migration.
	const ICONS: Record<string, Component> = {
		monthly: ChartLine,
		'📈': ChartLine,
		priceBuckets: ChartPie,
		'🥧': ChartPie,
		spc: ChartColumn,
		'📊': ChartColumn,
		trend: ChartNoAxesCombined,
		'📉': ChartNoAxesCombined,
		memo: NotepadText,
		'📝': NotepadText
	};
	const Icon = $derived(ICONS[icon]);
</script>

{#if Icon}
	<Icon {size} aria-hidden="true" />
{/if}
