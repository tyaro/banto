<script lang="ts">
	/**
	 * The three-pane screen on a dock (Issue #663 stage ④ PR-6, docs/design/three-pane-dock-plan.md;
	 * deletable together with `/tree` or with `@banto/dock-svelte`, docs/template-scope.md §3): the
	 * same parts as `/tree/workspace` (`../workspace/Workspace*.svelte`: they know nothing of the
	 * frame), laid out by `ThreePaneDock` instead of the fixed `ThreePaneLayout`.
	 *
	 * - This page holds every piece of state (the URL = target / tab / row, the settings draft), so
	 *   floating, re-docking, tabbing or hiding a pane never loses a draft and never asks anything
	 *   (plan §4.7). Leaving the (target, tab) the draft belongs to asks first, exactly like
	 *   `/tree/workspace` (the confirm below is the same code).
	 * - The centre (the tabs) is the dock's main region: never closed, floated or re-mounted by a
	 *   rearrangement (plan §4.2), so what is typed there and the tab's focus survive.
	 * - The "View" menu (`PageViewMenu`, the menu bar's 表示) comes from `viewMenuItems()`; the
	 *   toolbar buttons call `toggle` / `float` / `dockBack` and read the pressed state from
	 *   `leftOpen` / `rightOpen` (no strip of toggles, plan §4.8).
	 * - The layout is saved per user and screen (plan §4.4): what `onLayoutCommit` reports (#791:
	 *   a settled `layoutSnapshot()`, never a step of a drag or of the narrow switch) goes to
	 *   `dockLayoutStore` through `threePaneLayoutTarget.ts`; "reset layout" (reason `'reset'`)
	 *   saves the default as a user's change.
	 * - Narrow (<= 900px of the component) is the dock's own narrow display (the panes are edge bands
	 *   whose flyout is the drawer); kiosk (`settings.kiosk`) is `arrange={false}` (plan §4.5): the
	 *   saved layout is shown, nothing can be rearranged, no View menu or toolbar. Touch needs no
	 *   wiring: the title-bar and drop-guide buttons follow the density tokens.
	 */
	import { beforeNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { guardUnsavedChanges } from '@banto/forms';
	import {
		createDockState,
		ThreePaneDock,
		type ThreePaneLayoutCommitReason,
		type ThreePaneSavedLayout
	} from '@banto/dock-svelte';
	import { EmptyState, PageHeader, Tabs } from '@banto/ui';
	import { tick, untrack } from 'svelte';
	import { isDockEscapeBlocked } from '#lib/banto/dockEscape.js';
	import { dockMessages } from '#lib/banto/dockMessages.js';
	import { createDockLayoutStore } from '#lib/banto/dockLayoutStore.svelte.js';
	import { getUiSettings } from '#lib/banto/setup.js';
	import { confirmAction, confirmStore } from '#lib/confirm.svelte.js';
	import PageViewMenu, { type PageViewMenuItem } from '#lib/components/PageViewMenu.svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { settings } from '#lib/settings.svelte.js';
	import { isForcedNavigation } from '#lib/unsavedChanges.js';
	import WorkspaceDetail from '../workspace/WorkspaceDetail.svelte';
	import WorkspaceList from '../workspace/WorkspaceList.svelte';
	import WorkspaceSettings from '../workspace/WorkspaceSettings.svelte';
	import WorkspaceTree from '../workspace/WorkspaceTree.svelte';
	import {
		findWorkspaceRow,
		hasWorkspaceRow,
		hasWorkspaceTarget,
		initialSettings,
		settingsEqual,
		targetLabel,
		workspaceNodes,
		workspaceRows,
		type WorkspaceSettings as Settings
	} from '../workspace/workspaceSample.js';
	import {
		parseWorkspaceView,
		sameWorkspaceScope,
		workspaceSearch,
		type WorkspaceTab,
		type WorkspaceView
	} from '../workspace/workspaceUrl.js';
	import { createThreePaneLayoutTarget } from './threePaneLayoutTarget.js';

	const lookup = { hasTarget: hasWorkspaceTarget, hasRow: hasWorkspaceRow };
	const parse = (url: { searchParams: { get(name: string): string | null } }): WorkspaceView =>
		parseWorkspaceView(url.searchParams, lookup);

	// --- state = the URL -------------------------------------------------------

	const view = $derived(parse(page.url));
	const targetName = $derived(view.target ? targetLabel(view.target) : null);
	const rows = $derived(view.target ? workspaceRows(view.target) : []);
	const selectedRow = $derived(
		view.target && view.row ? findWorkspaceRow(view.target, view.row) : null
	);

	/** The path itself comes from `resolve` (it carries the base path); only the query is ours. */
	const here = (next: WorkspaceView): string =>
		`${resolve('tree/workspace-dock')}${workspaceSearch(next)}`;

	/** A new target pushes a history entry; a tab or row change replaces the current one. */
	const replaces = (from: WorkspaceView, to: WorkspaceView): boolean => from.target === to.target;

	function go(next: WorkspaceView): void {
		void goto(here(next), { replace: replaces(view, next), reset: false });
	}

	// --- the settings draft ----------------------------------------------------

	let saved = $state<Record<string, Settings>>({});
	const savedFor = (id: string): Settings => saved[id] ?? initialSettings(id);

	// svelte-ignore state_referenced_locally
	let draftFor = $state<string | null>(view.target);
	// svelte-ignore state_referenced_locally
	let draft = $state<Settings>(initialSettings(view.target ?? ''));
	let savedNotice = $state(false);

	// The draft belongs to one target: arriving on another one (after the guard
	// let it through) starts from that target's saved settings.
	$effect.pre(() => {
		const target = view.target;
		untrack(() => {
			if (draftFor === target) return;
			draftFor = target;
			draft = { ...savedFor(target ?? '') };
			savedNotice = false;
		});
	});

	const dirty = $derived(view.target !== null && !settingsEqual(draft, savedFor(view.target)));

	$effect(() => {
		if (dirty) savedNotice = false;
	});

	function save(): void {
		if (!view.target) return;
		saved[view.target] = { ...draft };
		savedNotice = true;
	}

	function discard(): void {
		draft = { ...savedFor(view.target ?? '') };
	}

	// --- leaving with unsaved settings (the same as /tree/workspace) ----------------

	guardUnsavedChanges({
		isDirty: () => dirty,
		beforeNavigate,
		message: () => m['tree.workspace.confirmMessage'](),
		isForced: isForcedNavigation,
		confirm: () => true
	});

	/** True while the page carries on with a move the user agreed to (the guard must not ask again). */
	let proceeding = false;
	/** Set for the one history walk that follows an agreed Back / Forward. */
	let retracing = false;

	beforeNavigate((navigation) => {
		if (retracing) {
			retracing = false;
			return;
		}
		if (proceeding || !dirty) return;
		// Reload / tab close / leaving the site: the package guard cancels so the browser asks.
		if (navigation.type === 'leave' || navigation.willUnload || !navigation.to) return;
		if (isForcedNavigation(navigation)) return;
		if (navigation.to.url.pathname === page.url.pathname) {
			// Only the row changed: the draft stays where it is.
			if (sameWorkspaceScope(parse(navigation.to.url), view)) return;
		}
		navigation.cancel();
		void askThenGo(
			navigation.to.url,
			navigation.type === 'popstate' ? (navigation.delta ?? null) : null
		);
	});

	/**
	 * After a refused move the browser focus sits on what the user just clicked (a
	 * tree row, a tab) while the screen still shows the old one: put it on the
	 * control that matches what is shown.
	 */
	async function refocusShown(opener: Element | null): Promise<void> {
		await tick();
		await new Promise<void>((done) => requestAnimationFrame(() => done()));
		if (confirmStore.current) return; // a newer question is open: leave the focus to it
		const within = (selector: string) => opener?.closest(selector) != null;
		const target = within('[role="tablist"]')
			? '[role="tab"][aria-selected="true"]'
			: within('.workspace-tree')
				? '.workspace-tree [role="treeitem"][aria-selected="true"]'
				: null;
		if (target) document.querySelector<HTMLElement>(target)?.focus();
	}

	async function askThenGo(to: URL, delta: number | null): Promise<void> {
		const opener = document.activeElement;
		// The root layout's ConfirmHost answers an open question "cancel" from its own
		// beforeNavigate callback, which may run after this one for the same
		// navigation: ask only once every callback has run.
		await Promise.resolve();
		const agreed = await confirmAction({
			title: m['tree.workspace.confirmTitle'](),
			message: m['tree.workspace.confirmMessage'](),
			confirmLabel: m['tree.workspace.confirmDiscard'](),
			cancelLabel: m['tree.workspace.confirmKeep'](),
			danger: true
		});
		if (!agreed) {
			await refocusShown(opener);
			return;
		}
		if (delta) {
			// Back / Forward: walk the history again instead of pushing a new entry, so
			// the entries (and the forward ones) stay as they were.
			discard();
			retracing = true;
			history.go(delta);
			return;
		}
		const next = to.pathname === page.url.pathname ? parse(to) : null;
		discard();
		proceeding = true;
		try {
			await goto(to, {
				replace: next ? replaces(view, next) : false,
				reset: false
			});
		} finally {
			proceeding = false;
		}
	}

	// --- picks -------------------------------------------------------------------

	function selectTarget(id: string): void {
		if (id === view.target) return;
		go({ target: id, tab: view.tab, row: null });
	}

	function setTab(tab: string): void {
		if (tab === view.tab) return;
		go({ target: view.target, tab: tab as WorkspaceTab, row: null });
	}

	function selectRow(id: string): void {
		go({ ...view, row: id });
		// Narrow: the details are in an edge band; slide them out for the row just picked.
		if (narrow) void three?.setVisible('right', true);
	}

	// --- the dock ----------------------------------------------------------------

	/** Kiosk: the saved layout is shown and nothing can be rearranged (plan §4.5). */
	const arrange = $derived(!settings.kiosk);

	const DOCK_STORAGE_KEY = 'banto.dock.threePane.workspace';
	/** `UiSettingsProvider` key (`[A-Za-z0-9._-]{1,64}`): one layout per user and screen. */
	const DOCK_SETTING_KEY = 'dock.threePane.workspace';

	const dock = createDockState();
	let three: ReturnType<typeof ThreePaneDock> | undefined = $state();
	let leftOpen = $state(true);
	let rightOpen = $state(true);
	let narrow = $state(false);

	const layoutTarget = createThreePaneLayoutTarget(dock, () => three);
	const layoutStore = createDockLayoutStore({
		dock: layoutTarget,
		storageKey: DOCK_STORAGE_KEY,
		settingKey: DOCK_SETTING_KEY,
		provider: getUiSettings,
		defaultLayout: () => layoutTarget.defaultLayout
	});

	// Once mounted: remember what the dock started with, then read the provider's copy once - it
	// wins (also over a move made meanwhile); nothing saved or a failure restores the default. A
	// read for a session that has ended is dropped (dockLayoutStore.svelte.ts). What is shown at
	// mount is mirrored into the local copy (it is the store's baseline: nothing goes to the provider).
	$effect(() => {
		if (!three) return;
		untrack(() => {
			layoutTarget.attach();
			void layoutStore.load();
			layoutStore.changed(layoutTarget.serialize());
		});
	});

	/**
	 * Autosave (#791): the dock reports a settled layout to save - the end of a move / resize, a
	 * dock / float / tab / close, a View menu choice; the kept wide layout while narrow - never a
	 * step in between. The local copy saves at once; the provider gets one write 500ms after the
	 * last report. `'reset'` ("reset layout" was applied; the dock installed the default itself) is
	 * saved as a user's change even when the default was already shown. A layout the store applied
	 * (the provider's copy, `restoreLayout`) is not reported. The text comes from `layoutTarget`: it
	 * is the reported value, except while a stored layout is still being installed.
	 */
	function saveLayout(_saved: ThreePaneSavedLayout, reason: ThreePaneLayoutCommitReason): void {
		if (reason === 'reset') layoutTarget.withoutApplying(() => layoutStore.reset());
		else layoutStore.changed(layoutTarget.serialize());
	}

	// Unmount: flush (not drop) a pending provider save - unless the session changed.
	$effect(() => () => layoutStore.dispose());

	/** The panes' View menu entries (checked from the dock's state) and "reset layout". */
	const viewMenuItems: PageViewMenuItem[] = $derived(
		three?.viewMenuItems({ resetLayout: m['dashboard.resetLayout']() }) ?? []
	);

	const leftFloating = $derived(dock.layout.floating.some((w) => w.id === 'left' && w.open));

	const tabs = $derived([
		{ id: 'list', label: m['tree.workspace.tabList']() },
		{ id: 'settings', label: m['tree.workspace.tabSettings']() }
	]);

	// The shared dock strings (`dock.*`) + this page's own three pane names.
	const paneDockMessages = $derived(
		dockMessages({
			threePaneLeft: () => m['tree.workspace.paneTree'](),
			threePaneCenter: () => m['tree.workspaceDock.paneCenter'](),
			threePaneRight: () => m['tree.workspace.paneDetail']()
		})
	);

	// A pick in the tree takes effect: narrow, the tree's flyout slides back in.
	$effect(() => {
		void view.target;
		untrack(() => dock.closeFlyout());
	});
</script>

<div class="page">
	<PageHeader
		hideTitle
		title={m['tree.workspaceDock.title']()}
		description={targetName ?? undefined}
	>
		{#snippet actions()}
			{#if arrange}
				<div class="toolbar" role="group" aria-label={m['tree.workspaceDock.toolbarLabel']()}>
					<button
						type="button"
						class="banto-btn banto-btn--ghost"
						aria-pressed={leftOpen}
						onclick={() => void three?.toggle('left')}
					>
						{m['tree.workspace.paneTree']()}
					</button>
					<button
						type="button"
						class="banto-btn banto-btn--ghost"
						aria-pressed={rightOpen}
						onclick={() => void three?.toggle('right')}
					>
						{m['tree.workspace.paneDetail']()}
					</button>
					{#if leftFloating}
						<button
							type="button"
							class="banto-btn banto-btn--ghost"
							onclick={() => void three?.dockBack('left')}
						>
							{m['tree.workspaceDock.dockTree']()}
						</button>
					{:else}
						<button
							type="button"
							class="banto-btn banto-btn--ghost"
							disabled={!leftOpen}
							onclick={() => void three?.float('left')}
						>
							{m['tree.workspaceDock.floatTree']()}
						</button>
					{/if}
				</div>
				<PageViewMenu label={m['dashboard.viewMenu']()} items={viewMenuItems} />
			{/if}
		{/snippet}
	</PageHeader>

	<div class="frame">
		<ThreePaneDock
			bind:this={three}
			bind:leftOpen
			bind:rightOpen
			bind:narrow
			{dock}
			initialLayout={layoutTarget.initialLayout}
			onLayoutCommit={saveLayout}
			{arrange}
			messages={paneDockMessages}
			isEscapeBlocked={isDockEscapeBlocked}
		>
			{#snippet left()}
				<WorkspaceTree nodes={workspaceNodes} selectedId={view.target} onSelect={selectTarget} />
			{/snippet}
			{#snippet right()}
				<WorkspaceDetail row={selectedRow} />
			{/snippet}

			<div class="center" data-testid="workspace-dock-center">
				{#if view.target === null || targetName === null}
					<EmptyState
						title={m['tree.workspace.emptyTitle']()}
						description={m['tree.workspace.emptyHint']()}
					/>
				{:else}
					<Tabs {tabs} label={m['tree.workspace.tabsLabel']()} bind:value={() => view.tab, setTab}>
						{#snippet panel(id)}
							<div class="body">
								{#if id === 'settings'}
									<WorkspaceSettings
										{targetName}
										bind:draft
										{dirty}
										{savedNotice}
										onSave={save}
										onDiscard={discard}
									/>
								{:else}
									<WorkspaceList
										{targetName}
										{rows}
										selectedRowId={view.row}
										onSelectRow={selectRow}
									/>
								{/if}
							</div>
						{/snippet}
					</Tabs>
				{/if}
			</div>
		</ThreePaneDock>
	</div>
</div>

<style>
	/* Same sizing as /tree/workspace: the page takes the viewport minus the shell's vertical room
	   and the frame fills what is left. The floor keeps it usable on a 1366x768 screen at 125%. */
	.page {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-3);
		height: max(
			26rem,
			calc(
				100dvh -
					var(
						--banto-shell-main-block-inset,
						calc(var(--banto-shell-header-height) + var(--banto-space-5) * 2)
					)
			)
		);
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-1);
	}

	/* The pressed state of the toggles (the pane is shown): the same tint as a selected row. */
	.toolbar button[aria-pressed='true'] {
		background: color-mix(in srgb, var(--banto-primary) 14%, transparent);
	}

	.body {
		padding: var(--banto-space-3);
	}

	.frame {
		flex: 1;
		min-height: 0;
	}

	.center {
		min-height: 100%;
	}
</style>
