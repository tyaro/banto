/**
 * LineChart x-axis simplification (spec §6, "ticks-time OPTIONAL" note):
 * x values (typically ISO date strings) are treated as ORDERED CATEGORIES,
 * evenly spaced by array index - not by real elapsed time. Two dates one day
 * apart and two dates one year apart both get one "slot". A genuine time
 * scale (spacing proportional to elapsed time, gap-aware) is out of scope for
 * v1; this is documented here as the accepted simplification.
 *
 * `everyNthIndex` picks which of `count` ordered x-positions get an axis
 * label, so labels don't overlap when there are many more data points than
 * fit legibly across the plot width.
 */
/**
 * Drops tick labels whose rendered boxes would collide. The LAST index is
 * always kept (it is end-anchored: its box extends LEFT of its x); earlier
 * ones are middle-anchored. Walking backwards from the last, an earlier label
 * yields when its right edge (+ `gap`) reaches the kept neighbour's left edge.
 * `xs[i]` / `widths[i]` are parallel to `indices`.
 */
export function dropCollidingTicks(
	indices: number[],
	xs: number[],
	widths: number[],
	gap = 4
): number[] {
	const n = indices.length;
	if (n <= 1) return indices.slice();
	const kept: number[] = [indices[n - 1]];
	let leftEdge = xs[n - 1] - widths[n - 1]; // end-anchored
	for (let k = n - 2; k >= 0; k--) {
		const right = xs[k] + widths[k] / 2;
		if (right + gap <= leftEdge) {
			kept.push(indices[k]);
			leftEdge = xs[k] - widths[k] / 2;
		}
	}
	return kept.reverse();
}

/**
 * Thins MIDDLE-anchored tick labels (e.g. a horizontal bar chart's value
 * axis) so rendered boxes never collide. The FIRST tick (the origin) and the
 * LAST tick are always kept; between them the ticks are evenly stepped:
 * every `step`-th tick counting from the first (0, k, 2k, ...), smallest
 * step that fits. When the last tick is off the stepping, it is appended and
 * the stepped ticks that would collide with it are dropped (never the
 * first). If even first + last collide, only the first (origin) is kept.
 * `xs[i]` / `widths[i]` are the centre and estimated width of tick `i`.
 * Returns the kept indices into `xs` in ascending order.
 */
export function thinCenteredTicks(xs: number[], widths: number[], gap = 4): number[] {
	const n = xs.length;
	if (n <= 1) return xs.map((_, i) => i);
	const fits = (a: number, b: number) => xs[a] + widths[a] / 2 + gap <= xs[b] - widths[b] / 2;
	for (let step = 1; step < n; step++) {
		const kept: number[] = [];
		for (let i = 0; i < n; i += step) kept.push(i);
		if (kept[kept.length - 1] !== n - 1) {
			while (kept.length > 1 && !fits(kept[kept.length - 1], n - 1)) kept.pop();
			kept.push(n - 1);
		}
		let ok = true;
		for (let k = 1; k < kept.length && ok; k++) ok = fits(kept[k - 1], kept[k]);
		if (ok) return kept;
	}
	return [0];
}

export function everyNthIndex(count: number, maxTicks: number): number[] {
	if (count <= 0) return [];
	if (maxTicks <= 0) return [];
	if (count <= maxTicks) return Array.from({ length: count }, (_, i) => i);

	const step = Math.ceil(count / maxTicks);
	const indices: number[] = [];
	for (let i = 0; i < count; i += step) indices.push(i);
	if (indices[indices.length - 1] !== count - 1) {
		// The final index is always labeled; if the last stepped index sits
		// closer than one full step to it, the two labels would collide, so
		// the stepped one yields to the final one.
		if (count - 1 - indices[indices.length - 1] < step) indices.pop();
		indices.push(count - 1);
	}
	return indices;
}
