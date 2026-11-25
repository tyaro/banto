<script lang="ts">
	/**
	 * Browser fixture page (touch-keypad-design §14.3): the smallest screen that shows
	 * what jsdom cannot - hit testing, the top layer, real focus and the browser's own
	 * number validation. Not wired into the template; served only by this folder's vite config.
	 *
	 * The theme CSS and the real `Modal` come from the sibling packages by RELATIVE path:
	 * the package keeps no dependency on them (`src/` never imports them, conventions §4).
	 *
	 * Everything the tests assert on is appended to `window.__log`.
	 */
	import '../../../theme/src/css/banto.css';
	import Modal from '../../../ui/src/Modal.svelte';
	import { TouchKeysHost, touchKeys, type TouchKeysPlacement } from '../../src/index';

	const params = new URLSearchParams(location.search);
	const placement: TouchKeysPlacement = params.get('placement') === 'bottom' ? 'bottom' : 'popup';
	const textPlacement: TouchKeysPlacement = params.get('text') === 'popup' ? 'popup' : 'bottom';

	const log: string[] = [];
	(window as unknown as { __log: string[] }).__log = log;
	const idOf = (target: EventTarget | null): string =>
		target instanceof HTMLElement ? target.id : '';

	let qty = $state<number | string>(12);
	let memo = $state('abc');
	let modalOpen = $state(false);

	$effect(() => {
		const record = (event: Event): void => {
			log.push(`${event.type === 'focusout' ? 'blur' : event.type}:${idOf(event.target)}`);
		};
		const types = ['input', 'change', 'focusout'];
		for (const type of types) document.addEventListener(type, record, true);
		return () => {
			for (const type of types) document.removeEventListener(type, record, true);
		};
	});

	function submit(event: SubmitEvent, fieldId: string): void {
		event.preventDefault();
		const field = document.getElementById(fieldId) as HTMLInputElement;
		log.push(`submit:${idOf(event.target)}=${field.value}`);
	}
</script>

<TouchKeysHost
	enabled
	placement={{ number: placement, text: textPlacement }}
	onopen={(input) => log.push(`open:${input.id}`)}
	onconfirm={({ input, value }) => log.push(`confirm:${input.id}=${value}`)}
	oncancel={({ input, reason }) => log.push(`cancel:${input.id}:${reason}`)}
/>

<main>
	<h1>touch-keys fixture</h1>
	<form id="main" onsubmit={(event) => submit(event, 'qty')}>
		<label for="qty">数量</label>
		<input
			id="qty"
			type="number"
			min="0"
			max="999"
			bind:value={qty}
			{@attach touchKeys({ kind: 'number', editKey: 'row-1' })}
		/>
		<output id="bound">{qty}</output>

		<label for="price">単価</label>
		<input id="price" type="number" min="0.05" step="0.10" value="0.05" />

		<label for="memo">メモ</label>
		<input id="memo" type="text" bind:value={memo} />
		<output id="memo-bound">{memo}</output>

		<label for="code">コード</label>
		<input id="code" type="text" maxlength="4" />

		<label for="kana">カナ</label>
		<input
			id="kana"
			type="text"
			{@attach touchKeys({ kind: 'text', layouts: ['kana', 'alnum'], maxLength: 12 })}
		/>

		<!-- the plain text of this field must never reach the log (onconfirm gets null, §5.5) -->
		<label for="pw">パスワード</label>
		<input id="pw" type="password" autocomplete="off" />

		<!-- the browser's own validity is the authority on what an email field takes (§6.5) -->
		<label for="mail">メール</label>
		<input id="mail" type="email" />

		<button id="save" type="submit">保存</button>
		<button id="open-modal" type="button" onclick={() => (modalOpen = true)}>明細を開く</button>
	</form>
</main>

<Modal open={modalOpen} title="明細" width="320px" onclose={() => (modalOpen = false)}>
	<form id="mform" onsubmit={(event) => submit(event, 'm-qty')}>
		<label for="m-qty">明細の数量</label>
		<input id="m-qty" type="number" min="0" max="99" value="3" />
		<button id="m-save" type="submit">明細を保存</button>
	</form>
</Modal>

<div id="toast" role="status">保存しました</div>

<style>
	main {
		padding: var(--banto-space-4);
	}
	form {
		display: grid;
		gap: var(--banto-space-2);
		max-width: 16rem;
	}
	#toast {
		position: fixed;
		right: var(--banto-space-4);
		bottom: var(--banto-space-4);
		z-index: var(--banto-z-toast);
		padding: var(--banto-space-3);
		background: var(--banto-surface-raised);
		color: var(--banto-text);
		border: var(--banto-border-width) solid var(--banto-border);
	}
</style>
