import { beforeEach, describe, expect, it, vi } from 'vitest';

let live = true;
vi.mock('@banto/admin-core', () => ({ isCurrentSessionScope: () => live }));

import { hasPendingUploads, stashPendingUploads, takePendingUploads } from './pendingUploads';

const scope = { generation: 1, owner: 'acct:1' };
const pending = [{ file: new File(['x'], 'a.txt'), error: 'no' }] as never;

describe('pendingUploads (#714 F2)', () => {
	beforeEach(() => {
		live = true;
		takePendingUploads('items', 1);
	});

	it('hands the files over once, to the session that stashed them', () => {
		stashPendingUploads(scope, 'items', 1, pending);
		expect(hasPendingUploads('items', 1)).toBe(true);
		expect(takePendingUploads('items', 1)).toBe(pending);
		expect(takePendingUploads('items', 1)).toBeNull();
	});

	it('never hands them to another session', () => {
		stashPendingUploads(scope, 'items', 1, pending);
		live = false;
		expect(hasPendingUploads('items', 1)).toBe(false);
		live = true;
		expect(takePendingUploads('items', 1)).toBeNull();
	});

	it('does not stash once the session has ended', () => {
		live = false;
		stashPendingUploads(scope, 'items', 1, pending);
		live = true;
		expect(hasPendingUploads('items', 1)).toBe(false);
	});
});
