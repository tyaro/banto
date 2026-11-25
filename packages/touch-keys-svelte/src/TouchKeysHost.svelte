<script lang="ts">
	/**
	 * The one host of the on-screen keys (touch-keypad-design §5.1, §6, §7): put it
	 * once at the app root. While `enabled`, a tap on a numeric `<input>` opens the
	 * number keypad for it and a tap on a text / password `<input>` the text keyboard;
	 * confirm writes the field's `value` and emits `input` then `change`, so `bind:value`
	 * and `oninput` fields receive it unchanged.
	 *
	 * Promises kept here:
	 * - Opens on `click`, never on `focus` (the one exception: a field with `openOnFocus` opens when
	 *   focus enters it in the continuation of a pointer-made click). Focus stays on the field the whole time
	 *   (keys and the catch surface never take it), so nothing blurs and no focus is restored.
	 * - The keys live in a `popover="manual"` (top layer, above any Modal) whose element
	 *   is a full-viewport catch surface: a tap outside cancels and does NOT reach the page
	 *   underneath (§7.2.1). The only exception is another keypad field: one tap moves there.
	 * - While open the surface carries `data-esc-layer`, so `@banto/ui` layers yield Esc to
	 *   it; Esc cancels unless something already consumed it (§7.3).
	 * - Hardware keys / scanners typing into the field cancel the keys (one owner of the
	 *   value, §6.3). A hardware Enter with an unconfirmed change only closes the keys
	 *   (consumed in the capture phase); held-down Enter repeats never pass through.
	 * - Right before writing, the field's value and `editKey` must equal what they were at
	 *   open, and the written value must stick and satisfy the browser's own validity —
	 *   otherwise nothing is written and no event is emitted (`target-changed`, §6.5 / §8.3).
	 * - Password fields (§5.5): the plain text is never handed out. The draft lives inside the
	 *   masked `TextKeyboard` (this host holds only whether it is pending), starts empty and dies with
	 *   that keyboard on every way of closing; `onconfirm` gets `value: null, previous: null`
	 *   and `note` gets `draft: null`. Nothing here logs a draft or a value.
	 *
	 * `enabled` has no default: the package never guesses whether the device has a keyboard (§12).
	 */
	import { untrack, type Snippet } from 'svelte';
	import NumberKeypad from './NumberKeypad.svelte';
	import TextKeyboard from './TextKeyboard.svelte';
	import { onAttach } from './attach';
	import { classifyDraft, type NumberRules } from './core/number';
	import { classifyText, type TextLayout } from './core/text';
	import type { TouchKeysMessages } from './messages';
	import {
		releaseOsKeyboard,
		resolveTarget,
		restoreOsKeyboard,
		suppressOsKeyboard,
		writeChecked,
		writeTextChecked,
		type ResolveFn,
		type Target
	} from './target';
	import type {
		TouchKeysCancelDetail,
		TouchKeysCancelReason,
		TouchKeysConfirmDetail,
		TouchKeysPlacement
	} from './types';

	interface Props {
		/** Use the keys at all. While false the host listens to nothing and touches no field. */
		enabled: boolean;
		/** Default placement; a field's own `placement` wins. Default `{ number: 'popup', text: 'bottom' }`. */
		placement?: { number?: TouchKeysPlacement; text?: TouchKeysPlacement };
		/**
		 * Layouts of the text keyboard, in order (the first one shows first). Default: all.
		 * A field's own `layouts` wins; password fields always get every layout (§5.5).
		 */
		layouts?: TextLayout[];
		/**
		 * Options for fields the app did not write itself (inside a form component).
		 * `false` = no keys on this field, `undefined` = infer from the attributes.
		 */
		resolve?: ResolveFn;
		messages?: TouchKeysMessages;
		onopen?: (input: HTMLInputElement) => void;
		/**
		 * After the value was written and `input` / `change` were emitted.
		 * For a password field `value` and `previous` are `null` (§5.5).
		 */
		onconfirm?: (detail: TouchKeysConfirmDetail) => void;
		/** Closed without writing. The draft is not handed out. */
		oncancel?: (detail: TouchKeysCancelDetail) => void;
		/** One extra line under the draft (unit, caution). `draft` is `null` for a password field. */
		note?: Snippet<[{ input: HTMLInputElement; draft: string | null }]>;
	}

	let {
		enabled,
		placement,
		layouts,
		resolve,
		messages,
		onopen,
		onconfirm,
		oncancel,
		note: noteLine
	}: Props = $props();

	interface Session {
		/** Open count: late work from an earlier session checks it and drops out (conventions §8). */
		id: number;
		/** What was resolved at open: the kind of keys, their rules, and (text) whether it is masked. */
		target: Target;
		input: HTMLInputElement;
		placement: TouchKeysPlacement;
		/**
		 * Compared again right before the write (§6.5). For a password field this is the
		 * field's own current value: compared only, never rendered or handed out.
		 */
		openValue: string;
		openEditKey: string | number | null | undefined;
		openType: string;
	}

	let session = $state.raw<Session | null>(null);
	/** The draft of the open keys. Stays '' for a password field: its draft never leaves the keyboard. */
	let draft = $state('');
	/** Password fields only: the masked keyboard holds typed characters, or was explicitly cleared. */
	let maskedPending = $state(false);
	/** The field refused the last text confirm (type / pattern): the keyboard says so until the next key. */
	let rejected = $state(false);
	let sessionCount = 0;
	/** A hardware Enter just closed the keys: swallow its auto-repeats until the key is released. */
	let swallowEnterRepeat = false;

	const MODIFIER_KEYS = new Set([
		'Shift',
		'Control',
		'Alt',
		'AltGraph',
		'Meta',
		'OS',
		'CapsLock',
		'NumLock',
		'ScrollLock',
		'Fn',
		'FnLock',
		'Hyper',
		'Super',
		'Symbol',
		'SymbolLock'
	]);

	// ------------------------------------------------------------ open / close

	const isMasked = (target: Target): boolean => target.kind === 'text' && target.masked;

	function open(candidate: Target): void {
		const { input } = candidate;
		suppressOsKeyboard(input);
		if (document.activeElement !== input) input.focus({ preventScroll: true });
		// A focus handler may have changed the field (its type, readonly, its options): everything
		// about this session - masked or not, the draft, the opening value and type - is decided
		// HERE, after focus, from one moment. Deciding "masked" before focus and the type after it
		// could copy a password into unmasked keys.
		const target = resolveTarget(input, resolve);
		if (!target) {
			releaseOsKeyboard(input);
			return;
		}
		// A password field starts from an empty draft: its current value is not copied (§5.5).
		draft = isMasked(target) ? '' : input.value;
		maskedPending = false;
		rejected = false;
		session = {
			id: ++sessionCount,
			target,
			input,
			placement:
				target.placement ??
				(target.kind === 'text' ? (placement?.text ?? 'bottom') : (placement?.number ?? 'popup')),
			openValue: input.value,
			openEditKey: target.editKey,
			openType: input.type
		};
		onopen?.(input);
	}

	/** Drops the session and the draft. Returns the closed session (null when none was open). */
	function close(): Session | null {
		const closed = session;
		session = null;
		draft = '';
		maskedPending = false;
		rejected = false;
		return closed;
	}

	function cancel(reason: TouchKeysCancelReason): void {
		const closed = close();
		if (closed) oncancel?.({ input: closed.input, reason });
	}

	/** Still the field it was at open: in the page, editable, same type, not behind a closing layer. */
	function isLive(s: Session): boolean {
		const { input } = s;
		return (
			input.isConnected &&
			!input.readOnly &&
			!input.matches(':disabled') &&
			input.type === s.openType &&
			!input.closest('[inert], [data-layer-inactive]')
		);
	}

	/** §6.5: same value and same edit key as at open. Returns the field as it resolves NOW, or null. */
	function currentIfSame(s: Session): Target | null {
		if (s.input.value !== s.openValue) return null;
		const now = resolveTarget(s.input, resolve);
		return now !== null && Object.is(now.editKey, s.openEditKey) ? now : null;
	}

	/** An unconfirmed change (§6.3): the keys changed the draft away from the opening value. */
	function hasPending(s: Session): boolean {
		return isMasked(s.target) ? maskedPending : draft !== s.openValue;
	}

	function matchesOpen(s: Session): boolean {
		return currentIfSame(s) !== null;
	}

	/**
	 * `classifyDraft` does not look at the fraction digits (the keys never let more in than the
	 * rules they were opened with), so a `decimals` lowered while open is checked here. A value
	 * left exactly as it was at open is not an entry of this session and passes as before.
	 */
	function fitsDecimals(value: string, openValue: string, rules: NumberRules): boolean {
		if (value === openValue) return true;
		const dot = value.indexOf('.');
		return dot < 0 || value.length - dot - 1 <= rules.decimals;
	}

	function confirm(value: string): void {
		const s = session;
		if (!s) return;
		if (!isLive(s)) return cancel('target-gone');
		const now = currentIfSame(s);
		// The rules may have changed while the keys were open (another setting lowered `max`,
		// `required` was added): the value must satisfy the rules as they are NOW.
		if (
			!now ||
			now.kind !== 'number' ||
			!classifyDraft(value, now.rules).canConfirm ||
			!fitsDecimals(value, s.openValue, now.rules) ||
			!writeChecked(s.input, value, s.openValue)
		) {
			return cancel('target-changed');
		}
		close();
		s.input.dispatchEvent(new Event('input', { bubbles: true }));
		s.input.dispatchEvent(new Event('change', { bubbles: true }));
		onconfirm?.({ input: s.input, value, previous: s.openValue });
	}

	/**
	 * The text keyboard's confirm: the same checks as `confirm` (§6.5, rules as they are NOW,
	 * the write must stick). `value` is the only place a password draft passes through this
	 * host; it goes into the field and nowhere else.
	 *
	 * A text the field itself refuses (`type="email"` / `"url"`, `pattern`) is not written and
	 * emits nothing either, but the keys STAY OPEN with a notice: unlike the number keypad the
	 * keys cannot know a field's pattern beforehand, and closing would throw the draft away.
	 */
	function confirmText(value: string): void {
		const s = session;
		if (!s || s.target.kind !== 'text') return;
		// A password field is emptied only after the clear-all key (§5.5): an untouched empty
		// draft says nothing about the value in the field. The keyboard already refuses this.
		if (s.target.masked && value === '' && !maskedPending) return;
		if (!isLive(s)) return cancel('target-gone');
		const now = currentIfSame(s);
		if (
			!now ||
			now.kind !== 'text' ||
			now.masked !== s.target.masked ||
			!classifyText(value, now.rules).canConfirm
		) {
			return cancel('target-changed');
		}
		const written = writeTextChecked(s.input, value, s.openValue);
		if (written === 'invalid') {
			rejected = true;
			return;
		}
		if (written !== 'ok') return cancel('target-changed');
		const masked = s.target.masked;
		close();
		s.input.dispatchEvent(new Event('input', { bubbles: true }));
		s.input.dispatchEvent(new Event('change', { bubbles: true }));
		onconfirm?.(
			masked
				? { input: s.input, value: null, previous: null }
				: { input: s.input, value, previous: s.openValue }
		);
	}

	/** A later check for the session that is open now (a no-op once it closed or was replaced). */
	function later(check: (s: Session) => void, schedule: (run: () => void) => void): void {
		const id = session?.id;
		if (id === undefined) return;
		schedule(() => {
			if (session && session.id === id) check(session);
		});
	}

	// ------------------------------------------------------------ page listeners

	function fieldOf(target: EventTarget | null): EventTarget | null {
		if (target instanceof HTMLInputElement) return target;
		if (target instanceof Element) {
			const label = target.closest('label');
			if (label) return label.control;
		}
		return target;
	}

	function inSurface(target: EventTarget | null): boolean {
		return target instanceof Element && target.closest('[data-touch-keys-surface]') !== null;
	}

	/** Before focus enters a keypad field: keep the OS keyboard away (§7.4). */
	function onPointerdown(event: Event): void {
		closeClickWindow();
		if (inSurface(event.target)) return;
		const field = fieldOf(event.target);
		const target = resolveTarget(field, resolve);
		if (target) suppressOsKeyboard(target.input);
		// No longer a keypad field (touchKeys(false), data-touch-keys="off", readonly ...):
		// give it its own inputmode back, or a touch-only device could not type into it.
		else if (field instanceof HTMLInputElement) releaseOsKeyboard(field);
	}

	/**
	 * `openOnFocus`: true from a pointer-made click until the end of its task. The app's click
	 * handler (and the microtasks it queues, e.g. a Svelte flush) run inside that window, so a
	 * field it shows and focuses is "the continuation of the tap"; a later focus is not.
	 * It is an approximation of "same task" (a timer gives no ordering guarantee against other
	 * task sources), so any other input - a key, a new pointerdown, a keyboard-made click -
	 * closes it at once.
	 */
	let clickWindow = false;
	let clickWindowTimer: ReturnType<typeof setTimeout> | undefined;

	function closeClickWindow(): void {
		clickWindow = false;
		clearTimeout(clickWindowTimer);
	}

	function onFocusin(event: FocusEvent): void {
		if (!clickWindow || inSurface(event.target)) return;
		if (session && event.target === session.input) return;
		const target = resolveTarget(event.target, resolve);
		if (!target?.openOnFocus) return;
		closeClickWindow();
		if (session) cancel('outside');
		open(target);
	}

	function onClick(event: MouseEvent): void {
		if (inSurface(event.target)) return;
		// A keyboard-made click (Enter / Space) has detail 0: it never starts the window, and closes one.
		closeClickWindow();
		if (event.detail > 0) {
			clickWindow = true;
			clearTimeout(clickWindowTimer);
			clickWindowTimer = setTimeout(closeClickWindow, 0);
		}
		if (session && event.target === session.input) return;
		const target = resolveTarget(event.target, resolve);
		if (!target) return;
		if (session) cancel('outside');
		open(target);
	}

	/** Capture phase on window: runs before the field's own handlers. */
	function onKeydownCapture(event: KeyboardEvent): void {
		closeClickWindow();
		const isEnter = event.key === 'Enter';
		if (!session) {
			if (!isEnter) return;
			if (event.repeat && swallowEnterRepeat) {
				event.preventDefault();
				event.stopImmediatePropagation();
			} else {
				swallowEnterRepeat = false;
			}
			return;
		}
		if (event.key === 'Escape' || MODIFIER_KEYS.has(event.key)) return;
		if (isEnter && (hasPending(session) || event.repeat)) {
			// An unconfirmed change (or a held-down Enter): close only. Letting it through would
			// submit the value from BEFORE the keys opened while the keys showed another one (§6.3).
			event.preventDefault();
			event.stopImmediatePropagation();
			swallowEnterRepeat = true;
			cancel('hardware-input');
			return;
		}
		// Any other key (and an Enter with nothing pending) goes to the field as usual - once:
		// the auto-repeats of that Enter are swallowed until the key is released.
		if (isEnter) swallowEnterRepeat = true;
		cancel('hardware-input');
	}

	function onKeyup(event: KeyboardEvent): void {
		if (event.key === 'Enter') swallowEnterRepeat = false;
	}

	/** Bubble phase on window (§7.3): a layer or the field that consumed Esc wins. */
	function onKeydown(event: KeyboardEvent): void {
		if (!session || event.key !== 'Escape') return;
		if (event.isComposing || event.keyCode === 229) return;
		if (event.defaultPrevented) return;
		event.preventDefault();
		cancel('cancel-key');
	}

	function onBeforeinput(event: Event): void {
		if (session && event.target === session.input) cancel('hardware-input');
	}

	function onFocusout(event: FocusEvent): void {
		if (session && event.target === session.input) cancel('target-gone');
	}

	function onSubmit(event: Event): void {
		if (session && session.input.form !== null && event.target === session.input.form) {
			cancel('target-gone');
		}
	}

	function onReset(event: Event): void {
		if (!session || event.target !== session.input.form) return;
		// The values are reset after this event; a task later the field shows the result.
		later(
			(s) => {
				if (!matchesOpen(s)) cancel('target-changed');
			},
			(run) => setTimeout(run, 0)
		);
	}

	// A derived, so the listeners are torn down only when the VALUE flips - not whenever the
	// parent hands the same `enabled` again (that would cancel open keys as 'disabled').
	const active = $derived(enabled);

	$effect(() => {
		if (!active) return;
		// Native listeners: Svelte's delegated ones run too late to stop a key before the field sees it.
		const add = <E extends Event>(
			target: Document | Window,
			type: string,
			fn: (event: E) => void,
			capture: boolean
		): (() => void) => {
			const listener = fn as (event: Event) => void;
			target.addEventListener(type, listener, capture);
			return () => target.removeEventListener(type, listener, capture);
		};
		const offs = [
			add(document, 'pointerdown', onPointerdown, true),
			add(document, 'click', onClick, true),
			add(document, 'focusin', onFocusin, true),
			add(window, 'keydown', onKeydownCapture, true),
			add(window, 'keydown', onKeydown, false),
			add(window, 'keyup', onKeyup, true),
			add(document, 'beforeinput', onBeforeinput, true),
			add(document, 'focusout', onFocusout, true),
			add(document, 'submit', onSubmit, true),
			add(document, 'reset', onReset, true),
			// §6.5: the field's options were attached again while open - check right after.
			// (Called from inside the attachment's own effect: read nothing reactive there.)
			onAttach((el) =>
				untrack(() => {
					if (!session || el !== session.input) return;
					later(
						(s) => {
							if (!matchesOpen(s)) cancel('target-changed');
						},
						(run) => queueMicrotask(run)
					);
				})
			)
		];
		return () => {
			for (const off of offs) off();
			swallowEnterRepeat = false;
			closeClickWindow();
			untrack(() => cancel('disabled'));
			restoreOsKeyboard();
		};
	});

	// The field went away / became readonly / disabled / changed type, or its layer is closing.
	$effect(() => {
		const s = session;
		if (!s || typeof MutationObserver === 'undefined') return;
		const observer = new MutationObserver(() => {
			if (session === s && !isLive(s)) cancel('target-gone');
		});
		observer.observe(document.documentElement, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['disabled', 'readonly', 'type', 'inert', 'data-layer-inactive']
		});
		return () => observer.disconnect();
	});

	// ------------------------------------------------------------ the surface

	const INSET_VAR = '--banto-touch-keys-inset-bottom';

	/** Shows the popover, wires the catch surface and publishes the bottom inset (§7.1, §7.2.1, §7.5). */
	function surface(el: HTMLElement): () => void {
		const s = untrack(() => session);
		type Popover = HTMLElement & { showPopover?: () => void; hidePopover?: () => void };
		(el as Popover).showPopover?.();

		const keepFocus = (event: Event): void => event.preventDefault();
		const onSurfaceClick = (event: MouseEvent): void => {
			if (event.target !== el) return; // a key or the keypad itself
			// Only another keypad field gets this tap; everything else underneath gets nothing.
			const below =
				typeof document.elementsFromPoint === 'function'
					? document.elementsFromPoint(event.clientX, event.clientY).find((e) => !el.contains(e))
					: undefined;
			const next = below && below !== session?.input ? resolveTarget(below, resolve) : null;
			cancel('outside');
			if (next) open(next);
		};
		el.addEventListener('pointerdown', keepFocus);
		el.addEventListener('mousedown', keepFocus);
		el.addEventListener('contextmenu', keepFocus);
		el.addEventListener('click', onSurfaceClick);

		const root = document.documentElement;
		const panel = el.firstElementChild;
		const publish = (): void => {
			if (s?.placement === 'bottom' && panel) {
				root.style.setProperty(INSET_VAR, `${Math.round(panel.getBoundingClientRect().height)}px`);
			}
		};
		publish();
		const resize =
			s?.placement === 'bottom' && panel && typeof ResizeObserver !== 'undefined'
				? new ResizeObserver(publish)
				: null;
		if (panel) resize?.observe(panel);
		s?.input.scrollIntoView?.({ block: 'nearest' });

		return () => {
			resize?.disconnect();
			root.style.removeProperty(INSET_VAR);
			try {
				(el as Popover).hidePopover?.();
			} catch {
				// Already out of the top layer.
			}
		};
	}
