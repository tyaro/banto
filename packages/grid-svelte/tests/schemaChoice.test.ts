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

describe('columnsFromSchema: reference (#714)', () => {
	interface Task {
		owner: number | null;
	}
	const task = {} as Task;
	const fields = [{ name: 'owner', label: '担当者', type: 'reference' as const, required: true }];

	it('is display only and shows the stored id as it is', () => {
		const [owner] = columnsFromSchema<Task>({ fields });
		expect(owner.header).toBe('担当者');
		expect(owner.editable).toBeUndefined();
		expect(owner.editor).toBeUndefined();
		expect(owner.validate).toBeUndefined();
		expect(owner.format).toBeUndefined();
		expect(owner.filterable).toBeUndefined();
	});

	it('takes a format from overrides to show a name the app already has', () => {
		const names = new Map([[2, '青山']]);
		const [owner] = columnsFromSchema<Task>(
			{ fields },
			{ overrides: { owner: { format: (value) => names.get(value as number) ?? String(value) } } }
		);
		expect(owner.format?.(2, task)).toBe('青山');
	});
});
