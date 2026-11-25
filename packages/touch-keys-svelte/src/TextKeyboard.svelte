<script lang="ts">
	/**
	 * On-screen text keyboard (letters / digits and symbols): the display (title, draft,
	 * character count, notice) and the keys. It only edits a draft and reports confirm /
	 * cancel; `TouchKeysHost` binds it to an `<input>` (touch-keypad-design §5.3, §9).
	 *
	 * The draft is edited at its end only (append, delete the last character, clear). Case is a
	 * toggle key that stays until pressed again; there is no long-press, repeat or double-tap
	 * (§11). Keys never take focus (`mousedown` is prevented) and enter on `click`.
	 *
	 * `masked` (password fields, §5.5) is a contract, not only a look:
	 * - the draft lives inside this component and starts EMPTY; `draft` is neither read nor written,
	 * - the display shows one dot per character (never the last character), plus the count,
	 * - `note` receives `null`, `onlength` only the length; the plain text leaves exactly once,
	 *   as the argument of `onconfirm`,
	 * - every printable ASCII character is reachable (all layouts, the full symbol set).
	 * `masked` is read once, when the keyboard is created: flipping it later reveals nothing.
	 *
	 * Sizing: `--banto-touch-key-size` (default 48px); keys shrink when the width runs out (§10).
	 */
	import { untrack, type Snippet } from 'svelte';
	import {
		classifyText,
		pressTextKey,
		resolveTextLayouts,
		resolveTextRules,
		textKeyRows,
		type TextKey,
		type TextLayout
	} from './core/text';
	import { defaultTouchKeysMessages, type TouchKeysMessages } from './messages';

	interface Props {
		/** The draft text. Starts as the field's current value; read it on confirm. Unused when `masked`. */
		draft?: string;
		/** Upper bound in UTF-16 code units (as the `maxlength` attribute). */
		maxLength?: number;
		/** An empty draft cannot be confirmed. */
		required?: boolean;
		/** Layouts to offer, in order (default: all). With one layout there are no switch keys. */
		layouts?: TextLayout[];
		/** The layout shown first (default: the first of `layouts`). */
		initialLayout?: TextLayout;
		/** Password entry: see the contract above. */
		masked?: boolean;
		/** Heading shown above the draft. */
		label?: string;
		messages?: TouchKeysMessages;
		/** One extra line under the draft (unit, caution). Receives the draft, or `null` when `masked`. */
		note?: Snippet<[string | null]>;
		/** After every key: the draft's length (never its text). */
		onlength?: (length: number) => void;
		/** Confirm pressed with a confirmable draft. */
		onconfirm?: (value: string) => void;
		oncancel?: () => void;
	}

	let {
		draft = $bindable(''),
		maxLength,
		required,
		layouts,
		initialLayout,
		masked,
		label,
		messages,
		note,
		onlength,
		onconfirm,
		oncancel
	}: Props = $props();

	const isMasked = untrack(() => masked === true);
	/** The masked draft: component-local, gone with the component. */
	let secret = $state('');
	const text = $derived(isMasked ? secret : draft);

	const t = $derived({ ...defaultTouchKeysMessages, ...messages });
	const rules = $derived(resolveTextRules({}, { maxLength, required }));
	const offered = $derived(resolveTextLayouts(layouts, isMasked));
	let chosen = $state<TextLayout | undefined>(untrack(() => initialLayout));
	const layout = $derived(chosen !== undefined && offered.includes(chosen) ? chosen : offered[0]);
	let upper = $state(false);
	const rows = $derived(textKeyRows(layout, { upper, fullSymbols: isMasked }));
	const status = $derived(classifyText(text, rules));

	const shown = $derived(isMasked ? '●'.repeat(text.length) : text);
	const countLine = $derived(
		isMasked || rules.maxLength !== undefined ? t.length(text.length, rules.maxLength ?? null) : ''
	);
	const notice = $derived(
		status.notice === 'required'
			? t.required()
			: status.notice === 'max-length' && rules.maxLength !== undefined
				? t.maxLength(rules.maxLength)
				: ''
	);
	const layoutName = (l: TextLayout): string => (l === 'symbol' ? t.symbol() : t.alnum());

	function press(key: TextKey) {
		const next = pressTextKey(text, key, rules);
		if (isMasked) secret = next;
		else draft = next;
		onlength?.(next.length);
	}

	function confirm() {
		if (!status.canConfirm) return;
		onconfirm?.(text);
	}

	/** Keeps focus on the target input: a key press must not blur it. */
	function keepFocus(e: Event) {
		e.preventDefault();
	}
