// @vitest-environment jsdom
/**
 * `file` type (Issue #714, downstream-requests-2026-11-plan §4.12): the value
 * (the record's files + the chosen ones), the on-screen checks, what is NOT
 * submitted, one field per form, the upload after a create and how BantoForm
 * renders and wires the field in the new and the edit state.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BantoForm from '../src/BantoForm.svelte';
import { createFormStore } from '../src/store.svelte';
import { createFormDraft } from '../src/draft.svelte';
import { submitValuesOf } from '../src/layout';
import { pickFiles, validateAll, validateField } from '../src/validate';
import {
	acceptsFile,
	fileValueOf,
	formatFileSize,
	newPendingFile,
	uploadPendingFiles
} from '../src/fields/file';
import type {
	FieldDef,
	FileFieldClient,
	FileFieldMeta,
	FileFieldValue,
	FormSchema
} from '../src/types';

afterEach(cleanup);

function file(name: string, size = 10, type = 'text/plain'): File {
	return new File([new Uint8Array(size)], name, { type });
}

function meta(id: number, fileName: string, sizeBytes = 10): FileFieldMeta {
	return { id, fileName, sizeBytes };
}

/** A client over an in-memory list; `refuse` makes `upload` reject for a file. */
function fakeClient(initial: FileFieldMeta[] = [], refuse?: (file: File) => string | null) {
	let rows = [...initial];
	let nextId = 100;
	const client = {
		list: vi.fn(async () => [...rows]),
		upload: vi.fn(async (_resource: string, _resourceId: string, f: File) => {
			const reason = refuse?.(f);
			if (reason) throw new Error(reason);
			const row = meta(nextId++, f.name, f.size);
			rows = [...rows, row];
			return row;
		}),
		remove: vi.fn(async (id: number) => {
			rows = rows.filter((row) => row.id !== id);
		})
	} satisfies FileFieldClient;
	return client;
}

function fileDef(client: FileFieldClient, extra: Partial<FieldDef> = {}): FieldDef {
	const { file: config, ...rest } = extra;
	return {
		name: 'files',
		label: '資料',
		type: 'file',
		...rest,
		file: { client, resource: 'items', ...config }
	};
}

const title: FieldDef = { name: 'title', label: '件名', type: 'text' };

function known(pending: File[] = [], existing: FileFieldMeta[] = []): FileFieldValue {
	return { existing, pending: pending.map(newPendingFile) };
}

/** Anything that is a `File`, anywhere inside `value`. */
function filesIn(value: unknown): File[] {
	if (value instanceof File) return [value];
	if (!value || typeof value !== 'object') return [];
	return Object.values(value as object).flatMap(filesIn);
}

