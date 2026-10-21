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
 * Firewall holds under these names, and the panel says so. What is compared
 * is the rule in effect (the ActiveStore's), which a central policy of the
 * same name can override; the local rule is only a supplement (Codex review
 * on PR #465).
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
	FirewallRuleOrigin,
	FirewallRuleStatus,
	FirewallRuleValues,
	FirewallUnknownReason
} from '#lib/banto/serverAdmin.js';
import type { FirewallInfo } from './firewallInfo';

const STATES = new Set(['missing', 'present', 'unknown']);
const LOCAL_STATES = new Set(['missing', 'same', 'differs', 'unknown']);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isOrigin(value: unknown): boolean {
	return (
		value === null ||
		(isObject(value) &&
			typeof value.sourceType === 'string' &&
			typeof value.source === 'string' &&
			typeof value.local === 'boolean')
	);
}

function isLocalRule(value: unknown): boolean {
	if (!isObject(value) || typeof value.state !== 'string' || !LOCAL_STATES.has(value.state)) {
		return false;
	}
	return value.state !== 'differs' || isObject(value.rule);
}

function isRuleCheck(value: unknown): value is FirewallRuleCheck {
	if (typeof value !== 'object' || value === null) return false;
	const check = value as Record<string, unknown>;
	if (typeof check.state !== 'string' || !STATES.has(check.state)) return false;
	if (check.state === 'unknown') return typeof check.reason === 'string';
	if (check.state === 'present') {
		return (
			isObject(check.rule) &&
			isOrigin(check.origin) &&
			isLocalRule(check.local) &&
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

/** A local field and its value, where the local rule differs from the one in effect. */
export interface FirewallLocalValue {
	field: FirewallField;
	value: string;
}

/** The local rule next to the one in effect, as the panel words it. */
export type FirewallLocalView =
	/** Nothing to add: the local rule is the one shown, or has its values. */
	| { kind: 'same' }
	/** No local rule of this name (what applies comes from elsewhere). */
	| { kind: 'missing' }
	/** The local rule has other values (`values`, the local ones), and they do not apply. */
	| { kind: 'differs'; values: FirewallLocalValue[] }
	| { kind: 'unknown' };

/** What one rule's state reads as on screen. */
export type FirewallRuleView =
	| { kind: 'missing' }
	/**
	 * Present and as the administrator command creates it. `policy`: the
	 * rule in effect comes from central management (Group Policy and the
	 * like), not the local store.
	 */
	| {
			kind: 'matches';
			unchecked: FirewallField[];
			policy: FirewallRuleOrigin | null;
			local: FirewallLocalView;
	  }
	/** Present but different (`fields`, e.g. changed to Block, a narrower source range, another exe, an old port). */
	| {
			kind: 'differs';
			fields: FirewallField[];
			unchecked: FirewallField[];
			policy: FirewallRuleOrigin | null;
			local: FirewallLocalView;
	  }
	| { kind: 'unknown'; reason: FirewallUnknownReason };

const VALUE_FIELDS: readonly FirewallField[] = [
	'enabled',
	'direction',
	'action',
	'protocol',
	'profile',
	'program',
	'localPort',
	'remoteAddress'
];

/**
 * The fields where `local` differs from `effective`, ignoring case (as
 * src-tauri's `same_values`). The ActiveStore expands environment variables
 * in a program path, so a local path with `%` is not held against it.
 */
function localDifferences(
	local: FirewallRuleValues,
	effective: FirewallRuleValues
): FirewallLocalValue[] {
	const values: FirewallLocalValue[] = [];
	for (const field of VALUE_FIELDS) {
		const a = ruleFieldValue(local, field) ?? '';
		const b = ruleFieldValue(effective, field) ?? '';
		if (field === 'program' && a.includes('%')) continue;
		if (a.toLowerCase() !== b.toLowerCase()) values.push({ field, value: a });
	}
	return values;
}

function localView(check: Extract<FirewallRuleCheck, { state: 'present' }>): FirewallLocalView {
	switch (check.local.state) {
		case 'same':
			return { kind: 'same' };
		case 'missing':
			return { kind: 'missing' };
		case 'unknown':
			return { kind: 'unknown' };
		case 'differs': {
			const values = localDifferences(check.local.rule, check.rule);
			return values.length === 0 ? { kind: 'same' } : { kind: 'differs', values };
		}
	}
}

export function firewallRuleView(check: FirewallRuleCheck): FirewallRuleView {
	switch (check.state) {
		case 'missing':
			return { kind: 'missing' };
		case 'unknown':
			return { kind: 'unknown', reason: check.reason };
		case 'present': {
			const policy = check.origin !== null && !check.origin.local ? check.origin : null;
			const local = localView(check);
			return check.mismatches.length === 0
				? { kind: 'matches', unchecked: check.unchecked, policy, local }
				: {
						kind: 'differs',
						fields: check.mismatches,
						unchecked: check.unchecked,
						policy,
						local
					};
		}
	}
}

/**
 * The value of `field` in `check`'s rule (the one in effect), as the
 * firewall reports it (lists joined with `, `). `null` for `active` (the
 * panel words it) and when the rule is not present.
 */
export function firewallFieldValue(check: FirewallRuleCheck, field: FirewallField): string | null {
	return check.state === 'present' ? ruleFieldValue(check.rule, field) : null;
}

function ruleFieldValue(rule: FirewallRuleValues, field: FirewallField): string | null {
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
