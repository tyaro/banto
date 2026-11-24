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
	 *   - drag reorder / reparent (`draggable`, with a host veto via `canDrop`),
	 *   - trailing per-row controls (`rowActions`),
	 *   - host-decided expansion (`expansion`),
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
		canDrop as canDropShape,
		findNode,
		findParent,
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
		FlatNode,
		NodeId,
		TreeColumn,
		TreeDropHover,
		TreeDropRequest,
		TreeDropVerdict,
		TreeEmptyContext,
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
		/**
		 * `selectionMode: 'single'` only. `true` (default): moving the focus with the keys (arrows,
		 * Home, End) also selects the row and calls `onSelectionChange` (the long-standing behaviour).
		 * `false`: those keys move only the focus; a row is picked with Space, Enter or a click
		 * (WAI-ARIA tree "selection does not follow focus"). Enter in this mode selects the row and
		 * then does what it always did (toggle a branch / `onActivate` a leaf). `'multi'` and
		 * `'none'` are unaffected.
		 */
		selectionFollowsFocus?: boolean;
		/**
		 * Shown as one extra line under an expanded branch whose `children` is an empty array
		 * (not `undefined`; a lazy branch that is unloaded / loading / failed is not "empty", a
		 * lazy branch that loaded zero children is). Passing it also gives such a branch a
		 * disclosure toggle (without it, an empty branch looks and behaves as a leaf). The line is
		 * not a node: arrow keys skip it, it is never selected / checked, and it is exposed to
		 * assistive tech as a disabled `treeitem` one level below the branch.
		 */
		emptyChildren?: Snippet<[TreeNode<TData>, TreeEmptyContext]>;
		/**
		 * Controls at the end of a row (buttons, a toggle, a menu trigger). Drawn at the end of
		 * the tree column, after the label. A click, double-click or drag that starts inside them
		 * never selects / renames / drags the row. Keyboard: the controls of the row that holds the
		 * tree's tab stop are reachable with Tab (row -> its controls -> out of the tree); Tab /
		 * Shift+Tab skip the controls of every other row, and a Tab from outside that lands on them
		 * is sent to the tab-stop row - so the tree adds no tab stop per row. The tree never
		 * writes to the controls (a host toolbar's own roving `tabindex` is left as it is). Inside the controls the tree's own keys
		 * (arrows, Enter, Space, F2 ...) are not handled, and Escape returns the focus to the row.
		 * Give every control its own accessible name (e.g. `aria-label` with the node's label).
		 */
		rowActions?: Snippet<[TreeNode<TData>, TreeLabelContext]>;
		/**
		 * Host-decided expansion. While given, exactly these ids are open: a toggle / arrow key /
		 * drop-into only calls `onExpandedChange` with the list it asks for, and nothing changes
		 * until the host passes a new `expansion`. `autoExpandNewRoots` and "open the branches above
		 * the `selection`" do not apply while it is given. A lazy branch listed here is loaded.
		 * When it goes back to `undefined`, the tree shows its own expansion again (the user's
		 * toggles meanwhile only went to `onExpandedChange`; `autoExpandNewRoots` and revealing a
		 * `selection` still update the tree's own set, so a match picked while searching stays
		 * visible) - so "open the ancestors of the matches only while searching" is
		 * `expansion={query ? ancestorIdsOfMatches : undefined}`. Omitted = uncontrolled
		 * (`expanded` is only the initial value).
		 */
		expansion?: NodeId[];
		/**
		 * The user opened / closed a branch (toggle, arrow keys, Enter, double-click, a drop
		 * into a branch). Gets the full list of open ids: the new state when uncontrolled, the
		 * requested state when `expansion` is given. Not called for expansion the tree does on
		 * its own (`autoExpandNewRoots`, revealing a `selection`).
		 */
		onExpandedChange?: (ids: NodeId[]) => void;
		/**
		 * Asked while dragging, for each (target row, position) the pointer reaches, after the
		 * tree's own shape check passed (not onto itself, not into its own subtree; a disabled row
		 * is never a target). Return `false` or `{ allowed: false, reason }` to refuse: the row is
		 * marked as refused (`data-drop-denied`) and releasing there does nothing. `true` /
		 * `{ allowed: true }` accepts. Omitted = every shape-legal drop is accepted. Must be
		 * synchronous and cheap (called on pointer moves, once per target / position change).
		 */
		canDrop?: (request: TreeDropRequest<TData>) => TreeDropVerdict;
		/**
		 * The drop the pointer currently points at changed during a drag: the candidate with the
		 * verdict (and the `reason` from `canDrop`, for the host to show), or `null` when there is
		 * no candidate (outside the rows, over the dragged row, a shape-illegal target, drag ended).
		 */
		onDropTargetChange?: (hover: TreeDropHover<TData> | null) => void;
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
		autoExpandNewRoots = false,
		selectionFollowsFocus = true,
		emptyChildren,
		rowActions,
		expansion,
		onExpandedChange,
		canDrop,
		onDropTargetChange
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

	// Expansion: the host's `expansion` while given, else the tree's own set (which is left
	// untouched meanwhile, so it is what shows again once `expansion` is dropped).
	const hostExpanded = $derived(expansion ? new Set(expansion) : null);
	function isExpandedId(id: NodeId): boolean {
		return hostExpanded ? hostExpanded.has(id) : tree.isExpanded(id);
	}
	/** A user request to open / close `id`: applied when uncontrolled, only reported when controlled. */
	function requestExpanded(id: NodeId, open: boolean): void {
		if (isExpandedId(id) === open) return;
		if (hostExpanded) {
			const next = new Set(hostExpanded);
			if (open) next.add(id);
			else next.delete(id);
			onExpandedChange?.([...next]);
			return;
		}
		if (open) tree.expand(id);
		else tree.collapse(id);
		onExpandedChange?.([...tree.expandedIds]);
	}

	const flat = $derived(flattenVisible(roots, isExpandedId));
	const templateColumns = $derived(
		columns
			? `minmax(180px, 1fr) ${columns.map((c) => `${c.width ?? DEFAULT_COL_WIDTH}px`).join(' ')}`
			: ''
	);

	let editing = $state<{ id: NodeId; draft: string } | null>(null);
	let dropTarget = $state<{ id: NodeId; position: DropPosition; denied: boolean } | null>(null);
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

	// Host-decided expansion: load the lazy branches it lists (also the ones that appear
	// later, inside a branch that just loaded - hence the dependency on `roots`).
	$effect(() => {
		if (!hostExpanded || !loadChildren) return;
		const forest = roots;
		const wanted = [...hostExpanded];
		untrack(() => {
			for (const id of wanted) {
				const node = findNode(forest, id);
				if (node) void ensureLoaded(node);
			}
		});
	});

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

	/**
	 * A branch with an empty `children` array that the host wants an "empty" line for. A lazy
	 * branch is only empty once its load finished (idle / loading / error are not empty).
	 */
	function isEmptyBranch(node: TreeNode<TData>): boolean {
		if (!emptyChildren || node.children === undefined || node.children.length > 0) return false;
		if (!node.hasChildren) return true;
		return tree.getLoadStatus(node.id) === 'loaded';
	}
	/** Shows a disclosure toggle: has children, or is an empty branch with an `emptyChildren` line. */
	function expandable(f: FlatNode<TData>): boolean {
		return f.hasChildren || isEmptyBranch(f.node);
	}
	function isOpen(f: FlatNode<TData>): boolean {
		return expandable(f) && isExpandedId(f.node.id);
	}

	function toggleExpand(node: TreeNode<TData>): void {
		if (isExpandedId(node.id)) {
			requestExpanded(node.id, false);
		} else {
			requestExpanded(node.id, true);
			// Controlled: the load starts once the host lists the id (the effect above).
			if (!hostExpanded) void ensureLoaded(node);
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
		return target instanceof Element && target.closest('[data-tree-control]') !== null;
	}

	// --- trailing row controls (`rowActions`) ---
	function actionsOf(target: EventTarget | null): HTMLElement | null {
		return target instanceof Element ? target.closest<HTMLElement>('[data-tree-actions]') : null;
	}
	// The tree never writes to the host's controls (no `tabindex` rewriting), and it does not
	// recompute the page's Tab order either: a Tab / Shift+Tab inside the tree is the browser's
	// own, run while the other rows' control boxes (the tree's own spans) are `inert` - so it
	// stops only at the tab-stop row and its controls and leaves the tree like any Tab would
	// (disabled fieldsets, positive `tabindex`, the page's edge are the browser's business).
	// A Tab from outside that lands on another row's control is sent to the tab-stop row.
	const TABBABLE =
		'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, audio[controls], video[controls], [tabindex], [contenteditable]:not([contenteditable="false"])';
	function isTabbable(el: HTMLElement): boolean {
		const order =
			el.getAttribute('tabindex') === null && el.matches('[contenteditable]') ? 0 : el.tabIndex;
		if (order < 0) return false;
		// `:disabled` also covers controls inside a disabled `<fieldset>`
		if (el.matches(':disabled')) return false;
		if (el.closest('[inert], [hidden]')) return false;
		return typeof el.checkVisibility === 'function'
			? el.checkVisibility({ visibilityProperty: true })
			: true;
	}
	/**
	 * Focuses the first candidate that really takes the focus (checked on
	 * `document.activeElement`, so any reason a control cannot be focused is covered), else
	 * `fallback` (the row itself).
	 */
	function focusFirstOf(candidates: HTMLElement[], fallback: HTMLElement | undefined): void {
		for (const el of candidates) {
			if (!isTabbable(el)) continue;
			el.focus();
			if (document.activeElement === el) return;
		}
		fallback?.focus();
	}
	/** The other rows' control boxes are `inert` until this key's default action is done. */
	function shieldOtherRowsForOneKey(): void {
		const shielded: HTMLElement[] = [];
		for (const box of containerEl?.querySelectorAll<HTMLElement>('[data-tree-actions]') ?? []) {
			if (box.closest('[data-node-id]')?.getAttribute('data-node-id') === tabStopId) continue;
			box.setAttribute('inert', '');
			shielded.push(box);
		}
		setTimeout(() => {
			for (const box of shielded) box.removeAttribute('inert');
		});
	}
	// A Tab key is under way (set on the window, cleared once its focus move is done).
	let tabbing: 'forward' | 'back' | null = null;
	/**
	 * Every Tab on the page (capture, so no handler can hide it - the rename input's included):
	 * remembers its direction for `onActionsFocusIn`, and when it starts inside this tree,
	 * shuts the other rows' controls out for that key.
	 */
	function onWindowKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return;
		tabbing = event.shiftKey ? 'back' : 'forward';
		setTimeout(() => (tabbing = null));
		if (!(event.target instanceof Element) || !containerEl?.contains(event.target)) return;
		// The row the Tab starts from (e.g. the rename input's) is the tab-stop row from now on.
		const rowId = event.target.closest('[data-node-id]')?.getAttribute('data-node-id');
		if (rowId != null && elements.has(rowId) && tabStopId !== rowId) tree.focusedId = rowId;
		shieldOtherRowsForOneKey();
	}
	/**
	 * Focus reached a row's controls. Whatever it came from, a row other than the tab-stop row
	 * never keeps a keyboard (Tab) focus: it goes to the tab-stop row (Shift+Tab: that row's last
	 * control that takes the focus, else the row). A click or a host's `focus()` instead makes
	 * that row the tab-stop row (the user picked it).
	 */
	function onActionsFocusIn(id: NodeId): void {
		if (tabbing && tabStopId !== null && tabStopId !== id) {
			const rowEl = elements.get(tabStopId);
			const controls =
				tabbing === 'back'
					? [
							...(rowEl?.querySelectorAll<HTMLElement>(`[data-tree-actions] :is(${TABBABLE})`) ??
								[])
						]
					: [];
			focusFirstOf(controls.reverse(), rowEl);
			return;
		}
		tree.focusedId = id;
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
		else if (!nodeHasChildren(node) && !isEmptyBranch(node)) onActivate?.(node);
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
		// IME の変換中の Enter（確定）・Escape（取り消し）は変換側のもの。素通しにする
		// （一部の WebView は変換確定の keydown で isComposing が false になり keyCode 229 だけが立つ）。
		if (event.isComposing || event.keyCode === 229) return;
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
		} else if (selectionMode === 'single' && selectionFollowsFocus && !target.node.disabled) {
			tree.selectOnly(id);
			emitSelection();
		} else {
			tree.focusedId = id;
		}
		scheduleFocus(id);
	}

	function onKeydown(event: KeyboardEvent): void {
		if (editing) return;
		// A Tab is the browser's own (the other rows are shut out in `onWindowKeydown`).
		if (rowActions && event.key === 'Tab') return;
		// Inside a row's trailing controls the keys belong to the control (Enter / Space press
		// the button, arrows may drive a host widget). Only Escape is ours: back to the row.
		const actions = actionsOf(event.target);
		if (actions) {
			if (event.key === 'Escape' && !event.defaultPrevented) {
				const rowId = actions.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
				if (rowId !== undefined) {
					event.preventDefault();
					tree.focusedId = rowId;
					elements.get(rowId)?.focus();
				}
			}
			return;
		}
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
				if (expandable(f) && !isOpen(f)) toggleExpand(f.node);
				else if (f.expanded) moveFocus(index + 1, false);
				break;
			case 'ArrowLeft':
				event.preventDefault();
				if (isOpen(f)) requestExpanded(f.node.id, false);
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
				if (selectionMode === 'single' && !selectionFollowsFocus) selectAt(index, event);
				if (expandable(f)) toggleExpand(f.node);
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
		window.addEventListener('pointercancel', onDragCancel);
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
		const el = hit instanceof Element ? hit.closest<HTMLElement>('[data-node-id]') : null;
		if (!el) {
			clearDropTarget();
			return;
		}
		const targetId = el.getAttribute('data-node-id');
		// Only a row of THIS tree (another tree on the page may use the same ids).
		if (targetId === null || targetId === dragState.id || elements.get(targetId) !== el) {
			clearDropTarget();
			return;
		}
		const rect = el.getBoundingClientRect();
		const y = event.clientY - rect.top;
		const third = rect.height / 3;
		const targetNode = findNode(roots, targetId);
		if (targetNode?.disabled) {
			// disabled rows used to be skipped by pointer-events: none
			clearDropTarget();
			return;
		}
		let position: DropPosition;
		if (y < third) position = 'before';
		else if (y > rect.height - third) position = 'after';
		else position = targetNode && nodeHasChildren(targetNode) ? 'inside' : 'after';
		// Same candidate as the last move: keep the verdict (the host is asked once per change;
		// the drop itself is judged again on release).
		if (dropTarget?.id === targetId && dropTarget.position === position) return;
		const judged = judgeDrop(dragState.id, targetId, position);
		if (!judged) {
			clearDropTarget();
			return;
		}
		dropTarget = { id: targetId, position, denied: !judged.allowed };
		onDropTargetChange?.(judged);
	}
	/**
	 * The tree's shape check, then the host's `canDrop`, on the current forest. `null` when the
	 * shape (or a missing / disabled node) rules the drop out before the host is asked.
	 */
	function judgeDrop(
		dragId: NodeId,
		targetId: NodeId,
		position: DropPosition
	): TreeDropHover<TData> | null {
		const dragged = findNode(roots, dragId);
		const target = findNode(roots, targetId);
		if (!dragged || !target || target.disabled) return null;
		if (!canDropShape(roots, dragId, targetId, position)) return null;
		const request: TreeDropRequest<TData> = {
			dragged,
			target,
			position,
			parent: position === 'inside' ? target : findParent(roots, targetId)
		};
		const verdict = canDrop ? canDrop(request) : true;
		const allowed = typeof verdict === 'boolean' ? verdict : verdict.allowed;
		const reason = typeof verdict === 'boolean' || allowed ? undefined : verdict.reason;
		return { ...request, allowed, reason };
	}
	function clearDropTarget(): void {
		if (dropTarget === null) return;
		dropTarget = null;
		onDropTargetChange?.(null);
	}
	/** Ends a drag (release, cancel or teardown): listeners off, candidate cleared. */
	function endDrag(): void {
		window.removeEventListener('pointermove', onDragMove);
		window.removeEventListener('pointerup', onDragUp);
		window.removeEventListener('pointercancel', onDragCancel);
		dragState = null;
		clearDropTarget();
	}
	function onDragCancel(event: PointerEvent): void {
		if (!dragState || event.pointerId !== dragState.pointerId) return;
		endDrag();
	}
	function onDragUp(event: PointerEvent): void {
		// Only the pointer that started the drag ends it.
		if (!dragState || event.pointerId !== dragState.pointerId) return;
		const ds = dragState;
		const dt = dropTarget;
		endDrag();
		if (!ds.active || !dt || dt.denied) return;
		// Judged again on the current forest and host state: the hover verdict may be stale.
		const judged = judgeDrop(ds.id, dt.id, dt.position);
		if (!judged?.allowed) return;
		if (onMove) onMove(ds.id, dt.id, dt.position);
		else roots = moveNode(roots, ds.id, dt.id, dt.position);
		if (dt.position === 'inside') requestExpanded(dt.id, true);
	}
	// A tree torn down mid-drag leaves no window listeners behind.
	$effect(() => () => untrack(endDrag));

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

