<script lang="ts">
	/**
	 * On-screen number keypad: the display (title, draft, allowed range, notice)
	 * and the keys. It only edits a draft and reports confirm / cancel — binding
	 * it to an `<input>`, the popover and the host come later (touch-keypad-design §5.3, §15 T2).
	 *
	 * Keys never take focus (`mousedown` is prevented) and enter on `click`; there is no
	 * long-press, repeat or double-tap (§11). Sizing: `--banto-touch-key-size` (default 48px).
	 */
	import {
		classifyDraft,
		pressNumberKey,
		resolveNumberRules,
		type NumberKey,
		type NumberRules
	} from './core/number';
	import { formatDec } from './core/decimal';
	import { defaultTouchKeysMessages, type TouchKeysMessages } from './messages';

	interface Props {
		/**
		 * Already-resolved rules (e.g. from `resolveNumberRules` on a real `<input>`). When given,
		 * display, key entry and the confirm check all use it and `min`/`max`/`step`/`decimals`/
		 * `allowNegative`/`required` are ignored, so the keypad never judges differently from the host.
		 */
		rules?: NumberRules;
		/** The draft text. Starts as the field's current value; read it on confirm. */
		draft?: string;
		min?: number | string;
		max?: number | string;
		/** `'any'` = no step rule. */
		step?: number | string | 'any';
		/** Fractional digits the keys may enter (default: unlimited up to the 15-digit cap). */
		decimals?: number;
		/** Show the sign key. Default: true unless `min >= 0`. */
		allowNegative?: boolean;
		/** An empty draft cannot be confirmed. */
		required?: boolean;
		/** Heading shown above the draft. */
		label?: string;
		messages?: TouchKeysMessages;
		/** Confirm pressed with a confirmable draft: the canonical string ('' for empty). */
		onconfirm?: (value: string) => void;
		oncancel?: () => void;
	}

	let {
		rules: givenRules,
		draft = $bindable(''),
		min,
		max,
		step,
		decimals,
		allowNegative,
		required,
		label,
		messages,
		onconfirm,
		oncancel
	}: Props = $props();

	const t = $derived({ ...defaultTouchKeysMessages, ...messages });
	const rules = $derived(
		givenRules ??
			resolveNumberRules(
				{ required },
				{ min, max, step, decimals, allowNegative, required },
				{ force: true }
			)!
	);
	let fresh = $state(true);
	const status = $derived(classifyDraft(draft, rules));

	const rangeLine = $derived.by(() => {
		const lo = rules.min ? formatDec(rules.min) : null;
		const hi = rules.max ? formatDec(rules.max) : null;
		return lo === null && hi === null ? '' : t.range(lo, hi);
	});
	const notice = $derived.by(() => {
		if (status.kind === 'empty') return status.notice === 'required' ? t.required() : '';
		if (status.kind !== 'invalid') return '';
		if (status.reason === 'step') return t.step(status.lower, status.upper);
		return t.range(status.min, status.max);
	});

	function press(key: NumberKey) {
		const next = pressNumberKey({ text: draft, fresh }, key, rules);
		draft = next.text;
		fresh = next.fresh;
	}

	function confirm() {
		if (!status.canConfirm) return;
		onconfirm?.(status.kind === 'valid' ? status.value : '');
	}

	/** Keeps focus on the target input: a key press must not blur it. */
	function keepFocus(e: Event) {
		e.preventDefault();
	}

	const digitRows: NumberKey[][] = [
		['7', '8', '9'],
		['4', '5', '6'],
		['1', '2', '3']
	];
</script>

<div
	class="keypad"
	role="group"
	aria-label={label ? `${t.numberKeypad()} ${label}` : t.numberKeypad()}
	oncontextmenu={keepFocus}
