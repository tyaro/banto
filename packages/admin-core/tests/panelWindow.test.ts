import { describe, expect, it, vi } from 'vitest';
import {
	PANEL_CLOSED_EVENT,
	PANEL_CLOSE_COMMAND,
	PANEL_LIST_COMMAND,
	PANEL_OPEN_COMMAND,
	closePanelWindow,
	createPanelPopOut,
	listPanelWindows,
	listenPanelClosed,
	openPanelWindow
} from '../src/panelWindow';

type Listener = (e: { payload: unknown }) => void;

/** A `listen` whose registration can be resolved by hand, and whose event can be fired. */
function fakeListen() {
	let captured: Listener | null = null;
	const unlisten = vi.fn();
	const listen = vi.fn(async (_event: string, cb: Listener) => {
		captured = cb;
		return unlisten;
	});
	return {
		listen,
		unlisten,
		fire: (payload: unknown) => captured?.({ payload })
	};
}

const tick = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

const MEMO = { id: 'memo', title: 'Memo' };

describe('openPanelWindow', () => {
	it('invokes the plugin command with the id and the title', async () => {
		const invoke = vi.fn(async () => undefined);
		await openPanelWindow(MEMO, { isTauri: () => true, invoke });
		expect(invoke).toHaveBeenCalledWith(PANEL_OPEN_COMMAND, { id: 'memo', title: 'Memo' });
		expect(PANEL_OPEN_COMMAND).toBe('plugin:banto-tauri-panel|open');
	});

	it('passes only the id and the title, whatever else the dock content carries', async () => {
		const invoke = vi.fn(async () => undefined);
		await openPanelWindow({ ...MEMO, x: 10, floating: true } as typeof MEMO, {
			isTauri: () => true,
			invoke
		});
		expect(invoke).toHaveBeenCalledWith(PANEL_OPEN_COMMAND, { id: 'memo', title: 'Memo' });
	});

	it('does nothing outside Tauri', async () => {
		const invoke = vi.fn(async () => undefined);
		await openPanelWindow(MEMO, { isTauri: () => false, invoke });
		expect(invoke).not.toHaveBeenCalled();
	});

	it("rejects with the plugin's error", async () => {
		const invoke = vi.fn(async () => {
			throw 'panel id is empty';
		});
		await expect(
			openPanelWindow({ id: '', title: '' }, { isTauri: () => true, invoke })
		).rejects.toBe('panel id is empty');
	});
});

describe('openPanelWindow: background (Issue #1015)', () => {
	it('passes the colour the app gives', async () => {
		const invoke = vi.fn(async () => undefined);
		await openPanelWindow(MEMO, { isTauri: () => true, invoke, background: () => '#1e1e2e' });
		expect(invoke).toHaveBeenCalledWith(PANEL_OPEN_COMMAND, {
			id: 'memo',
			title: 'Memo',
			background: '#1e1e2e'
		});
	});

	it('leaves the argument out when there is no colour', async () => {
		for (const background of [undefined, () => undefined, () => '']) {
			const invoke = vi.fn(async () => undefined);
			await openPanelWindow(MEMO, { isTauri: () => true, invoke, background });
			expect(invoke).toHaveBeenCalledWith(PANEL_OPEN_COMMAND, { id: 'memo', title: 'Memo' });
		}
	});

	it('reads the colour at every open, so a theme change is followed', async () => {
		const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined);
		let color = '#ffffff';
		const options = { isTauri: () => true, invoke, background: () => color };
		await openPanelWindow(MEMO, options);
		color = '#101010';
		await openPanelWindow(MEMO, options);
		expect(invoke.mock.calls.map((c) => c[1]?.background)).toEqual(['#ffffff', '#101010']);
	});

	it('still opens the window when the colour function throws', async () => {
		const invoke = vi.fn(async () => undefined);
		await openPanelWindow(MEMO, {
			isTauri: () => true,
			invoke,
			background: () => {
				throw new Error('no document');
			}
		});
		expect(invoke).toHaveBeenCalledWith(PANEL_OPEN_COMMAND, { id: 'memo', title: 'Memo' });
	});

	it('does not read the colour outside Tauri', async () => {
		const background = vi.fn(() => '#000000');
		await openPanelWindow(MEMO, { isTauri: () => false, invoke: vi.fn(), background });
		expect(background).not.toHaveBeenCalled();
	});
});

describe('listenPanelClosed', () => {
	it('listens on banto://panel-closed and hands the id over', async () => {
		const { listen, unlisten, fire } = fakeListen();
		const cb = vi.fn();
		const stop = listenPanelClosed(cb, { isTauri: () => true, listen });
		await tick();

		expect(listen).toHaveBeenCalledWith(PANEL_CLOSED_EVENT, expect.any(Function));
		expect(PANEL_CLOSED_EVENT).toBe('banto://panel-closed');
		fire('memo');
		expect(cb).toHaveBeenCalledWith('memo');

		stop();
		expect(unlisten).toHaveBeenCalledTimes(1);
	});

	it('ignores a payload that is not a string', async () => {
		const { listen, fire } = fakeListen();
		const cb = vi.fn();
		listenPanelClosed(cb, { isTauri: () => true, listen });
		await tick();
		fire({ id: 'memo' });
		fire(null);
		expect(cb).not.toHaveBeenCalled();
	});

	it('registers nothing outside Tauri', () => {
		const { listen } = fakeListen();
		const stop = listenPanelClosed(vi.fn(), { isTauri: () => false, listen });
		expect(listen).not.toHaveBeenCalled();
		stop();
	});

	it('tears the listener down if unsubscribed before listen() resolved', async () => {
		let resolveListen!: (fn: () => void) => void;
		let captured: Listener | null = null;
		const unlisten = vi.fn();
		const listen = vi.fn((_event: string, cb: Listener) => {
			captured = cb;
			return new Promise<() => void>((resolve) => {
				resolveListen = resolve;
			});
		});
		const cb = vi.fn();

		const stop = listenPanelClosed(cb, { isTauri: () => true, listen });
		stop();
		resolveListen(unlisten);
		await tick();

		expect(unlisten).toHaveBeenCalledTimes(1);
		// An event that still arrives is not delivered.
		captured!({ payload: 'memo' });
		expect(cb).not.toHaveBeenCalled();
	});

	it('survives a listen() that fails', async () => {
		const listen = vi.fn(async () => {
			throw new Error('event.listen not allowed');
		});
		const stop = listenPanelClosed(vi.fn(), { isTauri: () => true, listen });
		await tick();
		expect(() => stop()).not.toThrow();
	});
});

