import { describe, expect, it } from 'vitest';
import {
	classifyDraft,
	inferTouchKind,
	isWritableNumber,
	normalizeDraft,
	openDraft,
	pressNumberKey,
	resolveNumberRules,
	type DraftState,
	type NumberKey,
	type NumberRules
} from '../src/core/number';
import { formatDec, parseDec } from '../src/core/decimal';

const free = { decimals: 3, allowNegative: true };

function type(start: string, keys: NumberKey[], rules = free): DraftState {
	return keys.reduce((s, k) => pressNumberKey(s, k, rules), openDraft(start));
}

describe('pressNumberKey', () => {
	it('the first digit replaces the current value', () => {
		expect(type('42', ['7']).text).toBe('7');
		expect(type('42', ['7', '5']).text).toBe('75');
	});
	it('the first backspace trims the current value', () => {
		expect(type('42', ['backspace']).text).toBe('4');
		expect(type('42', ['backspace', '9']).text).toBe('49');
	});
	it('the first dot starts a fresh draft', () => {
		expect(type('42', ['.', '5']).text).toBe('.5');
	});
	it('limits fractional digits to decimals and ignores a second dot', () => {
		expect(type('', ['1', '.', '2', '3', '4', '5']).text).toBe('1.234');
		expect(type('', ['1', '.', '.', '2']).text).toBe('1.2');
		expect(type('', ['1', '.'], { decimals: 0, allowNegative: true }).text).toBe('1');
	});
	it('sign toggles anywhere and works on empty', () => {
		expect(type('', ['sign']).text).toBe('-');
		expect(type('', ['sign', '5']).text).toBe('-5');
		expect(type('', ['5', 'sign']).text).toBe('-5');
		expect(type('', ['5', 'sign', 'sign']).text).toBe('5');
		expect(type('7', ['sign', '3']).text).toBe('-73'); // sign edits the current value, then keeps typing
		expect(type('', ['sign'], { decimals: 0, allowNegative: false }).text).toBe('');
	});
	it('stops at 15 significant digits', () => {
		const keys = Array<NumberKey>(20).fill('1');
		expect(type('', keys, { decimals: 14, allowNegative: true }).text).toBe('1'.repeat(15));
	});
	it('does not stack leading zeros', () => {
		expect(type('', ['0', '0', '7']).text).toBe('7');
		expect(type('', ['0', '.', '5']).text).toBe('0.5');
	});
	it('backspace and clear', () => {
		expect(type('', ['1', '2', 'backspace']).text).toBe('1');
		expect(type('99', ['1', '2', 'clear']).text).toBe('');
	});
});

const open: NumberRules = resolveNumberRules({ inputmode: 'decimal' })!;
const req: NumberRules = resolveNumberRules({ inputmode: 'decimal', required: true })!;

