<!--
	@component
	Issue #638: the dialog of a save refused by the optimistic lock. It lists the
	fields the other person changed - their value next to this form's - and asks
	which to keep: "take theirs" (the form takes their record, nothing is sent),
	"overwrite with mine" (re-send this form's values) or "choose per field"
	(a radio per field, then re-send). Cancel / Esc / × keeps the draft.

	It only draws `conflicts` (`conflict.ts` computes them) and reports the
	answer; the host (`ResourceDetail`) re-sends. The table reuses the audit
	diff's field labels and value formatting (`auditChanges.ts`) and its look;
	the radios are why it is not `AuditChanges` itself.

	Messages are `resource.conflict*` (the display preset keeps `resource.*`).
-->
<script lang="ts">
	import { Modal } from '@banto/ui';
	import * as m from '#lib/paraglide/messages.js';
	import { auditFieldLabel, formatAuditValue } from './auditChanges';
	import { defaultConflictChoices, type ConflictChoice, type ConflictField } from './conflict';

	interface Props {
		open: boolean;
		/** The resource name, for the field labels. */
		resource: string;
		conflicts: ConflictField[];
		/** A re-send is in flight: the actions wait. */
		busy?: boolean;
		onTakeTheirs: () => void;
		onOverwrite: () => void;
		onSaveChoices: (choices: Record<string, ConflictChoice>) => void;
		onCancel: () => void;
	}

	let {
		open,
		resource,
		conflicts,
		busy = false,
		onTakeTheirs,
		onOverwrite,
		onSaveChoices,
		onCancel
	}: Props = $props();

	let choosing = $state(false);
	let choices: Record<string, ConflictChoice> = $state({});

	// Every new set of conflicts (a dialog opened, or reopened after a re-send
	// conflicted again) starts from the summary and the default choices.
	$effect.pre(() => {
		const next = conflicts;
		choosing = false;
		choices = defaultConflictChoices(next);
	});

	const overlayMessages = { overlayClose: () => m['common.close']() };

	function requestClose(): boolean {
		return !busy;
	}
</script>

<Modal
	{open}
	title={m['resource.conflictTitle']()}
	width="40rem"
	messages={overlayMessages}
	onRequestClose={requestClose}
	onclose={onCancel}
>
	<p class="body">
		{choosing ? m['resource.conflictChooseHint']() : m['resource.conflictBody']()}
	</p>
	<div class="table-wrap">
		<!-- svelte-ignore a11y_no_redundant_roles -->
		<table data-testid="conflict-changes" role="table">
			<caption class="sr-only">{m['resource.conflictCaption']()}</caption>
			<!-- svelte-ignore a11y_no_redundant_roles -->
			<thead role="rowgroup">
				<!-- svelte-ignore a11y_no_redundant_roles -->
				<tr role="row">
					<th scope="col" role="columnheader">{m['resource.changesColField']()}</th>
					<th scope="col" role="columnheader">{m['resource.conflictColTheirs']()}</th>
					<th scope="col" role="columnheader">{m['resource.conflictColMine']()}</th>
				</tr>
			</thead>
			<!-- svelte-ignore a11y_no_redundant_roles -->
			<tbody role="rowgroup">
				{#each conflicts as conflict (conflict.field)}
					{@const label = auditFieldLabel(resource, conflict.field)}
					<!-- svelte-ignore a11y_no_redundant_roles -->
					<tr role="row">
						<th scope="row" role="rowheader">{label}</th>
						{#if choosing}
							<td role="cell">
								<span class="cell-label">{m['resource.conflictColTheirs']()}</span>
								<label class="pick">
									<input
										type="radio"
										name="conflict-{conflict.field}"
										value="theirs"
										aria-label={m['resource.conflictPickTheirs']({ field: label })}
										bind:group={choices[conflict.field]}
									/>
									<span>{formatAuditValue(conflict.theirs)}</span>
								</label>
							</td>
							<td role="cell">
								<span class="cell-label">{m['resource.conflictColMine']()}</span>
								<label class="pick">
									<input
										type="radio"
										name="conflict-{conflict.field}"
										value="mine"
										aria-label={m['resource.conflictPickMine']({ field: label })}
										bind:group={choices[conflict.field]}
									/>
									<span>{formatAuditValue(conflict.mine)}</span>
								</label>
							</td>
						{:else}
							<td role="cell">
								<span class="cell-label">{m['resource.conflictColTheirs']()}</span>
								{formatAuditValue(conflict.theirs)}
							</td>
							<td role="cell">
								<span class="cell-label">{m['resource.conflictColMine']()}</span>
								{formatAuditValue(conflict.mine)}
								{#if !conflict.mineChanged}
									<span class="muted">{m['resource.conflictMineUnchanged']()}</span>
								{/if}
							</td>
						{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<div class="actions">
		{#if choosing}
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				disabled={busy}
				onclick={() => (choosing = false)}
			>
				{m['resource.conflictBack']()}
			</button>
			<button
				type="button"
				class="banto-btn banto-btn--primary"
				disabled={busy}
				onclick={() => onSaveChoices({ ...choices })}
			>
				{m['resource.conflictSaveChoices']()}
			</button>
		{:else}
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				disabled={busy}
				onclick={onCancel}
			>
				{m['common.cancel']()}
			</button>
			<button
				type="button"
				class="banto-btn banto-btn--secondary"
				disabled={busy}
				onclick={() => (choosing = true)}
			>
				{m['resource.conflictChoose']()}
			</button>
			<button
				type="button"
				class="banto-btn banto-btn--danger"
				disabled={busy}
				onclick={onOverwrite}
			>
				{m['resource.conflictOverwrite']()}
			</button>
			<button
				type="button"
				class="banto-btn banto-btn--primary"
				disabled={busy}
				onclick={onTakeTheirs}
			>
				{m['resource.conflictTakeTheirs']()}
			</button>
		{/if}
	</div>
</Modal>

<style>
	.body {
		margin: 0 0 var(--banto-space-4);
		color: var(--banto-text);
		text-wrap: pretty;
	}

	.table-wrap {
		overflow-x: auto;
		margin-bottom: var(--banto-space-4);
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
	}

	@media (min-width: 481px) {
		tbody th {
			white-space: nowrap;
		}
	}

	/* The per-cell column name is only for the stacked narrow layout; on the
	   wide table the column header says it (display:none keeps it out of the
	   accessibility tree too). */
	.cell-label {
		display: none;
	}

	.muted {
		color: var(--banto-text-muted);
	}

	.pick {
		display: inline-flex;
		align-items: center;
		gap: var(--banto-space-2);
		cursor: pointer;
	}

	/* Narrow viewport / large text (WCAG 1.4.10, #1044): the three columns do not
	   fit, so each field becomes a block - the field name, then "their value" and
	   "your value" one under the other, each led by its column name. */
	@media (max-width: 480px) {
		.table-wrap {
			overflow-x: visible;
		}

		table,
		tbody,
		tr,
		th,
		td {
			display: block;
		}

		thead {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
		}

		tr {
			border-bottom: var(--banto-border-width) solid var(--banto-border);
			padding-block: var(--banto-space-1);
		}

		th,
		td {
			border-bottom: none;
		}

		.cell-label {
			display: block;
			color: var(--banto-text-muted);
			font-weight: 600;
		}
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--banto-space-2);
	}
</style>