describe('value and on-screen validation', () => {
	it('starts with the record’s files not known and nothing chosen', () => {
		const store = createFormStore({ fields: [fileDef(fakeClient())] });
		expect(store.values.files).toEqual({ existing: null, pending: [] });
		expect(store.isDirty).toBe(false);
	});

	it('required: one existing or chosen file is enough; an unknown list is not judged', () => {
		const def = fileDef(fakeClient(), { required: true });
		expect(validateField(def, known(), {})).toBe('必須項目です');
		expect(validateField(def, known([file('a.txt')]), {})).toBeNull();
		expect(validateField(def, known([], [meta(1, 'a.txt')]), {})).toBeNull();
		expect(validateField(def, { existing: null, pending: [] }, {})).toBeNull();
		expect(validateField({ ...def, required: false }, known(), {})).toBeNull();
	});

	it('checks the count, the size and the kind of the chosen files', () => {
		const def = fileDef(fakeClient(), {
			file: {
				client: fakeClient(),
				resource: 'items',
				maxFiles: 2,
				maxFileSize: 1024,
				accept: '.pdf,image/*'
			}
		});
		const pdf = file('a.pdf', 10, 'application/pdf');
		expect(validateField(def, known([pdf]), {})).toBeNull();
		expect(validateField(def, known([pdf, pdf], [meta(1, 'x.pdf')]), {})).toBe(
			'ファイルは2件までです'
		);
		expect(validateField(def, known([file('big.pdf', 1025, 'application/pdf')]), {})).toBe(
			'1 KB以下のファイルを選んでください'
		);
		expect(validateField(def, known([file('memo.txt')]), {})).toBe(
			'この種類のファイルは選べません（.pdf,image/*）'
		);
		expect(
			validateField(def, known([file('memo.txt')]), {}, { fileTypeNotAccepted: () => 'no' })
		).toBe('no');
	});

	it('accept matches an extension, a type family or an exact type', () => {
		expect(acceptsFile(undefined, { name: 'a.bin', type: '' })).toBe(true);
		expect(acceptsFile('.PDF', { name: 'a.pdf', type: '' })).toBe(true);
		expect(acceptsFile('image/*', { name: 'a', type: 'image/png' })).toBe(true);
		expect(acceptsFile('image/*', { name: 'a.png', type: 'text/plain' })).toBe(false);
		expect(acceptsFile('text/csv, .txt', { name: 'a.csv', type: 'text/csv' })).toBe(true);
		expect(acceptsFile('text/csv', { name: 'a.csv', type: 'text/plain' })).toBe(false);
	});

	it('formats sizes in binary steps', () => {
		expect(formatFileSize(0)).toBe('0 B');
		expect(formatFileSize(1023)).toBe('1023 B');
		expect(formatFileSize(1024)).toBe('1 KB');
		expect(formatFileSize(1536)).toBe('1.5 KB');
		expect(formatFileSize(5 * 1024 * 1024)).toBe('5 MB');
	});

	it('a pick takes what fits and refuses the rest with the reason', () => {
		const def = fileDef(fakeClient(), {
			file: { client: fakeClient(), resource: 'items', maxFiles: 2, maxFileSize: 100 }
		});
		const picked = pickFiles(def, known([], [meta(1, 'old.txt')]), [
			file('big.txt', 101),
			file('one.txt'),
			file('two.txt')
		]);
		expect(picked.accepted.map((entry) => entry.file.name)).toEqual(['one.txt']);
		expect(picked.refused.map((entry) => [entry.file.name, entry.message])).toEqual([
			['big.txt', '100 B以下のファイルを選んでください'],
			['two.txt', 'ファイルは2件までです']
		]);
		expect(new Set(picked.accepted.map((entry) => entry.key)).size).toBe(1);
	});
});

describe('what is submitted, and dirty', () => {
	it('never puts the field - or any File - into the submitted values', () => {
		const schema: FormSchema = { fields: [title, fileDef(fakeClient())] };
		const store = createFormStore(schema, { version: 3 });
		store.setValue('title', 'a');
		store.setValue('files', known([file('a.txt')], [meta(1, 'b.txt')]));
		expect(store.submitValues).toEqual({ title: 'a', version: 3 });
		expect(filesIn(store.submitValues)).toEqual([]);
		expect(submitValuesOf(schema, store.values)).toEqual({ title: 'a', version: 3 });
		// The field's value is still in `values`.
		expect(fileValueOf(store.values.files).pending).toHaveLength(1);
	});

	it('chosen files make the form dirty until they are gone; the listed files do not', () => {
		const store = createFormStore({ fields: [title, fileDef(fakeClient())] });
		store.setValue('files', known([], [meta(1, 'b.txt')]));
		expect(store.isDirty).toBe(false);
		store.setValue('files', known([file('a.txt')], [meta(1, 'b.txt')]));
		expect(store.isDirty).toBe(true);
		// Saving the record does not upload anything: still unsaved.
		store.markClean();
		expect(store.isDirty).toBe(true);
		store.setValue('files', known([], [meta(1, 'b.txt'), meta(2, 'a.txt')]));
		expect(store.isDirty).toBe(false);
	});

	it('a field hidden by visibleWhen is not validated, not dirty and sends nothing', async () => {
		const client = fakeClient();
		const schema: FormSchema = {
			fields: [
				{ name: 'attach', label: '添付する', type: 'checkbox' },
				fileDef(client, { required: true, visibleWhen: (values) => values.attach === true })
			]
		};
		const store = createFormStore(schema);
		store.setValue('files', known([file('a.txt')]));
		expect(store.isDirty).toBe(false);
		expect(validateAll(schema, { attach: false, files: known() })).toEqual([]);
		expect(await uploadPendingFiles(schema, store, 7)).toEqual({ uploaded: [], failed: [] });
		expect(client.upload).not.toHaveBeenCalled();
		// The chosen file is kept: showing the field again brings it back.
		store.setValue('attach', true);
		expect(fileValueOf(store.values.files).pending).toHaveLength(1);
		expect(store.isDirty).toBe(true);
	});
});

