<script lang="ts">
	/** Test page for TouchKeysHost: a form with every kind of field the host must tell apart. */
	import TouchKeysHost from '../src/TouchKeysHost.svelte';
	import { touchKeys } from '../src/attach';
	import type { TouchKeysMessages } from '../src/messages';
	import type { ResolveFn } from '../src/target';
	import type {
		TouchKeysCancelDetail,
		TouchKeysConfirmDetail,
		TouchKeysPlacement
	} from '../src/types';

	interface Props {
		enabled?: boolean;
		show?: boolean;
		editKey?: string | number;
		placement?: { number?: TouchKeysPlacement };
		resolve?: ResolveFn;
		messages?: TouchKeysMessages;
		withNote?: boolean;
		onopen?: (input: HTMLInputElement) => void;
		onconfirm?: (detail: TouchKeysConfirmDetail) => void;
		oncancel?: (detail: TouchKeysCancelDetail) => void;
		onkeydown?: (event: KeyboardEvent) => void;
		onsubmit?: (event: SubmitEvent) => void;
	}

	let {
		enabled = true,
		show = true,
		editKey = 1,
		placement,
		resolve,
		messages,
		withNote = false,
		onopen,
		onconfirm,
		oncancel,
		onkeydown,
		onsubmit
	}: Props = $props();

	let qty = $state<number | string>(12);
</script>

{#snippet unit({ draft }: { input: HTMLInputElement; draft: string | null })}
	<span data-testid="note">{draft} kg</span>
{/snippet}

<TouchKeysHost
	{enabled}
	{placement}
	{resolve}
	{messages}
	{onopen}
	{onconfirm}
	{oncancel}
	note={withNote ? unit : undefined}
/>

<form
	onsubmit={(event) => {
		event.preventDefault();
		onsubmit?.(event);
	}}
>
	{#if show}
		<label for="qty">数量</label>
		<input
			id="qty"
			type="number"
			min="0"
			max="999"
			bind:value={qty}
			{onkeydown}
			{@attach touchKeys({ kind: 'number', editKey: () => editKey })}
		/>
	{/if}
	<output data-testid="bound">{qty}</output>
	<input id="rec" type="text" value="5" {@attach touchKeys({ kind: 'number', editKey })} />
	<input id="dec" type="text" inputmode="decimal" value="1.5" aria-label="重さ" />
	<input id="off" type="number" {@attach touchKeys(false)} />
	<div data-touch-keys="off"><input id="wrapped" type="number" /></div>
	<input id="name" type="text" />
	<input id="ro" type="number" readonly />
	<button type="submit">保存</button>
</form>
