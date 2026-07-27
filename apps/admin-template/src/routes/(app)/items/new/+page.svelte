<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { BantoForm, createFormStore } from '@banto/forms';
	import type { FormSchema } from '@banto/forms';
	import { createFormResource, getResource } from '@banto/admin-core';
	import PageHeader from '$lib/components/ui/PageHeader.svelte';
	import LoadingState from '$lib/components/ui/LoadingState.svelte';

	const resource = getResource('items');
	const schema = resource.schema as FormSchema;

	const formResource = createFormResource('items');
	const store = createFormStore(schema);

	$effect(() => {
		void formResource.load();
	});

	async function handleSubmit(values: Record<string, unknown>) {
		const result = await formResource.submit(values);
		if (result.ok) {
			goto(`${base}/items`);
		} else {
			store.setServerErrors(result.fieldErrors);
		}
	}
</script>

<div class="page">
	<PageHeader title={`${resource.label}を新規作成`} />

	<div class="form-panel">
		{#if formResource.loading}
			<LoadingState label="読み込み中…" />
		{:else}
			<BantoForm {schema} {store} onSubmit={handleSubmit} submitting={formResource.saving} />
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
