// @vitest-environment jsdom
/**
 * @banto/ui ConfirmDialog + `createConfirmStore()` / ConfirmHost (Issue #556):
 * the `await confirm()` answers (confirm, Cancel, Esc, ×, a newer question),
 * the alertdialog's name and description, focus on the safe choice and back
 * to the opener, the `danger` look, and `requireText` keeping the confirm
 * button disabled until the text matches. Modal's own contract (layering,
 * trap, motion) is overlay.test.ts's.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConfirmHost, createConfirmStore, defaultUiMessages } from '../src/index';

beforeAll(() => {
	Element.prototype.getClientRects = function (this: Element) {
		return (this.isConnected ? [{}] : []) as unknown as DOMRectList;
	};
	if (!('inert' in HTMLElement.prototype)) {
		Object.defineProperty(HTMLElement.prototype, 'inert', {
			configurable: true,
			get(this: HTMLElement) {
				return this.hasAttribute('inert');
			},
			set(this: HTMLElement, value: boolean) {
				this.toggleAttribute('inert', Boolean(value));
			}
		});
	}
	const style = document.createElement('style');
	style.textContent = '[role="presentation"] { position: fixed; z-index: 900; }';
	document.head.append(style);
});

afterEach(cleanup);

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

function setup() {
	const store = createConfirmStore();
	render(ConfirmHost, { store });
	const opener = document.createElement('button');
	opener.textContent = 'open';
	document.body.append(opener);
	opener.focus();
	return { store, opener };
}

const dialog = () => screen.getByRole('alertdialog');
const confirmButton = (name: string) => screen.getByRole('button', { name });
const cancelButton = () => screen.getByRole('button', { name: defaultUiMessages.confirmCancel() });

describe('createConfirmStore + ConfirmHost', () => {
	it('shows nothing until asked', () => {
		setup();
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});

	it('resolves true on confirm, names and describes the dialog, focuses Cancel and returns focus', async () => {
		const { store, opener } = setup();
		const answer = store.confirm({
			title: 'Delete row',
			message: 'Line 1\nLine 2',
			confirmLabel: 'Delete'
		});
		await flush();
		const node = dialog();
		expect(node.getAttribute('aria-label')).toBe('Delete row');
		expect(node.getAttribute('aria-modal')).toBe('true');
		const describedBy = node.getAttribute('aria-describedby');
		expect(describedBy).toBeTruthy();
		expect(document.getElementById(describedBy!)?.textContent).toBe('Line 1\nLine 2');
		expect(document.activeElement).toBe(cancelButton());

		await fireEvent.click(confirmButton('Delete'));
		await expect(answer).resolves.toBe(true);
		await flush();
		expect(screen.queryByRole('alertdialog')).toBeNull();
		expect(document.activeElement).toBe(opener);
		opener.remove();
	});

	it('resolves false on Cancel, Esc and ×', async () => {
		const { store, opener } = setup();
		const routes: Array<() => Promise<unknown>> = [
			() => fireEvent.click(cancelButton()),
			() => fireEvent.keyDown(window, { key: 'Escape' }),
			() => fireEvent.click(screen.getByRole('button', { name: defaultUiMessages.overlayClose() }))
		];
		for (const route of routes) {
			const answer = store.confirm({ title: 'Ask' });
			await flush();
			await route();
			await expect(answer).resolves.toBe(false);
			await flush();
			expect(store.current).toBeNull();
		}
		opener.remove();
	});

	it('answers an open question false when a newer one is asked, and ignores a stale settle', async () => {
		const { store, opener } = setup();
		const first = store.confirm({ title: 'First' });
		await flush();
		const firstId = store.current!.id;
		const second = store.confirm({ title: 'Second' });
		await expect(first).resolves.toBe(false);
		await flush();
		expect(dialog().getAttribute('aria-label')).toBe('Second');
		store.settle(firstId, true);
		expect(store.current?.title).toBe('Second');
		store.settle(store.current!.id, true);
		await expect(second).resolves.toBe(true);
		opener.remove();
	});

	it('cancel() answers the open question false and closes it; no-op when none is open', async () => {
		const { store, opener } = setup();
		store.cancel();
		const pending = store.confirm({ title: 'Leaving' });
		await flush();
		store.cancel();
		await expect(pending).resolves.toBe(false);
		expect(store.current).toBeNull();
		opener.remove();
	});

	it('uses the default labels, and the danger look on request', async () => {
		const { store, opener } = setup();
		void store.confirm({ title: 'Plain' });
		await flush();
		const ok = confirmButton(defaultUiMessages.confirmOk());
		expect(ok.classList.contains('button--primary')).toBe(true);
		store.settle(store.current!.id, false);
		await flush();
		void store.confirm({ title: 'Danger', danger: true, confirmLabel: 'Remove' });
		await flush();
		expect(confirmButton('Remove').classList.contains('button--danger')).toBe(true);
		opener.remove();
	});
});

describe('ConfirmDialog: requireText', () => {
	it('keeps confirm disabled until the text matches, focuses the text box, Enter confirms', async () => {
		const { store, opener } = setup();
		const answer = store.confirm({
			title: 'Delete user',
			requireText: 'alice',
			confirmLabel: 'Delete'
		});
		await flush();
		const input = screen.getByRole('textbox', {
			name: defaultUiMessages.confirmTypeToConfirm('alice')
		}) as HTMLInputElement;
		expect(document.activeElement).toBe(input);
		const button = confirmButton('Delete') as HTMLButtonElement;
		expect(button.disabled).toBe(true);

		await fireEvent.input(input, { target: { value: 'alic' } });
		expect(button.disabled).toBe(true);
		// A blocked submit (Enter while it does not match) answers nothing.
		await fireEvent.submit(input.form!);
		expect(store.current).not.toBeNull();

		await fireEvent.input(input, { target: { value: 'alice' } });
		expect(button.disabled).toBe(false);
		await fireEvent.submit(input.form!);
		await expect(answer).resolves.toBe(true);
		opener.remove();
	});

	it('starts each question with an empty text box', async () => {
		const { store, opener } = setup();
		void store.confirm({ title: 'One', requireText: 'alice' });
		await flush();
		const input = () => screen.getByRole('textbox') as HTMLInputElement;
		await fireEvent.input(input(), { target: { value: 'alice' } });
		store.settle(store.current!.id, false);
		await flush();
		void store.confirm({ title: 'Two', requireText: 'alice' });
		await flush();
		expect(input().value).toBe('');
		opener.remove();
	});
});
