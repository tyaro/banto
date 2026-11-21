/**
 * Persistent panes of one `DockHost` (#663 ④, three-pane-dock-plan §4.2 C):
 * the content of a pane the consumer marks `persistent` is drawn ONCE, outside
 * the docked tree (a hidden stash in the host), and the element holding it is
 * moved with `appendChild` into whichever empty RECEPTACLE the tree draws for
 * that pane (a docked pane, a tab, a floating window, an auto-hide slide-out).
 * A receptacle that goes away gives the element back to the stash. So the
 * content keeps its DOM and its Svelte component state through every change of
 * the tree - undock / dock, a drop on an outer edge, a split made around it,
 * auto-hide, a tab switch - and is mounted once.
 *
 * What a DOM move loses, and how it is put back:
 *
 * - **Focus.** Moving a node with `appendChild` drops the focus inside it, and
 *   so does Svelte removing the old receptacle (it takes the receptacle's DOM
 *   out of the document BEFORE the attachment's teardown can move the content
 *   away; #763). `snapshot()` (called by `DockHost` in an `$effect.pre`, before
 *   the tree's blocks update) records the focused element inside each content,
 *   and:
 *   - where `Element.moveBefore()` exists (Chromium 133+; it moves a node and
 *     keeps its focus, selection and `iframe` documents), the content that
 *     holds the focus is moved right there into the TRANSIT element of the host
 *     (rendered, so the focus stays; empty and invisible otherwise), out of the
 *     receptacle Svelte may be about to remove. The receptacle mounted by that
 *     update takes it from there (`moveBefore` again), and `#settle` puts a
 *     content nobody took back where it belongs. No `blur` / `focusout` fires.
 *     Only for an update that may re-create a receptacle: `DockHost` passes
 *     `layoutStructureKey` (which pane is where, without positions and sizes),
 *     and an update with the same key as the last one - another window moved or
 *     resized, a divider dragged - moves nothing (even `moveBefore` re-connects
 *     a custom element that has no `connectedMoveCallback`).
 *   - elsewhere the focus is lost (`blur` / `focusout` fire) and, after the
 *     moves of that update (a microtask, the receptacle is in the document by
 *     then), it goes back to the recorded element - only when the focus is
 *     nowhere (`<body>`) or still on it, so a focus the host or the app put
 *     elsewhere meanwhile (a band tab, a frame after a drop) is not taken away.
 *
 *   From `snapshot()` to the end of `#settle` the content that held the focus
 *   carries `data-dock-rearranging` (`isDockRearranging(node)` reads it), so an
 *   app can tell such a `blur` from the user leaving the field.
 *   A content parked in the stash (its pane was hidden or closed) does not keep
 *   the focus: it is blurred (the focus goes to `<body>`, as when a pane that
 *   is not persistent is unmounted).
 * - **Scroll (#768).** An element that is not rendered has no scroll offset: a
 *   move through the stash (`hidden`), a re-created receptacle and a tab put in
 *   the background (`.tab-content[hidden]`) all lose it. Two things scroll:
 *   - the standard FRAME around a receptacle (`.body` of the tree, a window, an
 *     auto-hide flyout; `overflow: auto`). It is outside the content, is
 *     re-created by a move, and is SHARED by the tabs of a group (one `.body`,
 *     the tab on top scrolls it). Its offset is kept per pane;
 *   - elements inside the content that scroll by themselves (not inside a
 *     shadow tree: neither the search below nor their `scroll` event gets there).
 *
 *   `snapshot()` reads both for every pane that is on screen, right before an
 *   update that may re-create or hide a receptacle: the frame's offset, and
 *   every element of the content that is scrolled (a walk over the content -
 *   one property read per element, only for such an update - so an offset set
 *   in the same task, whose `scroll` event did not fire yet, counts as well).
 *   `arranged()` (called by `DockHost` in an `$effect`, right after the blocks
 *   of that update ran, in the same flush - before the code of the app that
 *   applied the update goes on) writes them back. What is written is decided
 *   by what the update did to the pane, never by comparing offsets with what
 *   somebody else may have set meanwhile:
 *   - a pane that CAME on screen in a receptacle it was not shown in before
 *     the update (moved, a tab brought to the top, a body expanded, shown
 *     again) gets its record. Without a record of the frame (never read on
 *     screen: "nothing recorded" is not "recorded at the origin") the frame
 *     goes to the origin: a shared frame shows the offset of the tab that was
 *     on top, clamped or not;
 *   - a pane the update left shown in the same receptacle is written only
 *     where an offset `snapshot` just read non-zero reads the origin now (the
 *     update lost it: Svelte re-inserts a keyed receptacle it re-orders);
 *   - a pane that is not on screen keeps what was recorded while it last was.
 *
 *   So nothing is written after `arranged()`: an offset the app sets once its
 *   update is applied stays - a start offset for a pane shown for the first
 *   time, the origin for a pane that did not move - and every later `snapshot`
 *   of the same task reads offsets that are the panes' own (a tab switched
 *   away and back at once included).
 *   The one exception is a content that is moved when `arranged()` cannot see
 *   it on screen (it waits in the transit element; a receptacle or a content
 *   mounted by something else than a `DockHost` update): it is OWED its record
 *   until `#settle` (a microtask after the move) writes it - a frame only with
 *   a record, as the app may have set a start offset by then - and `snapshot`
 *   does not read it meanwhile.
 *
 *   Between two snapshots the `scroll` events keep the record current (capture
 *   on the content; the shared frame's belong to the pane on top only), for a
 *   move made by an update that `snapshot` took for one that keeps every
 *   receptacle. The offsets live here, per pane id, for as long as the content
 *   does - never in the layout (nothing is saved).
 * - **`iframe`.** An `iframe` moved with `appendChild` loads its document again
 *   (browsers do that on every re-insertion); only a move made with
 *   `moveBefore` keeps it. That is not every move where `moveBefore` exists:
 *   only the content that holds the focus is taken to the transit element
 *   beforehand, so another content whose receptacle Svelte removed is out of
 *   the document when it is placed and falls back to `appendChild`.
 *   README "Persistent panes".
 *
 * Two receptacles of the same pane may exist for a moment (the new one mounted
 * before the old one is torn down): the newest mounted one holds the content,
 * and when it goes the content moves to the newest one left, else to the stash.
 */
