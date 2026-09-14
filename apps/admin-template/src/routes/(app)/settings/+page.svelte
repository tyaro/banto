<script lang="ts">
	/**
	 * 設定ページ（choiapp-feedback-2026-09 §3: 5カテゴリの節構成）。
	 *
	 * settings-split refactor（choiapp-feedback-2026-09 §3.1、二段階の1段目）:
	 * カテゴリ毎のカード markup/state/ハンドラ/CSS は co-located な
	 * section コンポーネント（AppearanceSection.svelte 等）へ移した。この
	 * ページ自身は (1) ページ見出し、(2) カテゴリジャンプ用の in-page nav、
	 * (3) 各 `<section id=… class="settings-section" aria-labelledby=…>` +
	 * `<h2>` ラッパーだけを持つ - DOM の id/見出し/アンカー/ページ全体の
	 * `.settings-section`/`.settings-grid` 系 CSS を変えないため（section
	 * コンポーネントが描画する内側の `<div class="settings-grid">` を
	 * ラッパーごと section コンポーネントに含めてしまうと、DOM 構造自体は
	 * 同じでも「どのファイルが何を描画するか」の境界が曖昧になるので、
	 * ラッパーは明示的にこちらへ残した）。
	 *
	 * 表示条件（showConnectivity/showData/showSecurity）は各 section が
	 * 自分の内部カード条件として独立に再計算しているのと同じ式をここでも
	 * 評価している - isAdmin()/isAuditLogAvailable()/isBackupsAvailable()/
	 * isTauri() はいずれも副作用の無い純粋な判定なので、二重に呼んでも
	 * 挙動は変わらない。
	 */
	import * as m from '$lib/paraglide/messages';
	import PageHeader from '$lib/components/ui/PageHeader.svelte';
	import { sessionStore } from '$lib/session.svelte';
	import { isAdmin } from '$lib/permissions';
	import { isAuditLogAvailable } from '$lib/banto/auditLogAdmin';
	import { isBackupsAvailable } from '$lib/banto/backupsAdmin';
	import { tauri } from './shared';
	import AppearanceSection from './AppearanceSection.svelte';
	import AccountSection from './AccountSection.svelte';
	import ConnectivitySection from './ConnectivitySection.svelte';
	import DataSection from './DataSection.svelte';
	import SecuritySection from './SecuritySection.svelte';
	import './settings.css';

	const auditAvailable = isAuditLogAvailable();
	const backupsAvailable = isBackupsAvailable();

	// ESCAPE HATCH (spec M11, mirrors `auth_config_apply`'s Rust doc comment):
	// while login-not-required mode is CURRENTLY on, any role may still reach
	// SecuritySection - otherwise a synthetic session below `admin` (e.g. a
	// kiosk set to `viewer`) could never turn auth back on.
	const canManageAuthMode = $derived(isAdmin(sessionStore.role) || sessionStore.authDisabled);

	// --- Category sections (choiapp-feedback-2026-09 §3) -----------------------
	// Cards are grouped into titled category sections instead of one flat
	// grid. A section renders only when at least one of its cards does, and
	// the in-page category nav below mirrors exactly the rendered sections
	// (capability-hide, spec §11.3 - no greyed-out entries). Everything
	// stays on ONE page (anchor jumps, not tabs): every card keeps rendering
	// for the e2e smoke/visual/axe suites, and a settings page short enough
	// not to scroll simply ignores the anchors.
	const showConnectivity = $derived(isAdmin(sessionStore.role));
	const showData = $derived(isAdmin(sessionStore.role) && (auditAvailable || backupsAvailable));
	const showSecurity = $derived(tauri && canManageAuthMode);

	const sectionNavEntries = $derived(
		[
			{ id: 'appearance', label: m['settings.sectionAppearance'], visible: true },
			{ id: 'account', label: m['settings.sectionAccount'], visible: true },
			{ id: 'connectivity', label: m['settings.sectionConnectivity'], visible: showConnectivity },
			{ id: 'data', label: m['settings.sectionData'], visible: showData },
			{ id: 'security', label: m['settings.sectionSecurity'], visible: showSecurity }
		].filter((entry) => entry.visible)
	);
</script>

<div class="page settings-page">
	<PageHeader title={m['nav.settings']()} description={m['settings.pageDescription']()} />

	<nav class="section-nav" aria-label={m['settings.sectionNavAria']()}>
		{#each sectionNavEntries as entry (entry.id)}
			<a href="#{entry.id}">{entry.label()}</a>
		{/each}
	</nav>

	<section id="appearance" class="settings-section" aria-labelledby="appearance-heading">
		<h2 id="appearance-heading" class="section-heading">{m['settings.sectionAppearance']()}</h2>
		<AppearanceSection />
	</section>

	<section id="account" class="settings-section" aria-labelledby="account-heading">
		<h2 id="account-heading" class="section-heading">{m['settings.sectionAccount']()}</h2>
		<AccountSection />
	</section>

	{#if showConnectivity}
		<section id="connectivity" class="settings-section" aria-labelledby="connectivity-heading">
			<h2 id="connectivity-heading" class="section-heading">
				{m['settings.sectionConnectivity']()}
			</h2>
			<ConnectivitySection />
		</section>
	{/if}

	{#if showData}
		<section id="data" class="settings-section" aria-labelledby="data-heading">
			<h2 id="data-heading" class="section-heading">{m['settings.sectionData']()}</h2>
			<DataSection />
		</section>
	{/if}

	{#if showSecurity}
		<section id="security" class="settings-section" aria-labelledby="security-heading">
			<h2 id="security-heading" class="section-heading">{m['settings.sectionSecurity']()}</h2>
			<SecuritySection />
		</section>
	{/if}
</div>
