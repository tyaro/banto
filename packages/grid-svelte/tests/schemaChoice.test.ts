/** columnsFromSchema for the radio / multiselect field types (Issue #714). */
import { describe, expect, it } from 'vitest';
import { columnsFromSchema } from '../src/core/schema';

interface Row {
	color: string | number;
	tags: Array<string | number> | null;
}

const row = {} as Row;
const options = [
	{ value: 'a', label: '赤' },
	{ value: 2, label: '青' }
];

describe('columnsFromSchema: radio / multiselect (#714)', () => {
	const columns = columnsFromSchema<Row>({
		fields: [
			{ name: 'color', label: '色', type: 'radio', options, required: true },
			{ name: 'tags', label: 'タグ', type: 'multiselect', options }
		]
	});

	it('derives a radio like a select: the label shown and a select editor', () => {
		const color = columns.find((c) => c.id === 'color')!;
		expect(color.editable).toBe(true);
		expect(color.editor).toBe('select');
		expect(color.editorOptions).toEqual(options);
		expect(color.format?.(2, row)).toBe('青');
		expect(color.format?.('zz', row)).toBe('zz');
		expect(color.validate?.('', row)).toBe('必須項目です');
	});

	it('shows a multiselect array as its labels joined with 、, display only', () => {
		const tags = columns.find((c) => c.id === 'tags')!;
		expect(tags.editable).toBeUndefined();
		expect(tags.format?.(['a', 2], row)).toBe('赤、青');
		expect(tags.format?.(['x'], row)).toBe('x');
		expect(tags.format?.([], row)).toBe('');
		expect(tags.format?.(null, row)).toBe('');
	});
});
