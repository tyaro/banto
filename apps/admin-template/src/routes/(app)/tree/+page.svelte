<script lang="ts">
	/**
	 * M-review 2026-08 tree demo (deletable per docs/template-scope.md §3):
	 * shows `@banto/tree-svelte` end to end — the three form factors
	 * (file-explorer / hierarchical data-grid / category-select) and every
	 * interaction (expand·collapse, single/multi selection, tri-state
	 * checkboxes, lazy async load, drag reorder/reparent, inline rename).
	 *
	 * The trees here are UNCONTROLLED: no `onMove`/`onRename` is passed, so the
	 * component owns an internal immutable copy and edits persist visually
	 * without the page wiring a store — the smallest possible demo. Sample data
	 * lives in `#lib/banto/treeSample.ts` (replaceable, like the items seed);
	 * all page chrome is Paraglide (`raw-jp-in-app` — no raw Japanese in
	 * `.svelte`). Not screenshotted (absent from e2e/visual DIAGONAL_PAGES), so
	 * adding it only drifts the shared sidebar baselines, not a new page shot.
	 */
	import {
		BantoTree,
		TreeSelect,
		findNode,
		moveNode,
		type NodeId,
		type TreeColumn,
		type TreeDropRequest,
		type TreeDropVerdict,
		type TreeNode
	} from '@banto/tree-svelte';
	import { Eye, EyeOff } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import * as m from '#lib/paraglide/messages.js';
	import { PageHeader, SurfaceCard } from '@banto/ui';
	import { treeMessages } from '#lib/banto/i18n.js';
	import {
		explorerTree,
		categoryTree,
		lazyRoots,
		loadLazyChildren,
		type FileData
	} from '#lib/banto/treeSample.js';

	const treeMsg = treeMessages();

	// tree-grid columns: localized headers, `kind`/`size` read from node.data.
	// A `$derived` so the headers re-resolve if the active locale changes (the
	// `format` closures already re-run per render, so cells localize too).
	const gridColumns: TreeColumn<FileData>[] = $derived([
		{
			id: 'kind',
			header: m['tree.demo.colKind'](),
			accessor: (data) => data?.kind,
			format: (v) => (v === 'folder' ? m['tree.demo.kindFolder']() : m['tree.demo.kindFile']())
		},
		{
			id: 'size',
			header: m['tree.demo.colSize'](),
			width: 90,
			align: 'right',
			accessor: (data) => data?.size,
			format: (v) => (typeof v === 'number' ? `${v} KB` : '—')
		}
	]);

	// Section 2 (multi + checkboxes): reflect the checked count back to the page.
	let checkedCount = $state(0);

	// Section 5 (TreeSelect): bound selections + their resolved labels.
	let deptValue = $state<string | null>(null);
	let deptValues = $state<string[]>([]);

	const deptSingleLabel = $derived(
		deptValue ? (findNode(categoryTree, deptValue)?.label ?? '') : ''
	);
	const deptMultiLabels = $derived(
		deptValues.map((id) => findNode(categoryTree, id)?.label ?? '').filter(Boolean)
	);

	let contextInfo = $state('');

	// Section "host hooks" (#821): the page owns the forest (`onMove`), filters it by name and,
	// only while searching, decides the expansion (`expansion`). Clearing the search hands the
	// expansion back to the tree, which shows what was open before.
	let files = $state.raw<TreeNode<FileData>[]>(explorerTree);
	let query = $state('');
	let hiddenIds = $state<NodeId[]>([]);
	let dropReason = $state('');

	/** Keeps the matches (whole) and the branches above them; `open` collects those branches. */
	function matchTree(
		list: TreeNode<FileData>[],
		q: string,
		open: NodeId[]
	): { kept: TreeNode<FileData>[]; count: number } {
		const kept: TreeNode<FileData>[] = [];
		let count = 0;
		for (const node of list) {
			const hit = node.label.toLowerCase().includes(q);
			const sub = node.children ? matchTree(node.children, q, open) : { kept: [], count: 0 };
			if (!hit && sub.kept.length === 0) continue;
			if (sub.kept.length > 0) open.push(node.id);
			count += sub.count + (hit ? 1 : 0);
			kept.push(hit ? node : { ...node, children: sub.kept });
		}
		return { kept, count };
	}
	const search = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return null;
		const open: NodeId[] = [];
		const { kept, count } = matchTree(files, q, open);
		return { q, nodes: kept, open, count };
	});
	// While searching, the user's toggles are applied on top of "the ancestors of the matches".
	let searchToggles = $state<{ q: string; ids: NodeId[] } | null>(null);
	const searchExpansion = $derived(
		search ? (searchToggles?.q === search.q ? searchToggles.ids : search.open) : undefined
	);

	function onlyMarkdownInDocs({ dragged, parent }: TreeDropRequest<FileData>): TreeDropVerdict {
		if (parent?.id === 'docs' && !dragged.label.endsWith('.md'))
			return { allowed: false, reason: m['tree.demo.dropOnlyMd']() };
		return true;
	}
	function toggleHidden(id: NodeId): void {
		hiddenIds = hiddenIds.includes(id) ? hiddenIds.filter((h) => h !== id) : [...hiddenIds, id];
	}
