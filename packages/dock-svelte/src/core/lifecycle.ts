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
 * - **Own state first, re-check after.** The structure of the layout is
 *   recorded before the hook is called. After it returns (or its promise
 *   settles) the change is applied only if the host is still mounted and the
 *   structure is unchanged (`structureKey`: docked tree shape, active tabs,
 *   floating ids and their open flags - geometry, split sizes and z-order do
 *   not count). So a hook that re-enters (makes another structure change,
 *   unmounts the host) or a layout that changed while an async confirm was
 *   open never gets an old decision applied. This is narrower than the request
 *   owner of #436 (no busy flag, no resources, no "latest wins"): each change
 *   is checked against the structure it was asked about.
 * - **Same change twice** (a double click on ✕) while the first is pending
 *   returns the pending request instead of asking again.
 * - **Apply by id.** The `apply` callbacks look ids up when they run and are
 *   no-ops when the id is gone.
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
 * the assumption that the conversion could be restored. `DockHost` also
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
import { findNode } from './tree';
import type { DockState } from '../state.svelte';
import type { DockLayout, DockNode } from '../types';

/**
 * A structure change the dock UI is about to make (shared-primitives-upstream-
 * plan §3.5). `remount` says what happens to the content: `true` = it is
 * unmounted now and mounted again later (capture a draft so the next mount can
 * restore it), `false` = its DOM is kept (`hidden` + `inert`). For
 * `tab-switch` it describes the `from` pane. `close` discards the content.
 */
export type DockPanelChange =
	| { kind: 'dock' | 'undock' | 'move-docked'; panelId: string; remount: true }
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
	isStructureChangeDeferred?: () => boolean;
}

/**
 * The parts of the layout a structure change depends on: the docked tree's
 * shape and active tabs, and which floating windows exist and are open.
 * Geometry, split sizes and z-order are left out (they change on focus /
 * move / resize and never invalidate a structure decision).
 */
export function structureKey(layout: DockLayout): string {
	const node = (n: DockNode): unknown => {
		if (n.type === 'panel') return n.id;
		if (n.type === 'tabs') return [n.id, n.activeIndex, n.children.map((c) => c.id)];
		return [n.id, n.direction, n.children.map(node)];
	};
	const floating = layout.floating
		.map((w) => `${w.id}:${w.open ? 1 : 0}`)
		.sort()
		.join(',');
	return JSON.stringify([floating, layout.docked ? node(layout.docked) : null]);
}

interface Held {
	change: DockPanelChange;
	apply: () => void;
	resolve: (outcome: DockPanelChangeOutcome) => void;
}

const CAPTURE: AddEventListenerOptions = { capture: true };

export class PanelLifecycle {
	#dock: DockState;
	#getOptions: () => PanelLifecycleOptions;
	#disposed = false;
	#held: Held | null = null;
	#retryTimer: ReturnType<typeof setTimeout> | null = null;
	#pending = new Map<string, Promise<DockPanelChangeOutcome>>();
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