import type { Attachment } from 'svelte/attachments';
import type { DockLayout, DockNode } from '../types';

/** On the content that held the focus, from `snapshot()` to the end of `#settle` (module doc). */
const REARRANGING = 'data-dock-rearranging';

/**
 * Whether `node` is inside a `persistent` pane the dock is re-arranging right now (#763).
 * Where `Element.moveBefore()` is missing, the focused field of such a pane gets a `blur` /
 * `focusout` (and then `focus` / `focusin`) although the user did not leave it: a handler that
 * commits on blur can skip those with this. A node inside a shadow tree is looked up through
 * its hosts (`closest` stops at a shadow root). `null` / `undefined` are `false`, also where
 * there is no DOM (SSR).
 */
export function isDockRearranging(node: Node | null | undefined): boolean {
	let current: Node | null = node ?? null;
	while (current) {
		// `nodeType`, not `instanceof Element`: no DOM globals needed, and nodes of another realm work.
		const el = current.nodeType === 1 ? (current as Element) : current.parentElement;
		if (el?.closest(`[${REARRANGING}]`)) return true;
		// A shadow root has a `host`; a document (or a detached tree's top) ends the walk.
		const root: Node = (el ?? current).getRootNode();
		current = (root as Partial<ShadowRoot>).host ?? null;
	}
	return false;
}

