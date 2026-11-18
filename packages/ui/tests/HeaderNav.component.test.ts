// @vitest-environment jsdom
/**
 * @banto/ui HeaderNav contracts (docs/design/nav-menubar-plan.md §4, §7.1):
 * the `<nav>` and its name, links with `href` and `aria-current="page"` (top
 * row and dropdowns), the disclosure buttons' `aria-expanded` /
 * `aria-controls`, Esc closing and returning focus, the overflow into "more"
 * (groups under a `role="group"` heading, the active and unread marks moving
 * with them), the measuring row (`aria-hidden`, no links or buttons), no
 * rewrite when the count stays, the insufficient state (§4.9) and the arrow
 * keys (D3-c). Real layout, placement and the top-layer look are browser
 * behaviour (ui-demo, the e2e of PR-3), not asserted here.
 *
 * Stand-ins: the Popover API (same as menu.test.ts), a ResizeObserver whose
 * callbacks the test fires, a synchronous requestAnimationFrame, and
 * `getBoundingClientRect` returning widths from the measuring items'
 * `data-header-nav-measure` ids (and the nav's width for `<nav>`).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeaderNav, type HeaderNavEntry } from '../src/index';
import { computeAnchoredPosition } from '../src/anchoredPopover';

vi.mock('../src/anchoredPopover', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/anchoredPopover')>();
	return { ...actual, computeAnchoredPosition: vi.fn(actual.computeAnchoredPosition) };
});
import CustomIcon from './fixtures/CustomIcon.svelte';

type PopoverElement = HTMLElement & { showPopover(): void; hidePopover(): void };

function fireToggle(el: HTMLElement, newState: 'open' | 'closed'): void {
	queueMicrotask(() => {
		const event = new Event('toggle');
		Object.defineProperty(event, 'newState', { value: newState });
		el.dispatchEvent(event);
	});
}

const observers = new Set<{ callback: ResizeObserverCallback }>();

function notifyResize(): void {
	for (const observer of observers) observer.callback([], observer as unknown as ResizeObserver);
}

let navWidth = 1000;
/** Width key of the "more" measuring item (its own marker, not an entry id). */
const MORE_KEY = '<more>';
const widthOf: Record<string, number> = {};

beforeAll(() => {
	const proto = HTMLElement.prototype as unknown as PopoverElement;
	proto.showPopover = function (this: HTMLElement) {
		if (this.dataset.popoverOpen === 'true') throw new Error('already open');
		this.dataset.popoverOpen = 'true';
		this.style.display = 'block';
		fireToggle(this, 'open');
	};
	proto.hidePopover = function (this: HTMLElement) {
		if (this.dataset.popoverOpen !== 'true') return;
		delete this.dataset.popoverOpen;
		this.style.removeProperty('display');
		fireToggle(this, 'closed');
	};
	globalThis.ResizeObserver = class {
		callback: ResizeObserverCallback;
		constructor(callback: ResizeObserverCallback) {
			this.callback = callback;
			observers.add(this);
		}
		observe() {}
		unobserve() {}
		disconnect() {
			observers.delete(this);
		}
	} as unknown as typeof ResizeObserver;
});

