/**
 * `createSavedSetting` (shared-primitives-upstream-plan §3.4, Issue #437).
 * Runs against an injected `UiSettingsProvider` whose every call is a
 * manually settled promise, so success, failure, delay and answer order are
 * controlled by the test. (Reactivity is `$state`-backed; this node
 * environment runs Svelte's server build where effects do not run, so it is
 * not asserted here.)
 */
import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../src/errors';
import {
	createHttpUiSettings,
	uiSettingConflict,
	type UiSettingSnapshot,
	type UiSettingsProvider,
	type UiSettingWriteResult
} from '../src/providers/uiSettings';
import {
	createSavedSetting,
	type SavedSetting,
	type SavedSettingOptions
} from '../src/savedSetting.svelte';

interface Pending<R> {
	args: unknown[];
	resolve: (value: R) => void;
	reject: (error: unknown) => void;
}

/** A read answer in the provider's shape (#786). */
function stored(value: string | null): UiSettingSnapshot {
	return { value, revision: value === null ? '0' : 'rev' };
}

/** A write answer in the provider's shape (#786). */
function written(): UiSettingWriteResult {
	return { revision: 'rev' };
}

function manualProvider() {
	const gets: Pending<string | null>[] = [];
	const sets: Pending<void>[] = [];
	// The tests answer with the bare value / nothing; the provider's #786 shape
	// (`{ value, revision }` / `{ revision }`) is added here.
	const provider: UiSettingsProvider = {
		get: (key) =>
			new Promise<string | null>((resolve, reject) => {
				gets.push({ args: [key], resolve, reject });
			}).then(stored),
		set: (key, value) =>
			new Promise<void>((resolve, reject) => {
				sets.push({ args: [key, value], resolve, reject });
			}).then(written),
		remove: async () => ({ revision: '0' })
	};
	return { provider, gets, sets };
}

interface Pos {
	x: number;
}

function options(
	provider: UiSettingsProvider,
	extra: Partial<SavedSettingOptions<Pos>> = {}
): SavedSettingOptions<Pos> {
	return {
		provider,
		key: 'layout',
		parse: (raw: string) => {
			const o = JSON.parse(raw) as { v?: number; x?: unknown };
			return o.v === 1 && typeof o.x === 'number' ? { x: o.x } : undefined;
		},
		serialize: (value: Pos) => JSON.stringify({ v: 1, x: value.x }),
		fallback: () => ({ x: 0 }),
		...extra
	};
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const raw = (x: number) => JSON.stringify({ v: 1, x });

describe('save', () => {
	it('updates saved only after the provider succeeds', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 5 });
		expect(s.dirty).toBe(true);
		const done = s.save();
		expect(s.saving).toBe(true);
		expect(s.saved).toBeUndefined();
		expect(m.sets[0].args).toEqual(['layout', raw(5)]);
		m.sets[0].resolve();
		expect(await done).toBe(true);
		expect(s.saved).toEqual({ x: 5 });
		expect(s.saving).toBe(false);
		expect(s.dirty).toBe(false);
		expect(s.error).toBeNull();
	});

	it('keeps current and the previous saved on failure, and clears error on the next success', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 1 });
		const first = s.save();
		m.sets[0].resolve();
		await first;
		s.set({ x: 2 });
		const second = s.save();
		const failure = new ProviderError({ kind: 'storage', message: 'disk' });
		m.sets[1].reject(failure);
		expect(await second).toBe(false);
		expect(s.error).toBe(failure);
		expect(s.current).toEqual({ x: 2 });
		expect(s.saved).toEqual({ x: 1 });
		expect(s.dirty).toBe(true);
		const third = s.save();
		m.sets[2].resolve();
		expect(await third).toBe(true);
		expect(s.error).toBeNull();
		expect(s.saved).toEqual({ x: 2 });
	});

	it('treats a synchronous provider throw as a failure', async () => {
		const provider: UiSettingsProvider = {
			get: async () => stored(null),
			set: () => {
				throw new ProviderError({ kind: 'other', message: 'invalid ui-settings key' });
			},
			remove: async () => ({ revision: '0' })
		};
		const s = createSavedSetting(options(provider));
		expect(await s.save()).toBe(false);
		expect(s.error).toBeInstanceOf(ProviderError);
		expect(s.saving).toBe(false);
	});

	it('marks the snapshot that was sent, not an edit made during the send', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 1 });
		const done = s.save();
		s.set({ x: 2 }); // edited while x=1 is in flight
		m.sets[0].resolve();
		await done;
		expect(s.saved).toEqual({ x: 1 });
		expect(s.current).toEqual({ x: 2 });
		expect(s.dirty).toBe(true);
	});
});

