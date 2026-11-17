import { describe, expect, it } from 'vitest';
import { advanceLockVersion, createRowSaveQueue } from './rowSaveQueue';

// Issue #284 regression tests. Both ResourceClientGrid and ResourceServerGrid route
// their inline edits (onCellEdit) and range pastes (onRangePaste) through the
// single queue created in ResourceListPage.svelte, so these cover both grid paths.

interface Row {
	id: number;
	name: string;
	price: number;
	stock: number;
}

const original: Row = { id: 1, name: 'original', price: 100, stock: 10 };

function compose(base: Row, changes: Record<string, unknown>): Record<string, unknown> {
	return { name: base.name, price: base.price, stock: base.stock, ...changes };
}

/** A fake provider whose responses are resolved/rejected by hand, in any order. */
function setup() {
	const server = new Map<number, Row>([
		[1, { ...original }],
		[2, { ...original, id: 2 }]
	]);
	const sent: Record<string, unknown>[] = [];
	const gates: { resolve: () => void; reject: (e: Error) => void }[] = [];
	const queue = createRowSaveQueue<Row>({
		compose,
		save: (rowId, values) => {
			sent.push(values);
			return new Promise<Row>((resolve, reject) => {
				gates.push({
					resolve: () => {
						const next = { ...server.get(rowId as number)!, ...values } as Row;
						server.set(rowId as number, next);
						resolve(next);
					},
					reject
				});
			});
		}
	});
	return { queue, server, sent, gates };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createRowSaveQueue', () => {
	it('keeps both columns when a second paste starts before the first save returns', async () => {
		const { queue, server, sent, gates } = setup();
		const a = queue.enqueue(1, original, { name: 'pasted-name' });
		const b = queue.enqueue(1, original, { stock: 99 }); // stale display row
		await tick();
		expect(sent).toHaveLength(1); // second is held back until the first lands
		gates[0].resolve();
		await a;
		await tick();
		expect(sent[1]).toEqual({ name: 'pasted-name', price: 100, stock: 99 });
		gates[1].resolve();
		await b;
		expect(server.get(1)).toMatchObject({ name: 'pasted-name', stock: 99 });
	});

	it('does not overwrite a pasted value with a stale row on a following inline edit', async () => {
		const { queue, sent, gates } = setup();
		const paste = queue.enqueue(1, original, { name: 'pasted', price: 5 });
		const inline = queue.enqueue(1, original, { stock: 1 });
		await tick();
		gates[0].resolve();
		await paste;
		await tick();
		gates[1].resolve();
		await inline;
		expect(sent[1]).toEqual({ name: 'pasted', price: 5, stock: 1 });
	});

	it('settles results in send order', async () => {
		const { queue, gates } = setup();
		const order: string[] = [];
		const a = queue.enqueue(1, original, { name: 'a' }).then(() => order.push('a'));
		const b = queue.enqueue(1, original, { stock: 2 }).then(() => order.push('b'));
		await tick();
		gates[0].resolve();
		await tick();
		gates[1].resolve();
		await Promise.all([a, b]);
		expect(order).toEqual(['a', 'b']);
	});

	it('reports a failure only to its own caller and bases later saves on confirmed values', async () => {
		const { queue, sent, gates } = setup();
		const failing = queue.enqueue(1, original, { name: 'will-fail' });
		const failed = failing.catch((e: Error) => e.message);
		const next = queue.enqueue(1, original, { stock: 7 });
		await tick();
		gates[0].reject(new Error('boom'));
		expect(await failed).toBe('boom');
		await tick();
		// The failed name must not leak into the following request.
		expect(sent[1]).toEqual({ name: 'original', price: 100, stock: 7 });
		gates[1].resolve();
		await expect(next).resolves.toMatchObject({ name: 'original', stock: 7 });
	});

	it('does not block other rows', async () => {
		const { queue, sent } = setup();
		void queue.enqueue(1, original, { name: 'x' });
		void queue.enqueue(2, { ...original, id: 2 }, { name: 'y' });
		await tick();
		expect(sent).toHaveLength(2);
	});

	it('drops confirmed state once drained so later edits use the current display row', async () => {
		const { queue, sent, gates } = setup();
		const first = queue.enqueue(1, original, { name: 'one' });
		await tick();
		gates[0].resolve();
		await first;
		await tick();
		const reloaded: Row = { id: 1, name: 'external', price: 1, stock: 1 };
		void queue.enqueue(1, reloaded, { stock: 3 });
		await tick();
		expect(sent[1]).toEqual({ name: 'external', price: 1, stock: 3 });
	});

	it('bases an edit started before a save drained on the currently displayed row (#284 review)', async () => {
		let display: Row = { ...original };
		const sent: Record<string, unknown>[] = [];
		const queue = createRowSaveQueue<Row>({
			compose,
			currentRow: () => display,
			save: async (_id, values) => {
				sent.push(values);
				return { ...display, ...values } as Row;
			}
		});
		// 1. paste A into name; meanwhile the user opens a stock edit, whose
		//    edit.row snapshot still has the OLD name.
		const staleSnapshot = { ...original };
		// 2. A completes, the grid publishes it to the display, the lane drains.
		display = await queue.enqueue(1, original, { name: 'pasted-name' });
		await tick();
		// 3. the stock edit is confirmed with the pre-A snapshot.
		await queue.enqueue(1, staleSnapshot, { stock: 99 });
		expect(sent[1]).toEqual({ name: 'pasted-name', price: 100, stock: 99 });
	});

	it('falls back to the enqueue-time row when currentRow has no such row', async () => {
		const sent: Record<string, unknown>[] = [];
		const queue = createRowSaveQueue<Row>({
			compose,
			currentRow: () => undefined,
			save: async (_id, values) => {
				sent.push(values);
				return { ...original, ...values } as Row;
			}
		});
		await queue.enqueue(1, original, { stock: 1 });
		expect(sent[0]).toEqual({ name: 'original', price: 100, stock: 1 });
	});
});

