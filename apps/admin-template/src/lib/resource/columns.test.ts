import { describe, expect, it } from 'vitest';
import { detailHref } from './columns';

// '/settings' (not '/items'): the path must be a route every scaffold preset
// keeps, or the display copy's type-check rejects it as an AppPath.
describe('detailHref', () => {
	it('builds <path>/<id> for a numeric id', () => {
		expect(detailHref({ path: '/settings' }, 3)).toBe('/settings/3');
	});

	it('encodes a string id as one path segment', () => {
		expect(detailHref({ path: '/settings' }, 'a/b?c#d')).toBe('/settings/a%2Fb%3Fc%23d');
	});
});