/**
 * What decides which receptacles the tree draws, as a string: which pane is in which tab group
 * / split / window / auto-hide band, in which order, and the flags that mount or hide a body
 * (`open`, `collapsed`, the active tab ...). Positions and sizes (a window's `x` / `y` /
 * `width` / `height`, a split's `sizes`, an auto-hide `size`) and titles / icons are left out:
 * an update that changes only those re-creates no receptacle, so `snapshot` moves nothing for
 * it (module doc, "Focus").
 */
export function layoutStructureKey(layout: DockLayout): string {
	const parts: (string | number)[] = [];
	const flags = (...on: (boolean | undefined)[]) => on.map((f) => (f ? 1 : 0)).join('');
	const visit = (node: DockNode): void => {
		if (node.type === 'panel') {
			parts.push('p', node.id, flags(node.collapsed));
		} else if (node.type === 'tabs') {
			parts.push('t', node.id, node.activeIndex, flags(node.collapsed), node.children.length);
			node.children.forEach(visit);
		} else {
			parts.push('s', node.id, node.direction, node.children.length);
			node.children.forEach(visit);
		}
	};
	for (const w of layout.floating)
		parts.push('f', w.id, flags(w.open, w.collapsed, w.locked, w.pinned));
	parts.push('d');
	if (layout.docked) visit(layout.docked);
	for (const entry of layout.autoHidden ?? []) {
		parts.push('a', entry.edge);
		visit(entry.node);
	}
	// Ids are free text: a separator none of them holds in practice.
	return parts.join('\u0000');
}

/** Is `el` rendered as far as the dock decides it (a background tab, a collapsed body and the stash are `hidden`)? */
function isOnScreen(el: Element): boolean {
	return el.isConnected && el.closest('[hidden]') === null;
}

interface Offset {
	top: number;
	left: number;
}

const ORIGIN: Offset = { top: 0, left: 0 };

/** The scroll offset of `el`, the origin included (a record that says "at the top"). */
function readOffset(el: Element): Offset {
	return { top: el.scrollTop, left: el.scrollLeft };
}

/** The scroll offset of `el`; `null` at the origin (an element inside a content that is not scrolled is not kept). */
function offsetOf(el: Element): Offset | null {
	const offset = readOffset(el);
	return offset.top === 0 && offset.left === 0 ? null : offset;
}

/** Writes only what differs: assigning the same offset would still cancel a scroll in progress. */
function scrollTo(el: Element, offset: Offset): void {
	if (el.scrollTop !== offset.top) el.scrollTop = offset.top;
	if (el.scrollLeft !== offset.left) el.scrollLeft = offset.left;
}

type MoveBefore = (node: Node, child: Node | null) => void;

function moveBeforeOf(target: HTMLElement): MoveBefore | null {
	const fn = (target as unknown as { moveBefore?: unknown }).moveBefore;
	return typeof fn === 'function' ? (fn as MoveBefore) : null;
}

/** Move `el` to the end of `target`, with `moveBefore` (state kept) when it can be used. */
function moveInto(target: HTMLElement, el: HTMLElement): void {
	const moveBefore = moveBeforeOf(target);
	if (moveBefore && target.isConnected && el.isConnected) {
		try {
			moveBefore.call(target, el, null);
			return;
		} catch {
			// Not movable that way (another document / shadow root): the plain move below.
		}
	}
	target.appendChild(el);
}

interface Entry {
	/** The element the stash renders the pane's snippet into (`null` until it is mounted). */
	content: HTMLElement | null;
	/** Its place in the stash. */
	home: HTMLElement | null;
	/** Receptacles mounted now, in mount order (the last one holds the content). */
	slots: HTMLElement[];
	/** Last seen scroll offsets of the scrolled elements inside the content. */
	scroll: Map<Element, Offset>;
	/**
	 * Scroll offset of the standard `.body` frame while this pane was last on screen, the origin
	 * included. `null` = nothing recorded yet (never read on screen): nothing to write back.
	 */
	body: Offset | null;
	/**
	 * The receptacle this pane was shown in (`null` = not on screen) at the re-arranging `snapshot`
	 * that `arranged` has not answered yet.
	 */
	before: HTMLElement | null;
	/** That `snapshot` read the pane's offsets there (it did not for a pane that is `owed`). */
	read: boolean;
	/** The content was moved and its record is not written back yet (module doc, "Scroll"). */
	owed: boolean;
	/** The focused element inside the content right before a structure change. */
	focus: HTMLElement | null;
	/** The content waits in the transit element for the receptacle of this update (module doc). */
	transit: boolean;
	onScroll: (event: Event) => void;
}

