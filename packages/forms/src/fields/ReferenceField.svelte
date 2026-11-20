<script lang="ts">
	/**
	 * Reference field (`type: 'reference'`, #714): pick a record of another
	 * resource from a searched list. The value is the record's id (its type
	 * kept), `null` when nothing is chosen; the name shown lives here, not in
	 * the store. forms holds no data contract: the candidates come from
	 * `def.search`, the name of a stored value from `def.resolve`.
	 *
	 * Combobox + listbox with list autocomplete (WAI-ARIA APG): the text box
	 * is `role="combobox"` and **keeps focus**; the active option is named by
	 * `aria-activedescendant`, and the pointer moves that same option (one
	 * highlight). Nothing in the list takes focus (its `mousedown` is
	 * cancelled), so a click on an option never blurs the box first.
	 *
	 * Keys: typing opens the list and searches (debounced). ArrowDown opens it
	 * (Alt+ArrowDown too), ArrowUp / ArrowDown move the active option (no
	 * wrap), Enter picks it, Alt+ArrowUp closes. Esc closes the open list and
	 * leaves the typed text; a second Esc puts the name of the current value
	 * back. Tab leaves without picking. Enter with the list open never submits
	 * the form.
	 *
	 * The value changes only by picking an option, or by leaving (blur, or
	 * Enter with the list closed) with the box emptied - that is `null`. Text
	 * that was typed but not picked is never a value: on leaving, the box goes
	 * back to the name of the value it still has.
	 *
	 * Races (conventions §8): each search and each resolve is a request of the
	 * package's request owner - a newer one aborts the older one's signal and
	 * the older result is dropped even if `search` ignores the signal.
	 *
	 * The list is a `popover="manual"` in the top layer (not clipped by a
	 * drawer or a scrolling form), placed by `placeReferenceList` and placed
	 * again when an ancestor scrolls or the window resizes (it follows the
	 * input: the browser scrolling a just-focused box into view must not close
	 * a list that only just opened). It carries `data-esc-layer`, and Esc is consumed
	 * (`preventDefault`), so a dialog around the form yields its Esc.
	 */
	import { onDestroy, untrack } from 'svelte';
	import { createRequestOwner } from '../requestOwner.svelte';
	import type { FieldDef, ReferenceOption } from '../types';
	import {
		REFERENCE_SEARCH_DEBOUNCE_MS,
		defaultReferenceFieldMessages,
		isBlankReference,
		placeReferenceList,
		revealReferenceOption,
		type ReferenceFieldMessages
	} from './reference';

	interface Props {
		def: FieldDef;
		id?: string;
		class?: string;
		'aria-describedby'?: string;
		value: unknown;
		error?: string;
		disabled?: boolean;
		/** The picked option's value (type kept), or `null` when the box was emptied. */
		onInput: (value: string | number | null) => void;
		onBlur?: () => void;
		/** i18n layer 1 (conventions §13): defaults are Japanese. */
		messages?: Partial<ReferenceFieldMessages>;
		/** Wait after the last keystroke before searching (tests pass 0 or use fake timers). */
		debounceMs?: number;
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
		messages = {},
		debounceMs = REFERENCE_SEARCH_DEBOUNCE_MS
	}: Props = $props();

	const uid = $props.id();
	const listId = `${uid}-list`;
	const optionId = (index: number) => `${uid}-option-${index}`;

	const t = $derived({ ...defaultReferenceFieldMessages, ...messages });
	const editable = $derived(!disabled && !def.readonly);

	const owner = createRequestOwner();
	const SEARCH = 'search';
	const RESOLVE = 'resolve';

	let inputEl: HTMLInputElement | undefined = $state();
	let panelEl: HTMLDivElement | undefined = $state();

	/** What the box shows: the name of the value, or what the user is typing. */
	let text = $state('');
	/** The user typed since the box last showed the value's name. */
	let editing = $state(false);
	/** The option known for the current value (picked, or resolved). */
	let known: ReferenceOption | null = null;

	let open = $state(false);
	let options = $state.raw<ReferenceOption[]>([]);
	/** Index of the active option (`aria-activedescendant`), or -1. */
	let active = $state(-1);
	let phase = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	let failure = $state('');
	/** The text the shown candidates (or the "nothing found") answer. */
	let answered = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;

	/** The name shown for the current value: the known option's label, else the value itself. */
	function display(): string {
		if (isBlankReference(value)) return '';
		return known && known.value === value ? known.label : String(value);
	}

	// The value came from outside (initial values, a reset, another field's
	// handler) or from our own pick: show its name. Only `value` is tracked.
	$effect(() => {
		const current = value;
		untrack(() => {
			if (isBlankReference(current)) {
				known = null;
				owner.invalidate(RESOLVE);
			} else if (!known || known.value !== current) {
				known = null;
				void resolveName(current as string | number);
			}
			if (!editing) text = display();
		});
	});

	async function resolveName(current: string | number): Promise<void> {
		const request = owner.begin(RESOLVE);
		try {
			const option = (await def.resolve?.(current, request.signal)) ?? null;
			// A value that changed meanwhile has its own request; a missing record
			// (`null`) keeps the value itself on show.
			// A pick meanwhile (it adopts its own option) also outdates this name.
			if (!request.isCurrent() || !option || value !== current) return;
			known = { ...option, value: current };
			if (!editing) text = option.label;
		} catch {
			// The name could not be fetched: the value itself stays on show.
		} finally {
			request.finish();
		}
	}

	async function runSearch(query: string): Promise<void> {
		const request = owner.begin(SEARCH);
		phase = 'loading';
		try {
			const found = (await def.search?.(query, request.signal)) ?? [];
			if (!request.isCurrent()) return;
			options = found;
			active = -1;
			answered = query;
			phase = 'ready';
		} catch (cause) {
			if (!request.isCurrent()) return;
			options = [];
			active = -1;
			failure = t.searchFailed(cause);
			phase = 'error';
		} finally {
			request.finish();
		}
	}

	/**
	 * The words changed: the options on screen answer the old ones, so they go
	 * (nothing to arrow to, press Enter on or click) until the new answer comes.
	 * The search under way is stopped, and so is the one waiting for the debounce.
	 */
	function dropStale(): void {
		clearTimeout(timer);
		owner.invalidate(SEARCH);
		options = [];
		active = -1;
		phase = 'loading';
	}

	/** Search for `query` after the debounce (`now`: at once). */
	function scheduleSearch(query: string, now = false): void {
		dropStale();
		if (now || debounceMs <= 0) void runSearch(query);
		else timer = setTimeout(() => void runSearch(query), debounceMs);
	}

	function openList(): void {
		if (!editable) return;
		open = true;
	}

	function closeList(): void {
		clearTimeout(timer);
		owner.invalidate(SEARCH);
		open = false;
		options = [];
		active = -1;
		phase = 'idle';
	}

	function pick(option: ReferenceOption): void {
		// The picked option is the name now: a name still being fetched for the
		// previous value must not land on it.
		owner.invalidate(RESOLVE);
		known = option;
		text = option.label;
		editing = false;
		closeList();
		if (option.value !== value) onInput(option.value);
	}

	/**
	 * Leaving the box (blur, Enter with the list closed): an emptied box is
	 * "nothing chosen"; any other typed text is dropped for the name of the
	 * value the field still has.
	 */
	function settle(): void {
		if (!editing) return;
		editing = false;
		if (text.trim() === '') {
			text = '';
			if (!isBlankReference(value)) {
				known = null;
				onInput(null);
			}
		} else {
			text = display();
		}
	}

	function moveActive(delta: number): void {
		if (options.length === 0) return;
		active =
			active < 0
				? delta > 0
					? 0
					: options.length - 1
				: Math.min(Math.max(active + delta, 0), options.length - 1);
	}

	function handleInput(event: Event & { currentTarget: HTMLInputElement }): void {
		if (!editable) return;
		text = event.currentTarget.value;
		editing = true;
		// Typing takes over from the list: no option stays active, so Enter
		// never picks one the user did not move to.
		active = -1;
		openList();
		// While an IME composes, the text is not final: search when it ends.
		if (!(event as unknown as InputEvent).isComposing) scheduleSearch(text.trim());
		// Nor may a search for the text before the composition answer meanwhile.
		else dropStale();
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.isComposing || !editable) return;
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				if (!open) {
					// Browse: what was typed, or everything when the box shows the value's name.
					openList();
					scheduleSearch(editing ? text.trim() : '', true);
				} else if (!event.altKey) {
					moveActive(1);
				}
				break;
			case 'ArrowUp':
				if (!open) break;
				event.preventDefault();
				if (event.altKey) closeList();
				else moveActive(-1);
				break;
			case 'Enter':
				if (open) {
					// Never submits the form: pick the active option, or just close.
					event.preventDefault();
					const option = options[active];
					if (option) pick(option);
					else closeList();
				} else {
					// The form submits next (implicit submission): settle the value first.
					settle();
				}
				break;
			case 'Escape':
				if (open) {
					event.preventDefault();
					closeList();
				} else if (editing && text !== display()) {
					event.preventDefault();
					editing = false;
					text = display();
				}
				break;
		}
	}

	function handleBlur(): void {
		closeList();
		if (!editable) return;
		settle();
		onBlur?.();
	}

	// The field stopped being editable (a submit started) while the list was open.
	$effect(() => {
		if (!editable && open) untrack(closeList);
	});

	// Show the list in the top layer while it exists.
	$effect(() => {
		const panel = panelEl;
		if (!panel) return;
		panel.showPopover();
		// The input moved (a scrolling drawer, the page, a resize): the list
		// follows it. The list's own scroll does not move the input.
		const follow = (event: Event) => {
			if (event.target instanceof Node && panel.contains(event.target)) return;
			if (inputEl) placeReferenceList(inputEl, panel);
		};
		window.addEventListener('scroll', follow, true);
		window.addEventListener('resize', follow);
		return () => {
			window.removeEventListener('scroll', follow, true);
			window.removeEventListener('resize', follow);
		};
	});

	// Place it again whenever its content (and so its height) changes, and keep
	// the active option inside its box.
	$effect(() => {
		const panel = panelEl;
		void options;
		void phase;
		const index = active;
		if (!panel || !inputEl) return;
		placeReferenceList(inputEl, panel);
		const option = index >= 0 ? document.getElementById(optionId(index)) : null;
		if (option) revealReferenceOption(panel, option);
	});

	onDestroy(() => {
		clearTimeout(timer);
		owner.dispose();
	});

	/**
	 * The listbox is on screen. It exists only while it has options (a listbox
	 * needs some), so with the panel open on "searching" / "nothing found" /
	 * the failure, the combobox is not expanded: those are said by the status.
	 */
	const listed = $derived(open && options.length > 0);

	const note = $derived(
		phase === 'error'
			? failure
			: phase === 'loading'
				? options.length === 0
					? t.loading()
					: ''
				: phase === 'ready' && options.length === 0
					? t.noResults(answered)
					: ''
	);
	/** What a screen reader hears (`role="status"`): the same states, plus the count when candidates arrive. */
	const announcement = $derived(
		!open
			? ''
			: phase === 'loading'
				? t.loading()
				: phase === 'ready' && options.length > 0
					? t.resultCount(options.length)
					: note
	);
