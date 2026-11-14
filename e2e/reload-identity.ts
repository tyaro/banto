import { expect, type Frame, type Page } from '@playwright/test';

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
	let body: unknown;
	const markReloaded = (frame: Frame) => {
		if (frame === page.mainFrame()) reloaded = true;
	};
	page.on('framenavigated', markReloaded);
	try {
		const identity = page.waitForResponse(async (response) => {
			if (!reloaded || new URL(response.url()).pathname !== '/api/auth/identity') return false;
			expect(response.ok()).toBe(true);
			body = await response.json();
			return true;
		});
		await page.reload();
		await identity;
		return body;
	} finally {
		page.off('framenavigated', markReloaded);
	}
}
