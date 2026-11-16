import { ProviderError } from '@banto/admin-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const setup = vi.hoisted(() => ({ mode: 'tauri' as 'tauri' | 'server' | 'demo' }));
const invoke = vi.hoisted(() => vi.fn());

vi.mock('./setup', () => ({ getBantoMode: () => setup.mode, CSRF_HEADER: {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

afterEach(() => invoke.mockReset());

describe('Tauri login notice errors', () => {
	it.each([
		['getLoginNotice', 'login_notice_get', undefined, { kind: 'unauthorized' }],
		[
			'setLoginNotice',
			'login_notice_set',
			{ notice: 'a\u200bb' },
			{ kind: 'validation', field_errors: [{ field: 'notice', message: 'invalid character' }] }
		]
	] as const)('%s preserves the Rust error body', async (name, command, args, errorBody) => {
		invoke.mockRejectedValue(errorBody);
		const notice = await import('./loginNotice');
		const request =
			name === 'getLoginNotice' ? notice.getLoginNotice() : notice.setLoginNotice('a\u200bb');
		await expect(request).rejects.toBeInstanceOf(ProviderError);
		await expect(request).rejects.toMatchObject({ body: errorBody });
		expect(invoke).toHaveBeenCalledWith(command, args);
	});
});
