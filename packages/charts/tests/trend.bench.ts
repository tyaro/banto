/**
 * Trend (LineChart) streaming-append performance bench (roadmap.md §3,
 * 性能エスカレーション梯子・第0段; GitHub Discussion #173).
 *
 * Run with `pnpm --filter @banto/charts bench` (NOT part of `vitest run` /
 * CI - timing benchmarks are machine-dependent and must not gate merges,
 * same rule as `packages/grid-svelte/tests/virtual.bench.ts`, which this
 * file's shape follows).
 *
 * Why: Discussion #173 decided the UI declarative layer's next step is
 * schema-driven incremental extension, NOT a renderer swap - but a
 * Canvas/native trend renderer is still on the v2 backlog as the roadmap §3
 * escalation ladder's 第2段 (第1段 is server-side aggregation, see
 * `template-scope.md §4.2`). Before that debate goes anywhere, this bench
 * fixes 第0段: what `LineChart.svelte` ACTUALLY costs, in script time, per
 * streaming sample append - the same "vitest bench on the hot path, not
 * browser FPS" method as improvement-plan P4-2 (`virtual.bench.ts`).
 *
 * What one bench iteration reproduces (LineChart.svelte:120-280 is the
 * source of truth - if the two drift, the component wins and this file
 * should be updated to match):
 *
 *   1. `rollingAppend` (core/rolling.ts) appends one new row to a
 *      already-full rolling window of `W` rows, evicting the oldest.
 *   2. `seriesValues` (LineChart.svelte:136): per series, `data.map` through
 *      `getValue`/`toNumber` to a plain number array.
 *   3. `extentOf` (LineChart.svelte:140-155): an explicit min/max loop across
 *      every series' values (NOT `Math.min(...arr)`, so it can't overflow
 *      the argument-spread stack limit at 100k points).
 *   4. `decimatedIndices(0, W-1, 800)` (core/decimate.ts): the visible range
 *      is the full window (no zoom) decimated to ~800 samples (a typical
 *      plot width in px).
 *   5. `linearScale` (core/scale.ts) maps each decimated index to x/y pixel
 *      coordinates, then `linePath` (core/path.ts) joins them into one SVG
 *      path string per series.
 *
 * Deliberately excluded: `xLabels`, tick arrays, legend items, and the
 * right-axis margin/scale. Those are cheap string/array derivations that
 * also re-run per append, but the instruction this bench was built from
 * scopes it to the numeric hot path above; they don't change how the cost
 * scales with S x W.
 *
 * Matrix: series count S in {2, 10} x rolling-window size W in {1,000 /
 * 10,000 / 100,000} points - 6 combinations per describe. Row data is
 * `{ t, s0..s(S-1) }`, generated with a deterministic linear-congruential
 * generator (no `Math.random`, so a run is reproducible; conventions §3 -
 * no new dependency for this).
 *
 * Two describes, so the relationship between them is readable directly:
 *
 * - **"full re-derive per append"**: steps 1-5 above, i.e. exactly what
 *   `LineChart.svelte` pays today on every streaming append (a brand-new
 *   `data` array reference forces its whole coarse-grained `$derived` chain
 *   to rerun). Expected scaling: **O(S x W)** - `seriesValues`/`extentOf`
 *   both touch every row of every series. That "full rebuild is the
 *   dominant cost, not the render math" reading is the whole point of this
 *   bench: it is the argument for (or against) reaching for
 *   incremental/windowed derivation before reaching for a renderer change.
 * - **"decimation+path only"**: steps 4-5 only (skips the append + the
 *   O(S x W) `seriesValues`/`extentOf` rebuild, which only reruns when the
 *   underlying data changes) - this is what a pan/zoom frame costs once
 *   `data` is static. Expected scaling: **O(S x decimated-output-count)**,
 *   where the decimated-output-count is bounded near `target` (800) but is
 *   NOT exactly constant across `W` - `decimatedIndices`' plain
 *   stride/nth-point decimation (core/decimate.ts) recomputes
 *   `stride = ceil(W / 800)` per call, so the actual output size sawtooths
 *   between roughly `target/2` and `target` depending on where `W` falls
 *   relative to the nearest stride boundary (measured: 501 indices at
 *   W=1,000, 771 at W=10,000, 801 at W=100,000 - NOT the flat "always ~800"
 *   an idealized reducer would give). The bench numbers below reflect that.
 *
 * Representative results (machine-dependent; re-run to refresh - Node
 * v22.22.2, 2026-08-25 dev container):
 *
 * | bench                 |  S=2, W=1k | S=2, W=10k | S=2, W=100k | S=10, W=1k | S=10, W=10k | S=10, W=100k |
 * | ---------------------- | ---------: | ---------: | ----------: | ---------: | ----------: | -----------: |
 * | full re-derive         | ~1.21k ops/s (0.82ms) | ~472 ops/s (2.12ms) | ~40.7 ops/s (24.6ms) | ~319 ops/s (3.14ms) | ~86.5 ops/s (11.6ms) | ~6.07 ops/s (165ms) |
 * | decimation+path only   | ~3.42k ops/s (0.29ms) | ~2.24k ops/s (0.45ms) | ~1.75k ops/s (0.57ms) | ~480 ops/s (2.08ms) | ~196 ops/s (5.09ms) | ~189 ops/s (5.28ms) |
 *
 * Reading:
 *
 * - "full re-derive" is close to O(W) only once `W` is large enough for the
 *   O(S x W) term to dominate fixed per-call overhead (closures, small
 *   allocations): 10k->100k drops ~11.6x (S=2) / ~14.2x (S=10) for a 10x `W`
 *   increase (roughly linear, the mild excess plausibly GC/allocation cost
 *   on megabyte-scale intermediate arrays), while 1k->10k drops only ~2.6x /
 *   ~3.7x - well under 10x, i.e. sub-linear at small `W` because per-call
 *   overhead is still a comparable fraction of the total. The asymptotic
 *   O(S x W) reading is a large-`W` property, not a claim that every step
 *   scales exactly 10x.
 * - "decimation+path only" moves far less than "full re-derive" across the
 *   same 100x range of `W` (S=2: 3.42k -> 1.75k ops/s, under 2x; S=10: 480
 *   -> 189 ops/s, under 2.6x) - consistent with the bounded, sawtoothing
 *   output-index count above (501 -> 771 -> 801), not with O(W). This is
 *   the "pan/zoom stays cheap regardless of window size" property the
 *   escalation ladder's 第0段 needs confirmed before arguing 第2段 (Canvas)
 *   is necessary.
 * - The ratio between the two describes at a given (S, W) is the clearest
 *   read on where a streaming append's cost actually goes: at W=1,000 full
 *   re-derive is only ~2.8x (S=2) / ~1.5x (S=10) the decimation-only cost,
 *   but at W=100,000 that gap widens to ~43x (S=2) / ~31x (S=10) - as the
 *   window grows, the O(S x W) `seriesValues`/`extentOf`/`rollingAppend`
 *   rebuild increasingly dominates the bounded decimate+draw stage. That
 *   growing gap - not the render math - is where an incremental/windowed
 *   derivation (append-only update instead of `data.map`-from-scratch every
 *   time) would pay off before a renderer swap does.
 */
