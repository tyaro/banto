import { describe, expect, it, vi } from 'vitest';
import {
	PANEL_CLOSED_EVENT,
	PANEL_LIST_COMMAND,
	PANEL_OPEN_COMMAND,
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
