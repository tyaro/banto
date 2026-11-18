<!--
	@component
	The per-user permission checkboxes of the users edit panel (Issue #697,
	user-permissions-plan §6). Drawn only when the app registered at least one
	permission (the page decides); the template registers none.

	- One `<fieldset>` + `<legend>` names the group; each checkbox sits inside
	  its own `<label>`, and a description (when the app has one) is tied to it
	  with `aria-describedby`.
	- A key the account holds but the app no longer registers is shown as
	  "unregistered" and can be unchecked: saving then removes it. Its row stays
	  on screen while it is unchecked (`rows` come from what the server holds,
	  not from the draft), so focus is never dropped from under the cursor.
	- `disabled` greys the group while the form has no trustworthy copy (after
	  a conflict, until the list is read again).
-->
<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { PermissionRow, UserPermission } from '#lib/banto/usersAdmin.js';

	interface Props {
		rows: PermissionRow[];
		/** The draft: keys currently checked. */
		checked: readonly UserPermission[];
		disabled?: boolean;
		onchange: (key: UserPermission, checked: boolean) => void;
	}

	let { rows, checked, disabled = false, onchange }: Props = $props();

	// Ids only need to be unique within the page; the field is drawn once.
	const idFor = (index: number): string => `user-permission-desc-${index}`;
</script>

<fieldset class="permissions" {disabled} data-testid="user-permissions">
	<legend>{m['common.permissions']()}</legend>
	<p class="hint">{m['users.permissionsDesc']()}</p>
	<ul>
		{#each rows as row, index (row.key)}
			{@const hasDesc = row.registered ? row.description !== null : true}
			<li>
				<label>
					<input
						type="checkbox"
						value={row.key}
						checked={checked.includes(row.key)}
						aria-describedby={hasDesc ? idFor(index) : undefined}
						onchange={(event) => onchange(row.key, event.currentTarget.checked)}
					/>
					<span class="label">{row.label}</span>
					{#if !row.registered}
						<span class="unregistered">{m['users.permissionUnregistered']()}</span>
					{/if}
				</label>
				{#if hasDesc}
					<p class="desc" id={idFor(index)}>
						{row.registered ? row.description : m['users.permissionUnregisteredDesc']()}
					</p>
				{/if}
			</li>
		{/each}
	</ul>
</fieldset>

<style>
	.permissions {
		margin: 0 0 var(--banto-space-3);
		padding: 0;
		border: none;
		min-inline-size: 0;
	}

	legend {
		padding: 0;
		font-size: var(--banto-font-size-sm);
		font-weight: 600;
		color: var(--banto-text);
	}

	.hint {
		margin: var(--banto-space-1) 0 var(--banto-space-2);
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-2);
	}

	label {
		display: inline-flex;
		align-items: center;
		gap: var(--banto-space-2);
		cursor: pointer;
		font-size: var(--banto-font-size-base);
	}

	input {
		accent-color: var(--banto-primary);
	}

	.unregistered {
		padding: 0 var(--banto-space-2);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-sm);
		font-size: var(--banto-font-size-xs);
		color: var(--banto-text-muted);
	}

	.desc {
		margin: var(--banto-space-1) 0 0;
		padding-inline-start: var(--banto-space-6);
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	fieldset:disabled label {
		cursor: default;
	}
</style>
