/**
 * 「共有する」の 3 ステップ（Issue #558、design-ux-review-2026-11 D-2）の判定。
 * ConnectivitySection.svelte が ① URL と QR → ② 別の端末からの接続確認の
 * 結果（緑／赤）→ ③ 届かなかったときの直し方 1 つ、の順に出す。
 *
 * ② は既存の接続確認（LanReachCheckPanel.svelte、lan-reach-check-design）の
 * 表示状態 `ReachView` をそのまま読む。期限切れは「届かないと決まった」わけでは
 * ない（読み取らなかっただけかもしれない）ので、赤でも「届きませんでした」とは
 * 断定せず、③ も「まず確かめること」1 つにとどめる。
 *
 * ③ の 1 つは、Windows ファイアウォールの規則の読み取り（FirewallRuleStatusPanel）
 * から選ぶ: 規則が無く、この画面から許可できる → 許可の確認画面
 * （FirewallChangeDialog）、規則が無いが許可できない（読めない・実行ファイルの
 * 場所が分からないなど）→ 詳しくの中のファイアウォールの情報、規則がある・
 * Windows 以外・まだ読めていない → 同じネットワークにいるかの確認。
 */
import type { FirewallChangeOperation, FirewallRuleStatus } from '#lib/banto/serverAdmin.js';
import type { ReachView } from './lanReachCheck';

/** ② の結果の色: ok = 緑、ng = 赤、waiting = 確認待ち、unknown = まだ確認していない・読めない。 */
export type ReachVerdict = 'ok' | 'ng' | 'waiting' | 'unknown';

export function reachVerdict(view: ReachView | null): ReachVerdict {
	switch (view?.kind) {
		case 'verified':
		case 'stale':
			return 'ok';
		case 'expired':
			return 'ng';
		case 'pending':
		case 'selfAccess':
			return 'waiting';
		default:
			return 'unknown';
	}
}

/**
 * What the Windows firewall read says about the most likely fix:
 * `allow` = no rule, and this screen can add it; `manual` = no rule (or it
 * could not be read) but it cannot be added from here; `present` = a rule
 * (per executable or per port) is there. `null` = nothing to say (not read
 * yet, or not Windows).
 */
export type FirewallFixHint = 'allow' | 'manual' | 'present';

export function firewallFixHint(
	status: FirewallRuleStatus | null,
	actions: readonly FirewallChangeOperation[]
): FirewallFixHint | null {
	if (status === null) return null;
	const program = status.program;
	// Either rule (per executable, or the per-port one) lets the port through.
	if (program.state === 'present' || status.port.state === 'present') return 'present';
	if (actions.includes('allow')) return 'allow';
	if (program.state === 'unknown' && program.reason === 'notWindows') return null;
	return 'manual';
}

/** ③ の直し方（1 つだけ）。 */
export type ShareFix =
	/** Windows ファイアウォールで許可する（確認画面を開く）。 */
	| 'firewallAllow'
	/** 詳しくの中のファイアウォールの情報を見る（手で許可する）。 */
	| 'firewallInfo'
	/** 同じネットワーク（同じ Wi-Fi）につながっているか確かめる。 */
	| 'network';

/** ③ に出す 1 つ。② が赤（期限切れ）のときだけ。 */
export function shareFix(verdict: ReachVerdict, firewall: FirewallFixHint | null): ShareFix | null {
	if (verdict !== 'ng') return null;
	if (firewall === 'allow') return 'firewallAllow';
	if (firewall === 'manual') return 'firewallInfo';
	return 'network';
}
