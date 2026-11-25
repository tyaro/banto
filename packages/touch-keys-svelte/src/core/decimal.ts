/**
 * Exact decimal arithmetic on a tiny `{ n, s }` (integer `n` scaled by 10^-`s`)
 * representation. The keypad judges range and step on integers so that
 * `0.15 - 0.05` against `0.1` is never a floating-point question
 * (touch-keypad-design §8.2).
 */
export interface Dec {
	n: bigint;
	s: number;
}

const DEC_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/** Parses an HTML-ish decimal string (`1`, `-0.05`, `.5`, `1e-3`). `null` when not a number. */
export function parseDec(text: string): Dec | null {
	const m = DEC_RE.exec(text.trim());
	if (!m) return null;
	const sign = m[1];
	const int = m[2] ?? '';
	const frac = m[3] ?? '';
	if (int === '' && frac === '') return null;
	let digits = (int + frac).replace(/^0+(?=\d)/, '') || '0';
	let scale = frac.length;
	if (m[4] !== undefined) {
		const e = Number(m[4]);
		if (!Number.isInteger(e) || Math.abs(e) > 400) return null;
		scale -= e;
		if (scale < 0) {
			digits += '0'.repeat(-scale);
			scale = 0;
		}
	}
	const n = BigInt(digits);
	return { n: sign === '-' ? -n : n, s: scale };
}

/** A string or number -> Dec (`null` for NaN / Infinity / unparsable / missing). */
export function toDec(v: string | number | null | undefined): Dec | null {
	if (v === null || v === undefined) return null;
	if (typeof v === 'number') return Number.isFinite(v) ? parseDec(String(v)) : null;
	return parseDec(v);
}

const pow10 = (k: number): bigint => 10n ** BigInt(k);

function align(a: Dec, b: Dec): [bigint, bigint, number] {
	const s = Math.max(a.s, b.s);
	return [a.n * pow10(s - a.s), b.n * pow10(s - b.s), s];
}

export function cmpDec(a: Dec, b: Dec): number {
	const [x, y] = align(a, b);
	return x < y ? -1 : x > y ? 1 : 0;
}

export function subDec(a: Dec, b: Dec): Dec {
	const [x, y, s] = align(a, b);
	return { n: x - y, s };
}

export function addDec(a: Dec, b: Dec): Dec {
	const [x, y, s] = align(a, b);
	return { n: x + y, s };
}

/** `floor(a / b)` as an integer (`b > 0`). */
export function floorDivDec(a: Dec, b: Dec): bigint {
	const [x, y] = align(a, b);
	const q = x / y;
	return x % y !== 0n && x < 0n ? q - 1n : q;
}

export function mulInt(a: Dec, k: bigint): Dec {
	return { n: a.n * k, s: a.s };
}

/** Plain decimal string with trailing fractional zeros trimmed. */
export function formatDec(a: Dec): string {
	const neg = a.n < 0n;
	const digits = (neg ? -a.n : a.n).toString().padStart(a.s + 1, '0');
	const int = digits.slice(0, digits.length - a.s);
	const frac = digits.slice(digits.length - a.s).replace(/0+$/, '');
	return (neg ? '-' : '') + int + (frac ? `.${frac}` : '');
}

/** Number of fractional digits after trimming trailing zeros. */
export function decPlaces(a: Dec): number {
	let { n, s } = a;
	if (n === 0n) return 0;
	while (s > 0 && n % 10n === 0n) {
		n /= 10n;
		s--;
	}
	return s;
}
