// @vitest-environment jsdom
/**
 * `canSave` is asked right before a download is saved: when it says no (the
 * session ended while the fetch was in flight), nothing is saved and the
 * object URL is freed.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AttachmentsPanel from '../src/AttachmentsPanel.svelte';
import type { AttachmentMeta, AttachmentsClient } from '../src/types';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const item = {
	id: 1,
	fileName: 'a.txt',
	mimeType: 'text/plain',
	size: 3
} as unknown as AttachmentMeta;

function setup(canSave?: () => boolean) {
	const client: AttachmentsClient = {
		list: async () => [item],
		upload: async () => {
			throw new Error('unused');
		},
		remove: async () => {},
		thumbnailUrl: async () => '',
		downloadUrl: async () => 'blob:test'
	};
	const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
	const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
	render(AttachmentsPanel, {
		client,
		resource: 'items',
		resourceId: '1',
		canWrite: false,
		canSave
	});
	return { revoke, click };
}

async function pressDownload() {
	const btn = await screen.findByRole('button', { name: /ダウンロード/ });
	await fireEvent.click(btn);
	await vi.waitFor(() => expect(btn.hasAttribute('disabled')).toBe(false));
}

describe('AttachmentsPanel canSave', () => {
	it('does not save and frees the URL when canSave is false', async () => {
		const { revoke, click } = setup(() => false);
		await pressDownload();
		expect(click).not.toHaveBeenCalled();
		expect(revoke).toHaveBeenCalledWith('blob:test');
	});

	it('saves as before when canSave is omitted', async () => {
		const { revoke, click } = setup();
		await pressDownload();
		expect(click).toHaveBeenCalledTimes(1);
		expect(revoke).toHaveBeenCalledWith('blob:test');
	});
});
