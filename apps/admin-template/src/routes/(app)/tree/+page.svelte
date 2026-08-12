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
	 * lives in `$lib/banto/treeSample.ts` (replaceable, like the items seed);
	 * all page chrome is Paraglide (`raw-jp-in-app` — no raw Japanese in
	 * `.svelte`). Not screenshotted (absent from e2e/visual DIAGONAL_PAGES), so
	 * adding it only drifts the shared sidebar baselines, not a new page shot.
	 */
	import { BantoTree, TreeSelect, findNode, type TreeColumn } from '@banto/tree-svelte';
	import * as m from '$lib/paraglide/messages';
	import PageHeader from '$lib/components/ui/PageHeader.svelte';
	import SurfaceCard from '$lib/components/ui/SurfaceCard.svelte';
	import { treeMessages } from '$lib/banto/i18n';
	import {
		explorerTree,
		categoryTree,
		lazyRoots,
		loadLazyChildren,
		type FileData
	} from '$lib/banto/treeSample';

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
</script>

<div class="page">
	<PageHeader title={m['nav.tree']()} description={m['tree.demo.intro']()} />

	<SurfaceCard title={m['tree.demo.explorerTitle']()} description={m['tree.demo.explorerHint']()}>
		<BantoTree
			nodes={explorerTree}
			expanded={['project', 'src']}
			editable
			draggable
			messages={treeMsg}
		/>
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
		gap: 1rem;
	}

	.selection {
		margin: 0.75rem 0 0;
		font-size: 0.8rem;
		color: var(--banto-text-muted);
	}

	.selects {
		display: flex;
		flex-wrap: wrap;
		gap: 1.5rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		min-width: 220px;
	}

	.field label {
		font-size: 0.8rem;
		font-weight: 600;
	}
</style>
