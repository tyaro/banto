import { describe, expect, it } from 'vitest';
import type { DockLayout } from '@banto/dock-svelte';
import { createThreePaneLayoutTarget, type ThreePaneLayoutApi } from './threePaneLayoutTarget.js';

const EMPTY: DockLayout = { version: 2, floating: [], docked: null };
const DEFAULT = { schema: 1, name: 'default' };

function fakeDock(shown: object = DEFAULT) {
	const state = { shown, restored: [] as unknown[] };
	const api: ThreePaneLayoutApi = {
		layoutSnapshot: () => state.shown,
		restoreLayout: (saved) => {
			state.restored.push(saved);
			state.shown = saved === undefined ? DEFAULT : JSON.parse(String(saved));
			return Promise.resolve();
		}
	};
	return { state, api };
}

function make() {
	let current: ThreePaneLayoutApi | undefined;
	const target = createThreePaneLayoutTarget({ layout: EMPTY, autoHidden: [] }, () => current);
	return {
		target,
		mount(api: ThreePaneLayoutApi) {
			current = api;
			target.attach();
		}
	};
}

describe('createThreePaneLayoutTarget', () => {
	it('before the dock is mounted a stored value becomes initialLayout and is what serialize() says', () => {
		const { target } = make();
		expect(target.initialLayout).toBeUndefined();
		expect(target.hydrate('{"schema":1}')).toBe(true);
		expect(target.initialLayout).toBe('{"schema":1}');
		expect(target.serialize()).toBe('{"schema":1}');
	});

	it('rejects a stored value that is not a JSON object', () => {
		const { target } = make();
		expect(target.hydrate('nope')).toBe(false);
		expect(target.hydrate('42')).toBe(false);
		expect(target.hydrate('null')).toBe(false);
		expect(target.initialLayout).toBeUndefined();
	});

	it('after mounting, serialize() is the snapshot text and a stored value is installed with restoreLayout', async () => {
		const { state, api } = fakeDock();
		const { target, mount } = make();
		mount(api);
		expect(target.serialize()).toBe(JSON.stringify(DEFAULT));
		expect(target.hydrate('{"schema":1,"name":"saved"}')).toBe(true);
		// while it is being installed the stored text is the answer (not a user's change)
		expect(target.serialize()).toBe('{"schema":1,"name":"saved"}');
		await Promise.resolve();
		await Promise.resolve();
		expect(state.restored).toEqual(['{"schema":1,"name":"saved"}']);
		expect(target.serialize()).toBe('{"schema":1,"name":"saved"}');
	});

	it('serialize() still reads layoutSnapshot() while a stored value is being installed (keeps the effect dependency)', () => {
		const { api } = fakeDock();
		let reads = 0;
		const counting: ThreePaneLayoutApi = {
			layoutSnapshot: () => (reads++, api.layoutSnapshot()),
			restoreLayout: () => new Promise(() => {})
		};
		const { target, mount } = make();
		mount(counting);
		target.hydrate('{"schema":1,"name":"saved"}');
		reads = 0;
		expect(target.serialize()).toBe('{"schema":1,"name":"saved"}');
		expect(reads).toBe(1);
	});

	it('does not install a stored value that is already what is shown', () => {
		const { state, api } = fakeDock({ schema: 1, name: 'same' });
		const { target, mount } = make();
		mount(api);
		expect(target.hydrate(JSON.stringify({ schema: 1, name: 'same' }))).toBe(true);
		expect(state.restored).toEqual([]);
	});

	it('assigning the default skips the install while the dock still shows the default it started with', () => {
		const { state, api } = fakeDock();
		const { target, mount } = make();
		mount(api);
		target.layout = target.defaultLayout;
		expect(state.restored).toEqual([]);
		state.shown = { schema: 1, name: 'moved' };
		target.layout = target.defaultLayout;
		expect(state.restored).toEqual([undefined]);
	});

	it('a dock that started from a stored value is always re-installed to the default', () => {
		const { state, api } = fakeDock({ schema: 1, name: 'stored' });
		const { target, mount } = make();
		target.hydrate('{"schema":1,"name":"stored"}');
		mount(api);
		target.layout = target.defaultLayout;
		expect(state.restored).toEqual([undefined]);
	});

	it('ignores assignments while withoutApplying runs, and any layout that is not the default', () => {
		const { state, api } = fakeDock();
		const { target, mount } = make();
		mount(api);
		state.shown = { schema: 1, name: 'moved' };
		target.withoutApplying(() => {
			target.layout = target.defaultLayout;
		});
		target.layout = EMPTY;
		expect(state.restored).toEqual([]);
	});
});