export class PersistentContents {
	#entries = new Map<string, Entry>();
	/** Panes whose content was moved since the last `#settle`. */
	#moved = new Set<string>();
	/** A `snapshot` for an update that may re-create or hide a receptacle waits for its `arranged`. */
	#arranging = false;
	#queued = false;
	#disposed = false;
	#transit: HTMLElement | null = null;
	/** The `structure` of the last `snapshot` (`undefined` = none yet, or one given without). */
	#structure: string | undefined;

	/** `{@attach}` for the host's transit element (module doc, "Focus"). */
	transit: Attachment<HTMLElement> = (el) => {
		this.#transit = el;
		return () => {
			if (this.#transit === el) this.#transit = null;
		};
	};

	/** `{@attach}` for the element in the stash that holds the pane's rendered snippet. */
	content(panelId: string): Attachment<HTMLElement> {
		return (el) => {
			const entry = this.#entry(panelId);
			entry.content = el;
			entry.home = el.parentElement;
			el.addEventListener('scroll', entry.onScroll, { capture: true });
			this.#place(panelId);
			return () => {
				el.removeEventListener('scroll', entry.onScroll, { capture: true });
				// `#settle` no longer reaches it once `entry.content` is cleared below.
				el.removeAttribute(REARRANGING);
				// The stash item is gone (the pane closed or left the layout): so is the content,
				// wherever it was moved to.
				el.remove();
				if (entry.content === el) {
					entry.content = null;
					entry.home = null;
					entry.scroll.clear();
					entry.body = null;
					entry.before = null;
					entry.read = false;
					entry.owed = false;
					entry.focus = null;
					entry.transit = false;
				}
				this.#forgetIfUnused(panelId);
			};
		};
	}

	/** `{@attach}` for an empty receptacle the tree draws for the pane. */
	slot(panelId: string): Attachment<HTMLElement> {
		return (el) => {
			const entry = this.#entry(panelId);
			entry.slots.push(el);
			// The frame scrolls itself (its `scroll` event does not bubble to the receptacle).
			const frame = el.closest<HTMLElement>('.body');
			// Only while this receptacle shows the content: the tabs of a group share one frame, and
			// the offset of the tab on top is not the offset of a pane in the background (#768).
			const onFrameScroll = () => {
				if (frame && this.#shownIn(entry) === el) entry.body = readOffset(frame);
			};
			frame?.addEventListener('scroll', onFrameScroll);
			this.#place(panelId);
			return () => {
				frame?.removeEventListener('scroll', onFrameScroll);
				const i = entry.slots.indexOf(el);
				if (i !== -1) entry.slots.splice(i, 1);
				this.#place(panelId);
				this.#forgetIfUnused(panelId);
			};
		};
	}

	/**
	 * Record where the focus is inside each content (before the tree updates; module doc).
	 * `structure` is what decides the receptacles (`layoutStructureKey` plus whatever else the
	 * caller's tree depends on): with the same value as the last call no receptacle is
	 * re-created, so the content is left where it is and not marked - only the focus is
	 * recorded, for a move this update makes after all. Without it every call may re-arrange.
	 * Before a re-arrangement the scroll offsets of every pane on screen are read as well, and
	 * `arranged` puts them back after it (module doc, "Scroll").
	 */
	snapshot(structure?: string): void {
		if (this.#disposed) return;
		const kept = structure !== undefined && structure === this.#structure;
		this.#structure = structure;
		const active = document.activeElement;
		let any = false;
		if (!kept && this.#entries.size > 0) {
			// Before the content that holds the focus leaves its receptacle (below).
			for (const entry of this.#entries.values()) {
				entry.before = this.#shownIn(entry);
				// Not a pane that is owed its record: it shows no offset of its own yet.
				entry.read = entry.before !== null && !entry.owed;
				if (entry.read) this.#recordScroll(entry);
			}
			this.#arranging = true;
		}
		for (const entry of this.#entries.values()) {
			const el = entry.content;
			if (el && active instanceof HTMLElement && active !== el && el.contains(active)) {
				entry.focus = active;
				any = true;
				if (kept) continue;
				el.setAttribute(REARRANGING, '');
				this.#toTransit(entry, el);
			}
		}
		if (any) this.#queue();
	}

	/**
	 * Right after the update the last `snapshot` was taken for (its blocks ran, in the same
	 * flush): write the scroll offsets back, by what the update did to each pane (module doc,
	 * "Scroll"). Nothing to do after a `snapshot` that kept every receptacle.
	 */
	arranged(): void {
		if (this.#disposed || !this.#arranging) return;
		this.#arranging = false;
		for (const entry of this.#entries.values()) {
			const { before, read } = entry;
			entry.before = null;
			entry.read = false;
			const slot = this.#shownIn(entry);
			// Not on screen (or not placed yet: `#settle` sees to a content that is owed).
			if (!slot) continue;
			if (slot !== before) this.#restoreScroll(entry, 'came');
			else if (entry.owed) this.#restoreScroll(entry, 'moved');
			else if (read) this.#restoreScroll(entry, 'stayed');
			entry.owed = false;
		}
	}

	/** The host unmounted: nothing is restored any more. */
	dispose(): void {
		this.#disposed = true;
	}

	#entry(panelId: string): Entry {
		let entry = this.#entries.get(panelId);
		if (!entry) {
			const scroll = new Map<Element, Offset>();
			entry = {
				content: null,
				home: null,
				slots: [],
				scroll,
				body: null,
				before: null,
				read: false,
				owed: false,
				focus: null,
				transit: false,
				onScroll: (event) => {
					const target = event.target;
					// Not an element that just stopped being rendered (its offset reads 0 then).
					if (!(target instanceof Element) || !isOnScreen(target)) return;
					const offset = offsetOf(target);
					if (offset) scroll.set(target, offset);
					else scroll.delete(target);
				}
			};
			this.#entries.set(panelId, entry);
		}
		return entry;
	}

	/**
	 * Take the content that holds the focus out of its receptacle before Svelte may remove that
	 * receptacle (module doc, "Focus"). Only where `moveBefore` keeps the focus through the move.
	 */
	#toTransit(entry: Entry, el: HTMLElement): void {
		const transit = this.#transit;
		const parent = el.parentElement;
		if (entry.transit || !transit || !parent || parent === entry.home) return;
		if (!transit.isConnected || !el.isConnected) return;
		const moveBefore = moveBeforeOf(transit);
		if (!moveBefore) return;
		try {
			moveBefore.call(transit, el, null);
			entry.transit = true;
		} catch {
			// Left where it is: the `appendChild` path (the focus is put back in `#settle`).
		}
	}

	/** The receptacle that holds the content and is on screen, if any (not a background tab, not the stash). */
	#shownIn(entry: Entry): HTMLElement | null {
		const slot = entry.slots.at(-1);
		if (!slot || entry.content?.parentElement !== slot || !isOnScreen(slot)) return null;
		return slot;
	}

	/** Read the offsets of a pane on screen (module doc, "Scroll"); a pane that is not keeps its record. */
	#recordScroll(entry: Entry): void {
		const el = entry.content;
		const slot = this.#shownIn(entry);
		if (!el || !slot) return;
		const frame = slot.closest<HTMLElement>('.body');
		if (frame) entry.body = readOffset(frame);
		entry.scroll.clear();
		for (const target of el.querySelectorAll('*')) {
			const offset = offsetOf(target);
			if (offset) entry.scroll.set(target, offset);
		}
	}

