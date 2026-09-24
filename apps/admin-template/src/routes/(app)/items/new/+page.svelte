<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { BantoForm, UnsavedChangesNotice, createFormStore } from '@banto/forms';
	import type { FormSchema } from '@banto/forms';
	import { createFormResource, getResource } from '@banto/admin-core';
	import * as m from '$lib/paraglide/messages';
	import { formValidationMessages } from '$lib/banto/i18n';
	import { guardUnsavedChanges } from '$lib/unsavedChanges';
	import PageHeader from '$lib/components/ui/PageHeader.svelte';
	import LoadingState from '$lib/components/ui/LoadingState.svelte';

	const resource = getResource('items');
	const schema = resource.schema as FormSchema;

	const formResource = createFormResource('items');
	// i18n layer ② (ADR-0005): inject Paraglide-backed validation messages.
	const store = createFormStore(schema, undefined, formValidationMessages());

	// Issue #214: ask before leaving with unsaved input (or mid-save).
	const guard = guardUnsavedChanges({
		isDirty: () => store.isDirty,
		isSaving: () => formResource.saving
	});

	$effect(() => {
		void formResource.load();
	});

	async function handleSubmit(values: Record<string, unknown>) {
		const result = await formResource.submit(values);
		if (result.ok) {
			// Saved: the values are no longer unsaved, so the move back to the
			// list must not prompt. Skip the move if the user already left
			// while the save was in flight (don't drag them back).
			store.markClean();
			if (!guard.disposed) goto(`${base}/items`);
		} else {
			store.setServerErrors(result.fieldErrors);
		}
	}
</script>

<div class="page">
	<PageHeader title={m['items.createTitle']({ resource: resource.label })} />

	<div class="form-panel">
		{#if formResource.loading}
			<LoadingState label={m['common.loading']()} />
		{:else}
			<BantoForm
				{schema}
				{store}
				onSubmit={handleSubmit}
				submitting={formResource.saving}
				submitLabel={m['common.save']()}
			>
				<UnsavedChangesNotice pending={guard.pending} label={m['unsaved.notice']()} />
				<!-- Cancel = back to the list; the guard asks first if anything is unsaved. -->
				<a class="banto-btn banto-btn--ghost" href={`${base}/items`}>{m['common.backToList']()}</a>
			</BantoForm>
		{/if}
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		/* Readable form width (design.md §Phase 4), not the full page width. */
		max-width: 720px;
	}

	.form-panel {
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		padding: 1.25rem;
	}
</style>
