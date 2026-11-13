/**
 * CSV import of a resource list (spec M15, ADR-0030 stage 5). Issue #218: the
 * preview renders only the first N rows, tells create from update, and the
 * request is built from the same validated rows as the preview.
 */
import { describe, expect, it } from 'vitest';
import type { FormSchema } from '@banto/forms';
import { resourceColumns } from './columns';
import {
	IMPORT_PREVIEW_ROW_LIMIT,
	buildImportPreview,
	canRunImport,
	importRowKind,
	importStatusVariant,
	numericFields,
	parseIdCell,
	previewImportFields,
	previewRows,
	requiredImportFields,
	toImportPayload,
	withImportResult,
	type ImportRowPreview
} from './csvImport';
import { defineResource } from './types';

const schema: FormSchema = {
	fields: [
		{ name: 'name', label: 'Name', type: 'text', required: true },
		{ name: 'price', label: 'Price', type: 'number', required: true, min: 0 },
		{ name: 'note', label: 'Note', type: 'text' },
		{ name: 'updatedAt', label: 'Updated', type: 'date', readonly: true, required: true }
	]
};

const resource = defineResource({
	name: 'things',
	label: 'Thing',
	path: '/settings',
	schema,
	capabilities: { list: true, create: true, edit: true }
});

const columns = () => resourceColumns(resource);

function makeRows(count: number): ImportRowPreview[] {
	return Array.from({ length: count }, (_, i) => ({
		csvLine: i + 2,
		// 偶数番目は id あり（更新）、奇数番目は id なし（新規）
		id: i % 2 === 0 ? 100 + i : undefined,
		values: { name: `商品${i}`, price: 10 * i },
		errors: []
	}));
}

describe('requiredImportFields / previewImportFields', () => {
	it('既定はスキーマの required で readonly でない欄', () => {
		expect(requiredImportFields(resource, {})).toEqual(['name', 'price']);
		expect(previewImportFields(resource, {})).toEqual(['name', 'price']);
	});

	it('定義で指定できる', () => {
		expect(requiredImportFields(resource, { required: ['name'] })).toEqual(['name']);
		expect(previewImportFields(resource, { required: ['name'] })).toEqual(['name']);
		expect(previewImportFields(resource, { preview: ['note', 'price'] })).toEqual([
			'note',
			'price'
		]);
	});

	it('number の欄は右寄せの対象', () => {
		expect([...numericFields(resource)]).toEqual(['price']);
	});
});

describe('parseIdCell', () => {
	it('空欄は新規、整数は更新、それ以外はエラー', () => {
		expect(parseIdCell('  ')).toEqual({});
		expect(parseIdCell(' 7 ')).toEqual({ id: 7 });
		expect(parseIdCell('1.5').error).toBeTruthy();
		expect(parseIdCell('abc').error).toBeTruthy();
	});

	it("idType 'string' は空欄以外をそのまま id にする", () => {
		expect(parseIdCell(' A-01 ', 'string')).toEqual({ id: 'A-01' });
		expect(parseIdCell('', 'string')).toEqual({});
	});
});

