<script lang="ts">
	import { onMount } from 'svelte';
	import { MessageSquareText } from '@lucide/svelte';
	import { Button, SurfaceCard } from '@banto/ui';
	import { isProviderError } from '@banto/admin-core';
	import * as m from '#lib/paraglide/messages.js';
	import { getLoginNotice, setLoginNotice } from '#lib/banto/loginNotice.js';
	import { errorMessage } from './shared';

	let notice = $state('');
	let loading = $state(true);
	let loadFailed = $state(false);
	let saving = $state(false);
	let feedback = $state('');
	function noticeError(error: unknown): string {
		if (isProviderError(error)) {
			if (error.body.kind === 'unauthorized') return m['settings.loginNoticeSignInAgain']();
			if (
				error.body.kind === 'validation' &&
				error.body.field_errors.some((field) => field.field === 'notice')
			) {
				return m['settings.loginNoticeInvalid']();
			}
		}
		return errorMessage(error);
	}

	async function load(): Promise<void> {
		loading = true;
		loadFailed = false;
		feedback = '';
		try {
			notice = await getLoginNotice();
		} catch (error) {
			loadFailed = true;
			feedback = noticeError(error);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});

	async function save(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (saving || loading || loadFailed) return;
		saving = true;
		feedback = '';
		if ([...notice.trim()].length > 200) {
			feedback = m['settings.loginNoticeTooLong']();
			saving = false;
			return;
		}
		try {
			notice = await setLoginNotice(notice);
			feedback = m['settings.loginNoticeSaved']();
		} catch (error) {
			feedback = noticeError(error);
		} finally {
			saving = false;
		}
	}
</script>

<SurfaceCard>
	<div class="card-head">
		<MessageSquareText size={20} aria-hidden="true" />
		<div>
			<h3>{m['settings.loginNoticeHeading']()}</h3>
			<p>{m['settings.loginNoticeDesc']()}</p>
		</div>
	</div>
	<form onsubmit={save}>
		<label class="banto-field banto-field--stacked">
			<input
				class="banto-field-control"
				type="text"
				bind:value={notice}
				disabled={loading || saving || loadFailed}
			/>
			<span class="banto-field-label">{m['settings.loginNoticeLabel']()}</span>
		</label>
		<div class="save-row">
			<Button type="submit" variant="primary" loading={saving} disabled={loading || loadFailed}>
				{m['settings.loginNoticeSave']()}
			</Button>
			{#if loadFailed}
				<Button type="button" variant="secondary" onclick={load}>
					{m['settings.loginNoticeRetry']()}
				</Button>
			{/if}
		</div>
		{#if feedback}<p class="note" role="status">{feedback}</p>{/if}
	</form>
</SurfaceCard>
