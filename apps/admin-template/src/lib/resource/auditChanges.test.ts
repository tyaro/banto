import { describe, expect, it } from 'vitest';
import {
	auditDetailRest,
	auditFieldLabel,
	formatAuditValue,
	parseAuditChanges
} from './auditChanges';

describe('parseAuditChanges', () => {
	it('reads changes and masked entries', () => {
		const detail = JSON.stringify({
			name: 'a',
			changes: [
				{ field: 'price', before: 1, after: 2 },
				{ field: 'token', masked: true }
			]
		});
		expect(parseAuditChanges('update', detail)).toEqual([
			{ field: 'price', masked: false, before: 1, after: 2 },
			{ field: 'token', masked: true, before: undefined, after: undefined }
		]);
	});

	it('keeps an empty changes array (nothing changed) distinct from no changes', () => {
		expect(parseAuditChanges('update', '{"name":"a","changes":[]}')).toEqual([]);
	});

	it('returns null for any action other than update', () => {
		const detail = '{"name":"a","changes":[{"field":"price","before":1,"after":2}]}';
		expect(parseAuditChanges('create', detail)).toBeNull();
		expect(parseAuditChanges('delete', detail)).toBeNull();
		expect(parseAuditChanges(null, detail)).toBeNull();
	});

	it('returns null for old records, other shapes and broken JSON', () => {
		expect(parseAuditChanges('update', '{"name":"a"}')).toBeNull();
		expect(parseAuditChanges('update', '{"changes":"x"}')).toBeNull();
		expect(parseAuditChanges('update', '[1]')).toBeNull();
		expect(parseAuditChanges('update', 'not json')).toBeNull();
		expect(parseAuditChanges('update', null)).toBeNull();
	});
});

describe('auditDetailRest', () => {
	it('keeps everything but changes', () => {
		const detail = JSON.stringify({ name: 'a', changes: [], extra: 1 });
		expect(JSON.parse(auditDetailRest(detail) ?? 'null')).toEqual({ name: 'a', extra: 1 });
	});

	it('is null when nothing is left or detail is not an object', () => {
		expect(auditDetailRest('{"changes":[]}')).toBeNull();
		expect(auditDetailRest('[1]')).toBeNull();
		expect(auditDetailRest('not json')).toBeNull();
		expect(auditDetailRest(null)).toBeNull();
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
