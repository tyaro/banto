/**
 * The pane lifecycle of one `DockHost` (spec §5.2; shared-primitives-upstream-
 * plan §3.5, §4.2, D3-c and D4, #432): every STRUCTURE change the dock UI makes
 * - dock / undock / move a docked pane / switch a tab / hide / close - asks the
 * consumer's `beforePanelChange` first, and the content of `keepMounted` panes
 * survives a tab switch and a hide (`hidden` + `inert`, same DOM nodes).
 *
 * ## Where it sits (plan §4.2)
 *
 * The `GestureOwner` (#433) owns one pointer / keyboard transaction. Geometry-
 * only changes (move / resize a floating window, a divider) end there and never
 * reach this module - they do not touch the content. A gesture that ends in a
 * structure change hands a REQUEST to `request()` from its `commit` callback,
 * which runs after the session is closed, so a confirm dialog never waits
 * inside a gesture. Refused = the layout is not touched (the ghost is already
 * gone, so the pane simply stays where it was).
 *
 * ## The request contract
 *
 * - **Only `true` applies.** `beforePanelChange` returning (or resolving to)
 *   `true` lets the change through; `false`, any other value, a throw or a
 *   rejection refuses it. Omitted = always `true`.
 * - **Own state first, re-check after.** When a request is made (or first held
 *   for IME composition) it records the structure GENERATION of the layout:
 *   `DockState.structureRevision`, a counter that goes up on every assignment
 *   whose `structureKey` (docked tree shape, active tabs, floating ids and
 *   their open flags) differs from the previous one, and on every slide out /
 *   back of an auto-hidden pane - geometry, split sizes and z-order do not count. Right before `apply` it checks again: the host is
 *   still mounted, the revision (and, for a layout mutated in place, the key)
 *   is unchanged, and the change described NOW (`describe`: which pane a tab
 *   switch leaves, `remount` from `keepMounted` at this moment) is the one the
 *   hook was asked about. Otherwise it is `stale`. A revision rather than a
 *   key comparison, so a structure that came back to the same shape while the
 *   hook waited (close -> open re-mounts a pane, tab A -> B -> A re-creates a
 *   pane that is not `keepMounted`) never gets the old decision applied to the
 *   new content. A hook that re-enters (makes another structure change,
 *   unmounts the host) is covered by the same check. This is narrower than the
 *   request owner of #436 (no busy flag, no resources, no "latest wins"): each
 *   change is checked against the structure it was asked about.
 * - **Which requests are the same.** A request is identified by the change
 *   AND its destination (`target`: the drop target and region of a dock /
 *   move-docked, the drop position of an undock). The same request while the
 *   first is waiting (a double click on ✕) returns the pending one instead of
 *   asking again. A different destination for the same pane (dropped on X,
 *   then on Y while X waits) is a different request and is asked on its own;
 *   whichever is approved first applies, and the other is then `stale` (the
 *   structure moved).
 * - **Disposal.** When the host unmounts, every waiting request - held, or
 *   waiting for a promise that may never settle - resolves `disposed` at once
 *   and drops its `apply` / `describe` callbacks.
 * - **Apply by id.** The `apply` callbacks look ids up when they run and are
 *   no-ops when the id is gone.
 * - **Panes pushed out (#666).** A drop into the docked tree (and `show` of a
 *   pane hidden from it) can change other docked panes too: the old active
 *   tab of the group it lands in leaves the screen, and a pane that a new
 *   split or tab group is made around is mounted again (`core/mounts.ts`:
 *   a Svelte component cannot be moved to another parent, so this holds
 *   for `keepMounted` panes as well). `requestPlacement` asks each of them
 *   first (`tab-switch` / `reparent`), then the moved pane, and applies
 *   once all agreed on the same structure. Taking a docked pane OUT of the
 *   tree (hide / close / undock, #682) asks the pane a shrinking split or
 *   tab group leaves, as `reparent`, the same way (`requestRemoval`).
 * - **Auto-hide (#694 PR-3).** Moving a whole region between the docked tree
 *   and an edge band (`autoHide` / `restoreAutoHidden`) goes through
 *   `requestPlacement` too: the panes pushed out first, then every pane of the
 *   region whose content is mounted, as `auto-hide`. Sliding a band's pane out
 *   and back is not asked (it is showing, like expanding a collapsed band).
 *
 * ## IME composition (plan §3.5 / §4.2)
 *
 * While `isDeferred()` is true (the consumer's `isStructureChangeDeferred`,
 * default: a `compositionstart` on the document without its `compositionend`,
 * on an element that is still connected and focused) a request is not asked
 * nor applied: it is held (one slot - a newer request replaces the held one,
 * which resolves `superseded`) and retried after `compositionend` / `focusout`
 * on the document (on the next task, after the IME's final `input`) or an
 * explicit `resumeDeferred()`. The DOM is never torn down mid-composition on
 * the assumption that the conversion could be restored. This is checked
 * twice: when the request is made and again when an async answer arrives - an
 * approval that arrives while a composition is open is held the same way and
 * applied after it ends (unless the structure changed meanwhile: `stale`). A
 * held request keeps the structure generation of the moment it was held, so a
 * layout change made by the app while it waits makes it `stale` too.
 * `DockHost` also
 * refuses to START a `drag` while deferred (move / resize / divider still
 * start: they do not touch the DOM of the content).
 *
 * ## hide vs close (D4-a)
 *
 * - `hide(id)`: the pane leaves the screen, its content is kept when
 *   `keepMounted(id)` (a floating window stays mounted `hidden` + `inert`; a
 *   docked pane becomes a closed floating window, which re-mounts it - the
 *   change says so with `remount: true`).
 * - `close(id)`: the content is discarded (unmounted even for a `keepMounted`
 *   pane) until the pane is opened again.
 * - The ✕ button (`closeButton`) is `hide` for a `keepMounted` pane and
 *   `close` otherwise (today's behaviour). Both keep the window's geometry.
 */
