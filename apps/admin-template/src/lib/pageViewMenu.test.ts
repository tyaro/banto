/**
 * #663 ①-C: the page View menu host (pageViewMenu.svelte.ts) - one source at
 * a time, a cleanup only removes its own source, and `inShell` follows the
 * shell's state.
 */
import { describe, expect, it } from 'vitest';
import { PageViewMenuHost, type PageViewMenuDef } from './pageViewMenu.svelte';

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
