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
		firewallStatusMatches
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
		switch (outcome.kind) {
			case 'ok':
				result = outcome.status;
				break;
			case 'unavailable':
				problem = 'unavailable';
				break;
			case 'stale':
				if (outcome.newer) {
					// The status re-read changes `info`, and the effect below checks again.
					void refresh();
				} else {
					problem = 'changed';
				}
				break;
		}
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
		}
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
		{:else if view.kind === 'differs'}
			<p class="error">{m['settings.firewallStatusDiffers']()}</p>
			<ul>
				{#each view.fields as field (field)}
					{@const value = firewallFieldValue(check, field)}
					<li>
						{fieldLabel(field)}:
						{#if field === 'active'}
							{m['settings.firewallFieldActiveNo']()}
						{:else}
							<code>{value}</code>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p>{m['settings.firewallStatusUnknown']({ reason: reasonText(view.reason) })}</p>
		{/if}
		{#if (view.kind === 'matches' || view.kind === 'differs') && view.unchecked.length > 0}
			<p class="note">
				{m['settings.firewallStatusUnchecked']({
					fields: view.unchecked.map(fieldLabel).join(m['settings.firewallListSeparator']())
				})}
			</p>
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
