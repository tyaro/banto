/**
 * Wires @banto/admin-core for the admin-template app (spec §3, §8): the
 * items resource + schema, a demo AuthProvider, and an InMemoryDataProvider
 * seeded with the sample dataset. Imported once (side-effect) from the root
 * layout, before any route guard runs, so getDataProvider()/
 * getAuthProvider() are ready everywhere.
 *
 * Phase B replaces the InMemoryDataProvider with a TauriDataProvider backed
 * by the Rust service layer (spec §10); the resource/schema definitions and
 * AuthProvider contract stay the same.
 */
import { createInMemoryDataProvider, initBanto } from '@banto/admin-core';
import type { AuthProvider, ResourceDefinition } from '@banto/admin-core';
import type { FormSchema } from '@banto/forms';
import { toastStore } from '$lib/toast.svelte';
import { sampleItems } from './sampleData';

const AUTH_KEY = 'banto.auth.demo';

const itemsSchema: FormSchema = {
	fields: [
		{ name: 'name', label: '商品名', type: 'text', required: true, min: 1, max: 40 },
		{ name: 'price', label: '価格', type: 'number', required: true, min: 0, max: 99999 },
		{ name: 'stock', label: '在庫', type: 'number', required: true, min: 0 },
		{ name: 'updatedAt', label: '更新日', type: 'date', readonly: true }
	]
};

const itemsResource: ResourceDefinition = {
	name: 'items',
	label: '商品',
	icon: '📦',
	schema: itemsSchema,
	capabilities: { list: true, create: true, edit: true, delete: true }
};

function isSessionAuthed(): boolean {
	return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(AUTH_KEY) === '1';
}

/**
 * Demo AuthProvider (spec §3.3): fixed admin/admin credentials backed by
 * sessionStorage. Phase B swaps this for a real backend without touching
 * the login page or the route guard.
 */
const demoAuthProvider: AuthProvider = {
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
		return isSessionAuthed() ? { id: 'admin', name: '管理者' } : null;
	}
};

const dataProvider = createInMemoryDataProvider({
	items: { rows: sampleItems }
});

initBanto({
	dataProvider,
	authProvider: demoAuthProvider,
	notifier: { notify: (kind, message) => toastStore.push(kind, message) },
	resources: [itemsResource]
});
