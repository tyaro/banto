import { describe, expect, it } from 'vitest';
import { auditLogFiltersFromQuery, auditLogLink, hasAuditLogQuery } from './auditLogQuery';
import { recordHistoryParams } from '#lib/resource/recordHistory.js';

const q = (s: string) => new URLSearchParams(s);

describe('auditLogFiltersFromQuery (#591)', () => {
	it('builds eq filters for both parameters', () => {
		expect(auditLogFiltersFromQuery(q('resource=items&entityId=42'))).toEqual([
			{ field: 'resource', op: 'eq', value: 'items' },
			{ field: 'entityId', op: 'eq', value: '42' }
		]);
	});

	it('matches the filters the drawer history reads with', () => {
		const fromDrawer = recordHistoryParams('items', 42).filters;
		expect(auditLogFiltersFromQuery(q('resource=items&entityId=42'))).toEqual(fromDrawer);
	});

	it('accepts either parameter alone', () => {
		expect(auditLogFiltersFromQuery(q('resource=items'))).toEqual([
			{ field: 'resource', op: 'eq', value: 'items' }
		]);
		expect(auditLogFiltersFromQuery(q('entityId=7'))).toEqual([
			{ field: 'entityId', op: 'eq', value: '7' }
		]);
	});

	it('decodes encoded values and trims spaces', () => {
		expect(auditLogFiltersFromQuery(q('entityId=%20a%2Fb%20'))).toEqual([
			{ field: 'entityId', op: 'eq', value: 'a/b' }
		]);
	});

	it('drops empty, over-long and control-character values', () => {
		expect(auditLogFiltersFromQuery(q('resource=&entityId=%20'))).toEqual([]);
		expect(auditLogFiltersFromQuery(q('resource=' + 'a'.repeat(201)))).toEqual([]);
		expect(auditLogFiltersFromQuery(q('entityId=a%00b'))).toEqual([]);
		expect(auditLogFiltersFromQuery(q('resource=a%0Ab&entityId=1'))).toEqual([
			{ field: 'entityId', op: 'eq', value: '1' }
		]);
	});

	it('ignores unrelated parameters and uses the first repeated value', () => {
		expect(auditLogFiltersFromQuery(q('view=x&resource=a&resource=b'))).toEqual([
			{ field: 'resource', op: 'eq', value: 'a' }
		]);
		expect(auditLogFiltersFromQuery(q(''))).toEqual([]);
	});
});

describe('hasAuditLogQuery', () => {
	it('is true when either parameter is present, even an invalid one', () => {
		expect(hasAuditLogQuery(q('resource='))).toBe(true);
		expect(hasAuditLogQuery(q('entityId=1'))).toBe(true);
		expect(hasAuditLogQuery(q('view=a'))).toBe(false);
	});
});

describe('auditLogLink', () => {
	it('encodes the values and round-trips through the reader', () => {
		const href = auditLogLink('/audit-log', 'items', 'a b&c/1');
		expect(href).toBe('/audit-log?resource=items&entityId=a+b%26c%2F1');
		const params = new URL(href, 'http://x').searchParams;
		expect(auditLogFiltersFromQuery(params)).toEqual([
			{ field: 'resource', op: 'eq', value: 'items' },
			{ field: 'entityId', op: 'eq', value: 'a b&c/1' }
		]);
	});
});
