/**
 * Pure text-keyboard core (touch-keypad-design §14.1): key tables, key entry,
 * the maximum length, and "every printable ASCII character is reachable" for
 * password fields (§5.5) - counted mechanically from the tables.
 */
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_TEXT_LAYOUTS,
	applyKanaMark,
	classifyText,
	kanaMarked,
	pressTextKey,
	reachableChars,
	resolveTextLayouts,
	resolveTextRules,
	textKeyRows
} from '../src/core/text';

const type = (text: string, chars: string, maxLength?: number): string =>
	[...chars].reduce((acc, char) => pressTextKey(acc, { char }, { maxLength }), text);

describe('textKeyRows', () => {
	it('alnum: a digit row and three QWERTY rows; upper case changes letters only', () => {
		expect(textKeyRows('alnum').map((r) => r.join(''))).toEqual([
			'1234567890',
			'qwertyuiop',
			'asdfghjkl',
			'zxcvbnm'
		]);
		expect(textKeyRows('alnum', { upper: true }).map((r) => r.join(''))).toEqual([
			'1234567890',
			'QWERTYUIOP',
			'ASDFGHJKL',
			'ZXCVBNM'
		]);
	});

	it('symbol: the short set for ordinary fields', () => {
		expect(textKeyRows('symbol').flat().join(' ')).toBe('- _ . , / : @ # ( ) + * = % & ! ?');
	});

	it('symbol (full): all 32 printable ASCII symbols, each once', () => {
		const keys = textKeyRows('symbol', { fullSymbols: true }).flat();
		expect(keys).toHaveLength(32);
		expect(new Set(keys).size).toBe(32);
	});

	it('no row is wider than ten keys and every key is one UTF-16 code unit', () => {
		for (const layout of ['alnum', 'symbol'] as const) {
			for (const fullSymbols of [false, true]) {
				for (const upper of [false, true]) {
					for (const row of textKeyRows(layout, { upper, fullSymbols })) {
						expect(row.length).toBeLessThanOrEqual(10);
						for (const k of row) expect(k).toHaveLength(1);
					}
				}
			}
		}
	});
});

describe('reachableChars (§5.5)', () => {
	it('a password keyboard reaches exactly the 95 printable ASCII characters U+0020..U+007E', () => {
		const want = new Set<string>();
		for (let code = 0x20; code <= 0x7e; code++) want.add(String.fromCharCode(code));
		const got = reachableChars(resolveTextLayouts(undefined, true), { fullSymbols: true });
		expect(want.size).toBe(95);
		expect([...got].sort()).toEqual([...want].sort());
	});

	it('the short symbol set does not reach all of them (why password fields use the full one)', () => {
		expect(reachableChars(['alnum', 'symbol']).size).toBeLessThan(95);
	});
});

describe('resolveTextLayouts', () => {
	it('defaults to all, keeps the given order, drops unknown names and duplicates', () => {
		expect(resolveTextLayouts(undefined)).toEqual(['alnum', 'symbol']);
		expect(resolveTextLayouts(['symbol', 'alnum', 'symbol'])).toEqual(['symbol', 'alnum']);
		expect(resolveTextLayouts(['hira', 'alnum'])).toEqual(['alnum']);
		expect(resolveTextLayouts(['hira'])).toEqual(['alnum', 'symbol']);
		expect(resolveTextLayouts([])).toEqual(['alnum', 'symbol']);
	});

	it('a password field always gets every layout', () => {
		expect(resolveTextLayouts(['alnum'], true)).toEqual(['alnum', 'symbol']);
	});
});

