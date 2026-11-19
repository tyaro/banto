import { describe, expect, it } from 'vitest';
import { validateDockLayout } from '../src/core/validate';
import { createDockState } from '../src/state.svelte';
import type { DockLayout } from '../src/types';

// shared-primitives-upstream-plan §3.2 / Issue #434 (PR-1: layout validation).

function win(id: string, over: Record<string, unknown> = {}) {
	return {
		id,
		title: id.toUpperCase(),
		x: 10,
		y: 20,
		width: 300,
		height: 200,
		open: true,
		...over
	};
}

function layoutOf(floating: unknown[], docked: unknown = null, version = 2) {
	return { version, floating, docked };
}

const goodDocked = {
	type: 'split',
	id: 's1',
	direction: 'row',
	children: [
		{
			type: 'tabs',
			id: 't1',
			activeIndex: 1,
			children: [
				{ type: 'panel', id: 'p1', title: 'P1' },
				{ type: 'panel', id: 'p2', title: 'P2' }
			]
		},
		{ type: 'panel', id: 'p3', title: 'P3' }
	],
	sizes: [0.3, 0.7]
};

function codes(value: unknown): string[] {
	const r = validateDockLayout(value);
	return r.ok ? [] : r.issues.map((i) => `${i.code}@${i.path}`);
}

