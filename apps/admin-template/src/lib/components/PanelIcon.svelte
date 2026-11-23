<script lang="ts">
	import type { Component } from 'svelte';
	import {
		ChartBar,
		ChartColumn,
		ChartColumnStacked,
		ChartLine,
		ChartNoAxesCombined,
		ChartPie,
		ChartScatter,
		NotepadText
	} from '@lucide/svelte';

	let { icon, size = 16 }: { icon: string; size?: number } = $props();

	// Dock layouts persist icon strings. Resolve older emoji values as well so
	// previously saved layouts switch to the same line icons without migration.
	const ICONS: Record<string, Component> = {
		monthly: ChartLine,
		'📈': ChartLine,
		categoryStock: ChartBar,
		stackedBar: ChartColumnStacked,
		priceBuckets: ChartPie,
		'🥧': ChartPie,
		scatter: ChartScatter,
		spc: ChartColumn,
		'📊': ChartColumn,
		trend: ChartNoAxesCombined,
		'📉': ChartNoAxesCombined,
		memo: NotepadText,
		'📝': NotepadText
	};
	const Icon = $derived(Object.hasOwn(ICONS, icon) ? ICONS[icon] : undefined);
</script>

{#if Icon}
	<Icon {size} aria-hidden="true" />
{:else}
	<span aria-hidden="true">{icon}</span>
{/if}
