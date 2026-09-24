/**
 * Desktop-only settings drafts under a stubbed Tauri IPC (issue #214, owner
 * review on PR #232). サーバ・接続 / セキュリティ only render their drafts
 * inside the Tauri webview, which the LAN/REST smoke suite cannot reach.
 * Here `window.__TAURI_INTERNALS__` is replaced before the app loads, so the
 * static build served by banto-serve boots in Tauri mode and every
 * `invoke()` lands in the table below (the backend itself is not used).
 *
 * What it pins down:
 * - Until the saved values load, the drafts cannot be edited (an edit then
 *   would have nothing to compare against, so it could never be detected
 *   as unsaved). A slow load and a failed load both keep them disabled; a
 *   failed one offers 再読み込み.
 * - Once loaded, an edit is protected: switching category asks, and so does
 *   closing the desktop window (close-requested is only watched while
 *   something is unsaved).
 *
 * Runs in its own page/context - independent of smoke.spec.ts's shared state.
 */
import { expect, test, type Page } from '@playwright/test';

const LEAVE_PROMPT = '保存していない変更があります。変更を破棄してこの画面から移動しますか？';
const CLOSE_PROMPT = '保存していない変更があります。変更を破棄してウィンドウを閉じますか？';

/** Installs the IPC stub. Knobs live on `window.__bantoMock` (see `mock()`). */
async function installTauriStub(page: Page): Promise<void> {
	await page.addInitScript(() => {
		type Callback = (payload: unknown) => void;
		const callbacks = new Map<number, Callback>();
		let nextId = 1;
		const mock = {
			serverStatusFails: false,
			authConfigFails: false,
			/** When set, `server_status` waits for it (a slow first load). */
			serverStatusGate: null as Promise<void> | null,
			releaseServerStatus: null as (() => void) | null,
			listens: [] as { event: string; handler: number; eventId: number }[],
			unlistens: [] as number[],
			destroyed: 0,
			callbacks
		};
		mock.serverStatusGate = new Promise<void>((resolve) => {
			mock.releaseServerStatus = resolve;
		});
		(window as unknown as { __bantoMock: typeof mock }).__bantoMock = mock;

		const serverStatus = {
			enabled: false,
			running: false,
			bind: '127.0.0.1',
			port: 8721,
			viewerPublic: false,
			urls: [],
			qrSvgs: []
		};
		const authSettings = {
			disabled: false,
			disabledRole: 'admin',
			autologinEnabled: false,
			autologinUsername: null
		};

		async function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
			switch (cmd) {
				case 'auth_check':
					return true;
				case 'auth_identity':
					return { id: 'admin', name: 'E2E管理者', role: 'admin' };
				case 'auth_status':
					return { initialized: true };
				case 'auth_config_get':
					if (mock.authConfigFails) throw 'auth settings unavailable (stub)';
					return authSettings;
				case 'server_status':
					if (mock.serverStatusGate) await mock.serverStatusGate;
					if (mock.serverStatusFails) throw 'server status unavailable (stub)';
					return serverStatus;
				case 'vibrancy_status':
					return { supported: false, applied: false };
				case 'plugin:event|listen': {
					const eventId = nextId++;
					mock.listens.push({
						event: String(args.event),
						handler: Number(args.handler),
						eventId
					});
					return eventId;
				}
				case 'plugin:event|unlisten':
					mock.unlistens.push(Number(args.eventId));
					return null;
				case 'plugin:window|destroy':
					mock.destroyed++;
					return null;
				default:
					return null;
			}
		}

		(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
			metadata: {
				currentWindow: { label: 'main' },
				currentWebview: { windowLabel: 'main', label: 'main' }
			},
			invoke,
			transformCallback(callback: Callback) {
				const id = nextId++;
				callbacks.set(id, callback);
				return id;
			},
			unregisterCallback(id: number) {
				callbacks.delete(id);
			},
			convertFileSrc: (path: string) => path
		};
		// `@tauri-apps/api/event`'s unlisten also tells the event plugin's
		// in-page registry; nothing to do here.
		(
			window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }
		).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
	});
}

/** Set a knob on the stub. */
async function mock(page: Page, patch: Record<string, unknown>): Promise<void> {
	await page.evaluate((values) => {
		Object.assign((window as unknown as { __bantoMock: object }).__bantoMock, values);
	}, patch);
}

/** Whether a close-requested listener is currently registered (and not removed). */
async function closeListenerActive(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const m = (
			window as unknown as {
				__bantoMock: {
					listens: { event: string; eventId: number }[];
					unlistens: number[];
				};
			}
		).__bantoMock;
		return m.listens.some(
			(l) => l.event === 'tauri://close-requested' && !m.unlistens.includes(l.eventId)
		);
	});
}

/** Fire the OS "close window" request at every live close-requested listener. */
async function requestWindowClose(page: Page): Promise<void> {
	await page.evaluate(() => {
		const m = (
			window as unknown as {
				__bantoMock: {
					listens: { event: string; handler: number; eventId: number }[];
					unlistens: number[];
					callbacks: Map<number, (payload: unknown) => void>;
				};
			}
		).__bantoMock;
		for (const l of m.listens) {
			if (l.event !== 'tauri://close-requested' || m.unlistens.includes(l.eventId)) continue;
			m.callbacks.get(l.handler)?.({ event: l.event, id: l.eventId, payload: null });
		}
	});
}

