/**
 * Reactive dock state (Svelte 5 runes): the list of floating pseudo-windows
 * (spec §5.1/§5.2, M7 scope) PLUS the docked layout tree (M8 Phase A). All
 * geometry decisions delegate to the pure `core/geometry.ts` helpers, and all
 * docked-tree decisions delegate to the pure `core/tree.ts` helpers; this
 * class only owns reassigning `layout` so Svelte's reactivity picks up each
 * change, plus the bookkeeping of moving a panel between `floating` and
 * `docked` (which lives in neither module since it touches both).
 */
import {
	DEFAULT_MIN_HEIGHT,
	DEFAULT_MIN_WIDTH,
	DEFAULT_WINDOW_HEIGHT,
	DEFAULT_WINDOW_WIDTH,
	applyDrag,
	applyResize,
	bringToFront,
	cascadePosition,
	clampWindowToHost
} from './core/geometry';
import {
	collectPanelIds,
	defaultMakeId,
	dockPanelIntoTree,
	findNode,
	moveTabWithinGroup,
	normalizeSizes,
	removePanel,
	resizeSplit as resizeSplitTree,
	setActiveTab as setActiveTabTree
} from './core/tree';
import type {
	DockLayout,
	DockNode,
	DockPanelNode,
	DropRegion,
	FloatingWindow,
	FloatingWindowDef,
	ResizeEdge
} from './types';

function isFloatingWindow(value: unknown): value is FloatingWindow {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === 'string' &&
		typeof candidate.title === 'string' &&
		(candidate.icon === undefined || typeof candidate.icon === 'string') &&
		typeof candidate.x === 'number' &&
		typeof candidate.y === 'number' &&
		typeof candidate.width === 'number' &&
		typeof candidate.height === 'number' &&
		typeof candidate.open === 'boolean'
	);
}

function isDockNode(value: unknown): value is DockNode {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.id !== 'string') return false;
	if (candidate.type === 'panel') {
		return (
			typeof candidate.title === 'string' &&
			(candidate.icon === undefined || typeof candidate.icon === 'string')
		);
	}
	if (candidate.type === 'tabs') {
		return (
			Array.isArray(candidate.children) &&
			candidate.children.every((c) => isDockNode(c) && c.type === 'panel') &&
			typeof candidate.activeIndex === 'number'
		);
	}
	if (candidate.type === 'split') {
		return (
			(candidate.direction === 'row' || candidate.direction === 'column') &&
			Array.isArray(candidate.children) &&
			candidate.children.length >= 2 &&
			candidate.children.every(isDockNode) &&
			Array.isArray(candidate.sizes) &&
			candidate.sizes.length === candidate.children.length &&
			candidate.sizes.every((s) => typeof s === 'number')
		);
	}
	return false;
}

function isDockLayoutV2(value: unknown): value is DockLayout {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.version === 2 &&
		Array.isArray(candidate.floating) &&
		candidate.floating.every(isFloatingWindow) &&
		(candidate.docked === null || isDockNode(candidate.docked))
	);
}

function isDockLayoutV1(value: unknown): value is { version: 1; floating: FloatingWindow[] } {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.version === 1 &&
		Array.isArray(candidate.floating) &&
		candidate.floating.every(isFloatingWindow)
	);
}

function emptyLayout(): DockLayout {
	return { version: 2, floating: [], docked: null };
}

function placeNew(
	def: FloatingWindowDef,
	index: number,
	hostW: number,
	hostH: number
): FloatingWindow {
	const width = def.width ?? DEFAULT_WINDOW_WIDTH;
	const height = def.height ?? DEFAULT_WINDOW_HEIGHT;
	const { x, y } = cascadePosition(index, hostW, hostH, width, height);
	return clampWindowToHost(
		{ id: def.id, title: def.title, icon: def.icon, x, y, width, height, open: true },
		hostW,
		hostH
	);
}

export class DockState {
	layout: DockLayout = $state(emptyLayout());
	/** Injected id generator for newly-created split/tabs nodes - defaults to `crypto.randomUUID` (see `core/tree.ts#defaultMakeId`); tests pass a deterministic counter instead. */
	#makeId: () => string;

	constructor(initial?: DockLayout | string, makeId: () => string = defaultMakeId) {
		this.#makeId = makeId;
		if (typeof initial === 'string') {
			this.hydrate(initial);
		} else if (initial) {
			this.layout = initial;
		}
	}

	isOpen(id: string): boolean {
		return this.layout.floating.find((w) => w.id === id)?.open ?? false;
	}

	/** Opens (marking `open: true`) and brings the window to front. No-op if the id doesn't exist yet - see `ensureWindow`. */
	open(id: string): void {
		if (!this.layout.floating.some((w) => w.id === id)) return;
		this.#update(id, (w) => ({ ...w, open: true }));
		this.focus(id);
	}

