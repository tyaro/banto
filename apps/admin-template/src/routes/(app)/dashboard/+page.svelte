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
		createDockState,
		type DockLayout,
		type PanelContent
	} from '@banto/dock-svelte';
	import { LayoutGrid, JapaneseYen, Package, TriangleAlert, Warehouse } from '@lucide/svelte';
	// Its own line: scaffold.mjs's dock remover rewrites the line above by text.
	import { ChevronRight } from '@lucide/svelte';
	import { resolveAppPath } from '#lib/appPath.js';
	import {
		LOW_STOCK_THRESHOLD,
		LOW_STOCK_VIEW_ID,
		itemsResource
	} from '#lib/banto/resources/items.js';
	import * as m from '#lib/paraglide/messages.js';
	import type { Item } from '#lib/banto/sampleData.js';
	import {
		byCategory,
		computeStatTiles,
		priceBuckets,
		scatterSample,
		stockByCategoryPriceBand,
		updatesByMonth
	} from '#lib/banto/dashboard.js';
	import { PANEL_DEFS, findPanelDef } from '#lib/banto/panels.js';
	import { getUiSettings, isTauri } from '#lib/banto/setup.js';
	import { listenPanelClosed, openPanelWindow } from '#lib/banto/popout.js';
	import { isDockEscapeBlocked } from '#lib/banto/dockEscape.js';
	import { dockMessages } from '#lib/banto/dockMessages.js';
	import { refreshPanelTitles } from '#lib/banto/dockTitles.js';
	import { createDockLayoutStore } from '#lib/banto/dockLayoutStore.svelte.js';
	import DashboardPanel from '#lib/components/DashboardPanel.svelte';
	import PanelIcon from '#lib/components/PanelIcon.svelte';
	import {
		MEMO_PANEL_ID,
		createDashboardMemo,
		createPanelChangeHandler,
		memoSaveCommand
	} from '#lib/banto/dashboardMemo.svelte.js';
	import { appShortcuts, firstPressOnly, SAVE_SHORTCUT } from '#lib/shortcuts.js';
	import { createSettlePrompt } from '#lib/banto/settlePrompt.svelte.js';
	import { untrack } from 'svelte';
	import { formValidationMessages } from '#lib/banto/i18n.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import type { DraftSettleResult } from '@banto/forms';
	import DashboardMemoField from '#lib/components/DashboardMemoField.svelte';
	import DraftSettleDialog from '#lib/components/DraftSettleDialog.svelte';
	import AnnotationButton from '#lib/components/AnnotationButton.svelte';
	import PageViewMenu, { type PageViewMenuItem } from '#lib/components/PageViewMenu.svelte';
	import AnnotationDrawer from '#lib/components/AnnotationDrawer.svelte';
	import { PageHeader, LoadingState } from '@banto/ui';

	const list = createListResource<Item>('items', {
		initialParams: { pagination: { offset: 0, limit: 20_000 } }
	});

	// #555 (4): the 在庫僅少 tile opens this list view (ResourceListPage reads `?view=`).
	const lowStockHref = `${resolveAppPath(itemsResource.path)}?view=${LOW_STOCK_VIEW_ID}`;

	$effect(() => {
		void list.load();
		return () => list.dispose();
	});

	const stats = $derived(computeStatTiles(list.rows));
	const categoryStock = $derived(byCategory(list.rows));
	const categoryPriceBand = $derived(stockByCategoryPriceBand(list.rows));
	const buckets = $derived(priceBuckets(list.rows));
	const monthCounts = $derived(updatesByMonth(list.rows));
	const scatterRows = $derived(scatterSample(list.rows));

	const yen = (n: number) => `¥${n.toLocaleString()}`;
	const countLabel = (n: number) => m['dashboard.countUnit']({ count: n.toLocaleString() });

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

	// Panel id/title/icon defs moved to #lib/banto/panels.ts (spec §5.3 v2):
	// shared with the standalone routes/panel/[id] route a popped-out panel
	// renders as, which has no access to this page's own locals.
	const PANEL_META: Record<string, { title: string; icon: string }> = Object.fromEntries(
		PANEL_DEFS.map((d) => [d.id, { title: d.title, icon: d.icon! }])
	);

	/** The seeded default: monthly | priceBuckets docked side by side, メモ floating. `hostW/H` clamp the floating window into view. */
	function defaultLayout(hostW: number, hostH: number): DockLayout {
		const memoDef = PANEL_DEFS.find((d) => d.id === 'memo')!;
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
					{
						type: 'panel',
						id: 'monthly',
						title: PANEL_META.monthly.title,
						icon: PANEL_META.monthly.icon
					},
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

	// M12 (spec §12.1): the UiSettingsProvider key the layout is saved under
	// (settings DB via Tauri/REST; localStorage in demo mode). A per-user
	// localStorage copy (`${DOCK_STORAGE_KEY}:<owner>`) is the synchronous
	// first-paint source; the provider copy is reconciled once after mount.
	// Both are bound to the signed-in user and session (dockLayoutStore.svelte.ts,
	// three-pane-dock-plan §4.4).
	const DOCK_SETTING_KEY = 'dock.dashboard';

	const dock = createDockState();
	// Where a docked pane closed with its ✕ / unchecked in the View menu is shown again: its place
	// in the default layout (dock-svelte reads only `docked`, so the host size does not matter).
	// Not saved with the layout: given at every mount. Without it such a pane opens floating.
	dock.defaultLayout = defaultLayout(1280, 800);
	const dockLayout = createDockLayoutStore({
		dock,
		storageKey: DOCK_STORAGE_KEY,
		settingKey: DOCK_SETTING_KEY,
		provider: getUiSettings,
		// A layout saved in another locale: today's titles by panel id (dockTitles.ts, #729 review).
		validate: (json) => refreshPanelTitles(json, (id) => findPanelDef(id)?.title),
		// Not before the host is measured: the floating メモ is clamped into it.
		defaultLayout: () =>
			dockHostW === 0 || dockHostH === 0 ? null : defaultLayout(dockHostW, dockHostH)
	});
	let dockHost: ReturnType<typeof DockHost> | undefined = $state();

	/**
	 * Issue #432 PR-10 (shared-primitives-upstream-plan §3.5・D9): the メモ
	 * pane is a text field whose unapplied input survives dock / undock / tab
	 * switches. The draft, its coordinator and the saved setting live HERE (the
	 * page), not in the pane: the pane is re-created by every structure change,
	 * and the draft's source stays registered while the page lives, so a closed
	 * memo with unapplied text still makes a router leave ask
	 * (dashboardMemo.svelte.ts). Apply = the UiSettingsProvider (spec §12.1).
	 */
	const memo = createDashboardMemo({
		provider: getUiSettings(),
		label: m['panels.memo'](),
		leaveMessage: () => m['unsaved.confirmLeave'](),
		messages: formValidationMessages()
	});
	const memoPrompt = createSettlePrompt();
	let memoStatus = $state<string | null>(null);

	/** What to tell the user after a save / close settle of the memo. */
	function noteMemoSettled(result: DraftSettleResult): void {
		memoStatus =
			result === 'failed'
				? m['dashboard.memoSaveFailed']()
				: result === 'dirty-again'
					? m['dashboard.memoChangedWhileSaving']()
					: null;
	}

	// Transition by transition (plan §3.5's table): dock / undock / move /
	// tab switch / hide only capture (no prompt); a close - which discards the
	// pane's content - settles first and closes only when the draft is clean.
	const beforePanelChange = createPanelChangeHandler({
		// Serialized: a close waits for a save already in flight (PR #449 review).
		coordinator: memo.serial,
		ask: (dirtyKeys) => memoPrompt.ask(dirtyKeys),
		onSettled: (_panelId, result) => noteMemoSettled(result)
	});

	async function saveMemo(): Promise<void> {
		noteMemoSettled(await memo.save());
	}

	// Issue #435 PR-11: the pane's save button and Ctrl+S / Cmd+S are ONE
	// command (memoSaveCommand) - the same serialized save, so a close asked
	// meanwhile waits for it. The key is registered with the app's shortcut
	// dispatcher for the page's lifetime (anywhere on this page, the memo's
	// textarea included); a held key saves once (firstPressOnly). Elsewhere
	// Ctrl+S stays the browser's.
	const memoSave = memoSaveCommand({
		memo,
		title: m['common.save'](),
		shortcut: SAVE_SHORTCUT,
		save: () => void saveMemo()
	});
	const memoSaveTitle = m['common.withShortcut']({
		label: m['common.save'](),
		keys: appShortcuts.format(SAVE_SHORTCUT)
	});
	$effect(() =>
		untrack(() =>
			appShortcuts.register('dashboard', [firstPressOnly(memoSave, appShortcuts.isRepeat)])
		)
	);

	// Page lifetime: register the draft's source, read the stored memo once, and
	// drop everything (an open question answers 'cancel') on unmount.
	$effect(() => untrack(() => memo.register()));
	$effect(() => {
		untrack(() => void memo.load());
		return () => {
			memoPrompt.dispose();
			memo.dispose();
		};
	});

	// A router leave with an unapplied memo asks first (Issue #214's guard; the
	// coordinator also joins the registry the desktop window close reads).
	guardUnsavedChanges({
		isDirty: () => memo.coordinator.pending,
		isSaving: () => memo.coordinator.settling || memo.setting.saving
	});

	let dockHostW = $state(0);
	let dockHostH = $state(0);

	// Seed the docked default once the host has a real measured size, but only
	// if nothing was restored from storage (an empty layout = fresh visit).
	// After seeding, a panel the user fully removed stays removed.
	$effect(() => {
		dockLayout.seedIfEmpty();
	});

	// M12: after the first paint, read the provider's copy once - it wins
	// (also over a move made meanwhile); nothing saved / a failure restores the
	// default. A read for a session that has ended is dropped.
	$effect(() => untrack(() => void dockLayout.load()));

	// Autosave the whole layout on every change (reading dock.serialize() ties
	// this effect to every move/resize/dock/undock/tab/close). The local copy
	// saves immediately; the provider gets one write 500ms after the layout
	// stops changing (a drag serializes on every pointermove).
	$effect(() => {
		const json = dock.serialize();
		untrack(() => dockLayout.changed(json));
	});

	// Unmount: flush (not drop) a pending provider save, so navigating away
	// right after a drag still persists the final layout - unless the session
	// changed (that is what unmounts the page on a user switch).
	$effect(() => () => dockLayout.dispose());

	function resetDockLayout() {
		dockLayout.reset();
	}

	// Each docked pane / floating window body measures its own height so the
	// chart fills it (charts ResizeObserver their own width). Keyed by panel id.
	let panelHeights = $state<Record<string, number>>({});
	function chartHeight(id: string): number {
		return Math.max(140, (panelHeights[id] ?? 240) - 16);
	}

	/**
	 * #663 ①-C: the View menu (PageViewMenu - the menu bar's "表示" when the
	 * bar is on screen, else a button in this page's header) replaces the old
	 * dock toolbar. One checkbox per panel in PANEL_DEFS order, checked = on
	 * screen (docked, a background tab included, or an open floating window),
	 * read from `dock.panels` so a refused / stale change shows the real state.
	 */
	function setPanelVisible(id: string, visible: boolean): void {
		if (!dockHost) return;
		if (visible) {
			// A panel never shown yet is not in the layout: add it as a closed-
			// or-open floating window first (a no-op for an id already docked or
			// floating), then show it - a pane hidden from the dock goes back to
			// its former slot.
			const def = PANEL_DEFS.find((d) => d.id === id);
			if (def) dock.ensureWindow(def, dockHostW, dockHostH);
		}
		// Hiding goes through the dock lifecycle like ✕ (closing discards the
		// pane's content, so the memo's unapplied input is settled first).
		void dockHost.setPanelVisible(id, visible);
	}

	const viewMenuItems: PageViewMenuItem[] = $derived.by(() => {
		const visible = new Map(dock.panels.map((row) => [row.id, row.visible]));
		return [
			...PANEL_DEFS.map((def): PageViewMenuItem => {
				const checked = visible.get(def.id) ?? false;
				return {
					kind: 'checkbox',
					id: `panel:${def.id}`,
					label: def.title,
					checked,
					onSelect: () => setPanelVisible(def.id, !checked)
				};
			}),
			{ kind: 'separator', id: 'reset-separator' },
			{
				kind: 'action',
				id: 'reset-layout',
				label: m['dashboard.resetLayout'](),
				onSelect: resetDockLayout
			}
		];
	});

	/**
	 * v2 pop-out (spec §5.3, Tauri only): dragging a panel out via
	 * dock-svelte's `onPopOut` affordance (⧉ button) opens it as a REAL
	 * native window (`panel_open` Tauri command -> routes/panel/[id]) instead
	 * of a pseudo-window. The panel is hidden from THIS dock - undocked (if
	 * docked) then closed (if floating) - but its floating geometry is
	 * preserved, so `dock.open(id)` (below, on window-close) restores it
	 * exactly where it was. `undefined` in browser mode: DockHost then
	 * renders no pop-out button at all (see its doc comment), so this is
	 * never called there - `isTauri()` guards it anyway as a second line of
	 * defense.
	 */
	const onPopOut = isTauri()
		? async (content: PanelContent) => {
				// Popping out leaves this dock like a close does, so it goes through the
				// host's lifecycle (`closePanel`: beforePanelChange settles the memo's
				// unapplied input, and a structure change made while that waits makes
				// it `stale`). Only an applied close pops out; the close already
				// undocked + closed the pane with its geometry kept. (The pop-out
				// window shows DashboardPanel's static memo text, not this page's draft.)
				if ((await dockHost?.closePanel(content.id)) !== 'applied') return;
				void openPanelWindow(content);
			}
		: undefined;

	// Round-trip contract (spec §5.3 v2): when a popped-out panel's native
	// window is closed, src-tauri emits `banto://panel-closed` with that
	// panel's id (see popout.ts's listenPanelClosed) - `dock.open` brings it
	// back as a floating pseudo-window at its preserved geometry. (If the
	// panel had been docked, `onPopOut`'s `closePanel` above took it out of
	// the docked tree as a closed floating window hidden from the dock - the
	// same path as the pane's ✕. `dock.open` opens it floating; the View
	// menu's `showPanel` would dock it at its default place.) No-op in
	// browser mode.
	$effect(() => {
		if (!isTauri()) return;
		return listenPanelClosed((id) => dock.open(id));
	});
</script>

<div class="page">
	<PageHeader
		hideTitle
		title={m['nav.dashboard']()}
		description={m['dashboard.summary']({ count: list.totalCount.toLocaleString() })}
	>
		{#snippet actions()}
			<PageViewMenu label={m['dashboard.viewMenu']()} items={viewMenuItems} />
			<AnnotationButton />
		{/snippet}
	</PageHeader>

	<!-- At the page root, not in PageHeader's actions: the header is a
	     containing block for fixed descendants (annotation.svelte.ts). -->
	<AnnotationDrawer>
		<p>{m['dashboard.aboutNote']({ count: list.totalCount.toLocaleString() })}</p>
	</AnnotationDrawer>

	<div class="stat-row">
		<section class="stat-tile">
			<span class="stat-icon" aria-hidden="true"><Package size={18} /></span>
			<div class="stat-body">
				<span class="stat-label">{m['dashboard.statCount']()}</span>
				<span class="stat-value">{stats.count.toLocaleString()}</span>
			</div>
		</section>
		<section class="stat-tile">
			<span class="stat-icon" aria-hidden="true"><Warehouse size={18} /></span>
			<div class="stat-body">
				<span class="stat-label">{m['dashboard.statStockTotal']()}</span>
				<div class="stat-value-row">
					<span class="stat-value">{stats.stockTotal.toLocaleString()}</span>
					<Sparkline values={monthCounts.map((mc) => mc.count)} width={72} height={24} />
				</div>
			</div>
		</section>
		<section class="stat-tile">
			<span class="stat-icon" aria-hidden="true"><JapaneseYen size={18} /></span>
			<div class="stat-body">
				<span class="stat-label">{m['dashboard.statAvgPrice']()}</span>
				<span class="stat-value">{yen(stats.avgPrice)}</span>
			</div>
		</section>
		<!-- #555 (4): the tile opens the items list on its `low-stock` view
		     (same LOW_STOCK_THRESHOLD as the count). -->
		<a class="stat-tile stat-link" href={lowStockHref} title={m['dashboard.statLowStockOpen']()}>
			<span class="stat-icon" aria-hidden="true"><TriangleAlert size={18} /></span>
			<div class="stat-body">
				<span class="stat-label">
					{m['dashboard.statLowStock']({ threshold: LOW_STOCK_THRESHOLD })}
				</span>
				<span class="stat-value">{stats.lowStockCount.toLocaleString()}</span>
			</div>
			<ChevronRight class="stat-link-icon" size={16} aria-hidden="true" />
		</a>
	</div>

	{#if list.loading && list.rows.length === 0}
		<LoadingState label={m['items.loadingData']()} />
	{:else}
		<div class="chart-grid">
			<section class="card primary">
				<h2>{m['dashboard.monthlyTitle']()}</h2>
				<p class="card-caption">{m['dashboard.monthlyCaption']()}</p>
				<LineChart
					data={monthCounts}
					x={(row) => row.month}
					series={[{ id: 'count', label: m['dashboard.seriesUpdates'](), y: (row) => row.count }]}
					area
					label={m['dashboard.monthlyAria']()}
					height={280}
					formatY={(n) => n.toLocaleString()}
				/>
			</section>

			<section class="card secondary">
				<h2>{m['dashboard.categoryStockTitle']()}</h2>
				<p class="card-caption">{m['dashboard.categoryStockCaption']()}</p>
				<BarChart
					data={categoryStock}
					category={(row) => row.category}
					series={[{ id: 'stock', label: m['dashboard.seriesStock'](), value: (row) => row.stock }]}
					horizontal
					label={m['dashboard.categoryStockAria']()}
					height={280}
					formatValue={(n) => n.toLocaleString()}
				/>
			</section>

			<section class="card secondary">
				<h2>{m['dashboard.stackedBarTitle']()}</h2>
				<p class="card-caption">{m['dashboard.stackedBarCaption']()}</p>
				<BarChart
					data={categoryPriceBand}
					category={(row) => row.category}
					series={[
						{ id: 'low', label: m['dashboard.priceBandLow'](), value: (row) => row.low },
						{ id: 'mid', label: m['dashboard.priceBandMid'](), value: (row) => row.mid },
						{ id: 'high', label: m['dashboard.priceBandHigh'](), value: (row) => row.high }
					]}
					stacked
					label={m['dashboard.stackedBarAria']()}
					height={280}
					formatValue={(n) => n.toLocaleString()}
				/>
			</section>

			<section class="card secondary">
				<h2>{m['dashboard.priceBucketTitle']()}</h2>
				<p class="card-caption">{m['dashboard.priceBucketCaption']()}</p>
				<PieChart
					data={buckets}
					category={(row) => row.bucket}
					value={(row) => row.count}
					donut
					label={m['dashboard.priceBucketAria']()}
					height={280}
					formatValue={countLabel}
				/>
			</section>

			<section class="card secondary">
				<h2>{m['dashboard.scatterTitle']()}</h2>
				<p class="card-caption">{m['dashboard.scatterCaption']()}</p>
				<ScatterChart
					data={scatterRows}
					x={(row) => row.price}
					y={(row) => row.stock}
					pointLabel={(row) => row.name}
					label={m['dashboard.scatterAria']()}
					height={280}
					formatX={(v) => yen(Number(v))}
					formatY={(v) => countLabel(Number(v))}
				/>
			</section>
		</div>

		<section class="workspace">
			<h2 class="workspace-heading">
				<LayoutGrid size={18} aria-hidden="true" />{m['dashboard.workspaceHeading']()}
			</h2>
			<p class="workspace-caption">{m['dashboard.workspaceCaption']()}</p>
			<div class="dock-wrapper" bind:clientWidth={dockHostW} bind:clientHeight={dockHostH}>
				<DockHost
					bind:this={dockHost}
					{dock}
					panel={dockPanel}
					iconContent={dockIcon}
					{onPopOut}
					{beforePanelChange}
					isEscapeBlocked={isDockEscapeBlocked}
					messages={dockMessages()}
				/>
			</div>
			<DraftSettleDialog
				prompt={memoPrompt}
				title={m['dashboard.memoCloseTitle']()}
				body={m['dashboard.memoCloseBody']()}
				applyLabel={m['dashboard.memoCloseApply']()}
				discardLabel={m['dashboard.memoCloseDiscard']()}
			/>
		</section>
	{/if}
</div>

{#snippet dockIcon(icon: string)}
	<PanelIcon {icon} />
{/snippet}

{#snippet dockPanel(content: PanelContent)}
	<!--
		Body extracted to DashboardPanel.svelte (spec §5.3 v2 pop-out): the
		SAME component renders this panel's content standalone at
		routes/panel/[id] once popped out into a real Tauri window, so the
		markup can't depend on anything from this page beyond the measured
		height below.
	-->
	<div class="dock-panel" bind:clientHeight={panelHeights[content.id]}>
		{#if content.id === MEMO_PANEL_ID}
			<DashboardMemoField
				draft={memo.draft}
				save={memoSave}
				saveTitle={memoSaveTitle}
				status={memoStatus}
			/>
		{:else}
			<DashboardPanel id={content.id} height={chartHeight(content.id)} />
		{/if}
	</div>
{/snippet}

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
	}

	/* "About this demo" collapsible (design.md §10): the long technical note
	   used to sit at the top of the page, ahead of the KPIs/charts it
	   describes. Closed by default. */
	/* KPI tiles (design.md §10): icon + label + tabular-nums value. Tile-only
	   card (not SurfaceCard, spec §K3): same face/border/radius/shadow tokens
	   without SurfaceCard's optional title/description header. */
	.stat-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: var(--banto-space-4);
	}

	/* Card tiers (#623): KPI row = subtle (flat), the main chart = primary,
	   the other charts = default. Tokens in banto.css (--banto-card-*). */
	.stat-tile {
		background: var(--banto-card-subtle-bg);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-card-subtle-shadow);
		padding: var(--banto-space-4) var(--banto-space-5);
		display: flex;
		align-items: center;
		gap: var(--banto-space-3);
	}

	/* #555 (4): a tile that opens a list view (the 在庫僅少 tile). */
	.stat-link {
		color: inherit;
		text-decoration: none;
		transition: border-color var(--banto-duration-fast) var(--banto-ease-out);
	}

	.stat-link:hover {
		border-color: var(--banto-primary);
	}

	.stat-link:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.stat-link :global(.stat-link-icon) {
		margin-left: auto;
		flex: none;
		color: var(--banto-text-muted);
	}

	.stat-icon {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: var(--banto-radius-md);
		background: color-mix(in srgb, var(--banto-primary) 12%, transparent);
		color: var(--banto-primary);
	}

	.stat-body {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		min-width: 0;
	}

	.stat-label {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.stat-value {
		font-size: var(--banto-font-size-2xl);
		font-weight: 650;
		color: var(--banto-text);
		font-variant-numeric: tabular-nums;
	}

	/* Kiosk (#624 PR-2): KPIs readable from across the room. Keyed on the
	   shell's .kiosk class (settings.kiosk), not on density. The number never
	   wraps; its size shrinks with the width of the text column (.stat-body is
	   an inline-size container), not the viewport. 15cqi fits ~9 bold
	   tabular digits (about 5.8em). The sparkline drops below the number so it
	   does not eat that width. */
	:global(.shell.kiosk) .stat-row {
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
	}

	:global(.shell.kiosk) .stat-icon {
		width: 56px;
		height: 56px;
	}

	:global(.shell.kiosk) .stat-label {
		font-size: var(--banto-font-size-lg);
	}

	:global(.shell.kiosk) .stat-body {
		flex: 1 1 0;
		container-type: inline-size;
	}

	:global(.shell.kiosk) .stat-value {
		font-size: min(var(--banto-font-size-3xl), 15cqi);
		line-height: 1.1;
		white-space: nowrap;
	}

	:global(.shell.kiosk) .stat-value-row {
		flex-direction: column;
		align-items: flex-start;
		gap: var(--banto-space-1);
	}

	@media (max-width: 600px) {
		:global(.shell.kiosk) .stat-icon {
			width: 36px;
			height: 36px;
		}
	}

	.stat-value-row {
		display: flex;
		align-items: center;
		gap: var(--banto-space-3);
	}

	/* Asymmetric 12-column chart grid (design.md §10, plan Phase 3): the
	   primary (monthly-trend) chart spans 8/12, secondary charts 4/12 each,
	   collapsing to a single column under 900px. */
	.chart-grid {
		display: grid;
		grid-template-columns: repeat(12, 1fr);
		gap: var(--banto-space-4);
	}

	.card {
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-card-default-shadow);
		padding: var(--banto-space-4) var(--banto-space-5);
		min-width: 0;
		grid-column: span 12;
	}

	.card.primary {
		box-shadow: var(--banto-card-primary-shadow);
	}

	@media (min-width: 901px) {
		.card.primary {
			grid-column: span 8;
		}

		.card.secondary {
			grid-column: span 4;
		}
	}

	h2 {
		margin: 0 0 var(--banto-space-1);
		font-size: var(--banto-font-size-base);
		font-feature-settings: 'palt';
	}

	.card-caption {
		margin: 0 0 var(--banto-space-2);
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
		text-wrap: pretty;
	}

	/* Docking area (design.md §10): separated from the regular chart cards
	   as an "analysis workspace" section on the subtle surface tone. */
	.workspace {
		background: var(--banto-surface-subtle);
		border-radius: var(--banto-radius-lg);
		padding: var(--banto-space-5);
	}

	.workspace-heading {
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
		margin: 0 0 var(--banto-space-2);
		font-size: var(--banto-font-size-base);
		font-feature-settings: 'palt';
	}

	.workspace-caption {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-md);
		text-wrap: pretty;
	}

	.dock-wrapper {
		height: 520px;
		margin-top: var(--banto-space-3);
	}

	.dock-panel {
		height: 100%;
		box-sizing: border-box;
		padding: var(--banto-space-3);
	}
</style>
