<script lang="ts">
	/**
	 * 外観・言語カテゴリ（choiapp-feedback-2026-09 §3）: テーマ / 言語 /
	 * キオスク / ウィンドウ効果(vibrancy)。`+page.svelte` の
	 * `<section id="appearance">` ラッパーから描画される（settings-split
	 * refactor: markup/state/CSS の移動のみ、挙動は変えない）。
	 */
	import type { Component } from 'svelte';
	import type { ThemeDensity, ThemeMode, ThemePreset } from '@banto/theme';
	import {
		Check,
		Languages,
		Monitor,
		MonitorPlay,
		Moon,
		Palette,
		Rows3,
		Rows4,
		Sparkles,
		Sun
	} from '@lucide/svelte';
	import * as m from '$lib/paraglide/messages';
	import { getLocale, locales, setLocale, type Locale } from '$lib/paraglide/runtime';
	import SurfaceCard from '$lib/components/ui/SurfaceCard.svelte';
	import { settings } from '$lib/settings.svelte';
	import { applyVibrancy, getVibrancyStatus, type VibrancyStatus } from '$lib/banto/vibrancy';
	import { toastStore } from '$lib/toast.svelte';
	import { sessionStore } from '$lib/session.svelte';
	import { isAdmin } from '$lib/permissions';
	import { errorMessage, tauri } from './shared';

	const modes: { value: ThemeMode; label: string }[] = [
		{ value: 'light', label: m['settings.modeLight']() },
		{ value: 'dark', label: m['settings.modeDark']() },
		{ value: 'system', label: m['settings.modeSystem']() }
	];

	// M12 preset axis (standard/glass), orthogonal to light/dark above.
	const presets: { value: ThemePreset; label: string }[] = [
		{ value: 'standard', label: m['settings.presetStandard']() },
		{ value: 'glass', label: m['settings.presetGlass']() }
	];

	// Density axis (visual-refresh-design.md §4.3), orthogonal to
	// theme/preset. settings.setThemeDensity() persistence is unchanged -
	// this page only adds the picker UI.
	const densities: { value: ThemeDensity; label: string }[] = [
		{ value: 'standard', label: m['settings.densityStandard']() },
		{ value: 'compact', label: m['settings.densityCompact']() }
	];

	const modeIcons: Record<ThemeMode, Component> = { light: Sun, dark: Moon, system: Monitor };
	const densityIcons: Record<ThemeDensity, Component> = { standard: Rows3, compact: Rows4 };

	// --- i18n layer ② (ADR-0005): the language picker ---------
	// Locale labels are shown in each language's OWN native name (日本語 /
	// English) rather than translated - a picker reads better when each option
	// names itself, so these two keys hold the same value in en.json and ja.json.
	// `getLocale()` is the resolved locale for this page load; changing it goes
	// through Paraglide's `setLocale()`, whose custom-banto strategy (locale.ts)
	// persists to localStorage + the M12 provider and reloads so every screen
	// re-renders in the new locale (the reload is Paraglide's default).
	const localeLabels: Record<Locale, () => string> = {
		ja: m['settings.languageJa'],
		en: m['settings.languageEn']
	};

	function changeLocale(next: Locale): void {
		if (next === getLocale()) return;
		setLocale(next);
	}

	// --- M12: window vibrancy (Tauri only, admin only, Windows only) --------
	// The whole section renders only when `vibrancy_status()` reports
	// `supported: true` (spec §11.3: capability-hide, don't grey out).
	let vibrancyStatus = $state<VibrancyStatus | null>(null);
	let applyingVibrancy = $state(false);

	$effect(() => {
		if (!tauri || !isAdmin(sessionStore.role)) return;
		void (async () => {
			try {
				vibrancyStatus = await getVibrancyStatus();
			} catch {
				// An older backend without the command (Phase A not deployed
				// yet) or any failure: keep the section hidden, never broken.
				vibrancyStatus = null;
			}
		})();
	});

	async function toggleVibrancy(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const next = input.checked;
		applyingVibrancy = true;
		try {
			const enabled = await applyVibrancy(next);
			if (vibrancyStatus) vibrancyStatus = { ...vibrancyStatus, enabled };
		} catch (err) {
			toastStore.push('error', errorMessage(err));
			input.checked = vibrancyStatus?.enabled ?? false;
		} finally {
			applyingVibrancy = false;
		}
	}
</script>

