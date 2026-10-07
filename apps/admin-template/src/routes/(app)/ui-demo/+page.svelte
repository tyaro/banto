<script lang="ts">
	/**
	 * `@banto/ui` catalog page (Issue #220, ADR-0018 §6): the main states of
	 * the seven shared components on one screen, for review and as the visual
	 * regression target of the package (e2e/visual DIAGONAL_PAGES). Deliberately
	 * light - not a catalog framework.
	 *
	 * The sidebar / command-palette entry exists only in the demo build
	 * (`demoOnly` in navigation.ts); the route itself is reachable by URL in
	 * every build. All page chrome is Paraglide (`raw-jp-in-app`). Samples are
	 * static and deterministic (the only state is a click counter), so the
	 * screenshot never depends on timing; the skeleton pulse is stopped by
	 * `prefers-reduced-motion` (the visual project forces it).
	 *
	 * Not in the API on purpose (ADR-0018 §2): `IconButton` has no `disabled`
	 * prop in phase 1, so no disabled sample.
	 */
	import {
		EmptyState,
		ErrorState,
		IconButton,
		LoadingState,
		PageHeader,
		StatusBadge,
		SurfaceCard,
		type StatusBadgeVariant
	} from '@banto/ui';
	import { Plus, RefreshCw, SearchX, ServerCrash, Star, X } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	const variants: StatusBadgeVariant[] = ['neutral', 'success', 'warning', 'danger', 'info'];

	function variantLabel(variant: StatusBadgeVariant): string {
		switch (variant) {
			case 'neutral':
				return m['uiDemo.badge.neutral']();
			case 'success':
				return m['uiDemo.badge.success']();
			case 'warning':
				return m['uiDemo.badge.warning']();
			case 'danger':
				return m['uiDemo.badge.danger']();
			case 'info':
				return m['uiDemo.badge.info']();
		}
	}

	let clicks = $state(0);
</script>

