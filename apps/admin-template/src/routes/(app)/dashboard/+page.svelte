<script lang="ts">
	/**
	 * M4 dashboard (spec §6): real charts built from the `items` data, in
	 * place of the M1-M3 placeholder cards.
	 *
	 * #716 (downstream-requests-2026-11-plan §4.13): the page draws no chart
	 * itself. It reads the data ONCE (`createDashboardData`) and hands it to the
	 * KPI strip (`DashboardKpiStrip`, defined by `dashboardKpis.ts`; fixed) and
	 * to the widgets registered in `dashboardWidgets.ts` - one registration + one
	 * component file per widget.
	 *
	 * W2: the widgets are the panels of ONE dock (the fixed grid of cards and
	 * the separate "analysis workspace" are gone). The user edits the
	 * ARRANGEMENT - add / show / hide from the View menu, move / resize / tab /
	 * float with the dock's own gestures and keyboard menu - and it is saved per
	 * user (`dashboard.widgets`). The default arrangement, the dock's height
	 * and the check of a saved value are `dashboardLayout.ts`.
	 *  - Kiosk (`settings.kiosk`): the saved arrangement is shown, nothing can
	 *    be rearranged (`arrange={false}`), no View menu.
	 *  - A page 900px wide or less: no dock (`DockHost` has no narrow display);
	 *    the widgets the arrangement shows are stacked in one column, in the
	 *    order they are registered (`DashboardWidgetStack`). Nothing can be
	 *    rearranged there and the saved arrangement is not written.
	 *
	 * scaffold: everything the dock needs sits between `[scaffold:dock]` marks
	 * (the imports, the script, the View menu, the dock, the snippets);
	 * `scripts/scaffold.mjs` (`removeDock`) cuts those regions, and what is left
	 * is the one-column display with every registered widget. Nothing here
	 * imports the charts package: `removeCharts` does not touch this file.
	 */
	// [scaffold:dock] begin
	import {
		DockHost,
		createDockLayoutStore,
		createDockState,
		type PanelContent
	} from '@banto/dock-svelte';
	import { getUiSettings } from '#lib/banto/setup.js';
	import { createAppPanelPopOut, createLayoutSaveWatch } from '#lib/banto/popout.js';
	import { isDockEscapeBlocked } from '#lib/banto/dockEscape.js';
	import { dockMessages } from '#lib/banto/dockMessages.js';
	import {
		DASHBOARD_LAYOUT_SETTING_KEY,
		DASHBOARD_LAYOUT_STORAGE_KEY,
		DASHBOARD_POPOUT_STORAGE_KEY,
		dashboardDockHeight,
		defaultDashboardLayout,
		validateDashboardLayout
	} from '#lib/banto/dashboardLayout.js';
	import { settings } from '#lib/settings.svelte.js';
	// The layout save's owner (#791).
	import { currentSessionScope, isCurrentSessionScope } from '@banto/admin-core';
	import PanelIcon from '#lib/components/PanelIcon.svelte';
	import {
		createDashboardMemo,
		createPanelChangeHandler,
		settleBeforeReset,
		trackClosePending,
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
	import DashboardWidgetFrame from '#lib/components/dashboard/DashboardWidgetFrame.svelte';
	// [scaffold:dock] end
	import { goto } from '$app/navigation';
	import * as m from '#lib/paraglide/messages.js';
	import { formatCount } from '#lib/banto/i18n.js';
	import { DASHBOARD_ROW_LIMIT, createDashboardData } from '#lib/banto/dashboardData.svelte.js';
	import { drillHref, type DashboardDrill } from '#lib/banto/dashboardDrill.js';
	import { DASHBOARD_WIDGETS, type DashboardSelect } from '#lib/banto/dashboardWidgets.js';
	import DashboardSelectionBar from '#lib/components/dashboard/DashboardSelectionBar.svelte';
	import DashboardWidgetStack from '#lib/components/dashboard/DashboardWidgetStack.svelte';
	import DashboardKpiStrip from '#lib/components/DashboardKpiStrip.svelte';
	import AnnotationButton from '#lib/components/AnnotationButton.svelte';
	import AnnotationDrawer from '#lib/components/AnnotationDrawer.svelte';
	import {
		DASHBOARD_PERIODS,
		DEFAULT_DASHBOARD_FILTER,
		latestDay,
		toggleSelection,
		type DashboardFilter,
		type DashboardPeriod
	} from '#lib/banto/dashboardPeriod.js';
	import { PageHeader, LoadingState, SegmentedControl, type SegmentedOption } from '@banto/ui';

	/**
	 * #716 W3: the ONE period the page holds (§4.13.3). The KPI strip and the widgets registered
	 * with `usesPeriod` draw the rows it leaves; the others do not notice a change. It is the
	 * page's state and nothing else: not saved (a reload starts at "all"), not part of the saved
	 * arrangement, not sent to a popped-out window. The selection of #882 (cross-filtering, `selection`) lives in this
	 * same object, with the same rules.
	 *
	 * #882 C2: a mark of a widget registered with `selects` toggles ONE value of its dimension
	 * (`select.toggle`, handed to the widgets through the frame); the widgets registered with
	 * `usesSelection` and the KPI strip are narrowed by it, and the band under the heading
	 * (`DashboardSelectionBar`) shows what is chosen and takes it off. The band is drawn only while
	 * something is chosen. Opening the items list from a choice (the drill-down of D3) is the
	 * band's link, not the mark itself.
	 */
	let filter = $state<DashboardFilter>({ ...DEFAULT_DASHBOARD_FILTER, selection: {} });
	const PERIOD_LABELS: Record<DashboardPeriod, () => string> = {
		all: m['dashboard.periodAll'],
		'30d': m['dashboard.period30d'],
		'90d': m['dashboard.period90d'],
		'12m': m['dashboard.period12m']
	};
	const periodOptions: SegmentedOption<DashboardPeriod>[] = DASHBOARD_PERIODS.map((value) => ({
		value,
		label: PERIOD_LABELS[value]()
	}));

	// The one read of `items` for this document (same "load once, whole dataset" pattern as the
	// items page: the dashboard aggregates over the full set, not a paginated window). The KPI
	// strip and every widget get it as a prop; none of them reads `items` itself. Changing the
	// period reads nothing again: the rows already read are narrowed (dashboardData.svelte.ts).
	const data = createDashboardData({ filter: () => filter });

	$effect(() => {
		void data.load();
		return () => data.dispose();
	});

	/**
	 * #882 D3: a mark of a widget opens the items list that holds the rows it counts. The widget
	 * says what was chosen; the period is added here (`drillHref`), so the list counts what the mark
	 * counted. Handed to the widgets in the dock and in the one-column display; the popped-out
	 * window (`routes/panel/[id]`) has none.
	 */
	const anchorDay = $derived(latestDay(data.all.rows));
	function onDrill(drill: DashboardDrill): void {
		void goto(drillHref(drill, filter, anchorDay));
	}
	const select: DashboardSelect = {
		get selection() {
			return filter.selection;
		},
		toggle(dimension, value) {
			filter.selection = toggleSelection(filter.selection, dimension, value);
		}
	};
	/** The band emptied under the focus: the period control is the filter that is still there. */
	function focusPeriod(): void {
		document.querySelector<HTMLElement>('input[name="dashboard-period"]:checked')?.focus();
	}
	// The read left rows out (the limit): say so next to the count, in one sentence.
	const summary = $derived.by(() => {
		const base = m['dashboard.summary']({ count: formatCount(data.totalCount) });
		if (!data.truncated) return base;
		const note = m['dashboard.truncatedNote']({ limit: formatCount(DASHBOARD_ROW_LIMIT) });
		return m['dashboard.summaryWithNote']({ summary: base, note });
	});

	/**
	 * The one-column display (`DashboardWidgetStack`, §4.13.7 a). On its own - a copy without the
	 * dock - it is the page's only display: always shown, every registered widget. The dock's
	 * region below narrows both: shown only while the page is too narrow for the dock, and only
	 * the widgets the arrangement shows.
	 */
	const stackView: { shown: () => boolean; shows: (id: string) => boolean } = {
		shown: () => true,
		shows: () => true
	};
	const stacked = $derived(stackView.shown());
	const stackWidgets = $derived(DASHBOARD_WIDGETS.filter((def) => stackView.shows(def.id)));
	// [scaffold:dock] begin
	/**
	 * The dock (spec §5, @banto/dock-svelte) every widget is a panel of. Panels can be dragged to
	 * re-split, tabbed (drop on a pane's centre), floated (drag a tab out), auto-hidden to an edge
	 * band, and the dividers resize; the same from the keyboard (each title bar's "panel actions"
	 * menu). The whole arrangement auto-saves per user.
	 */
	const dock = createDockState();
	// Where a docked pane closed with its ✕ / unchecked in the View menu is shown again: its place
	// in the default layout. Not saved with the layout: given at every mount. A widget that is not
	// in the default opens floating.
	dock.defaultLayout = defaultDashboardLayout();
	// M12 (spec §12.1): saved under a UiSettingsProvider key (settings DB via Tauri/REST;
	// localStorage in demo mode). A per-user localStorage copy (`<storage key>:<owner>`) is the
	// synchronous first-paint source; the provider copy is reconciled once after mount. Both are
	// bound to the signed-in user and session (`scope` / `isCurrent`, three-pane-dock-plan §4.4).
	const dockLayout = createDockLayoutStore({
		dock,
		storageKey: DASHBOARD_LAYOUT_STORAGE_KEY,
		settingKey: DASHBOARD_LAYOUT_SETTING_KEY,
		provider: getUiSettings,
		scope: currentSessionScope(),
		isCurrent: isCurrentSessionScope,
		// "Reset layout" deletes what was saved: a default the author changes later reaches this user.
		reset: 'remove',
		// Only registered widgets; today's titles by id (dashboardLayout.ts).
		validate: validateDashboardLayout,
		// Nothing floats in the default, so it does not wait for the host to be measured.
		defaultLayout: defaultDashboardLayout
	});
	let dockHost: ReturnType<typeof DockHost> | undefined = $state();

	/** Kiosk: the saved arrangement is shown and nothing can be rearranged (three-pane-dock-plan §4.5). */
	const arrange = $derived(!settings.kiosk);

	/**
	 * The page's own width (the sidebar is outside it), measured by a zero-height element. At
	 * `STACK_MAX_WIDTH` or less the dock is not drawn and the stack is; `0` = not measured yet
	 * (the first frame draws neither, so a wide page never flashes the stack).
	 * `measuredWidth` is what the element reports; `pageWidth` is the width the display follows
	 * (taken over by the effect below the memo's wiring, which can hold the switch).
	 */
	const STACK_MAX_WIDTH = 900;
	let measuredWidth = $state(0);
	let pageWidth = $state(0);
	const dockShown = $derived(pageWidth > STACK_MAX_WIDTH);
	stackView.shown = () => pageWidth > 0 && pageWidth <= STACK_MAX_WIDTH;
	// What the arrangement shows (docked, a background tab included, or an open floating window),
	// read only: the stack never changes `dock`, so a narrow visit leaves the saved value as it is.
	stackView.shows = (id) => dock.panels.some((row) => row.id === id && row.visible);

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
	/** Memo closes being decided (the prompt, then the save / discard it chose). */
	let closing = $state(0);

	// An IME composition open somewhere in the document (`compositionstart` without its end; a
	// composition abandoned by moving the focus away ends with `focusout`). The same rule the dock
	// uses for its own structure changes (dock-svelte `core/lifecycle.ts`).
	let composing = $state(false);
	$effect(() => {
		const start = () => (composing = true);
		// Only when it changes: removing the focused element (the pane's pop-out / ✕ button)
		// fires `focusout` synchronously inside Svelte's block teardown, where writing `$state`
		// throws `state_unsafe_mutation` and aborts the close / pop-out. A composition open at
		// that moment is cleared on the next microtask instead.
		const end = () => {
			if (composing) queueMicrotask(() => (composing = false));
		};
		document.addEventListener('compositionstart', start, true);
		document.addEventListener('compositionend', end, true);
		document.addEventListener('focusout', end, true);
		return () => {
			document.removeEventListener('compositionstart', start, true);
			document.removeEventListener('compositionend', end, true);
			document.removeEventListener('focusout', end, true);
		};
	});

	/**
	 * The display follows the measured width - but swapping the dock for the stack (or back)
	 * re-creates the memo's textarea and unmounts the `DockHost`, so the swap WAITS while that
	 * would lose something (#886 review):
	 *  - an IME composition is open: the text being converted lives in the textarea, not yet in
	 *    the draft. The swap happens once the composition has ended and its text was taken;
	 *  - a close of the memo is being decided (`closing`): from the host's ask until the answer
	 *    is back - the question, and the save / discard chosen in it (the dialog is gone by then,
	 *    but the save may still be running). The host that asked would be gone, its pending close
	 *    stale: the text saved or dropped without the pane closing. The swap happens once the
	 *    close was applied or refused, on every way out.
	 * Taken over in the NEXT frame in any case: the measurement arrives from a ResizeObserver, and
	 * swapping other observed boxes within the same delivery is reported as a "ResizeObserver
	 * loop" error. (After `compositionend` this also lets the composition's last input land.)
	 */
	$effect(() => {
		const width = measuredWidth;
		if (composing || closing > 0) return;
		const frame = requestAnimationFrame(() => {
			pageWidth = width;
		});
		return () => cancelAnimationFrame(frame);
	});

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
	const beforePanelChange = trackClosePending(
		createPanelChangeHandler({
			// Serialized: a close waits for a save already in flight (PR #449 review).
			coordinator: memo.serial,
			ask: (dirtyKeys) => memoPrompt.ask(dirtyKeys),
			onSettled: (_panelId, result) => noteMemoSettled(result)
		}),
		(pending) => (closing += pending ? 1 : -1)
	);

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

	// Seed the default if nothing was restored from storage (an empty layout =
	// fresh visit). After seeding, a panel the user fully removed stays removed.
	$effect(() => {
		dockLayout.seedIfEmpty();
	});

	// M12: after the first paint, read the provider's copy once - it wins
	// (also over a move made meanwhile); nothing saved / a failure restores the
	// default. A read for a session that has ended is dropped.
	let layoutLoaded = $state(false);
	$effect(() => untrack(() => void dockLayout.load().finally(() => (layoutLoaded = true))));

	// Autosave (#791): `DockHost` reports a settled layout to `dockLayout.commit`
	// (`onLayoutCommit` below) - the end of a move / resize, a dock / undock / tab /
	// close, a View menu choice, the page's own `dock.*` call - never a step of a
	// drag. The local copy saves immediately; the provider gets one write 500ms
	// after the last report. A layout the store applied is not written back.
	//
	// Every report goes through `reportLayout` (#1019): the store answers what became of each one
	// (saved / failed / ...), and `layoutSaves` turns that into "the layout as it is from now on is
	// saved" for the pop-out's `restore` below, which must not forget a widget before that.
	const layoutSaves = createLayoutSaveWatch();
	const reportLayout: typeof dockLayout.commit = (layout, reason) => {
		const outcome = dockLayout.commit(layout, reason);
		layoutSaves.track(outcome);
		return outcome;
	};

	// Unmount: flush (not drop) a pending provider save, so navigating away
	// right after a drag still persists the final layout - unless the session
	// changed (that is what unmounts the page on a user switch).
	$effect(() => () => dockLayout.dispose());

	// "Reset layout": the host puts the default in (asked through
	// `beforePanelChange` like any replacement) and reports it as `'reset'`,
	// for which the store DELETES the saved value (`reset: 'remove'`).
	//
	// #1021: the default has every widget in the dock, so a widget that is out in a window of its
	// own (the pop-out below) would be on screen twice. Once the default is in, those windows are
	// closed - and only then: a reset that was refused (the memo's unapplied input, a change made
	// meanwhile) leaves them alone. Every widget's id is passed, not only the ones the pop-out
	// remembers: the plugin closes just the windows it has, a window nobody remembered included.
	// A window that cannot be closed (the capability lacks `banto-tauri-panel:allow-close`) stays,
	// and its widget stays "in a window" in the View menu; closing it by hand is harmless then
	// (`restore`'s `dock.open` does nothing for a docked widget).
	//
	// The windows go at once, but the pop-out's memory of those widgets waits for the reset to be
	// saved (`saved`, like `restore` below - #1019): until then the provider still holds the layout
	// WITHOUT them, and a start after a failed / dropped write, or after the app was closed first,
	// would read that layout with nothing left to say the widgets are missing. Kept, the next
	// `connect()` puts them back. Taken BEFORE the replacement: its report is the one that counts.
	// (A refused reset leaves this promise unused; a later save answers it to nobody.)
	//
	// #1042: an unsaved memo is asked about first, with the prompt a close of it shows; cancelled
	// (or a save that failed / was typed over) = no reset. Nothing unsaved = no question.
	async function resetDockLayout() {
		if (!dockHost) return;
		closing += 1;
		let go: boolean;
		try {
			go = await settleBeforeReset({
				coordinator: memo.serial,
				ask: (dirtyKeys) => memoPrompt.ask(dirtyKeys),
				onSettled: noteMemoSettled
			});
		} finally {
			closing -= 1;
		}
		const host = dockHost;
		if (!go || !host) return;
		const saved = layoutSaves.next();
		void host
			.replaceLayout(defaultDashboardLayout(), { saved: true, commit: 'reset' })
			.then(async (outcome) => {
				if (outcome !== 'applied') return;
				const { failed } = await popOut.closeWindows(
					DASHBOARD_WIDGETS.map((def) => def.id),
					{ saved }
				);
				if (failed.length > 0) {
					console.error(
						`closing the pop-out windows failed: ${failed.map((f) => f.id).join(', ')}`,
						failed[0].error
					);
				}
			});
	}

	const widgetOf = (id: string) => DASHBOARD_WIDGETS.find((def) => def.id === id);

	/**
	 * #663 ①-C: the View menu (PageViewMenu - the menu bar's "表示" when the
	 * bar is on screen, else a button in this page's header) replaces the old
	 * dock toolbar. One checkbox per registered widget, in the registry's
	 * order, checked = on screen (docked, a background tab included, or an open
	 * floating window), read from `dock.panels` so a refused / stale change
	 * shows the real state. Checking a widget that is not in the arrangement is
	 * how one is ADDED (§4.13.3): it opens as a floating window, to be docked
	 * where the user wants it. Not offered in kiosk mode, nor while the page
	 * shows the one-column display (nothing can be rearranged there).
	 * (`viewMenuItems` itself is below the pop-out wiring, which it reads.)
	 */
	function setPanelVisible(id: string, visible: boolean): void {
		if (!dockHost) return;
		if (visible) {
			// A panel never shown yet is not in the layout: add it as a closed-
			// or-open floating window first (a no-op for an id already docked or
			// floating), then show it - a pane hidden from the dock goes back to
			// its former slot.
			const def = widgetOf(id);
			if (def) dock.ensureWindow(def, dockHostW, dockHostH);
		}
		// Hiding goes through the dock lifecycle like ✕ (closing discards the
		// pane's content, so the memo's unapplied input is settled first).
		void dockHost.setPanelVisible(id, visible);
	}

	/**
	 * v2 pop-out (spec §5.3, Tauri only): dragging a panel out via
	 * dock-svelte's `onPopOut` affordance (⧉ button) opens it as a REAL
	 * native window (the `banto-tauri-panel` plugin -> routes/panel/[id])
	 * instead of a pseudo-window. The panel is hidden from THIS dock - undocked
	 * (if docked) then closed (if floating) - but its floating geometry is
	 * preserved, so `dock.open(id)` (`restore`, on window-close) restores it
	 * exactly where it was. `popOut.onPopOut` is `undefined` in browser mode:
	 * DockHost then renders no pop-out button at all (see its doc comment).
	 * The plugin remembers each window's position and size and closes the
	 * panel windows with the main window (ADR-0037); nothing here does.
	 */
	const popOutOwner = currentSessionScope().owner;
	const popOut = createAppPanelPopOut<PanelContent>({
		// Which widgets are out in a window, kept for the next start (#1013), per user like the
		// layout that lacks them. Without a confirmed owner nothing is kept.
		storageKey: popOutOwner === null ? null : `${DASHBOARD_POPOUT_STORAGE_KEY}:${popOutOwner}`,
		// Popping out leaves this dock like a close does, so it goes through the
		// host's lifecycle (`closePanel`: beforePanelChange settles the memo's
		// unapplied input, and a structure change made while that waits makes
		// it `stale`). Only an applied close pops out; the close already
		// undocked + closed the pane with its geometry kept. (The pop-out
		// window shows MemoWidget's static memo text, not this page's draft.)
		detach: async (content) => (await dockHost?.closePanel(content.id)) === 'applied',
		// Round-trip contract (spec §5.3 v2): when a popped-out panel's native
		// window is closed, the plugin emits `banto://panel-closed` with that
		// panel's id - `dock.open` brings it back as a floating pseudo-window at
		// its preserved geometry. (If the panel had been docked, `detach`'s
		// `closePanel` above took it out of the docked tree as a closed floating
		// window hidden from the dock - the same path as the pane's ✕.
		// `dock.open` opens it floating; the View menu's `showPanel` would dock
		// it at its default place.) Also runs if the window could not be opened.
		//
		// What it returns (#1019): "the layout with the widget back in it is saved". The saved
		// layout lacks the widget since the pop-out, and at the next start the provider's copy wins
		// over this browser's - so until that write has landed the pop-out keeps the id in its
		// memory, and a start after a failed write puts the widget back again. Taken BEFORE the
		// dock changes: only a report made from here on carries the widget. A write that fails
		// leaves it pending (nothing retries here; the next start does), and a later report that is
		// saved resolves it - then the layout as the user left it is what counts, a widget closed
		// again included.
		restore: (id) => {
			const saved = layoutSaves.next();
			dock.open(id);
			// The host reports a settled layout to be saved (`onLayoutCommit`), but the one-column
			// display (900px or less) unmounts it: report this one ourselves there, so a widget put
			// back while the page is narrow is saved - and shown by the stack, which reads `dock`.
			if (!dockHost) void reportLayout(dock.layout, 'user');
			return saved;
		},
		// The pop-out did not happen: the window could not be opened (then
		// `restore` has already run), or the closed-notice subscription failed
		// (then nothing was detached, so the panel is still here). A real app
		// shows this in its own notification surface.
		onError: (error, content) => console.error(`pop-out of "${content.id}" failed`, error),
		// The plugin could not say which windows are open (the capability lacks
		// `banto-tauri-panel:allow-list`): nothing was put back, the widgets stay "in a window" in
		// the View menu, where selecting one opens its window again.
		onListError: (error) => console.error('listing the pop-out windows failed', error)
	});
	const onPopOut = popOut.onPopOut;

	// No-op in browser mode. Connecting also puts back the widgets that were out in a window whose
	// window is gone (#1013: the app was closed with it open), so it waits until that sticks: the
	// provider's layout has been read (it replaces what is shown, a restored widget included). It
	// does NOT wait for the host: the one-column display (900px or less) has no `DockHost`, and a
	// window closed there must still come back (`restore` saves the layout itself then). A pop-out
	// pressed before that is remembered and reconciled by this same `connect()`.
	$effect(() => {
		if (!layoutLoaded) return;
		return untrack(() => popOut.connect());
	});

	const viewMenuItems: PageViewMenuItem[] = $derived.by(() => {
		const visible = new Map(dock.panels.map((row) => [row.id, row.visible]));
		return [
			...DASHBOARD_WIDGETS.map((def): PageViewMenuItem => {
				// #1014: a widget that is out in a window of its own is on screen too, though this
				// dock holds it as closed. Selecting it brings that window to the front - showing
				// it here would put a second copy into the dock. Its window's ✕ is what closes it.
				if (popOut.isPoppedOut(def.id)) {
					return {
						kind: 'checkbox',
						id: `panel:${def.id}`,
						label: def.title,
						checked: true,
						onSelect: () =>
							void popOut
								.focus(def)
								.catch((error) => console.error(`focusing "${def.id}" failed`, error))
					};
				}
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
				onSelect: () => void resetDockLayout()
			}
		];
	});
	// [scaffold:dock] end
</script>

<div class="page">
	<PageHeader hideTitle title={m['nav.dashboard']()} description={summary}>
		{#snippet actions()}
			<SegmentedControl
				name="dashboard-period"
				size="sm"
				label={m['dashboard.periodLabel']()}
				options={periodOptions}
				bind:value={filter.period}
			/>
			<!-- [scaffold:dock] begin -->
			{#if arrange && dockShown}
				<PageViewMenu label={m['dashboard.viewMenu']()} items={viewMenuItems} />
			{/if}
			<!-- [scaffold:dock] end -->
			<AnnotationButton />
		{/snippet}
	</PageHeader>

	<!-- At the page root, not in PageHeader's actions: the header is a
	     containing block for fixed descendants (annotation.svelte.ts). -->
	<AnnotationDrawer>
		<p>{m['dashboard.aboutNote']({ count: formatCount(data.totalCount) })}</p>
	</AnnotationDrawer>

	<DashboardSelectionBar
		{filter}
		{anchorDay}
		truncated={data.truncated}
		onClear={(dimension) => select.toggle(dimension, '')}
		onClearAll={() => (filter.selection = {})}
		onEmptied={focusPeriod}
	/>

	<DashboardKpiStrip {data} {filter} />

	<!-- [scaffold:dock] begin -->
	<div class="page-measure" bind:clientWidth={measuredWidth}></div>
	<!-- [scaffold:dock] end -->
	{#if data.loading && data.all.rows.length === 0}
		<LoadingState label={m['items.loadingData']()} />
	{:else}
		<!-- [scaffold:dock] begin -->
		{#if dockShown}
			<div
				class="dock-wrapper"
				style:height="{dashboardDockHeight()}px"
				bind:clientWidth={dockHostW}
				bind:clientHeight={dockHostH}
			>
				<DockHost
					bind:this={dockHost}
					{dock}
					{arrange}
					panel={dockPanel}
					iconContent={dockIcon}
					{onPopOut}
					{beforePanelChange}
					isEscapeBlocked={isDockEscapeBlocked}
					messages={dockMessages()}
					onLayoutCommit={reportLayout}
				/>
			</div>
		{/if}
		<!-- [scaffold:dock] end -->
		{#if stacked}
			<DashboardWidgetStack widgets={stackWidgets} {data} {onDrill} {select} />
		{/if}
	{/if}
	<!-- [scaffold:dock] begin -->
	<!-- Outside the dock: the memo is editable in the one-column display too, and a close asked in
	     the dock is answered here whichever display is on screen by then. -->
	<DraftSettleDialog
		prompt={memoPrompt}
		title={m['dashboard.memoCloseTitle']()}
		body={m['dashboard.memoCloseBody']()}
		applyLabel={m['dashboard.memoCloseApply']()}
		discardLabel={m['dashboard.memoCloseDiscard']()}
	/>
	<!-- [scaffold:dock] end -->
</div>
<!-- [scaffold:dock] begin -->

{#snippet dockIcon(icon: string)}
	<PanelIcon {icon} />
{/snippet}

{#snippet dockPanel(content: PanelContent)}
	<!--
		The body is the registered widget's component (dashboardWidgets.ts), drawn
		by the frame that measures the pane and hands the widget its height. The
		SAME component renders this panel's content standalone at
		routes/panel/[id] once popped out into a real Tauri window, so it can't
		depend on anything from this page beyond its props.
	-->
	{@const widget = widgetOf(content.id)}
	<div class="dock-panel">
		{#if widget}
			<DashboardWidgetFrame {widget} {data} {onDrill} {select} />
		{:else}
			<p class="dock-status">{m['dashboard.unknownPanel']()}</p>
		{/if}
	</div>
{/snippet}

<!-- [scaffold:dock] end -->

<style>
	.page {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
	}

	/* The KPI strip's rules live in DashboardKpiStrip.svelte; the one-column display's in
	   DashboardWidgetStack.svelte. */

	/* Measures the page's width for the dock / one-column switch. Out of the flow (no gap of the
	   column goes to it) and never seen. */
	.page-measure {
		position: absolute;
		inset-inline: 0;
		top: 0;
		height: 0;
		visibility: hidden;
		pointer-events: none;
	}

	/* The dock's box. Its height is the rows of the default arrangement (dashboardLayout.ts), set
	   inline; the page scrolls. */
	.dock-wrapper {
		min-width: 0;
	}

	.dock-panel {
		height: 100%;
		box-sizing: border-box;
		padding: var(--banto-space-3);
	}

	/* A panel id the registry does not know. Caption-style. */
	.dock-status {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
		text-wrap: pretty;
	}
</style>
