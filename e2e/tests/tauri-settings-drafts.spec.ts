/**
 * Desktop-only settings drafts under a stubbed Tauri IPC (issue #214, owner
 * review on PR #232). サーバ・接続 / セキュリティ only render their drafts
 * inside the Tauri webview, which the LAN/REST smoke suite cannot reach.
 * Here `window.__TAURI_INTERNALS__` is replaced before the app loads, and the
 * page is opened on a Tauri asset origin (`http://tauri.localhost`, Issue
 * #396: `isTauri()` also checks the origin, so internals on
 * `http://127.0.0.1:<port>` boot in server mode). The static build served by
 * banto-serve is proxied to that origin with `page.route`, so the app boots in
 * Tauri mode and every `invoke()` lands in the table below (the backend
 * itself is not used; production code has no test-only switch).
 *
 * What it pins down:
 * - Until the saved values load, the drafts cannot be edited (an edit then
 *   would have nothing to compare against, so it could never be detected
 *   as unsaved). A slow load and a failed load both keep them disabled; a
 *   failed one offers 再読み込み.
 * - Once loaded, an edit is protected: switching category asks, and so does
 *   closing the desktop window (close-requested is only watched while
 *   something is unsaved).
 * - The firewall information (Issue #219) shows the LIVE listener's port and
 *   an escaped executable path, refuses to copy once the listener changed,
 *   and says "not needed" for a loopback-only listener. The Windows Firewall
 *   status (PR-B) shows each rule's state, and drops a result for a
 *   listener the screen no longer shows.
 * - The connection check from another device (PR-C3) issues a URL + QR for
 *   a live LAN host and turns into "confirmed" when the 2 s re-read finds
 *   a record (not Windows-only).
 *
 * Runs in its own page/context - independent of smoke.spec.ts's shared state.
 */
import { expect, test, type Page } from '@playwright/test';

const LEAVE_PROMPT = '保存していない変更があります。変更を破棄してこの画面から移動しますか？';
const CLOSE_PROMPT = '保存していない変更があります。変更を破棄してウィンドウを閉じますか？';

/** One of `TAURI_ORIGINS` (environment.ts): where Tauri serves its own assets on Windows. */
const TAURI_ORIGIN = 'http://tauri.localhost';

/**
 * Serves `TAURI_ORIGIN` from banto-serve (the project's `baseURL`): every
 * request to it is fetched from the real server and fulfilled as-is, so
 * `location.origin` is a Tauri asset origin while the static build is the
 * real one. Pass the page's own relative paths to `page.goto(tauriUrl(...))`.
 */
async function serveOnTauriOrigin(page: Page, baseURL: string | undefined): Promise<void> {
	if (!baseURL) throw new Error('project baseURL is required');
	await page.route(`${TAURI_ORIGIN}/**`, async (route) => {
		const url = new URL(route.request().url());
		const response = await route.fetch({ url: new URL(url.pathname + url.search, baseURL).href });
		await route.fulfill({ response });
	});
}

