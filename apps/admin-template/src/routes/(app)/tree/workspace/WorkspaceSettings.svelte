<script lang="ts">
	/**
	 * Centre pane, "settings" tab of `/tree/workspace`: a small form for the
	 * selected target. Free of the frame (see WorkspaceTree.svelte). The page owns
	 * the saved value and the draft (so it can ask before the draft is lost):
	 * this part edits `draft` (bindable) and reports `onSave` / `onDiscard`.
	 */
	import { UnsavedChangesNotice } from '@banto/forms';
	import { Button } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import type { WorkspaceSettings } from './workspaceSample.js';

	interface Props {
		targetName: string;
		draft: WorkspaceSettings;
		/** The draft differs from the saved value. */
		dirty: boolean;
		/** Shown after a save until the next edit. */
		savedNotice: boolean;
		onSave: () => void;
		onDiscard: () => void;
	}

	let { targetName, draft = $bindable(), dirty, savedNotice, onSave, onDiscard }: Props = $props();

	const uid = $props.id();
	const nameError = $derived(
		draft.displayName.trim() === '' ? m['tree.workspace.nameRequired']() : ''
	);
	const thresholdError = $derived(
		Number.isFinite(draft.threshold) && draft.threshold >= 0 && draft.threshold <= 100
			? ''
			: m['tree.workspace.thresholdRange']()
	);
	const invalid = $derived(nameError !== '' || thresholdError !== '');
</script>

<form
	class="settings"
	onsubmit={(event) => {
		event.preventDefault();
		if (dirty && !invalid) onSave();
	}}
>
	<h2>{m['tree.workspace.settingsTitle']({ target: targetName })}</h2>

	<div class="field">
		<label for="{uid}-name">{m['tree.workspace.fieldName']()}</label>
		<input
			id="{uid}-name"
			class="banto-input"
			type="text"
			aria-invalid={nameError !== ''}
			aria-describedby={nameError ? `${uid}-name-err` : undefined}
			bind:value={draft.displayName}
		/>
		{#if nameError}<p id="{uid}-name-err" class="error">{nameError}</p>{/if}
	</div>

	<div class="field">
		<label for="{uid}-threshold">{m['tree.workspace.fieldThreshold']()}</label>
		<input
			id="{uid}-threshold"
			class="banto-input"
			type="number"
			min="0"
			max="100"
			aria-invalid={thresholdError !== ''}
			aria-describedby={thresholdError ? `${uid}-threshold-err` : undefined}
			bind:value={draft.threshold}
		/>
		{#if thresholdError}<p id="{uid}-threshold-err" class="error">{thresholdError}</p>{/if}
	</div>

	<label class="check">
		<input type="checkbox" bind:checked={draft.notify} />
		{m['tree.workspace.fieldNotify']()}
	</label>

	<div class="footer">
		<Button type="submit" variant="primary" disabled={!dirty || invalid}>
			{m['common.save']()}
		</Button>
		<Button type="button" disabled={!dirty} onclick={onDiscard}>{m['unsaved.discard']()}</Button>
		<UnsavedChangesNotice pending={dirty} label={m['unsaved.notice']()} />
		{#if savedNotice && !dirty}<span class="saved" role="status">
				{m['tree.workspace.saved']()}
			</span>{/if}
	</div>
</form>

<style>
	.settings {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-3);
		max-width: 28rem;
	}

	h2 {
		margin: 0;
		font-size: var(--banto-font-size-lg, 1.1em);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
	}

	.field label {
		font-size: var(--banto-font-size-sm);
		font-weight: 600;
	}

	.check {
		display: inline-flex;
		align-items: center;
		gap: var(--banto-space-2);
	}

	.error {
		margin: 0;
		font-size: var(--banto-font-size-sm);
		color: var(--banto-danger, inherit);
	}

	.footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-3);
	}

	.saved {
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}
</style>
