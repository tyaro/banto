import { describe, expect, it } from 'vitest';
import { auditFieldLabel, formatAuditValue, parseAuditChanges } from './auditChanges';

describe('parseAuditChanges', () => {
	it('reads changes and masked entries', () => {
		const detail = JSON.stringify({
			name: 'a',
			changes: [
				{ field: 'price', before: 1, after: 2 },
				{ field: 'token', masked: true }
			]
		});
		expect(parseAuditChanges(detail)).toEqual([
			{ field: 'price', masked: false, before: 1, after: 2 },
			{ field: 'token', masked: true, before: undefined, after: undefined }
		]);
	});

	it('keeps an empty changes array (nothing changed) distinct from no changes', () => {
		expect(parseAuditChanges('{"name":"a","changes":[]}')).toEqual([]);
	});

	it('returns null for old records, other shapes and broken JSON', () => {
		expect(parseAuditChanges('{"name":"a"}')).toBeNull();
		expect(parseAuditChanges('{"changes":"x"}')).toBeNull();
		expect(parseAuditChanges('[1]')).toBeNull();
		expect(parseAuditChanges('not json')).toBeNull();
		expect(parseAuditChanges(null)).toBeNull();
	});
});

describe('auditFieldLabel / formatAuditValue', () => {
	it('falls back to the internal name', () => {
		expect(auditFieldLabel('no-such-resource', 'price')).toBe('price');
		expect(auditFieldLabel('items', 'no_such_field')).toBe('no_such_field');
	});

	it('formats values', () => {
		expect(formatAuditValue(null)).toBe('-');
		expect(formatAuditValue(12)).toBe('12');
		expect(formatAuditValue('x')).toBe('x');
		expect(formatAuditValue('')).toBe('""');
	});
});
