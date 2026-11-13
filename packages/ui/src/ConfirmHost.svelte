<script lang="ts">
	/**
	 * Shows a `createConfirmStore()` store's question in one ConfirmDialog
	 * (Issue #556), mounted once in the app's root layout like ToastHost. The
	 * buttons answer through `store.settle`, which resolves the caller's
	 * `await store.confirm(...)`.
	 *
	 * The last question stays rendered while the dialog fades out (`current`
	 * is already `null` then), so the text does not blank mid-motion.
	 */
	import ConfirmDialog from './ConfirmDialog.svelte';
	import type { ConfirmRequest, ConfirmStore } from './confirm.svelte';
	import type { UiMessages } from './messages';

	interface Props {
		/** The store to display (from `createConfirmStore()`). */
		store: ConfirmStore;
		/** Text overrides (layer 1 i18n): `confirmOk`, `confirmCancel`, `confirmTypeToConfirm`, `overlayClose`. */
		messages?: UiMessages;
	}

	let { store, messages }: Props = $props();

	let last: ConfirmRequest | null = null;
	const shown = $derived.by(() => {
		const current = store.current;
		if (current) last = current;
		return current ?? last;
	});
</script>

{#if shown}
	{@const request = shown}
	<ConfirmDialog
		open={store.current !== null}
		title={request.title}
		message={request.message}
		confirmLabel={request.confirmLabel}
		cancelLabel={request.cancelLabel}
		danger={request.danger}
		requireText={request.requireText}
		{messages}
		onconfirm={() => store.settle(request.id, true)}
		oncancel={() => store.settle(request.id, false)}
	/>
{/if}
