<script lang="ts">
	/**
	 * 「Windows ファイアウォールの状態」（Issue #219 段階 1 / PR-B）。
	 * spec §11.4（LAN 設定の UX・Windows ファイアウォールの案内）。
	 * FirewallInfoPanel.svelte の中、管理者向けのコマンドの下に出す。
	 *
	 * `firewall_rule_status` で、上のコマンドが作るルール（決まった名前）が
	 * Windows ファイアウォールにあるかを読み取りだけで確かめ、形ごとに
	 * 「ルール無し」「あり（期待どおり）」「あり（期待と違う: 項目）」
	 * 「確認できない（理由）」を出す。ルールがあることと LAN から接続できる
	 * ことは同じではないので、そのことも書く。
	 *
	 * 照合するのは ActiveStore の（効いている）ルール。ActiveStore にあっても
	 * 適用されているとは限らないので、EnforcementStatus が Full のときだけ
	 * 「適用されている」、ほかの既知の値は「存在するが適用されていない（理由）」、
	 * 読めない・未知の値は「適用状態は不明」と分けて出す。出どころがローカルの
	 * ストアでなければ種別（グループポリシー・MDM・Dynamic など）と出どころを、
	 * 取得できなければ「出どころ不明」を、ローカルのルールが無い・値が違う・
	 * 読めないときはそれを補足で出す（PR #465 の Codex・オーナーの指摘）。
	 *
	 * 再確認が失敗したら前回の結果は消す（エラーと並べて古い結果を出さない）。
	 *
	 * 応答は `firewallRuleStatus.ts` の `FirewallStatusRequests` で順序を
	 * 守る: 適用の開始・新しい確認で古い確認を捨て、表示している snapshot
	 * （generation・ポート・実行ファイル）と照合した結果だけを出す。
	 *
	 * 文言はすべて messages 経由（conventions §13）。
	 */
	import { untrack } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';
	import {
		getFirewallRuleStatus,
		type FirewallEnforcement,
		type FirewallField,
		type FirewallRuleCheck,
		type FirewallRuleStatus,
		type FirewallUnknownReason
	} from '#lib/banto/serverAdmin.js';
	import { firewallRuleNames, type FirewallInfo } from './firewallInfo';
	import {
		FirewallStatusRequests,
		firewallFieldValue,
		firewallRuleView,
		firewallStatusMatches,
		nextFirewallPanelState,
		type FirewallOriginView
	} from './firewallRuleStatus';
	import type { StatusRefresh } from './serverStatusRequests';

	interface Props {
		/** The live snapshot the firewall block shows. */
		info: FirewallInfo;
		/** The Tauri bundle identifier (`null` until known or when unavailable). */
		identifier: string | null;
		/** Re-read the server status (when the host is already past `info`). */
		refresh: () => Promise<StatusRefresh>;
		/** The section is applying new settings: pending checks are dropped. */
		applying: boolean;
	}

	let { info, identifier, refresh, applying }: Props = $props();

	const requests = new FirewallStatusRequests();
	let result = $state<FirewallRuleStatus | null>(null);
	let checking = $state(false);
	let problem = $state<'unavailable' | 'changed' | null>(null);

	// Only a result compared with what is shown now is ever displayed.
	const shown = $derived(result !== null && firewallStatusMatches(info, result) ? result : null);
	const target = $derived(`${info.generation}|${info.port}|${info.executablePath ?? ''}`);

	async function check(): Promise<void> {
		checking = true;
		problem = null;
		const outcome = await requests.check(getFirewallRuleStatus, () => untrack(() => info));
		if (outcome.kind === 'superseded') return;
		checking = false;
		// A failed check clears the previous result (never shown next to the error).
		const next = nextFirewallPanelState({ result, problem }, outcome);
		result = next.result;
		problem = next.problem;
		// The status re-read changes `info`, and the effect below checks again.
		if (next.refresh) void refresh();
	}

	$effect(() => {
		void target;
		if (applying) {
			untrack(() => requests.invalidate());
			return;
		}
		untrack(() => void check());
	});

	const names = $derived(identifier === null ? null : firewallRuleNames(identifier));

	function fieldLabel(field: FirewallField): string {
		switch (field) {
			case 'enabled':
				return m['settings.firewallFieldEnabled']();
			case 'direction':
				return m['settings.firewallFieldDirection']();
			case 'action':
				return m['settings.firewallFieldAction']();
			case 'protocol':
				return m['settings.firewallFieldProtocol']();
			case 'profile':
				return m['settings.firewallFieldProfile']();
			case 'program':
				return m['settings.firewallFieldProgram']();
			case 'localPort':
				return m['settings.firewallFieldLocalPort']();
			case 'remoteAddress':
				return m['settings.firewallFieldRemoteAddress']();
			case 'active':
				return m['settings.firewallFieldActive']();
			case 'enforcement':
				return m['settings.firewallFieldEnforcement']();
		}
	}

	function originKind(origin: FirewallOriginView): string {
		const sourceType = origin.sourceType ?? '';
		switch (origin.kind) {
			case 'groupPolicy':
				return m['settings.firewallSourceGroupPolicy']();
			case 'mdm':
				return m['settings.firewallSourceMdm']();
			case 'dynamic':
				return m['settings.firewallSourceDynamic']();
			case 'generated':
				return m['settings.firewallSourceGenerated']();
			case 'hardcoded':
				return m['settings.firewallSourceHardcoded']();
			case 'hostFirewallLocal':
			case 'hostFirewallGroupPolicy':
			case 'hostFirewallDynamic':
			case 'hostFirewallMdm':
				return m['settings.firewallSourceHostFirewall']({ sourceType });
			case 'other':
			case 'unknown':
				return m['settings.firewallSourceOther']({ sourceType });
		}
	}

	function originText(origin: FirewallOriginView): string {
		const source = origin.source ?? m['settings.firewallSourceUnknown']();
		if (origin.kind === 'unknown') return m['settings.firewallStatusOriginUnknown']({ source });
		const kind = originKind(origin);
		return origin.policy
			? m['settings.firewallStatusPolicy']({ kind, source })
			: m['settings.firewallStatusOrigin']({ kind, source });
	}

	function notEnforcedText(enforcement: FirewallEnforcement | null): string {
		const reasons =
			enforcement?.state === 'notEnforced'
				? enforcement.reasons.join(m['settings.firewallListSeparator']())
				: m['settings.firewallSourceUnknown']();
		return m['settings.firewallEnforcementNotEnforced']({ reasons });
	}

	function reasonText(reason: FirewallUnknownReason): string {
		switch (reason) {
			case 'notWindows':
				return m['settings.firewallReasonNotWindows']();
			case 'invalidIdentifier':
				return m['settings.firewallReasonInvalidIdentifier']();
			case 'launchFailed':
				return m['settings.firewallReasonLaunchFailed']();
			case 'timeout':
				return m['settings.firewallReasonTimeout']();
			case 'queryFailed':
				return m['settings.firewallReasonQueryFailed']();
			case 'unreadableOutput':
				return m['settings.firewallReasonUnreadableOutput']();
		}
	}
