<script lang="ts">
	/** Fixed bottom-right toast stack (spec §3.4 notification sink), mounted once in the root layout. */
	import { toastStore } from '$lib/toast.svelte';
</script>

<div class="toast-host" role="status" aria-live="polite">
	{#each toastStore.toasts as toast (toast.id)}
		<div class="toast {toast.kind}">
			<span class="message">{toast.message}</span>
			<button
				type="button"
				class="close"
				onclick={() => toastStore.dismiss(toast.id)}
				aria-label="閉じる"
			>
				×
			</button>
		</div>
	{/each}
</div>

<style>
	.toast-host {
		position: fixed;
		right: 1rem;
		bottom: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		z-index: 1000;
		max-width: 320px;
	}

	.toast {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.65rem 0.8rem;
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface-overlay);
		border: 1px solid var(--banto-border);
		border-left-width: 4px;
		border-left-color: var(--banto-border-strong);
		box-shadow: var(--banto-shadow-lg);
		font-size: 0.85rem;
		color: var(--banto-text);
		/* Glass preset (spec M12): no-op under standard (--banto-backdrop:
		   none), same opt-in as CommandPalette.svelte's overlay. */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
		/* Slide-in from the right (design.md §11.2). Finite animation driven
		   entirely by the duration token, so prefers-reduced-motion (which
		   zeroes --banto-duration-base in banto.css) collapses it to an
		   instant appearance with no extra media query needed here. */
		animation: banto-toast-in var(--banto-duration-base) var(--banto-ease-spring);
	}

	.toast.success {
		background: var(--banto-success-tint);
		border-left-color: var(--banto-success-solid);
		color: var(--banto-success-tint-text);
	}

	.toast.error {
		background: var(--banto-danger-tint);
		border-left-color: var(--banto-danger-solid);
		color: var(--banto-danger-tint-text);
	}

	.toast.info {
		/* No --banto-primary-tint token exists (plan Appendix A.3 only defines
		   tint pairs for danger/success/warning) - same color-mix fallback
		   StatusBadge.svelte's `info` variant already uses. */
		background: color-mix(in srgb, var(--banto-primary) 16%, var(--banto-surface-overlay));
		border-left-color: var(--banto-primary);
		color: var(--banto-primary);
	}

	.message {
		flex: 1;
	}

	.close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: none;
		color: inherit;
		opacity: 0.65;
		cursor: pointer;
		font-size: 1rem;
		line-height: 1;
		padding: 0.3rem;
		border-radius: var(--banto-radius-sm);
		transition:
			opacity var(--banto-duration-fast) var(--banto-ease-out),
			background var(--banto-duration-fast) var(--banto-ease-out);
	}

	.close:hover {
		opacity: 1;
		background: color-mix(in srgb, currentColor 14%, transparent);
	}

	.close:focus-visible {
		outline: none;
		opacity: 1;
		box-shadow: var(--banto-focus-ring);
	}

	@keyframes banto-toast-in {
		from {
			opacity: 0;
			transform: translateX(24px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}
</style>