const tauriUrl = (path: string): string => `${TAURI_ORIGIN}${path}`;

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
			resolves: [] as { checked: number; kind: string }[],
			/** Merged into every `server_status` answer (Issue #219: a running Windows host). */
			serverStatusPatch: {} as Record<string, unknown>,
			/** `@tauri-apps/api/app`'s `getIdentifier()` answer. */
			appIdentifier: null as string | null,
			/** `firewall_rule_status`'s answer (Issue #219 PR-B; `null` = an older host). */
			firewallRuleStatus: null as unknown,
			/** `reach_check_status`'s answer (Issue #219 PR-C3; `null` = an older host). */
			reachCheckStatus: null as unknown,
			/** `reach_check_issue`'s answer. */
			reachCheckIssue: null as unknown,
			/** Becomes `reachCheckStatus` when `reach_check_issue` is called (the host's new issuance). */
			reachStatusAfterIssue: null as unknown,
			/** The hosts `reach_check_issue` was called with. */
			reachIssueHosts: [] as string[]
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
					return { ...serverStatus, ...mock.serverStatusPatch };
				case 'plugin:app|identifier':
					return mock.appIdentifier;
				case 'firewall_rule_status':
					return mock.firewallRuleStatus;
				case 'reach_check_status':
					return mock.reachCheckStatus;
				case 'reach_check_issue':
					mock.reachIssueHosts.push(String(args.host));
					if (mock.reachStatusAfterIssue !== null)
						mock.reachCheckStatus = mock.reachStatusAfterIssue;
					return mock.reachCheckIssue;
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
		page,
		baseURL
	}) => {
		await installTauriStub(page);
		await serveOnTauriOrigin(page, baseURL);
		await page.goto(tauriUrl('/settings/connectivity'));
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
	// `refreshAll()` re-runs the guard; its first `auth_resolve` answer is
	// about a `seq` the provider had not observed and is discarded, the
	// provider catches up (S-84), the next answer confirms `kind: 'local'`, and
	// `sessionStore.authDisabled` follows it: the user menu (logout) goes.
	test('セキュリティ: enabling login-not-required mode switches the session to the local one (S-94)', async ({
		page,
		baseURL
	}) => {
		await installTauriStub(page);
		await serveOnTauriOrigin(page, baseURL);
		await page.goto(tauriUrl('/settings/security'));
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
		page,
		baseURL
	}) => {
		await installTauriStub(page);
		await serveOnTauriOrigin(page, baseURL);
		// Fail from the very first load (the knob must be set before the app boots).
		await page.addInitScript(() => {
			(
				window as unknown as { __bantoMock: { authConfigFails: boolean } }
			).__bantoMock.authConfigFails = true;
		});
		await page.goto(tauriUrl('/settings/security'));
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

	test('サーバ・接続: firewall information follows the live listener (Issue #219)', async ({
		page,
		baseURL
	}) => {
		await installTauriStub(page);
		// Runs after the stub's own init script: a running Windows host whose
		// SAVED port (9000) differs from the live one (8721).
		await page.addInitScript(() => {
			const m = (window as unknown as { __bantoMock: Record<string, unknown> }).__bantoMock;
			m.serverStatusGate = null;
			m.appIdentifier = 'dev.banto.admin';
			m.serverStatusPatch = {
				enabled: true,
				running: true,
				bind: '0.0.0.0',
				port: 9000,
				live: { bind: '0.0.0.0', port: 8721 },
				generation: 1,
				executablePath: "C:\\Program Files\\O'Brien\\banto-admin.exe",
				platform: 'windows'
			};
			m.firewallRuleStatus = {
				generation: 1,
				expected: { executablePath: "C:\\Program Files\\O'Brien\\banto-admin.exe", port: 8721 },
				program: {
					state: 'present',
					rule: {
						enabled: 'True',
						direction: 'Inbound',
						action: 'Block',
						protocol: 'TCP',
						profile: 'Private',
						program: "C:\\Program Files\\O'Brien\\banto-admin.exe",
						localPorts: ['Any'],
						remoteAddresses: ['LocalSubnet']
					},
					// A Group Policy rule of the same name is in effect; the local one says Allow.
					origin: {
						kind: 'groupPolicy',
						sourceType: 'GroupPolicy',
						source: 'contoso.local\\Banto'
					},
					enforcement: { state: 'enforced' },
					local: {
						state: 'differs',
						rule: {
							enabled: 'True',
							direction: 'Inbound',
							action: 'Allow',
							protocol: 'TCP',
							profile: 'Private',
							program: "C:\\Program Files\\O'Brien\\banto-admin.exe",
							localPorts: ['Any'],
							remoteAddresses: ['LocalSubnet']
						}
					},
					mismatches: ['action'],
					unchecked: []
				},
				port: { state: 'missing' },
				groupOtherRules: 0
			};
		});
		await serveOnTauriOrigin(page, baseURL);
		await page.goto(tauriUrl('/settings/connectivity'));

		await expect(
			page.getByRole('heading', { name: 'ファイアウォールの許可に必要な情報' })
		).toBeVisible();
		await expect(
			page.getByText("C:\\Program Files\\O'Brien\\banto-admin.exe", { exact: true })
		).toBeVisible();
		// The commands use the live port and the escaped path, never the saved port.
		const commands = page.locator('.firewall-command pre');
		await expect(commands).toHaveCount(2);
		await expect(commands.nth(0)).toContainText(
			"-Program 'C:\\Program Files\\O''Brien\\banto-admin.exe'"
		);
		await expect(commands.nth(1)).toContainText('-LocalPort 8721 ');
		await expect(page.locator('.firewall-info')).not.toContainText('9000');
		// The Windows Firewall status: a central policy's Block is in effect for
		// the program rule (the local Allow does not apply), no port rule.
		const ruleStatus = page.locator('.firewall-status');
		await expect(
			page.getByRole('heading', { name: 'Windows ファイアウォールの状態' })
		).toBeVisible();
		const differs = ruleStatus.locator('[data-state="differs"]');
		await expect(differs).toContainText('dev.banto.admin.lan.tcp.program');
		await expect(differs).toContainText('操作:');
		await expect(differs).toContainText('Block');
		await expect(differs.locator('[data-origin="policy"]')).toContainText(
			'集中管理のポリシー（グループポリシー）のルールです（出どころ: contoso.local\\Banto）'
		);
		await expect(differs.locator('[data-enforcement="enforced"]')).toContainText(
			'適用されています（EnforcementStatus: Full）'
		);
		await expect(differs.locator('[data-local="differs"]')).toBeVisible();
		await expect(differs).toContainText('Allow');
		await expect(ruleStatus.locator('[data-state="missing"]')).toContainText('ルール無し');
		await expect(ruleStatus).toContainText(
			'ルールがあることと、LAN の端末から接続できることは同じではありません。'
		);
		// The listener changed behind the screen: copying refuses and shows the new values.
		await mock(page, {
			serverStatusPatch: {
				enabled: true,
				running: true,
				bind: '0.0.0.0',
				port: 8722,
				live: { bind: '0.0.0.0', port: 8722 },
				generation: 2,
				executablePath: "C:\\Program Files\\O'Brien\\banto-admin.exe",
				platform: 'windows'
			}
		});
		await page.getByRole('button', { name: 'ポート単位の許可をコピー' }).click();
		await expect(
			page.getByText('待ち受けの状態が変わったため、コピーしませんでした。')
		).toBeVisible();
		await expect(commands.nth(1)).toContainText('-LocalPort 8722 ');
		// The firewall status still answers for generation 1: not shown for 8722.
		await expect(ruleStatus.locator('[data-state]')).toHaveCount(0);
		await expect(
			page.getByText('確認の途中でサーバーの状態が変わりました。もう一度確認してください。')
		).toBeVisible();

		// Loopback only: no rule needed, no commands.
		await mock(page, {
			serverStatusPatch: {
				enabled: true,
				running: true,
				bind: '127.0.0.1',
				port: 8722,
				live: { bind: '127.0.0.1', port: 8722 },
				generation: 3,
				platform: 'windows'
			}
		});
		await page.getByRole('button', { name: 'ポート単位の許可をコピー' }).click();
		await expect(
			page.getByText('このPCのみで待ち受けているため、ファイアウォールの設定は不要です。')
		).toBeVisible();
		await expect(commands).toHaveCount(0);
	});

	test('サーバ・接続: connection check from another device - issue, then confirmed (Issue #219 PR-C3)', async ({
		page,
		baseURL
	}) => {
		await installTauriStub(page);
		// A running Linux host (the block is not Windows-only), nothing issued yet.
		await page.addInitScript(() => {
			const m = (window as unknown as { __bantoMock: Record<string, unknown> }).__bantoMock;
			m.serverStatusGate = null;
			m.serverStatusPatch = {
				enabled: true,
				running: true,
				bind: '0.0.0.0',
				port: 8721,
				live: { bind: '0.0.0.0', port: 8721 },
				urls: ['http://127.0.0.1:8721', 'http://192.168.1.20:8721'],
				generation: 1,
				platform: 'linux'
			};
			m.reachCheckStatus = { generation: 1, lastIssue: null, selfAccessAt: null, records: [] };
			m.reachCheckIssue = {
				status: 'issued',
				generation: 1,
				issueId: 1,
				url: 'http://192.168.1.20:8721/reach#t=0d8b2f4e-1c3a-4b5d-9e6f-7a8b9c0d1e2f',
				qrSvg:
					'<svg xmlns="http://www.w3.org/2000/svg" data-reach-qr="1" width="10" height="10"></svg>',
				expiresInMs: 300000
			};
			m.reachStatusAfterIssue = {
				generation: 1,
				lastIssue: {
					issueId: 1,
					host: '192.168.1.20',
					port: 8721,
					expiresAt: Date.now() + 300000,
					outcome: 'pending',
					expiresInMs: 300000
				},
				selfAccessAt: null,
				records: []
			};
		});
		await serveOnTauriOrigin(page, baseURL);
		await page.goto(tauriUrl('/settings/connectivity'));

		const block = page.locator('.reach-check');
		await expect(page.getByRole('heading', { name: '別の端末からの接続確認' })).toBeVisible();
		await expect(block).toContainText('別の端末からの接続はまだ確認していません。');
		// The firewall blocks are Windows-only; this one is not.
		await expect(page.locator('.firewall-info')).toHaveCount(0);

		await block.getByRole('button', { name: '確認用の URL を発行' }).click();
		await expect(block.locator('[data-reach-state="pending"]')).toBeVisible();
		await expect(block).toContainText(
			'http://192.168.1.20:8721/reach#t=0d8b2f4e-1c3a-4b5d-9e6f-7a8b9c0d1e2f'
		);
		await expect(block.locator('svg[data-reach-qr]')).toHaveCount(1);
		await expect(block).toContainText('有効期限まで残り');
		expect(
			await page.evaluate(
				() =>
					(window as unknown as { __bantoMock: { reachIssueHosts: string[] } }).__bantoMock
						.reachIssueHosts
			)
		).toEqual(['192.168.1.20']);

		// Another device opened it: the 2 s re-read picks it up.
		const at = Date.now();
		await mock(page, {
			reachCheckStatus: {
				generation: 1,
				lastIssue: {
					issueId: 1,
					host: '192.168.1.20',
					port: 8721,
					expiresAt: at + 300000,
					outcome: 'recorded',
					expiresInMs: 0
				},
				selfAccessAt: null,
				records: [{ issueId: 1, at, peerIp: '192.168.1.31', host: '192.168.1.20', port: 8721 }]
			}
		});
		const verified = block.locator('[data-reach-state="verified"]');
		await expect(verified).toBeVisible({ timeout: 10_000 });
		await expect(verified).toContainText('別の端末から到達を確認しました。');
		await expect(verified).toContainText('192.168.1.31');
		await expect(verified).toContainText('http://192.168.1.20:8721');
		await expect(verified).toContainText('この時点に、この端末から届いたことの確認です。');
		// The QR of the used URL is gone with the pending state.
		await expect(block.locator('svg[data-reach-qr]')).toHaveCount(0);
	});
});
