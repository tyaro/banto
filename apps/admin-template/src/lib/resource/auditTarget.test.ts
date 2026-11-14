import { describe, expect, it } from 'vitest';
import { auditTargetHref } from './auditTarget';

describe('auditTargetHref', () => {
	it('links a registered resource to its list with ?id=', () => {
		expect(auditTargetHref('items', '42', 'update')).toBe('/items?id=42');
	});

	it('encodes the id as one query value', () => {
		expect(auditTargetHref('items', 'a&b=c#d', 'create')).toBe('/items?id=a%26b%3Dc%23d');
	});

	it('gives no link for a deleted record', () => {
		expect(auditTargetHref('items', '42', 'delete')).toBeNull();
	});

	it('gives no link without an entity id', () => {
		expect(auditTargetHref('items', null, 'update')).toBeNull();
		expect(auditTargetHref('items', '', 'update')).toBeNull();
	});

	it('gives no link for a resource without a screen', () => {
		expect(auditTargetHref('users', '1', 'update')).toBeNull();
		expect(auditTargetHref('attachments', '1', 'create')).toBeNull();
	});
});
