// @vitest-environment jsdom
/**
 * The action that takes the controls of a row out of the Tab order (#1016),
 * driven directly on a DOM row so the order of the writes and of the
 * MutationObserver reports can be built exactly. The first block is about the
 * cell editor, the one part whose `tabindex` follows `outside` (taken out
 * while the row is outside the window, put back inside it); the second about
 * everything else in the row, which is taken out all the time.
 */
import { tick } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import {
	SAVED_TABINDEX_ATTR,
	SUPPRESSED_TABINDEX,
	cellControls,
	rowTabStops
} from '../src/rowTabStops';

let rows: HTMLElement[] = [];

afterEach(() => {
	for (const row of rows) row.remove();
	rows = [];
});

function setup(html: string) {
	const row = document.createElement('div');
	// The cell being edited: the part of a row whose `tabindex` follows `outside`.
	row.innerHTML = `<div class="cell editing">${html}</div>`;
	document.body.append(row);
	rows.push(row);
	const action = rowTabStops(row, true);
	const el = row.querySelector<HTMLElement>('[data-k]')!;
	return { row, action, el };
}

/** MutationObserver reports are microtasks. */
async function reported() {
	await Promise.resolve();
	await tick();
}

describe('rowTabStops: the cell editor, by `outside`', () => {
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
		row.firstElementChild!.insertAdjacentHTML('beforeend', '<button data-k="late">late</button>');
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

describe('rowTabStops: the rest of the row, always', () => {
	function setupRow(html: string, outside = false) {
		const row = document.createElement('div');
		row.innerHTML = html;
		document.body.append(row);
		rows.push(row);
		const action = rowTabStops(row, outside);
		const get = (k: string) => row.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
		return { row, action, get };
	}

	it('takes every control out inside the window, except the cell editor', () => {
		const { get } = setupRow(
			'<div class="select-cell"><input type="checkbox" data-k="box" /></div>' +
				'<div class="cell"><a href="/x" data-k="link">x</a></div>' +
				'<div class="cell"><button data-k="btn">b</button><span tabindex="0" data-k="span">s</span></div>' +
				'<div class="cell editing"><input data-k="editor" /></div>'
		);
		for (const k of ['box', 'link', 'btn', 'span'])
			expect(get(k).getAttribute('tabindex')).toBe(SUPPRESSED_TABINDEX);
		expect(get('editor').hasAttribute('tabindex')).toBe(false);
		expect(get('editor').hasAttribute(SAVED_TABINDEX_ATTR)).toBe(false);
	});

	it('stays out when the row goes out of the window and comes back', () => {
		const { action, get } = setupRow(
			'<div class="cell"><button data-k="btn">b</button></div>' +
				'<div class="cell editing"><input data-k="editor" /></div>'
		);
		action.update(true);
		expect(get('btn').getAttribute('tabindex')).toBe(SUPPRESSED_TABINDEX);
		expect(get('editor').getAttribute('tabindex')).toBe(SUPPRESSED_TABINDEX);
		action.update(false);
		expect(get('btn').getAttribute('tabindex')).toBe(SUPPRESSED_TABINDEX);
		expect(get('editor').hasAttribute('tabindex')).toBe(false);
	});

	it('takes out what the host draws or makes focusable later, and a tabindex it writes', async () => {
		const { row, get } = setupRow(
			'<div class="cell"><a data-k="l">l</a><button data-k="btn">b</button></div>'
		);
		await reported();
		row.firstElementChild!.insertAdjacentHTML('beforeend', '<button data-k="late">late</button>');
		get('l').setAttribute('href', '/x');
		get('btn').setAttribute('tabindex', '0');
		await reported();
		for (const k of ['late', 'l', 'btn'])
			expect(get(k).getAttribute('tabindex')).toBe(SUPPRESSED_TABINDEX);
		expect(get('btn').getAttribute(SAVED_TABINDEX_ATTR)).toBe('0');
	});

	it('leaves an editor that is drawn later alone, and takes out the view drawn after it', async () => {
		const { row, get } = setupRow('<div class="cell" data-k="cell"><a href="/x">x</a></div>');
		const cell = get('cell');
		// What Svelte does when the cell enters its editor, in one task.
		cell.classList.add('editing');
		cell.innerHTML = '<input data-k="editor" />';
		await reported();
		expect(get('editor').hasAttribute('tabindex')).toBe(false);
		cell.classList.remove('editing');
		cell.innerHTML = '<a href="/x" data-k="link">x</a>';
		await reported();
		expect(row.querySelector('[data-k="link"]')!.getAttribute('tabindex')).toBe(
			SUPPRESSED_TABINDEX
		);
	});

	it('cellControls: what was a tab stop, in order; not a disabled one, not one the host kept out', () => {
		const { get } = setupRow(
			'<div class="cell" data-k="cell"><button data-k="a">a</button>' +
				'<button data-k="off" disabled>off</button>' +
				'<span tabindex="-1" data-k="minus">m</span>' +
				'<a href="/x" data-k="b">b</a><span tabindex="0" data-k="c">c</span></div>'
		);
		expect(cellControls(get('cell')).map((el) => el.dataset.k)).toEqual(['a', 'b', 'c']);
	});

	it('cellControls: leaves out what cannot take focus (hidden input, hidden / display:none / visibility:hidden, inert)', () => {
		const { get } = setupRow(
			'<div class="cell" data-k="cell"><input type="hidden" data-k="h0" />' +
				'<button data-k="a">a</button>' +
				'<div hidden><button data-k="h1">x</button></div>' +
				'<div style="display:none"><button data-k="h2">x</button></div>' +
				'<button style="visibility:hidden" data-k="h3">x</button>' +
				'<div inert><button data-k="h4">x</button></div>' +
				'<button data-k="b">b</button></div>'
		);
		expect(cellControls(get('cell')).map((el) => el.dataset.k)).toEqual(['a', 'b']);
	});
});
