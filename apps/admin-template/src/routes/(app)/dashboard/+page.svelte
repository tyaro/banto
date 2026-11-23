<script lang="ts">
	/**
	 * M4 dashboard (spec §6): real charts built from the `items` data, in
	 * place of the M1-M3 placeholder cards.
	 *
	 * #716 W1 (downstream-requests-2026-11-plan §4.13): the page no longer draws
	 * a chart itself. It reads the data ONCE (`createDashboardData`) and hands
	 * it to the KPI strip (`DashboardKpiStrip`, defined by `dashboardKpis.ts`)
	 * and to the widgets registered in `dashboardWidgets.ts` - one registration
	 * + one component file per widget. The two places of today stay: the fixed
	 * cards (`DASHBOARD_CARDS`) and the dock below them (W2 makes them one dock).
	 *
	 * scaffold: everything the dock needs sits between `[scaffold:dock]` marks
	 * (the imports, the script, the View menu, the workspace, the snippets);
	 * `scripts/scaffold.mjs` (`removeDock`) cuts those regions. Nothing here
	 * imports the charts package: `removeCharts` does not touch this file.
	 */
	// [scaffold:dock] begin
	import {
		DockHost,
		clampWindowToHost,
		createDockLayoutStore,
		createDockState,
		type DockLayout,
		type DockNode,
		type PanelContent
	} from '@banto/dock-svelte';
	import { LayoutGrid } from '@lucide/svelte';
	import { getUiSettings, isTauri } from '#lib/banto/setup.js';
	import { listenPanelClosed, openPanelWindow } from '#lib/banto/popout.js';
	import { isDockEscapeBlocked } from '#lib/banto/dockEscape.js';
	import { dockMessages } from '#lib/banto/dockMessages.js';
	import { refreshPanelTitles } from '#lib/banto/dockTitles.js';
	// The layout save's owner (#791).
	import { currentSessionScope, isCurrentSessionScope } from '@banto/admin-core';
	import PanelIcon from '#lib/components/PanelIcon.svelte';
	import {
		MEMO_PANEL_ID,
		createDashboardMemo,
		createPanelChangeHandler,
		memoSaveCommand,
		provideDashboardMemoPane
	} from '#lib/banto/dashboardMemo.svelte.js';
	import { appShortcuts, firstPressOnly, SAVE_SHORTCUT } from '#lib/shortcuts.js';
	import { createSettlePrompt } from '#lib/banto/settlePrompt.svelte.js';
	import { untrack } from 'svelte';
	import { formValidationMessages } from '#lib/banto/i18n.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import type { DraftSettleResult } from '@banto/forms';
	import DraftSettleDialog from '#lib/components/DraftSettleDialog.svelte';
	import PageViewMenu, { type PageViewMenuItem } from '#lib/components/PageViewMenu.svelte';
	// [scaffold:dock] end
	import * as m from '#lib/paraglide/messages.js';
	import { createDashboardData } from '#lib/banto/dashboardData.svelte.js';
	import { DASHBOARD_CARDS, findDashboardWidget } from '#lib/banto/dashboardWidgets.js';
	import DashboardKpiStrip from '#lib/components/DashboardKpiStrip.svelte';
	import AnnotationButton from '#lib/components/AnnotationButton.svelte';
	import AnnotationDrawer from '#lib/components/AnnotationDrawer.svelte';
	import { PageHeader, LoadingState } from '@banto/ui';

	// The one read of `items` for this document (same "load once, whole dataset" pattern as the
	// items page: the dashboard aggregates over the full set, not a paginated window). The KPI
	// strip and every widget get it as a prop; none of them reads `items` itself.
	const data = createDashboardData();

	$effect(() => {
		void data.load();
		return () => data.dispose();
	});

	/** The chart height of a fixed card (W1: the cards keep today's grid; W2 moves them into the dock). */
	const CARD_CHART_HEIGHT = 280;
	// [scaffold:dock] begin
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

	// W1 (#716): the widgets the dock offers as panels (= the View menu's rows), in this order.
	// A widget that is not registered (its package was removed by scaffold) is skipped. W2 puts
	// every registered widget into the dock and removes this list.
	const DOCK_PANELS = ['monthly', 'priceBuckets', 'spc', 'trend', 'memo']
		.map(findDashboardWidget)
		.filter((def) => def !== undefined);
	/** Docked side by side in the default layout (those of them that are registered). */
	const DEFAULT_DOCKED_IDS = ['monthly', 'priceBuckets'];

	/** The seeded default: monthly | priceBuckets docked side by side, メモ floating. `hostW/H` clamp the floating window into view. */
	function defaultLayout(hostW: number, hostH: number): DockLayout {
		const floating = DOCK_PANELS.filter((def) => def.id === MEMO_PANEL_ID).map((memoDef) =>
			clampWindowToHost(
				{
					id: memoDef.id,
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
			)
		);
		const panels = DOCK_PANELS.filter((def) => DEFAULT_DOCKED_IDS.includes(def.id)).map(
			(def): DockNode => ({ type: 'panel', id: def.id, title: def.title, icon: def.icon })
		);
		const docked: DockNode | null =
			panels.length > 1
				? {
						type: 'split',
						id: 'root',
						direction: 'row',
						children: panels,
						sizes: panels.map(() => 1 / panels.length)
					}
				: (panels[0] ?? null);
		return { version: 4, floating, docked };
	}

	// M12 (spec §12.1): the UiSettingsProvider key the layout is saved under
	// (settings DB via Tauri/REST; localStorage in demo mode). A per-user
	// localStorage copy (`${DOCK_STORAGE_KEY}:<owner>`) is the synchronous
	// first-paint source; the provider copy is reconciled once after mount.
	// Both are bound to the signed-in user and session (`scope` / `isCurrent` of
	// dock-svelte's `createDockLayoutStore`, three-pane-dock-plan §4.4).
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
		scope: currentSessionScope(),
		isCurrent: isCurrentSessionScope,
		// A layout saved in another locale: today's titles by panel id (dockTitles.ts, #729 review).
		validate: (json) => refreshPanelTitles(json, (id) => findDashboardWidget(id)?.title),
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
	// The memo widget (MemoWidget.svelte) draws this: every widget takes the same props, so the
	// page's memo reaches it through context. Getters: the draft is one object, `status` changes.
	provideDashboardMemoPane({
		draft: memo.draft,
		save: memoSave,
		saveTitle: memoSaveTitle,
		get status() {
			return memoStatus;
		}
	});

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

	// Autosave (#791): `DockHost` reports a settled layout to `dockLayout.commit`
	// (`onLayoutCommit` below) - the end of a move / resize, a dock / undock / tab /
	// close, a View menu choice, the page's own `dock.*` call - never a step of a
	// drag. The local copy saves immediately; the provider gets one write 500ms
	// after the last report. A layout the store applied is not written back.

	// Unmount: flush (not drop) a pending provider save, so navigating away
	// right after a drag still persists the final layout - unless the session
	// changed (that is what unmounts the page on a user switch).
	$effect(() => () => dockLayout.dispose());

	// "Reset layout": the host puts the default in (asked through
	// `beforePanelChange` like any replacement) and reports it as `'reset'`,
	// which the store saves as a user's change even when the default was shown.
	function resetDockLayout() {
		if (dockHostW === 0 || dockHostH === 0) return;
		void dockHost?.replaceLayout(defaultLayout(dockHostW, dockHostH), {
			saved: true,
			commit: 'reset'
		});
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
	 * dock toolbar. One checkbox per panel in DOCK_PANELS order, checked = on
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
			const def = DOCK_PANELS.find((d) => d.id === id);
			if (def) dock.ensureWindow(def, dockHostW, dockHostH);
		}
		// Hiding goes through the dock lifecycle like ✕ (closing discards the
		// pane's content, so the memo's unapplied input is settled first).
		void dockHost.setPanelVisible(id, visible);
	}

	const viewMenuItems: PageViewMenuItem[] = $derived.by(() => {
		const visible = new Map(dock.panels.map((row) => [row.id, row.visible]));
		return [
			...DOCK_PANELS.map((def): PageViewMenuItem => {
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
				// window shows MemoWidget's static memo text, not this page's draft.)
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
	// [scaffold:dock] end
</script>

<div class="page">
	<PageHeader
		hideTitle
		title={m['nav.dashboard']()}
		description={m['dashboard.summary']({ count: data.totalCount.toLocaleString() })}
	>
		{#snippet actions()}
			<!-- [scaffold:dock] begin -->
			<PageViewMenu label={m['dashboard.viewMenu']()} items={viewMenuItems} />
			<!-- [scaffold:dock] end -->
			<AnnotationButton />
		{/snippet}
	</PageHeader>

	<!-- At the page root, not in PageHeader's actions: the header is a
	     containing block for fixed descendants (annotation.svelte.ts). -->
	<AnnotationDrawer>
		<p>{m['dashboard.aboutNote']({ count: data.totalCount.toLocaleString() })}</p>
	</AnnotationDrawer>

	<DashboardKpiStrip {data} />

	{#if data.loading && data.rows.length === 0}
		<LoadingState label={m['items.loadingData']()} />
	{:else}
		{#if DASHBOARD_CARDS.length > 0}
			<div class="chart-grid">
				{#each DASHBOARD_CARDS as card (card.id)}
					{@const widget = findDashboardWidget(card.id)}
					{#if widget}
						<section class="card {card.tier}">
							<h2>{widget.title}</h2>
							<p class="card-caption">{card.caption}</p>
							<widget.component {data} height={CARD_CHART_HEIGHT} />
						</section>
					{/if}
				{/each}
			</div>
		{/if}
		<!-- [scaffold:dock] begin -->
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
					onLayoutCommit={dockLayout.commit}
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
		<!-- [scaffold:dock] end -->
	{/if}
</div>
<!-- [scaffold:dock] begin -->

{#snippet dockIcon(icon: string)}
	<PanelIcon {icon} />
{/snippet}

{#snippet dockPanel(content: PanelContent)}
	<!--
		The body is the registered widget's component (dashboardWidgets.ts). The
		SAME component renders this panel's content standalone at
		routes/panel/[id] once popped out into a real Tauri window, so it can't
		depend on anything from this page beyond its props: the data read once
		above, and the measured height below.
	-->
	{@const widget = findDashboardWidget(content.id)}
	<div class="dock-panel" bind:clientHeight={panelHeights[content.id]}>
		{#if widget}
			<widget.component {data} height={chartHeight(content.id)} />
		{:else}
			<p class="dock-status">{m['dashboard.unknownPanel']()}</p>
		{/if}
	</div>
{/snippet}

<!-- [scaffold:dock] end -->

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
	}

	/* The KPI strip's rules live in DashboardKpiStrip.svelte. */

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

	/* A panel id the registry does not know (a stale saved layout). Caption-style, like .card-caption. */
	.dock-status {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
		text-wrap: pretty;
	}
</style>