</script>

<div
	class="keyboard"
	role="group"
	aria-label={label ? `${t.textKeyboard()} ${label}` : t.textKeyboard()}
	oncontextmenu={keepFocus}
>
	<div class="display">
		{#if label}<div class="label">{label}</div>{/if}
		<div class="draft" data-testid="draft">{shown === '' ? ' ' : shown}</div>
		{#if countLine}<div class="count" data-testid="count">{countLine}</div>{/if}
		{#if note}<div class="note">{@render note(isMasked ? null : text)}</div>{/if}
		<div class="notice" role="status" aria-live="polite">{notice}</div>
	</div>

	<div class="rows">
		{#each rows as row, index (index)}
			<div class="row">
				{#each row as k (k)}
					<button
						type="button"
						class="key"
						tabindex="-1"
						onmousedown={keepFocus}
						onclick={() => press({ char: k })}
					>
						{k}
					</button>
				{/each}
			</div>
		{/each}
	</div>

	<div class="row tools">
		{#if layout === 'alnum'}
			<button
				type="button"
				class="key fn"
				tabindex="-1"
				onmousedown={keepFocus}
				onclick={() => (upper = !upper)}
			>
				{upper ? t.lower() : t.upper()}
			</button>
		{/if}
		{#if offered.length > 1}
			{#each offered as l (l)}
				<button
					type="button"
					class="key fn"
					tabindex="-1"
					aria-pressed={l === layout}
					onmousedown={keepFocus}
					onclick={() => (chosen = l)}
				>
					{layoutName(l)}
				</button>
			{/each}
		{/if}
		<button
			type="button"
			class="key fn space"
			tabindex="-1"
			onmousedown={keepFocus}
			onclick={() => press({ char: ' ' })}
		>
			{t.space()}
		</button>
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
	</div>

	<div class="row actions">
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
	.keyboard {
		--_size: var(--banto-touch-key-size, 48px);
		--_gap: var(--banto-touch-key-gap, var(--banto-space-2));
		display: inline-flex;
		flex-direction: column;
		gap: var(--_gap);
		padding: var(--banto-space-3);
		box-sizing: border-box;
		background: var(--banto-surface-raised);
		color: var(--banto-text);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		touch-action: manipulation;
		user-select: none;
		-webkit-user-select: none;
		/*
		 * Ten keys wide. Stated outright: a flex container's own width comes from its items'
		 * content, not from their flex-basis, so without it the rows would squeeze the keys.
		 */
		width: calc(
			10 * var(--_size) + 9 * var(--_gap) + 2 * var(--banto-space-3) + 2 * var(--banto-border-width)
		);
		max-width: 100%;
		min-width: 0;
	}
	.display {
		display: flex;
		flex-direction: column;
		gap: var(--banto-space-1);
		min-width: 0;
	}
	.label {
		color: var(--banto-text-muted);
		font-size: var(--banto-font-size-sm);
	}
	.draft {
		min-height: 1.4em;
		font-size: var(--banto-font-size-2xl);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.count,
	.note {
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
	.rows {
		display: flex;
		flex-direction: column;
		gap: var(--_gap);
		/* Four rows whatever the layout, so the keys below do not jump on a layout switch. */
		min-height: calc(4 * var(--_size) + 3 * var(--_gap));
	}
	.row {
		display: flex;
		justify-content: center;
		gap: var(--_gap);
		min-width: 0;
	}
	.key {
		/* Shrinks below the key size when ten keys do not fit the width (§10). */
		flex: 0 1 var(--_size);
		min-width: 0;
		height: var(--_size);
		padding: 0;
		font-size: var(--banto-font-size-xl);
		font-family: inherit;
		color: var(--banto-text);
		background: var(--banto-surface);
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: var(--banto-radius-sm);
		cursor: pointer;
		touch-action: manipulation;
	}
	.tools,
	.actions {
		flex-wrap: wrap;
	}
	.key.fn,
	.key.confirm {
		flex: 1 1 auto;
		min-width: var(--_size);
		padding: 0 var(--banto-space-2);
	}
	.key.fn {
		font-size: var(--banto-font-size-md);
	}
	.key.space {
		flex-grow: 3;
	}
	.key[aria-pressed='true'] {
		background: var(--banto-surface-hover);
		border-color: var(--banto-primary-solid);
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
