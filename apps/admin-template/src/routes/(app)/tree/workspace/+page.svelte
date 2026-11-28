<script lang="ts">
	/**
	 * Three-pane screen pattern (Issue #631 PR③; deletable together with `/tree`,
	 * docs/template-scope.md §3): the menu bar = functions, the left tree = the
	 * target, the centre tabs ("list" / "settings") = the work on it, the right
	 * pane = the details of the row selected in the list.
	 *
	 * - The panes' contents are separate parts (`Workspace*.svelte`) that know
	 *   nothing of `ThreePaneLayout`: this page holds every piece of state and
	 *   passes it down as props, so the same parts can later be laid out by
	 *   `@banto/dock-svelte` instead of the fixed frame.
	 * - URL = the screen's state (`?target=&tab=&row=`, `workspaceUrl.ts`): a
	 *   reload, Back/Forward and a shared link land on the same screen. Every
	 *   change goes through `goto` (so `page.url` is the one source of truth and
	 *   the guard below sees every move): a new target pushes a history entry,
	 *   a tab or row change replaces it.
	 * - Unsaved settings: leaving the (target, tab) the draft belongs to - another
	 *   target in the tree, the other tab, Back/Forward, another page - first asks
	 *   with the in-page confirm dialog. Cancel keeps the screen exactly as it
	 *   was (the tree's highlight, the tab and the focus included); discard drops
	 *   the draft and carries on. A reload or tab close gets the browser's own
	 *   prompt (`@banto/forms`' guard, which also covers the desktop window close).
	 */
	import { beforeNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { guardUnsavedChanges } from '@banto/forms';
	import { EmptyState, PageHeader, Tabs, ThreePaneLayout } from '@banto/ui';
	import { tick, untrack } from 'svelte';
	import { confirmAction, confirmStore } from '#lib/confirm.svelte.js';
	import * as m from '#lib/paraglide/messages.js';
	import { isForcedNavigation } from '#lib/unsavedChanges.js';
	import WorkspaceDetail from './WorkspaceDetail.svelte';
	import WorkspaceList from './WorkspaceList.svelte';
	import WorkspaceSettings from './WorkspaceSettings.svelte';
	import WorkspaceTree from './WorkspaceTree.svelte';
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
	} from './workspaceSample.js';
	import {
		parseWorkspaceView,
		sameWorkspaceScope,
		workspaceSearch,
		type WorkspaceTab,
		type WorkspaceView
	} from './workspaceUrl.js';

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
		`${resolve('tree/workspace')}${workspaceSearch(next)}`;

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

	// --- leaving with unsaved settings ------------------------------------------

	// The package guard keeps the registry (the desktop window close) and answers
	// reload / tab close with the browser's own prompt. Its synchronous
	// `window.confirm` is replaced for in-app moves by the dialog below, so it
	// is told to let those through.
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
		if (narrow) rightDrawerOpen = true;
	}

	// --- the frame ---------------------------------------------------------------

	let narrow = $state(false);
	let leftDrawerOpen = $state(false);
	let rightDrawerOpen = $state(false);

	// The drawer closes once the pick has really taken effect (not while a confirm is asked).
	$effect(() => {
		void view.target;
		untrack(() => (leftDrawerOpen = false));
	});

	const tabs = $derived([
		{ id: 'list', label: m['tree.workspace.tabList']() },
		{ id: 'settings', label: m['tree.workspace.tabSettings']() }
	]);

	const frameMessages = $derived({
		threePaneLeft: () => m['tree.workspace.paneTree'](),
		threePaneRight: () => m['tree.workspace.paneDetail'](),
		threePaneResizeLeft: () => m['tree.workspace.resizeTree'](),
		threePaneResizeRight: () => m['tree.workspace.resizeDetail'](),
		overlayClose: () => m['common.close']()
	});
</script>

<div class="page">
	<PageHeader hideTitle title={m['tree.workspace.title']()} />

	<div class="frame">
		<ThreePaneLayout
			title={targetName ?? undefined}
			bind:narrow
			bind:leftDrawerOpen
			bind:rightDrawerOpen
			messages={frameMessages}
		>
			{#snippet left()}
				<WorkspaceTree nodes={workspaceNodes} selectedId={view.target} onSelect={selectTarget} />
			{/snippet}
			{#snippet right()}
				<WorkspaceDetail row={selectedRow} />
			{/snippet}

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
		</ThreePaneLayout>
	</div>
</div>

<style>
	/* The shell's <main> gives its children no height, so the page takes the viewport
	   minus the shell's vertical room (header, main padding, dock reserve: the
	   shell's --banto-shell-main-block-inset), and the frame fills what is left.
	   The floor keeps the frame usable on a 1366x768 screen at 125%. */
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

	.body {
		padding: var(--banto-space-3);
	}

	.frame {
		flex: 1;
		min-height: 0;
	}
</style>
