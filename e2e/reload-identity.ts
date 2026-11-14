import { expect, type Frame, type Page, type Response } from '@playwright/test';

/**
 * Reloads the page and returns the body of the `/api/auth/identity` response
 * that the RELOADED page makes (Issue #582).
 *
 * Registering `waitForResponse` before `reload()` can catch a response the
 * outgoing page was still issuing; its body is discarded by the navigation, so
 * `response.json()` fails ("No resource with given identifier found") or reads
 * a stale state. Only responses after the main frame's `framenavigated` count,
 * and the body is read inside the predicate, before anything can discard it.
 */
export async function reloadAndReadIdentity(page: Page): Promise<unknown> {
	let reloaded = false;
	// Predicates run concurrently for overlapping responses, so keep each body
	// with its own response and return the one waitForResponse settled on.
	const bodies = new Map<Response, unknown>();
	const markReloaded = (frame: Frame) => {
		if (frame === page.mainFrame()) reloaded = true;
	};
	page.on('framenavigated', markReloaded);
	try {
		const identity = page.waitForResponse(async (response) => {
			if (!reloaded || new URL(response.url()).pathname !== '/api/auth/identity') return false;
			expect(response.ok()).toBe(true);
			bodies.set(response, await response.json());
			return true;
		});
		await page.reload();
		return bodies.get(await identity);
	} finally {
		page.off('framenavigated', markReloaded);
	}
}
