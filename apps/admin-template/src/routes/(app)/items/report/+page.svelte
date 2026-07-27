<script lang="ts">
	/**
	 * M19 report demo (docs/report-plan.md §3.5, deletable per
	 * docs/template-scope.md §3): a daily report ("日報") built from the
	 * `items` list, showing `@banto/report` end to end (Markdown template +
	 * data bind + print CSS) against real app data. Same "load once, whole
	 * dataset" pattern as dashboard/+page.svelte ($effect load/dispose
	 * around createListResource) since the report aggregates the full set,
	 * not a paginated window.
	 *
	 * No PageHeader here (unlike every other route) - deliberate: the
	 * report's own `<h1>` (rendered from the template's `# 日報（...）`
	 * heading, inside ReportView's paper preview) is the page's real
	 * heading. A second PageHeader `<h1>` above it would be redundant chrome
	 * competing with the "looks like an actual printed page" preview this
	 * page exists to show off - only a small text-link back to the list
	 * takes PageHeader's place.
	 */
	import { base } from '$app/paths';
	import { createListResource } from '@banto/admin-core';
	import { ReportView } from '@banto/report';
	import type { Item } from '$lib/banto/sampleData';
	import { byCategory, categoryCounts, computeStatTiles } from '$lib/banto/dashboard';
	import LoadingState from '$lib/components/ui/LoadingState.svelte';
	import dailyTemplate from '$lib/banto/reports/daily.md?raw';

	const list = createListResource<Item>('items', {
		initialParams: { pagination: { offset: 0, limit: 20_000 } }
	});

	$effect(() => {
		void list.load();
		return () => list.dispose();
	});

	// Same cutoff as dashboard.ts's own (unexported) LOW_STOCK_THRESHOLD -
	// mirrored here rather than duplicated as a new aggregation: this is a
	// single filter over already-loaded rows, not a new count/sum
	// computation (those still all come from computeStatTiles/byCategory/
	// categoryCounts below).
	const LOW_STOCK_THRESHOLD = 50;
	// Caps the printed 在庫僅少一覧 table to a reasonable page length - with
	// 1,000 seeded items and a uniform stock draw, ~100 rows would be low
	// stock; `lowStockCount` in the summary paragraph still reports the
	// TRUE total, this only limits how many rows the table lists.
	const LOW_STOCK_DISPLAY_LIMIT = 30;

	interface CategoryRow {
		category: string;
		count: number;
		stock: number;
	}

	/**
	 * Joins dashboard.ts's two existing per-category aggregates
	 * (`byCategory` = stock totals, `categoryCounts` = item counts) into the
	 * single {category, count, stock} row shape the report table needs.
	 * This is a plain join over already-computed values, not a new
	 * aggregation - both source arrays do the actual counting/summing.
	 */
	function mergeCategoryRows(items: Item[]): CategoryRow[] {
		const counts = new Map(categoryCounts(items).map((c) => [c.label, c.value]));
		return byCategory(items).map((c) => ({
			category: c.category,
			stock: c.stock,
			count: counts.get(c.category) ?? 0
		}));
	}

	/** `YYYY-MM-DD`, local time (the report's own "作成日", not an item field - no timezone-drift concern `dashboard.ts`'s date formatting deals with elsewhere). */
	function todayYmd(): string {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	}

	const reportData = $derived.by(() => {
		const items = list.rows;
		const stats = computeStatTiles(items);
		const lowStock = items
			.filter((item) => item.stock < LOW_STOCK_THRESHOLD)
			.sort((a, b) => a.stock - b.stock)
			.slice(0, LOW_STOCK_DISPLAY_LIMIT)
			.map((item) => ({ name: item.name, stock: item.stock }));

		return {
			date: todayYmd(),
			totalCount: stats.count,
			stockTotal: stats.stockTotal,
			avgPrice: stats.avgPrice,
			lowStockCount: stats.lowStockCount,
			categories: mergeCategoryRows(items),
			lowStock
		};
	});
</script>

<div class="page">
	<a class="back-link" href={`${base}/items`}>← 商品一覧へ戻る</a>

	{#if list.loading && list.rows.length === 0}
		<LoadingState label="商品データを読み込み中…" />
	{:else}
		<ReportView template={dailyTemplate} data={reportData} title="日報" />
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.back-link {
		align-self: flex-start;
		font-size: 0.8rem;
		color: var(--banto-text-muted);
	}

	.back-link:hover {
		color: var(--banto-text);
	}

	/* The report's own toolbar (ReportView) already hides itself and the
	   app shell on print (app.css); this small nav link is local to the
	   page and gets the same treatment. */
	@media print {
		.back-link {
			display: none;
		}
	}
</style>
