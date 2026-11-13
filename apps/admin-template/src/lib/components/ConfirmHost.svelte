<script lang="ts">
	/** Confirm dialog (Issue #556), mounted once in the root layout: `@banto/ui`'s ConfirmHost over the app's store (`#lib/confirm.svelte.js`), with the Paraglide text. */
	import { ConfirmHost } from '@banto/ui';
	import { confirmDialogMessages } from '#lib/banto/i18n.js';
	import { confirmStore } from '#lib/confirm.svelte.js';
</script>

<ConfirmHost store={confirmStore} messages={confirmDialogMessages()} />