beforeEach(() => {
	navWidth = 1000;
	for (const key of Object.keys(widthOf)) delete widthOf[key];
	Object.assign(widthOf, { a: 100, b: 100, g: 100, c: 100, [MORE_KEY]: 60 });
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	});
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
		this: HTMLElement
	) {
		const id =
			this.dataset.headerNavMeasureMore !== undefined ? MORE_KEY : this.dataset.headerNavMeasure;
		const width = id !== undefined ? (widthOf[id] ?? 0) : this.tagName === 'NAV' ? navWidth : 0;
		return {
			width,
			height: 0,
			top: 0,
			left: 0,
			right: width,
			bottom: 0,
			x: 0,
			y: 0,
			toJSON() {}
		} as DOMRect;
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	observers.clear();
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function entries(options: { active?: string; counts?: Record<string, number> } = {}) {
	const link = (id: string) => ({
		id,
		href: `/${id}`,
		label: id.toUpperCase(),
		icon: CustomIcon,
		active: options.active === id,
		count: options.counts?.[id]
	});
	return [
		{ kind: 'link', ...link('a') },
		{ kind: 'link', ...link('b') },
		{ kind: 'group', id: 'g', label: 'Group', items: [link('g1'), link('g2')] },
		{ kind: 'link', ...link('c') }
	] satisfies HeaderNavEntry[];
}

async function setup(
	props: Partial<{
		entries: HeaderNavEntry[];
		overflow: boolean;
		onInsufficient: (value: boolean) => void;
	}> = {}
) {
	const result = render(HeaderNav, {
		entries: entries(),
		ariaLabel: 'Main',
		moreLabel: 'More',
		updatesLabel: (count: number) => `${count} updates`,
		...props
	});
	await tick();
	const nav = screen.getByRole('navigation', { name: 'Main' });
	return { ...result, nav };
}

async function resizeTo(width: number) {
	navWidth = width;
	notifyResize();
	await tick();
}

const topControls = (nav: HTMLElement) =>
	Array.from(nav.querySelectorAll<HTMLElement>('[data-header-nav-top]'));

describe('HeaderNav', () => {
	it('renders a named nav with plain links and a disclosure button when everything fits', async () => {
		const { nav } = await setup();
		expect(nav.tagName).toBe('NAV');
		const links = within(nav).getAllByRole('link');
		expect(links.map((link) => [link.textContent?.trim(), link.getAttribute('href')])).toEqual([
			['A', '/a'],
			['B', '/b'],
			['C', '/c']
		]);
		const group = within(nav).getByRole('button', { name: 'Group' });
		expect(group.getAttribute('aria-expanded')).toBe('false');
		const popover = document.getElementById(group.getAttribute('aria-controls') ?? '');
		expect(popover?.getAttribute('popover')).toBe('auto');
		expect(within(nav).queryByRole('button', { name: /More/ })).toBeNull();
		// Top items are text only (D5): no icon outside the dropdowns.
		for (const control of topControls(nav)) {
			expect(control.querySelector('[data-testid="custom-icon"]')).toBeNull();
		}
	});

	it('keeps the measuring row out of the a11y tree, with no links or buttons', async () => {
		const { nav } = await setup();
		const measure = nav.querySelector('.measure-clip[aria-hidden="true"][inert]') as HTMLElement;
		expect(measure).not.toBeNull();
		expect(measure.querySelectorAll('a, button')).toHaveLength(0);
		expect(measure.querySelectorAll('[data-header-nav-measure]')).toHaveLength(4);
		expect(measure.querySelectorAll('[data-header-nav-measure-more]')).toHaveLength(1);
	});

	it('marks the active link with aria-current, and only the look on its group button', async () => {
		const { nav } = await setup({ entries: entries({ active: 'g2' }) });
		const group = within(nav).getByRole('button', { name: 'Group' });
		expect(group.classList.contains('active')).toBe(true);
		expect(group.hasAttribute('aria-current')).toBe(false);
		await fireEvent.click(group);
		await flush();
		expect(group.getAttribute('aria-expanded')).toBe('true');
		const inner = screen.getByRole('link', { name: 'G2' });
		expect(inner.getAttribute('aria-current')).toBe('page');
		expect(inner.getAttribute('href')).toBe('/g2');
		// Dropdown links carry the icon (D5).
		expect(inner.querySelector('[data-testid="custom-icon"]')).not.toBeNull();
		expect(screen.getByRole('link', { name: 'G1' }).hasAttribute('aria-current')).toBe(false);
	});

	it('puts aria-current on an active top-row link', async () => {
		const { nav } = await setup({ entries: entries({ active: 'b' }) });
		expect(within(nav).getByRole('link', { name: 'B' }).getAttribute('aria-current')).toBe('page');
		expect(within(nav).getByRole('link', { name: 'A' }).hasAttribute('aria-current')).toBe(false);
	});

	it('closes on a second click', async () => {
		const { nav } = await setup();
		const group = within(nav).getByRole('button', { name: 'Group' });
		await fireEvent.click(group);
		await flush();
		await fireEvent.click(group);
		await flush();
		expect(group.getAttribute('aria-expanded')).toBe('false');
	});

	it('closes on Esc and returns focus to the button', async () => {
		const { nav } = await setup();
		const group = within(nav).getByRole('button', { name: 'Group' });
		await fireEvent.keyDown(group, { key: 'ArrowDown' });
		await flush();
		const first = screen.getByRole('link', { name: 'G1' });
		expect(document.activeElement).toBe(first);
		await fireEvent.keyDown(first, { key: 'Escape' });
		await flush();
		expect(group.getAttribute('aria-expanded')).toBe('false');
		expect(document.activeElement).toBe(group);
	});

	it('moves "more" entries from the right end and lists groups under a heading', async () => {
		const { nav } = await setup();
		// 4 x 100 + more 60: 60 + 100 + 100 = 260 <= 300 < 360.
		await resizeTo(300);
		expect(topControls(nav).map((control) => control.textContent?.trim())).toEqual([
			'A',
			'B',
			'More'
		]);
		const more = within(nav).getByRole('button', { name: 'More' });
		await fireEvent.click(more);
		await flush();
		const popover = document.getElementById(more.getAttribute('aria-controls') ?? '')!;
		const section = within(popover).getByRole('group', { name: 'Group' });
		expect(
			within(section)
				.getAllByRole('link')
				.map((link) => link.textContent?.trim())
		).toEqual(['G1', 'G2']);
		// Original order: the group, then the loose link after it.
		expect(
			within(popover)
				.getAllByRole('link')
				.map((link) => link.textContent?.trim())
		).toEqual(['G1', 'G2', 'C']);
	});

	it('does not mistake an entry whose id is "more" for the "more" button', async () => {
		Object.assign(widthOf, { a: 200, more: 100 });
		const link = (id: string) => ({ id, href: `/${id}`, label: id.toUpperCase() });
		const { nav } = await setup({
			entries: [
				{ kind: 'link', ...link('a') },
				{ kind: 'link', ...link('more') }
			]
		});
		// 200 + 100 = 300 > 180, and 60 + 200 > 180: only the "more" button stays on top.
		await resizeTo(180);
		expect(topControls(nav).map((control) => control.textContent?.trim())).toEqual(['More']);
	});

	it('re-anchors an open dropdown when the row is measured again', async () => {
		const { nav } = await setup();
		await resizeTo(300);
		await fireEvent.click(within(nav).getByRole('button', { name: 'More' }));
		await flush();
		const anchored = vi.mocked(computeAnchoredPosition);
		const before = anchored.mock.calls.length;
		// 60 + 100 = 160 <= 200 < 260: one entry fewer on top, so "more" moves left.
		await resizeTo(200);
		expect(topControls(nav).map((control) => control.textContent?.trim())).toEqual(['A', 'More']);
		expect(anchored.mock.calls.length).toBeGreaterThan(before);
	});

	it('marks "more" active when the current page moved into it', async () => {
		const { nav } = await setup({ entries: entries({ active: 'c' }) });
		await resizeTo(300);
		expect(within(nav).getByRole('button', { name: 'More' }).classList.contains('active')).toBe(
			true
		);
		await resizeTo(1000);
		expect(within(nav).queryByRole('button', { name: 'More' })).toBeNull();
	});

	it('shows counts as capped badges and adds the unread name to links and buttons', async () => {
		const { nav } = await setup({ entries: entries({ counts: { a: 3, g1: 120, g2: 5, c: 2 } }) });
		const a = within(nav).getByRole('link', { name: 'A 3 updates' });
		expect(a.querySelector('[aria-hidden="true"]')?.textContent).toBe('3');
		// The group sums the numeric counts (not "99+").
		within(nav).getByRole('button', { name: 'Group 125 updates' });
		await resizeTo(300);
		within(nav).getByRole('button', { name: 'More 127 updates' });
		await fireEvent.click(within(nav).getByRole('button', { name: /More/ }));
		await flush();
		const g1 = screen.getByRole('link', { name: 'G1 120 updates' });
		expect(g1.querySelector('.badge')?.textContent).toBe('99+');
	});

	it('does not rewrite the row when the count stays the same', async () => {
		const { nav } = await setup();
		await resizeTo(300);
		const row = nav.querySelector('ul') as HTMLElement;
		const mutations: MutationRecord[] = [];
		const watcher = new MutationObserver((records) => mutations.push(...records));
		watcher.observe(row, { subtree: true, childList: true, attributes: true, characterData: true });
		await resizeTo(320);
		await resizeTo(290);
		watcher.disconnect();
		expect(mutations).toEqual([]);
		expect(topControls(nav)).toHaveLength(3);
	});

	it('re-measures when the entries change (a longer label)', async () => {
		const { nav, rerender } = await setup();
		await resizeTo(470);
		expect(topControls(nav)).toHaveLength(4); // 4 x 100 fits in 470
		widthOf.a = 200;
		const next = entries();
		next[0] = { ...next[0], label: 'A longer label' };
		await rerender({ entries: next });
		await tick();
		// 200 + 3 x 100 = 500 > 470; with "more": 60 + 200 + 100 + 100 = 460 <= 470.
		expect(topControls(nav).map((control) => control.textContent?.trim())).toEqual([
			'A longer label',
			'B',
			'Group',
			'More'
		]);
	});

	it('reports the insufficient state and recovers only past the slack', async () => {
		const onInsufficient = vi.fn();
		const { nav } = await setup({ onInsufficient });
		const row = nav.querySelector('ul') as HTMLElement;
		expect(row.style.visibility).toBe('');
		await resizeTo(50);
		expect(onInsufficient).toHaveBeenLastCalledWith(true);
		expect(row.style.visibility).toBe('hidden');
		await resizeTo(60); // "more" fits again, but not the slack
		expect(onInsufficient).toHaveBeenCalledTimes(1);
		await resizeTo(100);
		expect(onInsufficient).toHaveBeenLastCalledWith(false);
		expect(onInsufficient).toHaveBeenCalledTimes(2);
		expect(row.style.visibility).toBe('');
	});

	it('closes an open dropdown when the width becomes insufficient', async () => {
		const { nav } = await setup();
		await resizeTo(300);
		const more = within(nav).getByRole('button', { name: 'More' });
		await fireEvent.click(more);
		await flush();
		const popover = document.getElementById(more.getAttribute('aria-controls') ?? '')!;
		expect(popover.dataset.popoverOpen).toBe('true');
		await resizeTo(50);
		await flush();
		expect(popover.dataset.popoverOpen).toBeUndefined();
		expect(more.getAttribute('aria-expanded')).toBe('false');
	});

	it('moves along the top row with the arrows and Home / End (every item a Tab stop)', async () => {
		const { nav } = await setup();
		await resizeTo(300);
		const [a, b, more] = topControls(nav);
		for (const control of [a, b, more]) expect(control.getAttribute('tabindex')).toBeNull();
		a.focus();
		await fireEvent.keyDown(a, { key: 'ArrowRight' });
		expect(document.activeElement).toBe(b);
		await fireEvent.keyDown(b, { key: 'ArrowRight' });
		expect(document.activeElement).toBe(more);
		await fireEvent.keyDown(more, { key: 'ArrowRight' });
		expect(document.activeElement).toBe(a);
		await fireEvent.keyDown(a, { key: 'ArrowLeft' });
		expect(document.activeElement).toBe(more);
		await fireEvent.keyDown(more, { key: 'Home' });
		expect(document.activeElement).toBe(a);
		await fireEvent.keyDown(a, { key: 'End' });
		expect(document.activeElement).toBe(more);
	});

	it('moves inside an open dropdown with up / down / Home / End', async () => {
		const { nav } = await setup();
		const group = within(nav).getByRole('button', { name: 'Group' });
		await fireEvent.keyDown(group, { key: 'ArrowUp' });
		await flush();
		const g1 = screen.getByRole('link', { name: 'G1' });
		const g2 = screen.getByRole('link', { name: 'G2' });
		expect(document.activeElement).toBe(g2);
		await fireEvent.keyDown(g2, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(g1);
		await fireEvent.keyDown(g1, { key: 'End' });
		expect(document.activeElement).toBe(g2);
		await fireEvent.keyDown(g2, { key: 'Home' });
		expect(document.activeElement).toBe(g1);
	});

	it('closes on left / right and moves to the neighbouring top item (wrapping, not opened)', async () => {
		const { nav } = await setup();
		const [a, b, group, c] = topControls(nav);
		await fireEvent.keyDown(group, { key: 'ArrowDown' });
		await flush();
		await fireEvent.keyDown(screen.getByRole('link', { name: 'G1' }), { key: 'ArrowRight' });
		await flush();
		expect(document.activeElement).toBe(c);
		expect(group.getAttribute('aria-expanded')).toBe('false');
		expect(c.getAttribute('aria-expanded')).toBeNull();
		await fireEvent.keyDown(group, { key: 'ArrowDown' });
		await flush();
		await fireEvent.keyDown(screen.getByRole('link', { name: 'G1' }), { key: 'ArrowLeft' });
		await flush();
		expect(document.activeElement).toBe(b);
		expect(group.getAttribute('aria-expanded')).toBe('false');
		expect(a).toBeTruthy();
	});

	it('closes when focus leaves the button backwards (Shift+Tab)', async () => {
		const { nav } = await setup();
		const [, b, group] = topControls(nav);
		await fireEvent.keyDown(group, { key: 'ArrowDown' });
		await flush();
		await fireEvent.focusOut(group, { relatedTarget: b });
		await flush();
		expect(group.getAttribute('aria-expanded')).toBe('false');
	});

	it('keeps the same group open when an item is inserted before it', async () => {
		const result = await setup();
		const group = within(result.nav).getByRole('button', { name: 'Group' });
		await fireEvent.keyDown(group, { key: 'ArrowDown' });
		await flush();
		const base = entries();
		await result.rerender({
			entries: [{ kind: 'link', id: 'z', href: '/z', label: 'Z', icon: CustomIcon }, ...base]
		});
		await flush();
		const again = within(result.nav).getByRole('button', { name: 'Group' });
		expect(again.getAttribute('aria-expanded')).toBe('true');
		expect(
			within(result.nav)
				.getAllByRole('button')
				.filter((el) => el.getAttribute('aria-expanded') === 'true')
		).toHaveLength(1);
	});

	it('closes when focus leaves the dropdown', async () => {
		const { nav } = await setup();
		const group = within(nav).getByRole('button', { name: 'Group' });
		await fireEvent.keyDown(group, { key: 'ArrowDown' });
		await flush();
		const c = within(nav).getByRole('link', { name: 'C' });
		await fireEvent.focusOut(screen.getByRole('link', { name: 'G2' }), { relatedTarget: c });
		await flush();
		expect(group.getAttribute('aria-expanded')).toBe('false');
	});

	it('without overflow: no measuring row, no "more", everything on top', async () => {
		const { nav } = await setup({
			overflow: false,
			entries: [entries()[2]]
		});
		await resizeTo(10);
		expect(nav.querySelector('[data-header-nav-measure]')).toBeNull();
		expect(topControls(nav).map((control) => control.textContent?.trim())).toEqual(['Group']);
	});

	it('gives groups whose ids differ only by an escaped character distinct popover ids', async () => {
		const link = (id: string) => ({ id, href: `/${id}`, label: id, icon: CustomIcon });
		const { nav } = await setup({
			entries: [
				{ kind: 'group', id: 'a:b', label: 'Colon', items: [link('x1')] },
				{ kind: 'group', id: 'a_3a_b', label: 'Escaped', items: [link('x2')] },
				{ kind: 'group', id: 'a_b', label: 'Plain', items: [link('x3')] }
			]
		});
		const ids = ['Colon', 'Escaped', 'Plain'].map(
			(name) => within(nav).getByRole('button', { name }).getAttribute('aria-controls') ?? ''
		);
		expect(new Set(ids).size).toBe(3);
		for (const id of ids) expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
	});

	it('reports "not insufficient" when overflow is turned off while insufficient', async () => {
		const onInsufficient = vi.fn();
		const { nav, rerender } = await setup({ onInsufficient });
		await resizeTo(50);
		expect(onInsufficient).toHaveBeenLastCalledWith(true);
		await rerender({ overflow: false });
		await tick();
		await flush();
		expect(onInsufficient).toHaveBeenLastCalledWith(false);
		expect(onInsufficient).toHaveBeenCalledTimes(2);
		const row = nav.querySelector('ul.row') as HTMLElement;
		expect(row.style.visibility).toBe('');
	});

	it('keeps focus on the "more" button when the focused top item moves into it', async () => {
		const { nav } = await setup();
		const c = within(nav).getByRole('link', { name: 'C' });
		c.focus();
		expect(document.activeElement).toBe(c);
		await resizeTo(300);
		const more = within(nav).getByRole('button', { name: /More/ });
		expect(document.activeElement).toBe(more);
		expect(more.getAttribute('aria-expanded')).toBe('false');
	});

	it('moves focus to the top item when "more" disappears around a focused link in it', async () => {
		const { nav } = await setup();
		await resizeTo(300);
		const more = within(nav).getByRole('button', { name: /More/ });
		await fireEvent.click(more);
		await flush();
		const inner = screen.getByRole('link', { name: 'C' });
		inner.focus();
		expect(document.activeElement).toBe(inner);
		await resizeTo(1000);
		expect(within(nav).queryByRole('button', { name: /More/ })).toBeNull();
		const c = within(nav).getByRole('link', { name: 'C' });
		expect(document.activeElement).toBe(c);
	});

	it('leaves focus alone when it is outside the nav', async () => {
		const outside = document.createElement('button');
		document.body.append(outside);
		await setup();
		outside.focus();
		await resizeTo(300);
		expect(document.activeElement).toBe(outside);
		outside.remove();
	});
});

describe('HeaderNav menu entries (#663 ①-B)', () => {
	function menuEntries(
		options: { logChecked?: boolean; onLog?: () => void; onReset?: () => void } = {}
	) {
		const link = (id: string) => ({ id, href: `/${id}`, label: id.toUpperCase() });
		return [
			{ kind: 'link', ...link('a') },
			{ kind: 'link', ...link('b') },
			{
				kind: 'menu',
				id: 'view',
				label: 'View',
				items: [
					{
						kind: 'checkbox',
						id: 'log',
						label: 'Log',
						checked: options.logChecked ?? false,
						onSelect: options.onLog ?? (() => {})
					},
					{ kind: 'separator', id: 'sep' },
					{
						kind: 'action',
						id: 'reset',
						label: 'Reset layout',
						icon: CustomIcon,
						onSelect: options.onReset ?? (() => {})
					}
				]
			},
			{ kind: 'link', ...link('c') }
		] satisfies HeaderNavEntry[];
	}

	beforeEach(() => {
		widthOf.view = 80;
	});

	const menuOf = (button: HTMLElement) =>
		button.parentElement!.querySelector<HTMLElement>('[role="menu"]')!;

	it('renders a menu button and a role="menu" with checkbox, separator and action items', async () => {
		const { nav } = await setup({ entries: menuEntries({ logChecked: true }) });
		const button = within(nav).getByRole('button', { name: 'View' });
		expect(button.getAttribute('aria-haspopup')).toBe('menu');
		expect(button.getAttribute('aria-expanded')).toBe('false');
		// Not a link disclosure: no aria-controls, no links inside.
		expect(button.hasAttribute('aria-controls')).toBe(false);
		const menu = menuOf(button);
		expect(menu.getAttribute('aria-label')).toBe('View');
		expect(menu.querySelectorAll('a')).toHaveLength(0);
		// Closed (hidden, so out of the a11y queries) until opened: read the roles directly.
		expect(
			Array.from(menu.querySelectorAll('[role]'), (el) => [
				el.getAttribute('role'),
				el.textContent?.trim(),
				el.getAttribute('aria-checked')
			])
		).toEqual([
			['menuitemcheckbox', 'Log', 'true'],
			['separator', '', null],
			['menuitem', 'Reset layout', null]
		]);
		// Measured with the rest, marked pinned.
		expect(
			nav.querySelector('[data-header-nav-measure="view"]')?.hasAttribute('data-header-nav-pinned')
		).toBe(true);
	});

	it('opens from the keyboard on the first / last item', async () => {
		const { nav } = await setup({ entries: menuEntries() });
		const button = within(nav).getByRole('button', { name: 'View' });
		await fireEvent.keyDown(button, { key: 'ArrowDown' });
		await flush();
		expect(button.getAttribute('aria-expanded')).toBe('true');
		expect(document.activeElement).toBe(screen.getByRole('menuitemcheckbox', { name: 'Log' }));
		(menuOf(button) as PopoverElement).hidePopover();
		await flush();
		await fireEvent.keyDown(button, { key: 'ArrowUp' });
		await flush();
		expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Reset layout' }));
	});

	it('Esc (light dismiss) closes and returns focus to the button', async () => {
		const { nav } = await setup({ entries: menuEntries() });
		const button = within(nav).getByRole('button', { name: 'View' });
		await fireEvent.keyDown(button, { key: 'Enter' });
		await flush();
		expect(menuOf(button).contains(document.activeElement)).toBe(true);
		// The browser closes an auto popover on Esc; the stand-in does it directly.
		(menuOf(button) as PopoverElement).hidePopover();
		await flush();
		expect(button.getAttribute('aria-expanded')).toBe('false');
		expect(document.activeElement).toBe(button);
	});

	it('a checkbox calls onSelect, keeps the menu open and shows the new state while open', async () => {
		const onLog = vi.fn();
		const { nav, rerender } = await setup({ entries: menuEntries({ onLog }) });
		const button = within(nav).getByRole('button', { name: 'View' });
		await fireEvent.keyDown(button, { key: 'ArrowDown' });
		await flush();
		const checkbox = screen.getByRole('menuitemcheckbox', { name: 'Log' });
		expect(checkbox.getAttribute('aria-checked')).toBe('false');
		await fireEvent.click(checkbox);
		await flush();
		expect(onLog).toHaveBeenCalledTimes(1);
		expect(menuOf(button).dataset.popoverOpen).toBe('true');
		expect(document.activeElement).toBe(checkbox);
		await rerender({ entries: menuEntries({ onLog, logChecked: true }) });
		expect(screen.getByRole('menuitemcheckbox', { name: 'Log' }).getAttribute('aria-checked')).toBe(
			'true'
		);
		expect(menuOf(button).dataset.popoverOpen).toBe('true');
	});

	it('an action calls onSelect, closes the menu and returns focus to the button', async () => {
		const onReset = vi.fn();
		const { nav } = await setup({ entries: menuEntries({ onReset }) });
		const button = within(nav).getByRole('button', { name: 'View' });
		await fireEvent.keyDown(button, { key: 'ArrowUp' });
		await flush();
		await fireEvent.click(screen.getByRole('menuitem', { name: 'Reset layout' }));
		await flush();
		expect(onReset).toHaveBeenCalledTimes(1);
		expect(menuOf(button).dataset.popoverOpen).toBeUndefined();
		expect(document.activeElement).toBe(button);
	});

	it('leaves focus where an action moved it', async () => {
		const elsewhere = document.createElement('button');
		document.body.append(elsewhere);
		const { nav } = await setup({ entries: menuEntries({ onReset: () => elsewhere.focus() }) });
		const button = within(nav).getByRole('button', { name: 'View' });
		await fireEvent.keyDown(button, { key: 'ArrowUp' });
		await flush();
		await fireEvent.click(screen.getByRole('menuitem', { name: 'Reset layout' }));
		await flush();
		expect(document.activeElement).toBe(elsewhere);
		elsewhere.remove();
	});

	it('stays on the top row when links move into "more", and is reached with the arrows', async () => {
		const { nav } = await setup({ entries: menuEntries() });
		// Links 100 each, the menu 80 + gap 0: 60 (more) + 80 + 100 = 240 <= 250.
		await resizeTo(250);
		const tops = topControls(nav);
		expect(tops.map((control) => control.textContent?.trim())).toEqual(['A', 'View', 'More']);
		expect(nav.getAttribute('data-header-nav-shown')).toBe('1');
		const more = within(nav).getByRole('button', { name: 'More' });
		await fireEvent.click(more);
		await flush();
		const popover = document.getElementById(more.getAttribute('aria-controls') ?? '')!;
		expect(
			within(popover)
				.getAllByRole('link')
				.map((link) => link.textContent?.trim())
		).toEqual(['B', 'C']);
		expect(within(popover).queryByRole('menuitemcheckbox')).toBeNull();
		tops[0].focus();
		await fireEvent.keyDown(tops[0], { key: 'ArrowRight' });
		expect(document.activeElement).toBe(tops[1]);
		await fireEvent.keyDown(tops[1], { key: 'ArrowRight' });
		expect(document.activeElement).toBe(more);
		// Narrower still: only the menu and "more" are left.
		await resizeTo(140);
		expect(topControls(nav).map((control) => control.textContent?.trim())).toEqual([
			'View',
			'More'
		]);
	});

	it('closes on left / right inside the open menu and moves to the neighbouring top item', async () => {
		const { nav } = await setup({ entries: menuEntries() });
		const [, b, view, c] = topControls(nav);
		await fireEvent.keyDown(view, { key: 'ArrowDown' });
		await flush();
		await fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: 'Log' }), {
			key: 'ArrowRight'
		});
		await flush();
		expect(document.activeElement).toBe(c);
		expect(view.getAttribute('aria-expanded')).toBe('false');
		await fireEvent.keyDown(view, { key: 'ArrowDown' });
		await flush();
		await fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: 'Log' }), {
			key: 'ArrowLeft'
		});
		await flush();
		expect(document.activeElement).toBe(b);
	});

	it('closes an open menu when the width becomes insufficient', async () => {
		const onInsufficient = vi.fn();
		const { nav } = await setup({ entries: menuEntries(), onInsufficient });
		const button = within(nav).getByRole('button', { name: 'View' });
		await fireEvent.keyDown(button, { key: 'ArrowDown' });
		await flush();
		expect(menuOf(button).dataset.popoverOpen).toBe('true');
		// The menu (80) and "more" (60) no longer fit.
		await resizeTo(100);
		await flush();
		expect(onInsufficient).toHaveBeenLastCalledWith(true);
		expect(menuOf(button).dataset.popoverOpen).toBeUndefined();
	});

	it('re-anchors an open menu when the row is laid out again (no window resize)', async () => {
		const { nav } = await setup({ entries: menuEntries() });
		const button = within(nav).getByRole('button', { name: 'View' });
		await fireEvent.keyDown(button, { key: 'ArrowDown' });
		await flush();
		const anchored = vi.mocked(computeAnchoredPosition);
		const before = anchored.mock.calls.length;
		// Links move into "more": the trigger moves left, the window does not resize.
		await resizeTo(250);
		await flush();
		expect(topControls(nav).map((control) => control.textContent?.trim())).toEqual([
			'A',
			'View',
			'More'
		]);
		expect(menuOf(button).dataset.popoverOpen).toBe('true');
		const calls = anchored.mock.calls.slice(before);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.some(([anchor]) => anchor === button)).toBe(true);
	});

	it('without overflow: the menu sits with the other entries', async () => {
		const { nav } = await setup({ entries: menuEntries(), overflow: false });
		expect(topControls(nav).map((control) => control.textContent?.trim())).toEqual([
			'A',
			'B',
			'View',
			'C'
		]);
	});
});
