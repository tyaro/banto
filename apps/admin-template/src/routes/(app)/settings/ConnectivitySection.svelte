<script lang="ts">
	/**
	 * サーバ・接続カテゴリ（choiapp-feedback-2026-09 §3）: LANアクセス（QR /
	 * viewer-public 含む） / システム情報。`+page.svelte` の
	 * `<section id="connectivity">` ラッパー（admin 限定）から描画される
	 * （settings-split refactor: markup/state/CSS の移動のみ、挙動は変えない）。
	 *
	 * `systemInfoStore`（systemInfoStore.svelte.ts）は DataSection.svelte の
	 * `backupPostgresDialect` からも読まれる（spec M17）。初期ロード effect は
	 * settings-routes step 2（Copilot review on PR #198）で
	 * `settings/+layout.svelte` へ移した（`/settings/data` 等への直接遷移でも
	 * この値が要るため）- エラー表示は下の `systemInfoStore.error` を直接読む。
	 */
	import { Server, Wifi } from '@lucide/svelte';
	import * as m from '$lib/paraglide/messages';
	import SurfaceCard from '$lib/components/ui/SurfaceCard.svelte';
	import { applyServerSettings, getServerStatus, type ServerStatus } from '$lib/banto/serverAdmin';
	import { formatBytes, tauri } from './shared';
	import { authSettingsStore } from './authSettingsStore.svelte';
	import { systemInfoStore } from './systemInfoStore.svelte';

	let serverStatus = $state<ServerStatus | null>(null);
	let bindDraft = $state('127.0.0.1');
	let portDraft = $state(8721);
	let enabledDraft = $state(false);
	// viewer-public-plan §3.1-6 (ADR-0012): `server.viewerPublic` toggle,
	// same draft/apply pattern as `enabledDraft`/`bindDraft`/`portDraft`
	// above - `applyServerSettings`'s 4th argument.
	let viewerPublicDraft = $state(false);
	let applying = $state(false);
	let serverError: string | null = $state(null);

	function applyStatusToDrafts(status: ServerStatus): void {
		serverStatus = status;
		enabledDraft = status.enabled;
		bindDraft = status.bind;
		portDraft = status.port;
		viewerPublicDraft = status.viewerPublic;
	}

	$effect(() => {
		if (!tauri) return;
		void (async () => {
			try {
				applyStatusToDrafts(await getServerStatus());
			} catch (err) {
				serverError = err instanceof Error ? err.message : String(err);
			}
		})();
	});

	async function saveAndApply(): Promise<void> {
		applying = true;
		serverError = null;
		try {
			applyStatusToDrafts(
				await applyServerSettings(enabledDraft, bindDraft, portDraft, viewerPublicDraft)
			);
		} catch (err) {
			serverError = err instanceof Error ? err.message : String(err);
		} finally {
			applying = false;
		}
	}

	// The QR code shown is for the first LAN-reachable URL (i.e. not the
	// 127.0.0.1-only one) - that's the one another machine on the LAN would
	// actually need to scan; showing every URL's QR would just be noise.
	const firstLanUrl = $derived(
		serverStatus?.urls.find((url) => !url.includes('127.0.0.1')) ?? null
	);
	const firstLanQrSvg = $derived(
		firstLanUrl
			? (serverStatus?.qrSvgs.find((entry) => entry.url === firstLanUrl)?.svg ?? null)
			: null
	);

	// --- System Info (M-review 2026-08 §2.4, Tauri + LAN browser, admin only)
	// Read-only diagnostics: version, migration version, DB dialect+latency,
	// uptime, active LAN sessions, attachment storage. Same availability gate
	// as the audit/backups sections (real backend, not the plain-browser demo,
	// which has no live server to probe). Loaded by `settings/+layout.svelte`
	// (Copilot review on PR #198) rather than here - see `systemInfoStore.svelte.ts`'s
	// doc comment - so `systemInfoStore.error` below is written by that effect.
</script>

