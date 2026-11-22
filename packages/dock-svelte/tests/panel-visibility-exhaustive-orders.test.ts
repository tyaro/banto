// 隠す順 × 戻す順のすべて（#720・#721・#727・#732）: 木の形が元に戻る。
// 浅い既定と DOCK_EXHAUSTIVE=1（#798）: `DOCK_EXHAUSTIVE=1` のときは全部の深さ・件数で走る
// （dock-svelte を触る PR の CI と main の push）。未設定（手元の既定と、dock-svelte を触らない
// PR の CI）では浅くする: 5 枚の layout は 3 枚まで隠す（k = 4・5 の件を外す）。4 枚以下は同じ。
// 切り替えは `fixtures/exhaustive.ts` の 1 か所。
import { describe, expect, it } from 'vitest';
import { collectPanelIds } from '../src/core/tree';
import { createDockState } from '../src/state.svelte';
import type { DockNode } from '../src/types';
import { depth, permutations, subsets } from './fixtures/exhaustive';
import { L, counterMakeId, nested, panel, shapeOf } from './fixtures/visibility-layouts';

// #720 review (3 回目の同種の指摘): 同じタブの組・同じ split から何枚隠しても、どの順で
// 戻しても、全部戻せば元の並びになる。途中の並びは問わない。3〜5 枚から 2〜3 枚を選び、
// 隠す順 × 戻す順のすべてを総当たりで確かめる（タブの組と、split の向き両方）。
// 1 枚は残す: 全部を隠すと最後の 1 枚は `root` の slot になり、先に戻すものの手がかりが無い。
// #721: up to "every pane of the container" (k = n), with and without a neighbour `p` next to the
// container, and the whole tree's shape compared (not only the order of the panel ids).
describe('slot memory: every hide order x every show order comes back to the old shape', () => {
	const names = ['a', 'b', 'c', 'd', 'e'];
	const even = (ids: string[]) => ids.map(() => 1 / ids.length);
	const split = (direction: 'row' | 'column', ids: string[]): DockNode => ({
		type: 'split',
		id: 's',
		direction,
		sizes: even(ids),
		children: ids.map(panel)
	});
	const tabs = (ids: string[]): DockNode => ({
		type: 'tabs',
		id: 't',
		activeIndex: 0,
		children: ids.map(panel)
	});
	// The container next to `p` in an outer split of the other direction (a split's child never has its direction).
	const besideP = (inner: DockNode, direction: 'row' | 'column'): DockNode => ({
		type: 'split',
		id: 'o',
		direction,
		sizes: [0.6, 0.4],
		children: [inner, panel('p')]
	});
	const layouts: Record<string, (ids: string[]) => DockNode> = {
		'tabs beside p': (ids) => besideP(tabs(ids), 'row'),
		'tabs alone': (ids) => tabs(ids),
		'row beside p': (ids) => besideP(split('row', ids), 'column'),
		'row alone': (ids) => split('row', ids),
		'column beside p': (ids) => besideP(split('column', ids), 'row'),
		'column alone': (ids) => split('column', ids)
	};
	for (const [kind, make] of Object.entries(layouts)) {
		for (const n of [2, 3, 4, 5]) {
			const ids = names.slice(0, n);
			// Every pane (k = n) up to 4 panes: 5! x 5! runs per case would be too slow.
			const ks = [2, 3, 4].filter((k) => k <= n && (n <= 4 || k <= 3));
			for (const k of ks) {
				for (const hidden of subsets(ids, k)) {
					// Up to 4! x 4! runs: an explicit timeout for a slow CI runner (2-3 times slower).
					it(
						`${kind} [${ids.join(',')}] hide ${hidden.join(',')} (every order x every order)`,
						{ timeout: 60_000 },
						() => {
							const want = JSON.stringify(shapeOf(make(ids)));
							const failures: string[] = [];
							for (const hideOrder of permutations(hidden)) {
								for (const showOrder of permutations(hidden)) {
									const dock = createDockState(
										{ version: 2, floating: [], docked: make(ids) },
										counterMakeId()
									);
									for (const id of hideOrder) dock.dismiss(id);
									for (const id of showOrder) dock.show(id);
									const got = JSON.stringify(shapeOf(dock.layout.docked));
									if (got !== want) failures.push(`hide ${hideOrder} show ${showOrder} -> ${got}`);
								}
							}
							expect(failures).toEqual([]);
						}
					);
				}
			}
		}
	}
});