describe('the injected client', () => {
	it('takes the shape of @banto/attachments\u2019 client as it is (a structural subset)', () => {
		// Copies of `AttachmentMeta` / `AttachmentsClient` (packages/attachments/src/types.ts):
		// forms imports no other package, so the fit is checked against the shape.
		interface AttachmentMeta {
			id: number;
			resource: string;
			resourceId: string;
			fileName: string;
			mime: string;
			sizeBytes: number;
			sha256: string;
			hasThumbnail: boolean;
			createdAt: string;
			createdBy: string | null;
		}
		interface AttachmentsClient {
			list(resource: string, resourceId: string): Promise<AttachmentMeta[]>;
			upload(resource: string, resourceId: string, file: File): Promise<AttachmentMeta>;
			remove(id: number): Promise<void>;
			thumbnailUrl(meta: AttachmentMeta): Promise<string>;
			downloadUrl(meta: AttachmentMeta): Promise<string>;
		}
		const attachments = {} as AttachmentsClient;
		const client: FileFieldClient = attachments;
		expect(client).toBe(attachments);
	});
});

describe('one file field per form', () => {
	it('a second file field is an error when the form is defined', () => {
		const client = fakeClient();
		const schema: FormSchema = {
			fields: [fileDef(client), fileDef(client, { name: 'more', label: 'ほか' })]
		};
		expect(() => createFormStore(schema)).toThrow(/one 'file' field at most.*'files', 'more'/);
	});

	it('a file field without its client is an error too', () => {
		expect(() => createFormStore({ fields: [{ name: 'f', label: 'F', type: 'file' }] })).toThrow(
			/needs `file.client`/
		);
	});

	it('a FormDraft does not take a file field', () => {
		expect(() =>
			createFormDraft({ key: 'k', schema: { fields: [fileDef(fakeClient())] } })
		).toThrow(/FormDraft does not take a 'file' field/);
	});
});