	/** Is this pane's content kept mounted while it is not shown (the consumer's `keepMounted`)? */
	keepMounted(panelId: string): boolean {
		return this.#getOptions().keepMounted?.(panelId) === true;
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
	request(change: DockPanelChange, apply: () => void): Promise<DockPanelChangeOutcome> {
		if (this.#disposed) return Promise.resolve('disposed');
		if (this.isDeferred()) {
			this.#held?.resolve('superseded');
			return new Promise((resolve) => {
				this.#held = { change, apply, resolve };
			});
		}
		const id = JSON.stringify(change);
		const pending = this.#pending.get(id);
		if (pending) return pending;
		return this.#ask(id, change, apply);
	}

	/** Retry the request held for IME composition now (when the consumer's predicate turned false). */
	resumeDeferred(): void {
		if (this.#disposed || !this.#held || this.isDeferred()) return;
		const held = this.#held;
		this.#held = null;
		void this.request(held.change, held.apply).then(held.resolve);
	}

	// --- the hide / close actions (module doc, D4-a) ---

	/** Take the pane off the screen, keeping a `keepMounted` pane's content (module doc). Already hidden = nothing to ask. */
	hide(panelId: string): Promise<DockPanelChangeOutcome> {
		const where = this.#whereIs(panelId);
		if (where === null) return Promise.resolve('stale');
		if (where === 'hidden') return Promise.resolve('applied');
		const remount = this.#isDocked(panelId) || !this.keepMounted(panelId);
		return this.request({ kind: 'hide', panelId, remount }, () => this.#takeOffScreen(panelId));
	}

	/** Take the pane off the screen and discard its content (module doc). A hidden pane whose content is not kept = nothing to ask. */
	close(panelId: string): Promise<DockPanelChangeOutcome> {
		const where = this.#whereIs(panelId);
		if (where === null) return Promise.resolve('stale');
		if (where === 'hidden' && !this.isRetained(panelId)) return Promise.resolve('applied');
		return this.request({ kind: 'close', panelId }, () => {
			// Discard first, so the window is not drawn hidden for one update.
			this.discarded.add(panelId);
			this.#takeOffScreen(panelId);
		});
	}

	/** The ✕ button: `hide` for a `keepMounted` pane, `close` otherwise. */
	closeButton(panelId: string): Promise<DockPanelChangeOutcome> {
		return this.keepMounted(panelId) ? this.hide(panelId) : this.close(panelId);
	}

	/** Switch the docked tab group `groupId` to the tab `to` (by id; no-op when it is already active or gone). */
	switchTab(groupId: string, to: string, after?: () => void): Promise<DockPanelChangeOutcome> {
		const group = findNode(this.#dock.layout.docked, groupId);
		if (!group || group.type !== 'tabs') return Promise.resolve('stale');
		const from = group.children[group.activeIndex]?.id;
		if (from === undefined || from === to) return Promise.resolve('applied');
		const change: DockPanelChange = {
			kind: 'tab-switch',
			groupId,
			from,
			to,
			remount: !this.keepMounted(from)
		};
		return this.request(change, () => {
			const now = findNode(this.#dock.layout.docked, groupId);
			if (!now || now.type !== 'tabs') return;
			const index = now.children.findIndex((c) => c.id === to);
			if (index === -1) return;
			this.#dock.setActiveTab(groupId, index);
			after?.();
		});
	}

	/** `DockHost` unmounts: nothing held or pending is applied any more. */
	dispose(): void {
		this.#disposed = true;
		if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
		this.#retryTimer = null;
		const held = this.#held;
		this.#held = null;
		held?.resolve('disposed');
	}

	#whereIs(panelId: string): 'docked' | 'open' | 'hidden' | null {
		if (this.#isDocked(panelId)) return 'docked';
		const win = this.#dock.layout.floating.find((w) => w.id === panelId);
		if (!win) return null;
		return win.open ? 'open' : 'hidden';
	}

	#isDocked(panelId: string): boolean {
		return findNode(this.#dock.layout.docked, panelId)?.type === 'panel';
	}

	/** A docked pane has no hidden state of its own: it becomes a closed floating window (geometry kept for the next open). */
	#takeOffScreen(panelId: string): void {
		if (this.#isDocked(panelId)) this.#dock.undockPanel(panelId);
		this.#dock.close(panelId);
	}

	#ask(id: string, change: DockPanelChange, apply: () => void): Promise<DockPanelChangeOutcome> {
		// Own state first: the structure the hook is asked about.
		const before = structureKey(this.#dock.layout);
		const hook = this.#getOptions().beforePanelChange;
		const settle = (verdict: unknown): DockPanelChangeOutcome => {
			if (this.#disposed) return 'disposed';
			if (verdict !== true) return 'refused';
			if (structureKey(this.#dock.layout) !== before) return 'stale';
			apply();
			return 'applied';
		};
		let verdict: unknown;
		try {
			verdict = hook ? hook(change) : true;
		} catch {
			return Promise.resolve('refused');
		}
		if (!isThenable(verdict)) return Promise.resolve(settle(verdict));
		const pending = Promise.resolve(verdict).then(settle, () => 'refused' as const);
		this.#pending.set(id, pending);
		void pending.finally(() => {
			if (this.#pending.get(id) === pending) this.#pending.delete(id);
		});
		return pending;
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