describe('validateDockLayout: accepted inputs', () => {
	// #727 / Codex P2 on #732: a slot and its `outer` chain at most `MAX_SLOT_DEPTH` (8) deep - in a
	// version 3 layout; a version 2 one stays at 4, as the releases before #727 read it (PR #732
	// review). A chain cut there ends at a split slot without `outer` (the place of the gone split
	// is not kept) - the shape `captureDockSlot` makes eight splits deep. A slot saved when the
	// limit was 4 (four deep or less) still reads.
	const splitSlot = (id: string, outer?: unknown) => ({
		kind: 'split',
		splitId: id,
		direction: 'row',
		index: 0,
		neighborId: 'x',
		side: 'before',
		size: 0.5,
		anchors: ['x'],
		...(outer === undefined ? {} : { outer })
	});
	// `n` split slots, the innermost one first, ending at `last` (a cut chain when undefined).
	const chain = (n: number, last?: unknown): unknown => {
		let s = last;
		for (let i = n - 1; i >= 0; i--) s = splitSlot(`s${i}`, s);
		return s;
	};
	it('accepts a v3 dockSlot eight deep that ends at a cut split, not nine deep', () => {
		expect(validateDockLayout(layoutOf([win('b', { dockSlot: chain(8) })], null, 3)).ok).toBe(true);
		const withRoot = chain(7, { kind: 'root' });
		expect(validateDockLayout(layoutOf([win('b', { dockSlot: withRoot })], null, 3)).ok).toBe(true);
		for (const nine of [chain(9), chain(8, { kind: 'root' })]) {
			const r = validateDockLayout(layoutOf([win('b', { dockSlot: nine })], null, 3));
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.issues).toContainEqual({ code: 'shape', path: 'floating[0].dockSlot' });
		}
	});

	it('still accepts a dockSlot saved when the limit was four deep', () => {
		const four = splitSlot('r2', splitSlot('c1', splitSlot('r1', splitSlot('s'))));
		expect(validateDockLayout(layoutOf([win('b', { dockSlot: four })])).ok).toBe(true);
		const withRoot = splitSlot('c1', splitSlot('r1', splitSlot('s', { kind: 'root' })));
		expect(validateDockLayout(layoutOf([win('b', { dockSlot: withRoot })])).ok).toBe(true);
	});

	describe('the version follows the slot depth (PR #732 review)', () => {
		const slotLayout = (version: number, slot: unknown, where: 'floating' | 'autoHidden') =>
			where === 'floating'
				? layoutOf([win('b', { dockSlot: slot })], null, version)
				: {
						version,
						floating: [],
						docked: null,
						autoHidden: [{ node: { type: 'panel', id: 'b', title: 'B' }, edge: 'left', slot }]
					};
		const path = (where: 'floating' | 'autoHidden') =>
			where === 'floating' ? 'floating[0].dockSlot' : 'autoHidden[0].slot';

		for (const where of ['floating', 'autoHidden'] as const) {
			it(`${where}: v2 takes a slot four deep, not five (as the releases before #727)`, () => {
				const r4 = validateDockLayout(slotLayout(2, chain(4), where));
				expect(r4.ok && r4.layout.version).toBe(2);
				for (const five of [chain(5), chain(4, { kind: 'root' })]) {
					const r = validateDockLayout(slotLayout(2, five, where));
					expect(r.ok).toBe(false);
					if (!r.ok) expect(r.issues).toEqual([{ code: 'shape', path: path(where) }]);
				}
			});

			it(`${where}: v3 takes a slot eight deep, not nine; it reads back as v3`, () => {
				const r8 = validateDockLayout(slotLayout(3, chain(8), where));
				expect(r8.ok && r8.layout.version).toBe(3);
				const r5 = validateDockLayout(slotLayout(3, chain(5), where));
				expect(r5.ok && r5.layout.version).toBe(3);
				const r = validateDockLayout(slotLayout(3, chain(9), where));
				expect(r.ok).toBe(false);
				if (!r.ok) expect(r.issues).toEqual([{ code: 'shape', path: path(where) }]);
			});
		}

		it('takes a v3 layout with shallow slots only (or none), as v2', () => {
			const r = validateDockLayout(layoutOf([win('b', { dockSlot: chain(2) })], goodDocked, 3));
			expect(r.ok && r.layout.version).toBe(2);
			const none = validateDockLayout(layoutOf([win('a')], null, 3));
			expect(none.ok && none.layout.version).toBe(2);
		});

		it('rejects an unknown version (4)', () => {
			expect(codes(layoutOf([win('a')], null, 4))).toEqual(['version@version']);
		});
	});

	it('accepts a normal v2 layout with a docked tree', () => {
		const r = validateDockLayout(layoutOf([win('a'), win('b', { x: -50, y: -5 })], goodDocked));
		expect(r.ok).toBe(true);
	});

	it('accepts a v1 payload and migrates it to v2 with docked: null', () => {
		const r = validateDockLayout({ version: 1, floating: [win('a')] });
		expect(r).toEqual({
			ok: true,
			layout: { version: 2, floating: [win('a')], docked: null }
		});
	});

	it('repairs split sizes that do not sum to 1 (normalizeSizes)', () => {
		const docked = { ...goodDocked, sizes: [1, 3] };
		const r = validateDockLayout(layoutOf([], docked));
		expect(r.ok).toBe(true);
		if (r.ok && r.layout.docked?.type === 'split') {
			expect(r.layout.docked.sizes).toEqual([0.25, 0.75]);
		}
	});

	it('does not reject ids unknown to a consumer registry (not a structural issue)', () => {
		expect(validateDockLayout(layoutOf([win('never-registered-anywhere')])).ok).toBe(true);
	});

	it('does not mutate its input', () => {
		const input = layoutOf([win('a')], goodDocked);
		const snapshot = JSON.stringify(input);
		validateDockLayout(input);
		expect(JSON.stringify(input)).toBe(snapshot);
	});
});