describe('uploadPendingFiles (after the record was created)', () => {
	it('sends the chosen files to the new record one after another', async () => {
		const order: string[] = [];
		const client = fakeClient();
		client.upload.mockImplementation(async (_resource, _id, f: File) => {
			order.push(`start ${f.name}`);
			await Promise.resolve();
			order.push(`end ${f.name}`);
			return meta(order.length, f.name, f.size);
		});
		const schema: FormSchema = { fields: [fileDef(client)] };
		const store = createFormStore(schema);
		store.setValue('files', known([file('a.txt'), file('b.txt')]));
		const outcome = await uploadPendingFiles(schema, store, 42);
		expect(order).toEqual(['start a.txt', 'end a.txt', 'start b.txt', 'end b.txt']);
		expect(client.upload.mock.calls.map(([resource, id]) => [resource, id])).toEqual([
			['items', '42'],
			['items', '42']
		]);
		expect(outcome.uploaded.map((row) => row.fileName)).toEqual(['a.txt', 'b.txt']);
		expect(outcome.failed).toEqual([]);
		const value = fileValueOf(store.values.files);
		expect(value.pending).toEqual([]);
		expect(value.existing?.map((row) => row.fileName)).toEqual(['a.txt', 'b.txt']);
		expect(store.isDirty).toBe(false);
	});

	it('a refused file stays chosen with the client’s own message; the rest still go', async () => {
		// The server is stricter than the screen: the field allows 1 MB, the server 5 bytes.
		const client = fakeClient([], (f) =>
			f.size > 5 ? 'サーバーの上限（5 B）を超えています' : null
		);
		const schema: FormSchema = {
			fields: [fileDef(client, { file: { client, resource: 'items', maxFileSize: 1024 * 1024 } })]
		};
		const store = createFormStore(schema);
		store.setValue('files', known([file('big.txt', 10), file('ok.txt', 3)]));
		expect(store.validateAll()).toBe(true);
		const outcome = await uploadPendingFiles(schema, store, 1);
		expect(outcome.uploaded.map((row) => row.fileName)).toEqual(['ok.txt']);
		expect(outcome.failed.map((entry) => [entry.file.name, entry.error])).toEqual([
			['big.txt', 'サーバーの上限（5 B）を超えています']
		]);
		const value = fileValueOf(store.values.files);
		expect(value.pending.map((entry) => [entry.file.name, entry.error])).toEqual([
			['big.txt', 'サーバーの上限（5 B）を超えています']
		]);
		expect(store.isDirty).toBe(true);
	});

	it('a rejection without a message falls back to the field’s text', async () => {
		const client = fakeClient();
		client.upload.mockRejectedValue({ code: 500 });
		const schema: FormSchema = { fields: [fileDef(client)] };
		const store = createFormStore(schema);
		store.setValue('files', known([file('a.txt')]));
		const outcome = await uploadPendingFiles(schema, store, 1, {
			uploadFailed: () => 'could not upload'
		});
		expect(outcome.failed[0].error).toBe('could not upload');
	});
});

function pick(container: HTMLElement, files: File[]) {
	const input = container.querySelector<HTMLInputElement>('[data-file-input]')!;
	return fireEvent.change(input, { target: { files } });
}