describe('resolveTextRules (§9.3)', () => {
	it('reads maxlength and required from the attributes', () => {
		expect(resolveTextRules({ maxlength: '20', minlength: '2', required: true })).toEqual({
			maxLength: 20,
			minLength: 2,
			required: true
		});
		expect(resolveTextRules({})).toEqual({
			maxLength: undefined,
			minLength: undefined,
			required: false
		});
	});

	it('ignores a maxlength that is not a non-negative integer', () => {
		for (const maxlength of ['', 'abc', '-1', '2.5', '1e3']) {
			expect(resolveTextRules({ maxlength }).maxLength, maxlength).toBeUndefined();
		}
		expect(resolveTextRules({}, { maxLength: -1 }).maxLength).toBeUndefined();
		expect(resolveTextRules({}, { maxLength: 2.5 }).maxLength).toBeUndefined();
	});

	it('options tighten but never loosen the attribute', () => {
		expect(resolveTextRules({ maxlength: '20' }, { maxLength: 8 }).maxLength).toBe(8);
		expect(resolveTextRules({ maxlength: '5' }, { maxLength: 8 }).maxLength).toBe(5);
		expect(resolveTextRules({}, { maxLength: 8 }).maxLength).toBe(8);
		expect(resolveTextRules({ required: true }, { required: false }).required).toBe(true);
		expect(resolveTextRules({}, { required: true }).required).toBe(true);
	});

	it('minLength: the larger of options and attribute; 0 is dropped; a minimum above the maximum is KEPT', () => {
		expect(resolveTextRules({ minlength: '2' }, { minLength: 4 }).minLength).toBe(4);
		expect(resolveTextRules({ minlength: '6' }, { minLength: 4 }).minLength).toBe(6);
		expect(resolveTextRules({}, { minLength: 4 }).minLength).toBe(4);
		expect(resolveTextRules({ minlength: '0' }).minLength).toBeUndefined();
		expect(resolveTextRules({ minlength: 'x' }).minLength).toBeUndefined();
		expect(resolveTextRules({ minlength: '9', maxlength: '4' }).minLength).toBe(9);
		// options can not loosen the field's own minlength by naming a smaller maximum
		expect(resolveTextRules({ minlength: '8' }, { maxLength: 6 })).toEqual({
			maxLength: 6,
			minLength: 8,
			required: false
		});
	});

	it('minimum above maximum: no non-empty draft is confirmable (a conflict of the settings); empty follows required', () => {
		const rules = resolveTextRules({ minlength: '8' }, { maxLength: 6 });
		for (const text of ['a', 'abcdef', 'abcdefgh', 'abcdefghij']) {
			expect(classifyText(text, rules)).toEqual({ canConfirm: false, notice: 'length-conflict' });
		}
		expect(classifyText('', rules)).toEqual({ canConfirm: true, notice: null });
		expect(classifyText('', { ...rules, required: true })).toEqual({
			canConfirm: false,
			notice: 'required'
		});
	});
});

describe('pressTextKey (§9.4: the end of the draft only)', () => {
	it('appends, deletes the last character, clears', () => {
		expect(type('ab', 'c D')).toBe('abc D');
		expect(pressTextKey('abc', 'backspace', {})).toBe('ab');
		expect(pressTextKey('', 'backspace', {})).toBe('');
		expect(pressTextKey('abc', 'clear', {})).toBe('');
	});

	it('stops at maxLength; delete and clear still work', () => {
		expect(type('', 'abcdef', 3)).toBe('abc');
		expect(type('abc', 'd', 3)).toBe('abc');
		expect(pressTextKey('abc', 'backspace', { maxLength: 3 })).toBe('ab');
		expect(type('', 'a', 0)).toBe('');
	});

	it('a value that was already over the bound takes no more characters', () => {
		expect(type('abcdef', 'g', 3)).toBe('abcdef');
	});

	it('deleting drops a trailing surrogate pair as a whole', () => {
		expect(pressTextKey('a\u{1F600}', 'backspace', {})).toBe('a');
		expect(pressTextKey('\u{1F600}', 'backspace', {})).toBe('');
		// a lone low surrogate is one unit
		expect(pressTextKey('a\uDE00', 'backspace', {})).toBe('a');
	});
});

describe('classifyText', () => {
	const rules = (maxLength?: number, required = false, minLength?: number) => ({
		maxLength,
		minLength,
		required
	});
	it.each([
		['', rules(), true, null],
		['', rules(undefined, true), false, 'required'],
		['abc', rules(), true, null],
		['ab', rules(3), true, null],
		['abc', rules(3), true, 'max-length'],
		['abcd', rules(3), false, 'max-length'],
		[' ', rules(undefined, true), true, null],
		// like `minlength`: only a non-empty draft can be too short
		['', rules(undefined, false, 3), true, null],
		['ab', rules(undefined, false, 3), false, 'min-length'],
		['abc', rules(undefined, false, 3), true, null],
		['abc', rules(3, false, 3), true, 'max-length']
	] as const)('%j with %j -> canConfirm %s, notice %s', (text, r, canConfirm, notice) => {
		expect(classifyText(text, r)).toEqual({ canConfirm, notice });
	});
});