<div class="settings-grid">
	<SurfaceCard>
		<div class="card-head">
			<Wifi size={20} aria-hidden="true" />
			<div>
				<h3>{m['settings.lanHeading']()}</h3>
				<p>{m['settings.lanDesc']()}</p>
			</div>
		</div>
		{#if tauri}
			<!-- viewer-public-plan §3.1-6 (ADR-0012): the opt-in that lets
			     "auth disabled + LAN enabled" pass validation at all (§2.3).
			     Shown above the LAN toggle so the dependency reads top to
			     bottom - check this, then the toggle below unlocks. -->
			<label class="switch-row">
				<input
					type="checkbox"
					role="switch"
					class="banto-switch"
					bind:checked={viewerPublicDraft}
				/>
				{m['settings.viewerPublicToggle']()}
			</label>
			<p class="note warning">{m['settings.viewerPublicNote']()}</p>

			<label
				class="switch-row"
				class:disabled={authSettingsStore.value?.disabled && !viewerPublicDraft}
			>
				<input
					type="checkbox"
					role="switch"
					class="banto-switch"
					bind:checked={enabledDraft}
					disabled={authSettingsStore.value?.disabled && !viewerPublicDraft}
				/>
				{m['settings.lanToggle']()}
			</label>
			{#if authSettingsStore.value?.disabled}
				<p class="note">{m['settings.lanDisabledByAuth']()}</p>
			{/if}

			<div class="server-fields">
				<label class="field">
					{m['settings.bindAddress']()}
					<select class="banto-input" bind:value={bindDraft}>
						<option value="127.0.0.1">{m['settings.bindLocalOnly']()}</option>
						<option value="0.0.0.0">{m['settings.bindLanPublic']()}</option>
					</select>
				</label>

				<label class="field">
					{m['settings.port']()}
					<input class="banto-input" type="number" min="1" max="65535" bind:value={portDraft} />
				</label>
			</div>

			<button
				type="button"
				class="banto-btn banto-btn--primary"
				onclick={saveAndApply}
				disabled={applying}
			>
				{m['settings.saveAndApply']()}
			</button>

			{#if serverError}
				<p class="error">{serverError}</p>
			{/if}

			{#if serverStatus}
				<p class="status">
					{m['settings.statusLabel']()}
					<strong>{serverStatus.running ? m['settings.running']() : m['settings.stopped']()}</strong
					>
				</p>
				{#if serverStatus.running}
					<ul class="urls">
						{#each serverStatus.urls as url (url)}
							<li><a href={url} target="_blank" rel="noreferrer">{url}</a></li>
						{/each}
					</ul>
					{#if firstLanQrSvg}
						<!-- Server-generated QR SVG (Rust `qrcode` crate), not user input. -->
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						<div class="qr">{@html firstLanQrSvg}</div>
					{/if}
				{/if}
			{/if}
		{:else}
			<p class="note">{m['settings.serverDesktopOnly']()}</p>
		{/if}
		<p class="note">
			{m['settings.lanNote']()}
		</p>
	</SurfaceCard>

	{#if systemInfoStore.available}
		<SurfaceCard>
			<div class="card-head">
				<Server size={20} aria-hidden="true" />
				<div>
					<h3>{m['settings.systemInfoHeading']()}</h3>
					<p>{m['settings.systemInfoDesc']()}</p>
				</div>
			</div>

			{#if systemInfoStore.error}
				<p class="error">{systemInfoStore.error}</p>
			{:else if systemInfoStore.value}
				<p class="status">
					{m['settings.systemInfoAppVersion']()} <strong>{systemInfoStore.value.appVersion}</strong>
				</p>
				<p class="status">
					{m['settings.systemInfoMigration']()}
					<strong>{systemInfoStore.value.migrationVersion ?? '—'}</strong>
				</p>
				<p class="status">
					{m['settings.systemInfoDatabase']()}
					<strong>
						{systemInfoStore.value.dbDialect} ({m['settings.systemInfoLatencyValue']({
							ms: systemInfoStore.value.dbLatencyMs.toFixed(1)
						})})
					</strong>
				</p>
				<p class="status">
					{m['settings.systemInfoUptime']()}
					<strong
						>{m['settings.systemInfoUptimeValue']({
							secs: systemInfoStore.value.uptimeSecs
						})}</strong
					>
				</p>
				<p class="status">
					{m['settings.systemInfoSessions']()}
					<strong>{systemInfoStore.value.activeSessions}</strong>
				</p>
				<p class="status">
					{m['settings.systemInfoStorage']()}
					<strong>
						{systemInfoStore.value.attachmentBytes === null
							? '—'
							: formatBytes(systemInfoStore.value.attachmentBytes)}
					</strong>
				</p>
				{#if systemInfoStore.value.metrics}
					<p class="status">
						{m['settings.systemInfoHostCpu']()}
						<strong>
							{m['settings.systemInfoHostCpuValue']({
								percent: systemInfoStore.value.metrics.hostCpuPercent.toFixed(1),
								count: systemInfoStore.value.metrics.cpuCount
							})}
						</strong>
					</p>
					<p class="status">
						{m['settings.systemInfoHostMemory']()}
						<strong>
							{m['settings.systemInfoMemoryValue']({
								used: formatBytes(systemInfoStore.value.metrics.hostMemoryUsedBytes),
								total: formatBytes(systemInfoStore.value.metrics.hostMemoryTotalBytes)
							})}
						</strong>
					</p>
					{#if systemInfoStore.value.metrics.hostSwapTotalBytes > 0}
						<p class="status">
							{m['settings.systemInfoSwap']()}
							<strong>
								{m['settings.systemInfoMemoryValue']({
									used: formatBytes(systemInfoStore.value.metrics.hostSwapUsedBytes),
									total: formatBytes(systemInfoStore.value.metrics.hostSwapTotalBytes)
								})}
							</strong>
						</p>
					{/if}
					<p class="status">
						{m['settings.systemInfoProcess']()}
						<strong>
							{m['settings.systemInfoProcessValue']({
								percent: systemInfoStore.value.metrics.processCpuPercent.toFixed(1),
								rss: formatBytes(systemInfoStore.value.metrics.processMemoryBytes)
							})}
						</strong>
					</p>
				{/if}
			{:else}
				<p class="note">{m['settings.systemInfoLoading']()}</p>
			{/if}

			<p class="note">{m['settings.systemInfoNote']()}</p>
		</SurfaceCard>
	{/if}
</div>
