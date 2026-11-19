/**
 * Keyboard (and API) path for re-docking a pane (#663 ④, docs/design/three-pane-dock-plan.md
 * §4.6): `DockHost.movePanel` and the "panel actions" menu (`DockPanelMenu.svelte`) both go
 * through `PanelMover.move`, which hands every target to the SAME `DragController` methods a
 * pointer drop uses (`placeAtEdge` / `placeOnto` / `floatDocked`), so the capabilities, the
 * `dropCenter` / `dropSplit` offer, the `beforePanelChange` kinds (the panes pushed out first,
 * then `dock` / `move-docked` / `undock`), the stale checks and the outer edge's share are the
 * drag's. A move the drag would not offer is `unavailable` and changes nothing.
 *
 * Who may move what (the drag's rules): the pane's `move` capability; a floating window that
 * is `locked` does not move (its tabs / close / raise are not affected); a collapsed region,
 * an auto-hidden pane and a closed window do not move; floating needs `undock` too.
 *
 * The result is announced in the host's `aria-live="polite"` region (`announcement`), worded
 * by `DockMessages`. Focus: when the move came from the menu (`returnFocus` = its button), an
 * applied move puts the focus on the moved pane's title bar (its tab, or its menu button) and
 * anything else hands it back to the button - only when the focus was dropped (`<body>`) or is
 * still on the button / in the moved pane, not when it was taken elsewhere while the app's answer
 * waited; an API call only repairs a focus the move dropped (it was in the host and is now on
 * `<body>`).
 *
 * No keyboard shortcut is bound (plan §9 Q5): the menu is the keyboard path.
 */
import { getContext, setContext, tick } from 'svelte';
import type { DragController } from './drag.svelte';
import type { DockPanelChangeOutcome } from './lifecycle';
import { resolveCapabilities, type DockPolicy } from './policy';
import { collectPanelIds, findNode, findParent, removePanel } from './tree';
import type { DockMessages } from '../messages';
import type { DockState } from '../state.svelte';
import type { DockEdge } from '../types';

/**
 * Where `DockHost.movePanel` moves a pane (#663 ④):
 *  - `{ edge }`: an outer edge of the host (the docked root is wrapped, like the outer-edge guide buttons);
 *  - `{ tabWith }`: into the tab group of the docked pane `tabWith` (the cross guide's centre);
 *  - `{ splitWith, side }`: next to the docked pane `splitWith`'s region on that side (the cross guide's arrows);
 *  - `{ float: true }`: a docked pane becomes a floating window;
 *  - `{ back: true }`: a floating window that was floated from the tree in this host goes back where it was.
 */
export type DockMoveTarget =
	| { edge: DockEdge }
	| { tabWith: string }
	| { splitWith: string; side: DockEdge }
	| { float: true }
	| { back: true };

/** How `movePanel` ended: a `DockPanelChangeOutcome`, or `unavailable` (the drag would not offer this move; nothing was asked or changed). */
export type DockMoveOutcome = DockPanelChangeOutcome | 'unavailable';

/** A docked pane another pane can be moved next to / into (`DockMoveOptions`). */
export interface DockMoveTargetPane {
	id: string;
	title: string;
}

/** Which moves are offered for a pane now (the menu's items). Empty lists / `false` = not offered. */
export interface DockMoveOptions {
	edges: DockEdge[];
	tabWith: DockMoveTargetPane[];
	splitWith: DockMoveTargetPane[];
	float: boolean;
	back: boolean;
}

const EDGES: DockEdge[] = ['left', 'right', 'top', 'bottom'];

const NONE: DockMoveOptions = { edges: [], tabWith: [], splitWith: [], float: false, back: false };

export interface PanelMoverOptions {
	/** The host's live `messages` merged over the defaults. */
	messages: () => Required<DockMessages>;
	/** `false` = no re-arranging at all (a kiosk, plan §4.5 `arrange={false}`, a later PR): every move is `unavailable` and the menu is not offered. Omitted = allowed. */
	arrange?: () => boolean;
}

export class PanelMover {
	#dock: DockState;
	#drag: DragController;
	#getHostEl: () => HTMLElement | null;
	#getPolicy: () => DockPolicy;
	#options: PanelMoverOptions;
	/** Text of the host's `aria-live="polite"` region. */
	announcement = $state('');