describe('createPanelPopOut', () => {
	function setup(overrides: Partial<Parameters<typeof createPanelPopOut>[0]> = {}) {
		const events = fakeListen();
		const invoke = vi.fn(async () => undefined as unknown);
		const restore = vi.fn();
		const popOut = createPanelPopOut({
			isTauri: () => true,
			invoke,
			listen: events.listen,
			restore,
			...overrides
		});
		return { popOut, invoke, restore, events };
	}

	it('has no onPopOut outside Tauri (the dock then draws no pop-out button)', () => {
		const { popOut, events } = setup({ isTauri: () => false });
		expect(popOut.onPopOut).toBeUndefined();
		const stop = popOut.connect();
		expect(events.listen).not.toHaveBeenCalled();
		stop();
	});

	it('hands the background to the window it opens, read at each open (Issue #1015)', async () => {
		let color: string | undefined = '#0b0b0b';
		const { popOut, invoke } = setup({ background: () => color });
		popOut.onPopOut!(MEMO);
		await tick();
		await tick();
		expect(invoke).toHaveBeenCalledWith(PANEL_OPEN_COMMAND, {
			id: 'memo',
			title: 'Memo',
			background: '#0b0b0b'
		});

		color = undefined;
		popOut.onPopOut!({ id: 'other', title: 'Other' });
		await tick();
		await tick();
		expect(invoke).toHaveBeenCalledWith(PANEL_OPEN_COMMAND, { id: 'other', title: 'Other' });
	});

	it('detaches the panel, then opens its window', async () => {
		const order: string[] = [];
		const detach = vi.fn(async () => {
			order.push('detach');
			return true;
		});
		const { popOut, invoke } = setup({ detach });
		invoke.mockImplementation(async () => {
			order.push('open');
		});

		popOut.onPopOut!(MEMO);
		await tick();
		await tick();

		expect(detach).toHaveBeenCalledWith(MEMO);
		expect(order).toEqual(['detach', 'open']);
	});

	it('opens straight away when there is nothing to detach', async () => {
		const { popOut, invoke } = setup();
		popOut.onPopOut!(MEMO);
		await tick();
		expect(invoke).toHaveBeenCalledWith(PANEL_OPEN_COMMAND, MEMO);
	});

	it('opens no window when the detach is refused', async () => {
		const { popOut, invoke, restore } = setup({ detach: async () => false });
		popOut.onPopOut!(MEMO);
		await tick();
		await tick();
		expect(invoke).not.toHaveBeenCalled();
		expect(restore).not.toHaveBeenCalled();
	});

	it('puts the panel back when its window could not be opened', async () => {
		const onError = vi.fn();
		const { popOut, invoke, restore } = setup({ detach: () => true, onError });
		invoke.mockRejectedValue('no permission');

		popOut.onPopOut!(MEMO);
		await tick();
		await tick();

		expect(restore).toHaveBeenCalledWith('memo');
		expect(onError).toHaveBeenCalledWith('no permission', MEMO);
	});

	it('restores the panel when its window is closed, until disconnected', async () => {
		const { popOut, restore, events } = setup();
		const stop = popOut.connect();
		await tick();

		events.fire('memo');
		expect(restore).toHaveBeenCalledWith('memo');

		stop();
		expect(events.unlisten).toHaveBeenCalledTimes(1);
	});
});

describe('createPanelPopOut and the closed-notice subscription', () => {
	function deferredListen() {
		let resolve!: (fn: () => void) => void;
		let reject!: (e: unknown) => void;
		const pending = new Promise<() => void>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		const listen = vi.fn(() => pending);
		return { listen, resolve, reject };
	}

	it('waits for the registration before it detaches and opens', async () => {
		const gate = deferredListen();
		const invoke = vi.fn(async () => undefined as unknown);
		const detach = vi.fn(async () => true);
		const popOut = createPanelPopOut({
			isTauri: () => true,
			invoke,
			listen: gate.listen,
			detach,
			restore: vi.fn()
		});
		popOut.connect();

		popOut.onPopOut!(MEMO);
		await tick();
		await tick();
		expect(detach).not.toHaveBeenCalled();
		expect(invoke).not.toHaveBeenCalled();

		gate.resolve(vi.fn());
		await tick();
		await tick();
		await tick();
		expect(detach).toHaveBeenCalledWith(MEMO);
		expect(invoke).toHaveBeenCalledWith(PANEL_OPEN_COMMAND, MEMO);
	});

	it('detaches nothing and reports the reason when the registration failed', async () => {
		const gate = deferredListen();
		const invoke = vi.fn(async () => undefined as unknown);
		const detach = vi.fn(async () => true);
		const restore = vi.fn();
		const onError = vi.fn();
		const popOut = createPanelPopOut({
			isTauri: () => true,
			invoke,
			listen: gate.listen,
			detach,
			restore,
			onError
		});
		popOut.connect();
		gate.reject('no event permission');
		await tick();

		popOut.onPopOut!(MEMO);
		await tick();
		await tick();

		expect(onError).toHaveBeenCalledWith('no event permission', MEMO);
		expect(detach).not.toHaveBeenCalled();
		expect(invoke).not.toHaveBeenCalled();
		expect(restore).not.toHaveBeenCalled();
	});

	it('also refuses a pop-out that was waiting when the registration failed', async () => {
		const gate = deferredListen();
		const detach = vi.fn(async () => true);
		const onError = vi.fn();
		const popOut = createPanelPopOut({
			isTauri: () => true,
			invoke: vi.fn(async () => undefined as unknown),
			listen: gate.listen,
			detach,
			restore: vi.fn(),
			onError
		});
		popOut.connect();
		popOut.onPopOut!(MEMO);
		await tick();

		gate.reject(new Error('boom'));
		await tick();
		await tick();

		expect(onError).toHaveBeenCalledTimes(1);
		expect(detach).not.toHaveBeenCalled();
	});

	it('drops a pop-out that was waiting when connect() was stopped', async () => {
		const gate = deferredListen();
		const invoke = vi.fn(async () => undefined as unknown);
		const detach = vi.fn(async () => true);
		const onError = vi.fn();
		const popOut = createPanelPopOut({
			isTauri: () => true,
			invoke,
			listen: gate.listen,
			detach,
			restore: vi.fn(),
			onError
		});
		const stop = popOut.connect();
		popOut.onPopOut!(MEMO);
		await tick();
		stop();

		const unlisten = vi.fn();
		gate.resolve(unlisten);
		for (let i = 0; i < 5; i++) await tick();

		expect(unlisten).toHaveBeenCalled();
		expect(detach).not.toHaveBeenCalled();
		expect(invoke).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
	});

	it('also drops it when connect() was stopped and started again meanwhile', async () => {
		const gate = deferredListen();
		const invoke = vi.fn(async () => undefined as unknown);
		const detach = vi.fn(async () => true);
		const popOut = createPanelPopOut({
			isTauri: () => true,
			invoke,
			listen: gate.listen,
			detach,
			restore: vi.fn()
		});
		const stop = popOut.connect();
		popOut.onPopOut!(MEMO);
		await tick();
		stop();
		popOut.connect();

		gate.resolve(vi.fn());
		for (let i = 0; i < 5; i++) await tick();

		expect(detach).not.toHaveBeenCalled();
		expect(invoke).not.toHaveBeenCalled();
	});

	it('opens no window and restores the panel when connect() stops during the detach', async () => {
		const fake = fakeListen();
		const invoke = vi.fn(async () => undefined as unknown);
		const restore = vi.fn();
		let finishDetach!: (ok: boolean) => void;
		const detach = vi.fn(() => new Promise<boolean>((res) => (finishDetach = res)));
		const popOut = createPanelPopOut({
			isTauri: () => true,
			invoke,
			listen: fake.listen,
			detach,
			restore
		});
		const stop = popOut.connect();
		await tick();

		popOut.onPopOut!(MEMO);
		await tick();
		await tick();
		expect(detach).toHaveBeenCalled();
		stop();

		finishDetach(true);
		for (let i = 0; i < 5; i++) await tick();

		expect(invoke).not.toHaveBeenCalled();
		expect(restore).toHaveBeenCalledWith('memo');
	});
});

