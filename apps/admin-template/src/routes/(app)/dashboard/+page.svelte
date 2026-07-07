<script lang="ts">
	/**
	 * M4 dashboard (spec §6): real charts built from the `items` data, in
	 * place of the M1-M3 placeholder cards. Same "load once, whole dataset"
	 * pattern as the items page ($effect load/dispose around
	 * createListResource) since the dashboard needs the full set to
	 * aggregate, not a paginated window.
	 */
	import { BarChart, LineChart, PieChart, ScatterChart, Sparkline } from '@banto/charts';
	import { createListResource } from '@banto/admin-core';
	import {
		DockHost,
		clampWindowToHost,
		collectPanelIds,
		createDockState,
		type DockLayout,
		type FloatingWindowDef,
		type PanelContent
	} from '@banto/dock-svelte';
	import type { Item } from '$lib/banto/sampleData';
	import {
		byCategory,
		computeStatTiles,
		priceBuckets,
		scatterSample,
		updatesByMonth
	} from '$lib/banto/dashboard';

	const list = createListResource<Item>('items', {
		initialParams: { pagination: { offset: 0, limit: 20_000 } }
	});

	$effect(() => {
		void list.load();
		return () => list.dispose();
	});

	const stats = $derived(computeStatTiles(list.rows));
	const categoryStock = $derived(byCategory(list.rows));
	const buckets = $derived(priceBuckets(list.rows));
	const monthCounts = $derived(updatesByMonth(list.rows));
	const scatterRows = $derived(scatterSample(list.rows));

	const yen = (n: number) => `¥${n.toLocaleString()}`;
	const countLabel = (n: number) => `${n.toLocaleString()}件`;

	/**
	 * M8 dock demo (spec §5, @banto/dock-svelte): the default layout docks the
	 * two chart panels side by side (a row split) with the メモ panel
	 * floating over them, so docked + floating coexist out of the box. Panels
	 * can be dragged to re-split, tabbed (drop on a pane center), undocked
	 * (drag a tab out to floating), and the split divider resizes live. The
	 * whole layout auto-saves; a stored M7 (v1, floating-only) value migrates
	 * cleanly via hydrate.
	 */
	const DOCK_STORAGE_KEY = 'banto.dock.dashboard';

	const DOCK_WINDOW_DEFS: FloatingWindowDef[] = [
		{ id: 'monthly', title: '月別更新件数', icon: '📈', width: 420, height: 320 },
		{ id: 'priceBuckets', title: '価格帯分布', icon: '🥧', width: 360, height: 320 },
		{ id: 'memo', title: 'メモ', icon: '📝', width: 320, height: 220 }
	];

	const PANEL_META: Record<string, { title: string; icon: string }> = Object.fromEntries(
		DOCK_WINDOW_DEFS.map((d) => [d.id, { title: d.title, icon: d.icon! }])
	);

	/** The seeded default: monthly | priceBuckets docked side by side, メモ floating. `hostW/H` clamp the floating window into view. */
	function defaultLayout(hostW: number, hostH: number): DockLayout {
		const memoDef = DOCK_WINDOW_DEFS.find((d) => d.id === 'memo')!;
		const memo = clampWindowToHost(
			{
				id: 'memo',
				title: memoDef.title,
				icon: memoDef.icon,
				x: hostW - (memoDef.width ?? 320) - 24,
				y: hostH - (memoDef.height ?? 220) - 24,
				width: memoDef.width ?? 320,
				height: memoDef.height ?? 220,
				open: true
			},
			hostW,
			hostH
		);
		return {
			version: 2,
			floating: [memo],
			docked: {
				type: 'split',
				id: 'root',
				direction: 'row',
				children: [
					{ type: 'panel', id: 'monthly', title: PANEL_META.monthly.title, icon: PANEL_META.monthly.icon },
					{
						type: 'panel',
						id: 'priceBuckets',
						title: PANEL_META.priceBuckets.title,
						icon: PANEL_META.priceBuckets.icon
					}
				],
				sizes: [0.5, 0.5]
			}
		};
	}

	function loadDockLayout(): string | undefined {
		if (typeof localStorage === 'undefined') return undefined;
		return localStorage.getItem(DOCK_STORAGE_KEY) ?? undefined;
	}

	// Persistence is localStorage for now. Per spec §12.1 this moves behind the
	// SettingsProvider abstraction once it exists (local SQLite settings DB in
	// the webview, localStorage for remote browser clients).
	const dock = createDockState(loadDockLayout());

	let dockHostW = $state(0);
	let dockHostH = $state(0);
	let seeded = $state(false);

	// Seed the docked default once the host has a real measured size, but only
	// if nothing was restored from storage (an empty layout = fresh visit).
	// After seeding, a panel the user fully removed stays removed.
	$effect(() => {
		if (dockHostW === 0 || dockHostH === 0 || seeded) return;
		seeded = true;
		const known = new Set([...collectPanelIds(dock.layout.docked), ...dock.layout.floating.map((w) => w.id)]);
		if (known.size === 0) {
			dock.layout = defaultLayout(dockHostW, dockHostH);
		}
	});

	// Autosave the whole layout on every change (reading dock.serialize() ties
	// this effect to every move/resize/dock/undock/tab/close).
	$effect(() => {
		const json = dock.serialize();
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(DOCK_STORAGE_KEY, json);
		}
	});

	function resetDockLayout() {
		dock.layout = defaultLayout(dockHostW, dockHostH);
	}

	// Each docked pane / floating window body measures its own height so the
	// chart fills it (charts ResizeObserver their own width). Keyed by panel id.
	let panelHeights = $state<Record<string, number>>({});
	function chartHeight(id: string): number {
		return Math.max(140, (panelHeights[id] ?? 240) - 16);
	}

	function isDocked(id: string): boolean {
		return collectPanelIds(dock.layout.docked).includes(id);
	}
	/** A panel counts as visible when it's in the docked tree or an open floating window. */
	function isPanelVisible(id: string): boolean {
		return isDocked(id) || dock.isOpen(id);
	}
	/** Toolbar toggle: docked panels are always shown (button disabled); floating ones open/close, and a fully-removed one re-adds as floating. */
	function togglePanel(id: string): void {
		if (isDocked(id)) return;
		if (dock.isOpen(id)) {
			dock.close(id);
			return;
		}
		const def = DOCK_WINDOW_DEFS.find((d) => d.id === id);
		if (def) {
			dock.ensureWindow(def, dockHostW, dockHostH);
			dock.open(id);
		}
	}
