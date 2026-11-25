import { createSseStream, sessionStreamHooks } from '../../src/index';

/** サーバーが配信する値 1 件（`madeAt` は作る側が入れた「作った印」）。 */
export interface Reading {
	madeAt: number;
	value: number;
}

/** 画面が持つ状態。`reading` は配信から受けた値だけで、消すときは `null` にする。 */
export interface PlantView {
	reading: Reading | null;
	/** 作る側が止まっている（値は古い）。 */
	stale: boolean;
	/** 見る権限が無い（文言は画面のキーで出す）。 */
	forbidden: boolean;
}

export function openPlantStream(
	getToken: () => string | null,
	onChange: (view: PlantView) => void,
	transport: { baseUrl?: string; fetchFn?: typeof fetch } = {}
): () => void {
	let view: PlantView = { reading: null, stale: false, forbidden: false };
	const set = (next: Partial<PlantView>) => {
		view = { ...view, ...next };
		onChange(view);
	};
	return createSseStream<Reading>({
		...transport,
		path: '/api/plant/stream',
		getToken,
		parse: (data, event) => (event === 'values' ? (JSON.parse(data) as Reading) : null),
		onEvent: (reading) => set({ reading, forbidden: false }),
		// 値を作った印。つなぎ直しで送り直された古い値では、stale を解かない。
		valueStamp: (reading) => reading.madeAt,
		staleAfterMs: 15_000, // 作る側の周期（5 秒）の 3 倍
		onStale: (stale) => set({ stale }),
		// 値を消すのは呼ぶ側の仕事。前のセッションの値も、見る権限の外れた値も残さない。
		onSessionChange: () => set({ reading: null, forbidden: false }),
		onForbidden: () => set({ reading: null, forbidden: true }),
		forbiddenRetryDelayMs: 30_000,
		// 401・消えた token をセッションの制御へ知らせる（/api/events を開かない画面では必須）。
		...sessionStreamHooks()
	});
}
