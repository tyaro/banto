/**
 * `createPaletteSourceSearch` (#711): debounce, per-source state, abort of a
 * superseded request, and "an old answer never overwrites a newer query".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaletteCommand, PaletteSource } from '../src/commands';
import { createPaletteSourceSearch } from '../src/paletteSources.svelte';

function command(id: string): PaletteCommand {
	return { id, title: id, group: 'g', run: () => {} };
}

interface Deferred {
	query: string;
	signal: AbortSignal;
	resolve: (items: PaletteCommand[]) => void;
	reject: (error: unknown) => void;
}

/** A source whose every call is parked until the test settles it. */
function parkedSource(id: string, extra: Partial<PaletteSource> = {}) {
	const calls: Deferred[] = [];
	const source: PaletteSource = {
		id,
		group: `group-${id}`,
		search: (query, signal) =>
			new Promise<PaletteCommand[]>((resolve, reject) => {
				calls.push({ query, signal, resolve, reject });
			}),
		...extra
	};
	return { source, calls };
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('createPaletteSourceSearch', () => {
	it('waits for the debounce, then runs every visible source once with the trimmed query', async () => {
		const a = parkedSource('a');
		const b = parkedSource('b', { visible: () => false });
		const runner = createPaletteSourceSearch([a.source, b.source], { debounceMs: 200 });
		runner.setQuery('  foo ');
		runner.setQuery('  foo');
		expect(runner.states.map((s) => [s.id, s.status])).toEqual([['a', 'pending']]);
		vi.advanceTimersByTime(199);
		expect(a.calls).toHaveLength(0);
		vi.advanceTimersByTime(1);
		expect(a.calls.map((c) => c.query)).toEqual(['foo']);
		expect(b.calls).toHaveLength(0);
		a.calls[0].resolve([command('x')]);
		await flush();
		expect(runner.states[0]).toMatchObject({ status: 'ready', group: 'group-a' });
		expect(runner.states[0].items.map((i) => i.id)).toEqual(['x']);
	});

	it('keeps at most `limit` items per source', async () => {
		const a = parkedSource('a');
		const runner = createPaletteSourceSearch([a.source], { debounceMs: 0, limit: 2 });
		runner.setQuery('q');
		vi.advanceTimersByTime(0);
		a.calls[0].resolve([command('1'), command('2'), command('3')]);
		await flush();
		expect(runner.states[0].items.map((i) => i.id)).toEqual(['1', '2']);
	});

	it('a slow source stays pending while a fast one is ready; a failing one is marked error', async () => {
		const slow = parkedSource('slow');
		const fast = parkedSource('fast');
		const broken = parkedSource('broken');
		const runner = createPaletteSourceSearch([slow.source, fast.source, broken.source], {
			debounceMs: 0
		});
		runner.setQuery('q');
		vi.advanceTimersByTime(0);
		fast.calls[0].resolve([command('f')]);
		broken.calls[0].reject(new Error('boom'));
		await flush();
		expect(Object.fromEntries(runner.states.map((s) => [s.id, s.status]))).toEqual({
			slow: 'pending',
			fast: 'ready',
			broken: 'error'
		});
	});

	it('a newer query aborts the earlier request and the old answer never overwrites it', async () => {
		const a = parkedSource('a');
		const runner = createPaletteSourceSearch([a.source], { debounceMs: 0 });
		runner.setQuery('fo');
		vi.advanceTimersByTime(0);
		const first = a.calls[0];
		runner.setQuery('foo');
		expect(first.signal.aborted).toBe(true);
		expect(runner.states[0]).toMatchObject({ status: 'pending', items: [] });
		vi.advanceTimersByTime(0);
		const second = a.calls[1];
		// The newer answer lands first, then the stale one arrives late.
		second.resolve([command('new')]);
		await flush();
		first.resolve([command('old')]);
		await flush();
		expect(runner.states[0].items.map((i) => i.id)).toEqual(['new']);
	});

	it('a stale failure does not mark the current request as failed', async () => {
		const a = parkedSource('a');
		const runner = createPaletteSourceSearch([a.source], { debounceMs: 0 });
		runner.setQuery('a');
		vi.advanceTimersByTime(0);
		const first = a.calls[0];
		runner.setQuery('ab');
		vi.advanceTimersByTime(0);
		first.reject(new DOMException('aborted', 'AbortError'));
		await flush();
		expect(runner.states[0].status).toBe('pending');
	});

	it('typing before the debounce fires never starts the earlier query', () => {
		const a = parkedSource('a');
		const runner = createPaletteSourceSearch([a.source], { debounceMs: 200 });
		runner.setQuery('a');
		vi.advanceTimersByTime(100);
		runner.setQuery('ab');
		vi.advanceTimersByTime(199);
		expect(a.calls).toHaveLength(0);
		vi.advanceTimersByTime(1);
		expect(a.calls.map((c) => c.query)).toEqual(['ab']);
	});

	it('an empty query clears the states and cancels what is in flight', () => {
		const a = parkedSource('a');
		const runner = createPaletteSourceSearch([a.source], { debounceMs: 0 });
		runner.setQuery('a');
		vi.advanceTimersByTime(0);
		runner.setQuery('   ');
		expect(a.calls[0].signal.aborted).toBe(true);
		expect(runner.states).toEqual([]);
	});

	it('dispose aborts requests, drops the answer and ignores later queries', async () => {
		const a = parkedSource('a');
		const runner = createPaletteSourceSearch([a.source], { debounceMs: 0 });
		runner.setQuery('a');
		vi.advanceTimersByTime(0);
		runner.dispose();
		expect(a.calls[0].signal.aborted).toBe(true);
		a.calls[0].resolve([command('late')]);
		await flush();
		expect(runner.states).toEqual([]);
		runner.setQuery('b');
		vi.advanceTimersByTime(0);
		expect(a.calls).toHaveLength(1);
		expect(runner.states).toEqual([]);
	});

	it('visibility is evaluated per query (a role change takes effect)', () => {
		let allowed = false;
		const a = parkedSource('a', { visible: () => allowed });
		const runner = createPaletteSourceSearch([a.source], { debounceMs: 0 });
		runner.setQuery('x');
		expect(runner.states).toEqual([]);
		allowed = true;
		runner.setQuery('xy');
		expect(runner.states).toHaveLength(1);
	});
});