describe('a write dropped by the provider (#707)', () => {
	it('is not treated as saved: save() is false, saved unchanged, error set', async () => {
		let token: string | null = 'tok-a';
		const calls: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((res) => (release = res));
		const gated = (async (_url: string, init: RequestInit) => {
			calls.push(String(init.body));
			await gate;
			return new Response(JSON.stringify({ revision: 'rev' }), { status: 200 });
		}) as unknown as typeof fetch;
		const provider = createHttpUiSettings({ getToken: () => token, fetchFn: gated });
		// An in-flight write for the same key holds the next one back.
		const inflight = provider.set('layout', raw(1));
		const s = createSavedSetting(options(provider));
		s.set({ x: 2 });
		const done = s.save();
		token = 'tok-b'; // the session changed while the write was held
		release();
		await inflight;
		expect(await done).toBe(false);
		expect(s.saved).toBeUndefined();
		expect(s.error).toBeInstanceOf(ProviderError);
		expect((s.error as ProviderError).body.kind).toBe('unauthorized');
		expect(calls).toEqual([JSON.stringify({ value: raw(1) })]);
	});
});

describe('concurrent saves (serialized and coalesced)', () => {
	it('sends one at a time and coalesces saves made meanwhile into one follow-up with the latest value', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 1 });
		const a = s.save();
		s.set({ x: 2 });
		const b = s.save();
		s.set({ x: 3 });
		const c = s.save();
		expect(m.sets).toHaveLength(1); // nothing else started
		m.sets[0].resolve();
		expect(await a).toBe(true);
		await flush();
		expect(m.sets).toHaveLength(2);
		expect(m.sets[1].args).toEqual(['layout', raw(3)]); // latest, not x=2
		m.sets[1].resolve();
		expect(await Promise.all([b, c])).toEqual([true, true]);
		expect(s.saved).toEqual({ x: 3 });
		expect(s.dirty).toBe(false);
		expect(m.sets).toHaveLength(2);
	});

	it('sends the follow-up after a failure (a retry with the latest value)', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 1 });
		const a = s.save();
		s.set({ x: 2 });
		const b = s.save();
		m.sets[0].reject(new Error('net'));
		expect(await a).toBe(false);
		await flush();
		m.sets[1].resolve();
		expect(await b).toBe(true);
		expect(s.saved).toEqual({ x: 2 });
		expect(s.error).toBeNull();
	});

	it('sends snapshots strictly in order, so a late answer cannot overwrite a later one', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 1 });
		const a = s.save();
		s.set({ x: 2 });
		const b = s.save();
		m.sets[0].resolve();
		await a;
		await flush();
		m.sets[1].resolve();
		await b;
		expect(m.sets.map((p) => p.args[1])).toEqual([raw(1), raw(2)]);
		expect(s.saved).toEqual({ x: 2 });
	});
});

describe('immediate mode', () => {
	it('sends after set() and coalesces a burst of sets', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider, { mode: 'immediate' }));
		s.set({ x: 1 });
		s.set({ x: 2 });
		s.set({ x: 3 });
		expect(m.sets).toHaveLength(1);
		m.sets[0].resolve();
		await flush();
		expect(m.sets).toHaveLength(2);
		expect(m.sets[1].args[1]).toBe(raw(3));
		m.sets[1].resolve();
		await flush();
		expect(s.saved).toEqual({ x: 3 });
		expect(s.dirty).toBe(false);
	});

	it('does not send a set that equals the saved value', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider, { mode: 'immediate' }));
		s.set({ x: 1 });
		m.sets[0].resolve();
		await flush();
		s.set({ x: 1 });
		expect(m.sets).toHaveLength(1);
	});

	it('explicit mode never sends on set()', () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 1 });
		expect(m.sets).toHaveLength(0);
	});
});