async function destroyedCount(page: Page): Promise<number> {
	return page.evaluate(
		() => (window as unknown as { __bantoMock: { destroyed: number } }).__bantoMock.destroyed
	);
}

test.describe('Tauri settings drafts (stubbed IPC)', () => {
	test('サーバ・接続: not editable until the saved status loads; edits are then protected', async ({
		page
	}) => {
		await installTauriStub(page);
		await page.goto('/settings/connectivity');
		const port = page.getByLabel('ポート番号');
		const save = page.getByRole('button', { name: '保存して適用' });
		const unsaved = page.getByText('未保存の変更があります');
		const categoryNav = page.getByRole('navigation', { name: '設定カテゴリ' });

		// Slow first load: nothing editable yet.
		await expect(port).toBeVisible();
		await expect(port).toBeDisabled();
		await expect(save).toBeDisabled();

		// It then fails: still not editable, with a retry.
		await mock(page, { serverStatusFails: true });
		await page.evaluate(() =>
			(
				window as unknown as { __bantoMock: { releaseServerStatus: () => void } }
			).__bantoMock.releaseServerStatus()
		);
		await expect(page.getByText('保存済みの設定を読み込めなかったため')).toBeVisible();
		await expect(port).toBeDisabled();
		await expect(save).toBeDisabled();
		await expect(unsaved).toHaveCount(0);

		// Retry succeeds: the saved values arrive and become editable.
		await mock(page, { serverStatusFails: false, serverStatusGate: null });
		await page.getByRole('button', { name: '再読み込み' }).click();
		await expect(port).toBeEnabled();
		await expect(port).toHaveValue('8721');
		await expect(save).toBeEnabled();

		// An edit is now unsaved: switching category asks, "stay" keeps it.
		await port.fill('9000');
		await expect(unsaved).toBeVisible();
		const messages: string[] = [];
		page.once('dialog', (dialog) => {
			messages.push(dialog.message());
			void dialog.dismiss();
		});
		await categoryNav.getByRole('link', { name: '外観・言語' }).click();
		await expect.poll(() => messages).toEqual([LEAVE_PROMPT]);
		await expect(page).toHaveURL(/\/settings\/connectivity$/);
		await expect(port).toHaveValue('9000');

		// Closing the desktop window asks too: "stay" keeps the window...
		await expect.poll(() => closeListenerActive(page)).toBe(true);
		page.once('dialog', (dialog) => {
			messages.push(dialog.message());
			void dialog.dismiss();
		});
		await requestWindowClose(page);
		await expect.poll(() => messages).toEqual([LEAVE_PROMPT, CLOSE_PROMPT]);
		expect(await destroyedCount(page)).toBe(0);

		// ...and "leave" closes it (the JS side destroys the window).
		page.once('dialog', (dialog) => {
			messages.push(dialog.message());
			void dialog.accept();
		});
		await requestWindowClose(page);
		await expect.poll(() => destroyedCount(page)).toBe(1);

		// Discarding makes it clean again: no more close-requested listener.
		await page.getByRole('button', { name: '変更を取り消す' }).click();
		await expect(port).toHaveValue('8721');
		await expect(unsaved).toHaveCount(0);
		await expect.poll(() => closeListenerActive(page)).toBe(false);
	});

	test('セキュリティ: not editable while the saved auth settings failed to load', async ({
		page
	}) => {
		await installTauriStub(page);
		// Fail from the very first load (the knob must be set before the app boots).
		await page.addInitScript(() => {
			(
				window as unknown as { __bantoMock: { authConfigFails: boolean } }
			).__bantoMock.authConfigFails = true;
		});
		await page.goto('/settings/security');
		const toggle = page.getByRole('switch', { name: 'ログイン不要モードを有効にする' });
		const save = page.getByRole('button', { name: '保存して適用' });

		await expect(page.getByText('保存済みの設定を読み込めなかったため')).toBeVisible();
		await expect(toggle).toBeDisabled();
		await expect(save).toBeDisabled();

		await mock(page, { authConfigFails: false });
		await page.getByRole('button', { name: '再読み込み' }).click();
		await expect(toggle).toBeEnabled();
		await expect(save).toBeEnabled();

		await toggle.check();
		await expect(page.getByText('未保存の変更があります')).toBeVisible();
		const messages: string[] = [];
		page.once('dialog', (dialog) => {
			messages.push(dialog.message());
			void dialog.dismiss();
		});
		await page
			.getByRole('navigation', { name: '設定カテゴリ' })
			.getByRole('link', { name: '外観・言語' })
			.click();
		await expect.poll(() => messages).toEqual([LEAVE_PROMPT]);
		await expect(page).toHaveURL(/\/settings\/security$/);
		await expect(toggle).toBeChecked();
	});
});
