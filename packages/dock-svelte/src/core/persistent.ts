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
 * - **Focus.** Moving a node drops the focus inside it. `snapshot()` (called by
 *   `DockHost` in an `$effect.pre`, before the tree's blocks update) records the
 *   focused element inside each content; after the moves of that update (a
 *   microtask, the receptacle is in the document by then) the focus goes back
 *   to it - only when the focus is nowhere (`<body>`) or still on it, so a focus
 *   the host or the app put elsewhere meanwhile (a band tab, a frame after a
 *   drop) is not taken away. A content parked in the stash (its pane was hidden
 *   or closed) does not keep the focus: it is blurred (the focus goes to
 *   `<body>`, as when a pane that is not persistent is unmounted).
 * - **Scroll.** Every element inside a content that scrolls is recorded on its
 *   `scroll` event (capture on the content), and the recorded offsets are put
 *   back after each move into a receptacle (an element that is not rendered -
 *   the stash is `hidden` - has no scroll offset of its own). The standard
 *   frame around a receptacle (`.body` of the tree, a window, an auto-hide
 *   flyout; `overflow: auto`) is outside the content and is re-created by a
 *   move: its offset is recorded on its own `scroll` event, per pane, and put
 *   back onto the `.body` around the receptacle the content moved into.
 * - **`iframe`.** A moved `iframe` loads its document again (browsers do that on
 *   every re-insertion); nothing here can keep it. README "Persistent panes".
 *
 * Two receptacles of the same pane may exist for a moment (the new one mounted
 * before the old one is torn down): the newest mounted one holds the content,
 * and when it goes the content moves to the newest one left, else to the stash.
 */
import type { Attachment } from 'svelte/attachments';

interface Entry {
	/** The element the stash renders the pane's snippet into (`null` until it is mounted). */
	content: HTMLElement | null;
	/** Its place in the stash. */
	home: HTMLElement | null;
	/** Receptacles mounted now, in mount order (the last one holds the content). */
	slots: HTMLElement[];
	/** Last seen scroll offsets of the scrolled elements inside the content. */
	scroll: Map<Element, { top: number; left: number }>;
	/** Last seen scroll offset of the standard `.body` frame around a receptacle. */
	body: { top: number; left: number } | null;
	/** The focused element inside the content right before a structure change. */
	focus: HTMLElement | null;
	onScroll: (event: Event) => void;
}

export class PersistentContents {
	#entries = new Map<string, Entry>();
	/** Panes whose content was moved since the last `#settle`. */
	#moved = new Set<string>();
	#queued = false;
	#disposed = false;

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
				// The stash item is gone (the pane closed or left the layout): so is the content,
				// wherever it was moved to.
				el.remove();
				if (entry.content === el) {
					entry.content = null;
					entry.home = null;
					entry.scroll.clear();
					entry.body = null;
					entry.focus = null;
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
			const onFrameScroll = () => {
				if (!frame || entry.slots.at(-1) !== el) return;
				entry.body =
					frame.scrollTop === 0 && frame.scrollLeft === 0
						? null
						: { top: frame.scrollTop, left: frame.scrollLeft };
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

	/** Record where the focus is inside each content (before a structure change; module doc). */
	snapshot(): void {
		if (this.#disposed) return;
		const active = document.activeElement;
		let any = false;
		for (const entry of this.#entries.values()) {
			const el = entry.content;
			if (el && active instanceof HTMLElement && active !== el && el.contains(active)) {
				entry.focus = active;
				any = true;
			}
		}
		if (any) this.#queue();
	}

	/** The host unmounted: nothing is restored any more. */
	dispose(): void {
		this.#disposed = true;
	}

	#entry(panelId: string): Entry {
		let entry = this.#entries.get(panelId);
		if (!entry) {
			const scroll = new Map<Element, { top: number; left: number }>();
			entry = {
				content: null,
				home: null,
				slots: [],
				scroll,
				body: null,
				focus: null,
				onScroll: (event) => {
					const target = event.target;
					if (!(target instanceof Element)) return;
					if (target.scrollTop === 0 && target.scrollLeft === 0) scroll.delete(target);
					else scroll.set(target, { top: target.scrollTop, left: target.scrollLeft });
				}
			};
			this.#entries.set(panelId, entry);
		}
		return entry;
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
		const target = entry.slots.at(-1) ?? entry.home;
		if (!target || el.parentElement === target) return;
		target.appendChild(el);
		this.#moved.add(panelId);
		this.#queue();
	}

	#queue(): void {
		if (this.#queued) return;
		this.#queued = true;
		// After the update that moved it: the receptacle is in the document by then.
		queueMicrotask(() => this.#settle());
	}

	#settle(): void {
		this.#queued = false;
		const moved = new Set(this.#moved);
		this.#moved.clear();
		for (const [panelId, entry] of this.#entries) {
			const focus = entry.focus;
			entry.focus = null;
			const el = entry.content;
			if (this.#disposed || !el) continue;
			const shown = el.parentElement !== entry.home && el.isConnected;
			const active = document.activeElement;
			if (!shown) {
				// Parked in the hidden stash: the focus does not stay in it.
				if (active instanceof HTMLElement && el.contains(active)) active.blur();
				continue;
			}
			if (!moved.has(panelId)) continue;
			const frame = entry.slots.at(-1)?.closest<HTMLElement>('.body');
			if (frame && entry.body) {
				frame.scrollTop = entry.body.top;
				frame.scrollLeft = entry.body.left;
			}
			for (const [target, offset] of entry.scroll) {
				if (!el.contains(target)) {
					entry.scroll.delete(target);
					continue;
				}
				target.scrollTop = offset.top;
				target.scrollLeft = offset.left;
			}
			const lost = active === null || active === document.body || active === focus;
			if (focus && lost && focus.isConnected && el.contains(focus))
				focus.focus({ preventScroll: true });
		}
	}
}
