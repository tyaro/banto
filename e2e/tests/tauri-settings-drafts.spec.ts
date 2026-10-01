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
			callbacks,
			/**
			 * The Rust session slot (Issue #260): `auth_resolve` answers from it,
			 * and `auth_config_apply(true)` re-binds it to the synthetic local
			 * session, advancing `seq` (owner review of #266 P1). The provider
			 * does not observe that advance until its next `auth_resolve`.
			 */
			slot: { seq: 1, local: false, none: false, role: 'admin' as string },
			resolves: [] as { checked: number; kind: string }[]
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
				// Issue #260 実装-2: the route guard asks through the
				// SessionController, i.e. the provider's one-round-trip
				// `auth_resolve`.
				case 'auth_resolve': {
					const { seq, local, none, role } = mock.slot;
					const answer = none
						? { identity: null, kind: null, checked: seq, current: seq, stale: false }
						: local
							? {
									identity: { id: '0', name: 'ローカルユーザー', role },
									kind: 'local',
									checked: seq,
									current: seq,
									stale: false
								}
							: {
									identity: { id: 'admin', name: 'E2E管理者', role: 'admin' },
									kind: 'account',
									checked: seq,
									current: seq,
									stale: false
								};
					mock.resolves.push({ checked: seq, kind: answer.kind ?? 'none' });
					return answer;
				}
				case 'auth_config_apply': {
					const disabled = args.disabled === true;
					authSettings.disabled = disabled;
					authSettings.disabledRole = String(args.disabledRole);
					if (disabled) {
						const rebinding = !mock.slot.local || mock.slot.role !== authSettings.disabledRole;
						mock.slot = {
							seq: mock.slot.seq + (rebinding ? 1 : 0),
							local: true,
							none: false,
							role: authSettings.disabledRole
						};
					} else if (mock.slot.local) {
						// S-99: turning the mode off ends the synthetic session at once.
						mock.slot = { seq: mock.slot.seq + 1, local: false, none: true, role: 'admin' };
					}
					return { ...authSettings };
				}
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

	// Owner review of #266 P1 (Issue #260, S-94): turning login-not-required
	// mode on from the settings screen re-binds the Rust session to the
	// synthetic local one (`seq` + 1, not reported to the provider). The save's
	// `invalidateAll()` re-runs the guard; its first `auth_resolve` answer is
	// about a `seq` the provider had not observed and is discarded, the
	// provider catches up (S-84), the next answer confirms `kind: 'local'`, and
	// `sessionStore.authDisabled` follows it: the user menu (logout) goes.
	test('セキュリティ: enabling login-not-required mode switches the session to the local one (S-94)', async ({
		page
	}) => {
		await installTauriStub(page);
		await page.goto('/settings/security');
		const toggle = page.getByRole('switch', { name: 'ログイン不要モードを有効にする' });
		const save = page.getByRole('button', { name: '保存して適用' });
		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toBeVisible();
		await expect(toggle).toBeEnabled();

		await toggle.check();
		page.once('dialog', (dialog) => void dialog.accept()); // authDisableConfirm
		await save.click();

		await expect(page.getByRole('button', { name: 'ユーザーメニューを開く' })).toHaveCount(0);
		const resolves = await page.evaluate(
			() =>
				(window as unknown as { __bantoMock: { resolves: { checked: number; kind: string }[] } })
					.__bantoMock.resolves
		);
		// The answers after the apply are about seq 2; the last one confirmed `local`.
		const after = resolves.filter((answer) => answer.checked === 2);
		expect(after.length).toBeGreaterThanOrEqual(2); // one discarded, one applied (S-84)
		expect(after.at(-1)?.kind).toBe('local');

		// S-99: turning the mode off again ends the local session at once (seq 3);
		// the save's re-run of the guard catches up and confirms `none` -> /login.
		await expect(toggle).toBeChecked();
		await toggle.uncheck();
		await save.click();
		await expect(page).toHaveURL(/\/login$/);
		const last = await page.evaluate(() =>
			(
				window as unknown as { __bantoMock: { resolves: { checked: number; kind: string }[] } }
			).__bantoMock.resolves.at(-1)
		);
		expect(last).toEqual({ checked: 3, kind: 'none' });
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