describe('load', () => {
	it('applies a stored value to current and saved', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const done = s.load();
		expect(s.loading).toBe(true);
		m.gets[0].resolve(raw(7));
		expect(await done).toBe('loaded');
		expect(s.current).toEqual({ x: 7 });
		expect(s.saved).toEqual({ x: 7 });
		expect(s.dirty).toBe(false);
		expect(s.loading).toBe(false);
	});

	it('missing: current is the fallback, saved stays undefined', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const done = s.load();
		m.gets[0].resolve(null);
		expect(await done).toBe('missing');
		expect(s.current).toEqual({ x: 0 });
		expect(s.saved).toBeUndefined();
		expect(s.dirty).toBe(false);
	});

	it.each([
		['broken JSON', '{nope'],
		['unknown version', JSON.stringify({ v: 99, x: 3 })],
		['wrong shape', JSON.stringify({ v: 1, x: 'a' })]
	])('invalid (%s): falls back to the default and reports invalid', async (_name, stored) => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider, { fallback: () => ({ x: 42 }) }));
		const done = s.load();
		m.gets[0].resolve(stored);
		expect(await done).toBe('invalid');
		expect(s.current).toEqual({ x: 42 });
		expect(s.saved).toBeUndefined();
		expect(s.error).toBeNull();
		// an explicit save can overwrite the broken stored value even though not dirty
		const saved = s.save();
		expect(m.sets[0].args[1]).toBe(raw(42));
		m.sets[0].resolve();
		expect(await saved).toBe(true);
		expect(s.saved).toEqual({ x: 42 });
	});

	it('provider failure: failed, current and saved untouched, error set', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 9 });
		const done = s.load();
		const failure = new ProviderError({ kind: 'unauthorized' });
		m.gets[0].reject(failure);
		expect(await done).toBe('failed');
		expect(s.error).toBe(failure);
		expect(s.current).toEqual({ x: 9 });
		expect(s.saved).toBeUndefined();
	});

	it('does not overwrite an edit made while loading, but records the stored value as saved', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const done = s.load();
		s.set({ x: 5 });
		m.gets[0].resolve(raw(7));
		expect(await done).toBe('loaded');
		expect(s.current).toEqual({ x: 5 });
		expect(s.saved).toEqual({ x: 7 });
		expect(s.dirty).toBe(true);
	});

	it('a stale load (answers swapped) is dropped; the newer load wins', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const first = s.load();
		const second = s.load();
		m.gets[1].resolve(raw(2)); // newer answers first
		expect(await second).toBe('loaded');
		m.gets[0].resolve(raw(1)); // older answers late
		expect(await first).toBe('stale');
		expect(s.current).toEqual({ x: 2 });
		expect(s.saved).toEqual({ x: 2 });
	});

	it('a load that raced with a save is dropped', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const load = s.load();
		s.set({ x: 3 });
		const save = s.save();
		m.gets[0].resolve(raw(1)); // read before the write landed
		expect(await load).toBe('stale');
		m.sets[0].resolve();
		await save;
		expect(s.saved).toEqual({ x: 3 });
		expect(s.current).toEqual({ x: 3 });
	});

	it('a stale load failure does not set error', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const first = s.load();
		const second = s.load();
		m.gets[1].resolve(raw(2));
		await second;
		m.gets[0].reject(new Error('late'));
		expect(await first).toBe('stale');
		expect(s.error).toBeNull();
	});
});

describe('revert / resetToDefault', () => {
	it('distinguishes returning to the saved value from the standard value', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider, { fallback: () => ({ x: 100 }) }));
		s.set({ x: 1 });
		const done = s.save();
		m.sets[0].resolve();
		await done;
		s.set({ x: 2 });
		s.revert();
		expect(s.current).toEqual({ x: 1 });
		expect(s.dirty).toBe(false);
		s.resetToDefault();
		expect(s.current).toEqual({ x: 100 });
		expect(s.saved).toEqual({ x: 1 }); // nothing is saved by either
		expect(s.dirty).toBe(true);
		expect(m.sets).toHaveLength(1);
	});

	it('revert with nothing saved goes to the standard value', () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider, { fallback: () => ({ x: 100 }) }));
		s.set({ x: 1 });
		s.revert();
		expect(s.current).toEqual({ x: 100 });
		expect(s.dirty).toBe(false);
	});
});

describe('dispose', () => {
	it('ignores the answer in flight and resolves the queue as false', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 1 });
		const a = s.save();
		const b = s.save();
		s.dispose();
		m.sets[0].resolve();
		expect(await a).toBe(false);
		expect(await b).toBe(false);
		expect(s.saved).toBeUndefined();
		expect(m.sets).toHaveLength(1);
		expect(await s.save()).toBe(false);
		expect(await s.load()).toBe('stale');
		expect(m.gets).toHaveLength(0);
	});

	it('drops a load in flight', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const done = s.load();
		s.dispose();
		m.gets[0].resolve(raw(7));
		expect(await done).toBe('stale');
		expect(s.current).toEqual({ x: 0 });
	});
});

