// @vitest-environment jsdom
/**
 * The action that takes the controls of an out-of-window row out of the Tab
 * order (#1016), driven directly on a DOM row so the order of the writes and
 * of the MutationObserver reports can be built exactly.
 */
import { tick } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import {
	SAVED_TABINDEX_ATTR,
	SUPPRESSED_TABINDEX,
	outsideRowTabStops
} from '../src/outsideRowTabStops';

let rows: HTMLElement[] = [];

afterEach(() => {
	for (const row of rows) row.remove();
	rows = [];
});

function setup(html: string) {
	const row = document.createElement('div');
	row.innerHTML = html;
	document.body.append(row);
	rows.push(row);
	const action = outsideRowTabStops(row, true);
	const el = row.querySelector<HTMLElement>('[data-k]')!;
	return { row, action, el };
}

/** MutationObserver reports are microtasks. */
async function reported() {
	await Promise.resolve();
	await tick();
}

describe('outsideRowTabStops', () => {
	it('parks the original and writes the sentinel; puts the original back', () => {
		const { row, action } = setup(
			'<button data-k="a">a</button><span data-k="b" tabindex="2">b</span>' +
				'<span data-k="c" tabindex="-1">c</span>'
		);
		const get = (k: string) => row.querySelector(`[data-k="${k}"]`)!;
		for (const k of ['a', 'b', 'c'])
			expect(get(k).getAttribute('tabindex')).toBe(SUPPRESSED_TABINDEX);
		expect(get('a').getAttribute(SAVED_TABINDEX_ATTR)).toBe('');
		expect(get('c').getAttribute(SAVED_TABINDEX_ATTR)).toBe('-1');
		action.update(false);
		expect(get('a').hasAttribute('tabindex')).toBe(false);
		expect(get('b').getAttribute('tabindex')).toBe('2');
		expect(get('c').getAttribute('tabindex')).toBe('-1');
		expect(row.querySelector(`[${SAVED_TABINDEX_ATTR}]`)).toBeNull();
	});

	it('keeps only the last of two writes made in the same task', async () => {
		const { action, el } = setup('<button data-k="a">a</button>');
		await reported();
		el.setAttribute('tabindex', '2');
		el.setAttribute('tabindex', '5');
		await reported();
		expect(el.getAttribute('tabindex')).toBe(SUPPRESSED_TABINDEX);
		action.update(false);
		expect(el.getAttribute('tabindex')).toBe('5');
	});

	it('keeps the last of two writes also when the report comes after our own write', async () => {
		const { action, el } = setup('<button data-k="a">a</button>');
		el.setAttribute('tabindex', '2');
		el.setAttribute('tabindex', '5');
		// Before any report: the start write, then 2, then 5.
		await reported();
		action.update(false);
		expect(el.getAttribute('tabindex')).toBe('5');
	});

	it('keeps a value written just before the row comes back, before it is reported', () => {
		const { action, el } = setup('<button data-k="a" tabindex="0">a</button>');
		el.setAttribute('tabindex', '-1');
		action.update(false);
		expect(el.getAttribute('tabindex')).toBe('-1');
	});

	it('keeps a removed attribute removed when the row comes back before the report', () => {
		const { action, el } = setup('<button data-k="a" tabindex="0">a</button>');
		el.removeAttribute('tabindex');
		action.update(false);
		expect(el.hasAttribute('tabindex')).toBe(false);
		expect(el.hasAttribute(SAVED_TABINDEX_ATTR)).toBe(false);
	});

	it('original 0 -> -1 while out -> -1 back; no attribute -> -1 -> -1; then 0 -> 0', async () => {
		const { row, action } = setup(
			'<button data-k="zero" tabindex="0">z</button><button data-k="plain">p</button>'
		);
		const zero = row.querySelector<HTMLElement>('[data-k="zero"]')!;
		const plain = row.querySelector<HTMLElement>('[data-k="plain"]')!;
		await reported();
		zero.setAttribute('tabindex', '-1');
		plain.setAttribute('tabindex', '-1');
		await reported();
		expect(zero.getAttribute('tabindex')).toBe(SUPPRESSED_TABINDEX);
		action.update(false);
		expect(zero.getAttribute('tabindex')).toBe('-1');
		expect(plain.getAttribute('tabindex')).toBe('-1');

		action.update(true);
		await reported();
		zero.setAttribute('tabindex', '0');
		await reported();
		expect(zero.getAttribute('tabindex')).toBe(SUPPRESSED_TABINDEX);
		action.update(false);
		expect(zero.getAttribute('tabindex')).toBe('0');
		expect(plain.getAttribute('tabindex')).toBe('-1');
	});

	it('treats a later-added element and a newly focusable one like the rest', async () => {
		const { row, action } = setup('<span data-k="a">a</span><a data-k="l">l</a>');
		await reported();
		row.insertAdjacentHTML('beforeend', '<button data-k="late">late</button>');
		row.querySelector('[data-k="l"]')!.setAttribute('href', '/x');
		await reported();
		expect(row.querySelector('[data-k="late"]')!.getAttribute('tabindex')).toBe(
			SUPPRESSED_TABINDEX
		);
		expect(row.querySelector('[data-k="l"]')!.getAttribute('tabindex')).toBe(SUPPRESSED_TABINDEX);
		action.update(false);
		expect(row.querySelector('[data-k="late"]')!.hasAttribute('tabindex')).toBe(false);
		expect(row.querySelector('[data-k="l"]')!.hasAttribute('tabindex')).toBe(false);
	});

	it('does not restore anything on destroy', () => {
		const { el, action } = setup('<button data-k="a">a</button>');
		action.destroy();
		expect(el.getAttribute('tabindex')).toBe(SUPPRESSED_TABINDEX);
	});
});
