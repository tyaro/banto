<script lang="ts">
	/**
	 * Theme lab (Issue #690, design-ux-review-2026-11 E-3): move the design
	 * tokens (brand hue, corner radius, density, font, light / dark) and see
	 * them on a sample of the shared parts, then take the changed variables
	 * home as CSS. Like `/ui-demo`, the sidebar entry exists only in the demo
	 * build (`demoOnly` in navigation.ts); the route itself is reachable by URL
	 * in every build.
	 *
	 * The knobs act only inside the preview element: it carries a nested
	 * `data-theme` (banto.css re-derives the role colours on every `[data-theme]`
	 * element), `data-banto-density` and the variables as an inline style. The
	 * shell is untouched. Nothing is saved: a reload returns to the defaults.
	 * The CSS text and the contrast ratios come from `#lib/themeLab.js`
	 * (pure, unit-tested).
	 */
	import {
		DateInput,
		PageHeader,
		SegmentedControl,
		StatusBadge,
		SurfaceCard,
		ToastHost,
		createToastStore,
		type SegmentedOption,
		type StatusBadgeVariant
	} from '@banto/ui';
	import { BantoGrid, columnsFromSchema } from '@banto/grid-svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { copyText } from '#lib/clipboard.js';
	import { columnValidationMessages, dateInputMessages, gridMessages } from '#lib/banto/i18n.js';
	import {
		DEFAULT_STATE,
		LAB_FONTS,
		MAX_RADIUS_MD,
		clampHue,
		clampRadius,
		contrastRows,
		exportCss,
		isDefaultState,
		previewStyle,
		radiusScale,
		type ContrastId,
		type LabDensity,
		type LabFontId,
		type LabState,
		type LabTheme
	} from '#lib/themeLab.js';
	// [scaffold:charts] begin
	import ThemeLabCharts from './ThemeLabCharts.svelte';
	// [scaffold:charts] end

	let hue = $state(DEFAULT_STATE.hue);
	let radiusMd = $state(DEFAULT_STATE.radiusMd);
	let density = $state<LabDensity>(DEFAULT_STATE.density);
	let font = $state<LabFontId>(DEFAULT_STATE.font);
	let theme = $state<LabTheme>(DEFAULT_STATE.theme);

	const lab: LabState = $derived({ hue, radiusMd, density, font, theme });
	const radii = $derived(radiusScale(radiusMd));
	const css = $derived(exportCss(lab));
	const unchanged = $derived(isDefaultState(lab));
	const rows = $derived(contrastRows(theme, hue));
	const failing = $derived(rows.some((row) => !row.ok));

	function reset() {
		hue = DEFAULT_STATE.hue;
		radiusMd = DEFAULT_STATE.radiusMd;
		density = DEFAULT_STATE.density;
		font = DEFAULT_STATE.font;
		theme = DEFAULT_STATE.theme;
	}

	function setHue(value: string) {
		const n = Number(value);
		// an empty box while typing is not a hue yet: leave the last one
		if (value.trim() !== '' && Number.isFinite(n)) hue = clampHue(n);
	}

	function setRadius(value: string) {
		const n = Number(value);
		if (value.trim() !== '' && Number.isFinite(n)) radiusMd = clampRadius(n);
	}

	const densityOptions: SegmentedOption<LabDensity>[] = $derived([
		{ value: 'standard', label: m['themeLab.density.standard']() },
		{ value: 'compact', label: m['themeLab.density.compact']() },
		{ value: 'touch', label: m['themeLab.density.touch']() }
	]);
	const themeOptions: SegmentedOption<LabTheme>[] = $derived([
		{ value: 'light', label: m['themeLab.theme.light']() },
		{ value: 'dark', label: m['themeLab.theme.dark']() }
	]);

	const fontLabels: Record<LabFontId, () => string> = {
		system: () => m['themeLab.font.system'](),
		gothic: () => m['themeLab.font.gothic'](),
		mincho: () => m['themeLab.font.mincho'](),
		rounded: () => m['themeLab.font.rounded'](),
		mono: () => m['themeLab.font.mono']()
	};

	const contrastLabels: Record<ContrastId, () => string> = {
		onPrimary: () => m['themeLab.contrast.onPrimary'](),
		onPrimaryHover: () => m['themeLab.contrast.onPrimaryHover'](),
		onAccent: () => m['themeLab.contrast.onAccent'](),
		primaryText: () => m['themeLab.contrast.primaryText'](),
		danger: () => m['themeLab.contrast.danger'](),
		warning: () => m['themeLab.contrast.warning'](),
		success: () => m['themeLab.contrast.success'](),
		info: () => m['themeLab.contrast.info']()
	};

	// --- export ---------------------------------------------------------
	let exportNote = $state('');

	async function copyCss() {
		exportNote = (await copyText(css))
			? m['themeLab.export.copied']()
			: m['themeLab.export.copyFailed']();
	}

	function saveCss() {
		const blob = new Blob([css], { type: 'text/css' });
		const url = URL.createObjectURL(blob);
		try {
			const a = document.createElement('a');
			a.href = url;
			a.download = 'banto-theme.css';
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	// --- preview samples ------------------------------------------------
	const badges: StatusBadgeVariant[] = ['neutral', 'success', 'warning', 'danger', 'info'];
	const badgeLabels: Record<StatusBadgeVariant, () => string> = {
		neutral: () => m['themeLab.preview.badge.neutral'](),
		success: () => m['themeLab.preview.badge.success'](),
		warning: () => m['themeLab.preview.badge.warning'](),
		danger: () => m['themeLab.preview.badge.danger'](),
		info: () => m['themeLab.preview.badge.info']()
	};

	let dueDate = $state<string | null>('2026-11-07');
	const dateMessages = dateInputMessages();
	let view = $state('list');
	const viewOptions: SegmentedOption[] = $derived([
		{ value: 'list', label: m['themeLab.preview.segmentList']() },
		{ value: 'card', label: m['themeLab.preview.segmentCard']() }
	]);

	// The toasts are the real `@banto/ui` ToastHost over a store of their own
	// (not the app's), kept inside the stage: `contain: layout` on the stage
	// makes it the containing block of the host's `position: fixed`.
	const toastStore = createToastStore();
	function showToasts() {
		for (const toast of [...toastStore.toasts]) toastStore.dismiss(toast.id);
		const sticky = { durationMs: 0 };
		toastStore.push('success', m['themeLab.preview.toast.success'](), sticky);
		toastStore.push('error', m['themeLab.preview.toast.error'](), sticky);
		toastStore.push('warning', m['themeLab.preview.toast.warning'](), sticky);
		toastStore.push('info', m['themeLab.preview.toast.info'](), sticky);
	}
	$effect(() => {
		showToasts();
	});

	interface Row {
		code: string;
		name: string;
		qty: number;
	}
	const gridRows: Row[] = [
		{ code: 'A-100', name: 'M8', qty: 120 },
		{ code: 'B-200', name: 'M10', qty: 48 },
		{ code: 'C-300', name: 'M12', qty: 7 }
	];
	const gridColumns = $derived(
		columnsFromSchema<Row>(
			{
				fields: [
					{ name: 'code', label: m['themeLab.preview.gridCode'](), type: 'text', readonly: true },
					{ name: 'name', label: m['themeLab.preview.gridName'](), type: 'text', readonly: true },
					{ name: 'qty', label: m['themeLab.preview.gridQty'](), type: 'number', readonly: true }
				]
			},
			{ messages: columnValidationMessages() }
		)
	);
</script>

<div class="page">
	<PageHeader hideTitle title={m['nav.themeLab']()} description={m['themeLab.intro']()} />

	<div class="lab">
		<div class="side">
			<SurfaceCard title={m['themeLab.controls.heading']()}>
				<div class="controls">
					<div class="knob">
						<label for="theme-lab-hue-number">{m['themeLab.hue.label']()}</label>
						<div class="knob-row">
							<input
								type="range"
								min="0"
								max="359"
								step="1"
								value={hue}
								aria-label={m['themeLab.hue.slider']()}
								oninput={(event) => setHue(event.currentTarget.value)}
								data-testid="theme-lab-hue-slider"
							/>
							<input
								id="theme-lab-hue-number"
								class="banto-input number"
								type="number"
								min="0"
								max="359"
								step="1"
								value={hue}
								oninput={(event) => setHue(event.currentTarget.value)}
								data-testid="theme-lab-hue"
							/>
						</div>
						<span class="hint">{m['themeLab.hue.hint']()}</span>
					</div>

					<div class="knob">
						<label for="theme-lab-radius">{m['themeLab.radius.label']()}</label>
						<div class="knob-row">
							<input
								id="theme-lab-radius"
								type="range"
								min="0"
								max={MAX_RADIUS_MD}
								step="1"
								value={radiusMd}
								aria-label={m['themeLab.radius.slider']()}
								oninput={(event) => setRadius(event.currentTarget.value)}
								data-testid="theme-lab-radius"
							/>
						</div>
						<span class="hint">
							{m['themeLab.radius.value']({ sm: radii.sm, md: radii.md, lg: radii.lg })}
						</span>
					</div>

					<div class="knob">
						<span id="theme-lab-density-label">{m['themeLab.density.label']()}</span>
						<SegmentedControl
							options={densityOptions}
							bind:value={density}
							name="theme-lab-density"
							labelledby="theme-lab-density-label"
						/>
					</div>

					<div class="knob">
						<label for="theme-lab-font">{m['themeLab.font.label']()}</label>
						<select id="theme-lab-font" class="banto-input" bind:value={font}>
							{#each LAB_FONTS as option (option.id)}
								<option value={option.id}>{fontLabels[option.id]()}</option>
							{/each}
						</select>
						<span class="hint">{m['themeLab.font.hint']()}</span>
					</div>

					<div class="knob">
						<span id="theme-lab-theme-label">{m['themeLab.theme.label']()}</span>
						<SegmentedControl
							options={themeOptions}
							bind:value={theme}
							name="theme-lab-theme"
							labelledby="theme-lab-theme-label"
						/>
					</div>

					<div>
						<button type="button" class="banto-btn banto-btn--secondary" onclick={reset}>
							{m['themeLab.reset']()}
						</button>
					</div>
				</div>
			</SurfaceCard>

			<SurfaceCard
				title={m['themeLab.contrast.heading']()}
				description={m['themeLab.contrast.caption']()}
			>
				<ul class="contrast" data-testid="theme-lab-contrast">
					{#each rows as row (row.id)}
						<li>
							<span class="contrast-label">{contrastLabels[row.id]()}</span>
							<span class="contrast-ratio">{row.ratio.toFixed(1)}:1</span>
							<StatusBadge
								variant={row.ok ? 'success' : 'danger'}
								label={row.ok ? m['themeLab.contrast.pass']() : m['themeLab.contrast.fail']()}
							/>
						</li>
					{/each}
				</ul>
				<p
					class="contrast-note"
					class:warn={failing}
					role="status"
					data-testid="theme-lab-contrast-note"
				>
					{failing ? m['themeLab.contrast.warn']() : m['themeLab.contrast.allPass']()}
				</p>
			</SurfaceCard>

			<SurfaceCard
				title={m['themeLab.export.heading']()}
				description={m['themeLab.export.caption']()}
			>
				<div class="export">
					{#if unchanged}
						<p class="hint" data-testid="theme-lab-export-default">
							{m['themeLab.export.default']()}
						</p>
					{/if}
					<!-- A scrollable region must be reachable by keyboard (axe: scrollable-region-focusable). -->
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<pre
						class="code"
						tabindex="0"
						aria-label={m['themeLab.export.codeLabel']()}
						data-testid="theme-lab-css"><code>{css}</code></pre>
					<div class="export-actions">
						<button type="button" class="banto-btn banto-btn--primary" onclick={copyCss}>
							{m['themeLab.export.copy']()}
						</button>
						<button type="button" class="banto-btn banto-btn--secondary" onclick={saveCss}>
							{m['themeLab.export.save']()}
						</button>
					</div>
					<p class="hint" role="status">{exportNote}</p>
				</div>
			</SurfaceCard>
		</div>

		<section class="stage" aria-labelledby="theme-lab-preview-heading">
			<h2 id="theme-lab-preview-heading" class="stage-heading">
				{m['themeLab.preview.heading']()}
			</h2>
			<div
				class="preview"
				role="group"
				aria-label={m['themeLab.preview.region']()}
				data-theme={theme}
				data-banto-density={density === 'standard' ? undefined : density}
				style={previewStyle(lab)}
				data-testid="theme-lab-preview"
			>
				<section>
					<h3>{m['themeLab.preview.buttons']()}</h3>
					<div class="row">
						<button type="button" class="banto-btn banto-btn--primary">{m['common.save']()}</button>
						<button type="button" class="banto-btn banto-btn--secondary">
							{m['common.cancel']()}
						</button>
						<button type="button" class="banto-btn banto-btn--ghost">{m['common.close']()}</button>
						<button type="button" class="banto-btn banto-btn--danger">
							{m['themeLab.preview.delete']()}
						</button>
					</div>
				</section>

				<section>
					<h3>{m['themeLab.preview.badges']()}</h3>
					<div class="row">
						{#each badges as variant (variant)}
							<StatusBadge {variant} label={badgeLabels[variant]()} />
						{/each}
					</div>
				</section>

				<section>
					<h3>{m['themeLab.preview.inputs']()}</h3>
					<div class="fields">
						<div class="field">
							<label for="theme-lab-sample-name">{m['themeLab.preview.inputLabel']()}</label>
							<input
								id="theme-lab-sample-name"
								class="banto-input"
								type="text"
								value={m['themeLab.preview.inputValue']()}
							/>
						</div>
						<div class="field">
							<label for="theme-lab-sample-date">{m['themeLab.preview.dateLabel']()}</label>
							<DateInput
								id="theme-lab-sample-date"
								bind:value={dueDate}
								locale={getLocale()}
								messages={dateMessages}
							/>
						</div>
						<div class="field">
							<span id="theme-lab-sample-view">{m['themeLab.preview.segmentLabel']()}</span>
							<SegmentedControl
								options={viewOptions}
								bind:value={view}
								name="theme-lab-sample-view"
								labelledby="theme-lab-sample-view"
							/>
						</div>
					</div>
				</section>

				<section>
					<h3>{m['themeLab.preview.card']()}</h3>
					<SurfaceCard title={m['themeLab.preview.cardTitle']()}>
						<p class="card-body">{m['themeLab.preview.cardBody']()}</p>
					</SurfaceCard>
				</section>

				<section>
					<h3>{m['themeLab.preview.grid']()}</h3>
					<div class="grid-frame">
						<BantoGrid
							rows={gridRows}
							columns={gridColumns}
							getRowId={(row) => row.code}
							messages={gridMessages()}
						/>
					</div>
				</section>

				<section>
					<div class="heading-row">
						<h3>{m['themeLab.preview.toasts']()}</h3>
						<button
							type="button"
							class="banto-btn banto-btn--ghost banto-btn--sm"
							onclick={showToasts}
						>
							{m['themeLab.preview.toastsShow']()}
						</button>
					</div>
					<div class="toast-stage">
						<ToastHost store={toastStore} messages={{ toastClose: () => m['common.close']() }} />
					</div>
				</section>

				<!-- [scaffold:charts] begin -->
				<section>
					<h3>{m['themeLab.charts.heading']()}</h3>
					<p class="hint">{m['themeLab.charts.caption']()}</p>
					<ThemeLabCharts />
				</section>
				<!-- [scaffold:charts] end -->
			</div>
		</section>
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
	}

	/* Knobs, contrast and export on the left; the preview takes the rest and
	   stacks under them on a narrow screen. */
	.lab {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--banto-space-4);
		align-items: start;
	}

	@media (min-width: 1100px) {
		.lab {
			grid-template-columns: minmax(18rem, 22rem) minmax(0, 1fr);
		}
	}

	.side {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
		min-width: 0;
	}

	.controls {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
	}

	.knob {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		min-width: 0;
	}

	.knob-row {
		display: flex;
		align-items: center;
		gap: var(--banto-space-3);
	}

	.knob-row input[type='range'] {
		flex: 1;
		min-width: 0;
		accent-color: var(--banto-primary);
	}

	.number {
		width: 5rem;
	}

	.hint {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.contrast {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
	}

	.contrast li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		align-items: center;
		gap: var(--banto-space-3);
		font-size: var(--banto-font-size-sm);
	}

	.contrast-ratio {
		font-variant-numeric: tabular-nums;
	}

	.contrast-note {
		margin: var(--banto-space-3) 0 0;
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	.contrast-note.warn {
		color: var(--banto-danger);
		font-weight: 600;
	}

	.export {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
	}

	.code {
		margin: 0;
		padding: var(--banto-space-3);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface-subtle);
		overflow-x: auto;
		font-family: ui-monospace, 'SF Mono', Consolas, monospace;
		font-size: var(--banto-font-size-sm);
		white-space: pre;
	}

	.export-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--banto-space-2);
	}

	.stage {
		min-width: 0;
	}

	.stage-heading {
		margin: 0 0 var(--banto-space-2);
		font-size: var(--banto-font-size-base);
	}

	/* The scoped theme: this element has its own data-theme, density and the
	   variables (inline style), so everything inside follows them while the
	   shell does not. Its own surface, text, font and size are set here because
	   <body> would otherwise supply the outer ones. */
	.preview {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-5);
		padding: var(--banto-space-4);
		background: var(--banto-bg);
		color: var(--banto-text);
		font-family: var(--banto-font-family);
		font-size: var(--banto-font-size);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		min-width: 0;
	}

	.preview h3 {
		margin: 0 0 var(--banto-space-2);
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-2);
	}

	.heading-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--banto-space-2);
		margin-bottom: var(--banto-space-2);
	}

	.heading-row h3 {
		margin: 0;
	}

	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(12rem, 100%), 1fr));
		gap: var(--banto-space-3);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		min-width: 0;
		font-size: var(--banto-font-size-sm);
	}

	.card-body {
		margin: 0;
	}

	/* The grid scrolls inside a fixed height (a part's shape, conventions §9). */
	.grid-frame {
		height: 11rem;
	}

	/* `contain: layout` makes the stage the containing block of ToastHost's
	   `position: fixed`, so the toasts sit in the stage, not in the window. */
	.toast-stage {
		position: relative;
		contain: layout;
		min-height: 15rem;
		border: var(--banto-border-width) dashed var(--banto-border);
		border-radius: var(--banto-radius-md);
	}
</style>