	constructor(
		dock: DockState,
		drag: DragController,
		getHostEl: () => HTMLElement | null,
		getPolicy: () => DockPolicy,
		options: PanelMoverOptions
	) {
		this.#dock = dock;
		this.#drag = drag;
		this.#getHostEl = getHostEl;
		this.#getPolicy = getPolicy;
		this.#options = options;
	}

	/** Where the pane is, for moving: a docked pane outside a collapsed region, an open floating window, or `null` (does not move). */
	#source(panelId: string): 'docked' | 'floating' | null {
		const docked = this.#dock.layout.docked;
		const node = findNode(docked, panelId);
		if (node?.type === 'panel') {
			const parent = findParent(docked, panelId);
			const region = parent?.type === 'tabs' ? parent : node;
			return region.collapsed === true ? null : 'docked';
		}
		const win = this.#dock.layout.floating.find((w) => w.id === panelId);
		return win?.open ? 'floating' : null;
	}

	/** May the pane be moved at all (the drag's start rules: `move`, not locked, `arrange`). */
	#movable(panelId: string): 'docked' | 'floating' | null {
		if (this.#options.arrange?.() === false) return null;
		if (!resolveCapabilities(this.#getPolicy(), panelId).move) return null;
		const source = this.#source(panelId);
		if (source === 'floating') {
			const win = this.#dock.layout.floating.find((w) => w.id === panelId);
			if (win?.locked === true || win?.pinned === true) return null;
		}
		return source;
	}

	/**
	 * The drop target (`data-dock-drop-id`) the pane `otherId` stands for when `panelId` moves: its
	 * tab group, or itself - in the tree as it is once `panelId` left it (a group it shared with
	 * `panelId` may shrink to the bare pane). `null` = not a target (the pane itself, not docked,
	 * in a collapsed region).
	 */
	#targetOf(panelId: string, otherId: string): string | null {
		if (otherId === panelId) return null;
		const docked = this.#dock.layout.docked;
		const node = findNode(docked, otherId);
		if (node?.type !== 'panel') return null;
		const now = findParent(docked, otherId);
		if ((now?.type === 'tabs' ? now : node).collapsed === true) return null;
		const rest = this.#source(panelId) === 'docked' ? removePanel(docked, panelId) : docked;
		const after = findParent(rest, otherId);
		return after?.type === 'tabs' ? after.id : otherId;
	}

	/** Is `otherId` in the same tab group as the docked pane `panelId` (joining it as a tab is no move)? */
	#sameGroup(panelId: string, otherId: string): boolean {
		const parent = findParent(this.#dock.layout.docked, panelId);
		return parent?.type === 'tabs' && parent.children.some((c) => c.id === otherId);
	}

	/** Which moves are offered for `panelId` now. Reactive (reads the layout and the policy). */
	options(panelId: string): DockMoveOptions {
		const source = this.#movable(panelId);
		if (!source) return NONE;
		const docked = this.#dock.layout.docked;
		const tabWith: DockMoveTargetPane[] = [];
		const splitWith: DockMoveTargetPane[] = [];
		for (const id of collectPanelIds(docked)) {
			const target = this.#targetOf(panelId, id);
			if (target === null) continue;
			const node = findNode(docked, id);
			const title = node?.type === 'panel' ? node.title : id;
			const offer = this.#drag.dropOptions(target);
			if (offer.center && !this.#sameGroup(panelId, id)) tabWith.push({ id, title });
			if (offer.split) splitWith.push({ id, title });
		}
		return {
			edges: this.#drag.edgesOffered(panelId) ? [...EDGES] : [],
			tabWith,
			splitWith,
			float: source === 'docked' && resolveCapabilities(this.#getPolicy(), panelId).undock,
			back: source === 'floating' && this.#drag.canPlaceBack(panelId)
		};
	}

	/** Whether any move is offered for `panelId` (the menu button is shown). */
	hasOptions(panelId: string): boolean {
		const o = this.options(panelId);
		return (
			o.edges.length > 0 || o.tabWith.length > 0 || o.splitWith.length > 0 || o.float || o.back
		);
	}

	/**
	 * Is `target` offered for `panelId` now (the menu's rules: `#movable`, the capabilities, the
	 * targets' `dropCenter` / `dropSplit`, "back"'s place)? The pane's source, or `null`. Read
	 * when the move starts AND right before it is applied (the drag's `MoveGuard`): a lock or a
	 * capability is not part of `structureKey`, so a change while `beforePanelChange` waits is
	 * caught here (`stale`, nothing applied, no success announced).
	 */
	#offered(panelId: string, target: DockMoveTarget): 'docked' | 'floating' | null {
		const source = this.#movable(panelId);
		if (!source) return null;
		const offered = this.options(panelId);
		if ('edge' in target) return offered.edges.includes(target.edge) ? source : null;
		if ('tabWith' in target || 'splitWith' in target) {
			const otherId = 'tabWith' in target ? target.tabWith : target.splitWith;
			const list = 'tabWith' in target ? offered.tabWith : offered.splitWith;
			if (!list.some((p) => p.id === otherId)) return null;
			if ('splitWith' in target && !EDGES.includes(target.side)) return null;
			return source;
		}
		if ('float' in target) return offered.float ? source : null;
		if ('back' in target) return offered.back ? source : null;
		return null;
	}

	/**
	 * Hand `target` to the drag's own drop path; `null` = the drag would not offer it. `fromMenu`
	 * turns the drag's own focus repair off: `move` then places the focus once, after the outcome
	 * (#720 review: the repair ran first and put it on the group left behind).
	 */
	#start(
		panelId: string,
		target: DockMoveTarget,
		fromMenu: boolean
	): Promise<DockPanelChangeOutcome> | null {
		const source = this.#offered(panelId, target);
		if (!source) return null;
		const guard = () => this.#offered(panelId, target) === source;
		if ('edge' in target)
			return this.#drag.placeAtEdge(panelId, source, target.edge, guard, { refocus: !fromMenu });
		if ('tabWith' in target || 'splitWith' in target) {
			const otherId = 'tabWith' in target ? target.tabWith : target.splitWith;
			const targetId = this.#targetOf(panelId, otherId);
			if (targetId === null) return null;
			const region = 'tabWith' in target ? 'center' : target.side;
			return this.#drag.placeOnto(panelId, source, targetId, region, guard);
		}
		if ('float' in target) return this.#drag.floatDocked(panelId, undefined, guard);
		if ('back' in target) return this.#drag.placeBack(panelId, guard);
		return null;
	}

	/** The title of a pane wherever it is (for the announcement). */
	#titleOf(panelId: string): string {
		const node = findNode(this.#dock.layout.docked, panelId);
		if (node?.type === 'panel') return node.title;
		return this.#dock.layout.floating.find((w) => w.id === panelId)?.title ?? panelId;
	}

	#announce(text: string): void {
		// Cleared first, so the same sentence twice in a row is read again.
		this.announcement = '';
		void tick().then(() => (this.announcement = text));
	}

	#applied(title: string, target: DockMoveTarget, otherTitle: string): string {
		const t = this.#options.messages();
		if ('edge' in target) return t.movedToEdge(title, target.edge);
		if ('tabWith' in target) return t.movedToTabs(title, otherTitle);
		if ('splitWith' in target) return t.movedToSplit(title, otherTitle, target.side);
		if ('float' in target) return t.floated(title);
		return t.dockedBack(title);
	}

	/**
	 * Move `panelId` to `target` (module doc). `returnFocus` = the menu button the move came from.
	 * Resolves after the layout reflects the outcome and the focus was placed.
	 */
	async move(
		panelId: string,
		target: DockMoveTarget,
		options: { returnFocus?: HTMLElement | null } = {}
	): Promise<DockMoveOutcome> {
		const title = this.#titleOf(panelId);
		const otherId =
			'tabWith' in target ? target.tabWith : 'splitWith' in target ? target.splitWith : null;
		const otherTitle = otherId === null ? '' : this.#titleOf(otherId);
		const hostEl = this.#getHostEl();
		const active = document.activeElement;
		const focusWasInHost = !!hostEl && !!active && hostEl.contains(active);
		const started = this.#start(panelId, target, options.returnFocus !== undefined);
		const outcome: DockMoveOutcome = started ? await started : 'unavailable';
		const t = this.#options.messages();
		if (outcome === 'applied') this.#announce(this.#applied(title, target, otherTitle));
		else if (outcome === 'refused') this.#announce(t.moveCancelled(title));
		else if (outcome === 'stale' || outcome === 'superseded') this.#announce(t.moveStale(title));
		else if (outcome === 'unavailable') this.#announce(t.moveUnavailable(title));
		if (outcome === 'disposed') return outcome;
		await tick();
		const host = this.#getHostEl();
		if (!host?.isConnected) return outcome;
		const back = options.returnFocus?.isConnected ? options.returnFocus : null;
		const now = document.activeElement;
		const dropped = !now || now === document.body;
		if (options.returnFocus !== undefined) {
			// From the menu: the moved pane's title bar when applied, else the button.
			const to =
				outcome === 'applied'
					? (titleBarFocusTarget(host, panelId) ?? back)
					: (back ?? titleBarFocusTarget(host, panelId));
			// Only a focus the move dropped, or one still on the button, is moved: one the user / app
			// took elsewhere while the answer waited (an input or a dialog in this pane or another,
			// in or outside the host) is left alone (#720 review). Applied, a focus on the moved
			// pane's own title bar (its tab, button or frame, not its content) is moved too.
			const stayed =
				now === options.returnFocus || (outcome === 'applied' && !!now && onTitleBar(panelId, now));
			if (to && (dropped || stayed)) to.focus();
		} else if (focusWasInHost && dropped) {
			titleBarFocusTarget(host, panelId)?.focus();
		}
		return outcome;
	}
}

