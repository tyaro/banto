// 総当たりテストの深さの切り替え（#798）。ここ 1 か所だけが環境変数を読む。
//
// `DOCK_EXHAUSTIVE=1` のときは全部の深さ・件数で走る（dock-svelte を触る PR の CI と main の push）。
// 未設定（手元の既定と、dock-svelte を触らない PR の CI）では浅くする。浅くしても同じ性質を同じ
// 道具で見る（外すのは、深さ・件数だけ）。使うファイル: `panel-visibility-exhaustive-*.test.ts`、
// `DockHostKeyboardMove.test.ts`。

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

/** `DOCK_EXHAUSTIVE=1`（`0` と空は浅い）。 */
export const EXHAUSTIVE: boolean = !!env?.DOCK_EXHAUSTIVE && env.DOCK_EXHAUSTIVE !== '0';

/** 全部の深さなら `full`、浅い既定なら `shallow`。 */
export const depth = <T>(shallow: T, full: T): T => (EXHAUSTIVE ? full : shallow);

export const permutations = (ids: string[]): string[][] =>
	ids.length <= 1
		? [ids]
		: ids.flatMap((id, i) =>
				permutations([...ids.slice(0, i), ...ids.slice(i + 1)]).map((rest) => [id, ...rest])
			);

export const subsets = (ids: string[], k: number): string[][] =>
	k === 0
		? [[]]
		: ids.flatMap((id, i) => subsets(ids.slice(i + 1), k - 1).map((rest) => [id, ...rest]));
