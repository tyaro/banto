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
	host puts around them - a route today, a drawer later (B-3). The host owns
	the heading (`resource.createTitle` / `resource.editTitle`).

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
	import { onDestroy, untrack, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { BantoForm, UnsavedChangesNotice, createFormStore } from '@banto/forms';
	import type { FormSchema } from '@banto/forms';
	import {
		createFormResource,
		currentSessionScope,
		isProviderError,
		noteLastEditedRecord,
		saveLastOpenedId
	} from '@banto/admin-core';
	import { EmptyState, ErrorState, LoadingState } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { confirmAction } from '#lib/confirm.svelte.js';
	import { formValidationMessages } from '#lib/banto/i18n.js';
	import { sessionStore } from '#lib/session.svelte.js';
	import { guardUnsavedChanges } from '#lib/unsavedChanges.js';
	import { resolveAppPath } from '#lib/appPath.js';
	import { resourcePermissions } from './permissions';
	import type { AppResourceDefinition } from './types';

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
		 */
		after?: Snippet<[{ id: number; canWrite: boolean }]>;
		/** Extra buttons in the form's action row, before "back to list". */
		actions?: Snippet;
	}

	let { resource, id, after, actions }: Props = $props();

	// Read once (see the component doc above); `untrack` says so explicitly.
	const def = untrack(() => resource);
	const rawId = untrack(() => id);
	const isNew = rawId === null;
	const schema = def.schema as FormSchema;
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

	const formResource = isNew
		? createFormResource(def.name)
		: idValid
			? createFormResource(def.name, parsedId)
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

	// Issue #215/#255 review (fix 2): a save's response can arrive after this
	// form is no longer relevant (the user moved on, or logged out and someone
	// else logged in). `guard.canAutoNavigate` only decides whether `goto()`
	// runs; `destroyed` stops `noteLastEditedRecord` for "the user moved on",
	// `scope` (above) for "the session has ended".
	let destroyed = false;
	onDestroy(() => {
		destroyed = true;
	});

	// Shared by the initial load and the "reload" action. Only a `not_found`
	// ProviderError shows the not-found copy; anything else gets its own
	// message plus a way to retry without a full page navigation.
	async function loadForm() {
		if (!formResource) return;
		await formResource.load();
		if (!isNew && formResource.initialValues) {
			store = createFormStore(schema, formResource.initialValues, formValidationMessages());
			storeReady = true;
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

	async function handleSubmit(values: Record<string, unknown>) {
		// Defense in depth: the form is read-only for a role that may not save,
		// and the backend rejects it anyway - this just avoids a round trip.
		if (!formResource || !canSave) return;
		const result = await formResource.submit(values);
		if (result.ok) {
			// Issue #215/#255 review: only write the marker if this form hasn't
			// been torn down since AND its session is still the live one
			// (`noteLastEditedRecord` refuses a stale `scope` itself).
			// `parsedId` is included since some DataProviders' update responses
			// don't echo `id` back.
			if (!isNew && !destroyed) {
				noteLastEditedRecord(scope, def.name, {
					id: parsedId,
					values: { id: parsedId, ...(result.row as Record<string, unknown>) }
				});
			}
			// Saved: nothing is unsaved any more, so the move back to the list
			// must not prompt; and don't override a screen the user already
			// chose while the save was in flight (even if it is still loading).
			store.markClean();
			if (guard.canAutoNavigate) goto(listHref);
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
		const removed = await formResource.remove();
		if (!removed) return;
		// The record is gone: unsaved edits to it are moot, don't prompt.
		store.markClean();
		if (guard.canAutoNavigate) goto(listHref);
	}
</script>

<div class="form-panel">
	{#if isNotFoundError}
		<EmptyState
			title={m['resource.notFoundTitle']({ resource: def.label })}
			description={m['resource.notFoundDesc']()}
		>
			{#snippet action()}
				<a class="banto-btn banto-btn--secondary" href={listHref}>{m['common.backToList']()}</a>
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
					<a class="banto-btn banto-btn--ghost" href={listHref}>{m['common.backToList']()}</a>
				</div>
			{/snippet}
		</ErrorState>
	{:else if storeReady}
		<BantoForm
			appearance="underline"
			{schema}
			{store}
			onSubmit={handleSubmit}
			submitting={(formResource?.saving ?? false) || !canSave}
			submitLabel={m['common.save']()}
		>
			<UnsavedChangesNotice pending={guard.pending} label={m['unsaved.notice']()} />
			{#if !isNew && perms.delete}
				<button type="button" class="banto-btn banto-btn--danger" onclick={handleDelete}>
					{m['common.delete']()}
				</button>
			{/if}
			{@render actions?.()}
			<!-- Cancel = back to the list; the guard asks first if anything is unsaved. -->
			<a class="banto-btn banto-btn--ghost" href={listHref}>{m['common.backToList']()}</a>
		</BantoForm>
	{/if}
</div>

{#if after && idValid && storeReady}
	{@render after({ id: parsedId, canWrite: perms.edit })}
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

	.error-actions {
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
	}
</style>
