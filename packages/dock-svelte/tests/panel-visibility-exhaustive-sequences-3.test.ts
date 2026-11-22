// hide / show の手順の全列挙（#725, 3/3）: main で元に戻る手順は今も戻る。
// 浅い既定と DOCK_EXHAUSTIVE=1（#798）: `DOCK_EXHAUSTIVE=1` のときは全部の深さ・件数で走る
// （dock-svelte を触る PR の CI と main の push）。未設定（手元の既定と、dock-svelte を触らない
// PR の CI）では浅くする: 手の数を 4 枚 8・5 枚 7・6 枚以上 6 にする（全部: 12・10・8）。3 つのファイルは layout の集合で割る。
// 切り替えは `fixtures/exhaustive.ts` の 1 か所。
import { describe, expect, it } from 'vitest';
import { collectPanelIds } from '../src/core/tree';
import { depth } from './fixtures/exhaustive';
import { layoutPart, mainSlot, nowSlot } from './fixtures/visibility-layouts';
import { enumerateSequences } from './fixtures/visibility-sim';

// `L` の 3 / 3（並びの添字を 3 で割った余りが 2）。
const PART = 2;
const PARTS = 3;

// Codex kept finding regressions in orders that interleave hiding and showing (#725). Every
// sequence of hide / show steps up to `steps` long on these layouts, run with main's slot
// (`fixtures/slot-main.ts`, 82b82246) and the current one side by side (`fixtures/visibility-sim.ts`):
// every sequence that comes back to the old shape on main must still do so. The steps are as
// many as fit in a second or two per layout (12 for 4 panes, 10 for 5; 14 for all of them was
// run once by hand, with no regression). A sequence of odd length never shows every pane again.
describe('slot memory: no hide / show sequence regresses from main (every sequence)', () => {
	for (const [name, make] of layoutPart(PART, PARTS)) {
		// Six panes and more: 8 steps (10 takes 20 s for seven; the merged walk below covers every
		// pane hidden then shown).
		const n = collectPanelIds(make()).length;
		// 浅い既定: 4 枚 8 手・5 枚 7 手・6 枚以上 6 手。
		const steps = depth(n <= 4 ? 8 : n === 5 ? 7 : 6, n <= 4 ? 12 : n === 5 ? 10 : 8);
		it(`${name}: every sequence up to ${steps} steps`, { timeout: 60_000 }, () => {
			const result = enumerateSequences(make, mainSlot, nowSlot, steps);
			expect(result.mainRestores).toBeGreaterThan(0);
			expect(result.regressions.slice(0, 5)).toEqual([]);
		});
	}
});