describe('listPanelWindows', () => {
	it('asks the plugin for the open panel ids', async () => {
		const invoke = vi.fn(async () => ['memo', 'trend'] as unknown);
		await expect(listPanelWindows({ isTauri: () => true, invoke })).resolves.toEqual([
			'memo',
			'trend'
		]);
		expect(invoke).toHaveBeenCalledWith(PANEL_LIST_COMMAND);
		expect(PANEL_LIST_COMMAND).toBe('plugin:banto-tauri-panel|list');
	});

	it('answers nothing outside Tauri, without asking', async () => {
		const invoke = vi.fn(async () => ['memo'] as unknown);
		await expect(listPanelWindows({ isTauri: () => false, invoke })).resolves.toEqual([]);
		expect(invoke).not.toHaveBeenCalled();
	});

	it('rejects an answer that is not a list of ids', async () => {
		const invoke = vi.fn(async () => [1, 'memo'] as unknown);
		await expect(listPanelWindows({ isTauri: () => true, invoke })).rejects.toThrow(
			/did not answer/
		);
	});
});

describe('createPanelPopOut: which panels are out (#1013, #1014)', () => {
	/** A storage in memory; `state.ids` is what a restart would find. */
	function fakeStorage(initial: string[] = []) {
		const state = { ids: initial };
		return {
			state,
			storage: {
				load: vi.fn(() => [...state.ids]),
				save: vi.fn((ids: string[]) => {
					state.ids = [...ids];
				})
			}
		};
	}

	/** `invoke` of a plugin whose open windows are `open` (or whose `list` fails). */
	function fakePlugin(open: string[] | Error = []) {
		return vi.fn(async (command: string): Promise<unknown> => {
			if (command !== PANEL_LIST_COMMAND) return undefined;
			if (open instanceof Error) throw open;
			return open;
		});
	}

	function setup(overrides: Partial<Parameters<typeof createPanelPopOut>[0]> = {}) {
		const events = fakeListen();
		const restore = vi.fn();
		const invoke = fakePlugin();
		const popOut = createPanelPopOut({
			isTauri: () => true,
			invoke,
			listen: events.listen,
			restore,
			...overrides
		});
		return { popOut, invoke, restore, events };
	}

	it('remembers a popped-out panel until its window is closed', async () => {
		const { state, storage } = fakeStorage();
		const { popOut, restore, events } = setup({ storage, detach: () => true });
		popOut.connect();
		await tick();
		expect(popOut.isPoppedOut('memo')).toBe(false);

		popOut.onPopOut?.(MEMO);
		await tick();
		await tick();
		expect(popOut.isPoppedOut('memo')).toBe(true);
		expect(state.ids).toEqual(['memo']);

		events.fire('memo');
		expect(restore).toHaveBeenCalledWith('memo');
		expect(popOut.isPoppedOut('memo')).toBe(false);
		expect(state.ids).toEqual([]);
	});

	it('is already forgotten when restore runs', async () => {
		const seen: boolean[] = [];
		const ctx = setup({ restore: (id) => seen.push(ctx.popOut.isPoppedOut(id)) });
		ctx.popOut.connect();
		await tick();
		ctx.popOut.onPopOut?.(MEMO);
		await tick();
		ctx.events.fire('memo');
		expect(seen).toEqual([false]);
	});

	it('remembers nothing when the detach is refused', async () => {
		const { state, storage } = fakeStorage();
		const { popOut } = setup({ storage, detach: () => false });
		popOut.onPopOut?.(MEMO);
		await tick();
		expect(popOut.isPoppedOut('memo')).toBe(false);
		expect(storage.save).not.toHaveBeenCalled();
		expect(state.ids).toEqual([]);
	});

	it('forgets the panel when its window could not be opened', async () => {
		const { state, storage } = fakeStorage();
		const invoke = vi.fn(async () => {
			throw 'no permission';
		});
		const { popOut, restore } = setup({ storage, invoke, detach: () => true });
		popOut.onPopOut?.(MEMO);
		await tick();
		await tick();
		expect(restore).toHaveBeenCalledWith('memo');
		expect(popOut.isPoppedOut('memo')).toBe(false);
		expect(state.ids).toEqual([]);
	});

	it('tells subscribers when the answer changes, until they unsubscribe', async () => {
		const { popOut, events } = setup();
		const cb = vi.fn();
		const stop = popOut.subscribe(cb);
		popOut.connect();
		await tick();
		expect(cb).not.toHaveBeenCalled();

		popOut.onPopOut?.(MEMO);
		await tick();
		expect(cb).toHaveBeenCalledTimes(1);

		events.fire('memo');
		expect(cb).toHaveBeenCalledTimes(2);
		// A notice for a panel that was not out changes nothing.
		events.fire('memo');
		expect(cb).toHaveBeenCalledTimes(2);

		stop();
		popOut.onPopOut?.(MEMO);
		await tick();
		expect(cb).toHaveBeenCalledTimes(2);
	});

	it('focus brings the window of a popped-out panel to the front', async () => {
		const { popOut, invoke } = setup();
		popOut.onPopOut?.(MEMO);
		await tick();
		invoke.mockClear();

		await popOut.focus(MEMO);
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke).toHaveBeenCalledWith(PANEL_OPEN_COMMAND, { id: 'memo', title: 'Memo' });
	});

	it('focus opens nothing for a panel that is not popped out', async () => {
		const { popOut, invoke } = setup();
		await popOut.focus(MEMO);
		expect(invoke).not.toHaveBeenCalled();
	});

	it("focus rejects with the plugin's error", async () => {
		const { storage } = fakeStorage(['memo']);
		const invoke = vi.fn(async () => {
			throw 'no permission';
		});
		const { popOut } = setup({ storage, invoke });
		await expect(popOut.focus(MEMO)).rejects.toBe('no permission');
	});

	it('a list answer asked for before focus opened the window does not put the panel back (no dock-and-window double)', async () => {
		const { storage } = fakeStorage(['memo']);
		let answerList: (ids: string[]) => void = () => {};
		const invoke = vi.fn(async (command: string): Promise<unknown> => {
			if (command !== PANEL_LIST_COMMAND) return undefined;
			return new Promise<string[]>((resolve) => {
				answerList = resolve;
			});
		});
		const { popOut, restore } = setup({ storage, invoke });
		popOut.connect();
		await tick();
		await tick();
		expect(invoke).toHaveBeenCalledWith(PANEL_LIST_COMMAND);

		// The menu opens the window while the answer is on its way.
		await popOut.focus(MEMO);
		expect(invoke).toHaveBeenCalledWith(PANEL_OPEN_COMMAND, { id: 'memo', title: 'Memo' });
		answerList([]);
		await tick();
		await tick();
		expect(restore).not.toHaveBeenCalled();
		expect(popOut.isPoppedOut('memo')).toBe(true);
	});

	it('focus that fails to open a window puts the panel back when the plugin lists none, and still rejects', async () => {
		const { state, storage } = fakeStorage(['memo']);
		const invoke = vi.fn(async (command: string): Promise<unknown> => {
			if (command === PANEL_LIST_COMMAND) return [];
			throw 'no permission';
		});
		const { popOut, restore } = setup({ storage, invoke });
		await expect(popOut.focus(MEMO)).rejects.toBe('no permission');
		expect(restore).toHaveBeenCalledWith('memo');
		expect(popOut.isPoppedOut('memo')).toBe(false);
		expect(state.ids).toEqual([]);
	});

	it('focus that fails keeps the panel popped out when the plugin still lists its window', async () => {
		const { storage } = fakeStorage(['memo']);
		const invoke = vi.fn(async (command: string): Promise<unknown> => {
			if (command === PANEL_LIST_COMMAND) return ['memo'];
			throw 'no permission';
		});
		const { popOut, restore } = setup({ storage, invoke });
		await expect(popOut.focus(MEMO)).rejects.toBe('no permission');
		expect(restore).not.toHaveBeenCalled();
		expect(popOut.isPoppedOut('memo')).toBe(true);
	});

	it('connect() restores a remembered panel whose window is not open (the app was closed with it out)', async () => {
		const { state, storage } = fakeStorage(['memo']);
		const invoke = fakePlugin([]);
		const { popOut, restore } = setup({ storage, invoke });
		expect(popOut.isPoppedOut('memo')).toBe(true);

		popOut.connect();
		await tick();
		await tick();
		expect(invoke).toHaveBeenCalledWith(PANEL_LIST_COMMAND);
		expect(restore).toHaveBeenCalledTimes(1);
		expect(restore).toHaveBeenCalledWith('memo');
		expect(popOut.isPoppedOut('memo')).toBe(false);
		expect(state.ids).toEqual([]);
	});

	it('connect() leaves a remembered panel whose window is still open (a reload), and its closing restores it', async () => {
		const { state, storage } = fakeStorage(['memo', 'trend']);
		const { popOut, restore, events } = setup({ storage, invoke: fakePlugin(['memo']) });

		popOut.connect();
		await tick();
		await tick();
		expect(restore).toHaveBeenCalledTimes(1);
		expect(restore).toHaveBeenCalledWith('trend');
		expect(popOut.isPoppedOut('memo')).toBe(true);
		expect(state.ids).toEqual(['memo']);

		events.fire('memo');
		expect(restore).toHaveBeenCalledWith('memo');
		expect(state.ids).toEqual([]);
	});

	it('connect() does not ask the plugin when nothing is remembered', async () => {
		const { storage } = fakeStorage();
		const { popOut, invoke } = setup({ storage });
		popOut.connect();
		await tick();
		await tick();
		expect(invoke).not.toHaveBeenCalled();
	});

	it('restores nothing and reports the reason when the list fails (the panel stays popped out)', async () => {
		const { state, storage } = fakeStorage(['memo']);
		const failure = new Error('banto-tauri-panel.list not allowed');
		const onListError = vi.fn();
		const invoke = fakePlugin(failure);
		const { popOut, restore } = setup({ storage, invoke, onListError });

		popOut.connect();
		await tick();
		await tick();
		expect(onListError).toHaveBeenCalledWith(failure);
		expect(restore).not.toHaveBeenCalled();
		expect(popOut.isPoppedOut('memo')).toBe(true);
		expect(state.ids).toEqual(['memo']);

		// Not lost: the menu's focus opens its window again.
		invoke.mockClear();
		await popOut.focus(MEMO);
		expect(invoke).toHaveBeenCalledWith(PANEL_OPEN_COMMAND, { id: 'memo', title: 'Memo' });
	});

	it('also restores the panels without a window when the closed-notice subscription failed', async () => {
		const { storage } = fakeStorage(['memo']);
		const listen = vi.fn(async () => {
			throw new Error('event.listen not allowed');
		});
		const { popOut, restore } = setup({ storage, listen });
		popOut.connect();
		await tick();
		await tick();
		expect(restore).toHaveBeenCalledWith('memo');
	});

	it('restores nothing when connect() was stopped before the list answered', async () => {
		const { state, storage } = fakeStorage(['memo']);
		let answer!: (ids: string[]) => void;
		const invoke = vi.fn(() => new Promise<unknown>((resolve) => (answer = resolve)));
		const { popOut, restore } = setup({ storage, invoke });

		const stop = popOut.connect();
		await tick();
		stop();
		answer([]);
		await tick();
		expect(restore).not.toHaveBeenCalled();
		expect(state.ids).toEqual(['memo']);
	});

	it('does not restore twice when the closed notice comes before the list answers', async () => {
		const { storage } = fakeStorage(['memo']);
		let answer!: (ids: string[]) => void;
		const invoke = vi.fn(() => new Promise<unknown>((resolve) => (answer = resolve)));
		const { popOut, restore, events } = setup({ storage, invoke });

		popOut.connect();
		await tick();
		events.fire('memo');
		answer([]);
		await tick();
		expect(restore).toHaveBeenCalledTimes(1);
	});

	it('leaves alone a pop-out that is still opening its window when the list answers', async () => {
		const { storage } = fakeStorage(['trend']);
		let opened!: () => void;
		const invoke = vi.fn(async (command: string): Promise<unknown> => {
			if (command === PANEL_LIST_COMMAND) return [];
			await new Promise<void>((resolve) => (opened = resolve));
			return undefined;
		});
		const { popOut, restore } = setup({ storage, invoke });

		// Pressed before connect(): remembered, its window not built yet.
		popOut.onPopOut?.(MEMO);
		await tick();
		popOut.connect();
		await tick();
		await tick();
		expect(restore).toHaveBeenCalledTimes(1);
		expect(restore).toHaveBeenCalledWith('trend');
		expect(popOut.isPoppedOut('memo')).toBe(true);
		opened();
	});

	it('reads no memory and reports nothing popped out outside Tauri', () => {
		const { storage } = fakeStorage(['memo']);
		const { popOut } = setup({ storage, isTauri: () => false });
		expect(storage.load).not.toHaveBeenCalled();
		expect(popOut.isPoppedOut('memo')).toBe(false);
	});

	it('survives a storage that throws', async () => {
		const storage = {
			load: (): string[] => {
				throw new Error('blocked');
			},
			save: () => {
				throw new Error('quota');
			}
		};
		const { popOut, invoke } = setup({ storage });
		popOut.onPopOut?.(MEMO);
		await tick();
		expect(popOut.isPoppedOut('memo')).toBe(true);
		expect(invoke).toHaveBeenCalledWith(PANEL_OPEN_COMMAND, { id: 'memo', title: 'Memo' });
	});
});