describe('createRowSaveQueue optimistic lock (Issue #638)', () => {
	interface VRow extends Row {
		version: number;
	}
	const v1: VRow = { ...original, version: 1 };
	const composeV = (base: VRow, changes: Record<string, unknown>) => ({
		name: base.name,
		price: base.price,
		stock: base.stock,
		version: base.version,
		...changes
	});
	const conflict = { kind: 'conflict' };

	it('two edits in a row each send the version the previous save returned', async () => {
		const sent: Record<string, unknown>[] = [];
		let stored: VRow = { ...v1 };
		const queue = createRowSaveQueue<VRow>({
			compose: composeV,
			save: async (_id, values) => {
				sent.push(values);
				if (values.version !== stored.version) throw conflict;
				stored = { ...stored, ...values, version: stored.version + 1 } as VRow;
				return stored;
			}
		});
		const [a, b] = await Promise.all([
			queue.enqueue(1, v1, { name: 'first' }),
			queue.enqueue(1, v1, { stock: 5 })
		]);
		expect(sent.map((values) => values.version)).toEqual([1, 2]);
		expect(a.version).toBe(2);
		expect(b).toMatchObject({ name: 'first', stock: 5, version: 3 });
	});

	it('a conflict refuses the saves of that row still waiting in the burst, unsent', async () => {
		const sent: Record<string, unknown>[] = [];
		const queue = createRowSaveQueue<VRow>({
			compose: composeV,
			isConflict: (err) => err === conflict,
			save: async (_id, values) => {
				sent.push(values);
				if (values.name === 'refused') throw conflict;
				return { ...v1, ...values } as VRow;
			}
		});
		const results = await Promise.allSettled([
			queue.enqueue(1, v1, { name: 'refused' }),
			queue.enqueue(1, v1, { stock: 5 }),
			queue.enqueue(2, { ...v1, id: 2 }, { stock: 6 })
		]);
		expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
		expect((results[1] as PromiseRejectedResult).reason).toBe(conflict);
		// Row 1's second save was never sent; row 2 is another lane.
		expect(sent).toHaveLength(2);
		// Once the lane drained, a new edit is sent again.
		await queue.enqueue(1, v1, { stock: 7 });
		expect(sent).toHaveLength(3);
	});

	it('another failure does not refuse the waiting saves', async () => {
		const queue = createRowSaveQueue<VRow>({
			compose: composeV,
			isConflict: (err) => err === conflict,
			save: async (_id, values) => {
				if (values.name === 'bad') throw new Error('network');
				return { ...v1, ...values } as VRow;
			}
		});
		const results = await Promise.allSettled([
			queue.enqueue(1, v1, { name: 'bad' }),
			queue.enqueue(1, v1, { stock: 5 })
		]);
		expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
	});
});

