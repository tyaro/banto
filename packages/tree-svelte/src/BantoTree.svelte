<script lang="ts" generics="TData = unknown">
	/**
	 * Hierarchical tree view (spec: banto tree, M-review 2026-08 follow-up).
	 *
	 * Renders the forest as a FLAT list of the currently-visible nodes (via the
	 * pure `flattenVisible` core) so a single `{#each}` drives the whole tree —
	 * ready for later windowing. Supports:
	 *   - expand / collapse (with lazy async child loading via `loadChildren`),
	 *   - highlight selection: `single` or `multi` (ctrl-toggle, shift-range),
	 *   - tri-state checkboxes (`checkboxes`),
	 *   - inline rename (`editable`, F2 / double-click),
	 *   - drag reorder / reparent (`draggable`),
	 *   - optional `columns` → renders as a tree-grid.
	 *
	 * All tree math (flatten, move, tri-state, rename patch) lives in the
	 * dependency-free `core/` so it is unit-tested without a DOM; this component
	 * is the thin runes UI. The forest is owned internally as `$state` and
	 * edited immutably; every mutation also fires a callback so a host can
	 * persist it (and re-drive via a new `nodes` reference).
	 */
	import { tick, untrack, type Snippet } from 'svelte';
	import { computeCheckState, subtreeCheckToggle } from './core/checkbox';
	import {
		canDrop,
		findNode,
		flattenVisible,
		moveNode,
		nodeHasChildren,
		patchNode,
		rangeIds,
		setNodeChildren
	} from './core/tree';
	import type {
		CheckState,
		DropPosition,
		NodeId,
		TreeColumn,
		TreeLabelContext,
		TreeNode
	} from './core/types';
	import { defaultTreeMessages, type TreeMessages } from './messages';
	import { TreeState, type SelectionMode } from './tree-state.svelte';

	interface Props {
		/** The forest to render. A new reference resets the internal copy. */
		nodes: TreeNode<TData>[];
		/** Highlight-selection mode (default `'single'`). */
		selectionMode?: SelectionMode;
		/** Render tri-state checkboxes (default `false`). */
		checkboxes?: boolean;
		/** Allow inline rename via F2 / double-click (default `false`). */
		editable?: boolean;
		/** Allow drag reorder / reparent (default `false`). */
		draggable?: boolean;
		/** Extra columns → renders as a tree-grid (the tree is the implicit first column). */
		columns?: TreeColumn<TData>[];
		/** Initially expanded node ids. */
		expanded?: NodeId[];
		/** Initially highlight-selected node ids. */
		selected?: NodeId[];
		/**
		 * Host-controlled highlight selection (a page that keeps the selected id in
		 * its URL, or that may refuse a pick - e.g. behind an unsaved-changes
		 * confirm). When given, the tree always shows exactly these ids: a click or
		 * key still calls `onSelectionChange`, but the highlight goes back to
		 * `selection` unless the host changed it (synchronously or later). Changing
		 * `selection` moves the highlight (and the roving focus stop). Omitted =
		 * uncontrolled (`selected` is only the initial value).
		 */
		selection?: NodeId[];
		/** Initially checkbox-checked leaf ids. */
		checked?: NodeId[];
		/** Fetch a lazy branch's children on first expand. */
		loadChildren?: (node: TreeNode<TData>) => Promise<TreeNode<TData>[]>;
		/** i18n overrides (app passes resolved strings). */
		messages?: TreeMessages;
		/** Highlight selection changed. */
		onSelectionChange?: (ids: NodeId[]) => void;
		/** Checkbox selection changed. */
		onCheckChange?: (ids: NodeId[]) => void;
		/** A node was dragged. When provided, the host owns the data move (the tree does NOT edit its copy). */
		onMove?: (dragId: NodeId, targetId: NodeId, position: DropPosition) => void;
		/** A node was renamed. When provided, the host owns the label change. */
		onRename?: (id: NodeId, label: string) => void;
		/** A leaf was activated (Enter / double-click on a non-editable leaf). */
		onActivate?: (node: TreeNode<TData>) => void;
		/**
		 * Custom label content (e.g. a count / status badge). Replaces ONLY the
		 * visible label text; the accessible names (toggle / checkbox / rename)
		 * are always built from `node.label`, and an inline rename shows the input
		 * instead. Also applies to the tree-grid's first column (the tree column).
		 */
		label?: Snippet<[TreeNode<TData>, TreeLabelContext]>;
		/**
		 * A node's context menu was requested: mouse right-click, the ContextMenu
		 * key, or Shift+F10 (keyboard: `x`/`y` = the row's left / bottom edge).
		 * When provided the browser's default menu is suppressed; when omitted it
		 * is left alone. Does NOT change the selection (the focus moves to the row).
		 */
		onContextMenu?: (node: TreeNode<TData>, position: { x: number; y: number }) => void;
		/**
		 * Auto-expand root nodes: those in the first `nodes` and any root that
		 * appears later. A root the user collapsed is not re-opened by a later
		 * `nodes` swap (each root id is auto-expanded at most once). Default `false`.
		 */
		autoExpandNewRoots?: boolean;
	}

	let {
		nodes,
		selectionMode = 'single',
		checkboxes = false,
		editable = false,
		draggable = false,
		columns,
		expanded,
		selected,
		selection,
		checked,
		loadChildren,
		messages,
		onSelectionChange,
		onCheckChange,
		onMove,
		onRename,
		onActivate,
		label,
		onContextMenu,
		autoExpandNewRoots = false
	}: Props = $props();

	const t = $derived({ ...defaultTreeMessages, ...messages });
	// svelte-ignore state_referenced_locally
	const tree = new TreeState({ expanded, selected, checked, selectionMode });

	const INDENT_PX = 16;
	const DRAG_THRESHOLD_PX = 5;
	const DEFAULT_COL_WIDTH = 160;

	// Internal, immutable copy of the forest. A new `nodes` reference (a host
	// reset) resyncs it; internal edits (lazy load / move / rename) replace it
	// without touching `nodes`, so they persist for an uncontrolled host.
	// A WRITABLE `$derived` (Svelte 5.25+): it tracks `nodes`, so a new forest
	// reference from the host resets it, but internal edits (lazy load / move /
	// rename) may assign to it and hold until the next host reset — exactly the
	// "uncontrolled with host-reset" behaviour we want, in one line.
	let roots = $derived(nodes);

	const flat = $derived(flattenVisible(roots, (id) => tree.isExpanded(id)));
	const templateColumns = $derived(
		columns
			? `minmax(180px, 1fr) ${columns.map((c) => `${c.width ?? DEFAULT_COL_WIDTH}px`).join(' ')}`
			: ''
	);

	let editing = $state<{ id: NodeId; draft: string } | null>(null);
	let dropTarget = $state<{ id: NodeId; position: DropPosition } | null>(null);
	let containerEl = $state<HTMLElement | null>(null);

	// Element registry for roving focus (id -> row element).
	const elements = new Map<NodeId, HTMLElement>();
	function register(el: HTMLElement, id: NodeId) {
		elements.set(id, el);
		return {
			destroy() {
				if (elements.get(id) === el) elements.delete(id);
			}
		};
	}

	// Per-node load sequence so a re-expand cannot double-load and a stale
	// resolve is discarded.
	const loadSeq = new Map<NodeId, number>();
	async function ensureLoaded(node: TreeNode<TData>): Promise<void> {
		if (!loadChildren) return;
		if (node.children && node.children.length > 0) return;
		if (!node.hasChildren) return;
		const status = tree.getLoadStatus(node.id);
		if (status === 'loading' || status === 'loaded') return;
		const token = (loadSeq.get(node.id) ?? 0) + 1;
		loadSeq.set(node.id, token);
		tree.setLoadStatus(node.id, 'loading');
		try {
			const children = await loadChildren(node);
			if (loadSeq.get(node.id) !== token) return;
			roots = setNodeChildren(roots, node.id, children);
			tree.setLoadStatus(node.id, 'loaded');
		} catch {
			if (loadSeq.get(node.id) !== token) return;
			tree.setLoadStatus(node.id, 'error');
		}
	}

	// Root ids already auto-expanded once (never re-opened after a user collapse).
	// `$effect.pre` so the first render already shows them open (no flash).
	const seenRootIds = new Set<NodeId>();
	$effect.pre(() => {
		if (!autoExpandNewRoots) return;
		for (const root of nodes) {
			if (seenRootIds.has(root.id)) continue;
			seenRootIds.add(root.id);
			tree.expand(root.id);
			void ensureLoaded(root);
		}
	});

	function toggleExpand(node: TreeNode<TData>): void {
		if (tree.isExpanded(node.id)) {
			tree.collapse(node.id);
		} else {
			tree.expand(node.id);
			void ensureLoaded(node);
		}
	}

	function emitSelection(): void {
		onSelectionChange?.([...tree.selectedIds]);
		// Controlled: the host decides. Whatever `selection` is once the callback
		// (and its synchronous effects) are done wins - a refused pick snaps back.
		if (selection) void tick().then(() => syncSelection(true));
	}

	/**
	 * Controlled mode: make the highlight equal `selection` (and park the focus stop on it).
	 * `afterPick` = called right after a user pick was reported. A refused pick then undoes
	 * the whole move - selection AND focus go back to the host's row, so the highlight, the
	 * tab stop, the key handling and the browser focus never disagree - but only while the
	 * focus has not left the tree: a host that moved it elsewhere (a confirm dialog) keeps it.
	 */
	function syncSelection(afterPick = false): void {
		const wanted = untrack(() => selection);
		if (!wanted) return;
		const hostTookFocus = focusIsElsewhere();
		// The host took the focus out of the tree: drop the row focus the pick reserved.
		if (afterPick && hostTookFocus) cancelPendingFocus();
		const current = tree.selectedIds;
		const same = current.size === wanted.length && wanted.every((id) => current.has(id));
		if (same) return;
		current.clear();
		for (const id of wanted) current.add(id);
		// Show what was picked: open the (already loaded) branches above each id.
		for (const id of wanted)
			for (const ancestor of ancestorIds(roots, id) ?? []) tree.expand(ancestor);
		const first = wanted[0];
		if (first === undefined) return;
		tree.focusedId = first;
		if (afterPick && !hostTookFocus) scheduleFocus(first, true);
	}

	/** Ids of the branches above `id` among the loaded nodes (root first); `null` when absent. */
	function ancestorIds(list: TreeNode<TData>[], id: NodeId, path: NodeId[] = []): NodeId[] | null {
		for (const node of list) {
			if (node.id === id) return path;
			const found = node.children ? ancestorIds(node.children, id, [...path, node.id]) : null;
			if (found) return found;
		}
		return null;
	}

	/**
	 * The one row that takes Tab: the focused row when it is shown, else the first
	 * shown selected row, else the first row - so a hidden focus never strands the tree.
	 */
	const tabStopId = $derived.by(() => {
		const shown = flat.map((f) => f.node.id);
		const focused = tree.focusedId;
		if (focused !== null && shown.includes(focused)) return focused;
		return shown.find((id) => tree.selectedIds.has(id)) ?? shown[0] ?? null;
	});
	$effect.pre(() => {
		void selection?.length;
		for (const id of selection ?? []) void id;
		untrack(syncSelection);
	});
	function emitCheck(): void {
		onCheckChange?.([...tree.checkedIds]);
	}

	function isControl(target: EventTarget | null): boolean {
		return target instanceof HTMLElement && target.closest('[data-tree-control]') !== null;
	}

	function selectAt(
		index: number,
		event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }
	): void {
		const f = flat[index];
		if (!f || f.node.disabled || selectionMode === 'none') return;
		const id = f.node.id;
		if (selectionMode === 'multi' && (event.ctrlKey || event.metaKey)) {
			tree.toggleSelected(id);
		} else if (selectionMode === 'multi' && event.shiftKey && tree.anchorId) {
			tree.selectRange(rangeIds(flat, tree.anchorId, id));
			tree.focusedId = id;
		} else {
			tree.selectOnly(id);
		}
		emitSelection();
	}

	function onRowClick(event: MouseEvent, index: number): void {
		if (isControl(event.target) || flat[index]?.node.disabled) return;
		selectAt(index, event);
		tree.focusedId = flat[index]?.node.id ?? tree.focusedId;
		focusNodeEl(flat[index]?.node.id ?? null);
	}

	function onRowDblClick(event: MouseEvent, node: TreeNode<TData>): void {
		if (isControl(event.target) || node.disabled) return;
		if (editable) beginRename(node);
		else if (!nodeHasChildren(node)) onActivate?.(node);
		else toggleExpand(node);
	}

	function onCheckToggle(node: TreeNode<TData>): void {
		if (node.disabled) return;
		tree.applyCheck(subtreeCheckToggle(node, tree.checkedIds));
		emitCheck();
	}

	// --- context menu (mouse / ContextMenu key / Shift+F10) ---
	function onRowContextMenu(event: MouseEvent, node: TreeNode<TData>): void {
		if (!onContextMenu) return; // pass through: the browser's own menu
		// Right-click inside the rename input keeps the native text menu.
		if (editing?.id === node.id && event.target instanceof HTMLInputElement) return;
		event.preventDefault();
		// Focus follows the click (selection is NOT moved). Done synchronously,
		// BEFORE the callback, so a host that moves focus into its menu inside
		// the callback is not pulled back to the row afterwards.
		tree.focusedId = node.id;
		elements.get(node.id)?.focus();
		onContextMenu(node, { x: event.clientX, y: event.clientY });
	}

	// --- inline rename ---
	function beginRename(node: TreeNode<TData>): void {
		if (!editable || node.disabled) return;
		editing = { id: node.id, draft: node.label };
	}
	function commitRename(): void {
		const current = editing;
		editing = null;
		if (!current) return;
		const trimmed = current.draft.trim();
		const node = findNode(roots, current.id);
		if (!node || trimmed === '' || trimmed === node.label) return;
		if (onRename) onRename(current.id, trimmed);
		else roots = patchNode(roots, current.id, { label: trimmed });
	}
	function onRenameKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter') {
			event.preventDefault();
			event.stopPropagation();
			commitRename();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			editing = null;
		}
	}
	function autofocus(el: HTMLInputElement) {
		el.focus();
		el.select();
	}

	// --- keyboard navigation (roving focus) ---
	// The DOM focus follows the logical focus after the next render. Only the newest
	// request counts, so a reservation made before a refused pick cannot land late.
	let focusRequest = 0;
	function scheduleFocus(id: NodeId, unlessElsewhere = false): void {
		const request = ++focusRequest;
		void tick().then(() => {
			if (request !== focusRequest) return;
			if (unlessElsewhere && focusIsElsewhere()) return;
			elements.get(id)?.focus();
		});
	}
	/** The browser focus sits on something outside the tree (not just on the page body). */
	function focusIsElsewhere(): boolean {
		const active = document.activeElement;
		return !!active && active !== document.body && !(containerEl?.contains(active) ?? false);
	}
	function cancelPendingFocus(): void {
		focusRequest++;
	}
	function focusNodeEl(id: NodeId | null): void {
		if (id === null) return;
		tree.focusedId = id;
		scheduleFocus(id);
	}
	function moveFocus(toIndex: number, extend: boolean): void {
		const clamped = Math.min(Math.max(toIndex, 0), flat.length - 1);
		const target = flat[clamped];
		if (!target) return;
		const id = target.node.id;
		if (extend && selectionMode === 'multi' && tree.anchorId) {
			tree.selectRange(rangeIds(flat, tree.anchorId, id));
			tree.focusedId = id;
			emitSelection();
		} else if (selectionMode === 'single' && !target.node.disabled) {
			tree.selectOnly(id);
			emitSelection();
		} else {
			tree.focusedId = id;
		}
		scheduleFocus(id);
	}

	function onKeydown(event: KeyboardEvent): void {
		if (editing) return;
		// Keys act on the row that holds the tab stop: a focus id that is hidden (a closed
		// branch, an unknown `selection`) falls back to the shown row the user tabbed into.
		const focusedId = tabStopId;
		if (focusedId === null) return;
		if (tree.focusedId !== focusedId) tree.focusedId = focusedId;
		const index = flat.findIndex((f) => f.node.id === focusedId);
		if (index === -1) return;
		const f = flat[index];
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				moveFocus(index + 1, event.shiftKey);
				break;
			case 'ArrowUp':
				event.preventDefault();
				moveFocus(index - 1, event.shiftKey);
				break;
			case 'ArrowRight':
				event.preventDefault();
				if (f.hasChildren && !f.expanded) toggleExpand(f.node);
				else if (f.expanded) moveFocus(index + 1, false);
				break;
			case 'ArrowLeft':
				event.preventDefault();
				if (f.expanded) tree.collapse(f.node.id);
				else if (f.parentId !== null) focusNodeEl(f.parentId);
				break;
			case 'Home':
				event.preventDefault();
				moveFocus(0, event.shiftKey);
				break;
			case 'End':
				event.preventDefault();
				moveFocus(flat.length - 1, event.shiftKey);
				break;
			case 'Enter':
				event.preventDefault();
				if (f.hasChildren) toggleExpand(f.node);
				else onActivate?.(f.node);
				break;
			case ' ':
				event.preventDefault();
				if (checkboxes) onCheckToggle(f.node);
				else if (selectionMode === 'multi') {
					if (!f.node.disabled) {
						tree.toggleSelected(f.node.id);
						emitSelection();
					}
				} else selectAt(index, event);
				break;
			case 'ContextMenu':
			case 'F10': {
				if (event.key === 'F10' && !event.shiftKey) break;
				if (!onContextMenu) break;
				event.preventDefault();
				const rect = elements.get(f.node.id)?.getBoundingClientRect();
				onContextMenu(f.node, { x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
				break;
			}
			case 'F2':
				if (editable) {
					event.preventDefault();
					beginRename(f.node);
				}
				break;
			default:
				break;
		}
	}

	// --- drag reorder / reparent (pointer + window listeners) ---
	let dragState: {
		id: NodeId;
		pointerId: number;
		startX: number;
		startY: number;
		active: boolean;
	} | null = null;

	function onRowPointerDown(event: PointerEvent, node: TreeNode<TData>): void {
		if (!draggable || node.disabled || event.button !== 0 || isControl(event.target)) return;
		dragState = {
			id: node.id,
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			active: false
		};
		window.addEventListener('pointermove', onDragMove);
		window.addEventListener('pointerup', onDragUp);
	}
	function onDragMove(event: PointerEvent): void {
		if (!dragState || event.pointerId !== dragState.pointerId) return;
		if (!dragState.active) {
			if (
				Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY) <
				DRAG_THRESHOLD_PX
			)
				return;
			dragState.active = true;
		}
		event.preventDefault();
		const hit = document.elementFromPoint(event.clientX, event.clientY);
		const el = hit instanceof HTMLElement ? hit.closest<HTMLElement>('[data-node-id]') : null;
		if (!el) {
			dropTarget = null;
			return;
		}
		const targetId = el.getAttribute('data-node-id');
		if (targetId === null || targetId === dragState.id) {
			dropTarget = null;
			return;
		}
		const rect = el.getBoundingClientRect();
		const y = event.clientY - rect.top;
		const third = rect.height / 3;
		const targetNode = findNode(roots, targetId);
		if (targetNode?.disabled) {
			// disabled rows used to be skipped by pointer-events: none
			dropTarget = null;
			return;
		}
		let position: DropPosition;
		if (y < third) position = 'before';
		else if (y > rect.height - third) position = 'after';
		else position = targetNode && nodeHasChildren(targetNode) ? 'inside' : 'after';
		dropTarget = canDrop(roots, dragState.id, targetId, position)
			? { id: targetId, position }
			: null;
	}
	function onDragUp(): void {
		window.removeEventListener('pointermove', onDragMove);
		window.removeEventListener('pointerup', onDragUp);
		const ds = dragState;
		const dt = dropTarget;
		dragState = null;
		dropTarget = null;
		if (!ds || !ds.active || !dt) return;
		if (onMove) onMove(ds.id, dt.id, dt.position);
		else roots = moveNode(roots, ds.id, dt.id, dt.position);
		if (dt.position === 'inside') tree.expand(dt.id);
	}

	// --- tree-grid cell rendering ---
	function cellText(col: TreeColumn<TData>, node: TreeNode<TData>): string {
		const raw =
			typeof col.accessor === 'function'
				? col.accessor(node.data, node)
				: node.data === undefined
					? undefined
					: (node.data as Record<string, unknown>)[col.accessor as string];
		if (col.format) return col.format(raw, node);
		if (raw === null || raw === undefined) return '';
		return String(raw);
	}

	function checkStateOf(node: TreeNode<TData>): CheckState {
		return checkboxes ? computeCheckState(node, tree.checkedIds) : 'unchecked';
	}

	function indeterminate(el: HTMLInputElement, value: boolean) {
		el.indeterminate = value;
		return {
			update(next: boolean) {
				el.indeterminate = next;
			}
		};
	}
