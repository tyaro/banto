// @vitest-environment jsdom
/**
 * @banto/ui `layering.ts` promise 8 (#1055, ADR-0038): the modal backdrop
 * behind Modal / Drawer / CommandPalette / ThreePaneLayout's modal drawer -
 * `trackModalLayer` makes everything outside the topmost tracked layer
 * `inert`. Pure DOM logic, so the page is built by hand: what is made inert
 * (and what is kept: the path to the layer, its scrim, exempt elements, live
 * regions, an untracked layer above), layers stacked and released in any
 * order, whose `inert` is whose (already inert, written by the app while a
 * layer is open), and the DOM changing under an open layer.
 *
 * jsdom lays nothing out, so `getClientRects()` is stubbed as in
 * layering.test.ts. The backdrop follows DOM changes from a MutationObserver:
 * `settle()` waits for it.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MODAL_EXEMPT_ATTR, trackModalLayer } from '../src/index';

beforeAll(() => {
	Element.prototype.getClientRects = function (this: Element) {
		if (!this.isConnected) return [] as unknown as DOMRectList;
		const hidden = (node: Element | null): boolean =>
			node !== null && (getComputedStyle(node).display === 'none' || hidden(node.parentElement));
		return (hidden(this) ? [] : [{}]) as unknown as DOMRectList;
	};
});

const releases: (() => void)[] = [];

/** `trackModalLayer`, released after the test whatever happens (the state is per document). */
function track(...args: Parameters<typeof trackModalLayer>): () => void {
	const release = trackModalLayer(...args);
	releases.push(release);
	return release;
}