<svelte:window onkeydowncapture={rowActions ? onWindowKeydown : undefined} />

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
		{@const rowContext = {
			selected: selectionMode !== 'none' && tree.isSelected(node.id),
			focused: tree.focusedId === node.id,
			expanded: isOpen(f),
			hasChildren: expandable(f),
			depth: f.depth,
			disabled: !!node.disabled
		}}
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
			class:drop-denied={dropTarget?.id === node.id && dropTarget.denied}
			data-drop-denied={dropTarget?.id === node.id && dropTarget.denied ? '' : undefined}
			role="treeitem"
			data-node-id={node.id}
			aria-level={f.depth + 1}
			data-depth={f.depth}
			aria-setsize={f.setSize}
			aria-posinset={f.posInSet}
			aria-expanded={expandable(f) ? isOpen(f) : undefined}
			aria-selected={selectionMode !== 'none' ? tree.isSelected(node.id) : undefined}
			aria-disabled={node.disabled ? 'true' : undefined}
			aria-label={label || rowActions ? node.label : undefined}
			tabindex={tabStopId === node.id ? 0 : -1}
			style:grid-template-columns={columns ? templateColumns : undefined}
			use:register={node.id}
			onclick={(e) => onRowClick(e, index)}
			ondblclick={(e) => onRowDblClick(e, node)}
			onpointerdown={(e) => onRowPointerDown(e, node)}
			oncontextmenu={(e) => onRowContextMenu(e, node)}
		>
			<div class="primary" style:padding-left={`${f.depth * INDENT_PX}px`}>
				{#if expandable(f)}
					<button
						type="button"
						class="toggle"
						data-tree-control
						tabindex="-1"
						aria-label={isOpen(f) ? t.collapse(node.label) : t.expand(node.label)}
						onclick={(e) => {
							e.stopPropagation();
							if (node.disabled) return;
							toggleExpand(node);
						}}
					>
						<span class="chevron" class:open={isOpen(f)} aria-hidden="true">▸</span>
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
							{@render label(node, rowContext)}
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

				{#if rowActions}
					<!-- The host's controls. `data-tree-control` keeps their clicks / drags away from
					     the row; the tab order is kept by the tree's keyboard handling (never by
					     rewriting the host's attributes). -->
					<span
						class="row-actions"
						data-tree-control
						data-tree-actions
						onfocusin={() => onActionsFocusIn(node.id)}
					>
						{@render rowActions(node, rowContext)}
					</span>
				{/if}
			</div>

			{#if columns}
				{#each columns as col (col.id)}
					<div class="cell" style:text-align={col.align ?? 'left'}>{cellText(col, node)}</div>
				{/each}
			{/if}
		</div>
		{#if emptyChildren && isOpen(f) && isEmptyBranch(node)}
			<!-- Not a node: not in `flat` (so the arrow keys skip it), no tabindex stop, no
			     aria-selected. A disabled treeitem one level down is the only role a tree allows here. -->
			<!-- svelte-ignore a11y_role_has_required_aria_props (aria-selected would claim it is selectable) -->
			<div
				class="tree-row empty-children"
				role="treeitem"
				aria-disabled="true"
				aria-level={f.depth + 2}
				aria-setsize="1"
				aria-posinset="1"
				data-depth={f.depth + 1}
				data-empty-children={node.id}
				tabindex="-1"
				style:grid-template-columns={columns ? templateColumns : undefined}
			>
				<div class="primary" style:padding-left={`${(f.depth + 1) * INDENT_PX}px`}>
					<span class="toggle-spacer" aria-hidden="true"></span>
					<span class="label">{@render emptyChildren(node, { depth: f.depth + 1 })}</span>
				</div>
			</div>
		{/if}
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
	/* refused by the host's `canDrop` (after the position rules, so it wins) */
	.tree-row.drop-denied {
		cursor: not-allowed;
	}
	.tree-row.drop-denied::before,
	.tree-row.drop-denied::after {
		background: var(--banto-danger);
	}
	.tree-row.drop-denied.drop-inside {
		background: color-mix(in srgb, var(--banto-danger) 12%, transparent);
		box-shadow: inset 0 0 0 1px var(--banto-danger);
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

	.row-actions {
		display: inline-flex;
		align-items: center;
		gap: var(--banto-space-1);
		flex: 0 0 auto;
		margin-inline-start: auto;
		padding-inline-start: var(--banto-space-2);
		font-weight: 400;
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

	.tree-row.empty-children {
		color: var(--banto-text-muted);
	}
	.tree-row.empty-children:hover {
		background: transparent;
	}

	.empty {
		padding: var(--banto-space-4) var(--banto-space-3);
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-md);
	}
</style>
