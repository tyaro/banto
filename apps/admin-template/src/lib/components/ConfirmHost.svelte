<script lang="ts">
	/** Confirm dialog (Issue #556), mounted once in the root layout: `@banto/ui`'s ConfirmHost over the app's store (`#lib/confirm.svelte.js`), with the Paraglide text. */
	import { beforeNavigate } from '$app/navigation';
	import { ConfirmHost } from '@banto/ui';
	import { confirmDialogMessages } from '#lib/banto/i18n.js';
	import { confirmStore } from '#lib/confirm.svelte.js';

	// The host outlives the page that asked (it sits in the root layout), so a
	// navigation away - the browser's Back button included - answers the open
	// question "cancel" before the page goes: the awaiting handler returns
	// instead of deleting / restoring from a page the user has already left.
	beforeNavigate(() => confirmStore.cancel());
</script>

<ConfirmHost store={confirmStore} messages={confirmDialogMessages()} />