	/**
	 * Put the recorded offsets back onto a pane on screen (module doc, "Scroll"):
	 * - `'came'`: the update just applied showed it in this receptacle. Everything, and a frame
	 *   without a record goes to the origin (what it shows is not this pane's);
	 * - `'moved'`: its content was moved, by an update that may be over for a while. Everything
	 *   that has a record;
	 * - `'stayed'`: the update just applied left it shown where it was. Only a record whose
	 *   element reads the origin now (the update lost it).
	 */
	#restoreScroll(entry: Entry, how: 'came' | 'moved' | 'stayed'): void {
		const el = entry.content;
		const slot = this.#shownIn(entry);
		if (!el || !slot) return;
		const write = (target: Element, offset: Offset) => {
			if (how !== 'stayed' || offsetOf(target) === null) scrollTo(target, offset);
		};
		const frame = slot.closest<HTMLElement>('.body');
		const body = entry.body ?? (how === 'came' ? ORIGIN : null);
		if (frame && body) write(frame, body);
		for (const [target, offset] of entry.scroll) {
			if (!el.contains(target)) entry.scroll.delete(target);
			else write(target, offset);
		}
	}

	#forgetIfUnused(panelId: string): void {
		const entry = this.#entries.get(panelId);
		if (entry && !entry.content && entry.slots.length === 0) this.#entries.delete(panelId);
	}

	/** Put the content where it belongs now: the newest receptacle, else the stash. */
	#place(panelId: string): void {
		const entry = this.#entries.get(panelId);
		const el = entry?.content;
		if (!entry || !el) return;
		// In transit with no receptacle yet: it waits there (rendered, the focus stays) for the one
		// this update mounts; `#settle` parks it in the stash if none came.
		const target = entry.slots.at(-1) ?? (entry.transit ? null : entry.home);
		if (!target || el.parentElement === target) return;
		entry.transit = false;
		moveInto(target, el);
		this.#moved.add(panelId);
		entry.owed = true;
		this.#queue();
	}

	#queue(): void {
		if (this.#queued) return;
		this.#queued = true;
		// After the update that moved it: the receptacle is in the document by then.
		queueMicrotask(() => this.#settle());
	}

	#settle(): void {
		// A content still in transit: back into its receptacle (nothing replaced it), else the stash.
		for (const [panelId, entry] of this.#entries) {
			if (!entry.transit) continue;
			entry.transit = false;
			this.#place(panelId);
		}
		this.#queued = false;
		const moved = new Set(this.#moved);
		this.#moved.clear();
		for (const [panelId, entry] of this.#entries) {
			const focus = entry.focus;
			entry.focus = null;
			// A content that is not on screen now gets its record when an update shows it.
			const owed = entry.owed;
			entry.owed = false;
			const el = entry.content;
			if (this.#disposed || !el) continue;
			const shown = el.parentElement !== entry.home && el.isConnected;
			const active = document.activeElement;
			if (!shown) {
				// Parked in the hidden stash: the focus does not stay in it.
				if (active instanceof HTMLElement && el.contains(active)) active.blur();
				continue;
			}
			// Moved where `arranged` did not see it on screen (#768).
			if (owed) this.#restoreScroll(entry, 'moved');
			if (!moved.has(panelId)) continue;
			const lost = active === null || active === document.body || active === focus;
			if (focus && lost && focus.isConnected && el.contains(focus))
				focus.focus({ preventScroll: true });
		}
		// After the focus is back: its `focus` / `focusin` are still inside the mark.
		for (const entry of this.#entries.values()) entry.content?.removeAttribute(REARRANGING);
	}
}