describe('buildImportPreview', () => {
	it('空のファイルは null', () => {
		expect(buildImportPreview(resource, {}, columns(), 'a.csv', '')).toBeNull();
	});

	it('必須の列が欠けたら行を作らない', () => {
		const preview = buildImportPreview(resource, {}, columns(), 'a.csv', 'name\nfoo')!;
		expect(preview.missingRequired).toEqual(['price']);
		expect(preview.rows).toEqual([]);
		expect(canRunImport(preview)).toBe(false);
		expect(importStatusVariant(preview)).toBe('danger');
	});

	it('id は手で読み、読み取り専用の列は書かず、知らない列は無視として出す', () => {
		const text = 'id,name,price,updatedAt,extra\n,foo,10,2026-01-01,x\n3,bar,20,,y';
		const preview = buildImportPreview(resource, {}, columns(), 'a.csv', text)!;
		expect(preview.ignoredHeaders).toEqual(['extra']);
		expect(preview.writtenFields).toEqual(['name', 'price']);
		expect(preview.rows.map((row) => [row.csvLine, row.id, row.values])).toEqual([
			[2, undefined, { name: 'foo', price: 10 }],
			[3, 3, { name: 'bar', price: 20 }]
		]);
		expect(canRunImport(preview)).toBe(true);
		expect(importStatusVariant(preview)).toBe('success');
	});

	it('変換できない値と整数でない id は行のエラー', () => {
		const text = 'id,name,price\nx,foo,abc';
		const preview = buildImportPreview(resource, {}, columns(), 'a.csv', text)!;
		const columnIds = preview.rows[0].errors.map((e) => e.columnId).sort();
		expect(columnIds).toEqual(['id', 'price']);
		expect(canRunImport(preview)).toBe(false);
		expect(importStatusVariant(preview)).toBe('warning');
	});

	it("idType 'string' の id はそのまま送る", () => {
		const text = 'id,name,price\nA-01,foo,1';
		const preview = buildImportPreview(resource, { idType: 'string' }, columns(), 'a.csv', text)!;
		expect(toImportPayload(preview.rows)).toEqual([{ id: 'A-01', name: 'foo', price: 1 }]);
	});
});

describe('importRowKind', () => {
	it('id あり = 更新、なし = 新規', () => {
		expect(importRowKind({ id: 5 })).toBe('update');
		expect(importRowKind({ id: 0 })).toBe('update');
		expect(importRowKind({ id: 'A' })).toBe('update');
		expect(importRowKind({ id: undefined })).toBe('create');
	});
});

describe('previewRows', () => {
	it('上限を超える行は先頭 N 行だけを返す', () => {
		const rows = makeRows(IMPORT_PREVIEW_ROW_LIMIT + 25);
		const shown = previewRows(rows);
		expect(shown).toHaveLength(IMPORT_PREVIEW_ROW_LIMIT);
		expect(shown).toEqual(rows.slice(0, IMPORT_PREVIEW_ROW_LIMIT));
		expect(shown[0].csvLine).toBe(2);
	});

	it('上限以下なら全行を返す', () => {
		expect(previewRows(makeRows(3))).toHaveLength(3);
		expect(previewRows([])).toEqual([]);
	});

	it('limit を指定できる', () => {
		expect(previewRows(makeRows(8), 2)).toHaveLength(2);
	});

	it('表示行は新規/更新が混在しても区別できる', () => {
		const kinds = previewRows(makeRows(4)).map(importRowKind);
		expect(kinds).toEqual(['update', 'create', 'update', 'create']);
	});
});

describe('toImportPayload (プレビューと同じ行)', () => {
	it('プレビューに出る行は、送信ペイロードの先頭と同じ値になる', () => {
		const rows = makeRows(IMPORT_PREVIEW_ROW_LIMIT + 5);
		const payload = toImportPayload(rows);
		// 送信は全行（プレビューの表示行数に切り詰めない）
		expect(payload).toHaveLength(rows.length);
		previewRows(rows).forEach((row, i) => {
			expect(payload[i]).toEqual({ id: row.id, ...row.values });
		});
	});
});

describe('withImportResult', () => {
	const preview = () =>
		buildImportPreview(resource, {}, columns(), 'a.csv', 'name,price\nfoo,1\nbar,2')!;

	it('全件取り消し: エラーを残し、直して再実行できる状態は変えない', () => {
		const next = withImportResult(preview(), {
			created: 0,
			updated: 0,
			errors: [{ row: 1, message: 'dup' }]
		});
		expect(next.serverErrors).toEqual([{ row: 1, message: 'dup' }]);
		expect(next.applied).toBeNull();
		expect(importStatusVariant(next)).toBe('danger');
	});

	it('一部だけ反映: 反映した件数を覚え、同じファイルの再実行を止める', () => {
		const next = withImportResult(preview(), {
			created: 1,
			updated: 0,
			errors: [{ row: 1, message: 'dup' }]
		});
		expect(next.applied).toEqual({ created: 1, updated: 0 });
		expect(canRunImport(next)).toBe(false);
	});
});