</script>

{#if session}
	{#key session.id}
		<div
			class="surface"
			class:bottom={session.placement === 'bottom'}
			popover="manual"
			data-esc-layer
			data-touch-keys-surface={session.placement}
			{@attach surface}
		>
			<div class="panel">
				{#snippet keysNote(text: string | null)}
					{@render noteLine?.({ input: session!.input, draft: text })}
				{/snippet}
				{#if session.target.kind === 'text'}
					<!-- masked: the keyboard neither reads nor writes `draft`; only its length comes out (§5.5) -->
					<TextKeyboard
						bind:draft
						maxLength={session.target.rules.maxLength}
						minLength={session.target.rules.minLength}
						required={session.target.rules.required}
						{rejected}
						layouts={session.target.layouts ?? layouts}
						initialLayout={session.target.initialLayout}
						masked={session.target.masked}
						label={session.target.label}
						{messages}
						note={noteLine ? keysNote : undefined}
						onedit={({ length, cleared }) => {
							rejected = false;
							if (session && isMasked(session.target)) maskedPending = length > 0 || cleared;
						}}
						onconfirm={confirmText}
						oncancel={() => cancel('cancel-key')}
					/>
				{:else}
					<NumberKeypad
						bind:draft
						rules={session.target.rules}
						label={session.target.label}
						{messages}
						note={noteLine ? keysNote : undefined}
						onconfirm={confirm}
						oncancel={() => cancel('cancel-key')}
					/>
				{/if}
			</div>
		</div>
	{/key}
{/if}

<style>
	/*
	 * The popover element IS the catch surface: full viewport, pointer-events on, so a tap
	 * outside the keys lands here and never on the page underneath (§7.2.1). `::backdrop`
	 * is not used - a popover's backdrop lets pointers through.
	 */
	.surface {
		position: fixed;
		inset: 0;
		width: 100%;
		height: 100%;
		max-width: none;
		max-height: none;
		margin: 0;
		padding: var(--banto-space-3);
		border: 0;
		box-sizing: border-box;
		background: var(--banto-scrim);
		color: var(--banto-text);
		overflow: hidden;
		touch-action: none;
		align-items: center;
		justify-content: center;
	}
	.surface:popover-open {
		display: flex;
	}
	.surface.bottom {
		padding: 0;
		background: transparent;
		align-items: flex-end;
	}
	.panel {
		display: flex;
		max-width: 100%;
		max-height: 100%;
		overflow: auto;
	}
	.surface.bottom .panel {
		width: 100%;
		justify-content: center;
		padding: var(--banto-space-2);
		box-sizing: border-box;
		background: var(--banto-surface-raised);
		border-top: var(--banto-border-width) solid var(--banto-border);
	}
</style>
