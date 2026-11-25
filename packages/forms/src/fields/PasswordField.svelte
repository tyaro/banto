<script lang="ts">
	/**
	 * Password input field (spec §7.2 `type: 'password'`, added M10 RBAC for
	 * the user-management create form). Identical to TextField except for
	 * `type="password"` (masked input) and `autocomplete="new-password"` (a
	 * password field in an admin form is always setting a NEW credential for
	 * some account, never the current browser user's own login, so browsers
	 * should not offer to autofill/save it as such). The input is a `PasswordInput`:
	 * it carries the show / hide (eye) button every password box gets (#944).
	 */
	import type { FieldDef } from '../types';
	import PasswordInput from './PasswordInput.svelte';
	import type { PasswordInputMessages } from './password';

	interface Props {
		def: FieldDef;
		id?: string;
		class?: string;
		'aria-describedby'?: string;
		value: unknown;
		error?: string;
		disabled?: boolean;
		onInput: (value: string) => void;
		onBlur?: () => void;
		/** Texts of the show / hide button; defaults are Japanese. */
		messages?: Partial<PasswordInputMessages>;
	}

	let {
		def,
		id,
		class: className,
		'aria-describedby': describedBy,
		value,
		error,
		disabled = false,
		onInput,
		onBlur,
		messages
	}: Props = $props();
</script>

<PasswordInput
	class={className}
	id={id ?? def.name}
	value={(value as string | undefined) ?? ''}
	placeholder={def.placeholder}
	{disabled}
	readonly={def.readonly}
	aria-invalid={!!error}
	aria-describedby={describedBy}
	autocomplete="new-password"
	{messages}
	oninput={(event) => {
		if (!disabled && !def.readonly) onInput(event.currentTarget.value);
	}}
	onblur={() => {
		if (!disabled && !def.readonly) onBlur?.();
	}}
/>
