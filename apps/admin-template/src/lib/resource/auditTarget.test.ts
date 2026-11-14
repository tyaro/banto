import { describe, expect, it } from 'vitest';
import { auditTargetHref, type AuditTargetResource } from './auditTarget';

// Our own definitions: the registered `resources` differ by scaffold preset
// (display removes items), so the test does not read them.
const defs: AuditTargetResource[] = [{ name: 'items', path: '/items' }];

describe('auditTargetHref', () => {
	it('links a registered resource to its list with ?id=', () => {
		expect(auditTargetHref('items', '42', 'update', defs)).toBe('/items?id=42');
	});

	it('encodes the id as one query value', () => {
		expect(auditTargetHref('items', 'a&b=c#d', 'create', defs)).toBe('/items?id=a%26b%3Dc%23d');
	});

	it('gives no link for a deleted record', () => {
		expect(auditTargetHref('items', '42', 'delete', defs)).toBeNull();
	});

	it('gives no link without an entity id', () => {
		expect(auditTargetHref('items', null, 'update', defs)).toBeNull();
		expect(auditTargetHref('items', '', 'update', defs)).toBeNull();
	});

	it('gives no link for a resource without a screen', () => {
		expect(auditTargetHref('users', '1', 'update', defs)).toBeNull();
		expect(auditTargetHref('attachments', '1', 'create', defs)).toBeNull();
	});
});