afterEach(() => {
	for (const release of releases.splice(0)) release();
	document.body.replaceChildren();
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	parent: Element = document.body,
	attrs: Record<string, string> = {}
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
	parent.append(node);
	return node;
}

/** A fixed overlay at `z` holding a `role="dialog"` panel (the Modal / Drawer / palette shape). */
function layer(z: number | null, parent: Element = document.body) {
	const overlay = el('div', parent);
	overlay.style.position = 'fixed';
	if (z !== null) overlay.style.zIndex = String(z);
	const panel = el('div', overlay, { role: 'dialog', 'aria-modal': 'true' });
	el('button', panel);
	return { overlay, panel };
}

/** An app shell: header + main (with a frame holding the pane, its scrim and a centre) + footer. */
function shell() {
	const app = el('div');
	const header = el('header', app);
	const headerButton = el('button', header);
	const main = el('main', app);
	const aside = el('nav', main);
	const frame = el('div', main);
	const pane = el('aside', frame, { role: 'dialog', 'aria-modal': 'true' });
	const center = el('div', frame);
	const scrim = el('div', frame, { 'data-scrim': '' });
	const footer = el('footer', app);
	return { app, header, headerButton, main, aside, frame, pane, center, scrim, footer };
}

const inert = (node: Element) => node.hasAttribute('inert');
const blocked = (node: Element) => node.closest('[inert]') !== null;
const inertCount = () => document.querySelectorAll('[inert]').length;

describe('trackModalLayer: what is inert', () => {
	it('makes everything beside the path to the layer inert, and nothing on the path', () => {
		const s = shell();
		const other = el('div');
		track(s.pane);
		for (const node of [s.header, s.aside, s.center, s.scrim, s.footer, other]) {
			expect(inert(node)).toBe(true);
		}
		expect(blocked(s.headerButton)).toBe(true);
		for (const node of [document.body, s.app, s.main, s.frame, s.pane]) {
			expect(inert(node)).toBe(false);
		}
	});

	it('release gives back exactly what it took, and is safe to call twice', () => {
		const s = shell();
		const release = track(s.pane);
		expect(inertCount()).toBeGreaterThan(0);
		release();
		expect(inertCount()).toBe(0);
		release();
		expect(inertCount()).toBe(0);
	});

	it('keeps the named scrim (a sibling of the layer) so a click on it arrives', () => {
		const s = shell();
		track(s.pane, { backdrop: () => s.scrim });
		expect(inert(s.scrim)).toBe(false);
		expect(inert(s.center)).toBe(true);
		expect(inert(s.header)).toBe(true);
	});

	it('leaves <script> / <style> and non-HTML elements alone', () => {
		const s = shell();
		const script = el('script');
		const style = el('style');
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		document.body.append(svg);
		track(s.pane);
		expect(inert(script)).toBe(false);
		expect(inert(style)).toBe(false);
		expect(inert(svg)).toBe(false);
	});

	it('keeps an exempt element (toasts, touch keys) and walks around it', () => {
		const s = shell();
		const wrapper = el('div');
		const toasts = el('div', wrapper, { [MODAL_EXEMPT_ATTR]: '' });
		const toastButton = el('button', toasts);
		const beside = el('div', wrapper);
		track(s.pane);
		expect(blocked(toastButton)).toBe(false);
		expect(inert(wrapper)).toBe(false);
		expect(inert(beside)).toBe(true);
	});

	it('a layer that is not in the document decides nothing', () => {
		const s = shell();
		const detached = document.createElement('div');
		track(detached);
		expect(inertCount()).toBe(0);
		track(s.pane);
		expect(inert(s.header)).toBe(true);
	});
});

describe('trackModalLayer: live regions', () => {
	it('does not silence a live region, nor its ancestors; what is beside it is inert', () => {
		const s = shell();
		const status = el('div', s.header, { role: 'status' });
		const polite = el('p', s.footer, { 'aria-live': 'polite' });
		const off = el('p', s.footer, { 'aria-live': 'off' });
		track(s.pane);
		expect(blocked(status)).toBe(false);
		expect(blocked(polite)).toBe(false);
		expect(inert(s.headerButton)).toBe(true);
		expect(inert(off)).toBe(true);
	});

	it('controls inside a live region are made inert one by one (a "retry" in a banner, a toast button)', () => {
		const s = shell();
		const banner = el('div', s.app, { role: 'status' });
		const text = el('span', banner);
		const retry = el('button', banner);
		const link = el('a', banner, { href: '#' });
		const custom = el('span', banner, { tabindex: '0' });
		const release = track(s.pane);
		expect(inert(banner)).toBe(false);
		expect(inert(text)).toBe(false);
		for (const control of [retry, link, custom]) expect(inert(control)).toBe(true);
		release();
		expect(inertCount()).toBe(0);
	});

	it('a banner that appears while the layer is open is covered: announced, its button blocked', async () => {
		const s = shell();
		track(s.pane);
		// On the path (a child of the app shell, like ConnectionBanner) ...
		const banner = el('div', s.app, { role: 'status' });
		const retry = el('button', banner);
		// ... and deep inside what is already inert.
		const deep = el('div', s.header, { role: 'alert' });
		await settle();
		expect(blocked(banner)).toBe(false);
		expect(inert(retry)).toBe(true);
		expect(blocked(deep)).toBe(false);
		expect(inert(s.headerButton)).toBe(true);
	});

	it('a control that only gains an attribute later is blocked (href, tabindex, contenteditable, role)', async () => {
		const s = shell();
		const banner = el('div', s.app, { role: 'status' });
		const link = el('a', banner);
		const custom = el('span', banner);
		const editable = el('span', banner);
		const fake = el('span', banner);
		const text = el('span', banner);
		track(s.pane);
		expect(inert(link) || inert(custom) || inert(editable) || inert(fake)).toBe(false);
		link.setAttribute('href', '#');
		custom.setAttribute('tabindex', '0');
		editable.setAttribute('contenteditable', 'true');
		fake.setAttribute('role', 'button');
		await settle();
		for (const control of [link, custom, editable, fake]) expect(inert(control)).toBe(true);
		expect(inert(text)).toBe(false);
		expect(inert(banner)).toBe(false);
	});

	it('a control added later to a live region is blocked too', async () => {
		const s = shell();
		const banner = el('div', s.app, { 'aria-live': 'assertive' });
		track(s.pane);
		const retry = el('button', banner);
		await settle();
		expect(inert(retry)).toBe(true);
		expect(inert(banner)).toBe(false);
	});

	it('an element that turns into a live region is let out; one that stops being one is taken', async () => {
		const s = shell();
		const note = el('div', s.app);
		const was = el('div', s.app, { role: 'status' });
		track(s.pane);
		expect(inert(note)).toBe(true);
		note.setAttribute('aria-live', 'polite');
		was.removeAttribute('role');
		await settle();
		expect(inert(note)).toBe(false);
		expect(inert(was)).toBe(true);
	});
});

describe('trackModalLayer: layers stacked', () => {
	it('a modal opened from inside the layer becomes the top: the rest of the lower layer is inert', () => {
		const s = shell();
		const paneButton = el('button', s.pane);
		const releasePane = track(s.pane);
		const nested = layer(900, s.pane);
		const releaseNested = track(nested.panel);
		expect(inert(paneButton)).toBe(true);
		expect(blocked(nested.panel)).toBe(false);
		expect(inert(s.header)).toBe(true);
		releaseNested();
		expect(inert(paneButton)).toBe(false);
		expect(inert(s.header)).toBe(true);
		releasePane();
		expect(inertCount()).toBe(0);
	});

	it('a modal elsewhere in the document (a portal that existed before) is usable, and the lower layer comes back', () => {
		const s = shell();
		const portal = el('div');
		const releasePane = track(s.pane);
		expect(inert(portal)).toBe(true);
		const upper = layer(900, portal);
		const releaseUpper = track(upper.panel);
		expect(blocked(upper.panel)).toBe(false);
		expect(inert(s.app)).toBe(true);
		// Closing says so in the DOM (promise 6), as Modal / Drawer do.
		upper.panel.setAttribute('data-layer-inactive', 'true');
		releaseUpper();
		expect(inert(s.app)).toBe(false);
		expect(blocked(s.pane)).toBe(false);
		expect(inert(s.header)).toBe(true);
		expect(inert(portal)).toBe(true);
		releasePane();
		expect(inertCount()).toBe(0);
	});

	it('layers released out of order: the lower one first, then the upper one', () => {
		const lower = layer(900);
		const upper = layer(1000);
		const outside = el('button');
		const releaseLower = track(lower.panel);
		const releaseUpper = track(upper.panel);
		expect(inert(lower.overlay)).toBe(true);
		expect(blocked(upper.panel)).toBe(false);
		releaseLower();
		// The upper layer still decides.
		expect(inert(lower.overlay)).toBe(true);
		expect(inert(outside)).toBe(true);
		expect(blocked(upper.panel)).toBe(false);
		releaseUpper();
		expect(inertCount()).toBe(0);
	});

	it('the topmost is decided by z-index, not by who opened last; equal z = later in the document', () => {
		const high = layer(1000);
		const low = layer(900);
		const releaseHigh = track(high.panel);
		const releaseLow = track(low.panel);
		expect(inert(low.overlay)).toBe(true);
		expect(blocked(high.panel)).toBe(false);
		high.panel.setAttribute('data-layer-inactive', 'true');
		releaseHigh();
		expect(blocked(low.panel)).toBe(false);
		expect(inert(high.overlay)).toBe(true);
		releaseLow();
		const first = layer(900);
		const second = layer(900);
		track(second.panel);
		track(first.panel);
		expect(inert(first.overlay)).toBe(true);
		expect(blocked(second.panel)).toBe(false);
	});

	it('three layers, closed from the middle', () => {
		const a = layer(100);
		const b = layer(200);
		const c = layer(300);
		const releaseA = track(a.panel);
		const releaseB = track(b.panel);
		const releaseC = track(c.panel);
		b.panel.setAttribute('data-layer-inactive', 'true');
		releaseB();
		expect(blocked(c.panel)).toBe(false);
		expect(inert(a.overlay)).toBe(true);
		expect(inert(b.overlay)).toBe(true);
		c.panel.setAttribute('data-layer-inactive', 'true');
		releaseC();
		expect(blocked(a.panel)).toBe(false);
		expect(inert(b.overlay)).toBe(true);
		expect(inert(c.overlay)).toBe(true);
		releaseA();
		expect(inertCount()).toBe(0);
	});

	it('an untracked layer above (an app dialog, an open sidebar) is kept out of the backdrop', () => {
		const s = shell();
		const sidebar = el('div', document.body, { 'data-esc-layer': '' });
		sidebar.style.position = 'fixed';
		sidebar.style.zIndex = '900';
		const below = el('div', s.aside, { role: 'dialog' });
		track(s.pane);
		expect(inert(sidebar)).toBe(false);
		expect(blocked(below)).toBe(true);
	});

	it('an untracked dialog that appears later inside a portal we made inert is let out, and taken back when it goes', async () => {
		const s = shell();
		const portal = el('div');
		const beside = el('button', portal);
		track(s.pane);
		expect(inert(portal)).toBe(true);
		const dialog = layer(900, portal);
		await settle();
		expect(blocked(dialog.panel)).toBe(false);
		expect(inert(portal)).toBe(false);
		// What else is in the portal stays blocked, and so does the page.
		expect(inert(beside)).toBe(true);
		expect(inert(s.header)).toBe(true);
		dialog.overlay.remove();
		await settle();
		expect(inert(portal)).toBe(true);
	});

	it('an untracked layer that is closing or hidden is not kept', async () => {
		const s = shell();
		const closing = layer(900);
		closing.panel.setAttribute('data-layer-inactive', 'true');
		const hidden = layer(900);
		hidden.overlay.style.display = 'none';
		track(s.pane);
		expect(inert(closing.overlay)).toBe(true);
		expect(inert(hidden.overlay)).toBe(true);
		// Shown by a style change: found on the next update.
		hidden.overlay.style.display = '';
		await settle();
		expect(inert(hidden.overlay)).toBe(false);
	});
});

describe('trackModalLayer: whose inert is whose', () => {
	it('an element that was inert before stays inert after release', () => {
		const s = shell();
		s.aside.setAttribute('inert', '');
		const release = track(s.pane);
		release();
		expect(inert(s.aside)).toBe(true);
		expect(inertCount()).toBe(1);
	});

	it("an inert the app writes while the layer is open is the app's: release does not remove it", async () => {
		const s = shell();
		const release = track(s.pane);
		expect(inert(s.aside)).toBe(true);
		// e.g. the sidebar turns off-canvas (closed) while a Modal is open.
		s.aside.setAttribute('inert', '');
		await settle();
		release();
		expect(inert(s.aside)).toBe(true);
		expect(inert(s.header)).toBe(false);
	});

	it('...also when the release comes in the same task as the write', () => {
		const s = shell();
		const release = track(s.pane);
		s.aside.setAttribute('inert', '');
		release();
		expect(inert(s.aside)).toBe(true);
	});

	it('an inert the app removes while the layer is open is put back, and removed on release', async () => {
		const s = shell();
		s.aside.setAttribute('inert', '');
		const release = track(s.pane);
		s.aside.removeAttribute('inert');
		s.header.removeAttribute('inert');
		await settle();
		expect(inert(s.aside)).toBe(true);
		expect(inert(s.header)).toBe(true);
		release();
		expect(inertCount()).toBe(0);
	});

	it('does not walk into a subtree someone else made inert', () => {
		const s = shell();
		s.header.setAttribute('inert', '');
		const status = el('div', s.header, { role: 'status' });
		const retry = el('button', status);
		const release = track(s.pane);
		expect(inert(retry)).toBe(false);
		release();
		expect(inert(s.header)).toBe(true);
	});
});

describe('trackModalLayer: the DOM changes under an open layer', () => {
	it('content that appears beside the path is made inert', async () => {
		const s = shell();
		track(s.pane);
		const late = el('button', s.app);
		const portal = el('div');
		await settle();
		expect(inert(late)).toBe(true);
		expect(inert(portal)).toBe(true);
	});

	it('changes inside the layer leave the backdrop alone', async () => {
		const s = shell();
		track(s.pane);
		const inside = el('div', s.pane, { role: 'status' });
		const button = el('button', inside);
		await settle();
		expect(blocked(button)).toBe(false);
		expect(inert(s.header)).toBe(true);
	});

	it('a layer removed from the document without a release frees the page; the release afterwards is harmless', async () => {
		const s = shell();
		const release = track(s.pane);
		s.frame.remove();
		await settle();
		expect(inertCount()).toBe(0);
		release();
		expect(inertCount()).toBe(0);
	});

	it('stops watching once the last layer is released', async () => {
		const s = shell();
		const release = track(s.pane);
		release();
		const late = el('button', s.app);
		await settle();
		expect(inert(late)).toBe(false);
	});
});
