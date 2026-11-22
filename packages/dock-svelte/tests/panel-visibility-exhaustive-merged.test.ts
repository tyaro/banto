// 隠す順 → 戻す順のすべて（状態を畳みながら歩く, #732）。
// 浅い既定と DOCK_EXHAUSTIVE=1（#798）: `DOCK_EXHAUSTIVE=1` のときは全部の深さ・件数で走る
// （dock-svelte を触る PR の CI と main の push）。未設定（手元の既定と、dock-svelte を触らない
// PR の CI）では浅くする: cases の最後の 2 つ（最深の入れ子の layout）を外す。
// 切り替えは `fixtures/exhaustive.ts` の 1 か所。
import { describe, expect, it } from 'vitest';
import { depth } from './fixtures/exhaustive';
import { L, MERGED_CASES, mainSlot, nowSlot } from './fixtures/visibility-layouts';
import { walkHideThenShow } from './fixtures/visibility-sim';

// Codex P2 on #732 (the second one): every hide order of every set of panes, then every show order,
// with the states merged on the way (`keyOf`), so six and seven panes fit - not every order x
// every order run one by one (7! x 7! of them). Run with main's slot (82b82246) beside the current
// one: every one comes back to the old shape (`all`), or at least every one that does on main.
// The walk is `walkHideThenShow` and the layouts `MERGED_CASES` (`fixtures/`): the same walk runs
// with the shadow tree in `panel-visibility-exhaustive-shadow.test.ts` (#782 PR3).
describe('slot memory: every hide order then every show order (merged states)', () => {
	// 浅い既定: 最深の 2 つ（cases の最後の 2 つ）を外す。
	for (const [name, want] of depth(MERGED_CASES.slice(0, -2), MERGED_CASES)) {
		it(
			`${name} (${want === 'all' ? 'every one' : 'every one main brings back'})`,
			{ timeout: 60_000 },
			() => {
				const { checked, failures } = walkHideThenShow(L[name], mainSlot, nowSlot, want);
				expect(checked).toBeGreaterThan(0);
				expect(failures.slice(0, 5)).toEqual([]);
			}
		);
	}
});
