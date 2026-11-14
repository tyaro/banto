import { describe, expect, it } from 'vitest';
import * as m from '#lib/paraglide/messages.js';
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

	it('reads create and delete values, but ignores unrelated actions', () => {
		const detail = '{"name":"a","changes":[{"field":"price","before":1,"after":2}]}';
		for (const action of ['create', 'delete']) {
			expect(parseAuditChanges(action, detail)).toEqual([
				{ field: 'price', masked: false, before: 1, after: 2 }
			]);
		}
		expect(parseAuditChanges('password_reset', detail)).toBeNull();
		expect(parseAuditChanges(null, detail)).toBeNull();
	});

	it('returns null for old records, other shapes and broken JSON', () => {
		expect(parseAuditChanges('update', '{"name":"a"}')).toBeNull();
		expect(parseAuditChanges('update', '{"changes":"x"}')).toBeNull();
		expect(parseAuditChanges('update', '[1]')).toBeNull();
		expect(parseAuditChanges('update', 'not json')).toBeNull();
		expect(parseAuditChanges('update', null)).toBeNull();
		expect(parseAuditChanges('create', '{"name":"old"}')).toBeNull();
		expect(parseAuditChanges('delete', '{"attachmentsRemoved":2}')).toBeNull();
	});
});

describe('auditDetailRest', () => {
	it('keeps everything but changes', () => {
		const detail = JSON.stringify({ name: 'a', changes: [], extra: 1 });
		expect(JSON.parse(auditDetailRest(detail, 'items') ?? 'null')).toEqual({ name: 'a', extra: 1 });
	});

	it('is null when nothing is left or detail is not an object', () => {
		expect(auditDetailRest('{"changes":[]}', 'items')).toBeNull();
		expect(auditDetailRest('[1]', 'items')).toBeNull();
		expect(auditDetailRest('not json', 'items')).toBeNull();
		expect(auditDetailRest(null, 'items')).toBeNull();
	});

	it('keeps attachment sweep metadata next to delete values', () => {
		const detail = JSON.stringify({
			name: 'Deleted',
			changes: [{ field: 'stock', before: 3, after: null }],
			attachmentsRemoved: 2
		});
		expect(parseAuditChanges('delete', detail)).toEqual([
			{ field: 'stock', masked: false, before: 3, after: null }
		]);
		expect(JSON.parse(auditDetailRest(detail, 'items') ?? 'null')).toEqual({
			name: 'Deleted',
			attachmentsRemoved: 2
		});
	});

	it('hides a duplicate top-level role when changes already shows it', () => {
		const detail = JSON.stringify({
			username: 'target',
			role: 'editor',
			changes: [{ field: 'role', before: 'editor', after: null }]
		});
		expect(JSON.parse(auditDetailRest(detail, 'users') ?? 'null')).toEqual({ username: 'target' });
		expect(JSON.parse(auditDetailRest(detail, 'items') ?? 'null')).toEqual({
			username: 'target',
			role: 'editor'
		});
		expect(
			JSON.parse(auditDetailRest('{"username":"target","role":"editor"}', 'users') ?? 'null')
		).toEqual({
			username: 'target',
			role: 'editor'
		});
	});
});

describe('auditFieldLabel / formatAuditValue', () => {
	it('falls back to the internal name', () => {
		expect(auditFieldLabel('no-such-resource', 'price')).toBe('price');
		expect(auditFieldLabel('items', 'no_such_field')).toBe('no_such_field');
	});

	it('labels the users fields and role values', () => {
		expect(auditFieldLabel('users', 'displayName')).toBe(m['common.displayName']());
		expect(auditFieldLabel('users', 'role')).toBe(m['common.role']());
		expect(auditFieldLabel('users', 'other')).toBe('other');
		expect(formatAuditValue('editor', 'users', 'role')).toBe(m['role.editor']());
		expect(formatAuditValue('admin', 'users', 'role')).toBe(m['role.admin']());
		// not a users role: raw value
		expect(formatAuditValue('editor', 'items', 'role')).toBe('editor');
		expect(formatAuditValue('custom', 'users', 'role')).toBe('custom');
	});

	it('formats values', () => {
		expect(formatAuditValue(null)).toBe('-');
		expect(formatAuditValue(12)).toBe('12');
		expect(formatAuditValue('x')).toBe('x');
		expect(formatAuditValue('')).toBe('""');
	});
});