</script>

{#snippet ruleStatus(title: string, name: string | null, check: FirewallRuleCheck)}
	{@const view = firewallRuleView(check)}
	<div class="firewall-rule-status" data-state={view.kind}>
		<p class="firewall-command-title">
			{title}
			{#if name}<code>{name}</code>{/if}
		</p>
		{#if view.kind === 'missing'}
			<p>{m['settings.firewallStatusMissing']()}</p>
		{:else if view.kind === 'matches'}
			<p>{m['settings.firewallStatusMatches']()}</p>
		{:else if view.kind === 'unconfirmed'}
			<p class="error">{m['settings.firewallStatusUnconfirmed']()}</p>
		{:else if view.kind === 'differs'}
			<p class="error">{m['settings.firewallStatusDiffers']()}</p>
			<ul>
				{#each view.fields as field (field)}
					{@const value = firewallFieldValue(check, field)}
					<li>
						{fieldLabel(field)}:
						{#if field === 'active'}
							{m['settings.firewallFieldActiveNo']()}
						{:else if field === 'enforcement'}
							{notEnforcedText(view.enforcement)}
						{:else}
							<code>{value}</code>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p>{m['settings.firewallStatusUnknown']({ reason: reasonText(view.reason) })}</p>
		{/if}
		{#if view.kind === 'matches' || view.kind === 'unconfirmed' || view.kind === 'differs'}
			{#if view.enforcement?.state === 'enforced'}
				<p class="note" data-enforcement="enforced">
					{m['settings.firewallEnforcementEnforced']()}
				</p>
			{:else if view.enforcement?.state === 'unknown'}
				<p class="note" data-enforcement="unknown">
					{view.enforcement.values.length > 0
						? m['settings.firewallEnforcementUnknown']({
								values: view.enforcement.values.join(', ')
							})
						: m['settings.firewallEnforcementUnread']()}
				</p>
			{/if}
			{#if view.origin}
				<p
					class="note"
					data-origin={view.origin.kind === 'unknown'
						? 'unknown'
						: view.origin.policy
							? 'policy'
							: 'other'}
				>
					{originText(view.origin)}
				</p>
			{/if}
			{#if view.local.kind === 'missing'}
				<p class="note" data-local="missing">{m['settings.firewallStatusLocalMissing']()}</p>
			{:else if view.local.kind === 'differs'}
				<p class="note" data-local="differs">{m['settings.firewallStatusLocalDiffers']()}</p>
				<ul>
					{#each view.local.values as local (local.field)}
						<li>{fieldLabel(local.field)}: <code>{local.value}</code></li>
					{/each}
				</ul>
			{:else if view.local.kind === 'unknown'}
				<p class="note" data-local="unknown">{m['settings.firewallStatusLocalUnknown']()}</p>
			{/if}
			{#if view.unchecked.length > 0}
				<p class="note">
					{m['settings.firewallStatusUnchecked']({
						fields: view.unchecked.map(fieldLabel).join(m['settings.firewallListSeparator']())
					})}
				</p>
			{/if}
		{/if}
	</div>
{/snippet}

<div class="firewall-status">
	<h4>{m['settings.firewallStatusHeading']()}</h4>
	<p class="note">{m['settings.firewallStatusDesc']()}</p>

	<div role="status" aria-live="polite">
		{#if shown}
			{@render ruleStatus(
				m['settings.firewallStatusRuleProgram'](),
				names?.programName ?? null,
				shown.program
			)}
			{@render ruleStatus(
				m['settings.firewallStatusRulePort'](),
				names?.portName ?? null,
				shown.port
			)}
			{#if shown.groupOtherRules !== null && shown.groupOtherRules > 0 && names}
				<p class="note">
					{m['settings.firewallStatusGroupOther']({
						group: names.group,
						count: shown.groupOtherRules
					})}
				</p>
			{:else if shown.groupOtherRules === null && names}
				<p class="note" data-group="unknown">
					{m['settings.firewallStatusGroupUnknown']({ group: names.group })}
				</p>
			{/if}
		{:else if checking}
			<p class="note">{m['settings.firewallStatusChecking']()}</p>
		{/if}
		{#if problem === 'unavailable'}
			<p class="error">{m['settings.firewallStatusUnavailable']()}</p>
		{:else if problem === 'changed'}
			<p class="error">{m['settings.firewallStatusChanged']()}</p>
		{/if}
	</div>

	<button
		type="button"
		class="banto-btn banto-btn--secondary firewall-copy"
		onclick={() => check()}
		disabled={checking || applying}
	>
		{m['settings.firewallStatusRecheck']()}
	</button>

	<p class="note">{m['settings.firewallStatusReachNote']()}</p>
</div>