import { bench, describe } from 'vitest';
import { rollingAppend } from '../src/core/rolling';
import { decimatedIndices } from '../src/core/decimate';
import { linearScale } from '../src/core/scale';
import { linePath, type Point } from '../src/core/path';
import { getValue, toNumber, type Accessor } from '../src/types';

interface TrendRow {
	t: number;
	[key: string]: number;
}

/**
 * Deterministic PRNG (linear congruential generator) so bench data is
 * reproducible run-to-run without a dependency (conventions §3) - plain
 * `Math.random` would make results non-reproducible for no benefit here.
 */
function makeLcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		return state / 0x100000000;
	};
}

const SERIES_COUNTS = [2, 10] as const;
const WINDOW_SIZES = [1_000, 10_000, 100_000] as const;
// Plot width in px LineChart would measure for a typical container -
// matches the instruction's "プロット幅800px相当" and `decimatedIndices`'s
// `target` parameter.
const PLOT_WIDTH_PX = 800;
// LineChart's default height/margin (DEFAULT_MARGIN, LineChart.svelte:113),
// used only so the y range is representative - the scale math's cost is
// O(1) regardless of the actual numbers.
const CHART_HEIGHT = 240;
const INNER_TOP = 12;
const INNER_BOTTOM = CHART_HEIGHT - 28;

function seriesKey(i: number): string {
	return `s${i}`;
}

