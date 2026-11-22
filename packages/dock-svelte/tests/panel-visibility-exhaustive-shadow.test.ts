// #782 PR3: 影の木の inflate / deflate を、旧実装（main の slot、`fixtures/slot-main.ts`）と並べて走らせる
// 総当たり。新しい歩き方は足していない: `panel-visibility-exhaustive-sequences-*.test.ts` の
// `enumerateSequences` と、`-merged.test.ts` の `walkHideThenShow` を、今の slot の代わりに
// `fixtures/shadow-slot.ts`（inflate → 印 → deflate / 射影）で回す（#782 の申し送り、#798）。
//
// 浅い既定と DOCK_EXHAUSTIVE=1（#798、`fixtures/exhaustive.ts`）: 手の数は 4 枚 6・5 枚以上 5（全部: 8・7・6 =
// 元の 3 つのファイルの浅い既定）。影の木は手順の長さによらず同じ S に戻るので、深さを足しても影の木の側の
// 状態は増えない（増えるのは main の側だけ）。全部の深さ（10・8・6）は手元で 1 回通した。
// PR7 で slot の仕組みを削るときに、`slot-main.ts` と一緒にこのファイルも消す。
import { describe, expect, it } from 'vitest';
import { collectPanelIds } from '../src/core/tree';
import { depth } from './fixtures/exhaustive';
import { shadowReadsNow, shadowSlot } from './fixtures/shadow-slot';
import { L, MERGED_CASES, mainSlot } from './fixtures/visibility-layouts';
import { enumerateSequences, walkHideThenShow } from './fixtures/visibility-sim';

describe('shadow tree by inflate / deflate: no hide / show sequence regresses from main (every sequence)', () => {
	for (const [name, make] of Object.entries(L)) {
		const n = collectPanelIds(make()).length;
		const steps = depth(n <= 4 ? 6 : 5, n <= 4 ? 8 : n === 5 ? 7 : 6);
		it(`${name}: every sequence up to ${steps} steps`, { timeout: 60_000 }, () => {
			const result = enumerateSequences(make, mainSlot, shadowSlot, steps);
			expect(result.mainRestores).toBeGreaterThan(0);
			expect(result.regressions.slice(0, 5)).toEqual([]);
			// main が戻せない手順も含めて、全部が元の形に戻る。
			expect(result.nowRestores).toBe(result.sequences);
		});
	}
});

describe('shadow tree by inflate / deflate: every hide order then every show order (merged states)', () => {
	// 「全部が元の形に戻る」は main と比べなくても言えるので、main の側は走らせない（影の木だけで歩くと
	// 状態が少なく、最深の 2 つも浅い既定で回る）。
	for (const [name] of MERGED_CASES) {
		it(`${name} (every one)`, { timeout: 60_000 }, () => {
			const { checked, failures } = walkHideThenShow(L[name], shadowSlot, shadowSlot, 'all');
			expect(checked).toBeGreaterThan(0);
			expect(failures.slice(0, 5)).toEqual([]);
		});
	}
});

// 今の `captureDockSlot` が書いた slot（古い保存・外からの代入で入ってくる形）を inflate で読んでも、
// main が元の形に戻す手順は戻る。
describe('inflate reads the slots of slot.ts: no hide / show sequence regresses from main', () => {
	for (const [name, make] of Object.entries(L)) {
		const n = collectPanelIds(make()).length;
		const steps = depth(n <= 4 ? 6 : 5, n <= 4 ? 8 : n === 5 ? 7 : 6);
		it(`${name}: every sequence up to ${steps} steps`, { timeout: 60_000 }, () => {
			const result = enumerateSequences(make, mainSlot, shadowReadsNow, steps);
			expect(result.regressions.slice(0, 5)).toEqual([]);
		});
	}
});
