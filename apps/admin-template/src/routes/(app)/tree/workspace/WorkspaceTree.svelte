<script lang="ts">
	/**
	 * Left pane of `/tree/workspace`: the target tree. A self-contained part - it
	 * knows nothing about `ThreePaneLayout` (no context, no frame types), so a
	 * later `@banto/dock-svelte` layout can place the same component in a dock
	 * window. The page owns the state: `selectedId` comes in, a pick goes out
	 * through `onSelect` (the page may refuse it, e.g. behind the unsaved-changes
	 * confirm - `selection` makes the tree snap back to what the page says).
	 *
	 * Badges: `label` snippet (count + the worst result). Right-click, the
	 * ContextMenu key and Shift+F10 reach `onContextMenu` once; it opens a `Menu`
	 * anchored to a zero-size button at the pointer (or the row's lower-left edge
	 * from the keyboard), and the focus goes back to the row when the menu closes.
	 */
	import { BantoTree, type TreeNode } from '@banto/tree-svelte';
	import { Menu, MenuItem, StatusBadge } from '@banto/ui';
	import { tick } from 'svelte';
	import { treeMessages } from '#lib/banto/i18n.js';
	import * as m from '#lib/paraglide/messages.js';
	import {
		targetSummary,
		type WorkspaceNodeData,
		type WorkspaceResult
	} from './workspaceSample.js';

	interface Props {
		nodes: TreeNode<WorkspaceNodeData>[];
		/** The selected target (null = none). */
		selectedId: string | null;
		/** A node was picked (click / keys). The page decides whether it takes effect. */
		onSelect: (id: string) => void;
	}

	let { nodes, selectedId, onSelect }: Props = $props();

	const treeMsg = treeMessages();

	const VARIANT: Record<WorkspaceResult, 'success' | 'warning' | 'danger'> = {
		ok: 'success',
		warn: 'warning',
		ng: 'danger'
	};
	const resultLabel = (result: WorkspaceResult): string =>
		result === 'ok'
			? m['tree.workspace.resultOk']()
			: result === 'warn'
				? m['tree.workspace.resultWarn']()
				: m['tree.workspace.resultNg']();

	let rootEl: HTMLDivElement | undefined = $state();
	let anchorEl: HTMLButtonElement | undefined = $state();
	let menuNode = $state<TreeNode<WorkspaceNodeData> | null>(null);
	let anchorAt = $state({ x: 0, y: 0 });
	let picked = $state('');

	async function openMenu(node: TreeNode<WorkspaceNodeData>, at: { x: number; y: number }) {
		menuNode = node;
		anchorAt = at;
		// The Menu learns that its popover closed from the `toggle` event, which comes
		// a task later. A right-click while a menu is open has just closed it (light
		// dismiss): let that reach the Menu first, or the click below would be taken
		// for "close" and nothing would reopen.
		const popover = rootEl?.querySelector<HTMLElement>('[popover]');
		if (popover?.matches(':popover-open')) {
			await new Promise<void>((done) => {
				popover.addEventListener('toggle', () => done(), { once: true });
				popover.hidePopover();
			});
		} else {
			await new Promise<void>((done) => setTimeout(done, 0));
		}
		await tick();
		anchorEl?.click();
	}

	/** The anchor is only a position: whenever it takes focus (the menu closing), hand it to the row. */
	function returnFocusToRow(): void {
		if (!menuNode) return;
		const id = CSS.escape(menuNode.id);
		rootEl?.querySelector<HTMLElement>(`[data-node-id="${id}"]`)?.focus();
	}

	function choose(action: string): void {
		if (menuNode) picked = m['tree.workspace.menuPicked']({ label: menuNode.label, action });
	}
</script>

{#snippet badges(node: TreeNode<WorkspaceNodeData>)}
	{@const summary = targetSummary(node.id)}
	<span class="name">{node.label}</span>
	<span class="badges">
		<span class="count">{m['tree.workspace.badgeCount']({ n: summary.count })}</span>
		{#if summary.worst !== 'ok'}
			<StatusBadge variant={VARIANT[summary.worst]} label={resultLabel(summary.worst)} />
		{/if}
	</span>
{/snippet}

<div class="workspace-tree" bind:this={rootEl}>
	<BantoTree
		{nodes}
		label={badges}
		autoExpandNewRoots
		selection={selectedId ? [selectedId] : []}
		onSelectionChange={(ids) => {
			const id = ids[0];
			if (id !== undefined && id !== selectedId) onSelect(id);
		}}
		onContextMenu={openMenu}
		messages={treeMsg}
	/>

	<Menu
		label={m['tree.workspace.menuLabel']({ label: menuNode?.label ?? '' })}
		placement="bottom-start"
	>
		{#snippet trigger(props)}
			<button
				{...props}
				bind:this={anchorEl}
				type="button"
				class="menu-anchor"
				tabindex="-1"
				aria-hidden="true"
				style:left={`${anchorAt.x}px`}
				style:top={`${anchorAt.y}px`}
				onfocus={returnFocusToRow}
			></button>
		{/snippet}
		<MenuItem
			label={m['tree.workspace.menuRename']()}
			onSelect={() => choose(m['tree.workspace.menuRename']())}
		/>
		<MenuItem
			label={m['tree.workspace.menuDelete']()}
			danger
			onSelect={() => choose(m['tree.workspace.menuDelete']())}
		/>
	</Menu>

	<p class="picked" role="status">{picked}</p>
</div>

<style>
	.workspace-tree {
		padding: var(--banto-space-2);
	}

	.workspace-tree :global(.tree-row .primary) {
		flex: 1;
	}

	.name {
		flex: 1;
	}

	.badges {
		display: inline-flex;
		align-items: center;
		gap: var(--banto-space-2);
		margin-inline-start: var(--banto-space-2);
	}

	.count {
		padding: 0 var(--banto-space-2);
		border-radius: var(--banto-radius-full, 999px);
		background: var(--banto-surface-muted);
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text);
	}

	/* A zero-size, invisible position marker for the Menu (never a visible control). */
	.menu-anchor {
		position: fixed;
		width: 0;
		height: 0;
		padding: 0;
		border: 0;
		opacity: 0;
		pointer-events: none;
	}

	.picked {
		margin: var(--banto-space-2) 0 0;
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}
</style>