</script>

<input
	bind:this={inputEl}
	type="text"
	role="combobox"
	class={className}
	id={id ?? def.name}
	value={text}
	placeholder={def.placeholder}
	autocomplete="off"
	spellcheck="false"
	{disabled}
	readonly={def.readonly}
	class:muted={def.readonly}
	aria-autocomplete="list"
	aria-expanded={listed}
	aria-controls={listed ? listId : undefined}
	aria-activedescendant={listed && active >= 0 ? optionId(active) : undefined}
	aria-invalid={!!error}
	aria-describedby={describedBy}
	aria-busy={phase === 'loading' ? 'true' : undefined}
	oninput={handleInput}
	oncompositionend={(event) => {
		if (editable && open) scheduleSearch(event.currentTarget.value.trim());
	}}
	onkeydown={handleKeydown}
	onblur={handleBlur}
/>
<span class="status" role="status" aria-live="polite" data-reference-status>{announcement}</span>
{#if open}
	<!-- Nothing here takes focus: the combobox keeps it and names the active
	     option with aria-activedescendant (APG); the keys are the text box's. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		bind:this={panelEl}
		popover="manual"
		class="panel"
		data-esc-layer
		data-reference-list
		onmousedown={(event) => {
			// Keep focus on the text box: a press on an option (or the scrollbar)
			// must not blur it, which would close the list before the click.
			event.preventDefault();
		}}
	>
		{#if listed}
			<!-- svelte-ignore a11y_interactive_supports_focus -->
			<div id={listId} role="listbox" aria-label={t.listLabel(def)}>
				<!-- Keyed by position: nothing promises that the values `search` returns are unique. -->
				{#each options as option, index (index)}
					<!-- svelte-ignore a11y_interactive_supports_focus, a11y_click_events_have_key_events -->
					<div
						id={optionId(index)}
						role="option"
						class="option"
						class:option--active={index === active}
						class:option--value={option.value === value}
						aria-selected={index === active ? 'true' : 'false'}
						onpointermove={() => {
							if (active !== index) active = index;
						}}
						onclick={() => pick(option)}
					>
						<span class="option-label">{option.label}</span>
						{#if option.description}
							<span class="option-desc">{option.description}</span>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
		{#if note}
			<p class="note" class:note--error={phase === 'error'}>{note}</p>
		{/if}
	</div>
{/if}

<style>
	input {
		height: var(--banto-control-height);
		padding: 0 var(--banto-space-2);
		border: var(--banto-border-width) solid var(--banto-border-strong);
		border-radius: var(--banto-radius-md);
		background: transparent;
		color: var(--banto-text);
		font: inherit;
		width: 100%;
		box-sizing: border-box;
		transition: box-shadow var(--banto-duration-fast) var(--banto-ease-out);
	}

	input:focus-visible {
		outline: var(--banto-border-width-strong) solid transparent;
		outline-offset: var(--banto-border-width);
		box-shadow: var(--banto-focus-ring);
	}

	input:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	input.muted {
		color: var(--banto-text-muted);
	}

	/* Read out only (role="status"); the same text is shown in the list. */
	.status {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.panel {
		position: fixed;
		inset: auto;
		margin: 0;
		box-sizing: border-box;
		/* Shape of the list: as wide as the input (set when placed), about eight
		   rows tall; the placement caps it further on a short viewport. */
		max-inline-size: calc(100vw - 2 * var(--banto-space-1));
		max-block-size: var(--banto-reference-list-max-height, 16em);
		padding: var(--banto-space-1);
		border: var(--banto-border-width) solid var(--banto-border);
		border-radius: var(--banto-radius-md);
		background: var(--banto-surface-overlay);
		box-shadow: var(--banto-shadow-lg);
		color: var(--banto-text);
		font-size: var(--banto-font-size-md);
		/* Glass preset: no-op under standard (--banto-backdrop: none). */
		backdrop-filter: var(--banto-backdrop, none);
		-webkit-backdrop-filter: var(--banto-backdrop, none);
		overflow: auto;
		overscroll-behavior: contain;
	}

	.option {
		display: flex;
		flex-direction: column;
		padding: var(--banto-space-1) var(--banto-space-2);
		border-radius: var(--banto-radius-sm);
		cursor: pointer;
		overflow-wrap: anywhere;
	}

	.option-desc {
		font-size: var(--banto-font-size-sm);
		color: var(--banto-text-muted);
	}

	/* Not colour alone: the option of the current value is bold. */
	.option--value .option-label {
		font-weight: 600;
	}

	.option--active {
		background: var(--banto-surface-hover);
		box-shadow: inset 0 0 0 var(--banto-border-width) var(--banto-border-strong);
	}

	.note {
		margin: 0;
		padding: var(--banto-space-1) var(--banto-space-2);
		color: var(--banto-text-muted);
	}

	.note--error {
		color: var(--banto-danger);
	}

	@media (forced-colors: active) {
		.option--active {
			forced-color-adjust: none;
			background: Highlight;
			color: HighlightText;
		}

		.option--active .option-desc {
			color: HighlightText;
		}
	}
</style>
