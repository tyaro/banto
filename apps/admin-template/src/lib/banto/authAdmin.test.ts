import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #697 PR-2b: `applyAuthSettings` carries login-not-required mode's
 * permissions in the same `auth_config_apply` command as the role, and sends
 * no `permissions` argument at all when there is none (the Rust side then
 * leaves them as they are - an older screen keeps working). A rejection is a
 * `ProviderError` (`validation` for an unregistered key).
 */
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

afterEach(() => {
	invokeMock.mockReset();
});

describe('applyAuthSettings permissions', () => {
	it('omits `permissions` when not given, sends it (even empty) when given', async () => {
		invokeMock.mockResolvedValue({});
		const { applyAuthSettings } = await import('./authAdmin');

		await applyAuthSettings(true, 'viewer');
		await applyAuthSettings(true, 'viewer', ['alarm.ack']);
		await applyAuthSettings(true, 'viewer', []);

		expect(invokeMock.mock.calls).toEqual([
			['auth_config_apply', { disabled: true, disabledRole: 'viewer' }],
			['auth_config_apply', { disabled: true, disabledRole: 'viewer', permissions: ['alarm.ack'] }],
			['auth_config_apply', { disabled: true, disabledRole: 'viewer', permissions: [] }]
		]);
		expect(Object.keys(invokeMock.mock.calls[0][1] as object)).not.toContain('permissions');
	});

	it('turns a validation rejection into a ProviderError', async () => {
		invokeMock.mockRejectedValue({
			kind: 'validation',
			message: 'invalid',
			fieldErrors: [{ field: 'permissions', message: 'unknown' }]
		});
		const { applyAuthSettings } = await import('./authAdmin');
		await expect(applyAuthSettings(true, 'viewer', ['nope.x'])).rejects.toMatchObject({
			name: 'ProviderError',
			body: { kind: 'validation' }
		});
	});
});

describe('getPermissionCatalog', () => {
	it('reads `permissions_catalog`', async () => {
		const entries = [{ key: 'alarm.ack', labelKey: 'perm.ack', descriptionKey: 'perm.ack_desc' }];
		invokeMock.mockResolvedValue(entries);
		const { getPermissionCatalog } = await import('./authAdmin');
		await expect(getPermissionCatalog()).resolves.toEqual(entries);
		expect(invokeMock).toHaveBeenCalledWith('permissions_catalog', undefined);
	});
});
