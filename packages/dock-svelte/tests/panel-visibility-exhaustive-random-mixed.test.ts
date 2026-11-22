// hide / show の長い手順を乱数で（#725）と、hide / show / float / back を混ぜた全列挙（#734）。
// 浅い既定と DOCK_EXHAUSTIVE=1（#798）: `DOCK_EXHAUSTIVE=1` のときは全部の深さ・件数で走る
// （dock-svelte を触る PR の CI と main の push）。未設定（手元の既定と、dock-svelte を触らない
// PR の CI）では浅くする: interleaved の乱数は 150 本（全部: 600）、混ぜた全列挙は 5 枚以下の layout で 4 手（全部: 6 手。3 枚以下は 8 手のまま）。
// 切り替えは `fixtures/exhaustive.ts` の 1 か所。
import { describe, expect, it } from 'vitest';
import { collectPanelIds } from '../src/core/tree';
import { depth } from './fixtures/exhaustive';
import { L, mainSlot, mainSplit, nowSlot, runSteps, shapeOf } from './fixtures/visibility-layouts';
import { enumerateSequences, simRun } from './fixtures/visibility-sim';

// Longer sequences than the walk above, at random (fixed seed), run with `createDockState`: every
// one that comes back to the old shape with main's slot must still do so. The model the walk uses
// is checked against `createDockState` on the way.
describe('slot memory: interleaved hide / show orders do not regress', () => {
	// mulberry32: a small seeded generator, so the sequences are the same on every run.
	const rng = (seed: number) => () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	/**
	 * `-x` hides x, `+x` shows it; 10 to 16 steps (the count random too) with at least one show
	 * between hides, then the rest shown.
	 */
	const sequences = (ids: string[], count: number, seed: number): string[] => {
		const random = rng(seed);
		const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
		const out = new Set<string>();
		for (let tries = 0; out.size < count && tries < count * 20; tries++) {
			const hidden: string[] = [];
			const steps: string[] = [];
			const length = 10 + Math.floor(random() * 7);
			for (let i = 0; i < length; i++) {
				const docked = ids.filter((id) => !hidden.includes(id));
				const show = hidden.length > 0 && (docked.length === 0 || random() < 0.4);
				const id = pick(show ? hidden : docked);
				if (show) hidden.splice(hidden.indexOf(id), 1);
				else hidden.push(id);
				steps.push(`${show ? '+' : '-'}${id}`);
			}
			while (hidden.length > 0)
				steps.push(`+${hidden.splice(Math.floor(random() * hidden.length), 1)[0]}`);
			// Interleaved only: a show before the last hide.
			const lastHide = steps.map((s) => s[0]).lastIndexOf('-');
			if (steps.slice(0, lastHide).some((s) => s[0] === '+')) out.add(steps.join(' '));
		}
		return [...out];
	};
	// 浅い既定: 150 本（全部: 600）。
	const COUNT = depth(150, 600);
	for (const [name, make] of Object.entries(L)) {
		it(`${name}: ${COUNT} interleaved sequences`, () => {
			const want = JSON.stringify(shapeOf(make()));
			const failures: string[] = [];
			for (const seq of sequences(collectPanelIds(make()), COUNT, 721)) {
				const steps = seq.split(' ');
				const got = JSON.stringify(shapeOf(runSteps(make, steps).layout.docked));
				// The model of the walk above gives the same tree as `createDockState`.
				expect(JSON.stringify(shapeOf(simRun(nowSlot, make(), steps).docked)), seq).toBe(got);
				const onMain = JSON.stringify(shapeOf(simRun(mainSlot, make(), steps).docked));
				if (onMain === want && got !== want) failures.push(seq);
			}
			expect(failures).toEqual([]);
		});
	}
});

// #734: 隠した・浮かせた pane を混ぜた手順の全列挙。pane を浮かせて戻す手順は `runSteps` の `~x` / `^x`。
describe('slot memory: every mixed sequence of hide / show / float / back (#734)', () => {
	// Every sequence of hide / show / float / back steps, run with main's slot and main's wiring
	// (`split`: `dismiss` did not count the floated panes) beside the current ones: every sequence
	// that comes back to the old shape on main still does. Up to five panes, the steps as many as
	// fit in a few seconds (a docked pane can be hidden or floated: twice the branches).
	for (const [name, make] of Object.entries(L)) {
		const n = collectPanelIds(make()).length;
		if (n > 5) continue;
		const steps = n <= 3 ? 8 : depth(4, 6);
		it(`${name}: every mixed sequence up to ${steps} steps`, { timeout: 60_000 }, () => {
			const result = enumerateSequences(make, mainSplit, nowSlot, steps, { mixed: true });
			expect(result.mainRestores).toBeGreaterThan(0);
			expect(result.regressions.slice(0, 5)).toEqual([]);
		});
	}
});