describe('BantoForm: a new record (no parent yet)', () => {
	it('is a named group; the picker button has the field id', () => {
		const schema: FormSchema = {
			fields: [fileDef(fakeClient(), { required: true, help: 'PDF を付ける' })]
		};
		const { container } = render(BantoForm, {
			schema,
			store: createFormStore(schema),
			onSubmit: vi.fn()
		});
		const group = screen.getByRole('group', { name: /資料/ });
		expect(group.getAttribute('aria-describedby')).toMatch(/help-0$/);
		expect(container.querySelector('[id$="-field-0"]')).toBe(
			within(group).getByRole('button', { name: 'ファイルを選択' })
		);
		expect(within(group).getByText('ファイルはありません')).toBeTruthy();
	});

	it('keeps the chosen files in the field, uploads nothing and submits without them', async () => {
		const client = fakeClient();
		const schema: FormSchema = { fields: [title, fileDef(client)] };
		const store = createFormStore(schema);
		const onSubmit = vi.fn();
		const { container } = render(BantoForm, { schema, store, onSubmit });
		await pick(container, [file('a.txt', 2048), file('b.txt')]);
		const rows = within(screen.getByRole('list', { name: '資料のファイル' })).getAllByRole(
			'listitem'
		);
		expect(rows.map((row) => row.dataset.fileState)).toEqual(['pending', 'pending']);
		expect(rows[0].textContent).toContain('a.txt');
		expect(rows[0].textContent).toContain('2 KB');
		expect(screen.getByText('選んだファイルは、保存のあとでアップロードされます')).toBeTruthy();
		expect(store.isDirty).toBe(true);
		// No upload button before the record exists.
		expect(screen.queryByRole('button', { name: /アップロード/ })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'b.txt: 取り消す' }));
		expect(fileValueOf(store.values.files).pending.map((entry) => entry.file.name)).toEqual([
			'a.txt'
		]);

		await fireEvent.submit(container.querySelector('form')!);
		expect(onSubmit).toHaveBeenCalledWith({ title: '' });
		expect(filesIn(onSubmit.mock.calls[0][0])).toEqual([]);
		expect(client.upload).not.toHaveBeenCalled();
		expect(client.list).not.toHaveBeenCalled();
	});

	it('refuses a file the field does not allow and says why', async () => {
		const client = fakeClient();
		const schema: FormSchema = {
			fields: [fileDef(client, { file: { client, resource: 'items', maxFileSize: 100 } })]
		};
		const store = createFormStore(schema, undefined, {
			fileTooLarge: (_def, max) => `too large (max ${max})`
		});
		const { container } = render(BantoForm, { schema, store, onSubmit: vi.fn() });
		await pick(container, [file('big.txt', 101), file('ok.txt')]);
		expect(screen.getByRole('alert').textContent).toBe('big.txt: too large (max 100)');
		expect(fileValueOf(store.values.files).pending.map((entry) => entry.file.name)).toEqual([
			'ok.txt'
		]);
	});

	it('required: submitting with no file shows the error and does not submit', async () => {
		const schema: FormSchema = { fields: [fileDef(fakeClient(), { required: true })] };
		const store = createFormStore(schema);
		const onSubmit = vi.fn();
		const { container } = render(BantoForm, { schema, store, onSubmit });
		await fireEvent.submit(container.querySelector('form')!);
		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText('必須項目です')).toBeTruthy();
		expect(screen.getByRole('group', { name: /資料/ }).getAttribute('aria-describedby')).toMatch(
			/error-0$/
		);
	});

	it('after the create, a refused file is shown with its reason and can be tried again', async () => {
		let strict = true;
		const client = fakeClient([], (f) =>
			strict && f.name === 'b.txt' ? '容量が足りません' : null
		);
		const schema: FormSchema = { fields: [fileDef(client)] };
		const store = createFormStore(schema);
		const view = render(BantoForm, { schema, store, onSubmit: vi.fn() });
		await pick(view.container, [file('a.txt'), file('b.txt')]);
		const outcome = await uploadPendingFiles(schema, store, 9);
		expect(outcome.failed).toHaveLength(1);
		// The app moves the form to the edit state of the record it created.
		await view.rerender({ fileParentId: 9 });
		const failed = await waitFor(() => {
			const row = screen
				.getAllByRole('listitem')
				.find((item) => item.dataset.fileState === 'failed');
			expect(row).toBeTruthy();
			return row!;
		});
		expect(within(failed).getByRole('alert').textContent).toBe('容量が足りません');
		expect(store.isDirty).toBe(true);

		strict = false;
		await fireEvent.click(await screen.findByRole('button', { name: 'b.txt: 再試行' }));
		await waitFor(() => expect(fileValueOf(store.values.files).pending).toEqual([]));
		expect(client.upload).toHaveBeenLastCalledWith('items', '9', expect.any(File));
		expect(store.isDirty).toBe(false);
	});
});

