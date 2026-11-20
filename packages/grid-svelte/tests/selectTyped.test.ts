// @vitest-environment jsdom
/**
 * A select cell edit keeps the option's type (#714 review): `2` and `'2'` are
 * different options, so the `<select>` carries the option's index, not
 * `String(value)`, and the commit keeps a draft that already is an option
 * value instead of re-matching its text.
 */
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CellEditor from '../src/CellEditor.svelte';
import { resolveSelectDraft } from '../src/core/clipboard';

afterEach(cleanup);

const options = [
	{ value: 2, label: 'Two (number)' },
	{ value: '2', label: 'Two (text)' }
];

function renderSelect(draft: unknown, onDraftChange = vi.fn()) {
	const { container } = render(CellEditor, {
		editor: 'select',
		label: 'Kind',
		invalid: false,
		describedBy: undefined,
		pending: false,
		draft,
		options,
		editorEl: undefined,
		editorRootEl: undefined,
		onDraftChange,
		onToggle: vi.fn(),
		onKeydown: vi.fn(),
		onBlur: vi.fn()
	});
	return { select: container.querySelector('select')!, onDraftChange };
}

describe('select cell editor keeps the option type (#714 review)', () => {
	it('picking the text option yields the text value, not the number', async () => {
		const { select, onDraftChange } = renderSelect(2);
		expect(select.value).toBe('0');
		select.value = '1';
		await fireEvent.change(select);
		expect(onDraftChange).toHaveBeenCalledWith('2');
	});

	it('shows the typed option for a text draft', () => {
		const { select } = renderSelect('2');
		expect(select.value).toBe('1');
	});

	it('commit keeps a draft that already is an option value; text falls back to the first match', () => {
		expect(resolveSelectDraft('2', options)).toBe('2');
		expect(resolveSelectDraft(2, options)).toBe(2);
		expect(resolveSelectDraft(' 2', [{ value: ' 2', label: 'x' }])).toBe(' 2');
		// Paste-like text that is no option value: first string match.
		expect(resolveSelectDraft(3, [{ value: '3', label: 'x' }])).toBe('3');
	});
});
