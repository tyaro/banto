import { describe, expect, it, vi } from 'vitest';
import {
	PANEL_CLOSED_EVENT,
	PANEL_OPEN_COMMAND,
	createPanelPopOut,
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
