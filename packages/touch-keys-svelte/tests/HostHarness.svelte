<script lang="ts">
	/** Test page for TouchKeysHost: a form with every kind of field the host must tell apart. */
	import TouchKeysHost from '../src/TouchKeysHost.svelte';
	import { touchKeys } from '../src/attach';
	import type { TouchKeysMessages } from '../src/messages';
	import type { TextLayout } from '../src/core/text';
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
		recMax?: number;
		recDecimals?: number;
		decOff?: boolean;
		decRequired?: boolean;
		memoMax?: number;
		memoLayouts?: TextLayout[];
		pwType?: string;
		placement?: { number?: TouchKeysPlacement; text?: TouchKeysPlacement };
		layouts?: TextLayout[];
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
		recMax = 100,
		recDecimals,
		decOff = false,
		decRequired = false,
		memoMax,
		memoLayouts,
		pwType = 'password',
		placement,
		layouts,
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
	let title = $state('abc');
</script>

{#snippet unit({ draft }: { input: HTMLInputElement; draft: string | null })}
	<span data-testid="note" data-draft-null={draft === null ? 'yes' : 'no'}>{draft} kg</span>
{/snippet}

<TouchKeysHost
	{enabled}
	{placement}
	{layouts}
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
	<input
		id="rec"
		type="text"
		value="5"
		{@attach touchKeys({ kind: 'number', editKey, max: recMax, decimals: recDecimals })}
	/>
	<!-- the inner marker must not hide an "off" further out (§15.1) -->
	<div data-touch-keys={decOff ? 'off' : undefined}>
		<div data-touch-keys="on">
			<input
				id="dec"
				type="text"
				inputmode="decimal"
				value="1.5"
				aria-label="重さ"
				required={decRequired}
			/>
		</div>
	</div>
	<input id="off" type="number" {@attach touchKeys(false)} />
	<div data-touch-keys="off"><input id="wrapped" type="number" /></div>
	<input id="name" type="text" />
	<input id="ro" type="number" readonly />
	<!-- text keyboard fields (T3) -->
	<label for="title">題名</label>
	<input id="title" type="text" bind:value={title} {onkeydown} />
	<output data-testid="bound-title">{title}</output>
	<input id="code" type="text" maxlength="5" value="ab" aria-label="コード" />
	<input
		id="memo"
		type="text"
		value="x"
		aria-label="メモ"
		{@attach touchKeys({
			kind: 'text',
			editKey: () => editKey,
			maxLength: memoMax,
			layouts: memoLayouts
		})}
	/>
	<input id="mail" type="email" value="" aria-label="メール" required />
	<input id="numtext" type="number" {@attach touchKeys({ kind: 'text' })} />
	<input id="ro-text" type="text" readonly />
	<!-- password fields (§5.5) -->
	<input id="pw" type={pwType} value="old-secret" aria-label="パスワード" {onkeydown} />
	<input
		id="pin"
		type="password"
		inputmode="numeric"
		maxlength="4"
		aria-label="暗証番号"
		{@attach touchKeys({ kind: 'number', max: 9999 })}
	/>
	<button type="submit">保存</button>
</form>
