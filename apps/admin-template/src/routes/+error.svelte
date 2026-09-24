<script lang="ts">
	/**
	 * App-wide error page. Also where the (app) route guard lands when the
	 * server could not VERIFY the session (Issue #204, `(app)/+layout.ts`): the
	 * stored token is kept, so "retry" simply re-runs the guard - the session
	 * resumes as soon as the server can answer again.
	 */
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import * as m from '$lib/paraglide/messages';
	import SurfaceCard from '$lib/components/ui/SurfaceCard.svelte';

	function retry() {
		// A full reload re-runs every load (the guard included) from scratch.
		location.reload();
	}
</script>

<div class="error-page" role="alert">
	<SurfaceCard title={m['app.error.title']()} description={`${page.status}`}>
		<p class="message">{page.error?.message ?? ''}</p>
		<div class="actions">
			<button type="button" class="banto-btn banto-btn--primary" onclick={retry}>
				{m['app.error.retry']()}
			</button>
			<a class="banto-btn banto-btn--ghost" href={`${base}/`}>{m['app.error.home']()}</a>
		</div>
	</SurfaceCard>
</div>

<style>
	.error-page {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 1.5rem;
	}

	.message {
		margin: 0 0 1rem;
		color: var(--banto-text-muted);
	}

	.actions {
		display: flex;
		gap: 0.5rem;
	}
</style>