import { getContext, setContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import {
	activePanelOf,
	autoHiddenPanelIds,
	findAutoHidden,
	regionOf,
	regionPanelIds,
	removeRegion,
	type AutoHideOptions
} from './autohide';
import { displacedChanges, mountedPanes } from './mounts';
import { layoutChanges } from './replace';
import { restoreDockSlot } from './slot';
import { findNode, findParent, removePanel, structureKey } from './tree';
import type { DockState } from '../state.svelte';
import type { DockLayout, DockNode, DockPanelNode } from '../types';

/**
 * A structure change the dock UI is about to make (shared-primitives-upstream-
 * plan §3.5). `remount` says what happens to the content: `true` = it is
 * unmounted now and mounted again later (capture a draft so the next mount can
 * restore it), `false` = its DOM is kept (`hidden` + `inert`). For
 * `tab-switch` it describes the `from` pane. `close` discards the content.
 * `reparent` is a pane the user did not move, whose parent changes (a split or
 * tab group is made around it, or undone): `cause` is the pane being moved.
 * `auto-hide` (#694 PR-3) is a pane of a region that moves between the docked
 * tree and an edge band (`to: 'band'` = auto-hidden by its pin button, `'tree'`
 * = pinned back): its content is drawn by another parent, so it is re-mounted.
 * A `persistent` pane (#663 ④, three-pane-dock-plan §4.2 C) is never re-mounted
 * by any of these (its content lives outside the tree and is only moved):
 * `remount: false`, and it is not asked as `reparent` at all.
 */
export type DockPanelChange =
	| { kind: 'dock' | 'undock' | 'move-docked'; panelId: string; remount: boolean }
	| { kind: 'auto-hide'; panelId: string; to: 'band' | 'tree'; remount: boolean }
	| { kind: 'reparent'; panelId: string; cause: string; remount: boolean }
	| { kind: 'tab-switch'; groupId: string; from: string; to: string; remount: boolean }
	| { kind: 'hide'; panelId: string; remount: boolean }
	| { kind: 'close'; panelId: string };

/**
 * How a requested change ended: `applied`; `refused` (the hook said no, threw
 * or rejected); `stale` (the layout's structure changed before the answer, so
 * the old decision is not applied); `superseded` (a newer request replaced it
 * while it was held for IME composition); `disposed` (the host unmounted).
 */
export type DockPanelChangeOutcome = 'applied' | 'refused' | 'stale' | 'superseded' | 'disposed';

export interface PanelLifecycleOptions {
	beforePanelChange?: (change: DockPanelChange) => boolean | Promise<boolean>;
	keepMounted?: (panelId: string) => boolean;
	/** Panes whose content is drawn once outside the tree and moved (#663 ④). Implies `keepMounted`. */
	persistent?: (panelId: string) => boolean;
	isStructureChangeDeferred?: () => boolean;
}

/** Re-exported from `core/tree` (the encoding `DockState.structureRevision` counts changes of). */
export { structureKey };

/** How a request is told apart and re-checked (module doc). */
export interface PanelChangeRequestOptions {
	/** The destination of the change (drop target + region, drop position): part of the request's identity. */
	target?: unknown;
	/** The change as it would be described now; `null` = it no longer exists. Re-checked right before `apply`. */
	describe?: () => DockPanelChange | null;
	/** Is the caller still asking for it? `false` = `stale`. Re-checked like `describe` (`guarded`). */
	guard?: () => boolean;
}

interface Job {
	change: DockPanelChange;
	apply: () => void;
	describe: (() => DockPanelChange | null) | undefined;
	/** The caller's own "still wanted" check (`guarded`); `false` = `stale`. */
	guard: (() => boolean) | undefined;
	/** The structure generation the request is about (when it was made or first held). */
	revision: number;
	structure: string;
	/** The hook said `true`; only the IME hold is in the way. */
	approved: boolean;
	/** Creation order: a held slot keeps the newer request (README). */
	seq: number;
	done: boolean;
	resolve: (outcome: DockPanelChangeOutcome) => void;
	/** Drops the reaction attached to the hook's promise (which may never settle). */
	release: () => void;
}

const CAPTURE: AddEventListenerOptions = { capture: true };

export class PanelLifecycle {
	#dock: DockState;
	#getOptions: () => PanelLifecycleOptions;
	#disposed = false;
	#held: Job | null = null;
	#nextSeq = 0;
	#retryTimer: ReturnType<typeof setTimeout> | null = null;
	/** Requests not resolved yet (asked, waiting for the hook, or held), by identity. */
	#pending = new Map<string, Promise<DockPanelChangeOutcome>>();
	/** `requestPlacement`s not resolved yet, by identity (the whole list of changes and the target). */
	#placements = new Map<string, Promise<DockPanelChangeOutcome>>();
	#jobs = new Set<Job>();
	/** The `guarded` check of the call being made now (taken by every request it makes). */
	#guard: (() => boolean) | undefined = undefined;
	/** The element of an open composition (`compositionstart` without `compositionend`). */
	#composingIn: Element | null = null;
	/** Panes whose content was discarded by `close` - not kept mounted while hidden, until shown again. */
	readonly discarded = new SvelteSet<string>();

	constructor(dock: DockState, getOptions: () => PanelLifecycleOptions = () => ({})) {
		this.#dock = dock;
		this.#getOptions = getOptions;
	}

	/** Start watching the document's composition (browser only; `DockHost` calls it on mount). Returns the detach. */
	attach(): () => void {
		document.addEventListener('compositionstart', this.#onCompositionStart, CAPTURE);
		document.addEventListener('compositionend', this.#onCompositionEnd, CAPTURE);
		document.addEventListener('focusout', this.#onFocusOut, CAPTURE);
		return () => {
			document.removeEventListener('compositionstart', this.#onCompositionStart, CAPTURE);
			document.removeEventListener('compositionend', this.#onCompositionEnd, CAPTURE);
			document.removeEventListener('focusout', this.#onFocusOut, CAPTURE);
		};
	}

	/** Is this pane's content kept mounted while it is not shown (the consumer's `keepMounted`, or `persistent`)? */
	keepMounted(panelId: string): boolean {
		return this.#getOptions().keepMounted?.(panelId) === true || this.persistent(panelId);
	}

	/**
	 * Is this pane's content drawn once outside the docked tree and moved into
	 * whichever place shows it (the consumer's `persistent`, #663 ④,
	 * three-pane-dock-plan §4.2 C)? Read at the moment it is asked, like `keepMounted`.
	 */
	persistent(panelId: string): boolean {
		return this.#getOptions().persistent?.(panelId) === true;
	}

	/** Does moving this pane to another parent re-mount its content (`false` for a `persistent` pane)? */
	remounts(panelId: string): boolean {
		return !this.persistent(panelId);
	}

	/** Is a hidden floating window's content kept mounted right now (`keepMounted` and not discarded by `close`)? */
	isRetained(panelId: string): boolean {
		return this.keepMounted(panelId) && !this.discarded.has(panelId);
	}

	/** The pane is shown again (open floating or docked): a later hide keeps it again. */
	forgetDiscarded(ids: Iterable<string>): void {
		for (const id of ids) if (this.discarded.has(id)) this.discarded.delete(id);
	}

	/** Should structure changes wait (IME composition, or the consumer's predicate)? */
	isDeferred(): boolean {
		const custom = this.#getOptions().isStructureChangeDeferred;
		if (custom) return custom() === true;
		const el = this.#composingIn;
		if (!el) return false;
		// A composing element that was removed or lost focus never sends
		// `compositionend` in some browsers; it no longer holds anything up.
		if (!el.isConnected || !el.contains(document.activeElement)) {
			this.#composingIn = null;
			return false;
		}
		return true;
	}

	/**
	 * Ask `beforePanelChange` about `change` and run `apply` if it agrees and
	 * the structure is still the one it was asked about (module doc). Held
	 * while `isDeferred()`. A synchronous `true` applies synchronously.
	 */
	request(
		change: DockPanelChange,
		apply: () => void,
		options: PanelChangeRequestOptions = {}
	): Promise<DockPanelChangeOutcome> {
		if (this.#disposed) return Promise.resolve('disposed');
		const id = JSON.stringify([change, options.target ?? null]);
		const pending = this.#pending.get(id);
		if (pending) return pending;
		const job: Job = {
			change,
			apply,
			describe: options.describe,
			guard: options.guard ?? this.#guard,
			revision: this.#dock.structureRevision,
			structure: structureKey(this.#dock.layout),
			approved: false,
			seq: this.#nextSeq++,
			done: false,
			resolve: () => {},
			release: () => {}
		};
		const promise = new Promise<DockPanelChangeOutcome>((resolve) => {
			job.resolve = (outcome) => {
				if (job.done) return;
				job.done = true;
				job.release();
				// Let go of the consumer's closures (the hook's promise may keep `job` alive).
				job.apply = () => {};
				job.describe = undefined;
				job.guard = undefined;
				this.#jobs.delete(job);
				if (this.#pending.get(id) === promise) this.#pending.delete(id);
				if (this.#held === job) this.#held = null;
				resolve(outcome);
			};
		});
		this.#jobs.add(job);
		this.#pending.set(id, promise);
		if (this.isDeferred()) this.#hold(job);
		else this.#ask(job);
		return promise;
	}

	/**
	 * Run `make` (which makes requests: `setVisible`, `requestReplace`, ...) with `guard` attached to
	 * every request it makes, now or later in the same sequence (PR #723 review): right before
	 * `apply` - and before each further step - `guard()` is re-read, and `false` makes the request
	 * `stale` with nothing changed. A caller whose newer wish needs no change (the pane is already
	 * where it wants it) uses it to retire an older request still being asked.
	 */
	guarded<T>(guard: (() => boolean) | undefined, make: () => T): T {
		const outer = this.#guard;
		this.#guard = guard ?? outer;
		try {
			return make();
		} finally {
			this.#guard = outer;
		}
	}

	/** Retry the request held for IME composition now (when the consumer's predicate turned false). */
	resumeDeferred(): void {
		if (this.#disposed || !this.#held || this.isDeferred()) return;
		const job = this.#held;
		this.#held = null;
		if (job.approved) this.#applyIfCurrent(job);
		else if (!this.#isCurrent(job)) job.resolve('stale');
		else this.#ask(job);
	}

	// --- the hide / close actions (module doc, D4-a) ---

	/** Take the pane off the screen, keeping a `keepMounted` pane's content (module doc). Already hidden = nothing to ask. */
	hide(panelId: string): Promise<DockPanelChangeOutcome> {
		const where = this.#whereIs(panelId);
		if (where === null) return Promise.resolve('stale');
		if (where === 'hidden') return Promise.resolve('applied');
		// `remount` follows `keepMounted` at the moment of applying, too (re-checked by `describe`).
		const describe = (): DockPanelChange => ({
			kind: 'hide',
			panelId,
			remount:
				this.remounts(panelId) &&
				(this.#isDocked(panelId) || this.#isAutoHiddenPane(panelId) || !this.keepMounted(panelId))
		});
		const apply = (): void => this.#takeOffScreen(panelId);
		if (where === 'docked') return this.requestRemoval(panelId, describe, apply, 'hide');
		return this.request(describe(), apply, { describe });
	}

	/** Take the pane off the screen and discard its content (module doc). A hidden pane whose content is not kept = nothing to ask. */
	close(panelId: string): Promise<DockPanelChangeOutcome> {
		const where = this.#whereIs(panelId);
		if (where === null) return Promise.resolve('stale');
		if (where === 'hidden' && !this.isRetained(panelId)) return Promise.resolve('applied');
		const apply = (): void => {
			// Discard first, so the window is not drawn hidden for one update.
			this.discarded.add(panelId);
			this.#takeOffScreen(panelId);
		};
		if (where === 'docked')
			return this.requestRemoval(panelId, () => ({ kind: 'close', panelId }), apply, 'close');
		return this.request({ kind: 'close', panelId }, apply);
	}

	/**
	 * A change that takes the docked pane `panelId` out of the docked tree
	 * (hide / close / undock, #682). A split or tab group that shrinks to one
	 * child draws one level less, so the pane that is left is mounted again
	 * (`core/mounts.ts`, `keepMounted` too): it is asked first as `reparent`
	 * (`cause` = `panelId`), then `own` (the leaving pane's own change), through
	 * `requestPlacement`. A removal that leaves every other pane's chain as it
	 * was (3+ children, a bare pane) asks only `own`.
	 */
	requestRemoval(
		panelId: string,
		own: () => DockPanelChange | null,
		apply: () => void,
		target: unknown
	): Promise<DockPanelChangeOutcome> {
		return this.requestPlacement(
			panelId,
			() => (this.#isDocked(panelId) ? own() : null),
			() => (this.#isDocked(panelId) ? removePanel(this.#dock.layout.docked, panelId) : undefined),
			apply,
			target
		);
	}

	/** The ✕ button: `hide` for a `keepMounted` pane, `close` otherwise. */
	closeButton(panelId: string): Promise<DockPanelChangeOutcome> {
		return this.keepMounted(panelId) ? this.hide(panelId) : this.close(panelId);
	}

	/**
	 * Show the pane (`DockState.show`, #663). Not asked, like `DockState.open`
	 * - except when it changes what another docked pane shows or puts mounted
	 * content back into the tree:
	 *
	 * - An open floating window is only brought to the front (`DockState.show`,
	 *   nothing to ask).
	 * - A docked background tab is brought up with `switchTab` (a `tab-switch`,
	 *   like a tab click).
	 * - A pane hidden from the dock goes back to its remembered place through
	 *   `requestPlacement` (#666): the docked panes it pushes out are asked
	 *   first - the group's active pane it replaces as the active tab (or the
	 *   bare panel a group is re-made around: `remount: true`) as a
	 *   `tab-switch` to this pane, a pane (or the tabs of a group) a split is
	 *   re-made around as `reparent` (it is re-mounted) - through the same
	 *   `request` as a tab click (refused = the pane stays hidden; held while
	 *   an IME composition is open).
	 * - Putting a hidden pane whose content is still mounted (`keepMounted`,
	 *   not discarded) back into the docked tree moves that content from the
	 *   floating layer into the tree (re-mount), so it is asked as a `dock`
	 *   change (`remount: true`) - after the pushed-out panes, on the structure
	 *   they were approved on (changed in between = `stale`).
	 */
	show(panelId: string): Promise<DockPanelChangeOutcome> {
		const where = this.#whereIs(panelId);
		if (where === null) return Promise.resolve('stale');
		if (where === 'docked') {
			// A background tab: bringing it up is a tab switch (asked like a tab click).
			const group = findParent(this.#dock.layout.docked, panelId);
			if (group?.type !== 'tabs') {
				this.#dock.revealDocked(panelId);
				return Promise.resolve('applied');
			}
			const switched = this.switchTab(group.id, panelId);
			// Showing the pane also expands a region collapsed to a band (#663 ③-B). It is not a
			// structure decision (nothing is mounted or unmounted), so it needs no request of its own.
			return switched.then((outcome) => {
				if (outcome === 'applied') this.#dock.revealDocked(panelId);
				return outcome;
			});
		}
		if (where === 'autohidden') {
			// Auto-hidden (#694 PR-3): slid out of its band. Not asked, like expanding a band:
			// no docked pane changes (the slid-out content mounts as when its band tab is pressed).
			this.#dock.show(panelId);
			return Promise.resolve('applied');
		}
		if (where === 'open') {
			// An open floating window: `DockState.show` only brings it to the front.
			this.#dock.show(panelId);
			return Promise.resolve('applied');
		}
		const redocksMounted = (): boolean =>
			this.#whereIs(panelId) === 'hidden' &&
			this.isRetained(panelId) &&
			this.#dock.showPlacement(panelId) === 'docked';
		// The docked tree after `show`: put back in its remembered place, or unchanged
		// (opened floating). The fixed id of a group it would re-make keeps the
		// preview stable across the re-checks (`DockState.showTabSwitch` does the same).
		const preview = (): DockNode | null | undefined => {
			if (this.#whereIs(panelId) !== 'hidden') return undefined;
			const win = this.#dock.layout.floating.find((w) => w.id === panelId)!;
			const docked = this.#dock.layout.docked;
			if (!win.dockSlot) return docked;
			const node: DockPanelNode = { type: 'panel', id: win.id, title: win.title, icon: win.icon };
			return (
				restoreDockSlot(docked, node, win.dockSlot, () => `${panelId}:restored-tabs`) ?? docked
			);
		};
		return this.requestPlacement(
			panelId,
			() => (redocksMounted() ? { kind: 'dock', panelId, remount: this.remounts(panelId) } : null),
			preview,
			() => this.#dock.show(panelId),
			'show'
		);
	}

	/**
	 * A View menu's checkbox (#663): `true` = `show`; `false` = the ✕ button
	 * (`closeButton`: hide for a `keepMounted` pane, close otherwise, asked
	 * through `beforePanelChange`). Already in that state = `applied`.
	 */
	setVisible(panelId: string, visible: boolean): Promise<DockPanelChangeOutcome> {
		return visible ? this.show(panelId) : this.closeButton(panelId);
	}

	/**
	 * A change that puts `panelId` somewhere in the docked tree (a drop, `show`)
	 * and may push other docked panes out (#666, `core/mounts.ts`): a new split
	 * or tab group made around a pane re-mounts it, and a new active tab takes
	 * the old one off the screen. Each pushed-out pane is asked first (in tree
	 * order: `tab-switch` / `reparent`), then `own` (the moved pane's own
	 * change, `null` = not asked), one after the other; the first refusal
	 * stops it with nothing changed, and `apply` runs after the last approval.
	 * The answers are one decision about one structure: every request after
	 * the first keeps the generation the first was made on, and the list of
	 * changes is re-built and compared before each step and before `apply`
	 * (changed = `stale`). `preview` is the docked tree `apply` would make
	 * (`undefined` = the change no longer exists). Nothing to ask = applied
	 * at once. The same placement while the first is waiting returns the
	 * pending one; another placement is asked on its own, even when a step
	 * asks the same pane the same thing.
	 */
	requestPlacement(
		panelId: string,
		own: () => DockPanelChange | DockPanelChange[] | null,
		preview: () => DockNode | null | undefined,
		apply: () => void,
		target: unknown,
		/** Panes that move together with `panelId` (a whole region, #694 PR-3): asked by `own`, not as `reparent`. */
		moving: readonly string[] = []
	): Promise<DockPanelChangeOutcome> {
		if (this.#disposed) return Promise.resolve('disposed');
		const describeAll = (): DockPanelChange[] | null => {
			const after = preview();
			if (after === undefined) return null;
			const keep = (id: string) => this.keepMounted(id);
			const persists = (id: string) => this.persistent(id);
			const changes = displacedChanges(
				this.#dock.layout.docked,
				after,
				panelId,
				keep,
				persists
			).filter((c) => !(c.kind === 'reparent' && moving.includes(c.panelId)));
			const mine = own();
			if (mine === null) return changes;
			return [...changes, ...(Array.isArray(mine) ? mine : [mine])];
		};
		return this.#sequence(describeAll, apply, target);
	}

	/**
	 * Replace the whole layout (#663 ④, `DockHost.replaceLayout`: `ThreePaneDock`'s `resetLayout` /
	 * `restoreLayout`). Every pane whose content the replacement takes off the screen or re-mounts
	 * is asked first, in the order `layoutChanges` lists them (`core/replace.ts`), as one decision
	 * like `requestPlacement`: a refusal stops it with nothing changed, a structure change while it
	 * waits makes it `stale`, and `preview` (the layout `apply` would install; `undefined` = no
	 * longer possible) is re-read and compared before each step and before `apply`. Nothing to ask
	 * = applied at once. The layout `preview` gives now is part of the request's identity: the same
	 * replacement while it is asked shares the pending one, another destination is asked on its own
	 * (whichever is applied first wins, the other is `stale`), and a `preview` that later gives
	 * another layout makes it `stale`.
	 */
	requestReplace(
		preview: () => DockLayout | undefined,
		apply: (next: DockLayout) => void
	): Promise<DockPanelChangeOutcome> {
		if (this.#disposed) return Promise.resolve('disposed');
		const first = preview();
		if (first === undefined) return Promise.resolve('stale');
		// The destination is part of the request's identity (PR #723 review): two replacements whose
		// changes read the same (a floating pane docked on one side or the other) are asked apart,
		// and the one applied second finds the structure changed (`stale`).
		const destination = JSON.stringify(first);
		const describeAll = (): DockPanelChange[] | null => {
			const next = preview();
			if (next === undefined || JSON.stringify(next) !== destination) return null;
			return layoutChanges(
				this.#dock.layout,
				next,
				(id) => this.keepMounted(id),
				(id) => this.persistent(id),
				this.#dock.flyoutPanel
			);
		};
		return this.#sequence(
			describeAll,
			() => {
				const next = preview();
				if (next !== undefined) apply(next);
			},
			{ replace: destination }
		);
	}

	/** The asking loop shared by `requestPlacement` and `requestReplace` (see `requestPlacement`). */
	#sequence(
		describeAll: () => DockPanelChange[] | null,
		apply: () => void,
		target: unknown
	): Promise<DockPanelChangeOutcome> {
		const guard = this.#guard;
		const changes = describeAll();
		if (changes === null) return Promise.resolve('stale');
		if (changes.length === 0) {
			// Nothing to ask, but the caller's "still wanted" check holds all the same.
			if (guard && !guard()) return Promise.resolve('stale');
			apply();
			return Promise.resolve('applied');
		}
		const id = JSON.stringify([changes, target ?? null]);
		const pending = this.#placements.get(id);
		if (pending) return pending;
		const revision = this.#dock.structureRevision;
		const structure = structureKey(this.#dock.layout);
		const same = (): boolean =>
			this.#dock.structureRevision === revision &&
			structureKey(this.#dock.layout) === structure &&
			JSON.stringify(describeAll()) === JSON.stringify(changes);
		// The next request is made from the previous one's `apply` (right after its
		// approval, on the structure it was approved on), so synchronous answers
		// apply synchronously, like a single request.
		const step = (i: number): Promise<DockPanelChangeOutcome> => {
			const last = i === changes.length - 1;
			let next: Promise<DockPanelChangeOutcome> | null = null;
			return this.request(changes[i], last ? apply : () => (next = step(i + 1)), {
				// The whole placement is part of each step's identity: another placement whose
				// step asks the same pane the same thing must not share this one's continuation.
				target: id,
				describe: () => (same() ? changes[i] : null),
				guard
			}).then((outcome) => (outcome === 'applied' && next ? next : outcome));
		};
		const promise = step(0).finally(() => {
			if (this.#placements.get(id) === promise) this.#placements.delete(id);
		});
		this.#placements.set(id, promise);
		return promise;
	}

	/**
	 * Auto-hide the docked region that holds `id` (#694 PR-3, the pin button):
	 * through `requestPlacement`, the docked panes the removal pushes out (the one
	 * a shrinking split leaves) are asked first as `reparent`, then every pane of
	 * the region whose content is mounted now (the shown pane, `keepMounted`
	 * tabs) as `auto-hide` (`to: 'band'`). Its content is drawn by the band's
	 * slide-out afterwards, so it is re-mounted (`keepMounted` too). Changed in
	 * between = `stale`.
	 */
	autoHide(id: string, options: AutoHideOptions = {}): Promise<DockPanelChangeOutcome> {
		const first = regionOf(this.#dock.layout.docked, id);
		if (!first) return Promise.resolve('stale');
		const regionId = first.id;
		const ids = regionPanelIds(first);
		const cause = activePanelOf(first).id;
		const region = () => {
			const now = regionOf(this.#dock.layout.docked, regionId);
			return now && now.id === regionId ? now : null;
		};
		const own = (): DockPanelChange[] | null => {
			const now = region();
			if (!now) return null;
			const mounted = mountedPanes(this.#dock.layout.docked, (p) => this.keepMounted(p));
			return regionPanelIds(now)
				.filter((p) => mounted.has(p))
				.map((panelId) => ({
					kind: 'auto-hide',
					panelId,
					to: 'band',
					remount: this.remounts(panelId)
				}));
		};
		return this.requestPlacement(
			cause,
			own,
			() => (region() ? removeRegion(this.#dock.layout.docked, regionId) : undefined),
			() => void this.#dock.autoHideRegion(regionId, options),
			['auto-hide', regionId],
			ids
		);
	}

	/**
	 * Put the auto-hidden region that holds `id` back into the docked tree
	 * (#694 PR-3, the pin button of a slid-out pane): the docked panes it pushes
	 * out are asked first (`tab-switch` / `reparent`), then every pane of the
	 * region whose content is mounted now (slid out, or `keepMounted`) as
	 * `auto-hide` (`to: 'tree'`). Changed in between = `stale`.
	 */
	restoreAutoHidden(id: string): Promise<DockPanelChangeOutcome> {
		const first = findAutoHidden(this.#dock.layout, id);
		if (!first) return Promise.resolve('stale');
		const regionId = first.entry.node.id;
		const ids = regionPanelIds(first.entry.node);
		const own = (): DockPanelChange[] | null => {
			const now = findAutoHidden(this.#dock.layout, regionId);
			if (!now || now.entry.node.id !== regionId) return null;
			return regionPanelIds(now.entry.node)
				.filter((p) => this.#isFlyoutMounted(p))
				.map((panelId) => ({
					kind: 'auto-hide',
					panelId,
					to: 'tree',
					remount: this.remounts(panelId)
				}));
		};
		return this.requestPlacement(
			activePanelOf(first.entry.node).id,
			own,
			() => this.#dock.previewRestoreAutoHidden(regionId),
			() => void this.#dock.restoreAutoHidden(regionId),
			['auto-hide-restore', regionId],
			ids
		);
	}

	/** Switch the docked tab group `groupId` to the tab `to` (by id; no-op when it is already active or gone). */
	switchTab(groupId: string, to: string, after?: () => void): Promise<DockPanelChangeOutcome> {
		const describe = (): DockPanelChange | null => {
			const group = findNode(this.#dock.layout.docked, groupId);
			if (!group || group.type !== 'tabs') return null;
			const from = group.children[group.activeIndex]?.id;
			if (from === undefined) return null;
			return { kind: 'tab-switch', groupId, from, to, remount: !this.keepMounted(from) };
		};
		const change = describe();
		if (change === null) return Promise.resolve('stale');
		if (change.kind === 'tab-switch' && change.from === to) return Promise.resolve('applied');
		return this.request(
			change,
			() => {
				const now = findNode(this.#dock.layout.docked, groupId);
				if (!now || now.type !== 'tabs') return;
				const index = now.children.findIndex((c) => c.id === to);
				if (index === -1) return;
				this.#dock.setActiveTab(groupId, index);
				after?.();
			},
			{ describe }
		);
	}

	/** `DockHost` unmounts: nothing held or pending is applied any more, and every waiting request resolves `disposed` now. */
	dispose(): void {
		this.#disposed = true;
		if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
		this.#retryTimer = null;
		this.#held = null;
		for (const job of [...this.#jobs]) job.resolve('disposed');
	}

	#whereIs(panelId: string): 'docked' | 'autohidden' | 'open' | 'hidden' | null {
		if (this.#isDocked(panelId)) return 'docked';
		if (this.#isAutoHiddenPane(panelId)) return 'autohidden';
		const win = this.#dock.layout.floating.find((w) => w.id === panelId);
		if (!win) return null;
		return win.open ? 'open' : 'hidden';
	}

	#isDocked(panelId: string): boolean {
		return findNode(this.#dock.layout.docked, panelId)?.type === 'panel';
	}

	/** A pane (not a group id) of a region auto-hidden to an edge band (#694 PR-3). */
	#isAutoHiddenPane(panelId: string): boolean {
		return autoHiddenPanelIds(this.#dock.layout).includes(panelId);
	}

	/** Is the auto-hidden pane's content mounted now: slid out, or kept (`keepMounted`)? */
	#isFlyoutMounted(panelId: string): boolean {
		return this.#dock.flyoutPanel === panelId || this.keepMounted(panelId);
	}

	/** A docked pane has no hidden state of its own: it becomes a closed floating window that remembers its docked place (`DockState.dismiss`, #663). */
	#takeOffScreen(panelId: string): void {
		this.#dock.dismiss(panelId);
	}

	#ask(job: Job): void {
		const hook = this.#getOptions().beforePanelChange;
		let verdict: unknown;
		try {
			verdict = hook ? hook(job.change) : true;
		} catch {
			job.resolve('refused');
			return;
		}
		if (!isThenable(verdict)) {
			this.#settle(job, verdict);
			return;
		}
		// The reaction holds only `slot`, emptied when the job ends (dispose),
		// so a promise that never settles does not keep the job's closures.
		const slot: { settle: ((ok: boolean, value: unknown) => void) | null } = {
			settle: (ok, value) => (ok ? this.#settle(job, value) : job.resolve('refused'))
		};
		job.release = () => (slot.settle = null);
		Promise.resolve(verdict).then(
			(value) => slot.settle?.(true, value),
			() => slot.settle?.(false, undefined)
		);
	}

	#settle(job: Job, verdict: unknown): void {
		if (job.done) return;
		if (this.#disposed) return job.resolve('disposed');
		if (verdict !== true) return job.resolve('refused');
		job.approved = true;
		// A composition may have started while the hook waited: hold the approval.
		// An approval that is already stale must not take the slot (it would push
		// out a current held request and then be dropped itself on resume).
		if (this.isDeferred()) {
			if (!this.#isCurrent(job)) return job.resolve('stale');
			return this.#hold(job);
		}
		this.#applyIfCurrent(job);
	}

	/**
	 * One slot: a newer request replaces the older one (`superseded`), by
	 * creation order - an older request whose approval arrives late does not
	 * push out a newer held one; it is the one superseded.
	 */
	#hold(job: Job): void {
		const held = this.#held;
		if (held && held !== job) {
			if (held.seq > job.seq) return job.resolve('superseded');
			held.resolve('superseded');
		}
		this.#held = job;
	}

	/** Is the structure still the one the job was asked about (module doc)? Calls `describe` (consumer code) first. */
	#isCurrent(job: Job): boolean {
		if (job.describe && JSON.stringify(job.describe()) !== JSON.stringify(job.change)) return false;
		if (job.guard && !job.guard()) return false;
		return (
			!this.#disposed &&
			this.#dock.structureRevision === job.revision &&
			structureKey(this.#dock.layout) === job.structure
		);
	}

	#applyIfCurrent(job: Job): void {
		if (job.done) return;
		if (!this.#isCurrent(job)) return job.resolve('stale');
		job.apply();
		job.resolve('applied');
	}

	#scheduleRetry(): void {
		if (this.#disposed || !this.#held || this.#retryTimer !== null) return;
		// Next task: after the IME's final `input` and the focus move settle.
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = null;
			this.resumeDeferred();
		}, 0);
	}

	#onCompositionStart = (event: Event): void => {
		this.#composingIn = event.target instanceof Element ? event.target : null;
	};

	#onCompositionEnd = (): void => {
		this.#composingIn = null;
		this.#scheduleRetry();
	};

	#onFocusOut = (): void => {
		this.#scheduleRetry();
	};
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { then?: unknown }).then === 'function'
	);
}

const LIFECYCLE_KEY = Symbol('banto-dock-lifecycle');

/** Called once by `DockHost` during initialization. */
export function setPanelLifecycle(lifecycle: PanelLifecycle): void {
	setContext(LIFECYCLE_KEY, lifecycle);
}

/** Must be called during a descendant component's initialization. */
export function getPanelLifecycle(): PanelLifecycle {
	const lifecycle = getContext<PanelLifecycle | undefined>(LIFECYCLE_KEY);
	if (!lifecycle) {
		throw new Error(
			'getPanelLifecycle() called outside a DockHost tree - no PanelLifecycle in context.'
		);
	}
	return lifecycle;
}