/**
 * Whether `el` is in the pane `panelId` (#663 ④): its floating window, its docked frame, its
 * tab, or the content of a tab group whose selected tab it is.
 */
function paneHolds(panelId: string, el: Element): boolean {
	if (el.closest('[data-dock-window-id]')?.getAttribute('data-dock-window-id') === panelId)
		return true;
	const tab = el.closest('[data-dock-tab-id]');
	if (tab) return tab.getAttribute('data-dock-tab-id') === panelId;
	const frame = el.closest('[data-dock-drop-id]');
	if (!frame) return false;
	if (frame.getAttribute('data-dock-drop-id') === panelId) return true;
	return [...frame.querySelectorAll('[role="tab"][data-dock-tab-id]')].some(
		(t) =>
			t.getAttribute('data-dock-tab-id') === panelId &&
			t.getAttribute('aria-selected') === 'true' &&
			t.closest('[data-dock-drop-id]') === frame
	);
}

/**
 * Whether `el` is the pane `panelId`'s title bar rather than its content (#720 review): its tab,
 * its "panel actions" button, or its window / frame / content region element itself.
 */
function onTitleBar(panelId: string, el: Element): boolean {
	if (el.getAttribute('data-dock-tab-id') === panelId) return true;
	if (el.closest('[data-dock-menu-for]')?.getAttribute('data-dock-menu-for') === panelId)
		return true;
	if (el.getAttribute('data-dock-window-id') === panelId) return true;
	if (el.getAttribute('data-dock-drop-id') === panelId) return true;
	return el.getAttribute('role') === 'region' && paneHolds(panelId, el);
}

