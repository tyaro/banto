<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { BantoForm, createFormStore } from '@banto/forms';
	import type { FormSchema } from '@banto/forms';
	import { createFormResource, getResource } from '@banto/admin-core';

	const resource = getResource('items');
	const schema = resource.schema as FormSchema;
	// SvelteKit creates a fresh component instance per [id] value, so reading
	// the param once at setup time is enough (no need for $derived here).
	const id = page.params.id ?? '';

	const formResource = createFormResource(resource.name, id);
	let store = $state(createFormStore(schema));
	let storeReady = $state(false);

	$effect(() => {
		void formResource.load().then(() => {
			if (formResource.initialValues) {
				store = createFormStore(schema, formResource.initialValues);
				storeReady = true;
			}
		});
	});

	async function handleSubmit(values: Record<string, unknown>) {
		const result = await formResource.submit(values);
		if (result.ok) {
			goto('/items');
		} else {
			store.setServerErrors(result.fieldErrors);
		}
	}

	async function handleDelete() {
		if (!window.confirm('削除しますか？')) return;
		const removed = await formResource.remove();
		if (removed) goto('/items');
	}
</script>

<div class="page">
	<h2>{resource.label}を編集</h2>

	{#if formResource.loading}
		<p class="loading">読み込み中…</p>
	{:else if formResource.error}
		<p class="not-found">
			{resource.label}が見つかりません。<a href="/items">一覧へ戻る</a>
		</p>
	{:else if storeReady}
		<BantoForm {schema} {store} onSubmit={handleSubmit} submitting={formResource.saving}>
			{#snippet children()}
				<button type="button" class="delete" onclick={handleDelete}>削除</button>
			{/snippet}
		</BantoForm>
	{/if}
</div>

<style>
	.page {
		max-width: 480px;
		background: var(--banto-surface);
		border: 1px solid var(--banto-border);
		border-radius: calc(var(--banto-radius) * 2);
		padding: 1.25rem;
	}

	h2 {
		margin: 0 0 1rem;
		font-size: 1.1rem;
	}

	.loading {
		color: var(--banto-text-muted);
	}

	.not-found {
		color: var(--banto-text-muted);
	}

	.not-found a {
		color: var(--banto-primary);
	}

	.delete {
		padding: 0.55rem 1rem;
		border: 1px solid var(--banto-danger);
		border-radius: var(--banto-radius);
		background: transparent;
		color: var(--banto-danger);
		font-weight: 600;
		cursor: pointer;
	}

	.delete:hover {
		background: color-mix(in srgb, var(--banto-danger) 10%, transparent);
	}
</style>
