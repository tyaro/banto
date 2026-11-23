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
	clampWindowToHost,
	displayWindowGeometry,
	type ClampOptions
} from './core/geometry';
import { untrack } from 'svelte';
import {
	activePanelOf,
	autoHiddenPanelIds,
	autoHideRegionInLayout,
	findAutoHidden,
	idsOutOfDocked,
	regionOf,
	regionPanelIds,
	removeAutoHiddenPane,
	setAutoHiddenActive,
	type AutoHideOptions
} from './core/autohide';
import { bandTreeOf, readBandTree, shadowBandIds } from './core/bandTree';
import { restoreDockSlot, type HiddenDockSlot } from './core/slot';
import { dockShareOf } from './core/defaultPlace';
import { withLayoutVersion } from './core/layoutVersion';
import { notify } from './core/report';
import {
	dockAtShadowEdge,
	copyShadowSizes,
	deflateShadow,
	dockIntoShadow,
	dockRegionAtShadowEdge,
	findShadowPanel,
	markAway,
	markInBand,
	markPresent,
	placeInShadowAtDefault,
	projectShadow,
	regraftShadow,
	removeFromShadow,
	resizeShadowSplit,
	sameDocked,
	shadowPanelIds,
	withFreeShadowIds,
	withoutLoneFlags,
	writeShadowView,
	type ShadowNode
} from './core/shadow';
import { validateDockLayout } from './core/validate';
import {
	canCollapseRegion,
	collectPanelIds,
	defaultMakeId,
	expandRegionOf,
	findNode,
	findParent,
	moveTabWithinGroup,
	normalizeCollapsed,
	removePanel,
	setActiveTab as setActiveTabTree,
	setRegionCollapsed,
	structureKey
} from './core/tree';
import type {
	DockAutoHidden,
	DockEdge,
	DockLayout,
	DockNode,
	DockPanelInfo,
	DockPanelNode,
	DockSlot,
	DropRegion,
	FloatingWindow,
	FloatingWindowDef,
	ResizeEdge
} from './types';

/** For a prediction that only asks whether a pane docks: the ids of the tree it makes are not used. */
const NO_ID = (): string => '';

/** The collapsed regions of a docked tree (a split's child that is a pane or a tab group), by id. */
function collapsedRegions(
	node: DockNode | null,
	into = new Map<string, DockNode>()
): Map<string, DockNode> {
	if (node === null) return into;
	if (node.type === 'split') node.children.forEach((child) => collapsedRegions(child, into));
	else if (node.collapsed === true) into.set(node.id, node);
	return into;
}

/** Is the region `b` what `a` was: the same pane, or a tab group of the same tabs in the same order? */
function sameRegion(a: DockNode, b: DockNode): boolean {
	if (a.type !== b.type || a.type === 'split' || b.type === 'split') return false;
	if (a.type !== 'tabs' || b.type !== 'tabs') return true;
	return (
		a.children.length === b.children.length && a.children.every((c, i) => c.id === b.children[i].id)
	);
}