describe('BantoForm: an existing record (fileParentId)', () => {
	function setup(client: ReturnType<typeof fakeClient>, extra: Partial<FieldDef> = {}) {
		const schema: FormSchema = { fields: [fileDef(client, extra)] };
		const store = createFormStore(schema);
		const view = render(BantoForm, { schema, store, onSubmit: vi.fn(), fileParentId: 5 });
		return { store, ...view };
	}

	it('lists the record’s files', async () => {
		const client = fakeClient([meta(1, 'spec.pdf', 2048)]);
		const { store } = setup(client);
		expect(screen.getByRole('status').textContent).toBe('読み込み中…');
		const row = await screen.findByRole('listitem');
		expect(client.list).toHaveBeenCalledWith('items', '5');
		expect(row.dataset.fileState).toBe('existing');
		expect(row.textContent).toContain('spec.pdf');
		expect(fileValueOf(store.values.files).existing).toEqual([meta(1, 'spec.pdf', 2048)]);
		expect(store.isDirty).toBe(false);
	});

	it('uploads a chosen file at once', async () => {
		const client = fakeClient();
		const { store, container } = setup(client);
		await screen.findByText('ファイルはありません');
		await pick(container, [file('a.txt')]);
		await waitFor(() =>
			expect(fileValueOf(store.values.files).existing?.map((row) => row.fileName)).toEqual([
				'a.txt'
			])
		);
		expect(client.upload).toHaveBeenCalledWith('items', '5', expect.any(File));
		expect(fileValueOf(store.values.files).pending).toEqual([]);
		expect(store.isDirty).toBe(false);
	});

	it('shows the server’s rejection as it is, also when the screen allowed the file', async () => {
		const client = fakeClient([], () => 'この形式は受け付けられません');
		const { store, container } = setup(client, {
			file: { client, resource: 'items', accept: '.txt' }
		});
		await screen.findByText('ファイルはありません');
		await pick(container, [file('a.txt')]);
		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toBe('この形式は受け付けられません');
		expect(fileValueOf(store.values.files).pending).toHaveLength(1);
		expect(screen.getByRole('button', { name: 'a.txt: 再試行' })).toBeTruthy();
	});

	it('deletes at once after the confirmation, and not without it', async () => {
		const client = fakeClient([meta(1, 'spec.pdf')]);
		const confirmRemove = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const { store } = setup(client, { file: { client, resource: 'items', confirmRemove } });
		const button = await screen.findByRole('button', { name: 'spec.pdf: 削除' });
		await fireEvent.click(button);
		await waitFor(() => expect(confirmRemove).toHaveBeenCalledTimes(1));
		expect(confirmRemove).toHaveBeenCalledWith('「spec.pdf」を削除しますか？', meta(1, 'spec.pdf'));
		expect(client.remove).not.toHaveBeenCalled();
		await fireEvent.click(button);
		await waitFor(() => expect(fileValueOf(store.values.files).existing).toEqual([]));
		expect(client.remove).toHaveBeenCalledWith(1);
	});

	it('a failed delete keeps the file and shows the rejection', async () => {
		const client = fakeClient([meta(1, 'spec.pdf')]);
		client.remove.mockRejectedValue(new Error('権限がありません'));
		const { store } = setup(client, {
			file: { client, resource: 'items', confirmRemove: () => true }
		});
		await fireEvent.click(await screen.findByRole('button', { name: 'spec.pdf: 削除' }));
		expect((await screen.findByRole('alert')).textContent).toBe('権限がありません');
		expect(fileValueOf(store.values.files).existing).toHaveLength(1);
	});

	it('a list that cannot be fetched: the rejection, a reload, and required is not judged', async () => {
		const client = fakeClient([meta(1, 'spec.pdf')]);
		client.list.mockRejectedValueOnce(new Error('デモでは添付を使えません'));
		const { store } = setup(client, { required: true });
		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain('デモでは添付を使えません');
		expect(screen.getByRole<HTMLButtonElement>('button', { name: 'ファイルを選択' }).disabled).toBe(
			true
		);
		expect(store.validateAll()).toBe(true);
		await fireEvent.click(within(alert).getByRole('button', { name: '再読み込み' }));
		expect((await screen.findByRole('listitem')).textContent).toContain('spec.pdf');
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('takes one file when maxFiles is 1, and no more once the field is full', async () => {
		const client = fakeClient([meta(1, 'spec.pdf')]);
		const { container } = setup(client, { file: { client, resource: 'items', maxFiles: 1 } });
		await screen.findByRole('listitem');
		expect(container.querySelector<HTMLInputElement>('[data-file-input]')!.multiple).toBe(false);
		expect(screen.getByRole<HTMLButtonElement>('button', { name: 'ファイルを選択' }).disabled).toBe(
			true
		);
	});
});

/** A promise settled from outside: an upload that is still on its way. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('an upload that ends after its owner is gone (PR #844 review)', () => {
	/** Files per record; every upload waits until the test settles it. */
	function slowClient(initial: Record<string, FileFieldMeta[]> = {}) {
		const rows: Record<string, FileFieldMeta[]> = { ...initial };
		const waiting: { resourceId: string; done: ReturnType<typeof deferred<FileFieldMeta>> }[] = [];
		const client = {
			list: vi.fn(async (_resource: string, resourceId: string) => [...(rows[resourceId] ?? [])]),
			upload: vi.fn((_resource: string, resourceId: string, _file: File) => {
				const done = deferred<FileFieldMeta>();
				waiting.push({ resourceId, done });
				return done.promise;
			}),
			remove: vi.fn(async () => {})
		} satisfies FileFieldClient;
		/** The server took the file: it is in the record's list, and the upload answers. */
		function arrive(index: number, row: FileFieldMeta) {
			const { resourceId, done } = waiting[index];
			rows[resourceId] = [...(rows[resourceId] ?? []), row];
			done.resolve(row);
		}
		return { client, waiting, arrive };
	}

	it('record A’s upload ending after the switch to B is not written into B’s files', async () => {
		const { client, waiting, arrive } = slowClient({ '6': [meta(60, 'of-b.txt')] });
		const schema: FormSchema = { fields: [fileDef(client)] };
		const store = createFormStore(schema);
		const view = render(BantoForm, { schema, store, onSubmit: vi.fn(), fileParentId: 5 });
		await screen.findByText('ファイルはありません');
		await pick(view.container, [file('of-a.txt')]);
		await waitFor(() => expect(waiting).toHaveLength(1));

		// The app shows record B in the same form.
		store.reset();
		await view.rerender({ fileParentId: 6 });
		await waitFor(() =>
			expect(fileValueOf(store.values.files).existing).toEqual([meta(60, 'of-b.txt')])
		);

		arrive(0, meta(50, 'of-a.txt'));
		await waitFor(() => expect(screen.queryByText('アップロード中…')).toBeNull());
		await Promise.resolve();
		expect(fileValueOf(store.values.files)).toEqual({
			existing: [meta(60, 'of-b.txt')],
			pending: []
		});
		expect(screen.queryByRole('button', { name: 'of-a.txt: 削除' })).toBeNull();
		expect(client.upload).toHaveBeenCalledTimes(1);
	});

	it('the same holds when only the record changes and the value is kept', async () => {
		const { client, waiting, arrive } = slowClient();
		const schema: FormSchema = { fields: [fileDef(client)] };
		const store = createFormStore(schema);
		const view = render(BantoForm, { schema, store, onSubmit: vi.fn(), fileParentId: 5 });
		await screen.findByText('ファイルはありません');
		await pick(view.container, [file('one.txt'), file('two.txt')]);
		await waitFor(() => expect(waiting).toHaveLength(1));

		await view.rerender({ fileParentId: 6 });
		await waitFor(() => expect(client.list).toHaveBeenCalledWith('items', '6'));
		arrive(0, meta(50, 'one.txt'));
		await waitFor(() => expect(screen.queryByText('アップロード中…')).toBeNull());
		await Promise.resolve();

		// Nothing of A is among B's files, and the run did not go on to the next file.
		const value = fileValueOf(store.values.files);
		expect(value.existing).toEqual([]);
		expect(value.pending.map((entry) => [entry.file.name, entry.error])).toEqual([
			['one.txt', undefined],
			['two.txt', undefined]
		]);
		expect(client.upload).toHaveBeenCalledTimes(1);
	});

	it('a refusal of A’s upload is not shown on B either', async () => {
		const { client, waiting } = slowClient();
		const schema: FormSchema = { fields: [fileDef(client)] };
		const store = createFormStore(schema);
		const view = render(BantoForm, { schema, store, onSubmit: vi.fn(), fileParentId: 5 });
		await screen.findByText('ファイルはありません');
		await pick(view.container, [file('one.txt')]);
		await waitFor(() => expect(waiting).toHaveLength(1));

		await view.rerender({ fileParentId: 6 });
		waiting[0].done.reject(new Error('A は閉じられています'));
		await waitFor(() => expect(screen.queryByText('アップロード中…')).toBeNull());
		await Promise.resolve();
		expect(fileValueOf(store.values.files).pending.map((entry) => entry.error)).toEqual([
			undefined
		]);
		expect(screen.queryByText('A は閉じられています')).toBeNull();
	});

	it('uploadPendingFiles: a reset of the store while a file is on its way leaves the reset form alone', async () => {
		const { client, waiting, arrive } = slowClient();
		const schema: FormSchema = { fields: [fileDef(client)] };
		const store = createFormStore(schema);
		store.setValue('files', known([file('a.txt'), file('b.txt')]));
		const run = uploadPendingFiles(schema, store, 9);
		await waitFor(() => expect(waiting).toHaveLength(1));

		// The app clears the form for the next new record.
		store.reset();
		arrive(0, meta(90, 'a.txt'));
		const outcome = await run;
		expect(store.values.files).toEqual({ existing: null, pending: [] });
		// The file did arrive; the one that was reset away was never sent.
		expect(outcome.uploaded).toEqual([meta(90, 'a.txt')]);
		expect(client.upload).toHaveBeenCalledTimes(1);
	});
});

