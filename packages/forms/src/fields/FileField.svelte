<script lang="ts">
	/**
	 * Files of the record (`type: 'file'`, downstream-requests-2026-11-plan
	 * §4.12, Issue #714). Every byte goes through the injected
	 * `def.file.client` (the app's attachments client fits as it is): forms
	 * adds no operation and holds no data contract.
	 *
	 * - `parentId` given (the record exists - edit): the record's files are
	 *   listed; a chosen file is uploaded at once, a delete is immediate
	 *   (after `confirmRemove`). Like `@banto/attachments`' `AttachmentsPanel`.
	 * - no `parentId` (a new record): chosen files wait in the value
	 *   (`pending`). The app sends them with `uploadPendingFiles` after the
	 *   create succeeded. A file the client refused stays in the list with the
	 *   rejection, and can be tried again once `parentId` is there.
	 *
	 * `accept` / `maxFileSize` / `maxFiles` / `required` are checked on screen
	 * only (see `FileFieldConfig`). A rejection of the client - also one stricter
	 * than those - is shown as it is.
	 *
	 * Like `RadioField`: a `fieldset` + `legend`, `id` on the button that opens
	 * the picker, `aria-describedby` on the fieldset, no label drawn by `BantoForm`.
	 */
	import { tick, untrack } from 'svelte';
	import type { FieldDef, FileFieldMeta, FileFieldValue, PendingFile } from '../types';
	import { pickFiles, type ValidationMessages } from '../validate';
	import {
		defaultFileFieldMessages,
		fileValueOf,
		formatFileSize,
		listAfterChanges,
		uploadPending,
		type FileFieldMessages
	} from './file';

	interface Props {
		def: FieldDef;
		id?: string;
		class?: string;
		'aria-describedby'?: string;
		value: unknown;
		error?: string;
		disabled?: boolean;
		/** The record the files belong to. `null` / omitted: the record does not exist yet. */
		parentId?: string | number | null;
		/** Texts of the field; defaults are Japanese. */
		messages?: Partial<FileFieldMessages>;
		/** Messages of the on-screen checks of a picked file (`fileTooLarge` etc.); `BantoForm` passes the store's. */
		validationMessages?: ValidationMessages;
		onInput: (value: FileFieldValue) => void;
		onBlur?: () => void;
	}

	let {
		def,
		id,
		class: className,
		'aria-describedby': describedBy,
		value,
		error,
		disabled = false,
		parentId = null,
		messages,
		validationMessages,
		onInput,
		onBlur
	}: Props = $props();

	const t = $derived({ ...defaultFileFieldMessages, ...messages });
	const config = $derived(def.file);
	const isDisabled = $derived(disabled || !!def.readonly);
	const current = $derived(fileValueOf(value));
	const hasParent = $derived(parentId !== null && parentId !== undefined);

	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let uploadingKeys = $state<string[]>([]);
	let removingIds = $state<number[]>([]);
	/** Deletes whose confirmation is open (not reactive: only stops a second start). */
	const confirmingIds = new Set<number>();
	/** The files the last pick refused, each with its reason. */
	let refused = $state<string[]>([]);
	let actionError = $state<string | null>(null);

	let inputEl: HTMLInputElement | undefined = $state();
	let chooseEl: HTMLButtonElement | undefined = $state();

	const count = $derived((current.existing?.length ?? 0) + current.pending.length);
	const full = $derived(config?.maxFiles !== undefined && count >= config.maxFiles);
	// With a record, nothing is sent or deleted until its list is known.
	const ready = $derived(!hasParent || (!loading && loadError === null));

	/** The value as it is NOW (an await may have passed since the last render). */
	function latest(): FileFieldValue {
		return fileValueOf(value);
	}

	// A newer load (or the field going away) makes an older answer stale (conventions §8).
	let loadToken = 0;

	async function load(): Promise<void> {
		const target = parentId;
		if (!config || target === null || target === undefined) return;
		const token = ++loadToken;
		loading = true;
		loadError = null;
		// An upload may end while the list is on its way (the app's
		// `uploadPendingFiles` after a create): the answer must not undo it.
		const before = latest().existing;
		try {
			const list = await config.client.list(config.resource, String(target));
			if (token !== loadToken) return;
			const now = latest();
			onInput({
				existing: listAfterChanges(list, before, now.existing),
				pending: now.pending
			});
		} catch (err) {
			if (token !== loadToken) return;
			loadError = t.loadFailed(err);
		} finally {
			if (token === loadToken) loading = false;
		}
	}

	// The owner of an upload run or a delete: the record and where its files are.
	// What was started for another owner sends nothing more and writes nothing
	// into the value (conventions §8).
	let ownerToken = 0;

	$effect(() => {
		// Tracked: the record and where its files are. Everything else is untracked.
		const target = parentId;
		void config?.client;
		void config?.resource;
		untrack(() => {
			ownerToken += 1;
			loadToken += 1;
			loading = false;
			loadError = null;
			if (target === null || target === undefined) {
				// A record that does not exist has no files: known, and empty - also
				// when the value still lists the files of the record shown before.
				const now = latest();
				if (now.existing === null || now.existing.length > 0) {
					onInput({ existing: [], pending: now.pending });
				}
				removingIds = [];
				return;
			}
			void load();
		});
		return () => {
			ownerToken += 1;
			loadToken += 1;
		};
	});

	// The value went back to "not known" under the same owner: the store was
	// reset (or replaced). Say again what the record has - nothing for a record
	// that does not exist (so `required` is judged), the list read again otherwise.
	const unknown = $derived(current.existing === null);

	$effect(() => {
		if (!unknown) return;
		untrack(() => {
			const now = latest();
			if (now.existing !== null) return;
			if (!hasParent) {
				refused = [];
				actionError = null;
				onInput({ existing: [], pending: now.pending });
				return;
			}
			// A load on its way (the first one, or the owner's) answers for this value too;
			// a failed one keeps its message and its reload button.
			if (!loading && loadError === null) {
				refused = [];
				actionError = null;
				void load();
			}
		});
	});

	function upload(keys: string[]): void {
		const target = parentId;
		const client = config?.client;
		const resource = config?.resource;
		if (!config || target === null || target === undefined) return;
		const token = ownerToken;
		void uploadPending({
			config,
			parentId: target,
			read: () => value,
			write: onInput,
			// Compared directly too: the effect that moves the token runs after the props changed.
			isCurrent: () =>
				token === ownerToken &&
				parentId === target &&
				config?.client === client &&
				config?.resource === resource,
			// The value was reset while the file was on its way: it is the record's, so read the list again.
			onDetached: () => void load(),
			keys,
			messages,
			onStart: (key) => (uploadingKeys = [...uploadingKeys, key]),
			onEnd: (key) => (uploadingKeys = uploadingKeys.filter((item) => item !== key))
		});
	}

	function handlePick(event: Event & { currentTarget: HTMLInputElement }): void {
		const input = event.currentTarget;
		const files = Array.from(input.files ?? []);
		// So picking the same file again fires `change` again.
		input.value = '';
		if (isDisabled || !ready || files.length === 0) return;
		const picked = pickFiles(def, value, files, validationMessages);
		refused = picked.refused.map(({ file, message }) => t.rejected(file.name, message));
		if (picked.accepted.length === 0) return;
		const now = latest();
		onInput({ existing: now.existing, pending: [...now.pending, ...picked.accepted] });
		// The record exists: send right away. Otherwise they wait for the create.
		if (hasParent) upload(picked.accepted.map((entry) => entry.key));
	}

	/** The row with the pressed button is gone: keep the focus in the field. */
	function focusChoose(): void {
		void tick().then(() => chooseEl?.focus());
	}

	function cancelPending(entry: PendingFile): void {
		const now = latest();
		onInput({
			existing: now.existing,
			pending: now.pending.filter((item) => item.key !== entry.key)
		});
		focusChoose();
	}

	async function removeExisting(meta: FileFieldMeta): Promise<void> {
		// The file is of THIS record, through THIS client: both are taken now, and
		// checked again after the confirmation and after the answer.
		const client = config?.client;
		if (!config || !client || !hasParent || !ready || confirmingIds.has(meta.id)) return;
		const token = ownerToken;
		const target = parentId;
		const resource = config.resource;
		const same = () =>
			token === ownerToken &&
			parentId === target &&
			config?.client === client &&
			config?.resource === resource;
		const confirm = config.confirmRemove ?? ((message: string) => window.confirm(message));
		confirmingIds.add(meta.id);
		try {
			if (!(await confirm(t.removeConfirm(meta.fileName), meta))) return;
		} finally {
			confirmingIds.delete(meta.id);
		}
		// Another record is shown now: nothing is deleted.
		if (!same()) return;
		removingIds = [...removingIds, meta.id];
		actionError = null;
		try {
			await client.remove(meta.id);
			if (!same()) return;
			const now = latest();
			onInput({
				existing: now.existing?.filter((item) => item.id !== meta.id) ?? null,
				pending: now.pending
			});
			focusChoose();
		} catch (err) {
			if (same()) actionError = t.removeFailed(err);
		} finally {
			removingIds = removingIds.filter((item) => item !== meta.id);
		}
	}

	function handleFocusOut(event: FocusEvent & { currentTarget: HTMLFieldSetElement }) {
		if (isDisabled || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
		onBlur?.();
	}
</script>

<fieldset
	class={['group', className]}
	class:muted={def.readonly}
	aria-describedby={describedBy}
	disabled={isDisabled}
	data-invalid={error ? '' : undefined}
	onfocusout={handleFocusOut}
>
	<legend class="legend">
		{def.label}
		{#if def.required}<span class="required">*</span>{/if}
	</legend>

	<div class="pick">
		<input
			bind:this={inputEl}
			type="file"
			hidden
			tabindex="-1"
			multiple={config?.maxFiles !== 1}
			accept={config?.accept}
			data-file-input
			onchange={handlePick}
		/>
		<button
			bind:this={chooseEl}
			type="button"
			class="choose"
			{id}
			disabled={!ready || full}
			onclick={() => inputEl?.click()}
		>
			{t.choose()}
		</button>
	</div>

	{#if hasParent && loading}
		<p class="note" role="status">{t.loading()}</p>
	{:else if loadError}
		<p class="problem" role="alert">
			<span>{loadError}</span>
			<button type="button" class="action" onclick={() => void load()}>{t.reload()}</button>
		</p>
	{/if}

	{#if count > 0}
		<ul class="files" aria-label={t.listLabel(def)}>
			{#each current.existing ?? [] as meta (meta.id)}
				<li class="file" data-file-state="existing">
					<span class="name">{meta.fileName}</span>
					<span class="size">{formatFileSize(meta.sizeBytes)}</span>
					<button
						type="button"
						class="action"
						aria-label={t.actionLabel(t.remove(), meta.fileName)}
						disabled={!hasParent || !ready || removingIds.includes(meta.id)}
						onclick={() => void removeExisting(meta)}
					>
						{t.remove()}
					</button>
				</li>
			{/each}
			{#each current.pending as entry (entry.key)}
				{@const busy = uploadingKeys.includes(entry.key)}
				{@const again = entry.error ? t.retry() : t.upload()}
				<li class="file" data-file-state={busy ? 'uploading' : entry.error ? 'failed' : 'pending'}>
					<span class="name">{entry.file.name}</span>
					<span class="size">{formatFileSize(entry.file.size)}</span>
					<span class="state">{busy ? t.uploading() : t.pending()}</span>
					{#if hasParent && !busy}
						<button
							type="button"
							class="action"
							aria-label={t.actionLabel(again, entry.file.name)}
							disabled={!ready}
							onclick={() => upload([entry.key])}
						>
							{again}
						</button>
					{/if}
					<button
						type="button"
						class="action"
						aria-label={t.actionLabel(t.cancel(), entry.file.name)}
						disabled={busy}
						onclick={() => cancelPending(entry)}
					>
						{t.cancel()}
					</button>
					{#if entry.error && !busy}
						<span class="file-error" role="alert">{entry.error}</span>
					{/if}
				</li>
			{/each}
		</ul>
	{:else if current.existing !== null && !loading}
		<p class="note">{t.empty()}</p>
	{/if}

	{#if !hasParent && current.pending.length > 0}
		<p class="note">{t.pendingNote()}</p>
	{/if}
	{#each refused as line, index (index)}
		<p class="problem" role="alert">{line}</p>
	{/each}
	{#if actionError}
		<p class="problem" role="alert">{actionError}</p>
	{/if}
</fieldset>

<style>
	.group {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
	}

	.group:disabled {
		opacity: 0.5;
	}

	.legend {
		padding: 0;
		font-size: var(--banto-font-size-md);
		color: var(--banto-text-muted);
	}

	.required {
		color: var(--banto-danger);
		margin-left: var(--banto-space-1);
	}

	.pick {
		display: flex;
	}

	button {
		box-sizing: border-box;
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text);
		font: inherit;
		cursor: pointer;
		transition: background var(--banto-duration-fast) var(--banto-ease-out);
	}

	button:hover:not(:disabled) {
		background: var(--banto-surface-hover);
	}

	button:focus-visible {
		outline: var(--banto-border-width-strong) solid var(--banto-primary);
		outline-offset: var(--banto-border-width);
		box-shadow: var(--banto-focus-ring);
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.choose {
		min-height: var(--banto-control-height);
		padding: 0 var(--banto-space-4);
	}

	.group[data-invalid] .choose {
		border-color: var(--banto-danger);
	}

	.action {
		padding: var(--banto-space-1) var(--banto-space-2);
		font-size: var(--banto-font-size-sm);
	}

	.files {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
	}

	.file {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-1) var(--banto-space-2);
		padding: var(--banto-space-2);
		color: var(--banto-text);
	}

	.file + .file {
		border-top: var(--banto-border-width) solid var(--banto-border);
	}

	.name {
		flex: 1 1 8em;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.size,
	.state {
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
		white-space: nowrap;
	}

	.file-error {
		flex-basis: 100%;
		font-size: var(--banto-font-size-sm);
		color: var(--banto-danger);
	}

	.note {
		margin: 0;
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	.problem {
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--banto-space-2);
		font-size: var(--banto-font-size-sm);
		color: var(--banto-danger);
	}
</style>