// Codex P2 on #725: the surviving child of a split that is gone is itself a split. One pane of
// that child is not "the whole child", so it keeps its slot in the child (not the gone split's).
describe('slot memory: the surviving child of a gone split, every order x every order', () => {
	const layouts: Record<string, () => DockNode> = {
		'row[column[a,b,c], d]': () => nested('row', ['a', 'b', 'c'], ['d']),
		'row[d, column[a,b,c]]': () => nested('row', ['a', 'b', 'c'], ['d'], false),
		'column[row[a,b], c]': () => nested('column', ['a', 'b'], ['c']),
		'column[c, row[a,b]]': () => nested('column', ['a', 'b'], ['c'], false),
		// The same direction inside (an edge dock wraps the root even then; cross-review P2 on #725).
		'row[row[a,b], p]': () => nested('row', ['a', 'b'], ['p'], true, true),
		'row[p, row[a,b,c]]': () => nested('row', ['a', 'b', 'c'], ['p'], false, true),
		'column[column[a,b,c], p]': () => nested('column', ['a', 'b', 'c'], ['p'], true, true),
		// #727: two outer siblings (`c` came back around the anchor `b`, not around `row[a,b]`).
		'column[row[a,b], c, d]': () => nested('column', ['a', 'b'], ['c', 'd']),
		'column[c, d, row[a,b]]': () => nested('column', ['a', 'b'], ['c', 'd'], false),
		// Codex P2 on #732: four splits deep (`L` below; the describe body runs after the module).
		'column[row[a,column[row[b,c],d]],e]': () => L['column[row[a,column[row[b,c],d]],e]'](),
		// Codex P2 on #732 (the second one): tab groups inside a split inside a split, five panes
		// (every pane too). Six and seven: the walk with merged states below.
		'column[tabs[a,b],row[c,tabs[d,e]]]': () => L['column[tabs[a,b],row[c,tabs[d,e]]]'](),
		'row[a,column[tabs[b,c],tabs[d,e]]]': () => L['row[a,column[tabs[b,c],tabs[d,e]]]']()
	};
	for (const [name, make] of Object.entries(layouts)) {
		const ids = collectPanelIds(make());
		// #727: every pane too (k = n), and every hide order (an inner pane before the outer sibling).
		// 浅い既定: 5 枚の layout は 3 枚まで（k = 4・5 は重い）。
		const maxK = depth(ids.length >= 5 ? 3 : ids.length, ids.length);
		for (let k = 2; k <= maxK; k++) {
			for (const hidden of subsets(ids, k)) {
				// Up to 5! x 5! runs (7-9 s on CI): an explicit timeout, as for the walks below.
				it(
					`${name} hide ${hidden.join(',')} (every order x every order)`,
					{ timeout: 60_000 },
					() => {
						const want = JSON.stringify(shapeOf(make()));
						const failures: string[] = [];
						for (const hideOrder of permutations(hidden)) {
							for (const showOrder of permutations(hidden)) {
								const dock = createDockState(
									{ version: 2, floating: [], docked: make() },
									counterMakeId()
								);
								for (const id of hideOrder) dock.dismiss(id);
								for (const id of showOrder) dock.show(id);
								const got = JSON.stringify(shapeOf(dock.layout.docked));
								if (got !== want) failures.push(`hide ${hideOrder} show ${showOrder} -> ${got}`);
							}
						}
						expect(failures).toEqual([]);
					}
				);
			}
		}
	}
});
