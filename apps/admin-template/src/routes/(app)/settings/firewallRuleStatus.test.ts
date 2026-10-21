import { describe, expect, it } from 'vitest';
import type {
	FirewallField,
	FirewallRuleCheck,
	FirewallRuleStatus
} from '#lib/banto/serverAdmin.js';
import type { FirewallInfo } from './firewallInfo';
import {
	FirewallStatusRequests,
	firewallFieldValue,
	firewallRuleView,
	firewallStatusMatches,
	isFirewallRuleStatus
} from './firewallRuleStatus';

const EXE = 'C:\\Program Files\\Banto\\banto-admin.exe';

function info(port: number, generation: number | null): FirewallInfo {
	return { executablePath: EXE, port, bind: '0.0.0.0', generation, commands: null };
}

const present = (
	mismatches: FirewallField[] = [],
	unchecked: FirewallField[] = []
): FirewallRuleCheck => ({
	state: 'present',
	rule: {
		enabled: 'True',
		direction: 'Inbound',
		action: mismatches.includes('action') ? 'Block' : 'Allow',
		protocol: 'TCP',
		profile: 'Private',
		program: EXE,
		localPorts: ['Any'],
		remoteAddresses: mismatches.includes('remoteAddress')
			? ['192.168.1.10', '192.168.1.11']
			: ['LocalSubnet'],
		active: true
	},
	mismatches,
	unchecked
});

function result(
	port: number,
	generation: number,
	program: FirewallRuleCheck = { state: 'missing' }
): FirewallRuleStatus {
	return {
		generation,
		expected: { executablePath: EXE, port },
		program,
		port: { state: 'missing' },
		groupOtherRules: 0
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('firewallRuleView', () => {
	it('tells missing, as expected, different and unknown apart', () => {
		expect(firewallRuleView({ state: 'missing' })).toEqual({ kind: 'missing' });
		expect(firewallRuleView(present())).toEqual({ kind: 'matches', unchecked: [] });
		expect(firewallRuleView(present(['action', 'remoteAddress'], ['active']))).toEqual({
			kind: 'differs',
			fields: ['action', 'remoteAddress'],
			unchecked: ['active']
		});
		expect(firewallRuleView({ state: 'unknown', reason: 'timeout' })).toEqual({
			kind: 'unknown',
			reason: 'timeout'
		});
	});

	it('shows the values the firewall reports for the differing fields', () => {
		const check = present(['action', 'remoteAddress']);
		expect(firewallFieldValue(check, 'action')).toBe('Block');
		expect(firewallFieldValue(check, 'remoteAddress')).toBe('192.168.1.10, 192.168.1.11');
		expect(firewallFieldValue(check, 'localPort')).toBe('Any');
		expect(firewallFieldValue(check, 'active')).toBeNull();
		expect(firewallFieldValue({ state: 'missing' }, 'action')).toBeNull();
	});
});

describe('isFirewallRuleStatus', () => {
	it('accepts the host shape and refuses anything else (an older host answers null)', () => {
		expect(isFirewallRuleStatus(result(8721, 1))).toBe(true);
		expect(isFirewallRuleStatus(result(8721, 1, present(['action'])))).toBe(true);
		for (const bad of [
			null,
			undefined,
			'missing',
			{},
			{ ...result(8721, 1), generation: '1' },
			{ ...result(8721, 1), expected: null },
			{ ...result(8721, 1), program: { state: 'maybe' } },
			{ ...result(8721, 1), port: { state: 'unknown' } },
			{ ...result(8721, 1), port: { state: 'present', rule: {} } }
		]) {
			expect(isFirewallRuleStatus(bad), JSON.stringify(bad)).toBe(false);
		}
	});
});

describe('firewallStatusMatches', () => {
	it('matches only the snapshot shown (generation, port and executable)', () => {
		expect(firewallStatusMatches(info(8721, 1), result(8721, 1))).toBe(true);
		expect(firewallStatusMatches(info(8721, 1), result(8721, 2))).toBe(false);
		expect(firewallStatusMatches(info(8722, 1), result(8721, 1))).toBe(false);
		expect(
			firewallStatusMatches(info(8721, 1), {
				...result(8721, 1),
				expected: { executablePath: 'D:\\other.exe', port: 8721 }
			})
		).toBe(false);
		// A host without generation cannot be matched.
		expect(firewallStatusMatches(info(8721, null), result(8721, 0))).toBe(false);
	});
});

describe('FirewallStatusRequests', () => {
	it('shows a result for the snapshot shown', async () => {
		const requests = new FirewallStatusRequests();
		const outcome = await requests.check(
			async () => result(8721, 1, present()),
			() => info(8721, 1)
		);
		expect(outcome).toEqual({ kind: 'ok', status: result(8721, 1, present()) });
	});

	it('drops an older check once a newer one started', async () => {
		const requests = new FirewallStatusRequests();
		const slow = deferred<unknown>();
		const first = requests.check(
			() => slow.promise,
			() => info(8721, 1)
		);
		const second = requests.check(
			async () => result(8721, 1, present(['action'])),
			() => info(8721, 1)
		);
		slow.resolve(result(8721, 1));
		expect(await first).toEqual({ kind: 'superseded' });
		expect((await second).kind).toBe('ok');
	});

	it('drops a pending check when an apply starts (invalidate), even if it fails', async () => {
		const requests = new FirewallStatusRequests();
		const pending = deferred<unknown>();
		const failing = deferred<unknown>();
		const a = requests.check(
			() => pending.promise,
			() => info(8721, 1)
		);
		requests.invalidate();
		pending.resolve(result(8721, 1));
		expect(await a).toEqual({ kind: 'superseded' });

		const b = requests.check(
			() => failing.promise,
			() => info(8721, 1)
		);
		requests.invalidate();
		failing.reject(new Error('boom'));
		expect(await b).toEqual({ kind: 'superseded' });
	});

	it('does not show a result held back past an apply (A pending -> B shown -> A released)', async () => {
		const requests = new FirewallStatusRequests();
		let shown = info(8721, 1);
		const held = deferred<unknown>();
		const a = requests.check(
			() => held.promise,
			() => shown
		);
		// The apply to B is shown; the check for A is still in flight.
		shown = info(8722, 2);
		held.resolve(result(8721, 1, present()));
		expect(await a).toEqual({ kind: 'stale', newer: false });
	});

	it('asks for a status re-read when the host is already past what is shown', async () => {
		const requests = new FirewallStatusRequests();
		const outcome = await requests.check(
			async () => result(8722, 2),
			() => info(8721, 1)
		);
		expect(outcome).toEqual({ kind: 'stale', newer: true });
	});

	it('reads a failure or a foreign answer as unavailable, never as "no rule"', async () => {
		const requests = new FirewallStatusRequests();
		expect(
			await requests.check(
				async () => {
					throw new Error('forbidden');
				},
				() => info(8721, 1)
			)
		).toEqual({ kind: 'unavailable' });
		expect(
			await requests.check(
				async () => null,
				() => info(8721, 1)
			)
		).toEqual({ kind: 'unavailable' });
	});
});
