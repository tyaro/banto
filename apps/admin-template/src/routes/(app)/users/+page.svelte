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
	import type { Component } from 'svelte';
	import { BantoGrid, type GridColumn } from '@banto/grid-svelte';
	import { BantoForm, createFormStore } from '@banto/forms';
	import type { FormSchema } from '@banto/forms';
	import { isProviderError } from '@banto/admin-core';
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
	import { toastStore } from '$lib/toast.svelte';
	import PageHeader from '$lib/components/ui/PageHeader.svelte';
	import SurfaceCard from '$lib/components/ui/SurfaceCard.svelte';
	import StatusBadge, { type StatusBadgeVariant } from '$lib/components/ui/StatusBadge.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import LoadingState from '$lib/components/ui/LoadingState.svelte';
	import {
		createUser,
		deleteUser,
		isUsersAdminAvailable,
		listUsers,
		resetUserPassword,
		updateUser,
		DEMO_MODE_MESSAGE,
		type Role as UserRole,
		type UserSummary
	} from '$lib/banto/usersAdmin';

	const roleOptions: { value: UserRole; label: string }[] = [
		{ value: 'admin', label: '管理者' },
		{ value: 'editor', label: '編集者' },
		{ value: 'viewer', label: '閲覧者' }
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
			{ name: 'username', label: 'ユーザー名', type: 'text', required: true, min: 1, max: 32 },
			{
				name: 'password',
				label: 'パスワード（8文字以上）',
				type: 'password',
				required: true,
				min: 8
			},
			{ name: 'displayName', label: '表示名', type: 'text', required: true, min: 1 },
			{
				name: 'role',
				label: 'ロール',
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

	async function reload(): Promise<void> {
		if (!available) return;
		loading = true;
		try {
			users = await listUsers();
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void reload();
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
			toastStore.push('success', '作成しました');
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
			header: 'ユーザー名',
			accessor: 'username',
			width: 160,
			filterable: true,
			filterType: 'text'
		},
		{
			id: 'displayName',
			header: '表示名',
			accessor: 'displayName',
			width: 160,
			filterable: true,
			filterType: 'text'
		},
		{
			id: 'role',
			header: 'ロール',
			accessor: 'role',
			width: 110,
			format: (value) => roleLabel(value as UserRole)
		},
		{ id: 'createdAt', header: '作成日時', accessor: 'createdAt', width: 180 }
	];

	let selected: UserSummary | null = $state(null);
	let editDisplayName = $state('');
	let editRole: UserRole = $state('viewer');
	let saving = $state(false);

	function selectUser(user: UserSummary): void {
		selected = user;
		editDisplayName = user.displayName;
		editRole = user.role;
		resetPassword = '';
	}

	async function saveEdit(): Promise<void> {
		if (!selected) return;
		saving = true;
		try {
			const updated = await updateUser(selected.id, {
				displayName: editDisplayName,
				role: editRole
			});
			toastStore.push('success', '更新しました');
			selected = updated;
			await reload();
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			saving = false;
		}
	}

	let resetPassword = $state('');
	let resetting = $state(false);

	async function saveReset(): Promise<void> {
		if (!selected) return;
		if (resetPassword.length < 8) {
			toastStore.push('error', 'パスワードは8文字以上で入力してください');
			return;
		}
		resetting = true;
		try {
			await resetUserPassword(selected.id, resetPassword);
			toastStore.push('success', 'パスワードをリセットしました');
			resetPassword = '';
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		} finally {
			resetting = false;
		}
	}

	async function handleDelete(): Promise<void> {
		if (!selected) return;
		if (!window.confirm(`${selected.username} を削除しますか？`)) return;
		try {
			await deleteUser(selected.id);
			toastStore.push('success', '削除しました');
			selected = null;
			await reload();
		} catch (err) {
			toastStore.push('error', errorMessage(err));
		}
	}
</script>

<div class="page">
	<PageHeader title="ユーザー管理" description="アカウントの作成・編集・削除・パスワードリセットを行います。" />

	{#if !available}
		<EmptyState
			title="この環境では利用できません"
			description={`${DEMO_MODE_MESSAGE}。単体ブラウザのデモモードにはアカウントDBがないため、この機能はTauriアプリまたはLANアクセス（組み込みサーバー）でのみ利用できます。`}
		/>
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
							<h2>新規作成</h2>
							<p>ユーザー名・パスワード・ロールを指定してアカウントを作成します。</p>
						</div>
					</div>
					<!-- class="create" kept as a literal <section> (not SurfaceCard's
					     own <section>) - e2e smoke scenario 5 scopes its locators to
					     `section.create` to avoid ambiguity with the grid's column
					     filter buttons below. -->
					<section class="create">
						<BantoForm
							schema={createSchema}
							store={createStore}
							onSubmit={handleCreate}
							submitting={creating}
							submitLabel="作成"
						/>
					</section>
				</SurfaceCard>

				<SurfaceCard>
					<div class="card-head">
						<Users size={20} aria-hidden="true" />
						<div>
							<h2>アカウント一覧</h2>
							<p>行をクリックすると右に編集パネルが表示されます。</p>
						</div>
					</div>
					{#if loading && users.length === 0}
						<LoadingState />
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
								<h2>{selected.username} を編集</h2>
								<p>表示名とロールを更新します。</p>
							</div>
						</div>

						<div class="role-row">
							<StatusBadge
								variant={roleBadgeVariant[selected.role]}
								label={roleLabel(selected.role)}
								icon={roleBadgeIcon[selected.role]}
							/>
						</div>

						<label class="field">
							表示名
							<input class="banto-input" type="text" bind:value={editDisplayName} />
						</label>
						<label class="field">
							ロール
							<select class="banto-input" bind:value={editRole}>
								{#each roleOptions as option (option.value)}
									<option value={option.value}>{option.label}</option>
								{/each}
							</select>
						</label>
						<button
							type="button"
							class="banto-btn banto-btn--primary"
							onclick={saveEdit}
							disabled={saving}
						>
							保存
						</button>

						<!-- Danger zone (plan Phase 5): delete + password reset are
						     visually separated from the normal save action above.
						     Handlers/confirm dialogs are unchanged. -->
						<div class="danger-zone">
							<h3><ShieldAlert size={16} aria-hidden="true" />Danger zone</h3>

							<div class="danger-section">
								<p class="note">新しいパスワードを設定し、このユーザーへ強制的に反映します。</p>
								<label class="field">
									新しいパスワード（8文字以上）
									<input
										class="banto-input"
										type="password"
										bind:value={resetPassword}
										autocomplete="new-password"
									/>
								</label>
								<button
									type="button"
									class="banto-btn banto-btn--danger"
									onclick={saveReset}
									disabled={resetting}
								>
									<KeyRound size={16} aria-hidden="true" />
									パスワードをリセット
								</button>
							</div>

							<div class="danger-section">
								<p class="note">このアカウントを完全に削除します。取り消せません。</p>
								<button type="button" class="banto-btn banto-btn--danger" onclick={handleDelete}>
									<Trash2 size={16} aria-hidden="true" />
									削除
								</button>
							</div>
						</div>
					</SurfaceCard>
				{:else}
					<EmptyState
						icon={Users}
						title="ユーザーを選択してください"
						description="一覧から行をクリックすると、ここに編集パネルが表示されます。"
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
		gap: 1rem;
	}

	.workspace {
		display: grid;
		grid-template-columns: minmax(320px, 1fr) minmax(360px, 1fr);
		align-items: start;
		gap: 1rem;
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
		gap: 1rem;
	}

	.card-head {
		display: flex;
		align-items: flex-start;
		gap: 0.65rem;
		margin-bottom: 0.75rem;
		color: var(--banto-text-muted);
	}

	.card-head h2 {
		margin: 0;
		font-size: 1rem;
		color: var(--banto-text);
	}

	.card-head p {
		margin: 0.2rem 0 0;
		font-size: 0.8rem;
		color: var(--banto-text-muted);
	}

	.role-row {
		margin-bottom: 0.75rem;
	}

	.note {
		margin: 0 0 0.5rem;
		color: var(--banto-text-muted);
		font-size: 0.8rem;
	}

	.grid-wrap {
		height: 320px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.8rem;
		color: var(--banto-text-muted);
		margin-bottom: 0.75rem;
	}

	.danger-zone {
		margin-top: 1.25rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--banto-danger);
	}

	.danger-zone h3 {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0 0 0.75rem;
		font-size: 0.875rem;
		color: var(--banto-danger);
	}

	.danger-section + .danger-section {
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px dashed var(--banto-border);
	}

	.danger-section .banto-btn {
		margin-top: 0.25rem;
	}
</style>