describe('validateDockLayout: rejected inputs (Issue #434 observations)', () => {
	it('rejects x=1e999 (JSON.parse gives Infinity)', () => {
		const parsed = JSON.parse(
			'{"version":2,"floating":[{"id":"a","title":"A","x":1e999,"y":0,"width":300,"height":200,"open":true}],"docked":null}'
		);
		expect(parsed.floating[0].x).toBe(Infinity);
		expect(codes(parsed)).toEqual(['non-finite@floating[0].x']);
	});

	it('rejects NaN coordinates', () => {
		expect(codes(layoutOf([win('a', { y: NaN })]))).toEqual(['non-finite@floating[0].y']);
	});

	it('rejects width=-1 and height=0', () => {
		expect(codes(layoutOf([win('a', { width: -1 })]))).toEqual([
			'non-positive-size@floating[0].width'
		]);
		expect(codes(layoutOf([win('a', { height: 0 })]))).toEqual([
			'non-positive-size@floating[0].height'
		]);
	});

	it('rejects a duplicate id among floating windows (id=a)', () => {
		expect(codes(layoutOf([win('a'), win('a')]))).toEqual(['duplicate-id@floating[1].id']);
	});

	it('rejects an id shared by a floating window and a docked panel', () => {
		const docked = {
			type: 'tabs',
			id: 't',
			activeIndex: 0,
			children: [{ type: 'panel', id: 'a', title: 'A' }]
		};
		expect(codes(layoutOf([win('a')], docked))).toEqual(['duplicate-id@docked.children[0].id']);
	});

	it('rejects an unknown version', () => {
		expect(codes({ version: 4, floating: [], docked: null })).toEqual(['version@version']);
		expect(codes({ floating: [] })).toEqual(['version@version']);
	});

	it('rejects non-object and structurally wrong input', () => {
		expect(validateDockLayout(null).ok).toBe(false);
		expect(validateDockLayout('x').ok).toBe(false);
		expect(validateDockLayout([]).ok).toBe(false);
		expect(codes({ version: 2, floating: [] })).toEqual(['shape@docked']);
		expect(codes({ version: 2, floating: 'no', docked: null })).toEqual(['shape@floating']);
		expect(codes({ version: 1, floating: [{ id: 'a' }] })).toContain('shape@floating[0].title');
	});

	it('rejects invalid split: too few children, sizes mismatch, negative size', () => {
		const one = { ...goodDocked, children: [goodDocked.children[1]], sizes: [1] };
		expect(codes(layoutOf([], one))).toEqual(['split-sizes@docked.children']);
		const mismatch = { ...goodDocked, sizes: [1] };
		expect(codes(layoutOf([], mismatch))).toEqual(['split-sizes@docked.sizes']);
		const negative = { ...goodDocked, sizes: [-0.2, 1.2] };
		expect(codes(layoutOf([], negative))).toEqual(['split-sizes@docked.sizes[0]']);
		const inf = { ...goodDocked, sizes: [Infinity, 1] };
		expect(codes(layoutOf([], inf))).toEqual(['split-sizes@docked.sizes[0]']);
	});

	it('rejects invalid tabs: activeIndex out of range / fractional, empty group, nested split', () => {
		const tabs = (over: Record<string, unknown>) => ({
			type: 'tabs',
			id: 't',
			activeIndex: 0,
			children: [{ type: 'panel', id: 'p', title: 'P' }],
			...over
		});
		expect(codes(layoutOf([], tabs({ activeIndex: 1 })))).toEqual([
			'active-index@docked.activeIndex'
		]);
		expect(codes(layoutOf([], tabs({ activeIndex: -1 })))).toEqual([
			'active-index@docked.activeIndex'
		]);
		expect(codes(layoutOf([], tabs({ activeIndex: 0.5 })))).toEqual([
			'active-index@docked.activeIndex'
		]);
		expect(codes(layoutOf([], tabs({ children: [] })))).toEqual(['shape@docked.children']);
		expect(codes(layoutOf([], tabs({ children: [goodDocked] })))).toContain(
			'shape@docked.children[0].type'
		);
	});

	it('reports every issue at once', () => {
		const r = validateDockLayout(layoutOf([win('a', { x: Infinity, width: -1 }), win('a')]));
		expect(r.ok).toBe(false);
		if (!r.ok)
			expect(r.issues.map((i) => i.code).sort()).toEqual([
				'duplicate-id',
				'non-finite',
				'non-positive-size'
			]);
	});
});

