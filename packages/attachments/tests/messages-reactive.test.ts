// @vitest-environment jsdom
/**
 * `messages` is reactive: a parent that swaps the bundle later (a locale
 * switch) gets the new wording without remounting.
 */
import { cleanup, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import AttachmentsPanel from '../src/AttachmentsPanel.svelte';
import type { AttachmentsClient } from '../src/types';

afterEach(cleanup);

// Minimal stub: an empty list is enough to reach the empty state.
const client: AttachmentsClient = {
	list: async () => [],
	upload: async () => {
		throw new Error('unused');
	},
	remove: async () => {},
	thumbnailUrl: async () => '',
	downloadUrl: async () => ''
};

describe('AttachmentsPanel messages can be swapped after mount', () => {
	it('the empty-state text and upload label follow', async () => {
		const { rerender } = render(AttachmentsPanel, {
			client,
			resource: 'items',
			resourceId: '1',
			canWrite: true,
			messages: { empty: () => 'Nothing here', upload: () => 'Upload' }
		});
		expect(await screen.findByText('Nothing here')).toBeTruthy();
		expect(screen.getByText('Upload')).toBeTruthy();
		await rerender({ messages: { empty: () => '何もありません', upload: () => 'アップ' } });
		await tick();
		expect(screen.getByText('何もありません')).toBeTruthy();
		expect(screen.getByText('アップ')).toBeTruthy();
		expect(screen.queryByText('Nothing here')).toBeNull();
	});
});
