// @vitest-environment jsdom
/**
 * `type: 'reference'` (Issue #714): defaults, validation, draft, and the
 * combobox - keys, pointer, the value / name split, and the asynchronous
 * parts (debounce, a stale answer, abort, resolve failing).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import BantoForm from '../src/BantoForm.svelte';
import ReferenceField from '../src/fields/ReferenceField.svelte';
import { REFERENCE_SEARCH_DEBOUNCE_MS } from '../src/fields/reference';
import { createFormDraft } from '../src/draft.svelte';
import { createFormStore } from '../src/store.svelte';
import { validateField } from '../src/validate';
import type { FieldDef, FormSchema, ReferenceOption } from '../src/types';

type PopoverElement = HTMLElement & { showPopover(): void; hidePopover(): void };

beforeAll(() => {
	const proto = HTMLElement.prototype as unknown as PopoverElement;
	proto.showPopover = function (this: HTMLElement) {
		this.dataset.popoverOpen = 'true';
		this.style.display = 'block';
	};
	proto.hidePopover = function (this: HTMLElement) {
		delete this.dataset.popoverOpen;
	};
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const people: ReferenceOption[] = [
	{ value: 1, label: '青木', description: '営業' },
	{ value: 2, label: '青山' },
	{ value: '2', label: '文字の 2' },
	{ value: 4, label: '井上' }
];

const searchPeople = async (query: string) =>
	people.filter((person) => person.label.includes(query));
const resolvePerson = async (value: string | number) =>
	people.find((person) => person.value === value) ?? null;

const owner: FieldDef = {
	name: 'owner',
	label: '担当者',
	type: 'reference',
	search: searchPeople,
	resolve: resolvePerson
};

/** Let pending promise callbacks and effects run (real timers). */
async function settled(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const box = () => screen.getByRole('combobox') as HTMLInputElement;
const optionTexts = () => screen.queryAllByRole('option').map((el) => el.textContent?.trim());
const status = () => document.querySelector('[data-reference-status]')?.textContent ?? '';

interface FieldProps {
	def?: FieldDef;
	value?: unknown;
	debounceMs?: number;
	disabled?: boolean;
	messages?: Record<string, unknown>;
}

function renderField(props: FieldProps = {}) {
	const onInput = vi.fn();
	const onBlur = vi.fn();
	const result = render(ReferenceField, {
		def: owner,
		value: null,
		debounceMs: 0,
		onInput,
		onBlur,
		...props
	});
	return { ...result, onInput, onBlur };
}

async function type(text: string): Promise<void> {
	await fireEvent.input(box(), { target: { value: text } });
	await settled();
}

describe('defaults, validation and draft', () => {
	const required: FieldDef = { ...owner, required: true };

	it('starts at null in the store and the draft', () => {
		expect(createFormStore({ fields: [owner] }).values).toEqual({ owner: null });
		expect(createFormDraft({ key: 'k', schema: { fields: [owner] } }).values).toEqual({
			owner: null
		});
	});

	it('required means "has a value"; 0 is a value', () => {
		expect(validateField(required, null, {})).toBe('必須項目です');
		expect(validateField(required, '', {})).toBe('必須項目です');
		expect(validateField(required, 0, {})).toBeNull();
		expect(validateField(required, 'a1', {})).toBeNull();
	});

	it('draft: typed text never becomes the value; blank text clears it', () => {
		const draft = createFormDraft({ key: 'k', schema: { fields: [owner] }, initial: { owner: 2 } });
		draft.setRaw('owner', '青');
		expect(draft.commit('owner')).toBe(true);
		expect(draft.values.owner).toBe(2);
		draft.setRaw('owner', '  ');
		expect(draft.commitAll()).toBe(true);
		expect(draft.values.owner).toBeNull();
		draft.setValue('owner', '2');
		expect(draft.values.owner).toBe('2');
	});
});

describe('ReferenceField: combobox', () => {
	it('is a closed combobox with list autocomplete', () => {
		renderField();
		const input = box();
		expect(input.getAttribute('aria-autocomplete')).toBe('list');
		expect(input.getAttribute('aria-expanded')).toBe('false');
		expect(input.hasAttribute('aria-controls')).toBe(false);
		expect(input.hasAttribute('aria-activedescendant')).toBe(false);
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('typing opens the list; arrows move the active option; Enter picks it', async () => {
		const { onInput } = renderField();
		await type('青');
		const input = box();
		const list = screen.getByRole('listbox', { name: '担当者の候補' });
		expect(input.getAttribute('aria-expanded')).toBe('true');
		expect(input.getAttribute('aria-controls')).toBe(list.id);
		expect(optionTexts()).toEqual(['青木 営業', '青山']);
		// Nothing is active until the user moves: Enter would not pick.
		expect(input.hasAttribute('aria-activedescendant')).toBe(false);

		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		const options = screen.getAllByRole('option');
		expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id);
		expect(options.map((el) => el.getAttribute('aria-selected'))).toEqual(['false', 'true']);
		// No wrap at the end, back up with ArrowUp.
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id);
		await fireEvent.keyDown(input, { key: 'ArrowUp' });
		expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id);

		const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		input.dispatchEvent(enter);
		flushSync();
		expect(enter.defaultPrevented).toBe(true);
		expect(onInput).toHaveBeenCalledExactlyOnceWith(1);
		expect(input.value).toBe('青木');
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('keeps the type of the picked value (2 and "2" differ)', async () => {
		const { onInput } = renderField();
		await type('2');
		await fireEvent.keyDown(box(), { key: 'ArrowDown' });
		await fireEvent.keyDown(box(), { key: 'Enter' });
		expect(onInput).toHaveBeenCalledExactlyOnceWith('2');
	});

	it('ArrowDown on a closed box browses everything', async () => {
		renderField();
		await fireEvent.keyDown(box(), { key: 'ArrowDown' });
		await settled();
		expect(optionTexts()).toHaveLength(4);
		await fireEvent.keyDown(box(), { key: 'ArrowUp', altKey: true });
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('Esc closes the list and keeps the text; a second Esc puts the name back', async () => {
		const { onInput } = renderField({ value: 2 });
		await settled();
		expect(box().value).toBe('青山');
		await type('井');
		const first = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		box().dispatchEvent(first);
		flushSync();
		expect(first.defaultPrevented).toBe(true);
		expect(screen.queryByRole('listbox')).toBeNull();
		expect(box().value).toBe('井');

		const second = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		box().dispatchEvent(second);
		flushSync();
		expect(second.defaultPrevented).toBe(true);
		expect(box().value).toBe('青山');

		// Nothing left to undo: the next Esc is the surrounding layer's.
		const third = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		box().dispatchEvent(third);
		expect(third.defaultPrevented).toBe(false);
		expect(onInput).not.toHaveBeenCalled();
	});

	it('leaving with typed text does not pick: the name of the value comes back', async () => {
		const { onInput, onBlur } = renderField({ value: 2 });
		await settled();
		await type('井');
		await fireEvent.keyDown(box(), { key: 'ArrowDown' });
		// Tab does not pick the active option; the blur that follows settles.
		await fireEvent.keyDown(box(), { key: 'Tab' });
		await fireEvent.blur(box());
		expect(onInput).not.toHaveBeenCalled();
		expect(onBlur).toHaveBeenCalledOnce();
		expect(box().value).toBe('青山');
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('leaving with the box emptied sets null', async () => {
		const { onInput } = renderField({ value: 2 });
		await settled();
		await type('');
		await fireEvent.blur(box());
		expect(onInput).toHaveBeenCalledExactlyOnceWith(null);
	});

	it('typed text with no value is dropped on leaving', async () => {
		const { onInput } = renderField();
		await type('青');
		await fireEvent.blur(box());
		expect(onInput).not.toHaveBeenCalled();
		expect(box().value).toBe('');
	});

	it('a press on an option does not take focus away, and the click picks it', async () => {
		const { onInput } = renderField();
		await type('青');
		const option = screen.getAllByRole('option')[1];
		const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		option.dispatchEvent(down);
		expect(down.defaultPrevented).toBe(true);
		await fireEvent.pointerMove(option);
		expect(box().getAttribute('aria-activedescendant')).toBe(option.id);
		await fireEvent.click(option);
		expect(onInput).toHaveBeenCalledExactlyOnceWith(2);
		expect(box().value).toBe('青山');
	});

	it('does not open while disabled or readonly', async () => {
		const { onInput } = renderField({ def: { ...owner, readonly: true }, value: 2 });
		await settled();
		await fireEvent.keyDown(box(), { key: 'ArrowDown' });
		await type('井');
		expect(screen.queryByRole('listbox')).toBeNull();
		await fireEvent.blur(box());
		expect(onInput).not.toHaveBeenCalled();
	});
});

describe('ReferenceField: asynchronous search', () => {
	it('waits for the debounce and searches once for the last text', async () => {
		vi.useFakeTimers();
		const search = vi.fn(searchPeople);
		renderField({ def: { ...owner, search }, debounceMs: undefined });
		await fireEvent.input(box(), { target: { value: '青' } });
		await vi.advanceTimersByTimeAsync(REFERENCE_SEARCH_DEBOUNCE_MS - 1);
		await fireEvent.input(box(), { target: { value: '青山' } });
		await vi.advanceTimersByTimeAsync(REFERENCE_SEARCH_DEBOUNCE_MS - 1);
		expect(search).not.toHaveBeenCalled();
		expect(status()).toBe('検索中…');
		await vi.advanceTimersByTimeAsync(1);
		flushSync();
		expect(search).toHaveBeenCalledExactlyOnceWith('青山', expect.any(AbortSignal));
		expect(optionTexts()).toEqual(['青山']);
		expect(status()).toBe('1 件の候補');
	});

	it('aborts the older search, and its late answer does not replace the newer one', async () => {
		const calls: {
			query: string;
			signal: AbortSignal;
			answer: ReturnType<typeof deferred<ReferenceOption[]>>;
		}[] = [];
		const search = (query: string, signal: AbortSignal) => {
			const answer = deferred<ReferenceOption[]>();
			calls.push({ query, signal, answer });
			return answer.promise;
		};
		renderField({ def: { ...owner, search } });
		await type('青');
		await type('井');
		expect(calls.map((call) => call.query)).toEqual(['青', '井']);
		expect(calls[0].signal.aborted).toBe(true);
		expect(calls[1].signal.aborted).toBe(false);

		calls[1].answer.resolve([people[3]]);
		await settled();
		expect(optionTexts()).toEqual(['井上']);
		// The first search ignored its signal and answers last.
		calls[0].answer.resolve([people[0], people[1]]);
		await settled();
		expect(optionTexts()).toEqual(['井上']);
		expect(status()).toBe('1 件の候補');
	});

	describe('a changed search word retires the options of the old one (#762 review)', () => {
		/** A's answer is on screen; B is typed and still unanswered. */
		async function typedBOverA() {
			vi.useFakeTimers();
			const answers: Record<string, ReturnType<typeof deferred<ReferenceOption[]>>> = {};
			const search = (query: string) => {
				answers[query] = deferred<ReferenceOption[]>();
				return answers[query].promise;
			};
			const view = renderField({ def: { ...owner, search }, debounceMs: 100 });
			await fireEvent.input(box(), { target: { value: 'A' } });
			await vi.advanceTimersByTimeAsync(100);
			answers.A.resolve([people[0], people[1]]);
			await vi.advanceTimersByTimeAsync(0);
			flushSync();
			expect(optionTexts()).toEqual(['青木 営業', '青山']);
			await fireEvent.input(box(), { target: { value: 'B' } });
			flushSync();
			return { ...view, answers };
		}

		afterEach(() => vi.useRealTimers());

		it('ArrowDown then Enter right after typing picks nothing', async () => {
			const { onInput } = await typedBOverA();
			expect(optionTexts()).toEqual([]);
			await fireEvent.keyDown(box(), { key: 'ArrowDown' });
			await fireEvent.keyDown(box(), { key: 'Enter' });
			expect(onInput).not.toHaveBeenCalled();
		});

		it('the new answer can be picked', async () => {
			const { onInput, answers } = await typedBOverA();
			await vi.advanceTimersByTimeAsync(100);
			answers.B.resolve([people[3]]);
			await vi.advanceTimersByTimeAsync(0);
			flushSync();
			expect(optionTexts()).toEqual(['井上']);
			await fireEvent.keyDown(box(), { key: 'ArrowDown' });
			await fireEvent.keyDown(box(), { key: 'Enter' });
			expect(onInput).toHaveBeenCalledWith(people[3].value);
		});

		it('the mouse cannot pick an old option either', async () => {
			const { onInput } = await typedBOverA();
			expect(screen.queryAllByRole('option')).toHaveLength(0);
			expect(onInput).not.toHaveBeenCalled();
		});

		it('a composition in progress outdates the search for the text before it', async () => {
			const { answers } = await typedBOverA();
			await vi.advanceTimersByTimeAsync(100);
			// B is under way; the user keeps composing: its answer must not show.
			await fireEvent.input(box(), { target: { value: 'Bあ' }, isComposing: true });
			answers.B.resolve([people[3]]);
			await vi.advanceTimersByTimeAsync(0);
			flushSync();
			expect(optionTexts()).toEqual([]);
		});
	});

	it('a late failure of an older search is not shown either', async () => {
		const answers = [deferred<ReferenceOption[]>(), deferred<ReferenceOption[]>()];
		let call = 0;
		renderField({ def: { ...owner, search: () => answers[call++].promise } });
		await type('青');
		await type('井');
		answers[1].resolve([people[3]]);
		await settled();
		answers[0].reject(new Error('old'));
		await settled();
		expect(optionTexts()).toEqual(['井上']);
	});

	it('closing aborts the search under way and drops its answer', async () => {
		const answer = deferred<ReferenceOption[]>();
		let seen: AbortSignal | undefined;
		renderField({
			def: {
				...owner,
				search: (_query, signal) => {
					seen = signal;
					return answer.promise;
				}
			}
		});
		await type('青');
		await fireEvent.keyDown(box(), { key: 'Escape' });
		expect(seen?.aborted).toBe(true);
		expect(document.querySelector('[data-reference-list]')).toBeNull();
		answer.resolve(people);
		await settled();
		expect(document.querySelector('[data-reference-list]')).toBeNull();
	});

	it('says that nothing was found', async () => {
		renderField();
		await type('zzz');
		expect(optionTexts()).toEqual([]);
		expect(status()).toBe('該当する候補がありません');
		expect(document.querySelector('[data-reference-list]')?.textContent).toContain(
			'該当する候補がありません'
		);
		// No listbox without options: the panel only carries the message.
		expect(screen.queryByRole('listbox')).toBeNull();
		expect(box().getAttribute('aria-expanded')).toBe('false');
		expect(box().hasAttribute('aria-controls')).toBe(false);
	});

	it('shows a failed search with the message the app gave', async () => {
		const cause = new Error('offline');
		const searchFailed = vi.fn(() => '検索できません（オフライン）');
		renderField({
			def: { ...owner, search: () => Promise.reject(cause) },
			messages: { searchFailed }
		});
		await type('青');
		expect(searchFailed).toHaveBeenCalledWith(cause);
		expect(status()).toBe('検索できません（オフライン）');
		expect(optionTexts()).toEqual([]);
	});

	it('a search that throws synchronously is a failure too', async () => {
		renderField({
			def: {
				...owner,
				search: () => {
					throw new Error('sync');
				}
			}
		});
		await type('青');
		expect(status()).toBe('候補を取得できませんでした');
	});
});

describe('ReferenceField: the name of a stored value', () => {
	it('resolves the initial value, and a value set from outside', async () => {
		const resolve = vi.fn(resolvePerson);
		const { rerender } = renderField({ def: { ...owner, resolve }, value: 4 });
		// Until the name arrives the value itself is shown.
		expect(box().value).toBe('4');
		await settled();
		expect(box().value).toBe('井上');
		await rerender({ value: 1 });
		await settled();
		expect(box().value).toBe('青木');
		await rerender({ value: null });
		expect(box().value).toBe('');
		expect(resolve).toHaveBeenCalledTimes(2);
	});

	it('shows the value itself when there is no such record or resolve fails', async () => {
		renderField({ def: { ...owner, resolve: async () => null }, value: 99 });
		await settled();
		expect(box().value).toBe('99');
		cleanup();
		renderField({ def: { ...owner, resolve: () => Promise.reject(new Error('x')) }, value: 'k-7' });
		await settled();
		expect(box().value).toBe('k-7');
	});

	it('drops the name of a value that changed while it was being resolved', async () => {
		const answers = new Map<unknown, ReturnType<typeof deferred<ReferenceOption | null>>>();
		const signals = new Map<unknown, AbortSignal>();
		const resolve = (value: string | number, signal: AbortSignal) => {
			const answer = deferred<ReferenceOption | null>();
			answers.set(value, answer);
			signals.set(value, signal);
			return answer.promise;
		};
		const { rerender } = renderField({ def: { ...owner, resolve }, value: 1 });
		await rerender({ value: 4 });
		expect(signals.get(1)?.aborted).toBe(true);
		answers.get(4)?.resolve(people[3]);
		await settled();
		answers.get(1)?.resolve(people[0]);
		await settled();
		expect(box().value).toBe('井上');
	});

	it('a pick wins over the name still being resolved for the previous value (#762 review)', async () => {
		const pending = deferred<ReferenceOption | null>();
		let signal: AbortSignal | undefined;
		const resolve = (_value: string | number, s: AbortSignal) => {
			signal = s;
			return pending.promise;
		};
		const schema = { fields: [{ ...owner, resolve }] };
		const store = createFormStore(schema, { owner: 4 });
		render(BantoForm, { schema, store, onSubmit: vi.fn() });
		vi.useFakeTimers();
		await fireEvent.input(box(), { target: { value: '青' } });
		await vi.advanceTimersByTimeAsync(REFERENCE_SEARCH_DEBOUNCE_MS);
		flushSync();
		await fireEvent.keyDown(box(), { key: 'ArrowDown' });
		await fireEvent.keyDown(box(), { key: 'Enter' });
		expect(store.values.owner).toBe(1);
		expect(signal?.aborted).toBe(true);
		// The old name arrives late: it must not replace the picked one.
		pending.resolve(people[3]);
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
		expect(box().value).toBe('青木');
	});

	it('does not resolve what was just picked', async () => {
		const resolve = vi.fn(resolvePerson);
		const store = createFormStore({ fields: [{ ...owner, resolve }] });
		render(BantoForm, {
			schema: { fields: [{ ...owner, resolve }] },
			store,
			onSubmit: vi.fn()
		});
		vi.useFakeTimers();
		await fireEvent.input(box(), { target: { value: '青' } });
		await vi.advanceTimersByTimeAsync(REFERENCE_SEARCH_DEBOUNCE_MS);
		flushSync();
		await fireEvent.keyDown(box(), { key: 'ArrowDown' });
		await fireEvent.keyDown(box(), { key: 'Enter' });
		expect(store.values.owner).toBe(1);
		expect(box().value).toBe('青木');
		expect(resolve).not.toHaveBeenCalled();
	});
});

describe('BantoForm: reference', () => {
	const schema: FormSchema = {
		fields: [{ ...owner, required: true, help: '名前で検索する。' }]
	};

	it('labels the combobox, describes it with the help, and submits the id', async () => {
		const store = createFormStore(schema);
		const onSubmit = vi.fn();
		const { container } = render(BantoForm, {
			schema,
			store,
			onSubmit,
			referenceMessages: { noResults: (query: string) => `「${query}」は見つかりません` }
		});
		const input = screen.getByRole('combobox', { name: /担当者/ });
		expect(input.getAttribute('aria-describedby')).toBe(
			container.querySelector('.help')?.getAttribute('id')
		);

		// Required: nothing chosen is an error, typed text alone too.
		await fireEvent.submit(container.querySelector('form')!);
		expect(store.errors.owner).toBe('必須項目です');
		expect(onSubmit).not.toHaveBeenCalled();

		vi.useFakeTimers();
		await fireEvent.input(input, { target: { value: 'zzz' } });
		await vi.advanceTimersByTimeAsync(REFERENCE_SEARCH_DEBOUNCE_MS);
		flushSync();
		expect(status()).toBe('「zzz」は見つかりません');

		await fireEvent.input(input, { target: { value: '青山' } });
		await vi.advanceTimersByTimeAsync(REFERENCE_SEARCH_DEBOUNCE_MS);
		flushSync();
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(onSubmit).not.toHaveBeenCalled();
		expect(store.values.owner).toBe(2);

		await fireEvent.submit(container.querySelector('form')!);
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ owner: 2 });
	});

	it('Enter on the closed, emptied box clears the value before the form submits', async () => {
		const optional: FormSchema = { fields: [owner] };
		const store = createFormStore(optional, { owner: 2 });
		render(BantoForm, { schema: optional, store, onSubmit: vi.fn() });
		await settled();
		expect(box().value).toBe('青山');
		await fireEvent.input(box(), { target: { value: '' } });
		await fireEvent.keyDown(box(), { key: 'Escape' });
		const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		box().dispatchEvent(enter);
		expect(enter.defaultPrevented).toBe(false);
		expect(store.values.owner).toBeNull();
	});

	it('underline: the label is a sibling, not a wrapper of the list', () => {
		const store = createFormStore(schema);
		const { container } = render(BantoForm, {
			schema,
			store,
			onSubmit: vi.fn(),
			appearance: 'underline'
		});
		const input = screen.getByRole('combobox', { name: /担当者/ });
		expect(input.classList.contains('banto-field-control')).toBe(true);
		expect(input.closest('label')).toBeNull();
		expect(input.parentElement?.classList.contains('banto-field--stacked')).toBe(true);
		expect(container.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
	});
});
