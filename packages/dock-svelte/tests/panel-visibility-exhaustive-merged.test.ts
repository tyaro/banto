// 隠す順 → 戻す順のすべて（状態を畳みながら歩く, #732）。
// 浅い既定と DOCK_EXHAUSTIVE=1（#798）: `DOCK_EXHAUSTIVE=1` のときは全部の深さ・件数で走る
// （dock-svelte を触る PR の CI と main の push）。未設定（手元の既定と、dock-svelte を触らない
// PR の CI）では浅くする: cases の最後の 2 つ（最深の入れ子の layout）を外す。
// 切り替えは `fixtures/exhaustive.ts` の 1 か所。
import { describe, expect, it } from 'vitest';
import { collectPanelIds, findNode } from '../src/core/tree';
import { depth } from './fixtures/exhaustive';
import { L, mainSlot, nowSlot, shapeOf } from './fixtures/visibility-layouts';
import { keyOf, simDismiss, simShow, type Sim } from './fixtures/visibility-sim';

// Codex P2 on #732 (the second one): every hide order of every set of panes, then every show order,
// with the states merged on the way (`keyOf`), so six and seven panes fit - not every order x
// every order run one by one (7! x 7! of them). Run with main's slot (82b82246) beside the current
// one: every one comes back to the old shape (`all`), or at least every one that does on main.
describe('slot memory: every hide order then every show order (merged states)', () => {
	const cases: [keyof typeof L, 'all' | 'main'][] = [
		['row[b,c,column[tabs[d,e],tabs[f,g]]]', 'all'],
		['row[a,column[b,row[tabs[c,d],e]]]', 'all'],
		['column[row[a,tabs[b,c]],tabs[d,e],f]', 'all'],
		['row[column[tabs[a,b],c],column[d,tabs[e,f]]]', 'all'],
		// A tab group five containers deep. With `MAX_SLOT_DEPTH` at 4, the last tab's chain
		// (t, r2, c1, r1) was cut at a split that is gone, and `restoreDockSlot` had nothing to go
		// on with: the tab opened floating (`-a -b -x -d -c +c ...`), where main puts it beside e.
		// The limit is 8 now (#727).
		['column[row[a,column[row[tabs[b,c],x],d]],e]', 'all'],
		['row[a,column[b,row[c,column[tabs[d,e],f]]]]', 'all']
	];
	// 浅い既定: 最深の 2 つ（cases の最後の 2 つ）を外す。
	for (const [name, want] of depth(cases.slice(0, -2), cases)) {
		it(
			`${name} (${want === 'all' ? 'every one' : 'every one main brings back'})`,
			{ timeout: 60_000 },
			() => {
				const make = L[name];
				const ids = collectPanelIds(make());
				const shape = JSON.stringify(shapeOf(make()));
				const ok = (sim: Sim) =>
					sim.floating.length === 0 && JSON.stringify(shapeOf(sim.docked)) === shape;
				interface Entry {
					main: Sim;
					now: Sim;
					showing: boolean;
					steps: string[];
				}
				const start: Sim = { docked: make(), hidden: [], floating: [] };
				let level: Entry[] = [{ main: start, now: start, showing: false, steps: [] }];
				const failures: string[] = [];
				let checked = 0;
				while (level.length > 0) {
					const next = new Map<string, Entry>();
					const add = (e: Entry) => {
						const key = `${e.showing}${keyOf(e.main)}${keyOf(e.now)}`;
						if (!next.has(key)) next.set(key, e);
					};
					for (const e of level) {
						// The panes to show: hidden in the current run (a floating one is not docked again).
						const hidden = e.now.hidden.map((h) => h.id);
						if (e.showing && hidden.length === 0) {
							checked++;
							if (!ok(e.now) && (want === 'all' || ok(e.main)))
								failures.push(
									`${e.steps.join(' ')} -> ${JSON.stringify(shapeOf(e.now.docked))} floating [${e.now.floating}]`
								);
							continue;
						}
						const step = (id: string, show: boolean): Entry => ({
							main: show ? simShow(mainSlot, e.main, id) : simDismiss(mainSlot, e.main, id),
							now: show ? simShow(nowSlot, e.now, id) : simDismiss(nowSlot, e.now, id),
							showing: show,
							steps: [...e.steps, `${show ? '+' : '-'}${id}`]
						});
						if (e.showing) {
							for (const id of hidden) add(step(id, true));
							continue;
						}
						if (hidden.length > 0) add({ ...e, showing: true });
						for (const id of ids) if (findNode(e.now.docked, id)) add(step(id, false));
					}
					level = [...next.values()];
				}
				expect(checked).toBeGreaterThan(0);
				expect(failures.slice(0, 5)).toEqual([]);
			}
		);
	}
});
