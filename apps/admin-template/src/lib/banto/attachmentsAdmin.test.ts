import { initBanto, type CredentialRevision, type DataProvider } from '@banto/admin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #714 F2: `uploadAttachment`'s `canSend` is asked AFTER the file's bytes were
 * read and right before the request leaves (`fetch` on the REST path, `invoke`
 * on the Tauri path). A session that changes while the bytes are being read
 * therefore sends nothing - the file never goes out with the next session's
 * credentials.
 */
const setupMock = vi.hoisted(() => ({ mode: 'server' as 'demo' | 'server' | 'tauri' }));
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/banto/setup.js', () => ({
	CSRF_HEADER: { 'X-Banto-Client': 'banto' },
	getBantoMode: () => setupMock.mode
}));
vi.mock('./setup', () => ({
	CSRF_HEADER: { 'X-Banto-Client': 'banto' },
	getBantoMode: () => setupMock.mode
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { UPLOAD_REFUSED_MESSAGE, uploadAttachment } from './attachmentsAdmin';

const meta = { id: 1, fileName: 'a.txt' };

/** A file whose bytes arrive only when `release()` is called. */
function slowFile(): { file: File; release: () => void; reading: Promise<void> } {
	const file = new File(['hello'], 'a.txt', { type: 'text/plain' });
	let release = (): void => {};
	let started = (): void => {};
	const reading = new Promise<void>((resolve) => (started = resolve));
	const gate = new Promise<void>((resolve) => (release = resolve));
	const read = file.arrayBuffer.bind(file);
	file.arrayBuffer = async () => {
		started();
		await gate;
		return read();
	};
	return { file, release, reading };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	initBanto({
		dataProvider: {} as DataProvider,
		authProvider: {
			login: async () => ({ success: true }),
			logout: async () => {},
			resolve: async () => ({
				status: 'none',
				checked: '0.0' as CredentialRevision,
				current: '0.0' as CredentialRevision
			}),
			credentialRevision: () => '0.0' as CredentialRevision,
			onCredentialChanged: () => () => {}
		},
		resources: []
	});
	fetchMock = vi.fn(async () => new Response(JSON.stringify(meta), { status: 200 }));
	vi.stubGlobal('fetch', fetchMock);
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(meta);
});

afterEach(() => {
	vi.unstubAllGlobals();
	setupMock.mode = 'server';
});

describe.each(['server', 'tauri'] as const)('uploadAttachment canSend (%s)', (mode) => {
	const sent = (): number =>
		mode === 'tauri' ? invokeMock.mock.calls.length : fetchMock.mock.calls.length;

	beforeEach(() => {
		setupMock.mode = mode;
	});

	it('sends when the session is still live after the bytes were read', async () => {
		const canSend = vi.fn(() => true);
		await expect(
			uploadAttachment('items', '7', new File(['x'], 'a.txt'), { canSend })
		).resolves.toEqual(meta);
		expect(canSend).toHaveBeenCalled();
		expect(sent()).toBe(1);
	});

	it('sends without options (the attachments panel)', async () => {
		await expect(uploadAttachment('items', '7', new File(['x'], 'a.txt'))).resolves.toEqual(meta);
		expect(sent()).toBe(1);
	});

	it('refuses, sending nothing, when the session changed while the bytes were read', async () => {
		let live = true;
		const { file, release, reading } = slowFile();
		const upload = uploadAttachment('items', '7', file, { canSend: () => live });
		await reading;
		// Logout / another login while the file is still being read.
		live = false;
		release();
		await expect(upload).rejects.toMatchObject({ body: { message: UPLOAD_REFUSED_MESSAGE } });
		expect(sent()).toBe(0);
	});

	it('asks only after the bytes were read (not before)', async () => {
		const canSend = vi.fn(() => true);
		const { file, release, reading } = slowFile();
		const upload = uploadAttachment('items', '7', file, { canSend });
		await reading;
		expect(canSend).not.toHaveBeenCalled();
		release();
		await upload;
		expect(canSend).toHaveBeenCalledTimes(1);
		expect(sent()).toBe(1);
	});
});
