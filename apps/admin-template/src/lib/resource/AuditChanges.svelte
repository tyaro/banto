<!--
	@component
	The recorded fields of a create/update/delete audit record: field / before /
	after. `table` is the audit-log screen's detail; `inline` is the compact
	list under a row of the drawer's history tab. Field names are the internal
	names the record stores, shown as the resource's form label where there is
	one. A masked field shows no values (the server never recorded them).

	Messages are `resource.changes*`, not `audit.*`: the display preset removes
	most of `audit.*`, and the history tab stays there.
-->
<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { auditFieldLabel, formatAuditValue, type AuditChange } from './auditChanges';

	interface Props {
		resource: string;
		changes: AuditChange[];
		variant?: 'table' | 'inline';
	}

	let { resource, changes, variant = 'table' }: Props = $props();

	/** A set-difference entry (`permissions`: added / removed keys) has no before/after. */
	function isSetChange(change: AuditChange): boolean {
		return change.added !== undefined || change.removed !== undefined;
	}
</script>

{#snippet setDiff(change: AuditChange)}
	<span class="set-diff">
		{#if change.added && change.added.length > 0}
			<span
				><span class="muted">{m['resource.changesAdded']()}:</span> {change.added.join(', ')}</span
			>
		{/if}
		{#if change.removed && change.removed.length > 0}
			<span
				><span class="muted">{m['resource.changesRemoved']()}:</span>
				{change.removed.join(', ')}</span
			>
		{/if}
	</span>
{/snippet}

{#if changes.length === 0}
	<p class="none">{m['resource.changesNone']()}</p>
{:else if variant === 'table'}
	<div class="table-wrap">
		<table data-testid="audit-changes">
			<caption class="sr-only">{m['resource.changesCaption']()}</caption>
			<thead>
				<tr>
					<th scope="col">{m['resource.changesColField']()}</th>
					<th scope="col">{m['resource.changesColBefore']()}</th>
					<th scope="col">{m['resource.changesColAfter']()}</th>
				</tr>
			</thead>
			<tbody>
				{#each changes as change (change.field)}
					<tr>
						<th scope="row">{auditFieldLabel(resource, change.field)}</th>
						{#if change.masked}
							<td colspan="2" class="muted">{m['resource.changesMasked']()}</td>
						{:else if isSetChange(change)}
							<td colspan="2">{@render setDiff(change)}</td>
						{:else}
							<td>{formatAuditValue(change.before, resource, change.field)}</td>
							<td>{formatAuditValue(change.after, resource, change.field)}</td>
						{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else}
	<ul class="inline" data-testid="audit-changes-inline">
		{#each changes as change (change.field)}
			<li>
				<span class="field">{auditFieldLabel(resource, change.field)}</span>
				{#if change.masked}
					<span class="muted">{m['resource.changesMasked']()}</span>
				{:else if isSetChange(change)}
					{@render setDiff(change)}
				{:else}
					<span>{formatAuditValue(change.before, resource, change.field)}</span>
					<span class="muted" aria-hidden="true">→</span>
					<span>{formatAuditValue(change.after, resource, change.field)}</span>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

<style>
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
		overflow-wrap: anywhere;
	}

	thead th {
		color: var(--banto-text-muted);
		font-weight: 600;
	}

	tbody th {
		font-weight: 600;
		white-space: nowrap;
	}

	.muted {
		color: var(--banto-text-muted);
	}

	.none {
		margin: 0;
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}

	.inline {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		font-size: var(--banto-font-size-sm);
		overflow-wrap: anywhere;
	}

	.field {
		font-weight: 600;
	}

	.set-diff {
		display: inline-flex;
		flex-direction: column;
		gap: var(--banto-space-1);
	}
</style>