describe('DockState adopts only validated layouts', () => {
	const bad = [
		[
			'x=1e999',
			'{"version":2,"floating":[{"id":"a","title":"A","x":1e999,"y":0,"width":300,"height":200,"open":true}],"docked":null}'
		],
		['width=-1', JSON.stringify(layoutOf([win('a', { width: -1 })]))],
		['height=0', JSON.stringify(layoutOf([win('a', { height: 0 })]))],
		['duplicate id=a', JSON.stringify(layoutOf([win('a'), win('a')]))]
	] as const;

	it.each(bad)('hydrate(%s) returns false and leaves the current layout untouched', (_n, json) => {
		const dock = createDockState(layoutOf([win('keep')]) as unknown as DockLayout);
		const before = JSON.stringify(dock.layout);
		expect(dock.hydrate(json)).toBe(false);
		expect(JSON.stringify(dock.layout)).toBe(before);
	});

	it('hydrate returns false for malformed JSON and true for a valid payload', () => {
		const dock = createDockState();
		expect(dock.hydrate('not json{{{')).toBe(false);
		expect(dock.hydrate(JSON.stringify(layoutOf([win('a')], goodDocked)))).toBe(true);
		expect(dock.layout.floating[0].id).toBe('a');
	});

	it.each(bad)('constructor with string %s starts from an empty layout', (_n, json) => {
		expect(createDockState(json).layout).toEqual({ version: 2, floating: [], docked: null });
	});

	it('constructor with an invalid object starts from an empty layout (no throw)', () => {
		const invalid = layoutOf([win('a', { x: NaN }), win('a')]) as unknown as DockLayout;
		expect(createDockState(invalid).layout).toEqual({ version: 2, floating: [], docked: null });
	});

	it('constructor still accepts a normal v2 object and a v1 object', () => {
		const v2 = layoutOf([win('a')], goodDocked) as unknown as DockLayout;
		expect(createDockState(v2).layout.floating[0].id).toBe('a');
		const v1 = { version: 1, floating: [win('a')] } as unknown as DockLayout;
		expect(createDockState(v1).layout).toEqual({ version: 2, floating: [win('a')], docked: null });
	});
});

describe('caller-supplied objects that JSON cannot produce (PR #440 review)', () => {
	it('rejects split weights whose sum overflows to Infinity', () => {
		const docked = {
			type: 'split',
			id: 's1',
			direction: 'row',
			children: [
				{ type: 'panel', id: 'p1', title: 'P1' },
				{ type: 'panel', id: 'p2', title: 'P2' }
			],
			sizes: [1e308, 1e308]
		};
		const result = validateDockLayout(layoutOf([], docked));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues).toContainEqual({ code: 'split-sizes', path: 'docked.sizes' });
		}
	});

	it('stops at a split that contains itself instead of recursing forever', () => {
		const split: Record<string, unknown> = {
			type: 'split',
			id: 's1',
			direction: 'row',
			sizes: [1, 1]
		};
		split.children = [split, { type: 'panel', id: 'p1', title: 'P1' }];
		const result = validateDockLayout(layoutOf([], split));
		expect(result.ok).toBe(false);
		expect(() => createDockState(layoutOf([], split) as unknown as DockLayout)).not.toThrow();
	});

	it('rejects holes in sparse tab children and floating arrays', () => {
		const tabs = { type: 'tabs', id: 't1', activeIndex: 0, children: new Array(1) };
		const sparseTabs = validateDockLayout(layoutOf([], tabs));
		expect(sparseTabs.ok).toBe(false);
		if (!sparseTabs.ok) {
			expect(sparseTabs.issues).toContainEqual({ code: 'shape', path: 'docked.children[0]' });
		}

		const floating: unknown[] = [win('a')];
		floating.length = 2;
		const sparseFloating = validateDockLayout(layoutOf(floating));
		expect(sparseFloating.ok).toBe(false);
		if (!sparseFloating.ok) {
			expect(sparseFloating.issues).toContainEqual({ code: 'shape', path: 'floating[1]' });
		}
	});
});