/**
 * The element of the pane `panelId`'s title bar that takes the focus (#663 ④): its tab in a tab
 * group (roving tabindex), else its "panel actions" button, else its frame's body / its window.
 */
export function titleBarFocusTarget(host: HTMLElement, panelId: string): HTMLElement | null {
	const find = (selector: string, attr: string) =>
		[...host.querySelectorAll<HTMLElement>(selector)].find(
			(el) => el.getAttribute(attr) === panelId
		) ?? null;
	const tab = find('[role="tab"][data-dock-tab-id]', 'data-dock-tab-id');
	if (tab) return tab;
	const menu = find('[data-dock-menu-for]', 'data-dock-menu-for');
	if (menu) return menu;
	const frame = find('[data-dock-drop-id]', 'data-dock-drop-id');
	const region = frame?.querySelector<HTMLElement>('[role="region"]');
	if (region) return region;
	return find('[data-dock-window-id]', 'data-dock-window-id');
}

const MOVER_KEY = Symbol('banto-dock-mover');

/** Called once by `DockHost` during initialization. */
export function setPanelMover(mover: PanelMover): void {
	setContext(MOVER_KEY, mover);
}

/** The host's mover, or `undefined` outside a `DockHost` tree (then no menu is drawn). */
export function getPanelMover(): PanelMover | undefined {
	return getContext<PanelMover | undefined>(MOVER_KEY);
}