<div class="page">
	<PageHeader title={m['nav.uiDemo']()} description={m['uiDemo.intro']()}>
		{#snippet actions()}
			<button type="button" class="banto-btn banto-btn--secondary">{m['common.cancel']()}</button>
			<button type="button" class="banto-btn banto-btn--primary">{m['common.save']()}</button>
		{/snippet}
	</PageHeader>

	<SurfaceCard title="PageHeader" description={m['uiDemo.header.desc']()}>
		<!-- Extra headers on the same page: the real one above already owns
		     `view-transition-name: page-header`, and a duplicate name voids the
		     page transition - so the samples opt out of it. -->
		<div class="stack samples-header">
			<div class="sample">
				<span class="caption">{m['uiDemo.header.titleOnly']()}</span>
				<PageHeader title={m['uiDemo.header.sampleTitle']()} />
			</div>
			<div class="sample">
				<span class="caption">{m['uiDemo.header.withDescription']()}</span>
				<PageHeader
					title={m['uiDemo.header.sampleTitle']()}
					description={m['uiDemo.header.sampleDescription']()}
				/>
			</div>
			<div class="sample">
				<span class="caption">{m['uiDemo.header.withActions']()}</span>
				<PageHeader
					title={m['uiDemo.header.sampleTitle']()}
					description={m['uiDemo.header.sampleDescription']()}
				>
					{#snippet actions()}
						<button type="button" class="banto-btn banto-btn--secondary">
							{m['common.cancel']()}
						</button>
						<button type="button" class="banto-btn banto-btn--primary">{m['common.save']()}</button>
					{/snippet}
				</PageHeader>
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard title="SurfaceCard" description={m['uiDemo.card.desc']()}>
		<div class="grid">
			<div class="sample">
				<span class="caption">{m['uiDemo.card.titleOnly']()}</span>
				<SurfaceCard title={m['uiDemo.card.sampleTitle']()}>
					<p class="body-text">{m['uiDemo.card.sampleBody']()}</p>
				</SurfaceCard>
			</div>
			<div class="sample">
				<span class="caption">{m['uiDemo.card.withDescription']()}</span>
				<SurfaceCard
					title={m['uiDemo.card.sampleTitle']()}
					description={m['uiDemo.card.sampleDescription']()}
				>
					<p class="body-text">{m['uiDemo.card.sampleBody']()}</p>
				</SurfaceCard>
			</div>
			<div class="sample">
				<span class="caption">{m['uiDemo.card.bodyOnly']()}</span>
				<SurfaceCard>
					<p class="body-text">{m['uiDemo.card.sampleBody']()}</p>
				</SurfaceCard>
			</div>
			<div class="sample">
				<span class="caption">{m['uiDemo.card.withFooter']()}</span>
				<SurfaceCard title={m['uiDemo.card.sampleTitle']()}>
					<p class="body-text">{m['uiDemo.card.sampleBody']()}</p>
					{#snippet footer()}
						<button type="button" class="banto-btn banto-btn--ghost">{m['common.cancel']()}</button>
						<button type="button" class="banto-btn banto-btn--primary">{m['common.save']()}</button>
					{/snippet}
				</SurfaceCard>
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard title="StatusBadge" description={m['uiDemo.badge.desc']()}>
		<div class="row">
			{#each variants as variant (variant)}
				<StatusBadge {variant} label={variantLabel(variant)} />
			{/each}
		</div>
		<div class="row row--spaced">
			<span class="caption">{m['uiDemo.customIcon']()}</span>
			<StatusBadge variant="info" label={m['uiDemo.badge.customIconLabel']()} icon={Star} />
		</div>
	</SurfaceCard>

	<SurfaceCard title="IconButton" description={m['uiDemo.iconButton.desc']()}>
		<div class="row">
			<span class="caption">md</span>
			<IconButton label={m['common.close']()} icon={X} onclick={() => (clicks += 1)} />
			<span class="caption">sm</span>
			<IconButton label={m['common.close']()} icon={X} size="sm" onclick={() => (clicks += 1)} />
			<span class="caption">{m['uiDemo.customIcon']()}</span>
			<IconButton label={m['uiDemo.iconButton.add']()} icon={Plus} onclick={() => (clicks += 1)} />
			<span class="caption" data-testid="ui-demo-clicks">
				{m['uiDemo.iconButton.clicks']()}: {clicks}
			</span>
		</div>
	</SurfaceCard>

	<SurfaceCard title="EmptyState" description={m['uiDemo.empty.desc']()}>
		<div class="grid">
			<div class="sample sample--frame">
				<span class="caption">{m['uiDemo.default']()}</span>
				<EmptyState
					title={m['uiDemo.empty.title']()}
					description={m['uiDemo.empty.description']()}
				/>
			</div>
			<div class="sample sample--frame">
				<span class="caption">{m['uiDemo.customIcon']()} + action</span>
				<EmptyState
					icon={SearchX}
					title={m['uiDemo.empty.customTitle']()}
					description={m['uiDemo.empty.description']()}
				>
					{#snippet action()}
						<button type="button" class="banto-btn banto-btn--secondary">
							{m['common.reload']()}
						</button>
					{/snippet}
				</EmptyState>
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard title="ErrorState" description={m['uiDemo.error.desc']()}>
		<div class="grid">
			<div class="sample sample--frame">
				<span class="caption">{m['uiDemo.default']()}</span>
				<ErrorState
					title={m['uiDemo.error.title']()}
					description={m['uiDemo.error.description']()}
				/>
			</div>
			<div class="sample sample--frame">
				<span class="caption">{m['uiDemo.customIcon']()} + action</span>
				<ErrorState
					icon={ServerCrash}
					title={m['uiDemo.error.customTitle']()}
					description={m['uiDemo.error.description']()}
				>
					{#snippet action()}
						<button type="button" class="banto-btn banto-btn--secondary">
							<RefreshCw size={14} aria-hidden="true" />
							{m['common.reload']()}
						</button>
					{/snippet}
				</ErrorState>
			</div>
		</div>
	</SurfaceCard>

	<SurfaceCard title="LoadingState" description={m['uiDemo.loading.desc']()}>
		<div class="grid">
			<div class="sample sample--frame">
				<span class="caption">label = common.loading</span>
				<LoadingState label={m['common.loading']()} />
			</div>
			<div class="sample sample--frame">
				<span class="caption">{m['uiDemo.loading.customLabel']()}</span>
				<LoadingState label={m['uiDemo.loading.customLabelText']()} />
			</div>
			<div class="sample sample--frame">
				<span class="caption">lines = 1</span>
				<LoadingState label={m['common.loading']()} lines={1} />
			</div>
			<div class="sample sample--frame">
				<span class="caption">lines = 5</span>
				<LoadingState label={m['common.loading']()} lines={5} />
			</div>
		</div>
	</SurfaceCard>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
		gap: 1rem;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
	}

	.row--spaced {
		margin-top: 0.75rem;
	}

	.sample {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		min-width: 0;
	}

	.sample--frame {
		padding: 0.75rem;
		border: 1px dashed var(--banto-border);
		border-radius: var(--banto-radius-md);
	}

	.caption {
		color: var(--banto-text-muted);
		font-size: 0.75rem;
	}

	.body-text {
		margin: 0;
		font-size: 0.85rem;
	}

	/* Samples must not claim the page-level view-transition name (see the
	   comment above the PageHeader samples). */
	.samples-header :global(.page-header) {
		view-transition-name: none;
	}
</style>