describe('classifyDraft', () => {
	it('empty: optional is confirmable, required is not', () => {
		expect(classifyDraft('', open)).toEqual({ kind: 'empty', canConfirm: true, notice: null });
		expect(classifyDraft('', req)).toEqual({
			kind: 'empty',
			canConfirm: false,
			notice: 'required'
		});
	});
	it.each(['-', '.', '-.'])('partial %s cannot be confirmed and is silent', (t) => {
		expect(classifyDraft(t, open)).toEqual({ kind: 'partial', canConfirm: false });
	});
	it.each([
		['12', '12'],
		['0.15', '0.15'],
		['1.', '1'],
		['.5', '0.5'],
		['-0', '0'],
		['007', '7']
	])('valid %s -> %s', (t, v) => {
		expect(classifyDraft(t, open)).toEqual({ kind: 'valid', canConfirm: true, value: v });
	});
	it('range', () => {
		const r = resolveNumberRules({ inputmode: 'decimal', min: '10', max: '20' })!;
		expect(classifyDraft('1', r)).toMatchObject({
			kind: 'invalid',
			reason: 'range',
			min: '10',
			max: '20'
		});
		expect(classifyDraft('21', r)).toMatchObject({ kind: 'invalid', reason: 'range' });
		expect(classifyDraft('10', r).canConfirm).toBe(true);
		expect(classifyDraft('20', r).canConfirm).toBe(true);
	});
	it('negative not allowed', () => {
		const r = resolveNumberRules({ inputmode: 'decimal' }, { allowNegative: false })!;
		expect(classifyDraft('-1', r)).toMatchObject({ kind: 'invalid', reason: 'range' });
	});
	it('step with min as base: 0.10 is not allowed, 0.05 and 0.15 are', () => {
		const r = resolveNumberRules({ type: 'number', min: '0.05', step: '0.10' })!;
		expect(classifyDraft('0.10', r)).toMatchObject({
			kind: 'invalid',
			reason: 'step',
			lower: '0.05',
			upper: '0.15'
		});
		expect(classifyDraft('0.05', r).canConfirm).toBe(true);
		expect(classifyDraft('0.15', r).canConfirm).toBe(true);
		expect(r.decimals).toBe(2);
	});
	it('step with the value attribute as base', () => {
		const r = resolveNumberRules({ type: 'number', value: '1', step: '2' })!;
		expect(classifyDraft('3', r).canConfirm).toBe(true);
		expect(classifyDraft('2', r)).toMatchObject({ reason: 'step', lower: '1', upper: '3' });
	});
	it('base defaults to 0; missing step is 1; any means no step', () => {
		const n = resolveNumberRules({ type: 'number' })!;
		expect(classifyDraft('2.5', n)).toMatchObject({ reason: 'step', lower: '2', upper: '3' });
		const any = resolveNumberRules({ type: 'number', step: 'any' })!;
		expect(classifyDraft('2.5', any).canConfirm).toBe(true);
		const bad = resolveNumberRules({ type: 'number', step: '-3' })!;
		expect(bad.steps[0]!.step).toEqual(parseDec('1'));
	});
	it('negative base', () => {
		const r = resolveNumberRules({ type: 'number', min: '-1', step: '2' })!;
		expect(classifyDraft('-1', r).canConfirm).toBe(true);
		expect(classifyDraft('1', r).canConfirm).toBe(true);
		expect(classifyDraft('0', r)).toMatchObject({ reason: 'step', lower: '-1', upper: '1' });
		expect(
			classifyDraft('-3', resolveNumberRules({ type: 'number', step: '2', value: '-1' })!)
				.canConfirm
		).toBe(true);
	});
	it('floating-point trouble pairs are decided on integers', () => {
		const r = resolveNumberRules({ type: 'number', step: '0.1' })!;
		for (const v of ['0.1', '0.2', '0.3', '0.7', '1.1'])
			expect(classifyDraft(v, r).canConfirm).toBe(true);
		expect(classifyDraft('0.15', r).canConfirm).toBe(false);
		const r2 = resolveNumberRules({ type: 'number', min: '0.1', step: '0.2' })!;
		expect(classifyDraft('0.3', r2).canConfirm).toBe(true);
	});
	it('below the base floors correctly', () => {
		const r = resolveNumberRules({ type: 'number', min: '0', step: '5' }, { allowNegative: true })!;
		const s = classifyDraft('-3', r);
		expect(s.kind === 'invalid' && s.reason).toBe('range');
		const r2 = resolveNumberRules({ type: 'number', value: '0', step: '5' })!;
		expect(classifyDraft('-3', r2)).toMatchObject({ reason: 'step', lower: '-5', upper: '0' });
	});
});

describe('normalizeDraft / isWritableNumber', () => {
	it('canonical write form', () => {
		expect(normalizeDraft('1.')).toBe('1');
		expect(normalizeDraft('.5')).toBe('0.5');
		expect(normalizeDraft('-0')).toBe('0');
		expect(normalizeDraft('-0.0')).toBe('0.0');
		expect(normalizeDraft('007.50')).toBe('7.50');
		expect(normalizeDraft('1.5')).toBe('1.5');
		expect(normalizeDraft('-')).toBeNull();
		expect(normalizeDraft('')).toBeNull();
		expect(normalizeDraft('1e3')).toBeNull();
	});
	it('only a valid floating-point number may be written', () => {
		for (const ok of ['0', '-3', '1.5', '-0.25']) expect(isWritableNumber(ok)).toBe(true);
		for (const ng of ['', '-', '.', '1.', '.5', '1e3', '+1', ' 1', '1,5'])
			expect(isWritableNumber(ng)).toBe(false);
	});
});