describe('re-entrancy from callbacks', () => {
	it('provider.set that calls set() and save() re-entrantly queues one follow-up and keeps state consistent', async () => {
		const sets: Pending<void>[] = [];
		const ref: { setting?: SavedSetting<Pos> } = {};
		let reentered: Promise<boolean> | undefined;
		const provider: UiSettingsProvider = {
			get: async () => stored(null),
			set: (key, value) =>
				new Promise<void>((resolve, reject) => {
					sets.push({ args: [key, value], resolve, reject });
					if (sets.length === 1) {
						ref.setting?.set({ x: 2 });
						reentered = ref.setting?.save();
					}
				}).then(written),
			remove: async () => ({ revision: '0' })
		};
		const s = createSavedSetting(options(provider));
		ref.setting = s;
		s.set({ x: 1 });
		const first = s.save();
		expect(sets).toHaveLength(1); // the re-entrant save did not start a second send
		expect(s.saving).toBe(true);
		sets[0].resolve();
		expect(await first).toBe(true);
		expect(s.saved).toEqual({ x: 1 }); // the sent snapshot, not the re-entrant edit
		await flush();
		expect(sets).toHaveLength(2);
		expect(sets[1].args[1]).toBe(raw(2));
		sets[1].resolve();
		expect(await reentered).toBe(true);
		expect(s.saved).toEqual({ x: 2 });
		expect(s.dirty).toBe(false);
	});

	it('parse that edits the setting during load does not get its edit overwritten', async () => {
		const m = manualProvider();
		const ref: { setting?: SavedSetting<Pos> } = {};
		const s = createSavedSetting(
			options(m.provider, {
				parse: (stored) => {
					ref.setting?.set({ x: 50 });
					return { x: Number(stored) };
				}
			})
		);
		ref.setting = s;
		const done = s.load();
		m.gets[0].resolve('7');
		expect(await done).toBe('loaded');
		expect(s.current).toEqual({ x: 50 });
		expect(s.saved).toEqual({ x: 7 });
		expect(s.dirty).toBe(true);
	});

	it('fallback that disposes during load leaves nothing applied', async () => {
		const m = manualProvider();
		let calls = 0;
		const ref: { setting?: SavedSetting<Pos> } = {};
		const s = createSavedSetting(
			options(m.provider, {
				fallback: () => {
					if (++calls > 1) ref.setting?.dispose();
					return { x: 0 };
				}
			})
		);
		ref.setting = s;
		const done = s.load();
		m.gets[0].resolve(null);
		expect(await done).toBe('stale');
		expect(s.saved).toBeUndefined();
	});
});

describe('PR #442 review', () => {
	it('saved is an independent copy of what was sent, even if the caller mutates its object meanwhile', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const value = { x: 1 };
		s.set(value);
		const done = s.save();
		value.x = 99; // the caller mutates its own object while the send is pending
		m.sets[0].resolve();
		expect(await done).toBe(true);
		expect(m.sets[0].args[1]).toBe(raw(1));
		expect(s.saved).toEqual({ x: 1 });
		expect(s.saved).not.toBe(value);
	});

	it('a load started while a save is in flight is stale and does not roll current back', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 5 });
		const saving = s.save();
		expect(await s.load()).toBe('stale');
		expect(m.gets).toHaveLength(0); // it does not even read
		m.sets[0].resolve();
		expect(await saving).toBe(true);
		expect(s.current).toEqual({ x: 5 });
		expect(s.saved).toEqual({ x: 5 });
		expect(s.dirty).toBe(false);
	});
});

describe('PR #442 re-review', () => {
	it('after revert, editing current in place does not change saved', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		s.set({ x: 1 });
		const first = s.save();
		m.sets[0].resolve();
		expect(await first).toBe(true);
		s.revert();
		const v = s.current as Pos;
		v.x = 2;
		s.set(v);
		const second = s.save();
		m.sets[1].reject(new Error('offline'));
		expect(await second).toBe(false);
		expect(s.saved).toEqual({ x: 1 });
		s.revert();
		expect(s.current).toEqual({ x: 1 });
		expect(s.dirty).toBe(false);
	});

	it('after load, editing current in place does not change saved', async () => {
		const m = manualProvider();
		const s = createSavedSetting(options(m.provider));
		const loading = s.load();
		m.gets[0].resolve(raw(1));
		expect(await loading).toBe('loaded');
		const v = s.current as Pos;
		v.x = 7;
		expect(s.saved).toEqual({ x: 1 });
		expect(s.current).not.toBe(s.saved);
	});

	it('a parse that disposes during the success copy keeps the save from committing', async () => {
		const m = manualProvider();
		const ref: { s: SavedSetting<Pos> | null; armed: boolean } = { s: null, armed: false };
		const base = options(m.provider);
		const s = createSavedSetting({
			...base,
			parse: (text: string) => {
				if (ref.armed) ref.s?.dispose();
				return base.parse(text);
			}
		});
		ref.s = s;
		s.set({ x: 3 });
		const done = s.save();
		ref.armed = true;
		m.sets[0].resolve();
		expect(await done).toBe(false);
		expect(s.saved).toBeUndefined();
	});
});

// --- #786 C6: re-sending, merge, onSettled ---------------------------------

