/**
 * #663 ①-C: the page View menu host (pageViewMenu.svelte.ts) - one source at
 * a time, a cleanup only removes its own source, and `inShell` follows the
 * shell's state.
 */
import { describe, expect, it } from 'vitest';
import {
	PageViewMenuHost,
	type PageViewMenuControl,
	type PageViewMenuDef,
	type PageViewMenuHostOptions
} from './pageViewMenu.svelte';

const menu = (label: string): PageViewMenuDef => ({
	label,
	items: [{ kind: 'action', id: 'a', label: 'A', onSelect: () => {} }]
});

describe('PageViewMenuHost', () => {
	it('has no menu until a page registers one, and none after its cleanup', () => {
		const host = new PageViewMenuHost(() => true);
		expect(host.menu).toBeNull();
		const off = host.register(() => menu('View'));
		expect(host.menu?.label).toBe('View');
		off();
		expect(host.menu).toBeNull();
	});

	it("reads the source on each access (the page's current items)", () => {
		const host = new PageViewMenuHost(() => true);
		let label = 'View';
		host.register(() => menu(label));
		label = 'Changed';
		expect(host.menu?.label).toBe('Changed');
	});

	it('a later page replaces the earlier one; the stale cleanup leaves it alone', () => {
		const host = new PageViewMenuHost(() => true);
		const offFirst = host.register(() => menu('First'));
		const offSecond = host.register(() => menu('Second'));
		offFirst();
		expect(host.menu?.label).toBe('Second');
		offSecond();
		expect(host.menu).toBeNull();
	});

	it('inShell follows the shell state it was given', () => {
		let barShown = true;
		const host = new PageViewMenuHost(() => barShown);
		expect(host.inShell).toBe(true);
		barShown = false;
		expect(host.inShell).toBe(false);
	});
});

/**
 * Focus follows the menu between the bar and the page header. The DOM is
 * faked: nodes are plain objects, `active` is the focused one (`null` =
 * nothing / body), and the deferred attempts run when `flush` is called.
 */
describe('PageViewMenuHost focus hand-over', () => {
	type FakeNode = { name: string };
	const outside: FakeNode = { name: 'outside' };

	function setup(initialInShell: boolean) {
		let inShell = initialInShell;
		let active: FakeNode | null = null;
		const queue: Array<() => void> = [];
		const options: PageViewMenuHostOptions = {
			activeElement: () => active as unknown as Element | null,
			defer: (run) => queue.push(run)
		};
		const host = new PageViewMenuHost(() => inShell, options);
		/** A control with a trigger and an open menu item; `ready` = whether the trigger takes focus. */
		const control = (place: 'shell' | 'page', ready = true) => {
			const trigger: FakeNode = { name: `${place}-trigger` };
			const menuItem: FakeNode = { name: `${place}-item` };
			const state = { ready, focused: 0 };
			const c: PageViewMenuControl = {
				contains: (node) => node === (trigger as unknown) || node === (menuItem as unknown),
				focusTrigger: () => {
					if (!state.ready) return false;
					state.focused += 1;
					active = trigger;
					return true;
				}
			};
			const off = host.attach(place, c);
			return { trigger, menuItem, state, off };
		};
		const flush = (): void => {
			for (let i = 0; i < 50 && queue.length > 0; i++) queue.shift()?.();
		};
		host.followFocus(); // the provider's first run records the initial place
		return {
			host,
			control,
			flush,
			queue,
			focus: (node: FakeNode | null) => (active = node),
			get active() {
				return active;
			},
			switchTo: (next: boolean) => {
				inShell = next;
				host.followFocus();
			}
		};
	}

	it('page header -> bar: focus on the page trigger moves to the bar trigger', () => {
		const t = setup(false);
		const page = t.control('page');
		t.focus(page.trigger);
		t.switchTo(true);
		page.off(); // the page button unmounts
		const shell = t.control('shell');
		t.focus(null); // the browser drops the focus to body
		t.flush();
		expect(t.active).toBe(shell.trigger);
	});

	it('bar -> page header: focus inside the open bar menu moves to the page trigger', () => {
		const t = setup(true);
		const shell = t.control('shell');
		t.focus(shell.menuItem);
		t.switchTo(false);
		const page = t.control('page');
		t.flush();
		expect(t.active).toBe(page.trigger);
	});

	it('focus elsewhere at the switch is never touched', () => {
		const t = setup(false);
		t.control('page');
		t.focus(outside);
		t.switchTo(true);
		const shell = t.control('shell');
		t.flush();
		expect(t.active).toBe(outside);
		expect(shell.state.focused).toBe(0);
		expect(t.queue).toHaveLength(0);
	});

	it('retries while the new trigger refuses focus (bar not measured yet), then takes it', () => {
		const t = setup(false);
		const page = t.control('page');
		t.focus(page.trigger);
		t.switchTo(true);
		page.off();
		t.focus(null);
		const shell = t.control('shell', false);
		t.queue.shift()?.(); // attempt 0: refused
		t.queue.shift()?.(); // attempt 1: refused
		expect(t.active).toBeNull();
		shell.state.ready = true;
		t.flush();
		expect(t.active).toBe(shell.trigger);
	});

	it('gives up after a bounded number of attempts', () => {
		const t = setup(false);
		const page = t.control('page');
		t.focus(page.trigger);
		t.switchTo(true);
		page.off();
		t.focus(null);
		t.control('shell', false);
		t.flush();
		expect(t.queue).toHaveLength(0);
		expect(t.active).toBeNull();
	});

	it('does not steal focus the user moved elsewhere before the hand-over', () => {
		const t = setup(true);
		const shell = t.control('shell');
		t.focus(shell.trigger);
		t.switchTo(false);
		const page = t.control('page');
		t.focus(outside);
		t.flush();
		expect(t.active).toBe(outside);
		expect(page.state.focused).toBe(0);
	});

	it('a later switch cancels the pending hand-over', () => {
		const t = setup(true);
		const shell = t.control('shell', false);
		const page = t.control('page', false);
		t.focus(shell.trigger);
		t.switchTo(false); // bar -> page, pending
		t.switchTo(true); // back before it landed: focus is still on the shell trigger
		page.state.ready = true;
		shell.state.ready = true;
		t.flush();
		expect(page.state.focused).toBe(0);
	});

	it('owns() tells whether a node is in either control', () => {
		const t = setup(true);
		const shell = t.control('shell');
		const page = t.control('page');
		expect(t.host.owns(shell.menuItem as unknown as Node)).toBe(true);
		expect(t.host.owns(page.trigger as unknown as Node)).toBe(true);
		expect(t.host.owns(outside as unknown as Node)).toBe(false);
		page.off();
		expect(t.host.owns(page.trigger as unknown as Node)).toBe(false);
	});
});
