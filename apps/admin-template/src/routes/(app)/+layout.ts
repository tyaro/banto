import { redirect } from '@sveltejs/kit';
import { getAuthProvider } from '@banto/admin-core';

// Auth guard for the whole (app) group (spec §8.1), backed by
// AuthProvider.check() (spec §3.3).
export async function load() {
	if (!(await getAuthProvider().check())) {
		redirect(307, '/login');
	}
}
