import { describe, expect, it } from 'vitest';
import { detailHref } from './columns';

describe('detailHref', () => {
	it('builds <path>/<id> for a numeric id', () => {
		expect(detailHref({ path: '/items' }, 3)).toBe('/items/3');
	});

	it('encodes a string id as one path segment', () => {
		expect(detailHref({ path: '/items' }, 'a/b?c#d')).toBe('/items/a%2Fb%3Fc%23d');
	});
});
