<script lang="ts">
	/**
	 * Status/role badge (visual-refresh-design.md §6.2). Never relies on
	 * color alone - every variant always renders an icon, defaulted per
	 * variant when the caller doesn't pass one.
	 *
	 * `success`/`warning`/`danger` use the soft tint-pair tokens added by
	 * plan Appendix A.3 (`--banto-*-tint` / `--banto-*-tint-text`). Appendix
	 * A.3 does not define tint pairs for `info`/`neutral`, so those two fall
	 * back to existing tokens instead of inventing untracked token names:
	 * `info` reuses `--banto-primary` (kept as the "text" default per
	 * design.md §2.1) over a computed tint, `neutral` uses the new
	 * `--banto-surface-subtle` / existing `--banto-text-muted` pair.
	 */
	import type { Component } from 'svelte';
	import { CircleCheck, TriangleAlert, CircleAlert, Info, Circle } from '@lucide/svelte';

	export type StatusBadgeVariant = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

	interface Props {
		variant: StatusBadgeVariant;
		label: string;
		icon?: Component;
	}

	let { variant, label, icon }: Props = $props();

	const DEFAULT_ICONS: Record<StatusBadgeVariant, Component> = {
		neutral: Circle,
		success: CircleCheck,
		warning: TriangleAlert,
		danger: CircleAlert,
		info: Info
	};

	const Icon = $derived(icon ?? DEFAULT_ICONS[variant]);
</script>

<span class="status-badge status-badge--{variant}">
	<Icon size={12} aria-hidden="true" />
	{label}
</span>

<style>
	.status-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.15rem 0.5rem;
		border-radius: var(--banto-radius-sm);
		font-size: 0.75rem;
		line-height: 1.5;
		font-weight: 600;
		white-space: nowrap;
	}

	.status-badge--neutral {
		background: var(--banto-surface-subtle);
		color: var(--banto-text-muted);
	}

	.status-badge--info {
		background: color-mix(in srgb, var(--banto-primary) 16%, var(--banto-surface));
		color: var(--banto-primary);
	}

	.status-badge--success {
		background: var(--banto-success-tint);
		color: var(--banto-success-tint-text);
	}

	.status-badge--warning {
		background: var(--banto-warning-tint);
		color: var(--banto-warning-tint-text);
	}

	.status-badge--danger {
		background: var(--banto-danger-tint);
		color: var(--banto-danger-tint-text);
	}
</style>