describe('resolveNumberRules (attributes)', () => {
	it('is null for non-numeric fields unless forced', () => {
		expect(resolveNumberRules({ type: 'text' })).toBeNull();
		expect(resolveNumberRules({})).toBeNull();
		expect(resolveNumberRules({ type: 'text' }, {}, { force: true })).not.toBeNull();
	});
	it('inputmode: numeric has no decimals, decimal has up to the cap', () => {
		expect(resolveNumberRules({ inputmode: 'numeric' })!.decimals).toBe(0);
		expect(resolveNumberRules({ inputmode: 'decimal' })!.decimals).toBe(14);
	});
	it('inputmode: no attributes means no constraints; attributes are used when present', () => {
		const r = resolveNumberRules({ type: 'text', inputmode: 'decimal' })!;
		expect(r.min).toBeNull();
		expect(r.steps).toEqual([]);
		const r2 = resolveNumberRules({ inputmode: 'decimal', min: '1', max: '9', step: '0.5' })!;
		expect(r2.steps).toHaveLength(1);
		expect(r2.decimals).toBe(1);
		expect(classifyDraft('1.25', r2).canConfirm).toBe(false);
	});
	it('type=number without min and with a negative-free min hides the sign', () => {
		expect(resolveNumberRules({ type: 'number' })!.allowNegative).toBe(true);
		expect(resolveNumberRules({ type: 'number', min: '0' })!.allowNegative).toBe(false);
		expect(resolveNumberRules({ type: 'number', min: '-5' })!.allowNegative).toBe(true);
	});
	it('explicit spec wins over attributes for inputmode', () => {
		const r = resolveNumberRules(
			{ inputmode: 'decimal', min: '0', max: '10' },
			{ min: 5, max: 6, step: 0.5, decimals: 1 }
		)!;
		expect(formatDec(r.min!)).toBe('5');
		expect(formatDec(r.max!)).toBe('6');
		expect(r.decimals).toBe(1);
	});
	it('type=number: a spec can tighten but never loosen the attributes', () => {
		const r = resolveNumberRules({ type: 'number', min: '10', max: '20' }, { min: 0, max: 100 })!;
		expect(formatDec(r.min!)).toBe('10');
		expect(formatDec(r.max!)).toBe('20');
		const t = resolveNumberRules({ type: 'number', min: '10', max: '20' }, { min: 12, max: 15 })!;
		expect(formatDec(t.min!)).toBe('12');
		expect(formatDec(t.max!)).toBe('15');
	});
	it('type=number: the attribute step still applies next to a spec step', () => {
		const r = resolveNumberRules({ type: 'number' }, { step: 0.5 })!;
		expect(r.steps).toHaveLength(2);
		expect(classifyDraft('0.5', r).canConfirm).toBe(false);
		const loose = resolveNumberRules({ type: 'number', step: 'any' }, { step: 0.5 })!;
		expect(classifyDraft('0.5', loose).canConfirm).toBe(true);
		expect(classifyDraft('0.3', loose).canConfirm).toBe(false);
	});
	it('required: spec before attribute', () => {
		expect(resolveNumberRules({ inputmode: 'numeric', required: true })!.required).toBe(true);
		expect(
			resolveNumberRules({ inputmode: 'numeric', required: true }, { required: false })!.required
		).toBe(false);
	});
});

describe('inferTouchKind', () => {
	it.each([
		[{ type: 'number' }, 'number'],
		[{ type: 'text', inputmode: 'numeric' }, 'number'],
		[{ inputmode: 'decimal' }, 'number'],
		[{ type: 'text' }, 'text'],
		[{}, 'text'],
		[{ type: 'search' }, 'text'],
		[{ type: 'tel' }, 'text'],
		[{ type: 'url' }, 'text'],
		[{ type: 'email' }, 'text'],
		[{ type: 'password' }, 'password'],
		[{ type: 'date' }, 'off'],
		[{ type: 'color' }, 'off'],
		[{ type: 'text', readonly: true }, 'off'],
		[{ type: 'text', disabled: true }, 'off'],
		[{ type: 'number', touchKeys: 'off' }, 'off'],
		[{ tagName: 'TEXTAREA' }, 'off'],
		[{ tagName: 'select' }, 'off']
	])('%j -> %s', (attrs, kind) => {
		expect(inferTouchKind(attrs)).toBe(kind);
	});
});