/** A tiny in-memory ui-settings server with revisions, failure scripting and a session switch. */
function fakeServer(initial: string | null = null) {
	let value = initial;
	let rev = initial === null ? 0 : 1;
	let session = 'a';
	const calls: { value: string; ifRevision: string | undefined }[] = [];
	/** Errors to throw for the next writes; `landed` = the write is applied, then the answer fails. */
	const script: { error: unknown; landed?: boolean }[] = [];
	const snapshot = (): UiSettingSnapshot => ({
		value,
		revision: value === null ? '0' : `r${rev}`
	});
	const provider: UiSettingsProvider = {
		get: async () => snapshot(),
		set: async (_key, next, opts) => {
			calls.push({ value: next, ifRevision: opts?.ifRevision });
			const step = script.shift();
			const conflict = opts?.ifRevision !== undefined && opts.ifRevision !== snapshot().revision;
			if (step && !step.landed) throw step.error;
			if (conflict) {
				throw new ProviderError({ kind: 'conflict', current: snapshot() } as never);
			}
			value = next;
			rev++;
			if (step) throw step.error;
			return { revision: `r${rev}` };
		},
		remove: async () => ({ revision: '0' }),
		sessionGuard() {
			const captured = session;
			return () => session === captured;
		}
	};
	return {
		provider,
		calls,
		script,
		/** Another writer changes the stored value. */
		external(next: string) {
			value = next;
			rev++;
		},
		stored: () => value,
		switchSession() {
			session = session + 'x';
		}
	};
}

const netError = () =>
	new ProviderError({ kind: 'other', message: 'x' }, { networkFailure: 'network' });