</script>

{#snippet countLabel(node: TreeNode)}
	{node.label}
	{#if node.children?.length}<span class="count">{node.children.length}</span>{/if}
{/snippet}

{#snippet dimmedLabel(node: TreeNode<FileData>)}
	<span class:dimmed={hiddenIds.includes(node.id)}>{node.label}</span>
{/snippet}

{#snippet visibilityToggle(node: TreeNode<FileData>)}
	{@const hidden = hiddenIds.includes(node.id)}
	<button
		type="button"
		class="row-toggle"
		aria-pressed={hidden}
		aria-label={m['tree.demo.hideRow']({ label: node.label })}
		onclick={() => toggleHidden(node.id)}
	>
		{#if hidden}<EyeOff size={14} aria-hidden="true" />{:else}<Eye
				size={14}
				aria-hidden="true"
			/>{/if}
	</button>
{/snippet}

<div class="page">
	<PageHeader hideTitle title={m['nav.tree']()} description={m['tree.demo.intro']()} />

	<SurfaceCard title={m['tree.workspace.linkTitle']()} description={m['tree.workspace.linkHint']()}>
		<a class="banto-btn banto-btn--secondary" href={resolve('tree/workspace')}>
			{m['tree.workspace.linkOpen']()}
		</a>
	</SurfaceCard>

	<SurfaceCard
		title={m['tree.workspaceDock.linkTitle']()}
		description={m['tree.workspaceDock.linkHint']()}
	>
		<a class="banto-btn banto-btn--secondary" href={resolve('tree/workspace-dock')}>
			{m['tree.workspaceDock.linkOpen']()}
		</a>
	</SurfaceCard>

	<SurfaceCard title={m['tree.demo.explorerTitle']()} description={m['tree.demo.explorerHint']()}>
		<BantoTree
			nodes={explorerTree}
			expanded={['project', 'src']}
			editable
			draggable
			messages={treeMsg}
		/>
	</SurfaceCard>

	<SurfaceCard title={m['tree.demo.extTitle']()} description={m['tree.demo.extHint']()}>
		<BantoTree
			nodes={explorerTree}
			label={countLabel}
			autoExpandNewRoots
			messages={treeMsg}
			onContextMenu={(node, { x, y }) =>
				(contextInfo = m['tree.demo.contextAt']({
					label: node.label,
					x: Math.round(x),
					y: Math.round(y)
				}))}
		/>
		<p class="selection">{contextInfo}</p>
	</SurfaceCard>

	<SurfaceCard title={m['tree.demo.multiTitle']()} description={m['tree.demo.multiHint']()}>
		<BantoTree
			nodes={explorerTree}
			selectionMode="multi"
			checkboxes
			expanded={['project', 'docs', 'src']}
			messages={treeMsg}
			onCheckChange={(ids) => (checkedCount = ids.length)}
		/>
		<p class="selection">{m['tree.demo.checkedPrefix']()}: {checkedCount}</p>
	</SurfaceCard>

	<SurfaceCard title={m['tree.demo.gridTitle']()} description={m['tree.demo.gridHint']()}>
		<BantoTree
			nodes={explorerTree}
			columns={gridColumns}
			expanded={['project', 'docs', 'src', 'utils']}
			messages={treeMsg}
		/>
	</SurfaceCard>

	<SurfaceCard title={m['tree.demo.lazyTitle']()} description={m['tree.demo.lazyHint']()}>
		<BantoTree nodes={lazyRoots} loadChildren={loadLazyChildren} messages={treeMsg} />
	</SurfaceCard>

	<SurfaceCard title={m['tree.demo.hooksTitle']()} description={m['tree.demo.hooksHint']()}>
		<label class="search">
			<span>{m['tree.demo.searchLabel']()}</span>
			<input class="banto-input" type="search" bind:value={query} />
		</label>
		<BantoTree
			nodes={search?.nodes ?? files}
			expanded={['project', 'docs', 'src']}
			expansion={searchExpansion}
			onExpandedChange={(ids) => {
				if (search) searchToggles = { q: search.q, ids };
			}}
			draggable
			onMove={(dragId, targetId, position) => (files = moveNode(files, dragId, targetId, position))}
			canDrop={onlyMarkdownInDocs}
			onDropTargetChange={(hover) =>
				(dropReason = hover && !hover.allowed ? (hover.reason ?? '') : '')}
			label={dimmedLabel}
			rowActions={visibilityToggle}
			messages={treeMsg}
		/>
		<p class="selection" aria-live="polite">
			{#if dropReason}{dropReason}{:else if search}{m['tree.demo.searchExpanded']({
					count: search.count
				})}{:else}{m['tree.demo.hiddenCount']({ count: hiddenIds.length })}{/if}
		</p>
	</SurfaceCard>

	<SurfaceCard title={m['tree.demo.selectTitle']()} description={m['tree.demo.selectHint']()}>
		<div class="selects">
			<div class="field">
				<label for="dept-single">{m['tree.demo.selectSingleLabel']()}</label>
				<TreeSelect
					id="dept-single"
					nodes={categoryTree}
					bind:value={deptValue}
					expanded={['org']}
					messages={treeMsg}
				/>
				<p class="selection">
					{m['tree.demo.selectedPrefix']()}: {deptSingleLabel || m['tree.demo.none']()}
				</p>
			</div>

			<div class="field">
				<label for="dept-multi">{m['tree.demo.selectMultiLabel']()}</label>
				<TreeSelect
					id="dept-multi"
					nodes={categoryTree}
					multiple
					bind:values={deptValues}
					expanded={['org']}
					messages={treeMsg}
				/>
				<p class="selection">
					{m['tree.demo.selectedPrefix']()}:
					{deptMultiLabels.length ? deptMultiLabels.join('、') : m['tree.demo.none']()}
				</p>
			</div>
		</div>
	</SurfaceCard>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
	}

	.count {
		margin-inline-start: var(--banto-space-2);
		padding: 0 var(--banto-space-2);
		border-radius: var(--banto-radius-full, 999px);
		background: var(--banto-surface-muted);
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	.selection {
		margin: var(--banto-space-3) 0 0;
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	.search {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		max-width: 320px;
		margin-bottom: var(--banto-space-3);
		font-size: var(--banto-font-size-sm);
		font-weight: 600;
	}

	.dimmed {
		color: var(--banto-text-muted);
		text-decoration: line-through;
	}

	.row-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: var(--banto-space-1);
		border: 0;
		border-radius: var(--banto-radius-sm, 4px);
		background: transparent;
		color: var(--banto-text-muted);
		cursor: pointer;
	}

	.row-toggle:hover,
	.row-toggle[aria-pressed='true'] {
		color: var(--banto-text);
		background: var(--banto-surface-muted);
	}

	.selects {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-6);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		min-width: 220px;
	}

	.field label {
		font-size: var(--banto-font-size-sm);
		font-weight: 600;
	}
</style>