</script>

{#if columns}
	<div class="grid-header" aria-hidden="true" style:grid-template-columns={templateColumns}>
		<div class="grid-header-cell name">{t.nameColumn()}</div>
		{#each columns as col (col.id)}
			<div class="grid-header-cell" style:text-align={col.align ?? 'left'}>{col.header}</div>
		{/each}
	</div>
{/if}

<div
	class="tree"
	class:has-columns={!!columns}
	role="tree"
	aria-multiselectable={selectionMode === 'multi' ? true : undefined}
	tabindex={flat.length === 0 ? 0 : -1}
	bind:this={containerEl}
	onkeydown={onKeydown}
>
	{#each flat as f, index (f.node.id)}
		{@const node = f.node}
		{@const check = checkStateOf(node)}
		<!-- Keyboard is handled at the role="tree" container (roving tabindex +
		     onkeydown), the standard WAI-ARIA tree pattern; the row click is a
		     pointer convenience only. -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			class="tree-row"
			class:selected={selectionMode !== 'none' && tree.isSelected(node.id)}
			class:focused={tree.focusedId === node.id}
			class:disabled={node.disabled}
			class:drop-before={dropTarget?.id === node.id && dropTarget.position === 'before'}
			class:drop-after={dropTarget?.id === node.id && dropTarget.position === 'after'}
			class:drop-inside={dropTarget?.id === node.id && dropTarget.position === 'inside'}
			role="treeitem"
			data-node-id={node.id}
			aria-level={f.depth + 1}
			aria-setsize={f.setSize}
			aria-posinset={f.posInSet}
			aria-expanded={f.hasChildren ? f.expanded : undefined}
			aria-selected={selectionMode !== 'none' ? tree.isSelected(node.id) : undefined}
			aria-disabled={node.disabled ? 'true' : undefined}
			aria-label={label ? node.label : undefined}
			tabindex={tabStopId === node.id ? 0 : -1}
			style:grid-template-columns={columns ? templateColumns : undefined}
			use:register={node.id}
			onclick={(e) => onRowClick(e, index)}
			ondblclick={(e) => onRowDblClick(e, node)}
			onpointerdown={(e) => onRowPointerDown(e, node)}
			oncontextmenu={(e) => onRowContextMenu(e, node)}
		>
			<div class="primary" style:padding-left={`${f.depth * INDENT_PX}px`}>
				{#if f.hasChildren}
					<button
						type="button"
						class="toggle"
						data-tree-control
						tabindex="-1"
						aria-label={f.expanded ? t.collapse(node.label) : t.expand(node.label)}
						onclick={(e) => {
							e.stopPropagation();
							if (node.disabled) return;
							toggleExpand(node);
						}}
					>
						<span class="chevron" class:open={f.expanded} aria-hidden="true">▸</span>
					</button>
				{:else}
					<span class="toggle-spacer" aria-hidden="true"></span>
				{/if}

				{#if checkboxes}
					<input
						type="checkbox"
						class="checkbox"
						data-tree-control
						tabindex="-1"
						disabled={node.disabled}
						checked={check === 'checked'}
						use:indeterminate={check === 'indeterminate'}
						aria-label={t.checkbox(node.label)}
						onclick={(e) => e.stopPropagation()}
						onchange={() => onCheckToggle(node)}
					/>
				{/if}

				{#if editing?.id === node.id}
					<input
						class="rename"
						data-tree-control
						bind:value={editing.draft}
						aria-label={t.rename(node.label)}
						onkeydown={onRenameKeydown}
						onblur={commitRename}
						use:autofocus
					/>
				{:else}
					<span class="label">
						{#if label}
							{@render label(node, {
								selected: selectionMode !== 'none' && tree.isSelected(node.id),
								focused: tree.focusedId === node.id,
								expanded: f.expanded,
								hasChildren: f.hasChildren,
								depth: f.depth,
								disabled: !!node.disabled
							})}
						{:else}
							{node.label}
						{/if}
					</span>
				{/if}

				{#if tree.getLoadStatus(node.id) === 'loading'}
					<span class="badge">{t.loading()}</span>
				{:else if tree.getLoadStatus(node.id) === 'error'}
					<span class="badge error">{t.loadError()}</span>
				{/if}
			</div>

			{#if columns}
				{#each columns as col (col.id)}
					<div class="cell" style:text-align={col.align ?? 'left'}>{cellText(col, node)}</div>
				{/each}
			{/if}
		</div>
	{:else}
		<div class="empty">{t.empty()}</div>
	{/each}
</div>

<style>
	.tree {
		display: flex;
		flex-direction: column;
		color: var(--banto-text);
		font-size: var(--banto-font-size-md);
		outline: none;
	}

	.tree-row {
		display: flex;
		align-items: center;
		min-height: var(--banto-control-height, 2.25rem);
		padding: 0 var(--banto-space-2);
		border-radius: var(--banto-radius-md);
		cursor: default;
		position: relative;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}
	.tree.has-columns .tree-row {
		display: grid;
		align-items: center;
		border-radius: 0;
		border-bottom: var(--banto-border-width) solid var(--banto-border);
	}

	.tree-row:hover {
		background: var(--banto-surface-hover);
	}
	.tree-row.selected {
		background: color-mix(in srgb, var(--banto-primary) 14%, transparent);
		color: var(--banto-primary-hover);
		font-weight: 600;
	}
	.tree-row.disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.tree-row.focused:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}
	.tree-row:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	/* drop affordances (reorder line / reparent highlight) */
	.tree-row.drop-before::before,
	.tree-row.drop-after::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		height: 2px;
		background: var(--banto-primary);
		pointer-events: none;
	}
	.tree-row.drop-before::before {
		top: -1px;
	}
	.tree-row.drop-after::after {
		bottom: -1px;
	}
	.tree-row.drop-inside {
		background: color-mix(in srgb, var(--banto-primary) 12%, transparent);
		box-shadow: inset 0 0 0 1px var(--banto-primary);
	}

	.primary {
		display: flex;
		align-items: center;
		gap: var(--banto-space-1);
		min-width: 0;
		flex: 1;
	}

	.toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--banto-tree-toggle-size, 1.25rem);
		height: var(--banto-tree-toggle-size, 1.25rem);
		flex: 0 0 auto;
		border: none;
		background: none;
		color: var(--banto-text-muted);
		cursor: pointer;
		border-radius: var(--banto-radius-sm);
		padding: 0;
	}
	.toggle:hover {
		color: var(--banto-text);
		background: color-mix(in srgb, currentColor 12%, transparent);
	}
	.toggle-spacer {
		width: var(--banto-tree-toggle-size, 1.25rem);
		height: var(--banto-tree-toggle-size, 1.25rem);
		flex: 0 0 auto;
	}
	.chevron {
		display: inline-block;
		font-size: var(--banto-font-size-xs);
		line-height: 1;
		transition: transform var(--banto-duration-base) var(--banto-ease-out);
	}
	.chevron.open {
		transform: rotate(90deg);
	}

	.checkbox {
		width: 1.05rem;
		height: 1.05rem;
		flex: 0 0 auto;
		margin: 0;
		accent-color: var(--banto-primary);
		cursor: pointer;
	}
	.checkbox:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
		border-radius: var(--banto-radius-sm);
	}

	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.rename {
		flex: 1;
		min-width: 0;
		font: inherit;
		color: var(--banto-text);
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-primary);
		border-radius: var(--banto-radius-sm);
		padding: var(--banto-space-1) var(--banto-space-1);
	}
	.rename:focus-visible {
		outline: none;
		box-shadow: var(--banto-focus-ring);
	}

	.badge {
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
		padding-inline-start: var(--banto-space-1);
	}
	.badge.error {
		color: var(--banto-danger);
	}

	.cell {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding: 0 var(--banto-space-2);
		color: var(--banto-text);
	}

	.grid-header {
		display: grid;
		align-items: center;
		border-bottom: var(--banto-border-width) solid var(--banto-border-strong);
		background: var(--banto-surface-subtle, var(--banto-surface));
		font-size: var(--banto-font-size-sm);
		font-weight: 600;
		color: var(--banto-text-muted);
	}
	.grid-header-cell {
		padding: var(--banto-space-2) var(--banto-space-2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.grid-header-cell.name {
		padding-inline-start: var(--banto-space-2);
	}

	.empty {
		padding: var(--banto-space-4) var(--banto-space-3);
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-md);
	}
</style>