>
	<div class="display">
		{#if label}<div class="label">{label}</div>{/if}
		<div class="draft" data-testid="draft">{draft === '' ? ' ' : draft}</div>
		{#if rangeLine}<div class="range">{rangeLine}</div>{/if}
		<div class="notice" role="status" aria-live="polite">{notice}</div>
	</div>

	<div class="keys">
		{#each digitRows as row (row[0])}
			{#each row as k (k)}
				<button
					type="button"
					class="key"
					tabindex="-1"
					onmousedown={keepFocus}
					onclick={() => press(k)}
				>
					{k}
				</button>
			{/each}
		{/each}
		{#if rules.allowNegative}
			<button
				type="button"
				class="key fn"
				tabindex="-1"
				aria-label={t.sign()}
				onmousedown={keepFocus}
				onclick={() => press('sign')}
			>
				±
			</button>
		{:else}
			<span class="gap" aria-hidden="true"></span>
		{/if}
		<button
			type="button"
			class="key"
			tabindex="-1"
			onmousedown={keepFocus}
			onclick={() => press('0')}
		>
			0
		</button>
		{#if rules.decimals > 0}
			<button
				type="button"
				class="key"
				tabindex="-1"
				onmousedown={keepFocus}
				onclick={() => press('.')}
			>
				.
			</button>
		{:else}
			<span class="gap" aria-hidden="true"></span>
		{/if}
	</div>

	<div class="actions">
		<button
			type="button"
			class="key fn"
			tabindex="-1"
			onmousedown={keepFocus}
			onclick={() => press('backspace')}
		>
			{t.backspace()}
		</button>
		<button
			type="button"
			class="key fn"
			tabindex="-1"
			onmousedown={keepFocus}
			onclick={() => press('clear')}
		>
			{t.clearAll()}
		</button>
		<button
			type="button"
			class="key fn"
			tabindex="-1"
			onmousedown={keepFocus}
			onclick={() => oncancel?.()}
		>
			{t.cancel()}
		</button>
		<button
			type="button"
			class="key confirm"
			tabindex="-1"
			disabled={!status.canConfirm}
			onmousedown={keepFocus}
			onclick={confirm}
		>
			{t.confirm()}
		</button>
	</div>
</div>

<style>
	.keypad {
		--_size: var(--banto-touch-key-size, 48px);
		--_gap: var(--banto-touch-key-gap, var(--banto-space-2));
		display: inline-flex;
		flex-direction: column;
		gap: var(--_gap);
		padding: var(--banto-space-3);
		background: var(--banto-surface-raised);
		color: var(--banto-text);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		touch-action: manipulation;
		user-select: none;
		-webkit-user-select: none;
		max-width: 100%;
	}
	.display {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
	}
	.label {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}
	.draft {
		min-height: 1.4em;
		font-size: var(--banto-font-size-2xl);
		text-align: end;
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}
	.range {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
		text-align: end;
	}
	.notice {
		min-height: 1.2em;
		color: var(--banto-danger);
		font-size: var(--banto-font-size-sm);
		text-align: end;
	}
	.keys {
		display: grid;
		grid-template-columns: repeat(3, var(--_size));
		grid-auto-rows: var(--_size);
		gap: var(--_gap);
		justify-content: center;
	}
	.actions {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		grid-auto-rows: var(--_size);
		gap: var(--_gap);
	}
	.key {
		min-width: var(--_size);
		min-height: var(--_size);
		padding: 0 var(--banto-space-2);
		font-size: var(--banto-font-size-xl);
		font-family: inherit;
		color: var(--banto-text);
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: var(--banto-radius-sm);
		cursor: pointer;
		touch-action: manipulation;
	}
	.key.fn {
		font-size: var(--banto-font-size-md);
	}
	.key:active:not(:disabled) {
		background: var(--banto-surface-hover);
	}
	.key.confirm {
		background: var(--banto-primary-solid);
		color: var(--banto-text-inverse);
		border-color: var(--banto-primary-solid);
	}
	.key.confirm:active:not(:disabled) {
		background: var(--banto-primary-solid-hover);
	}
	.key:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
