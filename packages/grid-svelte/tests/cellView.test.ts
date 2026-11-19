import { describe, expect, it, vi } from 'vitest';
import {
	cellText,
	resolveCellPresentation,
	resolveCellView,
	resolveTone,
	safeHref
} from '../src/core/cellView';
import { isColumnEditable } from '../src/core/edit';
import { rangeToTsv } from '../src/core/clipboard';
import { getColumnValue } from '../src/core/sort';
import type { GridColumn } from '../src/types';

interface Row {
	id: number;
	status: string;
	done: number | string | null;
	ok: boolean | null;
	url: string;
}

const row: Row = { id: 1, status: '稼働', done: 0.25, ok: true, url: '/items/1' };
const col = (extra: Partial<GridColumn<Row>>): GridColumn<Row> => ({
	id: 'c',
	header: 'C',
	accessor: 'status',
	...extra
});

describe('resolveCellView (#713)', () => {
	it('plain text without a renderer, using format and blank for null', () => {
		expect(resolveCellView(col({}), row)).toEqual({ kind: 'text', text: '稼働' });
		expect(cellText(col({ accessor: 'ok' }), { ...row, ok: null })).toBe('');
		expect(resolveCellView(col({ format: (v) => `[${v}]` }), row)).toEqual({
			kind: 'text',
			text: '[稼働]'
		});
	});

	it('badge keeps the formatted text; an empty value stays plain', () => {
		expect(resolveCellView(col({ renderer: 'badge' }), row)).toEqual({
			kind: 'badge',
			text: '稼働'
		});
		expect(resolveCellView(col({ renderer: 'badge' }), { ...row, status: '' }).kind).toBe('text');
	});

	it('progress: 0..1 by default, clamped, percent label unless format is given', () => {
		const c = col({ renderer: 'progress', accessor: 'done' });
		expect(resolveCellView(c, row)).toEqual({ kind: 'progress', ratio: 0.25, text: '25%' });
		expect(resolveCellView(c, { ...row, done: 3 })).toMatchObject({ ratio: 1, text: '100%' });
		expect(resolveCellView(c, { ...row, done: -1 })).toMatchObject({ ratio: 0, text: '0%' });
		expect(resolveCellView(c, { ...row, done: '0.5' })).toMatchObject({ ratio: 0.5 });
		expect(resolveCellView({ ...c, format: (v) => `${v}/4` }, row)).toMatchObject({
			text: '0.25/4'
		});
	});

	it('progress: progressMax scales the value; a bad max falls back to 1', () => {
		const c = col({ renderer: 'progress', accessor: 'done', progressMax: 200 });
		expect(resolveCellView(c, { ...row, done: 50 })).toMatchObject({ ratio: 0.25, text: '25%' });
		expect(resolveCellView({ ...c, progressMax: 0 }, row)).toMatchObject({ ratio: 0.25 });
	});

	it('progress: a non-numeric value degrades to text', () => {
		const c = col({ renderer: 'progress', accessor: 'done' });
		expect(resolveCellView(c, { ...row, done: null }).kind).toBe('text');
		expect(resolveCellView(c, { ...row, done: 'abc' }).kind).toBe('text');
		expect(resolveCellView(c, { ...row, done: NaN }).kind).toBe('text');
	});

	it('boolean: only real booleans', () => {
		const c = col({ renderer: 'boolean', accessor: 'ok' });
		expect(resolveCellView(c, row)).toEqual({ kind: 'boolean', checked: true });
		expect(resolveCellView(c, { ...row, ok: false })).toEqual({ kind: 'boolean', checked: false });
		expect(resolveCellView(c, { ...row, ok: null }).kind).toBe('text');
	});

	it('link: needs a safe href', () => {
		const c = col({ renderer: 'link', href: (r) => r.url });
		expect(resolveCellView(c, row)).toEqual({ kind: 'link', text: '稼働', href: '/items/1' });
		expect(resolveCellView(col({ renderer: 'link' }), row).kind).toBe('text');
		expect(resolveCellView({ ...c, href: () => 'javascript:alert(1)' }, row).kind).toBe('text');
		expect(resolveCellView({ ...c, format: () => '' }, row)).toMatchObject({ text: '/items/1' });
	});
});

describe('safeHref', () => {
	it('allows http(s), mailto, tel and relative references', () => {
		for (const h of [
			'https://a.test/x',
			'http://a',
			'mailto:a@b',
			'tel:123',
			'/x',
			'./x',
			'#a',
			'?q=1',
			'x/y'
		])
			expect(safeHref(h)).toBe(h);
	});
	it('rejects scripts, data, obfuscated schemes and blanks', () => {
		for (const h of [
			'javascript:alert(1)',
			' JavaScript:1',
			'java\tscript:1',
			'data:text/html,x',
			'vbscript:x',
			'',
			'  '
		])
			expect(safeHref(h)).toBeNull();
		expect(safeHref(undefined)).toBeNull();
	});
});

describe('resolveTone', () => {
	it('returns the known tones and null otherwise', () => {
		const c = col({ tone: (v) => (v === '稼働' ? 'success' : null) });
		expect(resolveTone(c, row)).toBe('success');
		expect(resolveTone(c, { ...row, status: '停止' })).toBeNull();
		expect(resolveTone(col({}), row)).toBeNull();
		expect(resolveTone(col({ tone: () => 'purple' as never }), row)).toBeNull();
	});
	it('passes the raw value (not the formatted text) and the row', () => {
		const seen: unknown[] = [];
		resolveTone(
			col({
				accessor: 'done',
				format: () => 'x',
				tone: (v, r) => {
					seen.push(v, r.id);
					return 'info';
				}
			}),
			row
		);
		expect(seen).toEqual([0.25, 1]);
	});
});

describe('renderers with editing and copy', () => {
	it('link is never editable; badge / progress / boolean follow editable', () => {
		expect(isColumnEditable(col({ renderer: 'link', editable: true }), row)).toBe(false);
		for (const renderer of ['badge', 'progress', 'boolean'] as const) {
			expect(isColumnEditable(col({ renderer, editable: true }), row)).toBe(true);
			expect(isColumnEditable(col({ renderer }), row)).toBe(false);
		}
	});
	it('copy still uses the raw value', () => {
		const c = col({ accessor: 'done', renderer: 'progress', format: () => '25%' });
		const tsv = rangeToTsv(
			[row],
			[c],
			{ rowStart: 0, rowEnd: 0, fieldStart: 0, fieldEnd: 0 },
			getColumnValue
		);
		expect(tsv).toBe('0.25');
	});
});

describe('accessor reads (#713)', () => {
	it('reads the value once per cell for view, text and presentation', () => {
		const accessor = vi.fn((r: Row) => r.status);
		const c = col({ accessor, renderer: 'badge', tone: () => 'success' });
		resolveCellView(c, row);
		expect(accessor).toHaveBeenCalledTimes(1);
		accessor.mockClear();
		resolveCellView(col({ accessor }), row);
		expect(accessor).toHaveBeenCalledTimes(1);
		accessor.mockClear();
		expect(resolveCellPresentation(c, row)).toEqual({
			view: { kind: 'badge', text: '稼働' },
			tone: 'success'
		});
		expect(accessor).toHaveBeenCalledTimes(1);
	});
});
