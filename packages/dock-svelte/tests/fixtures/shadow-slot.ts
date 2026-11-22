// #782 PR3: 影の木の inflate / deflate を、`visibility-sim.ts` の `SlotImpl`（capture / restore）の形に
// したもの。旧実装（`slot-main.ts`）と今の `slot.ts` を並べて走らせる総当たりに、そのまま差し込める。
//
// sim は「隠した時に取った slot」をパネルごとに持ち続ける（あとで取り直さない）。deflate の slot は
// S の中の場所だけで決まり、ほかのパネルを隠す・戻すでは変わらない（`size` を除く）ので、古い slot の
// ままでも inflate は同じ S を組む。
import { captureDockSlot } from '../../src/core/slot';
import {
	deflateShadow,
	inflateShadow,
	markAway,
	markPresent,
	projectShadow
} from '../../src/core/shadow';
import type { HiddenDockSlot } from '../../src/core/slot';
import { panelOf, type SlotImpl } from './visibility-sim';

const awayOf = (hidden: HiddenDockSlot[]) =>
	hidden.map((h) => ({ panel: panelOf(h.id), slot: h.slot }));

/** capture = inflate → 印を付ける → deflate の slot。restore = inflate → 印を外す → 射影。 */
export const shadowSlot: SlotImpl = {
	capture(root, panelId, hidden) {
		const { shadow } = inflateShadow(root, awayOf(hidden));
		const { away } = deflateShadow(markAway(shadow, panelId));
		return away.find((a) => a.panel.id === panelId)?.slot ?? null;
	},
	restore(root, panel, slot, _makeId, hidden = []) {
		const { shadow, unplaced } = inflateShadow(root, [...awayOf(hidden), { panel, slot }]);
		// 場所が無い: 今の `restoreDockSlot` の `null`（浮動で開く）と同じ。
		if (unplaced.includes(panel.id)) return null;
		return projectShadow(markPresent(shadow, panel.id, panel));
	}
};

/** 今の `captureDockSlot` が書いた slot を inflate で読む（PR4 以降、古い保存や外からの代入で起きる組み合わせ）。 */
export const shadowReadsNow: SlotImpl = { capture: captureDockSlot, restore: shadowSlot.restore };
