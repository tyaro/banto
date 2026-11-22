<script lang="ts">
	/**
	 * ユーザー管理画面（spec M10 RBAC）。`admin` のみ到達（+page.ts が非adminを
	 * ダッシュボードへリダイレクト）。デモモード（プレーンな vite dev/preview、
	 * バックエンドなし）ではアカウントDBそのものが存在しないため、案内文のみ表示
	 * する（isUsersAdminAvailable()）。
	 *
	 * 一覧はBantoGrid（クライアントモード、全件を一度に取得）。BantoGridの
	 * セル編集は「1カラム=1値」のインライン編集向けで、行ごとの複数ボタン（削除
	 * ＋パスワードリセット）を埋め込む手段がないため、行クリックで選択→下に
	 * 詳細/編集/リセット/削除パネルを表示する構成にしている（items.[id]ページの
	 * 「クリックで編集ページへ」と同じ発想を、別ページ遷移ではなくページ内表示
	 * にしたもの）。
	 */
	import { onDestroy, untrack, type Component } from 'svelte';
	import { BantoGrid, type GridColumn } from '@banto/grid-svelte';
	import { BantoForm, createFormStore } from '@banto/forms';
	import type { FormSchema } from '@banto/forms';
	import { createRequestOwner, isProviderError } from '@banto/admin-core';
	import {
		Eye,
		KeyRound,
		Pencil,
		ShieldAlert,
		ShieldCheck,
		Trash2,
		UserRoundPlus,
		Users
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { confirmAction } from '#lib/confirm.svelte.js';
	import { toastStore } from '#lib/toast.svelte.js';
	import {
		PageHeader,
		SurfaceCard,
		StatusBadge,
		type StatusBadgeVariant,
		EmptyState,
		LoadingState,
		Button
	} from '@banto/ui';
	import {
		createUser,
		deleteUser,
		isUsersAdminAvailable,
		listPermissionCatalog,
		listUsers,
		permissionRows,
		permissionsToSend,
		rebasePermissions,
		resetUserPassword,
		samePermissions,
		shouldAdvanceEditVersion,
		updateUser,
		withPermission,
		type PermissionEntry,
		type Role as UserRole,
		type UserPermission,
		type UserSummary
	} from '#lib/banto/usersAdmin.js';
	import PermissionsField from './PermissionsField.svelte';

	const roleOptions: { value: UserRole; label: string }[] = [
		{ value: 'admin', label: m['role.admin']() },
		{ value: 'editor', label: m['role.editor']() },
		{ value: 'viewer', label: m['role.viewer']() }
	];

	function roleLabel(role: UserRole): string {
		return roleOptions.find((option) => option.value === role)?.label ?? role;
	}

	// StatusBadge (visual-refresh-design.md §10): role never relies on color
	// alone - admin gets the "info" variant, editor/viewer both "neutral" but
	// keep distinct icons so they stay visually distinguishable from each
	// other too.
	const roleBadgeVariant: Record<UserRole, StatusBadgeVariant> = {
		admin: 'info',
		editor: 'neutral',
		viewer: 'neutral'
	};
	const roleBadgeIcon: Record<UserRole, Component> = {
		admin: ShieldCheck,
		editor: Pencil,
		viewer: Eye
	};

	function errorMessage(err: unknown): string {
		return isProviderError(err) ? err.message : String(err);
	}

	const available = isUsersAdminAvailable();

	const createSchema: FormSchema = {
		fields: [
			{
				name: 'username',
				label: m['common.username'](),
				type: 'text',
				required: true,
				min: 1,
				max: 32
			},
			{
				name: 'password',
				label: m['common.passwordMinLabel'](),
				type: 'password',
				required: true,
				min: 8
			},
			{
				name: 'displayName',
				label: m['common.displayName'](),
				type: 'text',
				required: true,
				min: 1
			},
			{
				name: 'role',
				label: m['common.role'](),
				type: 'select',
				required: true,
				default: 'viewer',
				options: roleOptions
			}
		]
	};

	let createStore = $state(createFormStore(createSchema));
	let creating = $state(false);

	let users: UserSummary[] = $state([]);
	let loading = $state(false);
	let loadToken = 0;

	async function reload(): Promise<void> {
		if (!available) return;
		const token = ++loadToken;
		loading = true;
		try {
			const loaded = await listUsers();
			if (token === loadToken) users = loaded;
		} catch (err) {
			if (token === loadToken) toastStore.push('error', errorMessage(err));
		} finally {
			if (token === loadToken) loading = false;
		}
	}

	// Issue #697: the permissions the app registered. Read once per page (they
	// only change with the app's own build), independent of which user is
	// selected - so closing or switching the edit panel while it loads cannot
	// misapply it. An empty catalog (the template's own) hides the field.
	let catalog: PermissionEntry[] = $state([]);
	let catalogStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
	const catalogRequests = createRequestOwner();
	onDestroy(() => catalogRequests.dispose());

	async function loadCatalog(): Promise<void> {
		if (!available || catalogStatus === 'loading' || catalogStatus === 'ready') return;
		const request = catalogRequests.begin('catalog');
		catalogStatus = 'loading';
		try {
			const loaded = await listPermissionCatalog();
			if (!request.isCurrent()) return;
			catalog = loaded;
			catalogStatus = 'ready';
		} catch (err) {
			if (!request.isCurrent()) return;
			catalogStatus = 'error';
			toastStore.push('error', errorMessage(err));
		} finally {
			request.finish();
		}
	}

	$effect(() => {
		untrack(() => {
			void reload();
			void loadCatalog();
		});
	});

	async function handleCreate(values: Record<string, unknown>): Promise<void> {
		creating = true;
		try {
			await createUser({
				username: String(values.username),
				password: String(values.password),
				displayName: String(values.displayName),
				role: values.role as UserRole
			});
			toastStore.push('success', m['users.created']());
			createStore = createFormStore(createSchema);
			await reload();
		} catch (err) {
			if (isProviderError(err) && err.body.kind === 'validation') {
				createStore.setServerErrors(err.body.field_errors);
			} else {
				toastStore.push('error', errorMessage(err));
			}
		} finally {
			creating = false;
		}
	}

	const columns: GridColumn<UserSummary>[] = [
		{ id: 'id', header: 'ID', accessor: 'id', width: 70, align: 'right' },
		{
			id: 'username',
			header: m['common.username'](),
			accessor: 'username',
			width: 160,
			filterable: true,
			filterType: 'text'
		},
		{
			id: 'displayName',
			header: m['common.displayName'](),
			accessor: 'displayName',
			width: 160,
			filterable: true,
			filterType: 'text'
		},
		{
			id: 'role',
			header: m['common.role'](),
			accessor: 'role',
			width: 110,
			format: (value) => roleLabel(value as UserRole)
		},
		{ id: 'createdAt', header: m['users.colCreatedAt'](), accessor: 'createdAt', width: 180 }
	];

	let selected: UserSummary | null = $state(null);
	// Issue #206 / roadmap M10: identity alone cannot distinguish A → B → A
	// from the original edit session.
	let selectionEpoch = 0;
	let editDisplayName = $state('');
	let editRole: UserRole = $state('viewer');
	// Issue #651 (optimistic lock): the version the edit form was opened with
	// (or last saved / reset to). Deliberately NOT the list's current row: a
	// list reload or SSE refresh while the form is open must not move it, or a
	// change made by someone else in between would be overwritten silently.
	let editVersion = $state(0);
	let saving = $state(false);
	// Issue #697: the permission draft. `null` = no trustworthy copy (after a
	// conflict, until the list is read again): the field is disabled and a
	// save sends nothing for permissions, so a stale choice can never
	// overwrite someone else's change. "Did it change" is judged against the
	// selected row (what the server holds), not against the draft.
	let editPermissions: UserPermission[] | null = $state([]);
	const basePermissions: readonly UserPermission[] = $derived.by(() => selected?.permissions ?? []);
	const permissionList = $derived(
		permissionRows(catalog, basePermissions, m as unknown as Record<string, unknown>)
	);

	function selectUser(user: UserSummary): void {
		// The built-in `admin` row is read-only (ADR-0034 §2): no edit, password
		// or delete form is offered for it.
		if (user.kind === 'builtin') return;
		selectionEpoch++;
		selected = user;
		editDisplayName = user.displayName;
		editRole = user.role;
		editVersion = user.version;
		editPermissions = [...(user.permissions ?? [])];
		resetPassword = '';
		if (catalogStatus === 'error') void loadCatalog();
	}

	/** The `current` of a `conflict` error (the other side's latest row), or null when absent / not a user row. */
	function conflictCurrent(err: unknown): UserSummary | null {
		if (!isProviderError(err) || err.body.kind !== 'conflict') return null;
		const current = err.body.current as Partial<UserSummary> | null | undefined;
		if (
			current &&
			typeof current.id === 'number' &&
			typeof current.version === 'number' &&
			typeof current.displayName === 'string' &&
			typeof current.role === 'string'
		) {
			return current as UserSummary;
		}
		return null;
	}

	/**
	 * Put the form on the other side's latest row (and its version as the new
	 * base), if this selection is still the one that conflicted. The conflict
	 * body is the account row WITHOUT its permissions (Issue #697), so unless it
	 * carries them the permission draft becomes unknown (`null`) until
	 * `syncPermissions` reads them from the list.
	 */
	function showLatest(current: UserSummary | null, targetId: number, epoch: number): void {
		if (!current || epoch !== selectionEpoch || selected?.id !== targetId) return;
		const known = Array.isArray(current.permissions);
		selected = known ? current : { ...current, permissions: selected.permissions ?? [] };
		editDisplayName = current.displayName;
		editRole = current.role;
		editVersion = current.version;
		editPermissions = known ? [...current.permissions] : null;
	}

	/** What `showLatest` put in the form, so `syncPermissions` can tell input made while the list was re-read. */
	function conflictSnapshot(): { displayName: string; role: UserRole; version: number } {
		return { displayName: editDisplayName, role: editRole, version: editVersion };
	}

	/**
	 * After a conflict and the list re-read: take the permissions (and the row)
	 * from the list, if the selection did not move. The name and role fields
	 * stay editable during the re-read, so input made since `showLatest` (the
	 * `snapshot`) is kept:
	 * - same version as the form: only the permissions are filled in;
	 * - a newer version: the form follows it only when nothing was typed;
	 *   otherwise it is left alone (permissions stay unknown, the base version
	 *   is not advanced), so the next save conflicts again instead of
	 *   overwriting the newer change.
	 */
	function syncPermissions(
		targetId: number,
		epoch: number,
		snapshot: { displayName: string; role: UserRole; version: number }
	): void {
		if (editPermissions !== null || epoch !== selectionEpoch || selected?.id !== targetId) return;
		const row = users.find((user) => user.id === targetId);
		if (!row || row.version < editVersion) return;
		const edited = editDisplayName !== snapshot.displayName || editRole !== snapshot.role;
		if (row.version > editVersion && edited) return;
		selected = row;
		if (!edited) {
			editDisplayName = row.displayName;
			editRole = row.role;
		}
		editVersion = row.version;
		editPermissions = [...row.permissions];
	}

	async function saveEdit(): Promise<void> {
		if (!selected || saving) return;
		const targetId = selected.id;
		const epoch = selectionEpoch;
		// The base version is the one the form was opened with, read now (before
		// the await), never re-read from the list afterwards.
		const draft = { displayName: editDisplayName, role: editRole, version: editVersion };
		// Only a changed set is sent; otherwise the server leaves it alone.
		const sentPermissions = editPermissions ? [...editPermissions] : null;
		const permissions = permissionsToSend(sentPermissions, basePermissions);
		saving = true;
		try {
			const updated = await updateUser(targetId, { ...draft, permissions });
			toastStore.push('success', m['users.updated']());
			if (epoch === selectionEpoch && selected?.id === targetId) {
				selected = updated;
				editVersion = updated.version;
				// Fields remain editable while saving; retain input made after submission.
				if (editDisplayName === draft.displayName) editDisplayName = updated.displayName;
				if (editRole === draft.role) editRole = updated.role;
				if (
					editPermissions === null ||
					(sentPermissions && samePermissions(editPermissions, sentPermissions))
				) {
					editPermissions = [...updated.permissions];
				}
			} else if (
				// Selection moved on (e.g. reselected the same user from a stale list
				// row) before our reply: advance only the base version so the next
				// save does not conflict with our own write. Draft/panel untouched.
				shouldAdvanceEditVersion({
					selectedId: selected?.id,
					targetId,
					editVersion,
					sentVersion: draft.version,
					savedVersion: updated.version
				})
			) {
				editVersion = updated.version;
				// Permissions are sent as a complete set, so their base must follow
				// the version: otherwise the next save (now at the new version) would
				// silently drop what this save just granted. Changes made in the
				// reselected form are replayed on top of the saved set.
				if (selected) {
					const oldBase = selected.permissions ?? [];
					if (editPermissions !== null) {
						editPermissions = rebasePermissions(editPermissions, oldBase, updated.permissions);
					}
					selected = { ...selected, permissions: [...updated.permissions] };
				}
			}
			await reload();
		} catch (err) {
			if (isProviderError(err) && err.body.kind === 'conflict') {
				// Someone else saved first: show their latest values (the form's
				// base version follows) instead of overwriting them.
				showLatest(conflictCurrent(err), targetId, epoch);
				const snapshot = conflictSnapshot();
				toastStore.push('error', m['users.conflictNotSaved']());
				await reload();
				syncPermissions(targetId, epoch, snapshot);
			} else {
				toastStore.push('error', errorMessage(err));
			}
		} finally {
			saving = false;
		}
	}

	let resetPassword = $state('');
	let resetting = $state(false);

	async function saveReset(): Promise<void> {
		if (!selected || resetting) return;
		if (resetPassword.length < 8) {
			toastStore.push('error', m['auth.passwordTooShort']());
			return;
		}
		const targetId = selected.id;
		const epoch = selectionEpoch;
		const password = resetPassword;
		resetting = true;
		try {
			await resetUserPassword(targetId, password);
			toastStore.push('success', m['users.passwordReset']());
			if (epoch === selectionEpoch && selected?.id === targetId && resetPassword === password) {
				resetPassword = '';
			}
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			resetting = false;
		}
	}

	let deleting = $state(false);

	async function handleDelete(): Promise<void> {
		if (!selected || deleting) return;
		// Cannot be undone: the user types the user name to confirm (Issue #556).
		const { id: targetId, username } = selected;
		const epoch = selectionEpoch;
		const version = editVersion;
		const confirmed = await confirmAction({
			title: m['users.deleteConfirmTitle'](),
			message: m['users.deleteConfirm']({ username }),
			confirmLabel: m['common.delete'](),
			danger: true,
			requireText: username
		});
		if (!confirmed || deleting) return;
		deleting = true;
		try {
			await deleteUser(targetId, version);
			toastStore.push('success', m['users.deleted']());
			// roadmap M10: even a new selection of this ID no longer exists.
			// Advance the epoch so pending saves cannot reopen the deleted user.
			if (selected?.id === targetId) {
				selectionEpoch++;
				selected = null;
			}
			await reload();
		} catch (err) {
			if (isProviderError(err) && err.body.kind === 'conflict') {
				// Someone else changed the account first: nothing was deleted.
				// Show their latest values and re-read the list.
				showLatest(conflictCurrent(err), targetId, epoch);
				const snapshot = conflictSnapshot();
				toastStore.push('error', m['users.conflictNotDeleted']());
				await reload();
				syncPermissions(targetId, epoch, snapshot);
			} else {
				toastStore.push('error', errorMessage(err));
			}
		} finally {
			deleting = false;
		}
	}
</script>

<div class="page">
	<PageHeader hideTitle title={m['nav.users']()} description={m['users.pageDescription']()} />

	{#if !available}
		<EmptyState title={m['users.unavailableTitle']()} description={m['users.unavailableDesc']()} />
	{:else}
		<!-- >=1100px: list (create + grid) and edit panel side by side; below
		     that, stacked (plan Phase 5 "作成、一覧、選択ユーザー編集の関係を明確
		     にする" / "広い画面では一覧と編集を2カラム、狭い画面では縦積み"). -->
		<div class="workspace">
			<div class="list-column">
				<SurfaceCard>
					<div class="card-head">
						<UserRoundPlus size={20} aria-hidden="true" />
						<div>
							<h2>{m['users.createHeading']()}</h2>
							<p>{m['users.createDesc']()}</p>
						</div>
					</div>
					<!-- class="create" kept as a literal <section> (not SurfaceCard's
					     own <section>) - e2e smoke scenario 5 scopes its locators to
					     `section.create` to avoid ambiguity with the grid's column
					     filter buttons below. -->
					<section class="create">
						<BantoForm
							appearance="underline"
							schema={createSchema}
							store={createStore}
							onSubmit={handleCreate}
							submitting={creating}
							submitLabel={m['common.create']()}
						/>
					</section>
				</SurfaceCard>

				<SurfaceCard>
					<div class="card-head">
						<Users size={20} aria-hidden="true" />
						<div>
							<h2>{m['users.listHeading']()}</h2>
							<p>{m['users.listDesc']()}</p>
						</div>
					</div>
					{#if loading && users.length === 0}
						<LoadingState label={m['common.loading']()} />
					{:else}
						<div class="grid-wrap">
							<BantoGrid
								rows={users}
								{columns}
								getRowId={(user) => user.id}
								onRowClick={selectUser}
							/>
						</div>
					{/if}
				</SurfaceCard>
			</div>

			<div class="edit-column">
				{#if selected}
					<SurfaceCard>
						<div class="card-head">
							<Pencil size={20} aria-hidden="true" />
							<div>
								<h2>{m['users.editHeading']({ username: selected.username })}</h2>
								<p>{m['users.editDesc']()}</p>
							</div>
						</div>

						<div class="role-row">
							<StatusBadge
								variant={roleBadgeVariant[selected.role]}
								label={roleLabel(selected.role)}
								icon={roleBadgeIcon[selected.role]}
							/>
						</div>

						<label class="banto-field banto-field--stacked edit-field">
							<input class="banto-field-control" type="text" bind:value={editDisplayName} />
							<span class="banto-field-label">{m['common.displayName']()}</span>
						</label>
						<label class="banto-field banto-field--stacked edit-field">
							<select class="banto-field-control" bind:value={editRole}>
								{#each roleOptions as option (option.value)}
									<option value={option.value}>{option.label}</option>
								{/each}
							</select>
							<span class="banto-field-label">{m['common.role']()}</span>
						</label>
						{#if catalog.length > 0}
							<PermissionsField
								rows={permissionList}
								checked={editPermissions ?? basePermissions}
								disabled={editPermissions === null}
								onchange={(key, on) => {
									if (editPermissions) editPermissions = withPermission(editPermissions, key, on);
								}}
							/>
						{/if}
						<Button variant="primary" onclick={saveEdit} loading={saving}>
							{m['common.save']()}
						</Button>

						<!-- Danger zone (plan Phase 5): delete + password reset are
						     visually separated from the normal save action above.
						     Confirmation is still required before deletion. -->
						<div class="danger-zone">
							<h3><ShieldAlert size={16} aria-hidden="true" />Danger zone</h3>

							<div class="danger-section">
								<p class="note">{m['users.resetDesc']()}</p>
								<label class="banto-field banto-field--stacked edit-field">
									<input
										class="banto-field-control"
										type="password"
										bind:value={resetPassword}
										autocomplete="new-password"
									/>
									<span class="banto-field-label">{m['common.newPasswordMinLabel']()}</span>
								</label>
								<Button variant="danger" icon={KeyRound} onclick={saveReset} loading={resetting}>
									{m['users.resetPassword']()}
								</Button>
							</div>

							<div class="danger-section">
								<p class="note">{m['users.deleteDesc']()}</p>
								<Button variant="danger" icon={Trash2} onclick={handleDelete} loading={deleting}>
									{m['common.delete']()}
								</Button>
							</div>
						</div>
					</SurfaceCard>
				{:else}
					<EmptyState
						icon={Users}
						title={m['users.selectPrompt']()}
						description={m['users.selectHint']()}
					/>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
	}

	.workspace {
		display: grid;
		grid-template-columns: minmax(320px, 1fr) minmax(360px, 1fr);
		align-items: start;
		gap: var(--banto-space-4);
	}

	@media (max-width: 1099.98px) {
		.workspace {
			grid-template-columns: 1fr;
		}
	}

	.list-column,
	.edit-column {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-4);
	}

	.card-head {
		display: flex;
		align-items: flex-start;
		gap: var(--banto-space-3);
		margin-bottom: var(--banto-space-3);
		color: var(--banto-text-muted);
	}

	.card-head h2 {
		margin: 0;
		font-size: var(--banto-font-size-base);
		color: var(--banto-text);
	}

	.card-head p {
		margin: var(--banto-space-1) 0 0;
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	.role-row {
		margin-bottom: var(--banto-space-3);
	}

	.note {
		margin: 0 0 var(--banto-space-2);
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.grid-wrap {
		height: 320px;
	}

	.edit-field {
		margin-bottom: var(--banto-space-3);
	}

	.danger-zone {
		margin-top: var(--banto-space-5);
		padding-top: var(--banto-space-5);
		border-top: var(--banto-border-width) solid var(--banto-danger);
	}

	.danger-zone h3 {
		display: flex;
		align-items: center;
		gap: var(--banto-space-2);
		margin: 0 0 var(--banto-space-3);
		font-size: var(--banto-font-size-md);
		color: var(--banto-danger);
	}

	.danger-section + .danger-section {
		margin-top: var(--banto-space-4);
		padding-top: var(--banto-space-4);
		border-top: var(--banto-border-width) dashed var(--banto-border);
	}

	.danger-section :global(.banto-btn) {
		margin-top: var(--banto-space-1);
	}
</style>