// #736: a slot that contradicts itself is dropped (the window opens floating), the layout stays.
describe('validateDockLayout: a slot that contradicts itself', () => {
	const tab = (over: Record<string, unknown> = {}) => ({
		kind: 'tab',
		groupId: 'g',
		index: 1,
		anchors: ['x', 'y'],
		...over
	});
	const split = (over: Record<string, unknown> = {}) => ({
		kind: 'split',
		splitId: 's',
		direction: 'row',
		index: 0,
		neighborId: 'x',
		side: 'before',
		size: 0.5,
		anchors: ['x', 'y'],
		otherAnchors: ['z'],
		...over
	});
	const slotOfWindow = (slot: unknown) => {
		const r = validateDockLayout(layoutOf([win('b', { dockSlot: slot })]));
		if (!r.ok) throw new Error('layout rejected');
		return r.layout.floating[0];
	};

	it('keeps a consistent tab slot and a consistent split slot', () => {
		expect(slotOfWindow(tab()).dockSlot).toEqual(tab());
		expect(slotOfWindow(tab({ index: 2 })).dockSlot).toEqual(tab({ index: 2 }));
		expect(slotOfWindow(split()).dockSlot).toEqual(split());
		expect(slotOfWindow(tab({ outer: split() })).dockSlot).toEqual(tab({ outer: split() }));
	});

	it('keeps a tab slot saved without anchors, whatever its index (older JSON)', () => {
		expect(slotOfWindow(tab({ index: 9, anchors: [] })).dockSlot).toEqual(
			tab({ index: 9, anchors: [] })
		);
	});

	it.each([
		['anchors twice', tab({ anchors: ['x', 'x'] })],
		['its own id in anchors', tab({ anchors: ['x', 'b'] })],
		['an index past the group', tab({ index: 3 })],
		['a split slot with anchors twice', split({ anchors: ['x', 'x'] })],
		['a split slot with its own id as the neighbour', split({ neighborId: 'b' })],
		['a split slot with its own id in anchors', split({ anchors: ['b'] })],
		['a pane on both sides of a split slot', split({ otherAnchors: ['y'] })],
		['its own id in otherAnchors', split({ otherAnchors: ['b'] })]
	])('drops a dockSlot with %s, keeps the window and the layout', (_name, slot) => {
		const w = slotOfWindow(slot);
		expect(w.id).toBe('b');
		expect('dockSlot' in w).toBe(false);
	});

	it('drops the whole slot when only its outer contradicts', () => {
		expect('dockSlot' in slotOfWindow(tab({ outer: split({ anchors: ['x', 'x'] }) }))).toBe(false);
		expect(
			'dockSlot' in
				slotOfWindow(
					split({
						outer: split({ splitId: 'o', outer: split({ splitId: 'o2', neighborId: 'b' }) })
					})
				)
		).toBe(false);
	});

	it('drops only the contradicting window slot, and a v3 layout falls back to version 2', () => {
		let deep: unknown = split({ neighborId: 'b' });
		for (let i = 1; i < 5; i++) deep = split({ splitId: `s${i}`, outer: deep });
		const r = validateDockLayout(
			layoutOf([win('a', { dockSlot: tab() }), win('b', { dockSlot: deep })], null, 3)
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.layout.floating[0].dockSlot).toEqual(tab());
			expect('dockSlot' in r.layout.floating[1]).toBe(false);
			expect(r.layout.version).toBe(2);
		}
	});

	it('turns the slot of an auto-hidden band into the root, and keeps a consistent one', () => {
		const read = (slot: unknown) => {
			const band = { node: { type: 'panel', id: 'p', title: 'P' }, edge: 'left', slot };
			const r = validateDockLayout({ ...layoutOf([], goodDocked), autoHidden: [band] });
			if (!r.ok) throw new Error('layout rejected');
			return r.layout.autoHidden?.[0].slot;
		};
		expect(read(tab({ anchors: ['x', 'p'] }))).toEqual({ kind: 'root' });
		expect(read(tab({ outer: split({ neighborId: 'p' }) }))).toEqual({ kind: 'root' });
		expect(read(tab())).toEqual(tab());
	});
});