describe('createPanelPopOut: a panel put back is remembered until its layout is saved (Issue #1019)', () => {
	/** A storage in memory; `state.ids` is what a restart would find. */
	function fakeStorage(initial: string[] = []) {
		const state = { ids: initial };
		return {
			state,
			storage: {
				load: vi.fn(() => [...state.ids]),
				save: vi.fn((ids: string[]) => {
					state.ids = [...ids];
				})
			}
		};
	}

	/** One `restore` whose "saved" answer the test gives by hand, per call. */
	function fakeRestore() {
		const answers: { resolve: (saved: boolean | void) => void; reject: (e: unknown) => void }[] =
			[];
		const restore = vi.fn(
			(_id: string) =>
				new Promise<boolean | void>((resolve, reject) => answers.push({ resolve, reject }))
		);
		return { restore, answers };
	}

	/** A start of the app: the plugin lists `open`, the pop-out reads `storage`. */
	function start(
		storage: ReturnType<typeof fakeStorage>['storage'],
		restore: (id: string) => void | boolean | Promise<boolean | void>,
		open: string[] = []
	) {
		const events = fakeListen();
		const popOut = createPanelPopOut({
			isTauri: () => true,
			invoke: vi.fn(async (command: string) => (command === PANEL_LIST_COMMAND ? open : undefined)),
			listen: events.listen,
			detach: () => true,
			restore,
			storage
		});
		return { popOut, events };
	}

	const settle = async () => {
		for (let i = 0; i < 6; i++) await Promise.resolve();
	};

	it('keeps the id stored while restore has not answered, though the panel is no longer popped out', async () => {
		const { state, storage } = fakeStorage(['memo']);
		const { restore, answers } = fakeRestore();
		const { popOut } = start(storage, restore);
		popOut.connect();
		await settle();
		expect(restore).toHaveBeenCalledWith('memo');
		expect(popOut.isPoppedOut('memo')).toBe(false);
		expect(state.ids).toEqual(['memo']);

		answers[0].resolve(true);
		await settle();
		expect(state.ids).toEqual([]);
	});

	it('a promise that resolves nothing also lets go of it', async () => {
		const { state, storage } = fakeStorage(['memo']);
		const { restore, answers } = fakeRestore();
		start(storage, restore).popOut.connect();
		await settle();
		answers[0].resolve();
		await settle();
		expect(state.ids).toEqual([]);
	});

	it.each([
		['resolves false', (a: { resolve: (saved: boolean) => void }) => a.resolve(false)],
		['rejects', (a: { reject: (e: unknown) => void }) => a.reject(new Error('offline'))]
	])(
		'keeps it for the next start when restore %s, and that start restores it again',
		async (_n, answer) => {
			const { state, storage } = fakeStorage(['memo']);
			const first = fakeRestore();
			start(storage, first.restore).popOut.connect();
			await settle();
			answer(first.answers[0]);
			await settle();
			expect(state.ids).toEqual(['memo']);

			// The next start: nothing but the storage survives.
			const second = fakeRestore();
			const { popOut } = start(storage, second.restore);
			expect(popOut.isPoppedOut('memo')).toBe(true);
			popOut.connect();
			await settle();
			expect(second.restore).toHaveBeenCalledTimes(1);
			expect(second.restore).toHaveBeenCalledWith('memo');
			second.answers[0].resolve(true);
			await settle();
			expect(state.ids).toEqual([]);
		}
	);

	it('restore returning false at once keeps it too; returning nothing forgets at once (as before #1019)', async () => {
		const kept = fakeStorage(['memo']);
		start(kept.storage, () => false).popOut.connect();
		await settle();
		expect(kept.state.ids).toEqual(['memo']);

		const forgotten = fakeStorage(['memo']);
		start(forgotten.storage, () => {}).popOut.connect();
		await settle();
		expect(forgotten.state.ids).toEqual([]);
	});

	it('keeps it when restore throws', async () => {
		const { state, storage } = fakeStorage();
		const { popOut, events } = start(storage, () => {
			throw new Error('dock is gone');
		});
		popOut.connect();
		await settle();
		popOut.onPopOut?.(MEMO);
		await settle();
		expect(() => events.fire('memo')).toThrow('dock is gone');
		expect(popOut.isPoppedOut('memo')).toBe(false);
		expect(state.ids).toEqual(['memo']);
	});

	it('once confirmed, nothing brings the panel back at the next start (the user may have closed it)', async () => {
		const { state, storage } = fakeStorage();
		const { restore, answers } = fakeRestore();
		const { popOut, events } = start(storage, restore);
		popOut.connect();
		await settle();
		popOut.onPopOut?.(MEMO);
		await settle();
		events.fire('memo');
		answers[0].resolve(true);
		await settle();
		expect(state.ids).toEqual([]);

		const next = fakeRestore();
		start(storage, next.restore).popOut.connect();
		await settle();
		expect(next.restore).not.toHaveBeenCalled();
	});

	it('a panel popped out again meanwhile stays remembered: the older answer is ignored', async () => {
		const { state, storage } = fakeStorage();
		const { restore, answers } = fakeRestore();
		const { popOut, events } = start(storage, restore);
		popOut.connect();
		await settle();
		popOut.onPopOut?.(MEMO);
		await settle();
		events.fire('memo');
		popOut.onPopOut?.(MEMO);
		await settle();
		expect(popOut.isPoppedOut('memo')).toBe(true);

		answers[0].resolve(true);
		await settle();
		expect(popOut.isPoppedOut('memo')).toBe(true);
		expect(state.ids).toEqual(['memo']);

		// Put back a second time: only this call's answer counts.
		events.fire('memo');
		expect(state.ids).toEqual(['memo']);
		answers[1].resolve(true);
		await settle();
		expect(state.ids).toEqual([]);
	});

	it('other panels come and go in the storage while one waits', async () => {
		const { state, storage } = fakeStorage();
		const { restore, answers } = fakeRestore();
		const { popOut, events } = start(storage, restore);
		popOut.connect();
		await settle();
		popOut.onPopOut?.(MEMO);
		await settle();
		events.fire('memo');
		popOut.onPopOut?.({ id: 'chart', title: 'Chart' });
		await settle();
		expect([...state.ids].sort()).toEqual(['chart', 'memo']);
		answers[0].resolve(true);
		await settle();
		expect(state.ids).toEqual(['chart']);
	});

	it('a late answer takes only its own id out of what another pop-out stored since', async () => {
		const { state, storage } = fakeStorage(['memo']);
		const { restore, answers } = fakeRestore();
		start(storage, restore).popOut.connect();
		await settle();
		// Another panel was stored meanwhile; this pop-out is still connected.
		state.ids = ['memo', 'chart'];
		answers[0].resolve(true);
		await settle();
		expect(state.ids).toEqual(['chart']);
	});

	it('a pop-out writes its list again when an older one emptied the storage meanwhile', async () => {
		const { state, storage } = fakeStorage(['memo']);
		const old = fakeRestore();
		const stopOld = start(storage, old.restore).popOut.connect();
		await settle();
		// Entered again: the new pop-out reads `memo` and starts its own put-back.
		stopOld();
		const fresh = start(storage, fakeRestore().restore);
		fresh.popOut.connect();
		await settle();
		// The old answer lands BEFORE the new pop-out: it rightly empties the storage...
		old.answers[0].resolve(true);
		await settle();
		expect(state.ids).toEqual([]);
		// ...and the new pop-out of `memo` must write it again, though its own last write was `memo`.
		fresh.popOut.onPopOut?.(MEMO);
		await settle();
		expect(fresh.popOut.isPoppedOut('memo')).toBe(true);
		expect(state.ids).toEqual(['memo']);
	});

	it('a late answer of a left screen does not erase a newer pop-out of the same panel', async () => {
		const { state, storage } = fakeStorage(['memo']);
		const old = fakeRestore();
		const stopOld = start(storage, old.restore).popOut.connect();
		await settle();
		// The screen is left (its connection stops) and entered again: a new pop-out on the same
		// storage pops `memo` out again.
		stopOld();
		const fresh = start(storage, fakeRestore().restore);
		fresh.popOut.connect();
		await settle();
		fresh.popOut.onPopOut?.(MEMO);
		await settle();
		expect(fresh.popOut.isPoppedOut('memo')).toBe(true);
		old.answers[0].resolve(true);
		await settle();
		expect(state.ids).toEqual(['memo']);
		expect(fresh.popOut.isPoppedOut('memo')).toBe(true);
	});

	it('a late answer still takes its id out when nobody else has written', async () => {
		const { state, storage } = fakeStorage(['memo', 'chart']);
		const { restore, answers } = fakeRestore();
		start(storage, restore).popOut.connect();
		await settle();
		answers[0].resolve(true);
		answers[1]?.resolve(true);
		await settle();
		expect(state.ids).toEqual([]);
	});

	it('without a storage the answer changes nothing visible', async () => {
		const events = fakeListen();
		const { restore, answers } = fakeRestore();
		const popOut = createPanelPopOut({
			isTauri: () => true,
			invoke: vi.fn(async () => []),
			listen: events.listen,
			restore
		});
		popOut.connect();
		await settle();
		popOut.onPopOut?.(MEMO);
		await settle();
		events.fire('memo');
		expect(popOut.isPoppedOut('memo')).toBe(false);
		answers[0].resolve(true);
		await settle();
		expect(popOut.isPoppedOut('memo')).toBe(false);
	});
});

