import { describe, expect, it } from 'vitest';
import { connectivityScope, type ConnectivityScope } from './connectivityScope';

describe('connectivityScope (Issue #216)', () => {
	// Table: bind literal -> expected scope. Loopback binds must classify as
	// 'local' - the whole point of Issue #216 is that a loopback bind must
	// not be shown/treated as LAN-reachable.
	const cases: Array<[bind: string, expected: 'local' | 'lan']> = [
		['127.0.0.1', 'local'],
		['::1', 'local'],
		['localhost', 'local'],
		['0.0.0.0', 'lan'],
		['::', 'lan'],
		['192.168.1.50', 'lan'],
		['2001:db8::1', 'lan']
	];

	for (const [bind, expected] of cases) {
		it(`classifies "${bind}" as ${expected}`, () => {
			expect(connectivityScope(bind)).toBe(expected);
		});
	}

	it('counter-proof: a naive "always lan" classifier would fail the loopback cases above', () => {
		// This is not testing connectivityScope - it documents that the table
		// above actually discriminates the Issue #216 regression (always
		// showing LAN wording regardless of bind). If someone weakens
		// connectivityScope back to that, the 'local' cases in the table
		// fail, not this test.
		const regressedAlwaysLan = (_bind: string): ConnectivityScope => 'lan';
		expect(regressedAlwaysLan('127.0.0.1')).toBe('lan');
		expect(connectivityScope('127.0.0.1')).not.toBe(regressedAlwaysLan('127.0.0.1'));
	});
});
