import { describe, expect, it } from 'vitest';
import type {
	FirewallField,
	FirewallRuleCheck,
	FirewallRuleOrigin,
	FirewallRuleStatus,
	FirewallRuleValues
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

const LOCAL: FirewallRuleOrigin = { sourceType: 'Local', source: 'PersistentStore', local: true };
const GPO: FirewallRuleOrigin = {
	sourceType: 'GroupPolicy',
	source: 'contoso.local\\Banto',
	local: false
};

function values(overrides: Partial<FirewallRuleValues> = {}): FirewallRuleValues {
	return {
		enabled: 'True',
		direction: 'Inbound',
		action: 'Allow',
		protocol: 'TCP',
		profile: 'Private',
		program: EXE,
		localPorts: ['Any'],
		remoteAddresses: ['LocalSubnet'],
		...overrides
	};
}

const present = (
	mismatches: FirewallField[] = [],
	unchecked: FirewallField[] = []
): Extract<FirewallRuleCheck, { state: 'present' }> => ({
	state: 'present',
	rule: values({
		action: mismatches.includes('action') ? 'Block' : 'Allow',
		remoteAddresses: mismatches.includes('remoteAddress')
			? ['192.168.1.10', '192.168.1.11']
			: ['LocalSubnet']
	}),
	origin: LOCAL,
	local: { state: 'same' },
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
		expect(firewallRuleView(present())).toEqual({
			kind: 'matches',
			unchecked: [],
			policy: null,
			local: { kind: 'same' }
		});
		expect(firewallRuleView(present(['action', 'remoteAddress'], ['localPort']))).toEqual({
			kind: 'differs',
			fields: ['action', 'remoteAddress'],
			unchecked: ['localPort'],
			policy: null,
			local: { kind: 'same' }
		});
		expect(firewallRuleView({ state: 'unknown', reason: 'timeout' })).toEqual({
			kind: 'unknown',
			reason: 'timeout'
		});
	});

	it('names a central policy whose rule of the same name is in effect (a local Allow does not count)', () => {
		const check: FirewallRuleCheck = {
			state: 'present',
			rule: values({ action: 'Block' }),
			origin: GPO,
			local: { state: 'differs', rule: values() },
			mismatches: ['action'],
			unchecked: []
		};
		expect(firewallRuleView(check)).toEqual({
			kind: 'differs',
			fields: ['action'],
			unchecked: [],
			policy: GPO,
			local: { kind: 'differs', values: [{ field: 'action', value: 'Allow' }] }
		});
		expect(firewallFieldValue(check, 'action')).toBe('Block');
		// The policy's rule alone, identical to the command's: as expected, but from the policy.
		expect(
			firewallRuleView({ ...check, rule: values(), local: { state: 'missing' }, mismatches: [] })
		).toEqual({ kind: 'matches', unchecked: [], policy: GPO, local: { kind: 'missing' } });
	});

	it('tells a local rule that is not in effect, an unreadable local store and an expanded path apart', () => {
		expect(
			firewallRuleView({
				state: 'present',
				rule: values(),
				origin: null,
				local: { state: 'same' },
				mismatches: ['active'],
				unchecked: []
			})
		).toEqual({
			kind: 'differs',
			fields: ['active'],
			unchecked: [],
			policy: null,
			local: { kind: 'same' }
		});
		expect(firewallRuleView({ ...present(), local: { state: 'unknown' } })).toMatchObject({
			kind: 'matches',
			local: { kind: 'unknown' }
		});
		// `%ProgramFiles%` reads back expanded from the ActiveStore; case is not a difference.
		expect(
			firewallRuleView({
				...present(),
				local: {
					state: 'differs',
					rule: values({ program: '%ProgramFiles%\\Banto\\banto-admin.exe', profile: 'private' })
				}
			})
		).toMatchObject({ kind: 'matches', local: { kind: 'same' } });
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
		expect(
			isFirewallRuleStatus(
				result(8721, 1, {
					...present(['active']),
					origin: null,
					local: { state: 'differs', rule: values() }
				})
			)
		).toBe(true);
		for (const bad of [
			null,
			undefined,
			'missing',
			{},
			{ ...result(8721, 1), generation: '1' },
			{ ...result(8721, 1), expected: null },
			{ ...result(8721, 1), program: { state: 'maybe' } },
			{ ...result(8721, 1), port: { state: 'unknown' } },
			{ ...result(8721, 1), port: { state: 'present', rule: {} } },
			// An older host without the source of the rule in effect.
			{ ...result(8721, 1), port: { ...present(), origin: undefined } },
			{ ...result(8721, 1), port: { ...present(), local: undefined } },
			{ ...result(8721, 1), port: { ...present(), local: { state: 'differs' } } },
			{ ...result(8721, 1), port: { ...present(), origin: { sourceType: 'Local' } } }
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
