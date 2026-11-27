<script lang="ts">
	/**
	 * The band under the dashboard's heading that shows what the charts' marks chose (#882 C2,
	 * crossfilter-drilldown-design §6.3): one chip per dimension ("カテゴリ: 緑茶 ✕", pressing it takes
	 * that choice off) and "clear all". Drawn ONLY while something is chosen - with nothing chosen
	 * (and in a copy without the charts, where nothing can choose) the page looks as before.
	 *
	 * The drill-down of D3 lives here too: while a price band is the only choice, "open in the list"
	 * goes to the items list on that band with the page's period (`drillHref`). With a category chosen
	 * as well the link is not offered: items has no category column, so the list could not hold the
	 * same rows (design §10 decision 8).
	 *
	 * Shown in kiosk mode too (like the period control: it is not the arrangement, and nothing of it
	 * is saved). Imports no chart package: it stays when `scripts/scaffold.mjs` removes the charts.
	 */
	import { tick } from 'svelte';
	import { Button } from '@banto/ui';
	import { X } from '@lucide/svelte';
	import { DASHBOARD_ROW_LIMIT } from '#lib/banto/dashboardData.svelte.js';
	import { drillHref, type PriceBucketId } from '#lib/banto/dashboardDrill.js';
	import {
		DASHBOARD_DIMENSIONS,
		selectionValueLabel,
		type DashboardDimension,
		type DashboardFilter
	} from '#lib/banto/dashboardPeriod.js';
	import * as m from '#lib/paraglide/messages.js';
	import { formatCount } from '#lib/banto/i18n.js';

	interface Props {
		/** The page's filter: the selection shown here, and the period the list link carries. */
		filter: DashboardFilter;
		/** The newest day in the rows read (`latestDay`): the period of the list link counts from it. */
		anchorDay: string | null;
		/** The read left rows out (`DashboardData.truncated`): the list link says so in its tooltip. */
		truncated?: boolean;
		/** Take one dimension's choice off. */
		onClear: (dimension: DashboardDimension) => void;
		onClearAll: () => void;
		/**
		 * The band went away under the focus (the last choice was taken off from here): the page says
		 * where the focus goes, so a keyboard user is not dropped at the top of the document.
		 */
		onEmptied?: () => void;
	}

	let { filter, anchorDay, truncated = false, onClear, onClearAll, onEmptied }: Props = $props();

	const DIMENSION_LABELS: Record<DashboardDimension, () => string> = {
		category: m['dashboard.dimensionCategory'],
		priceBucket: m['dashboard.dimensionPriceBucket']
	};

	const chips = $derived(
		DASHBOARD_DIMENSIONS.flatMap((dimension) => {
			const value = filter.selection[dimension] ?? '';
			if (value === '') return [];
			return [
				{
					dimension,
					text: m['dashboard.selectionChip']({
						dimension: DIMENSION_LABELS[dimension](),
						value: selectionValueLabel(dimension, value)
					})
				}
			];
		})
	);

	// The list can narrow by a price band (and the period), not by a category.
	const listLink = $derived.by(() => {
		const bucket = filter.selection.priceBucket ?? '';
		if (bucket === '' || (filter.selection.category ?? '') !== '') return null;
		return {
			href: drillHref({ kind: 'priceBucket', bucket: bucket as PriceBucketId }, filter, anchorDay),
			label: m['dashboard.selectionOpenList']({ value: selectionValueLabel('priceBucket', bucket) })
		};
	});
	const truncatedNote = $derived(
		truncated ? m['dashboard.truncatedNote']({ limit: formatCount(DASHBOARD_ROW_LIMIT) }) : ''
	);

	let bar = $state<HTMLElement>();

	/** After a press here removed the pressed button: keep the focus in the band, or hand it to the page. */
	async function afterClear(): Promise<void> {
		await tick();
		if (bar?.isConnected) bar.querySelector<HTMLElement>('[data-selection-clear-all]')?.focus();
		else onEmptied?.();
	}
</script>

{#if chips.length > 0}
	<div
		class="selection-bar"
		role="group"
		aria-label={m['dashboard.selectionLabel']()}
		data-dashboard-selection
		bind:this={bar}
	>
		<span class="selection-title" aria-hidden="true">{m['dashboard.selectionLabel']()}</span>
		{#each chips as chip (chip.dimension)}
			<Button
				size="sm"
				aria-label={m['dashboard.selectionClear']({ chip: chip.text })}
				data-selection-chip={chip.dimension}
				onclick={() => {
					onClear(chip.dimension);
					void afterClear();
				}}
			>
				{chip.text}
				<X size={14} aria-hidden="true" />
			</Button>
		{/each}
		<Button
			size="sm"
			variant="ghost"
			data-selection-clear-all
			onclick={() => {
				onClearAll();
				void afterClear();
			}}
		>
			{m['dashboard.selectionClearAll']()}
		</Button>
		{#if listLink}
			<a
				class="banto-btn banto-btn--ghost banto-btn--sm selection-open"
				href={listLink.href}
				aria-label={listLink.label}
				title={truncatedNote || undefined}
				data-selection-open
			>
				{m['dashboard.selectionOpenListShort']()}
			</a>
		{/if}
	</div>
{/if}

<style>
	.selection-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-2);
	}

	.selection-title {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	/* The link sits at the end of the band, apart from the buttons that take choices off. */
	.selection-open {
		margin-inline-start: auto;
		text-decoration: none;
	}
</style>
