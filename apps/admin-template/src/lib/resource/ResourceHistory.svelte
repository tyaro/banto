<!--
	@component
	"History of this record" (#591, stage 2): the audit log narrowed to one
	resource and one record, newest first, as a plain list (time / user /
	action / result / origin). An `update` row with a recorded diff (#597) shows
	its changed fields under the row.

	Mounted by the list's drawer only while its "History" tab is selected, so
	the read happens when the tab is opened (and again each time it is opened,
	which is how a save made meanwhile shows up). `id` is read when the
	component is created; the host keys it on the record. `reloadKey` makes the
	host re-read while the tab stays open (a save that answered late).

	The caller decides who may see this (`admin`, a real audit log); the
	server's `audit_log_list` / `/api/audit-log/list` stay the real check
	(conventions §1, §10). Messages are `resource.history*`, not `audit.*`: the
	display preset removes the audit-log screen and most of `audit.*`.
-->
<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { EmptyState, ErrorState, LoadingState } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { listAuditLog } from '#lib/banto/auditLogAdmin.js';
	import { auditLogLink } from '#lib/banto/auditLogQuery.js';
	import { navItems, resolveAppPath } from '#lib/navigation.js';
	import { createRecordHistoryLoader, type RecordHistoryState } from './recordHistory';
	import AuditChanges from './AuditChanges.svelte';
	import { parseAuditChanges } from './auditChanges';

	interface Props {
		/** The resource name as the audit log records it (`ResourceDefinition.name`). */
		resource: string;
		id: string | number;
		/** Bump to read again. */
		reloadKey?: number;
	}

	let { resource, id, reloadKey = 0 }: Props = $props();

	let state: RecordHistoryState = $state({ status: 'idle' });
	const loader = createRecordHistoryLoader(listAuditLog, (next) => {
		state = next;
	});
	onDestroy(() => loader.dispose());

	// `untrack`: only `id`, `resource` and `reloadKey` are dependencies; the
	// loader writes `state`, which must not re-run this effect.
	$effect(() => {
		void reloadKey;
		const [currentResource, currentId] = [resource, id];
		untrack(() => void loader.load(currentResource, currentId));
	});

	function reload(): void {
		void loader.load(resource, id);
	}

	const actionLabels: Record<string, () => string> = {
		create: () => m['resource.historyActionCreate'](),
		update: () => m['resource.historyActionUpdate'](),
		delete: () => m['resource.historyActionDelete'](),
		denied: () => m['resource.historyActionDenied']()
	};
	const resultLabels: Record<string, () => string> = {
		ok: () => m['resource.historyResultOk'](),
		denied: () => m['resource.historyResultDenied'](),
		failed: () => m['resource.historyResultFailed']()
	};
	const originLabels: Record<string, () => string> = {
		tauri: () => m['resource.historyOriginTauri'](),
		rest: () => m['resource.historyOriginRest']()
	};
	/** An action the table does not know (a custom one) shows as recorded. */
	const label = (table: Record<string, () => string>, key: string): string => table[key]?.() ?? key;

	// The audit-log screen is not in every preset (display removes it): link
	// to it only when the nav still has it.
	// Matched as a string, not `'/audit-log'` as an `AppPath`: where the screen
	// is removed, scaffold also removes it from those types.
	const auditLogItem = navItems.find((item) => (item.path as string) === '/audit-log');
	// With the record's resource and id, so the screen opens filtered to it.
	const auditLogBase = auditLogItem ? resolveAppPath(auditLogItem.path) : null;
	const auditLogHref = $derived(auditLogBase ? auditLogLink(auditLogBase, resource, id) : null);
</script>

<div class="history">
	{#if state.status === 'idle' || state.status === 'loading'}
		<LoadingState label={m['resource.historyLoading']()} />
	{:else if state.status === 'error'}
		<ErrorState
			title={m['resource.historyLoadError']()}
			description={m['resource.historyLoadErrorDesc']()}
		>
			{#snippet action()}
				<button type="button" class="banto-btn banto-btn--secondary" onclick={reload}>
					{m['common.reload']()}
				</button>
			{/snippet}
		</ErrorState>
	{:else if state.rows.length === 0}
		<EmptyState title={m['resource.historyEmpty']()} />
	{:else}
		<div class="table-wrap">
			<table>
				<caption class="sr-only">{m['resource.historyCaption']()}</caption>
				<thead>
					<tr>
						<th scope="col">{m['resource.historyColTs']()}</th>
						<th scope="col">{m['resource.historyColAction']()}</th>
						<th scope="col">{m['resource.historyColUser']()}</th>
						<th scope="col">{m['resource.historyColResult']()}</th>
						<th scope="col">{m['resource.historyColOrigin']()}</th>
					</tr>
				</thead>
				<tbody>
					{#each state.rows as row (row.id)}
						<tr>
							<td class="ts">{row.ts}</td>
							<td>{label(actionLabels, row.action)}</td>
							<td>{row.actorUsername ?? '-'}</td>
							<td>{label(resultLabels, row.result)}</td>
							<td>{label(originLabels, row.origin)}</td>
						</tr>
						{@const changes = parseAuditChanges(row.detail)}
						{#if changes && changes.length > 0}
							<tr class="changes-row">
								<td colspan="5"><AuditChanges {resource} {changes} variant="inline" /></td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
		{#if state.total > state.rows.length}
			<p class="note">
				{m['resource.historyTruncated']({
					shown: state.rows.length.toLocaleString(),
					total: state.total.toLocaleString()
				})}
			</p>
		{/if}
	{/if}
	{#if auditLogHref}
		<p class="note">
			<a href={auditLogHref}>{m['resource.historyOpenAuditLog']()}</a>
		</p>
	{/if}
</div>

<style>
	.history {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-3);
	}

	.table-wrap {
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--banto-font-size-sm);
	}

	th,
	td {
		text-align: start;
		padding: var(--banto-space-2) var(--banto-space-3);
		border-bottom: var(--banto-border-width) solid var(--banto-border);
		white-space: nowrap;
	}

	th {
		color: var(--banto-text-muted);
		font-weight: 600;
	}

	.changes-row td {
		white-space: normal;
		padding-block-start: var(--banto-space-1);
	}

	.ts {
		font-variant-numeric: tabular-nums;
	}

	.note {
		margin: 0;
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