describe('BantoForm: store.reset() (PR #844 review)', () => {
	it('a new record: required is judged again after the reset', async () => {
		const schema: FormSchema = { fields: [fileDef(fakeClient(), { required: true })] };
		const store = createFormStore(schema);
		const onSubmit = vi.fn();
		const { container } = render(BantoForm, { schema, store, onSubmit });
		await pick(container, [file('a.txt')]);
		expect(store.validateAll()).toBe(true);

		store.reset();
		// Known again, and empty - not "unknown", which `required` would not judge.
		await waitFor(() =>
			expect(fileValueOf(store.values.files)).toEqual({ existing: [], pending: [] })
		);
		expect(store.isDirty).toBe(false);
		await fireEvent.submit(container.querySelector('form')!);
		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByText('必須項目です')).toBeTruthy();
	});

	it('an existing record: the files are read again after the reset', async () => {
		const client = fakeClient([meta(1, 'spec.pdf')]);
		const schema: FormSchema = { fields: [fileDef(client, { required: true })] };
		const store = createFormStore(schema);
		render(BantoForm, { schema, store, onSubmit: vi.fn(), fileParentId: 5 });
		await screen.findByRole('listitem');
		expect(client.list).toHaveBeenCalledTimes(1);

		store.reset();
		await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
		expect(client.list).toHaveBeenLastCalledWith('items', '5');
		await waitFor(() =>
			expect(fileValueOf(store.values.files).existing).toEqual([meta(1, 'spec.pdf')])
		);
		expect((await screen.findByRole('listitem')).textContent).toContain('spec.pdf');
		// One read per reset: the answer does not start another.
		await Promise.resolve();
		expect(client.list).toHaveBeenCalledTimes(2);
	});

	it('an existing record: a file on its way during the reset is read back, not lost', async () => {
		const rows = [meta(1, 'spec.pdf')];
		const sent = deferred<FileFieldMeta>();
		const client = {
			list: vi.fn(async () => [...rows]),
			upload: vi.fn(() => sent.promise),
			remove: vi.fn(async () => {})
		} satisfies FileFieldClient;
		const schema: FormSchema = { fields: [fileDef(client)] };
		const store = createFormStore(schema);
		const { container } = render(BantoForm, {
			schema,
			store,
			onSubmit: vi.fn(),
			fileParentId: 5
		});
		await screen.findByRole('listitem');
		await pick(container, [file('new.txt')]);
		await waitFor(() => expect(client.upload).toHaveBeenCalledTimes(1));

		store.reset();
		await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
		rows.push(meta(2, 'new.txt'));
		sent.resolve(meta(2, 'new.txt'));
		await waitFor(() =>
			expect(fileValueOf(store.values.files).existing?.map((row) => row.fileName)).toEqual([
				'spec.pdf',
				'new.txt'
			])
		);
		expect(fileValueOf(store.values.files).pending).toEqual([]);
	});
});