describe('closePanelWindow', () => {
	it('invokes the plugin command with the id and answers whether a window was closed', async () => {
		const invoke = vi.fn(async () => true as unknown);
		await expect(closePanelWindow('memo', { isTauri: () => true, invoke })).resolves.toBe(true);
		expect(invoke).toHaveBeenCalledWith(PANEL_CLOSE_COMMAND, { id: 'memo' });
		expect(PANEL_CLOSE_COMMAND).toBe('plugin:banto-tauri-panel|close');

		invoke.mockResolvedValueOnce(false);
		await expect(closePanelWindow('memo', { isTauri: () => true, invoke })).resolves.toBe(false);
	});

	it('does nothing outside Tauri', async () => {
		const invoke = vi.fn(async () => true);
		await expect(closePanelWindow('memo', { isTauri: () => false, invoke })).resolves.toBe(false);
		expect(invoke).not.toHaveBeenCalled();
	});

	it("rejects with the plugin's error", async () => {
		const invoke = vi.fn(async () => {
			throw new Error('not allowed');
		});
		await expect(closePanelWindow('memo', { isTauri: () => true, invoke })).rejects.toThrow(
			'not allowed'
		);
	});
});

describe('createPanelPopOut: closeWindows (Issue #1021)', () => {
	const NOTES = { id: 'notes', title: 'Notes' };

	function fakeStorage(initial: string[] = []) {
		const state = { ids: initial };
		return {
			state,
			storage: {
				load: vi.fn(() => [...state.ids]),
				save: vi.fn((ids: string[]) => {
					state.ids = [...ids];
				})
			}
		};
	}

	/**
	 * A plugin with windows: `open` adds one, `list` answers them, `close`
	 * takes one away (`closeError` makes it fail instead). Unlike the real one
	 * it does not send the closed notice by itself: the test fires it, to
	 * choose when it arrives.
	 */
	function fakePlugin() {
		const plugin = {
			windows: new Set<string>(),
			closeError: null as Error | null,
			invoke: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
				const id = args?.id as string;
				if (command === PANEL_LIST_COMMAND) return [...plugin.windows];
				if (command === PANEL_OPEN_COMMAND) {
					plugin.windows.add(id);
					return undefined;
				}
				if (command === PANEL_CLOSE_COMMAND) {
					if (plugin.closeError) throw plugin.closeError;
					return plugin.windows.delete(id);
				}
				return undefined;
			})
		};
		return plugin;
	}

	function setup(overrides: Partial<Parameters<typeof createPanelPopOut>[0]> = {}) {
		const events = fakeListen();
		const restore = vi.fn();
		const plugin = fakePlugin();
		const { state, storage } = fakeStorage();
		const popOut = createPanelPopOut({
			isTauri: () => true,
			invoke: plugin.invoke,
			listen: events.listen,
			restore,
			storage,
			detach: () => true,
			...overrides
		});
		return { popOut, plugin, restore, events, state };
	}

	const settle = async () => {
		await tick();
		await tick();
	};

	/** Connects, then pops `memo` and `notes` out. */
	async function popOutBoth(popOut: ReturnType<typeof setup>['popOut']) {
		popOut.connect();
		await settle();
		popOut.onPopOut?.(MEMO);
		popOut.onPopOut?.(NOTES);
		await settle();
	}

	it('closes every popped-out window, forgets the panels and does not restore them', async () => {
		const { popOut, plugin, restore, events, state } = setup();
		await popOutBoth(popOut);
		expect([...state.ids].sort()).toEqual(['memo', 'notes']);
		expect([...plugin.windows].sort()).toEqual(['memo', 'notes']);
		const changed = vi.fn();
		popOut.subscribe(changed);

		const result = await popOut.closeWindows();

		expect(result).toEqual({ closed: ['memo', 'notes'], failed: [] });
		expect(plugin.invoke).toHaveBeenCalledWith(PANEL_CLOSE_COMMAND, { id: 'memo' });
		expect(plugin.invoke).toHaveBeenCalledWith(PANEL_CLOSE_COMMAND, { id: 'notes' });
		expect(plugin.windows.size).toBe(0);
		expect(popOut.isPoppedOut('memo')).toBe(false);
		expect(popOut.isPoppedOut('notes')).toBe(false);
		expect(state.ids).toEqual([]);
		expect(changed).toHaveBeenCalled();

		// The closed notices of those windows arrive afterwards: swallowed.
		events.fire('memo');
		events.fire('notes');
		expect(restore).not.toHaveBeenCalled();
		expect(state.ids).toEqual([]);
	});

	it('closes only the given ids', async () => {
		const { popOut, restore, events, state } = setup();
		await popOutBoth(popOut);

		await expect(popOut.closeWindows(['memo'])).resolves.toEqual({ closed: ['memo'], failed: [] });

		expect(popOut.isPoppedOut('memo')).toBe(false);
		expect(popOut.isPoppedOut('notes')).toBe(true);
		expect(state.ids).toEqual(['notes']);
		// The other window closes the usual way.
		events.fire('notes');
		expect(restore).toHaveBeenCalledTimes(1);
		expect(restore).toHaveBeenCalledWith('notes');
	});

	it('swallows a closed notice that arrives before the plugin has answered', async () => {
		const { popOut, plugin, restore, events, state } = setup();
		await popOutBoth(popOut);
		let answer!: (had: boolean) => void;
		plugin.invoke.mockImplementationOnce(() => new Promise<unknown>((r) => (answer = r)));

		const closing = popOut.closeWindows(['memo']);
		events.fire('memo');
		expect(restore).not.toHaveBeenCalled();
		answer(true);

		await expect(closing).resolves.toEqual({ closed: ['memo'], failed: [] });
		expect(popOut.isPoppedOut('memo')).toBe(false);
		expect(state.ids).toEqual(['notes']);
		expect(restore).not.toHaveBeenCalled();
	});

	it('swallows only one notice per closed window', async () => {
		const { popOut, restore, events } = setup();
		await popOutBoth(popOut);
		await popOut.closeWindows(['memo']);
		events.fire('memo');
		expect(restore).not.toHaveBeenCalled();

		// The next window of the same panel comes back as usual.
		popOut.onPopOut?.(MEMO);
		await settle();
		expect(popOut.isPoppedOut('memo')).toBe(true);
		events.fire('memo');
		expect(restore).toHaveBeenCalledWith('memo');
		expect(popOut.isPoppedOut('memo')).toBe(false);
	});

	it('leaves a panel whose window could not be closed popped out, and restores it when that window closes later', async () => {
		const { popOut, plugin, restore, events, state } = setup();
		await popOutBoth(popOut);
		const denied = new Error('banto-tauri-panel.close not allowed');
		plugin.closeError = denied;

		const result = await popOut.closeWindows();

		expect(result.closed).toEqual([]);
		expect(result.failed).toEqual([
			{ id: 'memo', error: denied },
			{ id: 'notes', error: denied }
		]);
		expect(popOut.isPoppedOut('memo')).toBe(true);
		expect(popOut.isPoppedOut('notes')).toBe(true);
		expect([...state.ids].sort()).toEqual(['memo', 'notes']);
		expect(restore).not.toHaveBeenCalled();

		// The user closes the window by hand: the usual way back.
		events.fire('memo');
		expect(restore).toHaveBeenCalledWith('memo');
		expect(popOut.isPoppedOut('memo')).toBe(false);
		expect(state.ids).toEqual(['notes']);
	});

	it('counts a window that went away while the close failed as closed', async () => {
		const { popOut, plugin, restore, events, state } = setup();
		await popOutBoth(popOut);
		let fail!: (error: Error) => void;
		plugin.invoke.mockImplementationOnce(() => new Promise<unknown>((_, r) => (fail = r)));

		const closing = popOut.closeWindows(['memo']);
		events.fire('memo');
		fail(new Error('window not found'));

		await expect(closing).resolves.toEqual({ closed: ['memo'], failed: [] });
		expect(restore).not.toHaveBeenCalled();
		expect(popOut.isPoppedOut('memo')).toBe(false);
		expect(state.ids).toEqual(['notes']);
		// No mark is left behind: a later notice for the id is a real one.
		events.fire('memo');
		expect(restore).toHaveBeenCalledWith('memo');
	});

	it('forgets a remembered panel that has no window, and waits for no notice', async () => {
		const { state, storage } = fakeStorage(['memo']);
		const events = fakeListen();
		const restore = vi.fn();
		const plugin = fakePlugin();
		// The list fails, so the remembered panel stays "popped out" with no window.
		plugin.invoke.mockRejectedValueOnce(new Error('list not allowed'));
		const popOut = createPanelPopOut({
			isTauri: () => true,
			invoke: plugin.invoke,
			listen: events.listen,
			restore,
			storage
		});
		popOut.connect();
		await settle();
		expect(popOut.isPoppedOut('memo')).toBe(true);

		await expect(popOut.closeWindows()).resolves.toEqual({ closed: ['memo'], failed: [] });
		expect(popOut.isPoppedOut('memo')).toBe(false);
		expect(state.ids).toEqual([]);
		expect(restore).not.toHaveBeenCalled();

		// The plugin said there was no window, so no notice is owed: one that
		// comes for the id later is a real one.
		events.fire('memo');
		expect(restore).toHaveBeenCalledWith('memo');
	});

	it('closes the windows of given ids this object does not remember', async () => {
		const { popOut, plugin, restore, events, state } = setup();
		popOut.connect();
		await settle();
		plugin.windows.add('memo');

		const result = await popOut.closeWindows(['memo', 'notes', 'memo']);

		expect(result).toEqual({ closed: ['memo', 'notes'], failed: [] });
		expect(plugin.windows.size).toBe(0);
		expect(state.ids).toEqual([]);
		events.fire('memo');
		expect(restore).not.toHaveBeenCalled();
		// `notes` had no window: nothing is swallowed for it.
		events.fire('notes');
		expect(restore).toHaveBeenCalledWith('notes');
	});

	it('does not close a window that is being opened', async () => {
		const { popOut, plugin, restore } = setup();
		popOut.connect();
		await settle();
		let opened!: () => void;
		plugin.invoke.mockImplementationOnce(
			() => new Promise<unknown>((r) => (opened = () => r(undefined)))
		);
		popOut.onPopOut?.(MEMO);
		await settle();
		expect(popOut.isPoppedOut('memo')).toBe(true);

		const result = await popOut.closeWindows();

		expect(result.closed).toEqual([]);
		expect(result.failed.map((f) => f.id)).toEqual(['memo']);
		expect(plugin.invoke).not.toHaveBeenCalledWith(PANEL_CLOSE_COMMAND, { id: 'memo' });
		opened();
		await settle();
		expect(popOut.isPoppedOut('memo')).toBe(true);
		expect(restore).not.toHaveBeenCalled();
	});

	it('keeps a panel that is popped out again while the plugin is asked (generation)', async () => {
		const { popOut, plugin, restore, events, state } = setup();
		await popOutBoth(popOut);
		let answer!: (had: boolean) => void;
		plugin.invoke.mockImplementationOnce(() => new Promise<unknown>((r) => (answer = r)));

		const closing = popOut.closeWindows(['memo']);
		// The old window's notice comes, then the user pops the panel out again
		// before the plugin has answered the close.
		events.fire('memo');
		popOut.onPopOut?.(MEMO);
		await settle();
		answer(true);

		const result = await closing;
		expect(result.closed).toEqual([]);
		expect(result.failed.map((f) => f.id)).toEqual(['memo']);
		expect(popOut.isPoppedOut('memo')).toBe(true);
		expect([...state.ids].sort()).toEqual(['memo', 'notes']);
		expect(restore).not.toHaveBeenCalled();
		// The new window's notice is not swallowed.
		events.fire('memo');
		expect(restore).toHaveBeenCalledWith('memo');
	});

	it('a later connect() does not restore the forgotten panels', async () => {
		const { popOut, restore, state } = setup();
		await popOutBoth(popOut);
		await popOut.closeWindows();

		popOut.connect();
		await settle();

		expect(restore).not.toHaveBeenCalled();
		expect(state.ids).toEqual([]);
	});

	it('drops the mark of a notice nobody will hear when the subscription stops', async () => {
		const { popOut, restore, events } = setup();
		const stop = popOut.connect();
		await settle();
		popOut.onPopOut?.(MEMO);
		await settle();
		await popOut.closeWindows();

		// The screen is left before the notice arrives, then entered again.
		stop();
		popOut.connect();
		await settle();
		popOut.onPopOut?.(MEMO);
		await settle();
		events.fire('memo');
		expect(restore).toHaveBeenCalledWith('memo');
	});

	it('an object made later over the same storage closes what it read from it', async () => {
		const first = setup();
		await popOutBoth(first.popOut);
		const { state, storage } = fakeStorage([...first.state.ids]);
		// The screen was left and entered again: a new object, the same windows.
		const second = setup({ storage, invoke: first.plugin.invoke });
		second.popOut.connect();
		await settle();
		expect(second.popOut.isPoppedOut('memo')).toBe(true);
		expect(second.restore).not.toHaveBeenCalled();

		const result = await second.popOut.closeWindows();

		expect(result.closed.sort()).toEqual(['memo', 'notes']);
		expect(first.plugin.windows.size).toBe(0);
		expect(state.ids).toEqual([]);
		second.events.fire('memo');
		expect(second.restore).not.toHaveBeenCalled();
	});

	it('shares one close between two calls made at once', async () => {
		const { popOut, plugin } = setup();
		await popOutBoth(popOut);
		const [a, b] = await Promise.all([
			popOut.closeWindows(['memo']),
			popOut.closeWindows(['memo'])
		]);
		expect(a).toEqual({ closed: ['memo'], failed: [] });
		expect(b).toEqual(a);
		const closes = plugin.invoke.mock.calls.filter(([command]) => command === PANEL_CLOSE_COMMAND);
		expect(closes).toHaveLength(1);
	});

	it('closing an id again before the closed notice has come does not restore it on that notice', async () => {
		const { popOut, restore, events } = setup();
		await popOutBoth(popOut);

		await expect(popOut.closeWindows(['memo'])).resolves.toEqual({ closed: ['memo'], failed: [] });
		// The notice of that window is still on its way; the id is closed again
		// (no window any more: the plugin answers `false`).
		await expect(popOut.closeWindows(['memo'])).resolves.toEqual({ closed: ['memo'], failed: [] });

		events.fire('memo');
		expect(restore).not.toHaveBeenCalled();
		expect(popOut.isPoppedOut('memo')).toBe(false);

		// Only that one notice was owed: the next window comes back as usual.
		popOut.onPopOut?.(MEMO);
		await settle();
		events.fire('memo');
		expect(restore).toHaveBeenCalledTimes(1);
	});

	it('a panel popped out again before the late notice of its closed window stays out of the dock', async () => {
		const { popOut, plugin, restore, events } = setup();
		await popOutBoth(popOut);
		await popOut.closeWindows(['memo']);
		// Popped out again before the first window's notice has come...
		popOut.onPopOut?.(MEMO);
		await settle();
		expect(popOut.isPoppedOut('memo')).toBe(true);
		// ...and the id is closed once more: a second window, a second notice.
		let answer!: (had: boolean) => void;
		plugin.invoke.mockImplementationOnce(() => new Promise<unknown>((r) => (answer = r)));
		const closing = popOut.closeWindows(['memo']);
		// The first window's notice, while the second close is in flight.
		events.fire('memo');
		expect(restore).not.toHaveBeenCalled();
		plugin.windows.delete('memo');
		answer(true);
		await expect(closing).resolves.toEqual({ closed: ['memo'], failed: [] });
		// The second window's notice.
		events.fire('memo');
		expect(restore).not.toHaveBeenCalled();
		expect(popOut.isPoppedOut('memo')).toBe(false);

		// Nothing is owed any more.
		popOut.onPopOut?.(MEMO);
		await settle();
		events.fire('memo');
		expect(restore).toHaveBeenCalledTimes(1);
	});

	it('with `saved`, keeps the closed ids in the storage until the layout is saved', async () => {
		const { popOut, plugin, restore, events, state } = setup();
		await popOutBoth(popOut);
		let answer!: (saved: boolean) => void;
		const saved = new Promise<boolean>((r) => (answer = r));

		const result = await popOut.closeWindows(['memo', 'notes', 'clock'], { saved });

		expect(result.closed.sort()).toEqual(['clock', 'memo', 'notes']);
		expect(plugin.windows.size).toBe(0);
		expect(popOut.isPoppedOut('memo')).toBe(false);
		expect(popOut.isPoppedOut('notes')).toBe(false);
		// Still remembered - but not an id that had no window and was not popped out.
		expect([...state.ids].sort()).toEqual(['memo', 'notes']);
		events.fire('memo');
		events.fire('notes');
		expect(restore).not.toHaveBeenCalled();
		expect([...state.ids].sort()).toEqual(['memo', 'notes']);

		answer(true);
		await settle();
		expect(state.ids).toEqual([]);
		expect(restore).not.toHaveBeenCalled();
	});

	it.each([
		['never answers', () => new Promise<boolean>(() => {})],
		['resolves false', () => Promise.resolve(false)],
		['rejects', () => Promise.reject(new Error('the write failed'))]
	])(
		'with a `saved` that %s, the next start restores the panel - harmlessly',
		async (_name, makeSaved) => {
			const first = setup();
			await popOutBoth(first.popOut);
			await first.popOut.closeWindows(['memo'], { saved: makeSaved() });
			await settle();
			expect([...first.state.ids].sort()).toEqual(['memo', 'notes']);
			first.plugin.windows.clear();

			// The next start: the layout that was read may or may not have the panel
			// (the reset was not saved / was saved without anybody hearing of it).
			const { state, storage } = fakeStorage([...first.state.ids]);
			const second = setup({ storage, invoke: first.plugin.invoke });
			second.popOut.connect();
			await settle();
			await settle();

			// Restored once each, like any panel whose window is gone; `restore`
			// for a panel the dock already shows has to do nothing (`dock.open`).
			expect(second.restore.mock.calls.map(([id]) => id).sort()).toEqual(['memo', 'notes']);
			expect(second.popOut.isPoppedOut('memo')).toBe(false);
			expect(state.ids).toEqual([]);
		}
	);

	it('a panel popped out again while `saved` is awaited is not forgotten by that answer', async () => {
		const { popOut, state } = setup();
		await popOutBoth(popOut);
		let answer!: (saved: boolean) => void;
		await popOut.closeWindows(['memo'], { saved: new Promise<boolean>((r) => (answer = r)) });
		popOut.onPopOut?.(MEMO);
		await settle();

		answer(true);
		await settle();
		expect(popOut.isPoppedOut('memo')).toBe(true);
		expect([...state.ids].sort()).toEqual(['memo', 'notes']);
	});

	it('with `saved`, a window that could not be closed stays popped out and remembered', async () => {
		const { popOut, plugin, state } = setup();
		await popOutBoth(popOut);
		plugin.closeError = new Error('not allowed');

		const result = await popOut.closeWindows(['memo'], { saved: Promise.resolve(true) });
		await settle();

		expect(result.failed.map((f) => f.id)).toEqual(['memo']);
		expect(popOut.isPoppedOut('memo')).toBe(true);
		expect([...state.ids].sort()).toEqual(['memo', 'notes']);
	});

	it('does nothing outside Tauri', async () => {
		const { popOut, plugin } = setup({ isTauri: () => false });
		await expect(popOut.closeWindows(['memo'])).resolves.toEqual({ closed: [], failed: [] });
		expect(plugin.invoke).not.toHaveBeenCalled();
	});
});
