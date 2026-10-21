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
	isFirewallRuleStatus,
	nextFirewallPanelState
} from './firewallRuleStatus';

const EXE = 'C:\\Program Files\\Banto\\banto-admin.exe';

function info(port: number, generation: number | null): FirewallInfo {
	return { executablePath: EXE, port, bind: '0.0.0.0', generation, commands: null };
}

const LOCAL: FirewallRuleOrigin = { kind: 'local', sourceType: 'Local', source: 'PersistentStore' };
const GPO: FirewallRuleOrigin = {
	kind: 'groupPolicy',
	sourceType: 'GroupPolicy',
	source: 'contoso.local\\Banto'
};
const GPO_VIEW = { ...GPO, kind: 'groupPolicy' as const, policy: true };

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
	enforcement: { state: 'enforced' },
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
			origin: null,
			enforcement: { state: 'enforced' },
			local: { kind: 'same' }
		});
		expect(firewallRuleView(present(['action', 'remoteAddress'], ['localPort']))).toEqual({
			kind: 'differs',
			fields: ['action', 'remoteAddress'],
			unchecked: ['localPort'],
			origin: null,
			enforcement: { state: 'enforced' },
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
			enforcement: { state: 'enforced' },
			local: { state: 'differs', rule: values() },
			mismatches: ['action'],
			unchecked: []
		};
		expect(firewallRuleView(check)).toEqual({
			kind: 'differs',
			fields: ['action'],
			unchecked: [],
			origin: GPO_VIEW,
			enforcement: { state: 'enforced' },
			local: { kind: 'differs', values: [{ field: 'action', value: 'Allow' }] }
		});
		expect(firewallFieldValue(check, 'action')).toBe('Block');
		// The policy's rule alone, identical to the command's: as expected, but from the policy.
		expect(
			firewallRuleView({ ...check, rule: values(), local: { state: 'missing' }, mismatches: [] })
		).toEqual({
			kind: 'matches',
			unchecked: [],
			origin: GPO_VIEW,
			enforcement: { state: 'enforced' },
			local: { kind: 'missing' }
		});
	});

	it('tells a local rule that is not in effect, an unreadable local store and an expanded path apart', () => {
		expect(
			firewallRuleView({
				state: 'present',
				rule: values(),
				origin: null,
				enforcement: null,
				local: { state: 'same' },
				mismatches: ['active'],
				unchecked: []
			})
		).toEqual({
			kind: 'differs',
			fields: ['active'],
			unchecked: [],
			origin: null,
			enforcement: null,
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

	it('reads only a Full enforcement as applied (owner review on PR #465)', () => {
		// In the ActiveStore but not applied: a difference, with its reasons.
		for (const reasons of [['InactiveProfile'], ['LocalFirewallRulesDisallowed']]) {
			const check = {
				...present(['enforcement']),
				enforcement: { state: 'notEnforced' as const, reasons }
			};
			expect(firewallRuleView(check)).toMatchObject({
				kind: 'differs',
				fields: ['enforcement'],
				enforcement: { state: 'notEnforced', reasons }
			});
		}
		// Values as expected but the status missing or unknown: never plainly
		// "as expected", and `enforcement` is worded on its own, not in the
		// "not compared" list.
		for (const values of [[], [25]]) {
			const check = {
				...present([], ['enforcement', 'program']),
				enforcement: { state: 'unknown' as const, values }
			};
			expect(firewallRuleView(check)).toEqual({
				kind: 'unconfirmed',
				unchecked: ['program'],
				origin: null,
				enforcement: { state: 'unknown', values },
				local: { kind: 'same' }
			});
		}
		// A host that left the status out entirely reads the same way.
		expect(firewallRuleView({ ...present(), enforcement: null })).toMatchObject({
			kind: 'unconfirmed'
		});
	});

	it('tells the source kinds apart and never takes an unreported one for a policy', () => {
		const viewOf = (origin: FirewallRuleOrigin) => {
			const view = firewallRuleView({ ...present(), origin });
			return view.kind === 'matches' ? view.origin : undefined;
		};
		expect(viewOf(LOCAL)).toBeNull();
		for (const [kind, sourceType, policy] of [
			['groupPolicy', 'GroupPolicy', true],
			['mdm', 'MDM', true],
			['hostFirewallGroupPolicy', 'HostFirewallGroupPolicy', true],
			['hostFirewallMdm', 'HostFirewallMDM', true],
			['dynamic', 'Dynamic', false],
			['generated', 'Generated', false],
			['hardcoded', 'Hardcoded', false],
			['hostFirewallLocal', 'HostFirewallLocal', false],
			['hostFirewallDynamic', 'HostFirewallDynamic', false],
			['other', 'SomethingNew', false]
		] as const) {
			expect(viewOf({ kind, sourceType, source: 'x' }), kind).toEqual({
				kind,
				sourceType,
				source: 'x',
				policy
			});
		}
		expect(viewOf({ kind: 'unknown', sourceType: null, source: null })).toEqual({
			kind: 'unknown',
			sourceType: null,
			source: null,
			policy: false
		});
	});

	it('shows the values the firewall reports for the differing fields', () => {
		const check = present(['action', 'remoteAddress']);
		expect(firewallFieldValue(check, 'action')).toBe('Block');
		expect(firewallFieldValue(check, 'remoteAddress')).toBe('192.168.1.10, 192.168.1.11');
		expect(firewallFieldValue(check, 'localPort')).toBe('Any');
		expect(firewallFieldValue(check, 'active')).toBeNull();
		expect(firewallFieldValue(check, 'enforcement')).toBeNull();
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
			{ ...result(8721, 1), port: { ...present(), origin: { sourceType: 'Local' } } },
			// The earlier shape (`local: boolean`, no kind).
			{
				...result(8721, 1),
				port: { ...present(), origin: { sourceType: 'Local', source: 'x', local: true } }
			},
			{ ...result(8721, 1), port: { ...present(), origin: { ...LOCAL, kind: 'central' } } },
			// Without the enforcement status (an older host), or a malformed one.
			{ ...result(8721, 1), port: { ...present(), enforcement: undefined } },
			{ ...result(8721, 1), port: { ...present(), enforcement: { state: 'applied' } } },
			{
				...result(8721, 1),
				port: { ...present(), enforcement: { state: 'notEnforced', reasons: [] } }
			},
			{
				...result(8721, 1),
				port: { ...present(), enforcement: { state: 'unknown', values: ['25'] } }
			}
		]) {
			expect(isFirewallRuleStatus(bad), JSON.stringify(bad)).toBe(false);
		}
		for (const enforcement of [
			null,
			{ state: 'enforced' },
			{ state: 'notEnforced', reasons: ['InactiveProfile'] },
			{ state: 'unknown', values: [] },
			{ state: 'unknown', values: [25] }
		]) {
			expect(
				isFirewallRuleStatus({ ...result(8721, 1), port: { ...present(), enforcement } }),
				JSON.stringify(enforcement)
			).toBe(true);
		}
		expect(
			isFirewallRuleStatus({
				...result(8721, 1),
				port: { ...present(), origin: { kind: 'unknown', sourceType: null, source: null } }
			})
		).toBe(true);
	});
});

describe('nextFirewallPanelState', () => {
	const shownBefore = { result: result(8721, 1, present()), problem: null };

	it('clears the previous result when a re-check fails (owner review on PR #465)', () => {
		// An IPC error or a foreign answer: the old "as expected" is not kept next to the error.
		expect(nextFirewallPanelState(shownBefore, { kind: 'unavailable' })).toEqual({
			result: null,
			problem: 'unavailable',
			refresh: false
		});
		// Answered for an older snapshot: nothing old is left either.
		expect(nextFirewallPanelState(shownBefore, { kind: 'stale', newer: false })).toEqual({
			result: null,
			problem: 'changed',
			refresh: false
		});
		expect(nextFirewallPanelState(shownBefore, { kind: 'stale', newer: true })).toEqual({
			result: null,
			problem: null,
			refresh: true
		});
	});

	it('shows a new result and leaves the state alone for a superseded check', () => {
		const status = result(8721, 2, present(['action']));
		expect(
			nextFirewallPanelState({ result: null, problem: 'unavailable' }, { kind: 'ok', status })
		).toEqual({ result: status, problem: null, refresh: false });
		expect(nextFirewallPanelState(shownBefore, { kind: 'superseded' })).toEqual({
			...shownBefore,
			refresh: false
		});
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
