import { describe, expect, it } from 'vitest';
import {
	connectivityScope,
	isLoopbackHost,
	pickPrimaryLanUrl,
	type ConnectivityScope
} from './connectivityScope';

describe('isLoopbackHost / connectivityScope (Issue #216, PR #254 P2 follow-up)', () => {
	// Table: bind/host literal -> expected loopback-ness -> expected scope.
	// Includes the owner's two counter-examples from the review: a
	// non-canonical loopback IPv4 (127.0.0.2, still in 127.0.0.0/8) and the
	// `localhost`/`::1` names that a fixed `{'127.0.0.1','::1','localhost'}`
	// Set-based check either missed or got the QR side wrong for.
	const cases: Array<[host: string, loopback: boolean, scope: ConnectivityScope]> = [
		['127.0.0.1', true, 'local'],
		['127.0.0.2', true, 'local'], // whole 127.0.0.0/8, not just .1
		['127.255.255.255', true, 'local'],
		['::1', true, 'local'],
		['0:0:0:0:0:0:0:1', true, 'local'], // same address, unabbreviated form
		['localhost', true, 'local'],
		['LOCALHOST', true, 'local'], // case-insensitive
		['0.0.0.0', false, 'lan'],
		['::', false, 'lan'],
		['192.168.1.50', false, 'lan'],
		['2001:db8::1', false, 'lan'],
		['not-an-ip', false, 'lan'] // unparseable: conservative default is "not loopback"
	];

	for (const [host, loopback, scope] of cases) {
		it(`classifies "${host}" as loopback=${loopback}, scope=${scope}`, () => {
			expect(isLoopbackHost(host)).toBe(loopback);
			expect(connectivityScope(host)).toBe(scope);
		});
	}

	it('counter-proof: a fixed-Set classifier (the pre-fix implementation) gets 127.0.0.2 wrong', () => {
		// Documents exactly the review's first example: the old
		// `LOOPBACK_BINDS.has(bind)` check reported '127.0.0.2' as 'lan',
		// which is wrong (it's in the loopback range) - this is why the fix
		// moved to a real IP-range test instead of a fixed string Set.
		const oldSetBasedScope = (bind: string): ConnectivityScope =>
			new Set(['127.0.0.1', '::1', 'localhost']).has(bind) ? 'local' : 'lan';
		expect(oldSetBasedScope('127.0.0.2')).toBe('lan');
		expect(connectivityScope('127.0.0.2')).toBe('local');
	});
});

describe('pickPrimaryLanUrl (Issue #216, PR #254 P2 follow-up)', () => {
	// Table: the backend's `ServerStatus.urls` list for a given bind -> the
	// URL (if any) the QR should be built from. Mirrors
	// `banto_server::lan_urls_for_bind`'s shape for each bind case.
	const cases: Array<{ name: string; urls: string[]; expected: string | null }> = [
		{
			name: 'loopback IPv4 bind (127.0.0.1): single loopback URL, no QR',
			urls: ['http://127.0.0.1:8721'],
			expected: null
		},
		{
			// The review's first counter-example: a non-canonical loopback
			// address must still resolve to "no QR", the same as 127.0.0.1.
			name: 'loopback-range IPv4 bind (127.0.0.2): still no QR',
			urls: ['http://127.0.0.2:8721'],
			expected: null
		},
		{
			name: 'IPv6 loopback bind (::1): no QR',
			urls: ['http://[::1]:8721'],
			expected: null
		},
		{
			// The review's second counter-example.
			name: '"localhost" bind: no QR',
			urls: ['http://localhost:8721'],
			expected: null
		},
		{
			name: '0.0.0.0 bind with one LAN interface: QR for the LAN entry, not the loopback prefix',
			urls: ['http://127.0.0.1:8721', 'http://192.168.1.50:8721'],
			expected: 'http://192.168.1.50:8721'
		},
		{
			name: '0.0.0.0 bind with no LAN interfaces: no QR (loopback-only list)',
			urls: ['http://127.0.0.1:8721'],
			expected: null
		},
		{
			name: ':: bind with a LAN IPv6 interface: QR for the LAN entry, skipping both loopback prefixes',
			urls: ['http://127.0.0.1:8721', 'http://[::1]:8721', 'http://[2001:db8::1]:8721'],
			expected: 'http://[2001:db8::1]:8721'
		},
		{
			name: 'a specific non-loopback bind (192.168.1.50): that single URL is the QR target',
			urls: ['http://192.168.1.50:8721'],
			expected: 'http://192.168.1.50:8721'
		}
	];

	for (const { name, urls, expected } of cases) {
		it(name, () => {
			expect(pickPrimaryLanUrl(urls)).toBe(expected);
		});
	}

	it('counter-proof: a substring check (the pre-fix implementation) wrongly picks a loopback-range URL', () => {
		// Documents the review's exact failure mode: ConnectivitySection's
		// old `serverStatus.urls.find((url) => !url.includes('127.0.0.1'))`
		// would treat 'http://127.0.0.2:8721' as the LAN URL and build a QR
		// for it, even though this bind is loopback-only.
		const oldSubstringPicker = (urls: string[]): string | null =>
			urls.find((url) => !url.includes('127.0.0.1')) ?? null;
		expect(oldSubstringPicker(['http://127.0.0.2:8721'])).toBe('http://127.0.0.2:8721');
		expect(pickPrimaryLanUrl(['http://127.0.0.2:8721'])).toBeNull();
	});
});
