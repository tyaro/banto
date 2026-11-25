<!--
	@component
	The create / edit form of one resource (ADR-0030 §4, stage 3).

	`<ResourceDetail resource={definition} id={…}>`: `id === null` creates a new
	record, any other value edits that record. It owns `createFormResource` +
	`BantoForm`, the unsaved-changes guard, save / delete and the viewer's
	read-only form; what is offered follows `resourcePermissions` (ADR-0030 §5 —
	hidden, not disabled; the server's `RoleGuard` / Tauri's `require_role`
	stay the real check, conventions §1).

	It does not depend on the page frame (no `.page` wrapper, no `PageHeader`):
	it renders the form panel and then `after`, as siblings, into whatever the
	host puts around them - a route (`/<path>/[id]`, `/<path>/new`) or the
	list's drawer (#591, `ResourceListPage`). The host owns the heading
	(`resource.createTitle` / `resource.editTitle`).

	In a drawer the host passes `onClose` (and `onSaved` / `onDeleted`): the
	"back to list" controls become "close" buttons that call it, a save or a
	delete calls the callback instead of going back to the list (the list
	refreshes itself - `createFormResource` invalidates the resource), and the
	host asks `hasPendingChanges()` before it closes or switches the record.

	`id` is read ONCE, when the component is created. A host that can switch
	records under the same instance must key it (`{#key id}`); the (app) layout
	already keys every page on its route params (Issue #290), so the routes
	need nothing.

	Like everything under `lib/resource/`, this must not import an optional
	asset (attachments, reports, ...; conventions §4, `verify:architecture`
	rule `resource-no-optional`): optional extras come in through `after` /
	`actions`.
-->
<script lang="ts">
	import { onDestroy, tick, untrack, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		BantoForm,
		UnsavedChangesNotice,
		createFormStore,
		emptyFileValue,
		uploadPendingFiles
	} from '@banto/forms';
	import type { FormSchema } from '@banto/forms';
	import {
		conflictOf,
		createFormResource,
		currentSessionScope,
		isCurrentSessionScope,
		getDataProvider,
		isProviderError,
		notify,
		noteLastEditedRecord,
		saveLastOpenedId
	} from '@banto/admin-core';
	import { EmptyState, ErrorState, LoadingState } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { saveErrorMessage } from '#lib/banto/connectionRecovery.js';
	import { confirmAction } from '#lib/confirm.svelte.js';
	import {
		fileFieldMessages,
		passwordInputMessages,
		formValidationMessages,
		referenceFieldMessages
	} from '#lib/banto/i18n.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import { resolveAppPath, type AppPath } from '#lib/appPath.js';
	import ConflictDialog from './ConflictDialog.svelte';
	import { recordRecentRecord } from './recentRecords';
	import { recordTitle } from './recordTitle';
	import {
		conflictFields,
		keptEditsOverTheirs,
		inputTypedDuringSave,
		LOCK_VERSION_FIELD,
		lockVersionOf,
		resolvedValues,
		type ConflictChoice,
		type ConflictField
	} from './conflict';
	import { editableFieldNames } from './listState';
	import { resetKeepingFile, valuesOnLoad } from './carryFileField';
	import { hasPendingUploads, stashPendingUploads, takePendingUploads } from './pendingUploads';
	import { resourcePermissions } from './permissions';
	import { sendingWhile } from './sessionUpload';
	import type { AppResourceDefinition, ResourceRow } from './types';

	interface Props {
		resource: AppResourceDefinition;
		/**
		 * `null` = create a new record. Otherwise the record's id - a route
		 * param string is fine: it is parsed here, and anything that is not an
		 * integer is shown as not-found without a request.
		 */
		id: string | number | null;
		/**
		 * Below the form panel (the attachments panel goes here). Rendered only
		 * for an existing record that has loaded, so it never runs for a
		 * not-found / errored / new record. `canWrite` is the `edit` permission.
		 * `filesInForm`: the form itself lists the record's files (the retry
		 * of a failed upload), so a panel of the same files should stay out.
		 */
		after?: Snippet<[{ id: number; canWrite: boolean; filesInForm: boolean }]>;
		/** Extra buttons in the form's action row, before "back to list". */
		actions?: Snippet;
		/**
		 * #591: shown inside a host that is not a page (the list's drawer).
		 * "Back to list" becomes a "close" button that calls this, and the
		 * panel drops its card frame (the drawer is the frame).
		 */
		onClose?: () => void;
		/**
		 * #591: called after a successful save of an existing record, instead
		 * of going back to the list (and instead of the #215 one-shot marker
		 * the list reads when it mounts - the host is the list itself). Also
		 * called when the save answers after this form was torn down.
		 */
		onSaved?: (row: ResourceRow) => void;
		/** #591: called after the record was deleted, instead of going back to the list. */
		onDeleted?: () => void;
	}

	let { resource, id, after, actions, onClose, onSaved, onDeleted }: Props = $props();

	// Read once (see the component doc above); `untrack` says so explicitly.
	const def = untrack(() => resource);
	const rawId = untrack(() => id);
	const isNew = rawId === null;
	const fullSchema = def.schema as FormSchema;
	// #714 F2: the `file` field (one at most) uploads to the record's attachments.
	const fileField = fullSchema.fields.find((field) => field.type === 'file');
	const listHref = resolveAppPath(def.path);

	// ADR-0030 §5. Spec M10 RBAC: a `viewer` can still open an existing
	// record to look at it, but may not save or delete. `BantoForm`'s
	// `submitting` prop disables every field AND the submit button together
	// (there is no separate "read-only" prop), so passing it for a role that
	// may not save doubles as "make the whole form read-only".
	const perms = $derived(resourcePermissions(def, sessionStore.role));
	const canSave = $derived(isNew ? perms.create : perms.edit);

	// Rust's <name>_get/_update/_delete commands declare `id: i64`; Tauri's
	// serde deserializer does NOT coerce a JSON string into a number, so the
	// raw route param (always a string) must become a real `number` before it
	// reaches createFormResource/DataProvider. A value that isn't a valid
	// integer (non-numeric, empty, fractional, ...) can never be a real id, so
	// it is treated as not-found immediately - load is never called for it.
	const parsedId = typeof rawId === 'number' ? rawId : Number(rawId ?? '');
	const idValid = !isNew && rawId !== '' && Number.isInteger(parsedId);

	// Files that did not upload when this record was created (#714 F2): the edit
	// form shows them with their reasons so they can be retried. Only peeked at
	// here (to choose the schema); they are taken once the record has loaded.
	const hasLeftovers = !!fileField && idValid && hasPendingUploads(def.name, parsedId);
	let filesInForm = $state(false);
	// The create form and a form with leftovers carry the `file` field. An
	// existing record's form leaves it out: the attachments panel (`after`)
	// already lists, uploads and deletes that record's files, and the field
	// would show the same list twice.
	//
	// Every upload this form starts - the automatic one after a create and the
	// field's own upload / retry on the edit form - goes out only while the
	// session this form was built for (`scope`, below) is the live one: the
	// file client is handed that check and asks it right before it sends.
	const schema: FormSchema =
		fileField && !isNew && !hasLeftovers
			? { ...fullSchema, fields: fullSchema.fields.filter((field) => field.type !== 'file') }
			: sendingWhile(
					fullSchema,
					() => isCurrentSessionScope(scope),
					() => m['connection.saveFailed']()
				);

	// Issue #215/#255: `scope` is the session this form was built for. The
	// last-opened marker is saved for its owner only, and the save handler
	// passes the SAME scope, so a response that arrives after the session
	// ended (or ended and began again) writes nothing.
	const scope = currentSessionScope();
	// Issue #215: mark this as the row the list should highlight once the user
	// goes back. Done HERE, not from the list's row-click handler, because the
	// list's "open" cell is a plain link that never runs the grid's
	// `onRowClick` (`saveLastOpenedId`'s doc comment has the full reasoning) -
	// every way of getting here (a grid link, a double-click on a read-only
	// cell, a pasted URL, the back button) passes through this component.
	// Set for any syntactically valid id, even before `load()` confirms the
	// record still exists - a stale marker pointing at a deleted row is
	// harmless (no row to highlight).
	if (idValid) saveLastOpenedId(scope, def.name, parsedId);

	// Issue #637: a save that fails because the connection is down says so; the
	// form's store is untouched on any failed save, so the draft stays.
	// Issue #638: an optimistic-lock conflict is resolved here (the diff
	// dialog / the delete notice below), not toasted by `createFormResource`.
	const formOptions = {
		submitErrorMessage: (err: unknown) => saveErrorMessage(err, m['connection.saveFailed']),
		handlesConflict: true
	};
	const formResource = isNew
		? createFormResource(def.name, undefined, formOptions)
		: idValid
			? createFormResource(def.name, parsedId, formOptions)
			: null;
	// i18n layer ② (ADR-0005): inject Paraglide-backed validation messages.
	let store = $state(createFormStore(schema, undefined, formValidationMessages()));
	// A new record's form is ready from the start; an existing record's form
	// is (re-)built from the loaded values in `loadForm()`.
	let storeReady = $state(isNew);

	// Issue #214: ask before leaving with unsaved edits (or mid-save). `store`
	// is re-created by `loadForm()`, so read it at call time. Panels in
	// `after` (attachments) save immediately and have nothing to guard.
	const guard = guardUnsavedChanges({
		isDirty: () => storeReady && store.isDirty,
		isSaving: () => formResource?.saving ?? false
	});

	/**
	 * #591: whether closing / switching away now would drop something - an
	 * unsaved edit or a save still in flight (the same test as the leave
	 * guard above). The drawer's host asks before it closes or moves.
	 */
	/** #591 review: a save is in flight - the host waits instead of offering to discard it. */
	export function isSaving(): boolean {
		return formResource?.saving ?? false;
	}

	export function hasPendingChanges(): boolean {
		return guard.pending;
	}

	// Issue #215/#255 review (fix 2): a save's response can arrive after this
	// form is no longer relevant (the user moved on, or logged out and someone
	// else logged in). `guard.canAutoNavigate` only decides whether `goto()`
	// runs; `destroyed` stops `noteLastEditedRecord` for "the user moved on",
	// `scope` (above) for "the session has ended".
	let destroyed = false;
	onDestroy(() => {
		destroyed = true;
	});

	/**
	 * Issue #638: the record as this form last knew it from the server - the
	 * loaded record, then each saved / resolved one. Its `version` is what a
	 * delete is checked against (a save sends the `version` key the store's
	 * values carry), and it is the "before" that tells which fields someone
	 * else changed when a save conflicts.
	 */
	let base: Record<string, unknown> = {};
	const conflictFieldNames = editableFieldNames(schema);

	// Shared by the initial load and the "reload" action. Only a `not_found`
	// ProviderError shows the not-found copy; anything else gets its own
	// message plus a way to retry without a full page navigation.
	async function loadForm() {
		if (!formResource) return;
		await formResource.load();
		if (!isNew && formResource.initialValues) {
			base = formResource.initialValues;
			// Taken only now: the record is the one this session may edit.
			// ...and only by the session that started this load, who may save.
			// The handover is used ONCE, for the first initial values. Reading the
			// same record again (after a conflict without `current`) carries the
			// field as it is now instead: a file retried or cancelled since must
			// not come back.
			const reloading = storeReady;
			let leftovers: ReturnType<typeof takePendingUploads> = null;
			if (!reloading && isCurrentSessionScope(scope) && canSave) {
				leftovers = takePendingUploads(def.name, parsedId);
				filesInForm = leftovers !== null;
			}
			const hasFile = fileField && schema.fields.some((f) => f.type === 'file');
			store = createFormStore(
				schema,
				valuesOnLoad({
					record: formResource.initialValues,
					fileFieldName: hasFile ? fileField.name : null,
					current: reloading ? store.values : null,
					leftovers
				}),
				formValidationMessages()
			);
			storeReady = true;
			// #711: the palette's "recent records" - once the record exists, so
			// a deleted one never lands there. Written for `scope` only (see
			// `recordRecentRecord`).
			if (!destroyed) {
				recordRecentRecord(scope, {
					resource: def.name,
					id: parsedId,
					title: recordTitle(def, { id: parsedId, ...formResource.initialValues })
				});
			}
		}
	}

	$effect(() => {
		void loadForm();
	});

	const isNotFoundError = $derived.by(() => {
		if (isNew) return false;
		if (!idValid) return true;
		const err = formResource?.error;
		return isProviderError(err) && err.body.kind === 'not_found';
	});

	// --- Issue #638: a save refused by the optimistic lock -----------------

	/** The open conflict dialog: the other person's record and the draft it compares. */
	let conflict: {
		current: Record<string, unknown>;
		draft: Record<string, unknown>;
		fields: ConflictField[];
	} | null = $state(null);
	/** Fetching the latest record for a conflict that came without `current`. */
	let resolving = $state(false);
	let formPanel: HTMLElement | undefined = $state();

	function saveButton(): HTMLButtonElement | null {
		return formPanel?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null;
	}

	/**
	 * The other person's record for a conflict: the conflict's `current`, or
	 * fetched when the backend sent none. `null` (after a toast) when it
	 * cannot be had - the record was deleted meanwhile, or the fetch failed.
	 */
	async function latestRecord(
		current: Record<string, unknown> | undefined
	): Promise<Record<string, unknown> | null> {
		if (current) return current;
		try {
			return await getDataProvider().getOne<Record<string, unknown>>(def.name, parsedId);
		} catch (err) {
			notify(
				'error',
				isProviderError(err) && err.body.kind === 'not_found'
					? m['resource.conflictDeleted']()
					: saveErrorMessage(err, m['connection.saveFailed'])
			);
			return null;
		}
	}

	async function handleConflict(
		draft: Record<string, unknown>,
		reported: Record<string, unknown> | undefined,
		retried: boolean
	): Promise<void> {
		resolving = true;
		const current = await latestRecord(reported);
		resolving = false;
		if (!current || destroyed) return;
		const fields = conflictFields(conflictFieldNames, base, current, draft);
		if (fields.length === 0) {
			// None of the form's fields was changed by the other person (only
			// the version moved, or a field the form does not edit): re-send
			// the draft against their version - no value of theirs is lost.
			// Once per save: if that conflicts again with nothing to show, the
			// draft stays and the user saves again.
			base = current;
			// The re-send carries their version: the store's values must too, or
			// the saved form is compared against the stale one afterwards.
			const version = lockVersionOf(current);
			if (version !== undefined) store.values = { ...store.values, [LOCK_VERSION_FIELD]: version };
			if (retried) {
				notify('error', m['resource.conflictNotSaved']());
				return;
			}
			await handleSubmit(resolvedValues(draft, current, [], {}), true);
			return;
		}
		// The dialog gives focus back to whatever had it when it opened: make
		// that the save button (a save started by Enter in a field would
		// otherwise return there).
		await tick();
		saveButton()?.focus();
		// A copy: `draft` may be the form store's live values.
		conflict = { current, draft: { ...draft }, fields };
	}

	/** "Take theirs": the form becomes their record; this form's edits elsewhere stay unsaved. */
	function takeTheirs(): void {
		if (!conflict) return;
		const { current, draft } = conflict;
		const kept = keptEditsOverTheirs(conflictFieldNames, base, current, draft);
		base = current;
		resetRecord(current);
		if (Object.keys(kept).length > 0) store.values = { ...store.values, ...kept };
		conflict = null;
		notify('info', m['resource.conflictTookTheirs']());
	}

	/** "Overwrite with mine" / "save the chosen values": re-send against their version. */
	async function resend(choices: Record<string, ConflictChoice>): Promise<void> {
		if (!conflict) return;
		const { current, draft, fields } = conflict;
		const values = resolvedValues(draft, current, fields, choices);
		base = current;
		conflict = null;
		// The form shows what is being sent, so a re-send that conflicts once
		// more compares the values the user just chose.
		store.values = { ...store.values, ...values };
		await handleSubmit(values);
	}

	function overwriteWithMine(): void {
		const fields = conflict?.fields ?? [];
		void resend(Object.fromEntries(fields.map((field) => [field.field, 'mine' as const])));
	}

	/** `retried`: this is the automatic re-send of a conflict that showed no field (above). */
	async function handleSubmit(values: Record<string, unknown>, retried = false) {
		// Defense in depth: the form is read-only for a role that may not save,
		// and the backend rejects it anyway - this just avoids a round trip.
		if (!formResource || !canSave || resolving) return;
		// #714 F2: a create and the upload of its files are ONE save. While the
		// files go up the record already exists and the form may look idle;
		// a second save must neither create it again nor start over.
		if (isNew && creating) return;
		if (isNew && fileField) creating = true;
		try {
			await submitValues(formResource, values, retried);
		} finally {
			creating = false;
		}
	}

	/** `store.reset(record)` that keeps the `file` field's waiting files (not a column, so not in `record`). */
	function resetRecord(record: Record<string, unknown>): void {
		const hasFile = fileField && schema.fields.some((f) => f.type === 'file');
		resetKeepingFile(store, hasFile ? fileField.name : null, record);
	}

	/** A create (with the upload of its files) is under way: further saves are turned away. */
	let creating = $state(false);

	async function submitValues(
		resourceForm: NonNullable<typeof formResource>,
		values: Record<string, unknown>,
		retried: boolean
	) {
		const result = await resourceForm.submit(values);
		if (!result.ok && result.conflict) {
			await handleConflict(values, result.conflict.current, retried);
			return;
		}
		if (result.ok) {
			// Issue #638: the saved record (its new `version`) is what the next
			// save and delete are checked against.
			base = { ...values, ...(result.row as Record<string, unknown>) };
			// Issue #215/#255 review: only write the marker if this form hasn't
			// been torn down since AND its session is still the live one
			// (`noteLastEditedRecord` refuses a stale `scope` itself).
			// `parsedId` is included since some DataProviders' update responses
			// don't echo `id` back.
			if (!isNew && onSaved) {
				// #591: the host (the list's drawer) checks the filter itself.
				// The submitted values under the response, as for the form below
				// (a partial response must not read as "left the filter").
				onSaved({ ...values, ...(result.row as Record<string, unknown>), id: parsedId });
			} else if (!isNew && !destroyed) {
				noteLastEditedRecord(scope, def.name, {
					id: parsedId,
					values: { id: parsedId, ...(result.row as Record<string, unknown>) }
				});
			}
			// Saved: nothing is unsaved any more, so the move back to the list
			// must not prompt; and don't override a screen the user already
			// chose while the save was in flight (even if it is still loading).
			// #591 review: the drawer keeps the form open, so the saved row
			// becomes the clean baseline - the server may have changed some
			// values (`updatedAt` stamped, the name trimmed). Input typed during
			// the save stays on screen and stays unsaved (dirty), so closing
			// still asks.
			if (onSaved && !isNew) {
				const current = store.values;
				// The submitted values under the response: a DataProvider may
				// answer an update with only some fields (or without `id`).
				resetRecord({ ...values, ...((result.row ?? {}) as Record<string, unknown>) });
				// Only the fields edited during the save go back on top - the
				// others keep what the server stored.
				const typed = inputTypedDuringSave(current, values);
				if (Object.keys(typed).length > 0) store.values = { ...store.values, ...typed };
			} else {
				store.markClean();
			}
			// #714 F2: a created record's chosen files go up now (the record exists).
			// The ones that fail do not roll the record back: the edit form of
			// the new record opens with them, reasons shown, ready to retry.
			if (isNew && fileField) {
				const createdId = Number((result.row as { id?: unknown } | undefined)?.id);
				// Only the session that created the record sends its files, and
				// stops sending when that session ends (`schema`'s file client asks
				// right before each request, see `sendingWhile`).
				if (Number.isInteger(createdId) && isCurrentSessionScope(scope)) {
					const outcome = await uploadPendingFiles(schema, store, createdId, fileFieldMessages());
					if (outcome.failed.length > 0 && isCurrentSessionScope(scope)) {
						stashPendingUploads(scope, def.name, createdId, outcome.failed);
						// Handed over: nothing is left unsaved on this form.
						store.values = { ...store.values, [fileField.name]: emptyFileValue() };
						notify('error', m['resource.filesNotUploaded']({ count: outcome.failed.length }));
						if (!destroyed && guard.canAutoNavigate) {
							goto(resolveAppPath(`${def.path}/${createdId}` as AppPath));
						}
						return;
					}
				}
			}
			if (!onSaved && guard.canAutoNavigate) goto(listHref);
		} else {
			store.setServerErrors(result.fieldErrors);
		}
	}

	async function handleDelete() {
		if (isNew || !formResource || !perms.delete) return;
		const confirmed = await confirmAction({
			title: m['common.deleteConfirmTitle'](),
			message: m['resource.deleteConfirm'](),
			confirmLabel: m['common.delete'](),
			danger: true
		});
		// `destroyed`: the page may have gone while the dialog was open (the
		// host cancels on navigation; this is the second guard).
		if (!confirmed || destroyed) return;
		// Issue #638: delete only the record this form shows; a refusal
		// (someone changed it meanwhile) shows their record instead.
		const version = lockVersionOf(base);
		const removed = await formResource.remove(version === undefined ? undefined : { version });
		if (!removed) {
			const refused = conflictOf(formResource.lastError);
			if (refused && !destroyed) {
				notify('error', m['resource.conflictNotDeleted']());
				if (refused.current) {
					base = refused.current;
					resetRecord(refused.current);
				} else {
					await loadForm();
				}
			}
			return;
		}
		// The record is gone: unsaved edits to it are moot, don't prompt - and
		// files still waiting to upload to it are dropped (they keep it dirty).
		if (fileField && schema.fields.some((field) => field.type === 'file')) {
			store.values = { ...store.values, [fileField.name]: emptyFileValue() };
		}
		store.markClean();
		if (onDeleted) {
			if (!destroyed) onDeleted();
		} else if (guard.canAutoNavigate) {
			goto(listHref);
		}
	}
</script>

{#snippet backToList(variant: 'secondary' | 'ghost')}
	{#if onClose}
		<button type="button" class="banto-btn banto-btn--{variant}" onclick={onClose}>
			{m['common.close']()}
		</button>
	{:else}
		<a class="banto-btn banto-btn--{variant}" href={listHref}>{m['common.backToList']()}</a>
	{/if}
{/snippet}

<div class="form-panel" class:embedded={onClose !== undefined} bind:this={formPanel}>
	{#if isNotFoundError}
		<EmptyState
			title={m['resource.notFoundTitle']({ resource: def.label })}
			description={m['resource.notFoundDesc']()}
		>
			{#snippet action()}
				{@render backToList('secondary')}
			{/snippet}
		</EmptyState>
	{:else if formResource?.loading}
		<LoadingState label={m['common.loading']()} />
	{:else if !isNew && formResource?.error}
		<ErrorState title={m['resource.loadError']()} description={m['resource.loadErrorDesc']()}>
			{#snippet action()}
				<div class="error-actions">
					<button
						type="button"
						class="banto-btn banto-btn--secondary"
						onclick={() => void loadForm()}
					>
						{m['common.reload']()}
					</button>
					{@render backToList('ghost')}
				</div>
			{/snippet}
		</ErrorState>
	{:else if storeReady}
		<BantoForm
			appearance="underline"
			{schema}
			{store}
			onSubmit={handleSubmit}
			submitting={(formResource?.saving ?? false) || creating || resolving || !canSave}
			submitLabel={m['common.save']()}
			referenceMessages={referenceFieldMessages()}
			fileParentId={isNew ? null : parsedId}
			fileMessages={fileFieldMessages()}
			passwordMessages={passwordInputMessages()}
		>
			<UnsavedChangesNotice pending={guard.pending} label={m['unsaved.notice']()} />
			{#if !isNew && perms.delete}
				<button type="button" class="banto-btn banto-btn--danger" onclick={handleDelete}>
					{m['common.delete']()}
				</button>
			{/if}
			{@render actions?.()}
			<!-- Cancel = back to the list (or close the drawer); the guard asks first if anything is unsaved. -->
			{@render backToList('ghost')}
		</BantoForm>
	{/if}
</div>

{#if !isNew}
	<ConflictDialog
		open={conflict !== null}
		resource={def.name}
		conflicts={conflict?.fields ?? []}
		busy={formResource?.saving ?? false}
		onTakeTheirs={takeTheirs}
		onOverwrite={overwriteWithMine}
		onSaveChoices={(choices) => void resend(choices)}
		onCancel={() => (conflict = null)}
	/>
{/if}

{#if after && idValid && storeReady}
	{@render after({ id: parsedId, canWrite: perms.edit, filesInForm })}
{/if}

<style>
	.form-panel {
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-lg);
		box-shadow: var(--banto-shadow-sm);
		/* Keep native date segments usable in a narrow form at enlarged text. */
		padding: min(var(--banto-space-5), 3%);
	}

	/* #591: inside the list's drawer, the drawer is the frame. */
	.form-panel.embedded {
		background: none;
		border: 0;
		box-shadow: none;
		padding: 0;
	}

	.error-actions {
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
	}
</style>