describe('kana (§9.2)', () => {
	const rows = textKeyRows('kana');
	const keys = rows.flat().filter((k) => k !== '');

	it('the table holds all 46 katakana of the syllabary and the long-vowel mark, once each', () => {
		const gojuon = [
			...'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン'
		];
		expect(gojuon).toHaveLength(46);
		expect([...keys].sort()).toEqual([...gojuon, 'ー'].sort());
		expect(rows.every((r) => r.length === 10)).toBe(true);
	});

	it('every key is one precomposed UTF-16 unit (no combining marks, no half-width)', () => {
		for (const k of keys) {
			expect(k.length, k).toBe(1);
			expect(k.normalize('NFC'), k).toBe(k);
			expect(k.charCodeAt(0), k).toBeGreaterThanOrEqual(0x30a0);
			expect(k.charCodeAt(0), k).toBeLessThanOrEqual(0x30ff);
		}
	});

	it('voiced marks: every voiceable character, composed (カ → ガ is U+30AC), and a second press undoes it', () => {
		const pairs: Record<string, string> = {};
		for (const [a, b] of [
			'カガ',
			'キギ',
			'クグ',
			'ケゲ',
			'コゴ',
			'サザ',
			'シジ',
			'スズ',
			'セゼ',
			'ソゾ',
			'タダ',
			'チヂ',
			'ツヅ',
			'テデ',
			'トド',
			'ハバ',
			'ヒビ',
			'フブ',
			'ヘベ',
			'ホボ',
			'ウヴ'
		])
			pairs[a] = b;
		expect(Object.keys(pairs)).toHaveLength(21);
		for (const [plain, voiced] of Object.entries(pairs)) {
			expect(kanaMarked(plain, 'dakuten'), plain).toBe(voiced);
			expect(kanaMarked(voiced, 'dakuten'), voiced).toBe(plain);
		}
		expect(applyKanaMark('カ', 'dakuten')).toBe('ガ');
		expect(pressTextKey('アカ', { mark: 'dakuten' }, {})).toBe('アガ');
		expect(pressTextKey('アガ', { mark: 'dakuten' }, {})).toBe('アカ');
	});

	it('semi-voiced: ハ行 only; バ ↔ パ swap with the other mark', () => {
		for (const [plain, semi] of ['ハパ', 'ヒピ', 'フプ', 'ヘペ', 'ホポ']) {
			expect(kanaMarked(plain, 'handakuten')).toBe(semi);
			expect(kanaMarked(semi, 'handakuten')).toBe(plain);
		}
		expect(kanaMarked('バ', 'handakuten')).toBe('パ');
		expect(kanaMarked('パ', 'dakuten')).toBe('バ');
		expect(kanaMarked('カ', 'handakuten')).toBeUndefined();
	});

	it('small forms: ア行・ツ・ヤ行, and back', () => {
		for (const [plain, small] of [
			'アァ',
			'イィ',
			'ウゥ',
			'エェ',
			'オォ',
			'ツッ',
			'ヤャ',
			'ユュ',
			'ヨョ'
		]) {
			expect(kanaMarked(plain, 'small')).toBe(small);
			expect(kanaMarked(small, 'small')).toBe(plain);
		}
	});

	it('a mark does not apply to a character that cannot take it, to an empty draft, or to a non-kana tail', () => {
		for (const [last, mark] of [
			['ア', 'dakuten'],
			['ン', 'dakuten'],
			['ー', 'small'],
			['ナ', 'handakuten'],
			['ガ', 'small'],
			['a', 'dakuten'],
			[' ', 'small']
		] as const) {
			expect(kanaMarked(last, mark), `${last} ${mark}`).toBeUndefined();
		}
		expect(applyKanaMark('', 'dakuten')).toBeUndefined();
		// a refused mark leaves the draft as it is
		expect(pressTextKey('アン', { mark: 'dakuten' }, {})).toBe('アン');
	});

	it('only the last character changes; the length stays, so a mark works at maxLength', () => {
		expect(pressTextKey('ハシ', { mark: 'dakuten' }, { maxLength: 2 })).toBe('ハジ');
		expect(pressTextKey('ハシ', { char: 'ア' }, { maxLength: 2 })).toBe('ハシ');
	});

	it('kana is opt-in: not in the default layouts and not in a password keyboard', () => {
		expect(DEFAULT_TEXT_LAYOUTS).toEqual(['alnum', 'symbol']);
		expect(resolveTextLayouts(undefined)).toEqual(['alnum', 'symbol']);
		expect(resolveTextLayouts(['kana', 'alnum', 'kana'])).toEqual(['kana', 'alnum']);
		expect(resolveTextLayouts(['kana'], true)).toEqual(['alnum', 'symbol']);
		expect(reachableChars(['kana']).has('ガ')).toBe(false);
		expect(reachableChars(['kana']).has('ン')).toBe(true);
	});
});
