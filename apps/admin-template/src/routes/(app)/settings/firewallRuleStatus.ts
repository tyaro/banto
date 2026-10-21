/**
 * Spec §11.4 (LAN settings UX: documenting the OS-side Windows Firewall
 * behavior). Pure decisions behind the settings screen's "Windows Firewall
 * status" (Issue #219, stage 1 / PR-B): whether a `firewall_rule_status`
 * response may be shown, and what each rule's state reads as.
 * `FirewallRuleStatusPanel.svelte` renders it; nothing here touches the
 * DOM, Tauri or the message catalog (conventions §13).
 *
 * A rule that exists is not the same as being reachable from the LAN
 * (security audit 2026-10-21): this only tells what Windows Defender
 * Firewall's local store holds, and the panel says so.
 *
 * Responses are ordered the same way as `serverStatusRequests.ts` (owner
 * review on PR #463): each check gets a ticket, an apply or a newer check
 * makes the older ones stale, and a response is shown only when it was
 * compared with the very snapshot the panel shows (same `generation`, live
 * port and executable path) - never one for a listener that is gone.
 */
import type {
	FirewallField,
	FirewallRuleCheck,
	FirewallRuleStatus,
	FirewallUnknownReason
} from '#lib/banto/serverAdmin.js';
import type { FirewallInfo } from './firewallInfo';

const STATES = new Set(['missing', 'present', 'unknown']);

function isRuleCheck(value: unknown): value is FirewallRuleCheck {
	if (typeof value !== 'object' || value === null) return false;
	const check = value as Record<string, unknown>;
	if (typeof check.state !== 'string' || !STATES.has(check.state)) return false;
	if (check.state === 'unknown') return typeof check.reason === 'string';
	if (check.state === 'present') {
		return (
			typeof check.rule === 'object' &&
			check.rule !== null &&
			Array.isArray(check.mismatches) &&
			Array.isArray(check.unchecked)
		);
	}
	return true;
}

/**
 * Whether `value` has the shape of a `firewall_rule_status` response. An
 * older host has no such command (a stub or the IPC answers `null`), and
 * that must read as "could not check", not as "no rule".
 */
export function isFirewallRuleStatus(value: unknown): value is FirewallRuleStatus {
	if (typeof value !== 'object' || value === null) return false;
	const status = value as Record<string, unknown>;
	const expected = status.expected as Record<string, unknown> | null | undefined;
	return (
		typeof status.generation === 'number' &&
		typeof expected === 'object' &&
		expected !== null &&
		isRuleCheck(status.program) &&
		isRuleCheck(status.port)
	);
}

/**
 * Whether `status` was compared with the snapshot `info` shows: same
 * generation, live port and executable path. A host without `generation`
 * cannot be matched, so nothing is shown for it.
 */
export function firewallStatusMatches(info: FirewallInfo, status: FirewallRuleStatus): boolean {
	return (
		info.generation !== null &&
		status.generation === info.generation &&
		status.expected.port === info.port &&
		(status.expected.executablePath ?? null) === info.executablePath
	);
}

/** What one rule's state reads as on screen. */
export type FirewallRuleView =
	| { kind: 'missing' }
	/** Present and as the administrator command creates it. */
	| { kind: 'matches'; unchecked: FirewallField[] }
	/** Present but different (`fields`, e.g. changed to Block, a narrower source range, another exe, an old port). */
	| { kind: 'differs'; fields: FirewallField[]; unchecked: FirewallField[] }
	| { kind: 'unknown'; reason: FirewallUnknownReason };

export function firewallRuleView(check: FirewallRuleCheck): FirewallRuleView {
	switch (check.state) {
		case 'missing':
			return { kind: 'missing' };
		case 'unknown':
			return { kind: 'unknown', reason: check.reason };
		case 'present':
			return check.mismatches.length === 0
				? { kind: 'matches', unchecked: check.unchecked }
				: { kind: 'differs', fields: check.mismatches, unchecked: check.unchecked };
	}
}

/**
 * The value of `field` in `check`'s rule, as the firewall reports it (lists
 * joined with `, `). `null` for `active` (the panel words it) and when the
 * rule is not present.
 */
export function firewallFieldValue(check: FirewallRuleCheck, field: FirewallField): string | null {
	if (check.state !== 'present') return null;
	const rule = check.rule;
	switch (field) {
		case 'enabled':
			return rule.enabled;
		case 'direction':
			return rule.direction;
		case 'action':
			return rule.action;
		case 'protocol':
			return rule.protocol;
		case 'profile':
			return rule.profile;
		case 'program':
			return rule.program;
		case 'localPort':
			return rule.localPorts.join(', ');
		case 'remoteAddress':
			return rule.remoteAddresses.join(', ');
		case 'active':
			return null;
	}
}

/** What a check came to. */
export type FirewallCheckOutcome =
	/** Still the latest, and compared with the snapshot shown: show `status`. */
	| { kind: 'ok'; status: FirewallRuleStatus }
	/** An apply or a newer check came after it: dropped. */
	| { kind: 'superseded' }
	/**
	 * Compared with another snapshot than the one shown: dropped. `newer`:
	 * the host is already past what is shown, so the server status should be
	 * re-read (the panel then checks again for the new snapshot).
	 */
	| { kind: 'stale'; newer: boolean }
	/** The read failed or the host answered something else (still the latest). */
	| { kind: 'unavailable' };

export class FirewallStatusRequests {
	#latest = 0;

	/** Makes every check started so far stale (their responses are dropped). */
	invalidate(): void {
		this.#latest++;
	}

	/**
	 * Reads the status with `get`, and decides whether it may be shown for
	 * what the panel shows when the answer arrives (`shown`, read then - not
	 * when the check started).
	 */
	async check(
		get: () => Promise<unknown>,
		shown: () => FirewallInfo | null
	): Promise<FirewallCheckOutcome> {
		const ticket = ++this.#latest;
		let value: unknown;
		try {
			value = await get();
		} catch {
			return ticket === this.#latest ? { kind: 'unavailable' } : { kind: 'superseded' };
		}
		if (ticket !== this.#latest) return { kind: 'superseded' };
		if (!isFirewallRuleStatus(value)) return { kind: 'unavailable' };
		const info = shown();
		if (info === null) return { kind: 'superseded' };
		if (!firewallStatusMatches(info, value)) {
			return {
				kind: 'stale',
				newer: info.generation !== null && value.generation > info.generation
			};
		}
		return { kind: 'ok', status: value };
	}
}