describe('lock version follows only our own saves (Issue #638 review)', () => {
	interface VRow extends Row {
		version: number;
	}
	const conflict = { kind: 'conflict' };

	/**
	 * A fake server holding row 1 (and 2); `shown` is the list as displayed
	 * (what an SSE refetch would put on screen). `external` is someone else's
	 * save that bypasses the queue.
	 */
	function setupLocked() {
		const server = new Map<number, VRow>([
			[1, { ...original, version: 1 }],
			[2, { ...original, id: 2, version: 1 }]
		]);
		const shown = new Map<number, VRow>([...server].map(([id, row]) => [id, { ...row }]));
		const sent: Record<string, unknown>[] = [];
		const queue = createRowSaveQueue<VRow>({
			compose: (base, changes) => ({
				name: base.name,
				price: base.price,
				stock: base.stock,
				version: base.version,
				...changes
			}),
			currentRow: (rowId) => shown.get(rowId as number),
			isConflict: (err) => err === conflict,
			lock: {
				versionOf: (row) => row.version,
				withVersion: (values, version) => ({ ...values, version })
			},
			save: async (rowId, values) => {
				sent.push(values);
				const stored = server.get(rowId as number)!;
				if (values.version !== stored.version) throw conflict;
				const next = { ...stored, ...values, version: stored.version + 1 } as VRow;
				server.set(rowId as number, next);
				shown.set(rowId as number, { ...next });
				return next;
			}
		});
		const external = (rowId: number, changes: Partial<VRow>) => {
			const stored = server.get(rowId)!;
			server.set(rowId, { ...stored, ...changes, version: stored.version + 1 });
		};
		const refetch = () => {
			for (const [id, row] of server) shown.set(id, { ...row });
		};
		return { queue, server, shown, sent, external, refetch };
	}

	it('advanceLockVersion walks only our own steps', () => {
		const steps = new Map([
			[1, 2],
			[2, 3]
		]);
		expect(advanceLockVersion(1, steps)).toBe(3);
		expect(advanceLockVersion(5, steps)).toBe(5);
		expect(advanceLockVersion(1, undefined)).toBe(1);
		// A cycle (never produced by a real server) does not loop forever.
		expect(advanceLockVersion(1, new Map([[1, 1]]))).toBe(1);
	});

	it('(1) an edit opened before someone else saved sends its old version and conflicts', async () => {
		const { queue, server, shown, sent, external, refetch } = setupLocked();
		const opened = { ...shown.get(1)! }; // A opens the price editor at version 1
		external(1, { price: 300 }); // B saves the same price -> version 2
		refetch(); // the SSE refetch reaches A
		const committedRow = shown.get(1)!; // the grid re-reads the displayed row
		expect(committedRow.version).toBe(2);
		await expect(queue.enqueue(1, committedRow, { price: 150 }, opened)).rejects.toBe(conflict);
		expect(sent[0]).toMatchObject({ price: 150, version: 1 });
		expect(server.get(1)).toMatchObject({ price: 300, version: 2 }); // B's change survives
	});

	it('(2) our own saved version carries to the next save of the row, even after it drained', async () => {
		const { queue, shown, sent, refetch } = setupLocked();
		const first = { ...shown.get(1)! };
		// The second editor opens while the first save is still in flight.
		const second = { ...shown.get(1)! };
		await queue.enqueue(1, first, { price: 150 }, first);
		refetch();
		await queue.enqueue(1, shown.get(1)!, { stock: 5 }, second);
		expect(sent.map((values) => values.version)).toEqual([1, 2]);
		// A paste based on the row before both saves still follows our steps.
		await queue.enqueue(1, first, { name: 'pasted' });
		expect(sent.map((values) => values.version)).toEqual([1, 2, 3]);
	});

	it('(3) our own step, then a step by someone else in one burst: the next save conflicts', async () => {
		const { queue, server, shown, sent, external, refetch } = setupLocked();
		const opened = { ...shown.get(1)! };
		const a = queue.enqueue(1, opened, { price: 150 }, opened); // ours: 1 -> 2
		const b = queue.enqueue(1, opened, { stock: 5 }, opened); // ours, follows to 2
		await Promise.all([a, b]);
		expect(sent.map((values) => values.version)).toEqual([1, 2]);
		const reopened = { ...shown.get(1)! }; // version 3, ours
		external(1, { name: 'B' }); // someone else: 3 -> 4
		refetch();
		await expect(queue.enqueue(1, shown.get(1)!, { price: 999 }, reopened)).rejects.toBe(conflict);
		expect(sent[2]).toMatchObject({ version: 3 });
		expect(server.get(1)).toMatchObject({ name: 'B', version: 4 });
	});

	it('(4) a row not being edited catches up with the refetch: an edit opened after it saves', async () => {
		const { queue, shown, sent, external, refetch } = setupLocked();
		external(2, { price: 300 }); // someone else's change to a row nobody edits
		refetch();
		const opened = { ...shown.get(2)! }; // the editor opens on the refreshed row
		await expect(queue.enqueue(2, opened, { stock: 5 }, opened)).resolves.toMatchObject({
			price: 300,
			stock: 5,
			version: 3
		});
		expect(sent[0]).toMatchObject({ version: 2 });
	});
});