describe('re-sending a transient failure (#786 C6)', () => {
	it('re-sends after a network failure with a growing delay, then saves', async () => {
		vi.useFakeTimers();
		try {
			const s = fakeServer();
			s.script.push({ error: netError() }, { error: netError() });
			const settled: unknown[] = [];
			const setting = createSavedSetting(
				options(s.provider, { retry: {}, onSettled: (r) => settled.push(r) })
			);
			setting.set({ x: 5 });
			const result = setting.save();
			await vi.advanceTimersByTimeAsync(0);
			expect(s.calls).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(499);
			expect(s.calls).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(s.calls).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(999);
			expect(s.calls).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(1);
			expect(await result).toBe(true);
			expect(s.calls).toHaveLength(3);
			expect(setting.saved).toEqual({ x: 5 });
			expect(setting.error).toBeNull();
			expect(settled).toEqual([{ ok: true, value: { x: 5 }, error: null, attempts: 3 }]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('gives up after maxAttempts and keeps current and the previous saved', async () => {
		vi.useFakeTimers();
		try {
			const s = fakeServer();
			const err = netError();
			s.script.push({ error: err }, { error: err }, { error: err }, { error: err });
			const settled: { ok: boolean; attempts: number }[] = [];
			const setting = createSavedSetting(
				options(s.provider, { retry: {}, onSettled: (r) => settled.push(r) })
			);
			setting.set({ x: 5 });
			const result = setting.save();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(await result).toBe(false);
			expect(s.calls).toHaveLength(3);
			expect(setting.error).toBe(err);
			expect(setting.saved).toBeUndefined();
			expect(setting.current).toEqual({ x: 5 });
			expect(settled).toMatchObject([{ ok: false, attempts: 3 }]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not re-send what is not transient, or when retry is off', async () => {
		const cases: [ProviderError, Partial<SavedSettingOptions<Pos>>][] = [
			[new ProviderError({ kind: 'validation', field_errors: [] }), { retry: {} }],
			[new ProviderError({ kind: 'storage', message: 'db' }), { retry: {} }],
			[new ProviderError({ kind: 'other', message: 'HTTP 503' }), { retry: {} }],
			[netError(), {}],
			[netError(), { retry: false }],
			[netError(), { retry: { maxAttempts: 1 } }]
		];
		for (const [error, extra] of cases) {
			const s = fakeServer();
			s.script.push({ error });
			const setting = createSavedSetting(options(s.provider, extra));
			setting.set({ x: 5 });
			expect(await setting.save()).toBe(false);
			expect(s.calls).toHaveLength(1);
		}
	});

	it('isTransient decides what is re-sent', async () => {
		vi.useFakeTimers();
		try {
			const s = fakeServer();
			s.script.push({ error: new ProviderError({ kind: 'storage', message: 'busy' }) });
			const setting = createSavedSetting(
				options(s.provider, { retry: { isTransient: (e) => e instanceof ProviderError } })
			);
			setting.set({ x: 5 });
			const result = setting.save();
			await vi.advanceTimersByTimeAsync(1000);
			expect(await result).toBe(true);
			expect(s.calls).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('stops when the session changed during the wait (nothing is written for the new session)', async () => {
		vi.useFakeTimers();
		try {
			const s = fakeServer();
			s.script.push({ error: netError() });
			const setting = createSavedSetting(options(s.provider, { retry: {} }));
			setting.set({ x: 5 });
			const result = setting.save();
			await vi.advanceTimersByTimeAsync(100);
			s.switchSession();
			await vi.advanceTimersByTimeAsync(5000);
			expect(await result).toBe(false);
			expect(s.calls).toHaveLength(1);
			expect(s.stored()).toBeNull();
			expect((setting.error as ProviderError).body.kind).toBe('unauthorized');
		} finally {
			vi.useRealTimers();
		}
	});

	it('a save() made during the wait ends it and sends the latest value at once', async () => {
		vi.useFakeTimers();
		try {
			const s = fakeServer();
			s.script.push({ error: netError() });
			const setting = createSavedSetting(options(s.provider, { retry: {} }));
			setting.set({ x: 1 });
			const first = setting.save();
			await vi.advanceTimersByTimeAsync(100);
			setting.set({ x: 2 });
			const second = setting.save();
			await vi.advanceTimersByTimeAsync(0);
			expect(await first).toBe(false);
			expect(await second).toBe(true);
			expect(s.calls.map((c) => c.value)).toEqual([raw(1), raw(2)]);
			expect(setting.saved).toEqual({ x: 2 });
		} finally {
			vi.useRealTimers();
		}
	});

	it('dispose() during the wait stops the re-send and does not call onSettled', async () => {
		vi.useFakeTimers();
		try {
			const s = fakeServer();
			s.script.push({ error: netError() });
			const settled: unknown[] = [];
			const setting = createSavedSetting(
				options(s.provider, { retry: {}, onSettled: (r) => settled.push(r) })
			);
			setting.set({ x: 1 });
			const result = setting.save();
			await vi.advanceTimersByTimeAsync(100);
			setting.dispose();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(await result).toBe(false);
			expect(s.calls).toHaveLength(1);
			expect(settled).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('a throwing onSettled does not break the queue', async () => {
		const s = fakeServer();
		const setting = createSavedSetting(
			options(s.provider, {
				onSettled: () => {
					throw new Error('observer');
				}
			})
		);
		setting.set({ x: 1 });
		const a = setting.save();
		setting.set({ x: 2 });
		const b = setting.save();
		expect(await a).toBe(true);
		expect(await b).toBe(true);
	});
});

describe('merge (#786 C6)', () => {
	const merge = (server: Pos, current: Pos): Pos => ({ x: server.x + current.x });

	it('without merge the write stays unconditional', async () => {
		const s = fakeServer(raw(1));
		const setting = createSavedSetting(options(s.provider));
		await setting.load();
		setting.set({ x: 5 });
		expect(await setting.save()).toBe(true);
		expect(s.calls).toEqual([{ value: raw(5), ifRevision: undefined }]);
	});

	it('writes with the revision of the last read, and the one of the last write', async () => {
		const s = fakeServer(raw(1));
		const setting = createSavedSetting(options(s.provider, { merge }));
		await setting.load();
		setting.set({ x: 2 });
		await setting.save();
		setting.set({ x: 3 });
		await setting.save();
		expect(s.calls.map((c) => c.ifRevision)).toEqual(['r1', 'r2']);
	});

	it('a conflict is merged with the stored value and written from the returned revision', async () => {
		const s = fakeServer(raw(1));
		const setting = createSavedSetting(options(s.provider, { merge }));
		await setting.load();
		s.external(raw(10));
		setting.set({ x: 5 });
		expect(await setting.save()).toBe(true);
		expect(s.calls.map((c) => [c.value, c.ifRevision])).toEqual([
			[raw(5), 'r1'],
			[raw(15), 'r2']
		]);
		expect(s.stored()).toBe(raw(15));
		expect(setting.saved).toEqual({ x: 15 });
		// untouched since the send started: the editing value shows the merge
		expect(setting.current).toEqual({ x: 15 });
		expect(setting.dirty).toBe(false);
	});

	it('an edit made during the send keeps current as the user has it', async () => {
		const s = fakeServer(raw(1));
		const setting = createSavedSetting(options(s.provider, { merge }));
		await setting.load();
		s.external(raw(10));
		setting.set({ x: 5 });
		const p = setting.save();
		setting.set({ x: 9 });
		expect(await p).toBe(true);
		expect(setting.current).toEqual({ x: 9 });
		expect(setting.saved).toEqual({ x: 15 });
		expect(setting.dirty).toBe(true);
	});

	it('a first save over an existing value (nothing read) conflicts and is merged, not overwritten', async () => {
		const s = fakeServer(raw(10));
		const setting = createSavedSetting(options(s.provider, { merge }));
		setting.set({ x: 5 });
		expect(await setting.save()).toBe(true);
		expect(s.calls[0]!.ifRevision).toBe('0');
		expect(s.stored()).toBe(raw(15));
	});

	it('an unusable stored value is not merged: the snapshot is written over it', async () => {
		const s = fakeServer('not json');
		const seen: Pos[] = [];
		const setting = createSavedSetting(
			options(s.provider, {
				merge: (server, current) => {
					seen.push(server);
					return current;
				}
			})
		);
		setting.set({ x: 5 });
		expect(await setting.save()).toBe(true);
		expect(seen).toEqual([]);
		expect(s.stored()).toBe(raw(5));
	});

	it('gives up after MAX_CONFLICT_ATTEMPTS rounds with the conflict as the error', async () => {
		const s = fakeServer(raw(1));
		const setting = createSavedSetting(
			options(s.provider, {
				merge: (server, current) => {
					s.external(raw(server.x + 1)); // somebody wins again every time
					return { x: server.x + current.x };
				}
			})
		);
		await setting.load();
		s.external(raw(2));
		setting.set({ x: 5 });
		expect(await setting.save()).toBe(false);
		expect(s.calls).toHaveLength(5);
		expect(uiSettingConflict(setting.error)).not.toBeNull();
	});

	it('a throwing merge fails the save with that error and keeps current', async () => {
		const s = fakeServer(raw(1));
		const boom = new Error('merge');
		const setting = createSavedSetting(
			options(s.provider, {
				merge: () => {
					throw boom;
				}
			})
		);
		await setting.load();
		s.external(raw(2));
		setting.set({ x: 5 });
		expect(await setting.save()).toBe(false);
		expect(setting.error).toBe(boom);
		expect(setting.current).toEqual({ x: 5 });
		expect(s.stored()).toBe(raw(2));
	});

	it('a lost answer: the re-send conflicts with the value just sent, which counts as saved (no merge)', async () => {
		vi.useFakeTimers();
		try {
			const s = fakeServer(raw(1));
			s.script.push({ error: netError(), landed: true });
			const merged: Pos[] = [];
			const setting = createSavedSetting(
				options(s.provider, {
					retry: {},
					merge: (server, current) => {
						merged.push(server);
						return current;
					}
				})
			);
			await setting.load();
			setting.set({ x: 5 });
			const result = setting.save();
			await vi.advanceTimersByTimeAsync(1000);
			expect(await result).toBe(true);
			expect(merged).toEqual([]);
			expect(s.stored()).toBe(raw(5));
			expect(setting.saved).toEqual({ x: 5 });
			// the next save continues from the revision the conflict returned
			setting.set({ x: 6 });
			expect(await setting.save()).toBe(true);
			expect(s.calls[s.calls.length - 1]!.ifRevision).toBe('r2');
		} finally {
			vi.useRealTimers();
		}
	});

	it('a revision read in another session is not used ("0" instead)', async () => {
		const s = fakeServer(raw(1));
		const setting = createSavedSetting(options(s.provider, { merge }));
		await setting.load();
		s.switchSession();
		setting.set({ x: 5 });
		await setting.save();
		expect(s.calls[0]!.ifRevision).toBe('0');
	});

	it('stops merging when the session changed meanwhile', async () => {
		const s = fakeServer(raw(1));
		const setting = createSavedSetting(
			options(s.provider, {
				merge: (server, current) => {
					s.switchSession();
					return { x: server.x + current.x };
				}
			})
		);
		await setting.load();
		s.external(raw(10));
		setting.set({ x: 5 });
		expect(await setting.save()).toBe(false);
		expect(s.calls).toHaveLength(1);
		expect((setting.error as ProviderError).body.kind).toBe('unauthorized');
	});
});

describe('PR #877 review (#786 C6)', () => {
	it('a throwing isTransient fails the send normally and the queued follow-up still runs', async () => {
		const s = fakeServer();
		s.script.push({ error: netError() });
		const setting = createSavedSetting(
			options(s.provider, {
				retry: {
					isTransient: () => {
						throw new Error('classifier');
					}
				}
			})
		);
		setting.set({ x: 1 });
		const first = setting.save();
		setting.set({ x: 2 });
		const second = setting.save();
		expect(await first).toBe(false);
		expect(await second).toBe(true);
		expect(s.stored()).toBe(raw(2));
	});

	it('a save() made from onSettled joins the queue instead of overlapping the follow-up', async () => {
		const { provider, sets } = manualProvider();
		let again = false;
		const setting = createSavedSetting(
			options(provider, {
				onSettled: () => {
					if (again) return;
					again = true;
					setting.set({ x: 3 });
					void setting.save();
				}
			})
		);
		setting.set({ x: 1 });
		const first = setting.save();
		setting.set({ x: 2 });
		const second = setting.save();
		sets[0]!.resolve();
		await first;
		// one follow-up (carrying the latest value), not two overlapping sends
		await Promise.resolve();
		expect(sets).toHaveLength(2);
		expect(setting.saving).toBe(true);
		sets[1]!.resolve();
		expect(await second).toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(sets).toHaveLength(2);
		expect(setting.saved).toEqual({ x: 3 });
	});

	it('a follow-up accepted under another session is not sent', async () => {
		const sets: { resolve: () => void }[] = [];
		let session = 'a';
		const stored: string[] = [];
		const provider: UiSettingsProvider = {
			get: async () => ({ value: null, revision: '0' }),
			set: (_k, v) =>
				new Promise((resolve) => {
					sets.push({
						resolve: () => {
							stored.push(v);
							resolve({ revision: 'r' });
						}
					});
				}),
			remove: async () => ({ revision: '0' }),
			sessionGuard() {
				const captured = session;
				return () => session === captured;
			}
		};
		const setting = createSavedSetting(options(provider));
		setting.set({ x: 1 });
		const first = setting.save();
		setting.set({ x: 2 });
		const second = setting.save(); // accepted under session a
		session = 'b';
		sets[0]!.resolve();
		expect(await first).toBe(false); // saved for a session that ended: not applied
		expect(await second).toBe(false);
		expect(sets).toHaveLength(1);
		expect(stored).toEqual([raw(1)]);
		expect(setting.saved).toBeUndefined();
		expect((setting.error as ProviderError).body.kind).toBe('unauthorized');
	});

	it('a load answered after the session changed is not applied', async () => {
		let session = 'a';
		let answer!: (v: UiSettingSnapshot) => void;
		const provider: UiSettingsProvider = {
			get: () => new Promise((resolve) => (answer = resolve)),
			set: async () => ({ revision: 'r' }),
			remove: async () => ({ revision: '0' }),
			sessionGuard() {
				const captured = session;
				return () => session === captured;
			}
		};
		const setting = createSavedSetting(options(provider));
		const loading = setting.load();
		session = 'b';
		answer({ value: raw(7), revision: 'r1' });
		expect(await loading).toBe('stale');
		expect(setting.saved).toBeUndefined();
		expect(setting.current).toEqual({ x: 0 });
	});
});

describe('PR #877 re-review (#786 C6)', () => {
	function sessionProvider(onSet: (value: string, resolve: () => void) => void) {
		let session = 'a';
		const provider: UiSettingsProvider = {
			get: async () => ({ value: null, revision: '0' }),
			set: (_k, v) => new Promise((resolve) => onSet(v, () => resolve({ revision: 'r' }))),
			remove: async () => ({ revision: '0' }),
			sessionGuard() {
				const captured = session;
				return () => session === captured;
			}
		};
		return { provider, switchSession: () => (session += 'x') };
	}

	it('a save accepted under the new session does not share the old session follow-up result', async () => {
		const sets: { value: string; resolve: () => void }[] = [];
		const { provider, switchSession } = sessionProvider((value, resolve) =>
			sets.push({ value, resolve })
		);
		const setting = createSavedSetting(options(provider));
		setting.set({ x: 1 });
		const first = setting.save();
		setting.set({ x: 2 });
		const oldCaller = setting.save(); // queued under session a
		switchSession();
		setting.set({ x: 3 });
		const newCaller = setting.save(); // accepted under session b
		expect(await oldCaller).toBe(false);
		sets[0]!.resolve();
		expect(await first).toBe(false);
		await Promise.resolve();
		await Promise.resolve();
		expect(sets).toHaveLength(2);
		expect(sets[1]!.value).toBe(raw(3));
		sets[1]!.resolve();
		expect(await newCaller).toBe(true);
	});

	it('a conflict answered after the session changed is not handed to merge', async () => {
		const s = fakeServer(raw(1));
		const merged: Pos[] = [];
		const base = s.provider;
		const provider: UiSettingsProvider = {
			...base,
			set: async (k, v, o) => {
				try {
					return await base.set(k, v, o);
				} finally {
					s.switchSession(); // the account changes while the answer is on its way
				}
			}
		};
		const setting = createSavedSetting(
			options(provider, {
				merge: (server, current) => {
					merged.push(server);
					return current;
				}
			})
		);
		await setting.load();
		s.external(raw(10));
		setting.set({ x: 5 });
		expect(await setting.save()).toBe(false);
		expect(merged).toEqual([]);
		expect((setting.error as ProviderError).body.kind).toBe('unauthorized');
	});

	it('a load failure answered after the session changed does not set error', async () => {
		let session = 'a';
		let fail!: (e: unknown) => void;
		const provider: UiSettingsProvider = {
			get: () => new Promise((_, reject) => (fail = reject)),
			set: async () => ({ revision: 'r' }),
			remove: async () => ({ revision: '0' }),
			sessionGuard() {
				const captured = session;
				return () => session === captured;
			}
		};
		const setting = createSavedSetting(options(provider));
		const loading = setting.load();
		session = 'b';
		fail(new Error('old'));
		expect(await loading).toBe('stale');
		expect(setting.error).toBeNull();
	});
});
