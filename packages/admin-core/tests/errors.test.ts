import { describe, expect, it } from 'vitest';
import { isProviderError, ProviderError } from '../src/errors';

describe('ProviderError kind "forbidden" (spec M10 RBAC)', () => {
	it('carries the wire-shaped body with no extra fields, mirroring BantoError::Forbidden', () => {
		const err = new ProviderError({ kind: 'forbidden' });

		expect(isProviderError(err)).toBe(true);
		expect(err.body).toEqual({ kind: 'forbidden' });
	});

	it('describes itself with the Japanese user-facing message, same convention as other kinds', () => {
		const err = new ProviderError({ kind: 'forbidden' });

		// This IS what list.svelte.ts/form.svelte.ts/usersAdmin.ts toast verbatim
		// via notify('error', err.message) - unlike 'unauthorized', a 'forbidden'
		// is meant to be shown to the user (see errors.ts's describe()).
		expect(err.message).toBe('この操作を行う権限がありません');
	});
});

describe('ProviderError kind "conflict" (Issue #638 optimistic lock)', () => {
	it('carries the current record, mirroring BantoError::Conflict', () => {
		const err = new ProviderError({
			kind: 'conflict',
			message: 'changed',
			current: { id: 1, version: 2 }
		});

		expect(isProviderError(err)).toBe(true);
		expect(err.body).toEqual({
			kind: 'conflict',
			message: 'changed',
			current: { id: 1, version: 2 }
		});
	});

	it('describes itself with the Japanese user-facing message, like "forbidden"', () => {
		const err = new ProviderError({ kind: 'conflict', message: 'changed' });

		expect(err.message).toBe('他の人が先に変更しました。最新の内容を確かめてください');
	});
});
