<script lang="ts">
	/**
	 * The "?" button for a PageHeader's `actions` (Issue #553, step 4): opens
	 * the page's `AnnotationDrawer`. Renders nothing outside the demo build
	 * (`isDemoBuild()`, a build-time constant). Pair it with an
	 * `AnnotationDrawer` at the page root; a page with no annotation uses neither.
	 */
	import { CircleQuestionMark } from '@lucide/svelte';
	import { isDemoBuild } from '#lib/banto/environment.js';
	import * as m from '#lib/paraglide/messages.js';
	import { annotation } from './annotation.svelte.js';
</script>

{#if isDemoBuild()}
	<button
		type="button"
		class="banto-btn banto-btn--ghost"
		aria-label={m['annotation.open']()}
		title={m['annotation.open']()}
		aria-haspopup="dialog"
		data-testid="annotation-open"
		onclick={() => (annotation.open = true)}
	>
		<CircleQuestionMark size={16} aria-hidden="true" />
	</button>
{/if}