function makeRow(t: number, seriesCount: number, rand: () => number): TrendRow {
	const row: TrendRow = { t };
	for (let s = 0; s < seriesCount; s++) {
		row[seriesKey(s)] = rand() * 100;
	}
	return row;
}

/** A rolling window already at capacity `w`, seeded per (S, W) pair so different combinations don't share generator state. */
function makeFullWindow(seriesCount: number, w: number): TrendRow[] {
	const rand = makeLcg(seriesCount * 100_000 + w);
	const rows: TrendRow[] = new Array(w);
	for (let i = 0; i < w; i++) rows[i] = makeRow(i, seriesCount, rand);
	return rows;
}

function yAccessor(i: number): Accessor<TrendRow> {
	return seriesKey(i);
}

/** Reproduces LineChart.svelte's per-series `data.map` (L136). */
function seriesValuesOf(data: TrendRow[], seriesCount: number): number[][] {
	const out: number[][] = new Array(seriesCount);
	for (let s = 0; s < seriesCount; s++) {
		const accessor = yAccessor(s);
		out[s] = data.map((row) => toNumber(getValue(row, accessor)));
	}
	return out;
}

/** Reproduces LineChart.svelte's `extentOf` explicit min/max loop (L140-155), which avoids `Math.min(...arr)` so it can't overflow the argument-spread stack limit at 100k points. */
function extentOf(seriesValues: number[][]): [number, number] {
	let min = Infinity;
	let max = -Infinity;
	for (const arr of seriesValues) {
		for (let k = 0; k < arr.length; k++) {
			const v = arr[k];
			if (Number.isFinite(v)) {
				if (v < min) min = v;
				if (v > max) max = v;
			}
		}
	}
	return [min, max];
}

/** Reproduces LineChart.svelte's `seriesPaths` step: scale each decimated index to x/y, then join into one SVG path per series. */
function pathsFor(
	seriesValues: number[][],
	indices: number[],
	scaleX: (i: number) => number,
	scaleY: (v: number) => number
): string[] {
	const out: string[] = new Array(seriesValues.length);
	for (let s = 0; s < seriesValues.length; s++) {
		const vals = seriesValues[s];
		const pts: Point[] = [];
		for (const idx of indices) {
			const v = vals[idx];
			if (Number.isFinite(v)) pts.push({ x: scaleX(idx), y: scaleY(v) });
		}
		out[s] = linePath(pts);
	}
	return out;
}

describe('full re-derive per append (O(S x W); should scale ~linearly with W)', () => {
	for (const S of SERIES_COUNTS) {
		for (const W of WINDOW_SIZES) {
			const baseWindow = makeFullWindow(S, W);
			const appendRand = makeLcg(S * 7 + W * 13 + 1);
			let tick = W; // continues the base window's t sequence

			bench(`S=${S}, W=${W.toLocaleString()}`, () => {
				const newRow = makeRow(tick++, S, appendRand);
				const data = rollingAppend(baseWindow, [newRow], W);

				const seriesValues = seriesValuesOf(data, S);
				const [lo, hi] = extentOf(seriesValues);

				const indices = decimatedIndices(0, data.length - 1, PLOT_WIDTH_PX);
				const scaleX = linearScale([0, data.length - 1], [0, PLOT_WIDTH_PX]);
				const scaleY = linearScale([lo, hi], [INNER_BOTTOM, INNER_TOP]);

				pathsFor(seriesValues, indices, scaleX, scaleY);
			});
		}
	}
});

describe('decimation+path only (pan/zoom cost, data unchanged; bounded near target, not O(W))', () => {
	for (const S of SERIES_COUNTS) {
		for (const W of WINDOW_SIZES) {
			const data = makeFullWindow(S, W);
			const seriesValues = seriesValuesOf(data, S);
			const [lo, hi] = extentOf(seriesValues);
			const scaleX = linearScale([0, data.length - 1], [0, PLOT_WIDTH_PX]);
			const scaleY = linearScale([lo, hi], [INNER_BOTTOM, INNER_TOP]);

			bench(`S=${S}, W=${W.toLocaleString()}`, () => {
				const indices = decimatedIndices(0, data.length - 1, PLOT_WIDTH_PX);
				pathsFor(seriesValues, indices, scaleX, scaleY);
			});
		}
	}
});
