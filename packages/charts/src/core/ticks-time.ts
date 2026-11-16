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