function emptyLayout(): DockLayout {
	return { version: 4, floating: [], docked: null };
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

function sameFloatingStructure(a: FloatingWindow[], b: FloatingWindow[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((w, i) => w.id === b[i].id && w.open === b[i].open);
}

let adoptImpl: (dock: DockState, layout: DockLayout) => void;

/**
 * `dock.layout = layout` for a layout taken as a whole (not exported from the package), as
 * `hydrate` takes one. For the library's own whole-layout replacements by a layout that is not
 * made from today's: a saved or default one (`DockHost.replaceLayout` with `saved`,
 * `ThreePaneDock`'s installs - with `forgetHomeSlots`: the floated panes' places belong to the
 * layout replaced) and a cancelled gesture's snapshot, which gets the shadow tree that showed it
 * (`rememberShadow`) - the floated panes' places are as they were when it was taken.
 * A layout made from today's (`ThreePaneDock`'s `syncPanels`, `replaceLayout` without `saved`) is
 * assigned with the setter instead (#741): a floated pane keeps its place when the split / tab
 * group it was in is still in the tree, and has its default place otherwise (#782 PR7).
 */
export function adoptLayout(dock: DockState, layout: DockLayout): void {
	adoptImpl(dock, layout);
}

let rememberImpl: (dock: DockState, snapshot: DockLayout) => void;

/**
 * Tell `dock` that `snapshot` is a copy of its layout as it is now (not exported from the
 * package): the shadow tree of now is kept for it, so `restoreSplitSizes(id, snapshot)` puts the
 * shares of the panes out of the tree back too (#782 PR6, Codex P2 on #864), and
 * `adoptLayout(dock, snapshot)` puts back the whole of it with the floated panes' `homeSlot`s of
 * now (#782 PR7: also for a pane docked again meanwhile, and when nothing is docked). The gesture
 * controller's snapshot is a clone (`$state.snapshot`), which `DockState` cannot know by identity
 * as it knows the layouts it was assigned. Held weakly: gone with the snapshot.
 */
export function rememberShadow(dock: DockState, snapshot: DockLayout): void {
	rememberImpl(dock, snapshot);
}

let homeMarkImpl: (dock: DockState, id: string) => object | undefined;

/**
 * An object that stands for the place floated pane `id` remembers (not exported from the
 * package; `undefined`: none): the same object for as long as the pane remembers the same place,
 * another one once it is docked and floated again (#735). For asking "is it the same floating
 * window as when the answer was asked?" without a slot (#782 PR8a).
 */
export function homeMark(dock: DockState, id: string): object | undefined {
	return homeMarkImpl(dock, id);
}

let forgetImpl: (dock: DockState) => void;

/**
 * Drop every floated pane's `homeSlot` (not exported from the package): for a layout that is not
 * made from today's and replaces it - a saved one, or one kept and shown again later
 * (`ThreePaneDock`'s narrow display, #739 review). The places belong to the layout replaced; a
 * floated pane still floating in the new one (say closed) would otherwise be put back into a
 * tree it was never floated out of.
 */
export function forgetHomeSlots(dock: DockState): void {
	forgetImpl(dock);
}

/**
 * How the shadow tree followed one assignment of `layout` (#782 PR4, `watchShadow`). `step` is the
 * `DockState` method that said what it did to the tree (`null`: an assignment that did not).
 *  - `same`: the step alone, done on S, shows the docked tree assigned. Always so for a step
 *    made on S, whose docked tree is the projection of S (#782 PR6: floating out and back, moves,
 *    drops, a divider drag, showing and hiding); for an assignment no step described, S shows the
 *    tree once the docked panes it dropped are taken out.
 *  - `written`: it does once the sizes, active tabs, tab order, `collapsed` flags and titles of
 *    the docked tree are written onto S (what a tab click changes; a `collapsed` flag S cannot
 *    hold - `DockState`'s `#shows` - leaves a step made on S `written` too).
 *  - `rebuilt`: S was made again around the docked tree, for a change no step described (an
 *    assignment from outside, a layout taken as a whole, a pane docked by a slot that is not its
 *    place in S): with the panes out of the tree - floated, or in an edge band - put back by the
 *    container each was in (`regraftShadow`, #782 PR7); a layout taken as a whole brings the
 *    places of its edge bands with it (`DockLayout.dockedWithAutoHidden`, #782 PR8b).
 *  - `failed`: following threw; S is the docked tree with no pane remembered.
 */
export interface ShadowFollow {
	step: string | null;
	result: 'same' | 'written' | 'rebuilt' | 'failed';
}

type ShadowStep = { label: string; run: (s: ShadowNode | null) => ShadowNode | null };

/** What `shadowStateOf` gives (tests only). */
export interface ShadowState {
	shadow: ShadowNode | null;
	/** The panes out of the tree whose slot names no place in S. */
	unplaced: string[];
	/** How many assignments of `layout` S was looked at for (not the ones that could not change it). */
	follows: number;
}

let shadowImpl: (dock: DockState) => ShadowState;
let watchShadowImpl: (dock: DockState, watch: ((follow: ShadowFollow) => void) | null) => void;

/**
 * The shadow tree `dock` keeps beside its layout, and the panes out of the tree whose slot names
 * no place in it (#782 PR4; not exported from the package). For the tests only.
 * `projectShadow(shadow)` is the same as `layout.docked` after every assignment.
 */
export function shadowStateOf(dock: DockState): ShadowState {
	return shadowImpl(dock);
}

/** Be told how S followed each assignment of `dock.layout` that changed it (tests only; `null` stops). */
export function watchShadow(dock: DockState, watch: ((follow: ShadowFollow) => void) | null): void {
	watchShadowImpl(dock, watch);
}

/** What a `DockState` holds beside its layout at one moment (`rememberShadow`). */
interface HeldShadow {
	shadow: ShadowNode | null;
	homes: Map<string, DockSlot>;
	unplaced: Set<string>;
	lost: Set<string>;
}

export class DockState {
	#layout: DockLayout = $state(emptyLayout());
	/**
	 * The default layout (#782 PR5): where every pane belongs. `show` docks a pane hidden from the
	 * docked tree (`dismiss`, the close button, `hidePanel` / `closePanel`) at its place in this
	 * layout's `docked` tree (`core/defaultPlace.ts`), whatever place it was hidden from. Only
	 * `docked` is read. `null` (the default), or a pane the tree does not hold: the pane opens
	 * floating. Not saved and not part of `layout`: set it again after a reload (`ThreePaneDock`
	 * sets its own). The ids of its splits and tab groups should be distinct and stay the same.
	 */
	defaultLayout: DockLayout | null = $state.raw(null);
	/** The structure revision (plain, not reactive) - see `structureRevision`. */
	#structureRevision = 0;
	/** The layout last seen by the setter and its `structureKey` (plain fields: the setter never reads `$state`). */
	#structureSeen: DockLayout | null = null;
	#structureSeenKey = '';
	/**
	 * Every panel id ever seen in a layout, in the order first seen (plain, not
	 * reactive: it only changes together with `#layout`, which `panels` reads).
	 * Ids that leave the layout keep their place, so a pane that comes back
	 * returns to the same row of a View menu.
	 */
	#seenOrder: string[] = [];
	#seenIds = new Set<string>();
	/**
	 * Where each pane taken out of the tree by `undockPanel` was docked (#663 ④, `homeSlot`), in
	 * the order they left. A hidden pane remembers no place (#782 PR5). Plain (not reactive) and not
	 * saved; an entry whose pane is no longer a floating window - docked again by any path,
	 * auto-hidden or gone - is dropped by the `layout` setter (#735).
	 *
	 * Since #782 PR6 the place itself is the pane's tombstone in `#shadow`, and the slot is its
	 * name: what `homeSlot` hands out for "back" (`dockAtSlot` takes it as the name of that place).
	 * It is written once, as S says the place when the pane is floated (`deflateShadow`), and never
	 * rewritten (#782 PR7): the shares and the neighbours of the place change in S, not here.
	 */
	#homeSlots = new Map<string, DockSlot>();
	/**
	 * The floated panes whose place went with a change that was not made on S (an assignment from
	 * outside): S holds none for them, and "back" docks them at their default place (#782 PR7).
	 */
	#shadowLost = new Set<string>();
	/**
	 * The shadow tree S (#782 PR4, `core/shadow.ts`): the docked tree with every pane that is out
	 * of it but remembers a docked place - a pane floated by `undockPanel`; a hidden pane remembers
	 * none (#782 PR5) - as a tombstone. What decides where panes go (#782 PR6): floating a pane out
	 * and docking it back (`undockPanel`, `dockAtSlot` with its `homeSlot`), moving a docked pane and
	 * dropping a floating one (`dockExisting*`, `dockPanel*`, `ensurePanel`), a divider drag
	 * (`resizeSplit`), and showing and hiding (`show` works the default place out on S, `dismiss`)
	 * are done on S, and the docked tree assigned is its projection. After every assignment its
	 * projection is `layout.docked` (`#followShadow`, which follows the changes not made on S: tabs,
	 * flags, an assignment from outside). Plain.
	 *
	 * A region auto-hidden to an edge band is in S too (#782 PR8b): its panes are tombstones marked
	 * `band`, a tab group with the group itself and its id. `autoHideRegion`, `restoreAutoHidden` and
	 * hiding a pane of a band are steps on S like the others, so a region comes back into the split /
	 * tab group it left at the share it held, whatever came back before it. A region has a place
	 * while S holds every pane of it so (`#bandPlaced`); else it docks at its default place, or along
	 * its edge. These tombstones are saved with the layout (`dockedWithAutoHidden`, `#bandTree`);
	 * the ones of the floating windows are not.
	 */
	#shadow: ShadowNode | null = null;
	/** The `docked` tree `#shadow` was last made to show. */
	#shadowSeen: DockNode | null = null;
	/**
	 * The S that showed each docked tree this state has had, and each copy of one it was told of
	 * (`rememberShadow`: a gesture's snapshot) - weak, gone with the tree: what a cancelled divider
	 * drag puts back of S, from the layout it was started in (`restoreSplitSizes`).
	 */
	#shadowAt = new WeakMap<DockNode, ShadowNode>();
	/**
	 * What this state held beside a layout it was told a copy of (`rememberShadow`: a gesture's
	 * snapshot), by that copy: S (also `null`, nothing docked), the floated panes' `homeSlot`s and
	 * the ones S had no place for. `adoptLayout` of the copy puts
	 * all of it back as it was (#782 PR7) - S is taken as it is, whatever happened since: a pane
	 * that was floating then remembers its place again, also when it was docked meanwhile, and
	 * holds the share it held then. Weak: gone with the copy.
	 */
	#heldAt = new WeakMap<DockLayout, HeldShadow>();
	/** What `#heldAt` has for the layout `#adopt` is putting back; `undefined` = not such a layout. */
	#adoptHeld: HeldShadow | undefined = undefined;
	/** The floated panes that remember a place S does not hold (`regraftShadow`'s `unplaced`). */
	#shadowUnplaced = new Set<string>();
	/** What the method assigning `layout` next does to S (`#mirror`); taken by the setter. */
	#shadowStep: ShadowStep | null = null;
	/**
	 * The panes out of the tree that remembered a docked place, and the slot each had, in the layout
	 * S last followed (`#pendingById` of it): what tells an assignment that cannot change S - a
	 * floating window moved, resized or brought to the front - without walking S.
	 */
	#shadowPending = new Map<string, DockSlot>();
	/** `autoHidden` of the layout S last followed (by identity, like `#shadowSeen`). */
	#bandsSeen: DockAutoHidden[] | undefined = undefined;
	/** `bandTreeOf(#shadow)` and the S it was made of (`#bandTree`). */
	#bandTreeOf: { shadow: ShadowNode | null; tree: ShadowNode | null } = {
		shadow: null,
		tree: null
	};
	#shadowFollows = 0;
	#shadowWatch: ((follow: ShadowFollow) => void) | null = null;

	/** The layout. Assign a new object to change it (every method here does); the setter counts structure changes. */
	get layout(): DockLayout {
		return this.#layout;
	}

	set layout(next: DockLayout) {
		const step = this.#shadowStep;
		this.#shadowStep = null;
		// One version is written (#782 PR8b), whatever the object assigned says.
		next = withLayoutVersion(next);
		// Collapsed regions (#663 ③-B) are kept valid on EVERY assignment (a close, a drop,
		// `hydrate`, a restore ...): a flag that no longer fits the tree is dropped here.
		const docked = normalizeCollapsed(next.docked);
		if (docked !== next.docked) next = { ...next, docked };
		// An empty band list is not written (#694 PR-3).
		if (next.autoHidden !== undefined && next.autoHidden.length === 0) {
			next = { ...next };
			delete next.autoHidden;
		}
		// Whatever put a floated pane back in the tree (#735): its remembered place is spent ...
		const spent =
			this.#homeSlots.size > 0
				? untrack(() => {
						const floating = new Set(next.floating.map((w) => w.id));
						return [...this.#homeSlots.keys()].filter((id) => !floating.has(id));
					})
				: [];
		// ... and with it that the place of that float was lost (review of #870): the next time the
		// pane is floated it has a place of its own.
		for (const id of spent) {
			this.#homeSlots.delete(id);
			this.#shadowLost.delete(id);
		}
		// S follows before the layout is assigned (#782 PR8b): the places of the regions in the edge
		// bands are part of the layout (`dockedWithAutoHidden`), read off S as it is for `next`.
		// Whatever the object assigned holds there is replaced - only a layout taken as a whole
		// (`#adopt`) is read for it, in `#followShadow`.
		const places = untrack(() => {
			let upToDate = false;
			try {
				upToDate = step === null && !this.#adopting && this.#shadowUpToDate(next);
			} catch {
				// Not known to be up to date: followed below, which keeps its own faults in.
			}
			if (!upToDate) this.#followShadow(next, step);
			return this.#bandTree();
		});
		// Written without a look at what `next` holds there: a layout made from `this.layout` holds
		// the reactive proxy of the tree written last, which is not that tree by identity.
		if (places !== null) next = { ...next, dockedWithAutoHidden: places };
		else if (next.dockedWithAutoHidden !== undefined) {
			next = { ...next };
			delete next.dockedWithAutoHidden;
		}
		this.#noteStructure(next);
		this.#layout = next;
		// As the layout hands it out from now on (its proxy): what the next layout made from this
		// one holds, so `#shadowUpToDate` knows it by identity.
		this.#bandsSeen = untrack(() => this.#layout.autoHidden);
		// The slid-out pane is no longer auto-hidden: it is not slid out any more.
		const flyout = untrack(() => this.#flyout);
		if (flyout !== null && findAutoHidden(next, flyout) === null) this.#flyout = null;
	}

	/** Set while `hydrate` / `reset` / the constructor assign a layout taken as a whole. */
	#adopting = false;

	/**
	 * Is S certainly as it should be for `next`: the docked tree is the one S shows, the edge bands
	 * are the ones it followed, and the panes out of the tree remember the very slots they did? True
	 * for every change of a floating window's geometry, flags and z-order - nothing of S is walked
	 * for those (review of PR #857).
	 */
	#shadowUpToDate(next: DockLayout): boolean {
		if (next.docked !== this.#shadowSeen) return false;
		if (next.autoHidden !== this.#bandsSeen) return false;
		let count = 0;
		for (const w of next.floating) {
			const slot = this.#homeSlots.get(w.id);
			if (slot === undefined) continue;
			if (this.#shadowPending.get(w.id) !== slot) return false;
			count++;
		}
		return count === this.#shadowPending.size;
	}

	/** Say what the assignment of `layout` that follows does to the shadow tree (#782 PR4). */
	#mirror(label: string, run: (s: ShadowNode | null) => ShadowNode | null): void {
		this.#shadowStep = { label, run };
	}

	/**
	 * What the layout is saved with for the regions in its edge bands (`dockedWithAutoHidden`,
	 * `core/bandTree.ts`): S without the tombstones of the floating windows, or `null` when no
	 * region in a band has a place. The same object for as long as S is.
	 */
	#bandTree(): ShadowNode | null {
		if (this.#bandTreeOf.shadow !== this.#shadow)
			this.#bandTreeOf = { shadow: this.#shadow, tree: bandTreeOf(this.#shadow) };
		return this.#bandTreeOf.tree;
	}

	/**
	 * The ids of `layout` a split / tab group of S must not have (`withFreeShadowIds`, the `taken`
	 * of `regraftShadow` and of a default place): the ones out of its docked tree
	 * (`idsOutOfDocked`), but for a tab group in an edge band that `s` holds itself - with every
	 * tab of it as a tombstone marked `band`. That group and the band's are the same one: it keeps
	 * its id, and shows with it when the region is back (#782 PR8b).
	 */
	#taken(layout: DockLayout, s: ShadowNode | null): Set<string> {
		const taken = idsOutOfDocked(layout);
		for (const entry of layout.autoHidden ?? []) {
			const region = entry.node;
			if (region.type !== 'tabs') continue;
			const group = findNode(s, region.id) as ShadowNode | null;
			if (group?.type !== 'tabs') continue;
			const held = new Set(group.children.filter((c) => c.band === true).map((c) => c.id));
			if (region.children.every((tab) => held.has(tab.id))) taken.delete(region.id);
		}
		return taken;
	}

	/**
	 * `s`, made from S by a step that put a pane into it, with a new id for a tab group that now
	 * shows as a group under the id of a region in an edge band (`bands`, the list after the step).
	 * A group in a band stays in S with its id (`#taken`); once two panes that are not of that
	 * region show in it - put back from floating, or shown at their default place beside its tabs -
	 * the docked tree would hold the band's id. The group gets another, the band keeps its own; the
	 * region comes back into that group all the same (its place is its panes').
	 */
	#clear(
		s: ShadowNode | null,
		makeId: () => string,
		bands: readonly DockAutoHidden[] = this.autoHidden
	): ShadowNode | null {
		const ids = bands.filter((e) => e.node.type === 'tabs').map((e) => e.node.id);
		if (s === null || ids.length === 0) return s;
		const shown = projectShadow(s);
		const clash = new Set(ids.filter((id) => findNode(shown, id) !== null));
		return clash.size === 0 ? s : withFreeShadowIds(s, clash, makeId);
	}

	/** Does S hold a place for the region of `entry` (every pane of it a tombstone marked `band`)? */
	#bandPlaced(entry: DockAutoHidden): boolean {
		return regionPanelIds(entry.node).every(
			(id) => findShadowPanel(this.#shadow, id)?.band === true
		);
	}

	/**
	 * Keep the shadow tree with the layout `next`, which is assigned right after (#782 PR4). The
	 * step the assigning method named is done on S; a tombstone whose pane no longer remembers a
	 * docked place - a floated pane docked or closed for good, a pane no longer in an edge band -
	 * leaves S; what the docked tree shows otherwise (sizes, tabs, flags) is written onto S. When the
	 * projection of S is then not `next.docked` - or `next` is a layout taken as a whole, or a pane
	 * remembers a place S does not know - S is made again around `next.docked` (#782 PR7): with the
	 * panes out of the tree put back by the container each was in (`regraftShadow` - no guess of
	 * what the change did to the tree). A layout taken as a whole brings the places of its edge
	 * bands itself (`dockedWithAutoHidden`, read by `readBandTree`: a tree that does not show
	 * `next.docked` is not used); the ones S held for the layout replaced go. Reads `next` only,
	 * never changes it, and never throws: a fault is reported (`core/report.ts`) and S becomes the
	 * docked tree with no pane remembered.
	 */
	#followShadow(next: DockLayout, step: ShadowStep | null): void {
		const pending = this.#pendingById(next);
		this.#shadowPending = pending;
		this.#shadowFollows++;
		const label = this.#adopting ? 'adopt' : (step?.label ?? null);
		try {
			const regions = (next.autoHidden ?? []).map((entry) => regionPanelIds(entry.node));
			const banded = new Set(regions.flat());
			// `s` without the tombstones whose pane no longer remembers its place, and without what
			// is left of a region in a band that S does not hold as a whole (it has no place then).
			const settled = (s: ShadowNode | null): ShadowNode | null => {
				const inBand = new Set(shadowBandIds(s));
				for (const id of shadowPanelIds(s, 'away')) {
					if (inBand.has(id) ? banded.has(id) : pending.has(id)) continue;
					s = removeFromShadow(s, id);
					inBand.delete(id);
				}
				for (const ids of regions) {
					const held = ids.filter((id) => inBand.has(id));
					if (held.length > 0 && held.length < ids.length)
						for (const id of held) s = removeFromShadow(s, id);
				}
				return s;
			};
			// What S is made again from, when it has to be: the S before this assignment (for a layout
			// put back as it was - a cancelled gesture's snapshot -, the S that showed it then).
			const held = this.#adopting ? this.#adoptHeld : undefined;
			let from = settled(
				this.#adopting
					? held
						? held.shadow
						: this.#shadow
					: step
						? step.run(this.#shadow)
						: this.#shadow
			);
			if (held) {
				// A layout put back as it was: S is the one held with it, as it is (review of #870) -
				// nothing of now is read, not the edge bands of now either.
				const placed = new Set(shadowPanelIds(from, 'away'));
				const unplaced = [...pending.keys()].filter((id) => !placed.has(id));
				const shown = projectShadow(from);
				if (
					unplaced.every((id) => held.unplaced.has(id)) &&
					(sameDocked(shown, next.docked) || sameDocked(shown, withoutLoneFlags(next.docked, from)))
				) {
					this.#shadowIs(from, next.docked);
					this.#shadowUnplaced = new Set(unplaced);
					this.#shadowWatch?.({ step: label, result: 'same' });
					return;
				}
			}
			if (!this.#adopting) {
				const s = from;
				const placed = new Set(shadowPanelIds(s, 'away'));
				const known = [...pending.keys()].every(
					(id) => placed.has(id) || this.#shadowUnplaced.has(id)
				);
				const fits = (tree: ShadowNode | null): boolean => {
					const shown = projectShadow(tree);
					let same = sameDocked(shown, next.docked);
					let written = same ? tree : writeShadowView(tree, next.docked);
					if (written === undefined) {
						// But for a `collapsed` flag S cannot hold (`#shows` keeps it on the docked
						// tree): S is as it should be, and is not made again.
						const held = withoutLoneFlags(next.docked, tree);
						if (held === next.docked) return false;
						same = sameDocked(shown, held);
						written = same ? tree : writeShadowView(tree, held);
					}
					if (written === undefined) return false;
					this.#shadowIs(written, next.docked);
					this.#shadowWatch?.({ step: label, result: same ? 'same' : 'written' });
					return true;
				};
				if (known) {
					for (const id of this.#shadowUnplaced) {
						if (!pending.has(id)) this.#shadowUnplaced.delete(id);
					}
					if (s === this.#shadow && next.docked === this.#shadowSeen) return;
					if (fits(s)) return;
				}
			}
			// A change that was not made on S (an assignment from outside, a layout taken as a whole):
			// no guess is made of what it did to the tree (owner's decision of 2026-11-23, #782). A
			// pane out of the tree keeps its place when the split / tab group it was in is still
			// there, at the index it had; else it has none in S any more: a floated pane goes back to
			// its default place (`#backInShadow`), and so does a region in an edge band
			// (`#restoredFromBand`).
			for (const id of this.#shadowLost) if (!pending.has(id)) this.#shadowLost.delete(id);
			let around: ShadowNode | null = next.docked;
			if (this.#adopting) {
				// The edge bands of a layout taken as a whole have the places it was saved with, or
				// none: the ones S held belong to the layout replaced.
				for (const id of shadowBandIds(from)) from = removeFromShadow(from, id);
				around = readBandTree(next.dockedWithAutoHidden, next.docked, regions) ?? next.docked;
			}
			const before = new Set(shadowPanelIds(from, 'away'));
			const taken = this.#taken(next, this.#adopting ? around : from);
			const { shadow, unplaced } = regraftShadow(from, around, taken);
			this.#shadowIs(settled(shadow), next.docked);
			// What had no place before has none now; what lost it here goes to its default place.
			for (const id of unplaced) if (pending.has(id)) this.#shadowLost.add(id);
			this.#shadowUnplaced = new Set(
				[...pending.keys()].filter((id) => !before.has(id) || unplaced.includes(id))
			);
			this.#shadowWatch?.({ step: label, result: 'rebuilt' });
		} catch (error) {
			// A step made on S threw before anything was assigned (the layout is as it was). Here S
			// only follows the layout being assigned: a fault does not stop the assignment. It is not
			// swallowed either (#782 PR5): reported like an exception nobody caught.
			this.#shadowIs(next.docked, next.docked);
			this.#shadowUnplaced = new Set(pending.keys());
			this.#shadowWatch?.({ step: label, result: 'failed' });
			notify(() => {
				throw error;
			});
		}
	}

	/** S is `s` from now on, and shows `docked`. */
	#shadowIs(s: ShadowNode | null, docked: DockNode | null): void {
		this.#shadow = s;
		this.#shadowSeen = docked;
		if (s !== null && docked !== null) this.#shadowAt.set(docked, s);
	}

	/**
	 * The panes out of the tree that remember a docked place in `layout`, by id, in the order
	 * they left: the `homeSlot` of a pane floating in it (open or closed).
	 */
	#pendingById(layout: DockLayout): Map<string, DockSlot> {
		const out = new Map<string, DockSlot>();
		const floating = new Set(layout.floating.map((w) => w.id));
		for (const [id, slot] of this.#homeSlots)
			if (floating.has(id) && !out.has(id)) out.set(id, slot);
		return out;
	}

	/** The auto-hidden pane slid out over the docked tree (#694 PR-3). Not saved. */
	#flyout: string | null = $state(null);

	/**
	 * A counter that goes up every time a newly assigned layout has a different
	 * `structureKey` from the previous one (docked shape, active tabs, floating
	 * ids and open flags; geometry, split sizes and z-order do not count). Not
	 * reactive. It tells a pending `beforePanelChange` answer whether the
	 * structure changed at all while it waited - also when it came back to the
	 * same shape (close -> open re-mounts the content, tab A -> B -> A
	 * re-creates a pane that is not `keepMounted`), which comparing two keys
	 * would miss (#432). Sliding an auto-hidden pane out or back
	 * (`openFlyout` / `closeFlyout`) counts too: it (un)mounts the content.
	 */
	get structureRevision(): number {
		return this.#structureRevision;
	}

	#noteStructure(next: DockLayout): void {
		const prev = this.#structureSeen;
		this.#structureSeen = next;
		// Fast path for the geometry-only updates of a move / resize (every pointermove).
		if (
			prev &&
			prev.docked === next.docked &&
			prev.autoHidden === next.autoHidden &&
			sameFloatingStructure(prev.floating, next.floating)
		)
			return;
		const key = structureKey(next);
		if (key === this.#structureSeenKey) return;
		this.#structureSeenKey = key;
		this.#structureRevision++;
		// New ids only ever come with a structure change (the fast paths above compare ids).
		for (const id of [
			...collectPanelIds(next.docked),
			...autoHiddenPanelIds(next),
			...next.floating.map((w) => w.id)
		]) {
			if (this.#seenIds.has(id)) continue;
			this.#seenIds.add(id);
			this.#seenOrder.push(id);
		}
	}

	#panels: DockPanelInfo[] = $derived.by(() => this.#listPanels(this.#layout, this.#flyout));

	/**
	 * Every pane in the layout, for a View menu with a checkbox per pane (#663).
	 * Reactive: it follows the close button, `hidePanel` / `closePanel`, drags
	 * and `hydrate`. Order: the order each id was first seen by this `DockState`
	 * (the initial layout's docked tree in tree order, then its floating windows
	 * in array order; later additions at the end). Focus / z-order, docking and
	 * hiding do not reorder it; after `hydrate` / `layout = ...` known ids keep
	 * their place and new ones are appended. Apps that want their own order sort
	 * the rows themselves.
	 */
	get panels(): DockPanelInfo[] {
		return this.#panels;
	}

	#listPanels(layout: DockLayout, flyout: string | null): DockPanelInfo[] {
		const onScreen = onScreenPanelIds(layout, flyout);
		const byId = new Map<string, DockPanelInfo>();
		const visit = (node: DockNode): void => {
			if (node.type === 'panel') {
				byId.set(node.id, {
					id: node.id,
					title: node.title,
					icon: node.icon,
					placement: 'docked',
					visible: true,
					onScreen: onScreen.has(node.id)
				});
			} else node.children.forEach(visit);
		};
		if (layout.docked) visit(layout.docked);
		for (const entry of layout.autoHidden ?? []) {
			const panes = entry.node.type === 'tabs' ? entry.node.children : [entry.node];
			for (const p of panes) {
				byId.set(p.id, {
					id: p.id,
					title: p.title,
					icon: p.icon,
					placement: 'docked',
					visible: true,
					onScreen: onScreen.has(p.id),
					autoHidden: true
				});
			}
		}
		for (const w of layout.floating) {
			byId.set(w.id, {
				id: w.id,
				title: w.title,
				icon: w.icon,
				// What `show` would do (cross-review of PR #863): the same question, asked of `layout`.
				placement: this.#shownShadow(layout, w.id, NO_ID) !== null ? 'docked' : 'floating',
				visible: w.open,
				onScreen: onScreen.has(w.id)
			});
		}
		const out: DockPanelInfo[] = [];
		for (const id of this.#seenOrder) {
			const info = byId.get(id);
			if (info) out.push(info);
		}
		return out;
	}
	/** Injected id generator for newly-created split/tabs nodes - defaults to `crypto.randomUUID` (see `core/tree.ts#defaultMakeId`); tests pass a deterministic counter instead. */
	#makeId: () => string;

	constructor(initial?: DockLayout | string, makeId: () => string = defaultMakeId) {
		this.#makeId = makeId;
		// Both forms are validated (shared-primitives-upstream-plan §3.2); an
		// invalid initial value starts from an empty layout rather than throwing.
		if (typeof initial === 'string') {
			this.hydrate(initial);
		} else if (initial) {
			const result = validateDockLayout(initial);
			if (result.ok) this.#adopt(result.layout);
		}
	}

	/**
	 * Is the FLOATING window `id` open? Floating only (unchanged, #663): a
	 * docked id is `false`. For "is this pane on screen" (a View menu's
	 * checkbox) use `isVisible` / `panels`.
	 */
	isOpen(id: string): boolean {
		return this.layout.floating.find((w) => w.id === id)?.open ?? false;
	}

	/**
	 * Is the FLOATING window `id` locked (position and size fixed, #663 ②; was "pinned"
	 * before #694 PR-3)? A docked / unknown id is `false`. A deprecated `pinned: true`
	 * on a layout assigned without validation counts too.
	 */
	isLocked(id: string): boolean {
		const win = this.layout.floating.find((w) => w.id === id);
		return win?.locked === true || win?.pinned === true;
	}

	/**
	 * Lock / unlock the floating window `id`. Locked, `move` and `resize` do
	 * nothing (and the window host stops gestures); everything else (tabs,
	 * close, focus) is unchanged. `false` drops the field rather than writing
	 * `locked: false`; the deprecated `pinned` is dropped either way. A no-op for
	 * a docked / unknown id.
	 */
	setLocked(id: string, locked: boolean): void {
		const win = this.layout.floating.find((w) => w.id === id);
		if (!win || (this.isLocked(id) === locked && win.pinned === undefined)) return;
		this.#update(id, (w) => {
			const next: FloatingWindow = { ...w };
			delete next.pinned;
			if (locked) next.locked = true;
			else delete next.locked;
			return next;
		});
	}

	/** @deprecated Use `isLocked` (#694 PR-3: the pin now means auto-hide). Removed in the next major. */
	isPinned(id: string): boolean {
		return this.isLocked(id);
	}

	/** @deprecated Use `setLocked` (#694 PR-3: the pin now means auto-hide). Removed in the next major. */
	setPinned(id: string, pinned: boolean): void {
		this.setLocked(id, pinned);
	}

	/** Is the FLOATING window `id` collapsed to its title bar (#663 ③-A)? A docked / unknown id is `false`. */
	isCollapsed(id: string): boolean {
		return this.layout.floating.find((w) => w.id === id)?.collapsed === true;
	}

	/**
	 * Collapse / expand the floating window `id`. The saved geometry is not
	 * touched (expanding restores the saved height); `resize` does nothing while
	 * collapsed. `false` drops the field rather than writing `collapsed: false`.
	 * A no-op for a docked / unknown id.
	 */
	setCollapsed(id: string, collapsed: boolean): void {
		if (this.isCollapsed(id) === collapsed) return;
		this.#update(id, (w) => {
			const next: FloatingWindow = { ...w };
			if (collapsed) next.collapsed = true;
			else delete next.collapsed;
			return next;
		});
	}

	/**
	 * Is the docked region `nodeId` (a docked panel that is a split's child, or a tab group)
	 * collapsed to a band (#663 ③-B)? Not `isCollapsed`, which is the FLOATING window's. A
	 * panel inside a tab group, a split, a floating or unknown id is `false`.
	 */
	isDockedCollapsed(nodeId: string): boolean {
		const node = findNode(this.layout.docked, nodeId);
		return node !== null && node.type !== 'split' && node.collapsed === true;
	}

	/**
	 * May the docked region `nodeId` be collapsed (#663 ③-B)? Only a panel / tab group that is
	 * a direct child of a split with another child that is not collapsed: the last open region
	 * of a split and a lone root region cannot be. A region that is already collapsed is `true`.
	 */
	canCollapseDocked(nodeId: string): boolean {
		return canCollapseRegion(this.layout.docked, nodeId);
	}

	/**
	 * Collapse / expand the docked region `nodeId` to a band (#663 ③-B). The split's saved
	 * `sizes` are not touched (the open regions share the freed space in their current ratio;
	 * expanding gets the old layout back). Collapsing a region `canCollapseDocked` refuses, or
	 * an unknown id, does nothing. `false` drops the field rather than writing `collapsed: false`.
	 * The content stays mounted. No `beforePanelChange`: collapsing is not closing.
	 */
	setDockedCollapsed(nodeId: string, collapsed: boolean): void {
		const next = setRegionCollapsed(this.layout.docked, nodeId, collapsed);
		if (next === this.layout.docked) return;
		this.layout = { ...this.layout, docked: next };
	}

	/**
	 * Expand the docked region that holds the pane `panelId` (the pane itself when it is a
	 * split's child, else its tab group). Does nothing for a pane that is not docked or a
	 * region that is not collapsed. `show` and the pane lifecycle's `show` use it.
	 */
	revealDocked(panelId: string): void {
		const next = expandRegionOf(this.layout.docked, panelId);
		if (next === this.layout.docked) return;
		this.layout = { ...this.layout, docked: next };
	}

	/**
	 * Is the pane NOT closed (#663): in the docked tree (even as a background tab or
	 * inside a collapsed region), auto-hidden to a band, or an open floating window.
	 * The View menu's checkbox. For "is it really on screen" use `isOnScreen`.
	 */
	isVisible(id: string): boolean {
		return this.#isDocked(id) || this.isAutoHidden(id) || this.isOpen(id);
	}

	/**
	 * Is the pane really on screen (#792, reactive)? False for a pane in a collapsed
	 * region, a background tab, an auto-hidden pane that is not slid out (`flyoutPanel`),
	 * a floating window collapsed to its title bar, a closed window and an unknown id.
	 * True for the front tab of an uncollapsed docked region, an open uncollapsed
	 * floating window and the pane slid out now. Not about the host's size or the
	 * browser tab being hidden.
	 */
	isOnScreen(id: string): boolean {
		return onScreenPanelIds(this.layout, this.#flyout).has(id);
	}

	// --- auto-hide (#694 PR-3, `core/autohide.ts`) ---

	/** The regions auto-hidden to the host's edge bands, in band order (`layout.autoHidden`, `[]` when none). */
	get autoHidden(): readonly DockAutoHidden[] {
		return this.layout.autoHidden ?? [];
	}

	/** Is the pane (or region) `id` auto-hidden to an edge band? */
	isAutoHidden(id: string): boolean {
		return findAutoHidden(this.layout, id) !== null;
	}

	/**
	 * Auto-hide the docked region `regionId` (a pane that is not a tab, or a tab
	 * group; a tab's id stands for its group): it leaves the docked tree for the
	 * band at `options.edge` (omitted = the side it is on, seen from the main
	 * region `options.mainId` or the tree's middle) and remembers its place.
	 * Asks nothing - `DockHost`'s pin button goes through `beforePanelChange`.
	 * Returns whether it moved.
	 */
	autoHideRegion(regionId: string, options: AutoHideOptions = {}): boolean {
		const region = regionOf(this.layout.docked, regionId);
		if (!region) return false;
		// The band it goes to and its entry there, as for a layout (`core/autohide.ts`); the docked
		// tree is what S shows with the panes of the region marked (#782 PR8b): nothing of S moves.
		const next = autoHideRegionInLayout(this.layout, region.id, options);
		if (!next) return false;
		let s = this.#shadow;
		for (const id of regionPanelIds(region)) s = markInBand(s, id);
		this.layout = { ...next, docked: this.#projected('autoHideRegion', s) };
		return true;
	}

	/**
	 * Put the auto-hidden region that holds `id` (its region id or one of its
	 * panes) back into the docked tree: into the split / tab group it left, at the
	 * share it held there (#782 PR8b: its place in the shadow tree, like a floated
	 * pane's - whatever was moved, shown or hidden meanwhile). When that place is
	 * gone (the layout was assigned from outside, or read without
	 * `dockedWithAutoHidden`) every pane of it docks at its default place
	 * (`defaultLayout`), and the ones that have none together along the band's edge.
	 * Asks nothing. Returns whether it moved.
	 */
	restoreAutoHidden(id: string): boolean {
		const back = this.#restoredFromBand(id, this.#makeId);
		if (!back) return false;
		const next: DockLayout = {
			...this.layout,
			docked: this.#projected('restoreAutoHidden', back.shadow, back.moved)
		};
		if (back.bands.length > 0) next.autoHidden = back.bands;
		else delete next.autoHidden;
		this.layout = next;
		return true;
	}

	/** The docked tree `restoreAutoHidden(id)` would make (fixed ids for new splits, for a stable preview), or `undefined`. */
	previewRestoreAutoHidden(id: string): DockNode | null | undefined {
		const found = findAutoHidden(this.layout, id);
		if (!found) return undefined;
		const back = this.#restoredFromBand(id, () => `${found.entry.node.id}:restored-split`);
		return back ? this.#shows(back.shadow, back.moved) : undefined;
	}

	/**
	 * S with the region in an edge band that holds `id` back in the tree (`restoreAutoHidden`), the
	 * bands left, and a pane of the region (for `#shows`). `null`: `id` is not auto-hidden, or one of
	 * the region's ids is in the docked tree already. Pure: nothing changes.
	 */
	#restoredFromBand(
		id: string,
		makeId: () => string
	): { shadow: ShadowNode | null; bands: DockAutoHidden[]; moved: string } | null {
		const found = findAutoHidden(this.layout, id);
		if (!found) return null;
		const { entry, index } = found;
		const region = entry.node;
		const panes = region.type === 'tabs' ? region.children : [region];
		const docked = this.layout.docked;
		if ([region.id, ...panes.map((p) => p.id)].some((x) => findNode(docked, x))) return null;
		const bands = this.autoHidden.filter((_, i) => i !== index);
		// The layout without the band: the ids of the region are free for what comes back.
		const after: DockLayout = { ...this.layout, autoHidden: bands };
		const ids = this.#unused(makeId);
		const active = activePanelOf(region).id;
		let s = this.#shadow;
		if (this.#bandPlaced(entry)) {
			// Its place: the marks are cleared, the active tab last (a tab back is the active one).
			for (const pane of panes) if (pane.id !== active) s = markPresent(s, pane.id, pane);
			s = markPresent(s, active, activePanelOf(region));
			s = withFreeShadowIds(s, this.#taken(after, s), ids);
		} else {
			// No place in S (module doc of `core/autohide.ts`): the default place of each pane, in
			// tab order; the ones without one stay together, along the band's edge.
			const taken = this.#taken(after, s);
			const defaults = this.defaultLayout?.docked ?? null;
			s = withFreeShadowIds(s, taken, ids);
			const rest: DockPanelNode[] = [];
			for (const pane of panes) {
				const placed = placeInShadowAtDefault(s, defaults, pane, undefined, ids, taken);
				if (placed === null) rest.push(pane);
				else s = placed;
			}
			if (rest.length === 1) s = dockRegionAtShadowEdge(s, rest[0], entry.edge, ids);
			else if (rest.length > 1 && region.type === 'tabs') {
				const at = rest.findIndex((pane) => pane.id === active);
				// The group keeps its id, unless something of S has it by now.
				const groupId = findNode(s, region.id) === null ? region.id : ids();
				s = dockRegionAtShadowEdge(
					s,
					{ ...region, id: groupId, children: rest, activeIndex: Math.max(at, 0) },
					entry.edge,
					ids
				);
			}
		}
		return { shadow: this.#clear(s, ids, bands), bands, moved: panes[0].id };
	}

	/** The auto-hidden pane slid out over the docked tree, or `null` (not saved). */
	get flyoutPanel(): string | null {
		return this.#flyout;
	}

	/**
	 * Slide the auto-hidden pane `panelId` out (a group shows that pane). Not asked:
	 * like expanding a band, it changes no docked pane. A no-op for a pane that is
	 * not auto-hidden.
	 */
	openFlyout(panelId: string): void {
		const found = findAutoHidden(this.layout, panelId);
		if (!found || (found.entry.node.type === 'tabs' && found.entry.node.id === panelId)) return;
		const next = setAutoHiddenActive(this.layout, panelId);
		if (next !== this.layout) this.layout = next;
		this.#setFlyout(panelId);
	}

	/** Slide the open pane back into its band. */
	closeFlyout(): void {
		this.#setFlyout(null);
	}

	/**
	 * Sliding a pane out or back mounts / unmounts its content (unless
	 * `keepMounted`, which only the lifecycle knows), so it is a new structure
	 * generation: a `beforePanelChange` answer asked before a close -> open of
	 * the same pane must not apply to the re-mounted content (stale, #700).
	 * Every change counts, `keepMounted` panes too (a stale answer is the safe side).
	 */
	#setFlyout(panelId: string | null): void {
		if (untrack(() => this.#flyout) === panelId) return;
		this.#flyout = panelId;
		this.#structureRevision++;
	}

	/**
	 * Opens the FLOATING window `id` (marking `open: true`) and brings it to
	 * front. No-op if the id is not a floating window (a docked id included) -
	 * see `ensureWindow`. A pane hidden from the docked tree opens floating here
	 * (and is no longer one: `dockShare` is dropped); `show` docks it at its default place instead.
	 */
	open(id: string): void {
		if (!this.layout.floating.some((w) => w.id === id)) return;
		this.#update(id, (w) => {
			const next: FloatingWindow = { ...w, open: true };
			delete next.dockShare;
			return next;
		});
		this.focus(id);
	}

	/**
	 * Show the pane `id` wherever it belongs (#663, the View menu's "check"):
	 *  - docked: make its tab the active one;
	 *  - an open floating window: bring it to front;
	 *  - hidden from the docked tree or an edge band (`dismiss`, the close button, `hidePanel` /
	 *    `closePanel`): dock it at its DEFAULT place (#782 PR5, `defaultLayout`,
	 *    `core/defaultPlace.ts`: beside the nearest pane of the default layout docked now, else
	 *    along its default edge), as the active tab, with the share it held when it was hidden -
	 *    not where it was hidden from; without a default place (no `defaultLayout`, a pane it does
	 *    not dock), open it floating (at its saved geometry);
	 *  - a closed floating window: `open`.
	 * A region collapsed to a band that holds the pane (or that the pane goes back into) is
	 * expanded (#663 ③-B). Moves no DOM focus (z-order / active tab only, like `open`). Returns where
	 * the pane is now, or `null` for an unknown id (nothing changes).
	 */
	show(id: string): 'docked' | 'floating' | null {
		const parent = findParent(this.layout.docked, id);
		if (this.#isDocked(id)) {
			if (parent?.type === 'tabs') {
				this.setActiveTab(
					parent.id,
					parent.children.findIndex((c) => c.id === id)
				);
			}
			// A region collapsed to a band is expanded to show the pane (#663 ③-B).
			this.revealDocked(id);
			return 'docked';
		}
		if (this.isAutoHidden(id)) {
			// Auto-hidden (#694 PR-3): slide it out of its band.
			this.openFlyout(id);
			return 'docked';
		}
		if (!this.layout.floating.some((w) => w.id === id)) return null;
		const placed = this.#shownShadow(this.layout, id, this.#makeId);
		if (placed === null) {
			this.open(id);
			return 'floating';
		}
		this.layout = {
			...this.layout,
			floating: this.layout.floating.filter((w) => w.id !== id),
			docked: this.#expanded('show', placed, id)
		};
		return 'docked';
	}

	/** Where `show(id)` would put the pane now (`null` = unknown id). Lets a caller tell a re-dock from an open before doing it. */
	showPlacement(id: string): 'docked' | 'floating' | null {
		if (this.#isDocked(id) || this.isAutoHidden(id)) return 'docked';
		if (!this.layout.floating.some((w) => w.id === id)) return null;
		// Only whether it docks is asked: no id is taken from `makeId` for it.
		return this.shownTree(id, NO_ID) === null ? 'floating' : 'docked';
	}

	/**
	 * The docked pane that `show(id)` would take off the screen by putting the
	 * hidden pane `id` back as the ACTIVE tab of a tab group (#663): the tab it
	 * replaces as the active one (`wrapped: false`), or a bare docked panel that
	 * becomes the other tab of a new group (`wrapped: true` - it is re-mounted
	 * even when `keepMounted`). `groupId` is the group `id` ends up in (for a
	 * new group, the id it is given when the default layout's one is free). `null` =
	 * `show(id)` deactivates no docked pane (not hidden from the dock, restored
	 * into a split / an empty tree, or opened floating). `DockHost`'s
	 * `showPanel` asks this as a `tab-switch` first, like a tab click.
	 */
	showTabSwitch(id: string): { groupId: string; from: string; wrapped: boolean } | null {
		if (this.#isDocked(id)) return null;
		// A fixed id for a group the preview would create: stable across calls (the request re-checks it).
		const tree = this.shownTree(id, () => `${id}:restored-tabs`);
		if (tree === null) return null;
		const group = findParent(tree, id);
		if (group?.type !== 'tabs') return null;
		const before = findNode(this.layout.docked, group.id);
		if (before?.type === 'tabs') {
			const from = before.children[before.activeIndex]?.id;
			return from === undefined ? null : { groupId: group.id, from, wrapped: false };
		}
		const from = group.children.find((c) => c.id !== id)?.id;
		return from === undefined ? null : { groupId: group.id, from, wrapped: true };
	}

	/**
	 * Take the pane `id` off the screen, wherever it is (#663): a docked pane - or one in an edge
	 * band - leaves the tree and becomes a CLOSED floating window marked as hidden from the dock
	 * (`FloatingWindow.dockShare`: the share it held, kept by `serialize`). It remembers no place
	 * (#782 PR5): `show` docks it at its default place. A floating window is `close`d. This is the layout half of
	 * the close button - `DockHost`'s `hidePanel` / `closePanel` call it after
	 * `beforePanelChange`; calling it directly asks nothing.
	 */
	dismiss(id: string): void {
		const fromBand = removeAutoHiddenPane(this.layout, id);
		if (fromBand) {
			// Auto-hidden (#694 PR-3): out of its band, and out of S for good (#782 PR8b: its
			// tombstone goes, the rest of its region keeps its place). The share is the one the pane
			// holds at its place (`1`: its region has none).
			const index = fromBand.layout.floating.length;
			const { pane, entry } = fromBand;
			const share = this.#bandPlaced(entry) ? this.#shareOf(pane.id) : 1;
			const s = removeFromShadow(this.#shadow, id);
			this.#mirror('dismiss', () => s);
			const win: FloatingWindow = {
				id: pane.id,
				title: pane.title,
				icon: pane.icon,
				x: index * 24,
				y: index * 24,
				width: DEFAULT_WINDOW_WIDTH,
				height: DEFAULT_WINDOW_HEIGHT,
				open: false,
				dockShare: share
			};
			this.layout = { ...fromBand.layout, floating: [...fromBand.layout.floating, win] };
			return;
		}
		const node = findNode(this.layout.docked, id);
		if (!node || node.type !== 'panel') {
			this.close(id);
			return;
		}
		const index = this.layout.floating.length;
		const win: FloatingWindow = {
			id: node.id,
			title: node.title,
			icon: node.icon,
			// Same placement as `undockPanel` without a drop point.
			x: index * 24,
			y: index * 24,
			width: DEFAULT_WINDOW_WIDTH,
			height: DEFAULT_WINDOW_HEIGHT,
			open: false,
			dockShare: this.#shareOf(id)
		};
		// Out of S for good: no tombstone (so a flag on the last child left is dropped now, PR #857's 34).
		this.layout = {
			...this.layout,
			docked: this.#projected('dismiss', removeFromShadow(this.#shadow, id)),
			floating: [...this.layout.floating, win]
		};
	}

	/**
	 * The share the pane `id` - docked, or in an edge band with a place - holds of its split, for
	 * `FloatingWindow.dockShare` (`dockShareOf`): of the docked tree with the regions in the edge
	 * bands counted as there (#782 PR8b). They are part of the layout and have their places saved,
	 * so the share means the same whether a region beside the pane went to its band before the pane
	 * was hidden or after (`placeInShadowAtDefault` counts them too). The floated panes are not
	 * counted, as before: a share of what shows.
	 */
	#shareOf(id: string): number {
		let s = this.#shadow;
		const inBands = shadowBandIds(s);
		if (inBands.length === 0) return dockShareOf(this.layout.docked, id);
		for (const paneId of inBands) s = markPresent(s, paneId);
		return dockShareOf(projectShadow(s), id);
	}

	/**
	 * The other panes out of the tree that remember a docked place, with the slot of each, for
	 * `restoreDockSlot`'s `hidden` (#734) - in the order they left. The slot is the place S says
	 * (`deflateShadow`: every share as S has it now); for a pane S has no place for, the one it holds.
	 * Only for a slot that is not the pane's own (`restoredAt`; goes with it in #782 PR8c).
	 */
	#awaySlots(except: string): HiddenDockSlot[] {
		const said = new Map(deflateShadow(this.#shadow).away.map((a) => [a.panel.id, a.slot]));
		const out: HiddenDockSlot[] = [];
		for (const [id, home] of this.#homeSlots)
			if (id !== except) out.push({ id, slot: said.get(id) ?? home });
		return out;
	}

	/**
	 * Where the floating window `id` was docked before `undockPanel` took it out (#663 ④, the
	 * panel menu's "back to where it was"); `undefined` = it did not come out of the tree that
	 * way, or it was docked again since (by any path). Kept for this state's lifetime only (not
	 * part of `serialize`). The place may be gone by now: `dockAtSlot` tells.
	 *
	 * To be removed in #782 PR8c: use `hasHome` / `dockBack` / `backTree`.
	 */
	homeSlot(id: string): DockSlot | undefined {
		return this.#homeSlots.get(id);
	}

	/**
	 * Whether the floating window `id` remembers a docked place (it came out of the tree by
	 * `undockPanel`, and was not docked again since). Kept for this state's lifetime only (not part
	 * of `serialize`). `true` does not mean it can go back: the place may be lost with no default
	 * one left. Whether it can is `backTree(id) !== null`.
	 */
	hasHome(id: string): boolean {
		return this.#homeSlots.get(id) !== undefined;
	}

	#isDocked(id: string): boolean {
		return findNode(this.layout.docked, id)?.type === 'panel';
	}

	/**
	 * The docked tree `show(id)` gives for a pane hidden from the dock (a closed window with
	 * `dockShare`): the pane at its default place (`core/defaultPlace.ts`), before the region it
	 * lands in is expanded. `null` = `show` does not dock it (not such a window, or no default place:
	 * it opens floating). Pure: the layout does not change. The one prediction of `show`:
	 * `showPlacement`, `showTabSwitch` and `DockHost`'s `showPanel` ask it too.
	 */
	shownTree(id: string, makeId: () => string = this.#makeId): DockNode | null {
		const placed = this.#shownShadow(this.layout, id, makeId);
		return placed === null ? null : this.#shows(placed, id);
	}

	/**
	 * The shadow tree with the hidden pane `id` of `layout` (this state's layout: `panels` asks it
	 * of the one it lists) at its default place, or `null` (`shownTree`). The place is worked out on
	 * S (#782 PR6): the place of a pane floated out of the tree counts as a default sibling that is
	 * there, so the pane lands beside it and both are in the default order once that pane is back.
	 */
	#shownShadow(layout: DockLayout, id: string, makeId: () => string): ShadowNode | null {
		const win = layout.floating.find((w) => w.id === id);
		if (!win || win.open || win.dockShare === undefined) return null;
		const panel: DockPanelNode = { type: 'panel', id: win.id, title: win.title, icon: win.icon };
		// The ids out of the docked tree: a split / tab group made again does not take one of them
		// (Codex P2 on #863), and one S kept out of sight gets another. A tab group in an edge band
		// that S holds is not one of them (`#taken`): the pane joins it beside its tabs, as it does
		// beside a floated pane's place.
		// Freed before the pane is placed, as for a drop: an id given instead is then in S when the
		// place takes a default id that is free (cross-review of PR #864).
		const taken = this.#taken(layout, this.#shadow);
		const ids = this.#unused(makeId);
		const placed = placeInShadowAtDefault(
			withFreeShadowIds(this.#shadow, taken, ids),
			this.defaultLayout?.docked ?? null,
			panel,
			win.dockShare,
			ids,
			taken
		);
		return placed === null ? null : this.#clear(placed, ids, layout.autoHidden ?? []);
	}

	/**
	 * The docked tree the shadow tree `s`, made from S by a step, shows: its projection, with the
	 * one thing S cannot hold carried over from the docked tree of now - the `collapsed` flag of a
	 * region that is the only child of its split of S that shows (PR #857's judgment 34: say `a` of
	 * `row[column[a, b†], c, d]`, collapsed as a child of the row). Such a flag is on the docked tree
	 * alone, so a step that does not touch the region must not drop it (review of PR #864): it stays
	 * while the region is as it was - the same pane, or the same tabs - and still a split's child.
	 * Not the region of `moved`, the pane the step puts somewhere: a pane that is moved, dropped or
	 * docked back shows where it lands, as it did when the step was made on the docked tree.
	 */
	#shows(s: ShadowNode | null, moved?: string): DockNode | null {
		const docked = projectShadow(s);
		const flagged = collapsedRegions(this.layout.docked);
		if (flagged.size === 0) return docked;
		const held = collapsedRegions(projectShadow(this.#shadow));
		let out = docked;
		for (const [id, region] of flagged) {
			if (held.has(id)) continue;
			// The pane the step moves, or the group it leaves: the step expands it (Codex P2 on #864).
			if (id === moved || (region.type === 'tabs' && region.children.some((c) => c.id === moved)))
				continue;
			const now = findNode(out, id);
			if (!now || now.type === 'split' || now.collapsed === true) continue;
			if (!sameRegion(region, now)) continue;
			if (findParent(out, id)?.type !== 'split') continue;
			out = setRegionCollapsed(out, id, true);
		}
		return out;
	}

	/**
	 * `s`, made from S by a step that may show a split / tab group S kept out of sight, with a new
	 * id for one whose id the layout took meanwhile (`withFreeShadowIds`: a floating window, a region
	 * in an edge band) or the pane `incoming` has. The one place the ids of S are checked against
	 * the rest of the layout: every step that puts a pane into S goes through it (`#backInShadow`,
	 * `#shownShadow`'s own call, `#droppedOnto`, `#droppedAtEdge`, `#restoredFromBand`). An
	 * assignment from outside that docks a pane makes S again (`regraftShadow`, which is given the
	 * same ids).
	 */
	/**
	 * `makeId`, made to give ids nothing has (cross-review of PR #864): not a node of S - shown or
	 * not -, not a floating window or a region in an edge band, not `incoming`, and not one it gave
	 * before. An id in use gets a number after it (`x`, `x-2`, `x-3` ...). The callers' `makeId`
	 * may be a fixed one - "back" from the panel menu docks with `<pane>:restored`, the previews
	 * with theirs - and a random one may be the app's own. What it is not asked for costs nothing.
	 */
	#unused(makeId: () => string, incoming?: string): () => string {
		let used: Set<string> | null = null;
		return () => {
			if (used === null) {
				used = idsOutOfDocked(this.layout);
				if (incoming !== undefined) used.add(incoming);
				const add = (node: ShadowNode | null): void => {
					if (node === null) return;
					used!.add(node.id);
					if (node.type !== 'panel') node.children.forEach(add);
				};
				add(this.#shadow);
			}
			const first = makeId();
			let id = first;
			for (let n = 2; used.has(id); n++) id = `${first}-${n}`;
			used.add(id);
			return id;
		};
	}

	#freed(s: ShadowNode | null, makeId: () => string, incoming?: string): ShadowNode | null {
		const taken = this.#taken(this.layout, s);
		// The pane a step brings in: a new one (`ensurePanel`) is in no list of the layout yet.
		if (incoming !== undefined) taken.add(incoming);
		return withFreeShadowIds(s, taken, makeId);
	}

	/**
	 * Name the step that made the shadow tree `s` out of S, for the assignment of `layout` that
	 * follows, and give the docked tree it shows: the one to assign (#782 PR6 - the step is done on
	 * S, and the docked tree is its projection).
	 */
	#projected(label: string, s: ShadowNode | null, moved?: string): DockNode | null {
		this.#mirror(label, () => s);
		return this.#shows(s, moved);
	}

	/** `#projected`, with the region the pane `id` came back into expanded (#663 ③-B) - in S too. */
	#expanded(label: string, s: ShadowNode | null, id: string): DockNode | null {
		const docked = this.#shows(s, id);
		const shown = expandRegionOf(docked, id);
		this.#mirror(label, () => (shown === docked ? s : (writeShadowView(s, shown) ?? s)));
		return shown;
	}

	/** S with the floated pane `id` back at its place (its tombstone), or `null`: S holds none for it. */
	#backInShadow(id: string, slot: DockSlot, makeId: () => string): ShadowNode | null {
		if (slot !== this.#homeSlots.get(id)) return null;
		const win = this.layout.floating.find((w) => w.id === id);
		if (!win) return null;
		const ids = this.#unused(makeId);
		if (findShadowPanel(this.#shadow, id)?.away === true)
			return this.#clear(this.#freed(markPresent(this.#shadow, id, win), ids), ids);
		if (!this.#shadowLost.has(id)) return null;
		// Its place went with a change that was not made on S (an assignment from outside): the
		// default place, as for a pane hidden from the dock (#782 PR7, owner's decision).
		const panel: DockPanelNode = { type: 'panel', id: win.id, title: win.title, icon: win.icon };
		const taken = this.#taken(this.layout, this.#shadow);
		const placed = placeInShadowAtDefault(
			withFreeShadowIds(this.#shadow, taken, ids),
			this.defaultLayout?.docked ?? null,
			panel,
			undefined,
			ids,
			taken
		);
		return placed === null ? null : this.#clear(placed, ids);
	}

	/** S with the pane `node` (docked, or a floating window's) dropped at `region` of `targetId`. */
	#droppedOnto(
		node: DockPanelNode,
		targetId: string,
		region: DropRegion,
		makeId: () => string
	): ShadowNode | null {
		// Freed before the step (Codex P2 on #864): the pane's own id counts, so S never holds it
		// twice; what the step makes anew takes its ids from `makeId`.
		const ids = this.#unused(makeId, node.id);
		const s = this.#freed(this.#shadow, ids, node.id);
		return this.#clear(dockIntoShadow(s, node, targetId, region, ids), ids);
	}

	/** S with the pane `node` (docked, or a floating window's) along the outer edge `edge`. */
	#droppedAtEdge(node: DockPanelNode, edge: DockEdge, makeId: () => string): ShadowNode | null {
		const ids = this.#unused(makeId, node.id);
		return dockAtShadowEdge(this.#freed(this.#shadow, ids, node.id), node, edge, ids);
	}

	/**
	 * The docked tree with the floating window `id` (open or closed) put at `slot`; `null` = no such
	 * window, or the place is gone. Pure: the layout does not change. For "back" (`dockAtSlot`) and
	 * its preview.
	 *
	 * Its `homeSlot` names its place in the shadow tree (#782 PR6): the pane is back at its
	 * tombstone - in the split / tab group it left, at the share it held, whatever was moved, hidden
	 * or floated since and whatever order the panes come back in. Any other slot (one the caller
	 * took with `captureDockSlot`), or a `homeSlot` S has no place for, is put back by
	 * `core/slot.ts#restoreDockSlot` on the docked tree, counting the other panes that remember a
	 * docked place (#733).
	 *
	 * To be removed in #782 PR8c: use `backTree` for the pane's own place.
	 */
	restoredAt(id: string, slot: DockSlot, makeId: () => string = this.#makeId): DockNode | null {
		const win = this.layout.floating.find((w) => w.id === id);
		if (!win) return null;
		const back = this.#backInShadow(id, slot, makeId);
		if (back !== null) return this.#shows(back, id);
		// Its `homeSlot` with no place left, not even a default one: the place is gone.
		if (slot === this.#homeSlots.get(id) && this.#shadowLost.has(id)) return null;
		const panel: DockPanelNode = { type: 'panel', id: win.id, title: win.title, icon: win.icon };
		return restoreDockSlot(
			this.layout.docked,
			panel,
			slot,
			this.#unused(makeId),
			this.#awaySlots(id),
			idsOutOfDocked(this.layout)
		);
	}

	/**
	 * The docked tree with the floating window `id` (open or closed) put back where it was docked
	 * (its `hasHome` place): `restoredAt` for that place, without the slot. `null` = no such
	 * window, it remembers no place, or the place is gone (lost, and no default one). So whether it
	 * can go back is `backTree(id) !== null`, not `hasHome(id)`. Pure: the layout does not change.
	 */
	backTree(id: string, makeId: () => string = this.#makeId): DockNode | null {
		const slot = this.#homeSlots.get(id);
		return slot === undefined ? null : this.restoredAt(id, slot, makeId);
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

	/**
	 * Move by (dx, dy) from where the window is DRAWN (the saved preference
	 * clamped to the current host, `displayWindowGeometry`) and save the clamped
	 * result: an operation's outcome becomes the new preferred placement
	 * (shared-primitives-upstream-plan §3.2). `clamp` is the host's consumer
	 * policy (`DockHost`'s `clamp` prop).
	 */
	move(
		id: string,
		dx: number,
		dy: number,
		hostW: number,
		hostH: number,
		clamp?: ClampOptions
	): void {
		// Locked (#663 ②): the preference stays; the drawn clamp still applies at render.
		if (this.isLocked(id)) return;
		this.#update(id, (w) =>
			applyDrag(displayWindowGeometry(w, hostW, hostH, clamp), dx, dy, hostW, hostH, clamp)
		);
	}

	/** Resize from the DRAWN geometry (see `move`); the result is saved as the new preference. Minimums come from `clamp`, defaulting to `DEFAULT_MIN_*`. */
	resize(
		id: string,
		edge: ResizeEdge,
		dx: number,
		dy: number,
		hostW: number,
		hostH: number,
		clamp?: ClampOptions
	): void {
		if (this.isLocked(id) || this.isCollapsed(id)) return;
		this.#update(id, (w) =>
			applyResize(
				displayWindowGeometry(w, hostW, hostH, clamp),
				edge,
				dx,
				dy,
				hostW,
				hostH,
				clamp?.minW ?? DEFAULT_MIN_WIDTH,
				clamp?.minH ?? DEFAULT_MIN_HEIGHT
			)
		);
	}

	/** Adds `def` with a cascade position if it isn't in the layout yet; otherwise a no-op (existing geometry/open-state is left untouched). */
	ensureWindow(def: FloatingWindowDef, hostW: number, hostH: number): void {
		// A docked id counts too: adding it again would duplicate the id (#663).
		if (this.layout.floating.some((w) => w.id === def.id) || this.#isDocked(def.id)) return;
		if (this.isAutoHidden(def.id)) return;
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
			collectPanelIds(this.layout.docked).includes(def.id) ||
			this.isAutoHidden(def.id);
		if (known) return;

		if (this.layout.docked !== null || targetId !== undefined) {
			const panelNode: DockPanelNode = {
				type: 'panel',
				id: def.id,
				title: def.title,
				icon: def.icon
			};
			const effectiveTarget = targetId ?? this.layout.docked!.id;
			const docked = this.#projected(
				'ensurePanel',
				this.#droppedOnto(panelNode, effectiveTarget, region, this.#makeId),
				panelNode.id
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
		// On S (#782 PR6): a place the pane still remembered is given up first, and the target is
		// taken with the places of the panes out of the tree around it (`dockIntoShadow`).
		const docked = this.#projected(
			'dockPanel',
			this.#droppedOnto(panelNode, targetId, region, this.#makeId),
			panelId
		);
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
	 * `panelId` isn't currently docked. Its docked place is remembered as its
	 * `homeSlot` (#734: counted with the panes already hidden or floated out of
	 * the same container).
	 */
	undockPanel(
		panelId: string,
		geometry?: Partial<Pick<FloatingWindow, 'x' | 'y' | 'width' | 'height'>>
	): void {
		const node = findNode(this.layout.docked, panelId);
		if (!node || node.type !== 'panel') return;

		// Its place stays in S as a tombstone (#782 PR6): "back" (`dockAtSlot` with its `homeSlot`)
		// clears the mark, whatever was moved, hidden or floated meanwhile. The slot handed out names
		// that place, written as S says it at this moment (`deflateShadow`).
		const away = markAway(this.#shadow, panelId);
		const slot = deflateShadow(away).away.find((a) => a.panel.id === panelId)?.slot;
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
		// Before the assignment: the setter takes a docked pane gone from the tree with no place
		// remembered as one that left for good.
		if (slot) this.#homeSlots.set(panelId, slot);
		else this.#homeSlots.delete(panelId);
		this.#shadowLost.delete(panelId);
		const docked = this.#projected(
			'undockPanel',
			slot ? away : removeFromShadow(this.#shadow, panelId)
		);
		this.layout = { ...this.layout, docked, floating: [...this.layout.floating, win] };
	}

	/** Relocate a panel that's ALREADY docked to a new split/group (spec §5.2: drag a docked tab to a new spot). Removes then re-docks it, so it's equivalent to `undockPanel` + `dockPanel` without the floating round-trip. A no-op if `panelId` isn't currently docked. */
	dockExisting(panelId: string, targetId: string, region: DropRegion): void {
		const node = findNode(this.layout.docked, panelId);
		if (!node || node.type !== 'panel') return;
		const docked = this.#projected(
			'dockExisting',
			this.#droppedOnto(node, targetId, region, this.#makeId),
			panelId
		);
		this.layout = { ...this.layout, docked };
	}

	/** The pane `id` as a docked leaf: the docked pane itself, or a floating window's; `null` = neither. */
	#paneNode(id: string): DockPanelNode | null {
		const node = findNode(this.layout.docked, id);
		if (node?.type === 'panel') return node;
		const win = this.layout.floating.find((w) => w.id === id);
		return win ? { type: 'panel', id: win.id, title: win.title, icon: win.icon } : null;
	}

	/**
	 * The docked tree `dockPanel` (a floating window) / `dockExisting` (a docked pane) gives for
	 * `panelId` dropped at `region` of `targetId`; `null` = it is neither. Pure: the layout does not
	 * change. The one prediction of a drop (#782 PR6): the drag controller asks the panes the drop
	 * pushes out by this tree, which is made on the shadow tree like the drop itself.
	 */
	droppedTree(
		panelId: string,
		targetId: string,
		region: DropRegion,
		makeId: () => string = this.#makeId
	): DockNode | null {
		const node = this.#paneNode(panelId);
		if (node === null) return null;
		return this.#shows(this.#droppedOnto(node, targetId, region, makeId), panelId);
	}

	/**
	 * The docked tree `dockPanelAtEdge` / `dockExistingAtEdge` gives for `panelId` moved to the outer
	 * edge `edge` (as `droppedTree`); `null` = it is neither docked nor a floating window, or it is
	 * the only docked pane (`dockExistingAtEdge` does nothing then).
	 */
	droppedAtEdgeTree(
		panelId: string,
		edge: DockEdge,
		makeId: () => string = this.#makeId
	): DockNode | null {
		const node = this.#paneNode(panelId);
		if (node === null) return null;
		if (this.#isDocked(panelId) && !removePanel(this.layout.docked, panelId)) return null;
		return this.#shows(this.#droppedAtEdge(node, edge, makeId), panelId);
	}

	/**
	 * Move a currently-floating panel to an outer edge of the host (#694 PR-1): the docked root is
	 * wrapped in a new split and the panel spans that side (`core/tree.ts#dockPanelAtEdge`). Nothing
	 * docked yet = it becomes the root. Carries over its title/icon; a no-op if `panelId` isn't a
	 * floating window.
	 */
	dockPanelAtEdge(panelId: string, edge: DockEdge): void {
		const win = this.layout.floating.find((w) => w.id === panelId);
		if (!win) return;
		const panelNode: DockPanelNode = {
			type: 'panel',
			id: win.id,
			title: win.title,
			icon: win.icon
		};
		const docked = this.#projected(
			'dockPanelAtEdge',
			this.#droppedAtEdge(panelNode, edge, this.#makeId),
			panelId
		);
		const floating = this.layout.floating.filter((w) => w.id !== panelId);
		this.layout = { ...this.layout, floating, docked };
	}

	/**
	 * Move a panel that's ALREADY docked to an outer edge of the host (#694 PR-1): removed from
	 * where it is, then the rest of the tree is wrapped as in `dockPanelAtEdge`. A no-op if `panelId`
	 * isn't docked, or is the only docked pane (there is nothing to wrap).
	 */
	dockExistingAtEdge(panelId: string, edge: DockEdge): void {
		const node = findNode(this.layout.docked, panelId);
		if (!node || node.type !== 'panel') return;
		if (!removePanel(this.layout.docked, panelId)) return;
		const docked = this.#projected(
			'dockExistingAtEdge',
			this.#droppedAtEdge(node, edge, this.#makeId),
			panelId
		);
		this.layout = { ...this.layout, docked };
	}

	/**
	 * Move the OPEN floating window `panelId` back into the docked place `slot` describes (#663 ④,
	 * `DockHost.movePanel`'s `{ back: true }`): the tree `restoredAt` gives, with the region the pane
	 * comes back into expanded. Returns `false` (nothing changes) when it is not an open floating
	 * window or the place is gone.
	 *
	 * To be removed in #782 PR8c: use `dockBack`.
	 */
	dockAtSlot(panelId: string, slot: DockSlot, makeId: () => string = this.#makeId): boolean {
		const win = this.layout.floating.find((w) => w.id === panelId);
		if (!win || !win.open) return false;
		// Back to where it was: its tombstone in S (#782 PR6). Any other slot - or a `homeSlot` S has
		// no place for - is put back by `core/slot.ts` on the docked tree, and S is made again.
		const back = this.#backInShadow(panelId, slot, makeId);
		let docked: DockNode | null;
		if (back !== null) docked = this.#expanded('dockAtSlot', back, panelId);
		else {
			const restored = this.restoredAt(panelId, slot, makeId);
			if (restored === null) return false;
			docked = expandRegionOf(restored, panelId);
		}
		this.layout = {
			...this.layout,
			floating: this.layout.floating.filter((w) => w.id !== panelId),
			docked
		};
		return true;
	}

	/**
	 * Move the OPEN floating window `panelId` back where it was docked (`DockHost.movePanel`'s
	 * `{ back: true }`): the tree `backTree` gives, with the region the pane comes back into
	 * expanded. Returns `false` (nothing changes) when it is not an open floating window, it
	 * remembers no place, or the place is gone.
	 */
	dockBack(panelId: string, makeId: () => string = this.#makeId): boolean {
		const slot = this.#homeSlots.get(panelId);
		return slot === undefined ? false : this.dockAtSlot(panelId, slot, makeId);
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
	/**
	 * Put one floating window's geometry back to what it was in `from` (a
	 * cancelled resize, #433). Only that window changes; nothing happens if it
	 * no longer exists in either layout.
	 */
	restoreWindowGeometry(id: string, from: DockLayout): void {
		const before = from.floating.find((w) => w.id === id);
		if (!before) return;
		const { x, y, width, height } = before;
		this.#update(id, (w) => ({ ...w, x, y, width, height }));
	}

	/**
	 * Put one split's sizes back to what they were in `from` (a cancelled
	 * divider drag, #433). Only that split changes; nothing happens if it no
	 * longer exists or its child count changed.
	 */
	restoreSplitSizes(splitId: string, from: DockLayout): void {
		const before = findNode(from.docked, splitId);
		const now = findNode(this.layout.docked, splitId);
		if (!before || !now || before.type !== 'split' || now.type !== 'split') return;
		if (before.sizes.length !== now.children.length) return;
		// The split of S as it was in the S that showed `from` (#782 PR6): the shares of the panes
		// out of it too, which a drag changes when what shows had 0 together. Only while the split
		// has the children it had; else what shows is put back, and S takes it from there.
		const then = from.docked ? this.#shadowAt.get(from.docked) : undefined;
		const restored = then ? copyShadowSizes(this.#shadow, splitId, then) : undefined;
		if (restored !== undefined) {
			this.layout = {
				...this.layout,
				docked:
					restored === this.#shadow
						? this.layout.docked
						: this.#projected('restoreSplitSizes', restored)
			};
			return;
		}
		const sizes = before.sizes.slice();
		// Tab groups hold panels only, so only splits need to be walked.
		const replace = (node: DockNode): DockNode => {
			if (node.type !== 'split') return node;
			if (node.id === splitId) return { ...node, sizes };
			return { ...node, children: node.children.map(replace) };
		};
		this.layout = {
			...this.layout,
			docked: this.layout.docked ? replace(this.layout.docked) : null
		};
	}

	resizeSplit(splitId: string, dividerIndex: number, deltaFraction: number): void {
		// On S (#782 PR6): the shown children share what they have together; a tombstone keeps its own.
		const s = resizeShadowSplit(this.#shadow, splitId, dividerIndex, deltaFraction);
		this.layout = {
			...this.layout,
			docked: s === this.#shadow ? this.layout.docked : this.#projected('resizeSplit', s)
		};
	}

	/** Serialize the whole layout for persistence (spec §5.1). */
	serialize(): string {
		return JSON.stringify(this.savedLayout());
	}

	/**
	 * The layout as `serialize` writes it: `layout` itself since #782 PR5 (a closed window holds no
	 * slot whose shares would be taken without the floated panes). Kept as the one thing to save
	 * when the layout is saved as an object (`ThreePaneDock`'s `layoutSnapshot` does). It holds the
	 * places of the regions in the edge bands (`dockedWithAutoHidden`, #782 PR8b): read back by
	 * `hydrate`, the constructor and a layout taken as a whole (`adoptLayout`), not by an assignment
	 * to `layout` - there the places are the ones this state holds.
	 */
	savedLayout(): DockLayout {
		return this.layout;
	}

	/**
	 * Apply a previously-serialized layout onto this instance and return
	 * whether it was adopted (shared-primitives-upstream-plan §3.2, spec §5.1).
	 * The payload is validated as a whole by `validateDockLayout` (version,
	 * structure, unique ids, finite coordinates, positive sizes, valid
	 * split/tabs); malformed JSON or any issue returns `false` and leaves the
	 * current layout untouched (never partially applied). Only version 4 is
	 * read (#782 PR8b): a payload of versions 1 - 3 returns `false` like any
	 * other issue, and the app shows its default layout. Ids that no longer
	 * correspond to a known window definition are deliberately kept as-is -
	 * pruning them is the host component's job at render time
	 * (`ensureWindow`/`ensurePanel` never remove anything). The `docked` tree
	 * has its `sizes` repaired via `normalizeSizes`. The one part read on its
	 * own is `dockedWithAutoHidden` (the places of the regions in the edge
	 * bands): a tree that does not show `docked` is left out, and those regions
	 * dock at their default place, else along their edge.
	 *
	 * `serialize()`/`hydrate()` only convert to/from a string; writing to real
	 * storage is the app's job. Consumer contract: if that write fails, do not
	 * mark the snapshot as saved (keep the previous saved snapshot).
	 */
	hydrate(json: string): boolean {
		let parsed: unknown;
		try {
			parsed = JSON.parse(json);
		} catch {
			return false;
		}
		const result = validateDockLayout(parsed);
		if (!result.ok) return false;
		// Another layout replaces this one: the floated panes' places belong to the old tree, even
		// for an id that is floating in both (#738 review). A rejected payload keeps them (above).
		this.#homeSlots.clear();
		this.#adopt(result.layout);
		return true;
	}

	/** Discard the current layout (docked tree included) and re-place every def at its cascade default, all open, floating. */
	reset(defs: FloatingWindowDef[], hostW: number, hostH: number): void {
		// Same as `hydrate`: the remembered places belong to the discarded tree.
		this.#homeSlots.clear();
		this.#adopt({
			version: 4,
			floating: defs.map((def, index) => placeNew(def, index, hostW, hostH)),
			docked: null
		});
	}

	/**
	 * Assign a layout taken as a whole (`hydrate` / `reset` / the constructor, and `adoptLayout`):
	 * its slots are as given - the panes pending before belong to the layout replaced.
	 */
	#adopt(layout: DockLayout): void {
		// A copy of an earlier layout of this state (a cancelled gesture's snapshot): the places the
		// floated panes remembered then are theirs again, with the S that held them.
		const held = this.#heldAt.get(layout);
		if (held) {
			const floating = new Set(layout.floating.map((w) => w.id));
			this.#homeSlots = new Map([...held.homes].filter(([id]) => floating.has(id)));
			this.#shadowLost = new Set([...held.lost].filter((id) => floating.has(id)));
		}
		this.#adopting = true;
		this.#adoptHeld = held;
		try {
			this.layout = layout;
		} finally {
			this.#adopting = false;
			this.#adoptHeld = undefined;
		}
	}

	static {
		adoptImpl = (dock, layout) => dock.#adopt(layout);
		homeMarkImpl = (dock, id) => dock.#homeSlots.get(id);
		forgetImpl = (dock) => {
			dock.#homeSlots.clear();
			dock.#shadowLost.clear();
		};
		rememberImpl = (dock, snapshot) => {
			dock.#heldAt.set(snapshot, {
				shadow: dock.#shadow,
				homes: new Map(dock.#homeSlots),
				unplaced: new Set(dock.#shadowUnplaced),
				lost: new Set(dock.#shadowLost)
			});
			if (snapshot.docked !== null && dock.#shadow !== null)
				dock.#shadowAt.set(snapshot.docked, dock.#shadow);
		};
		shadowImpl = (dock) => ({
			shadow: dock.#shadow,
			unplaced: [...dock.#shadowUnplaced],
			follows: dock.#shadowFollows
		});
		watchShadowImpl = (dock, watch) => {
			dock.#shadowWatch = watch;
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

/** Ids of the panes really on screen (#792): see `DockState.isOnScreen`. */
function onScreenPanelIds(layout: DockLayout, flyout: string | null): Set<string> {
	const out = new Set<string>();
	const visit = (node: DockNode): void => {
		if (node.type === 'panel') {
			if (!node.collapsed) out.add(node.id);
		} else if (node.type === 'tabs') {
			if (node.collapsed) return;
			const front = node.children[node.activeIndex];
			if (front) out.add(front.id);
		} else node.children.forEach(visit);
	};
	if (layout.docked) visit(layout.docked);
	for (const w of layout.floating) if (w.open && !w.collapsed) out.add(w.id);
	if (flyout !== null && findAutoHidden(layout, flyout) !== null) out.add(flyout);
	return out;
}
