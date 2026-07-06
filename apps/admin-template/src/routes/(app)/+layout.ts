import { redirect } from '@sveltejs/kit';
import { getAuthProvider } from '@banto/admin-core';
import { bantoReady } from '$lib/banto/setup';

// Auth guard for the whole (app) group (spec §8.1), backed by
// AuthProvider.check() (spec §3.3). Must wait for provider
// selection/detection (spec §11.1's three-way environment probe) to finish
// before getAuthProvider() is safe to call.
export async function load() {
	await bantoReady;
	if (!(await getAuthProvider().check())) {
		redirect(307, '/login');
	}
}