<div class="settings-grid">
	<SurfaceCard>
		<div class="card-head">
			<Palette size={20} aria-hidden="true" />
			<div>
				<h3>{m['settings.themeHeading']()}</h3>
				<p>{m['settings.themeDesc']()}</p>
			</div>
		</div>

		<div class="options mode-options" role="radiogroup" aria-label={m['settings.themeHeading']()}>
			{#each modes as mode (mode.value)}
				{@const ModeIcon = modeIcons[mode.value]}
				<label class="theme-option" class:selected={settings.themeMode === mode.value}>
					<input
						type="radio"
						name="theme"
						value={mode.value}
						checked={settings.themeMode === mode.value}
						onchange={() => settings.setThemeMode(mode.value)}
					/>
					<span class="theme-preview" data-preview-mode={mode.value} aria-hidden="true">
						<span class="preview-header"></span>
						<span class="preview-row">
							<span class="preview-sidebar"></span>
							<span class="preview-surface"></span>
						</span>
					</span>
					<ModeIcon size={14} aria-hidden="true" />{mode.label}
					{#if settings.themeMode === mode.value}
						<Check size={14} aria-hidden="true" />
					{/if}
				</label>
			{/each}
		</div>

		<h4>{m['settings.presetHeading']()}</h4>
		<div
			class="options preset-options"
			role="radiogroup"
			aria-label={m['settings.presetGroupAria']()}
		>
			{#each presets as preset (preset.value)}
				<label class="theme-option" class:selected={settings.themePreset === preset.value}>
					<input
						type="radio"
						name="theme-preset"
						value={preset.value}
						checked={settings.themePreset === preset.value}
						onchange={() => settings.setThemePreset(preset.value)}
					/>
					<span class="preset-preview" data-preset={preset.value} aria-hidden="true"></span>
					{preset.label}
					{#if settings.themePreset === preset.value}
						<Check size={14} aria-hidden="true" />
					{/if}
				</label>
			{/each}
		</div>

		<h4>{m['settings.densityHeading']()}</h4>
		<div
			class="options density-options"
			role="radiogroup"
			aria-label={m['settings.densityHeading']()}
		>
			{#each densities as density (density.value)}
				{@const DensityIcon = densityIcons[density.value]}
				<label class="theme-option" class:selected={settings.themeDensity === density.value}>
					<input
						type="radio"
						name="density"
						value={density.value}
						checked={settings.themeDensity === density.value}
						onchange={() => settings.setThemeDensity(density.value)}
					/>
					<DensityIcon size={16} aria-hidden="true" />{density.label}
					{#if settings.themeDensity === density.value}
						<Check size={14} aria-hidden="true" />
					{/if}
				</label>
			{/each}
		</div>

		<p class="note">
			{m['settings.themeNote']()}
		</p>
	</SurfaceCard>

	<SurfaceCard>
		<div class="card-head">
			<Languages size={20} aria-hidden="true" />
			<div>
				<h3>{m['settings.languageHeading']()}</h3>
				<p>{m['settings.languageDesc']()}</p>
			</div>
		</div>

		<label class="field">
			{m['settings.languageLabel']()}
			<select
				class="banto-input"
				value={getLocale()}
				onchange={(event) => changeLocale(event.currentTarget.value as Locale)}
			>
				{#each locales as loc (loc)}
					<option value={loc}>{localeLabels[loc]()}</option>
				{/each}
			</select>
		</label>

		<p class="note">
			{m['settings.languageNote']()}
		</p>
	</SurfaceCard>

	<SurfaceCard>
		<div class="card-head">
			<MonitorPlay size={20} aria-hidden="true" />
			<div>
				<h3>{m['settings.kioskHeading']()}</h3>
				<p>{m['settings.kioskDesc']()}</p>
			</div>
		</div>
		<label class="switch-row">
			<input
				type="checkbox"
				role="switch"
				class="banto-switch"
				checked={settings.kiosk}
				onchange={(event) => settings.setKiosk(event.currentTarget.checked)}
			/>
			{m['settings.kioskToggle']()}
		</label>
	</SurfaceCard>

	{#if tauri && isAdmin(sessionStore.role) && vibrancyStatus?.supported}
		<SurfaceCard>
			<div class="card-head">
				<Sparkles size={20} aria-hidden="true" />
				<div>
					<h3>{m['settings.vibrancyHeading']()}</h3>
					<p>{m['settings.vibrancyDesc']()}</p>
				</div>
			</div>
			<label class="switch-row">
				<input
					type="checkbox"
					role="switch"
					class="banto-switch"
					checked={vibrancyStatus.enabled}
					disabled={applyingVibrancy}
					onchange={toggleVibrancy}
				/>
				{m['settings.vibrancyToggle']()}
			</label>
			<p class="note">
				{m['settings.vibrancyNote']()}
			</p>
		</SurfaceCard>
	{/if}
</div>