	/** Closes the window but keeps its geometry so a later `open`/`toggle` restores the same position/size. */
	close(id: string): void {
		this.#update(id, (w) => ({ ...w, open: false }));
	}

	toggle(id: string): void {
		if (this.isOpen(id)) this.close(id);
		else this.open(id);
	}

	/** Bring a window to the front of z-order (render order = z-order; spec §5.2). */
	focus(id: string): void {
		this.layout = bringToFront(this.layout, id);
	}

	move(id: string, dx: number, dy: number, hostW: number, hostH: number): void {
		this.#update(id, (w) => applyDrag(w, dx, dy, hostW, hostH));
	}

	resize(id: string, edge: ResizeEdge, dx: number, dy: number, hostW: number, hostH: number): void {
		this.#update(id, (w) =>
			applyResize(w, edge, dx, dy, hostW, hostH, DEFAULT_MIN_WIDTH, DEFAULT_MIN_HEIGHT)
		);
	}

	/** Adds `def` with a cascade position if it isn't in the layout yet; otherwise a no-op (existing geometry/open-state is left untouched). */
	ensureWindow(def: FloatingWindowDef, hostW: number, hostH: number): void {
		if (this.layout.floating.some((w) => w.id === def.id)) return;
		const win = placeNew(def, this.layout.floating.length, hostW, hostH);
		this.layout = { ...this.layout, floating: [...this.layout.floating, win] };
	}

	/**
	 * Like `ensureWindow`, but for a def that may belong in the docked tree.
	 * Rule (kept deliberately simple - see the M8 Phase A task write-up):
	 *  - If a `targetId` is given, OR the layout already has a docked root,
	 *    dock `def` in via `dockPanelIntoTree` (default `region: 'center'`,
	 *    default target: the docked root itself, which `dockPanelIntoTree`
	 *    resolves down to a real leaf pane). This is what lets a docked
	 *    default layout, once seeded (e.g. by one `dockPanel` call), keep
	 *    growing as more panels are added.
	 *  - Otherwise (no docked root yet and no explicit target) falls through
	 *    to `ensureWindow`'s floating cascade-placement behavior - this is
	 *    what seeds the very first panel.
	 * No-ops if `def.id` already exists anywhere (floating or docked).
	 */
	ensurePanel(
		def: FloatingWindowDef,
		hostW: number,
		hostH: number,
		region: DropRegion = 'center',
		targetId?: string
	): void {
		const known =
			this.layout.floating.some((w) => w.id === def.id) ||
			collectPanelIds(this.layout.docked).includes(def.id);
		if (known) return;

		if (this.layout.docked !== null || targetId !== undefined) {
			const panelNode: DockPanelNode = {
				type: 'panel',
				id: def.id,
				title: def.title,
				icon: def.icon
			};
			const effectiveTarget = targetId ?? this.layout.docked!.id;
			const docked = dockPanelIntoTree(
				this.layout.docked,
				panelNode,
				effectiveTarget,
				region,
				this.#makeId
			);
			this.layout = { ...this.layout, docked };
			return;
		}

		this.ensureWindow(def, hostW, hostH);
	}

	/** Move a currently-floating panel into the docked tree at `targetId`/`region` (spec §5.2: drag a floating window in to dock it). Carries over its title/icon; a no-op if `panelId` isn't a floating window. */
	dockPanel(panelId: string, targetId: string, region: DropRegion): void {
		const win = this.layout.floating.find((w) => w.id === panelId);
		if (!win) return;
		const panelNode: DockPanelNode = {
			type: 'panel',
			id: win.id,
			title: win.title,
			icon: win.icon
		};
		const docked = dockPanelIntoTree(this.layout.docked, panelNode, targetId, region, this.#makeId);
		const floating = this.layout.floating.filter((w) => w.id !== panelId);
		this.layout = { ...this.layout, floating, docked };
	}

	/**
	 * Move a currently-docked panel back out to floating (spec §5.2: drag a
	 * tab out of its group to float it). Removes it from the docked tree
	 * (collapsing any split/tabs group left with 0-1 children) and appends it
	 * to `floating` as an open window. `geometry` (all fields optional) seeds
	 * the new floating window's position/size - typically the drop point/size
	 * from the drag that triggered this; omitted fields fall back to a simple
	 * index-based cascade (no host bounds are known here, unlike
	 * `ensureWindow`/`reset`, since this op is host-agnostic - the next
	 * `move`/`resize` call clamps to the real host as usual). A no-op if
	 * `panelId` isn't currently docked.
	 */
	undockPanel(
		panelId: string,
		geometry?: Partial<Pick<FloatingWindow, 'x' | 'y' | 'width' | 'height'>>
	): void {
		const node = findNode(this.layout.docked, panelId);
		if (!node || node.type !== 'panel') return;

		const docked = removePanel(this.layout.docked, panelId);
		const index = this.layout.floating.length;
		const width = geometry?.width ?? DEFAULT_WINDOW_WIDTH;
		const height = geometry?.height ?? DEFAULT_WINDOW_HEIGHT;
		const win: FloatingWindow = {
			id: node.id,
			title: node.title,
			icon: node.icon,
			x: geometry?.x ?? index * 24,
			y: geometry?.y ?? index * 24,
			width,
			height,
			open: true
		};
		this.layout = { ...this.layout, docked, floating: [...this.layout.floating, win] };
	}

	/** Relocate a panel that's ALREADY docked to a new split/group (spec §5.2: drag a docked tab to a new spot). Removes then re-docks it, so it's equivalent to `undockPanel` + `dockPanel` without the floating round-trip. A no-op if `panelId` isn't currently docked. */
	dockExisting(panelId: string, targetId: string, region: DropRegion): void {
		const node = findNode(this.layout.docked, panelId);
		if (!node || node.type !== 'panel') return;
		const removed = removePanel(this.layout.docked, panelId);
		const docked = dockPanelIntoTree(removed, node, targetId, region, this.#makeId);
		this.layout = { ...this.layout, docked };
	}

	/** Change the visible tab of the docked tab group `groupId`. No-op if unknown. */
	setActiveTab(groupId: string, index: number): void {
		this.layout = { ...this.layout, docked: setActiveTabTree(this.layout.docked, groupId, index) };
	}

	/** Reorder a tab within its group (spec §5.2 "タブの並び替え"). No-op if unknown/out of range. */
	moveTab(groupId: string, from: number, to: number): void {
		this.layout = {
			...this.layout,
			docked: moveTabWithinGroup(this.layout.docked, groupId, from, to)
		};
	}

	/** Resize a split's two panes adjacent to `dividerIndex` by `deltaFraction` (spec §5.2 split resizing). No-op if unknown/out of range. */
	resizeSplit(splitId: string, dividerIndex: number, deltaFraction: number): void {
		this.layout = {
			...this.layout,
			docked: resizeSplitTree(this.layout.docked, splitId, dividerIndex, deltaFraction)
		};
	}

	/** Serialize the whole layout for persistence (spec §5.1). */
	serialize(): string {
		return JSON.stringify(this.layout);
	}

	/**
	 * Apply a previously-serialized layout onto this instance. Malformed JSON
	 * or a payload that doesn't match a v1 or v2 `DockLayout` shape is ignored
	 * (state is left unchanged). A v1 payload (M7, no `docked` field) is
	 * migrated to v2 with `docked: null`. Ids that no longer correspond to a
	 * known window definition are deliberately kept as-is - pruning them is
	 * the host component's job at render time (`ensureWindow`/`ensurePanel`
	 * never remove anything). A v2 payload's `docked` tree has its `sizes`
	 * repaired via `normalizeSizes` in case of drift (e.g. hand-edited JSON).
	 */
	hydrate(json: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(json);
		} catch {
			return;
		}
		if (isDockLayoutV2(parsed)) {
			this.layout = { ...parsed, docked: parsed.docked ? normalizeSizes(parsed.docked) : null };
			return;
		}
		if (isDockLayoutV1(parsed)) {
			this.layout = { version: 2, floating: parsed.floating, docked: null };
			return;
		}
	}

	/** Discard the current layout (docked tree included) and re-place every def at its cascade default, all open, floating. */
	reset(defs: FloatingWindowDef[], hostW: number, hostH: number): void {
		this.layout = {
			version: 2,
			floating: defs.map((def, index) => placeNew(def, index, hostW, hostH)),
			docked: null
		};
	}

	#update(id: string, fn: (win: FloatingWindow) => FloatingWindow): void {
		const index = this.layout.floating.findIndex((w) => w.id === id);
		if (index === -1) return;
		const next = this.layout.floating.slice();
		next[index] = fn(next[index]);
		this.layout = { ...this.layout, floating: next };
	}
}

/**
 * Create a `DockState`, optionally seeded from a `DockLayout` or a serialized
 * JSON string (see `hydrate`). `makeId` (default `crypto.randomUUID` via
 * `core/tree.ts#defaultMakeId`) generates ids for new split/tabs nodes -
 * tests pass a deterministic counter instead.
 */
export function createDockState(initial?: DockLayout | string, makeId?: () => string): DockState {
	return new DockState(initial, makeId);
}
