/**
 * Demo AuthProvider (spec §3.3): fixed admin/admin credentials backed by
 * sessionStorage. Used in plain-browser dev only (spec §11.1 environment 3);
 * Tauri and embedded-server modes use the real `auth_*` Rust commands/REST
 * routes instead. Split out of setup.ts (improvement-plan-2026-07.md P3-4):
 * demo-mode plumbing app authors never touch when swapping resources.
 */
import type { AuthProvider } from '@banto/admin-core';

const AUTH_KEY = 'banto.auth.demo';

function isSessionAuthed(): boolean {
	return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(AUTH_KEY) === '1';
}

export const demoAuthProvider: AuthProvider = {
	async login(params) {
		const { username, password } = params as { username?: string; password?: string };
		if (username === 'admin' && password === 'admin') {
			sessionStorage.setItem(AUTH_KEY, '1');
			return { success: true };
		}
		return { success: false, error: 'ユーザー名またはパスワードが違います' };
	},
	async logout() {
		sessionStorage.removeItem(AUTH_KEY);
	},
	async check() {
		return isSessionAuthed();
	},
	async getIdentity() {
		// Spec M10 RBAC: the demo provider's one fixed account is always
		// full 'admin' - this is the only environment where usersAdmin.ts is
		// unconditionally unavailable anyway (see isUsersAdminAvailable()),
		// so this only matters for permissions.ts-gated UI elsewhere (nav,
		// items page, settings page), which should behave exactly as if a
		// real admin were logged in.
		return isSessionAuthed() ? { id: 'admin', name: '管理者', role: 'admin' } : null;
	},
	// Always "initialized": the demo provider's admin/admin account always
	// exists, so the login page never shows the first-run setup form here
	// (spec §8.2's setup flow only applies to Tauri/embedded-server modes).
	async status() {
		return { initialized: true };
	},
	// No account store to change a password on in pure-browser demo mode;
	// the settings page hides the password-change section when this
	// resolves to `success: false` (see its "note" fallback).
	async changePassword() {
		return { success: false, error: 'デモモードでは変更できません' };
	}
};