</script>

<div class="page">
	<p class="note">
		商品データ（{list.totalCount.toLocaleString()}件）から集計したダッシュボードです（M4）。折れ線・棒・円・散布図はすべて
		@banto/charts のSVGフルスクラッチ実装。下部のドッキングレイアウトは@banto/dock-svelteによる分割・タブ化・ドラッグ再配置のデモです（M8）。
	</p>

	<div class="stat-row">
		<section class="stat-tile">
			<span class="stat-label">商品数</span>
			<span class="stat-value">{stats.count.toLocaleString()}</span>
		</section>
		<section class="stat-tile">
			<span class="stat-label">在庫合計</span>
			<div class="stat-value-row">
				<span class="stat-value">{stats.stockTotal.toLocaleString()}</span>
				<Sparkline values={monthCounts.map((m) => m.count)} width={72} height={24} />
			</div>
		</section>
		<section class="stat-tile">
			<span class="stat-label">平均価格</span>
			<span class="stat-value">{yen(stats.avgPrice)}</span>
		</section>
		<section class="stat-tile">
			<span class="stat-label">在庫僅少（50未満）</span>
			<span class="stat-value">{stats.lowStockCount.toLocaleString()}</span>
		</section>
	</div>

	{#if list.loading && list.rows.length === 0}
		<p class="loading">読み込み中…</p>
	{:else}
		<div class="chart-grid">
			<section class="card">
				<h2>カテゴリ別在庫</h2>
				<BarChart
					data={categoryStock}
					category={(row) => row.category}
					series={[{ id: 'stock', label: '在庫', value: (row) => row.stock }]}
					horizontal
					label="カテゴリ別在庫の横棒グラフ"
					height={280}
					formatValue={(n) => n.toLocaleString()}
				/>
			</section>

			<section class="card">
				<h2>価格帯分布</h2>
				<PieChart
					data={buckets}
					category={(row) => row.bucket}
					value={(row) => row.count}
					donut
					label="価格帯分布のドーナツグラフ"
					height={280}
					formatValue={countLabel}
				/>
			</section>

			<section class="card">
				<h2>月別更新件数</h2>
				<LineChart
					data={monthCounts}
					x={(row) => row.month}
					series={[{ id: 'count', label: '更新件数', y: (row) => row.count }]}
					area
					label="月別更新件数の面グラフ"
					height={280}
					formatY={(n) => n.toLocaleString()}
				/>
			</section>

			<section class="card">
				<h2>価格×在庫</h2>
				<ScatterChart
					data={scatterRows}
					x={(row) => row.price}
					y={(row) => row.stock}
					pointLabel={(row) => row.name}
					label="価格と在庫の散布図"
					height={280}
					formatX={(v) => yen(Number(v))}
					formatY={(v) => countLabel(Number(v))}
				/>
			</section>

			<section class="card wide">
				<h2>ドッキングレイアウト</h2>
				<p>
					ドッキングレイアウトのデモです（M8、@banto/dock-svelte）。タイトルバーやタブをドラッグしてパネルを分割・タブ化・再配置でき、ペイン中央にドロップするとタブ、端にドロップすると分割になります。タブを外側にドラッグするとフローティング化します。仕切りのドラッグでサイズ変更、レイアウトは自動保存されます。
				</p>
				<div class="dock-toolbar" role="toolbar" aria-label="ドックウィンドウ操作">
					{#each DOCK_WINDOW_DEFS as def (def.id)}
						<button
							type="button"
							class="dock-toggle"
							class:active={isPanelVisible(def.id)}
							aria-pressed={isPanelVisible(def.id)}
							disabled={isDocked(def.id)}
							title={isDocked(def.id) ? 'ドック中のパネルは常に表示されます' : undefined}
							onclick={() => togglePanel(def.id)}
						>
							{def.icon}
							{def.title}
						</button>
					{/each}
					<button type="button" class="dock-reset" onclick={resetDockLayout}>リセット</button>
				</div>
				<div class="dock-wrapper" bind:clientWidth={dockHostW} bind:clientHeight={dockHostH}>
					<DockHost {dock} panel={dockPanel} />
				</div>
			</section>
		</div>
	{/if}
</div>

{#snippet dockPanel(content: PanelContent)}
	{#if content.id === 'monthly'}
		<div class="dock-panel" bind:clientHeight={panelHeights['monthly']}>
			<LineChart
				data={monthCounts}
				x={(row) => row.month}
				series={[{ id: 'count', label: '更新件数', y: (row) => row.count }]}
				area
				label="月別更新件数の面グラフ"
				height={chartHeight('monthly')}
				formatY={(n) => n.toLocaleString()}
			/>
		</div>
	{:else if content.id === 'priceBuckets'}
		<div class="dock-panel" bind:clientHeight={panelHeights['priceBuckets']}>
			<PieChart
				data={buckets}
				category={(row) => row.bucket}
				value={(row) => row.count}
				donut
				label="価格帯分布のドーナツグラフ"
				height={chartHeight('priceBuckets')}
				formatValue={countLabel}
			/>
		</div>
	{:else}
		<div class="dock-panel dock-memo">
			<p>
				タイトルバー/タブをドラッグして分割・タブ化・再配置、仕切りでサイズ変更を試せます。レイアウトは自動保存されます。
			</p>
		</div>
	{/if}
{/snippet}

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.note {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
	}

	.loading {
		color: var(--banto-text-muted);
	}

	.stat-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 1rem;
	}

	.stat-tile {
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: calc(var(--banto-radius) * 2);
		padding: 1rem 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.stat-label {
		color: var(--banto-text-muted);
		font-size: 0.8rem;
	}

	.stat-value {
		font-size: 1.6rem;
		font-weight: 600;
		color: var(--banto-text);
		font-variant-numeric: tabular-nums;
	}

	.stat-value-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.chart-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: 1rem;
	}

	.card {
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: calc(var(--banto-radius) * 2);
		padding: 1rem 1.25rem;
		min-width: 0;
	}

	.card.wide {
		grid-column: 1 / -1;
	}

	h2 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}

	.card p {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: 0.875rem;
	}

	.dock-toolbar {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0.75rem 0;
	}

	.dock-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		border: 1px solid var(--banto-border);
		border-radius: 999px;
		background: var(--banto-surface);
		color: var(--banto-text-muted);
		padding: 0.35rem 0.9rem;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.dock-toggle.active {
		border-color: var(--banto-primary);
		color: var(--banto-primary);
		background: color-mix(in srgb, var(--banto-primary) 8%, transparent);
	}

	.dock-toggle:focus-visible,
	.dock-reset:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.dock-reset {
		border: 1px solid var(--banto-border);
		border-radius: 999px;
		background: var(--banto-surface);
		color: var(--banto-text);
		padding: 0.35rem 0.9rem;
		font-size: 0.8rem;
		cursor: pointer;
		margin-left: auto;
	}

	.dock-reset:hover {
		border-color: var(--banto-primary);
	}

	.dock-wrapper {
		height: 520px;
	}

	.dock-panel {
		height: 100%;
		box-sizing: border-box;
		padding: 0.75rem;
	}

	.dock-memo p {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: 0.85rem;
		line-height: 1.6;
	}
</style>
