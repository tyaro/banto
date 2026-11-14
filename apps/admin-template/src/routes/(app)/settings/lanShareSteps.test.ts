import { describe, expect, it } from 'vitest';
import type { FirewallRuleCheck, FirewallRuleStatus } from '#lib/banto/serverAdmin.js';
import type { ReachView } from './lanReachCheck';
import { firewallFixHint, reachVerdict, shareFix } from './lanShareSteps';

const present: FirewallRuleCheck = {
	state: 'present',
	rule: {} as never,
	origin: null,
	enforcement: null,
	local: { state: 'same' },
	mismatches: [],
	unchecked: []
};

function rules(program: FirewallRuleCheck, port: FirewallRuleCheck = { state: 'missing' }) {
	const status: FirewallRuleStatus = {
		generation: 1,
		expected: { executablePath: 'C:\\app.exe', port: 8721 },
		program,
		port,
		groupOtherRules: 0
	};
	return status;
}

describe('reachVerdict (Issue #558)', () => {
	it('maps the connection check to green / red / waiting / unknown', () => {
		const cases: [ReachView | null, string][] = [
			[{ kind: 'verified', records: [] }, 'ok'],
			[{ kind: 'stale', records: [] }, 'ok'],
			[{ kind: 'expired' }, 'ng'],
			[{ kind: 'pending', remainingMs: 1000, issued: null }, 'waiting'],
			[{ kind: 'selfAccess', remainingMs: 1000, issued: null, at: 0 }, 'waiting'],
			[{ kind: 'unverified' }, 'unknown'],
			[{ kind: 'loading' }, 'unknown'],
			[{ kind: 'unreadable' }, 'unknown'],
			[null, 'unknown']
		];
		for (const [view, verdict] of cases) expect(reachVerdict(view)).toBe(verdict);
	});
});

describe('firewallFixHint (Issue #558)', () => {
	it('offers the allow confirmation only when the panel offers "allow"', () => {
		expect(firewallFixHint(rules({ state: 'missing' }), ['allow'])).toBe('allow');
		expect(firewallFixHint(rules({ state: 'missing' }), [])).toBe('manual');
		expect(
			firewallFixHint(rules({ state: 'unknown', reason: 'queryFailed' }), ['allow', 'remove'])
		).toBe('allow');
	});

	it('says nothing about the firewall when a rule is there, off Windows, or before a read', () => {
		expect(firewallFixHint(rules(present), ['remove'])).toBe('present');
		expect(firewallFixHint(rules({ state: 'missing' }, present), ['allow'])).toBe('present');
		expect(firewallFixHint(rules({ state: 'unknown', reason: 'notWindows' }), [])).toBeNull();
		expect(firewallFixHint(null, [])).toBeNull();
	});
});

describe('shareFix (Issue #558)', () => {
	it('gives one fix, only when the check came back red', () => {
		expect(shareFix('ok', 'allow')).toBeNull();
		expect(shareFix('waiting', 'allow')).toBeNull();
		expect(shareFix('unknown', 'allow')).toBeNull();
		expect(shareFix('ng', 'allow')).toBe('firewallAllow');
		expect(shareFix('ng', 'manual')).toBe('firewallInfo');
		expect(shareFix('ng', 'present')).toBe('network');
		expect(shareFix('ng', null)).toBe('network');
	});
});
