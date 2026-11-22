/**
 * `@banto/charts/testing` (#852): the jsdom stand-ins a chart needs to mount,
 * and the way to put them back. For apps that build components on top of
 * `@banto/charts` and test them in jsdom.
 *
 * jsdom has no layout, so `ChartContainer`'s `bind:clientWidth` stays 0 and
 * a chart renders only its empty state; `ResizeObserver` is missing too (the
 * label font tracker uses it). `installChartDom()` fills both in and returns
 * a `restore()` that puts back exactly what was there before.
 *
 * This module imports nothing from a test runner (only `svelte`), so it works
 * with vitest, jest or anything else. `jsdom` and `@testing-library/svelte`
 * belong to the app's devDependencies.
 */
import { tick } from 'svelte';

export interface ChartDomOptions {
	/** Width (px) every element reports as `clientWidth` / `offsetWidth`. Must be > 0 for a chart to draw. Default 400. */
	width?: number;
	/** Height (px) every element reports as `clientHeight` / `offsetHeight`. Default 240. */
	height?: number;
}

export interface ChartDomHandle {
	/** Puts back every property `installChartDom` replaced. Safe to call more than once. */
	restore(): void;
}

const SIZE_PROPS = {
	clientWidth: 'width',
	offsetWidth: 'width',
	clientHeight: 'height',
	offsetHeight: 'height'
} as const;

class StubResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

// True while an install is in effect. Stacking installs would make the restore
// order matter (A then B, restored A then B, leaves B's stand-ins behind), so a
// second call is refused instead.
let active = false;

/**
 * Gives every `HTMLElement` a non-zero size and installs a no-op
 * `ResizeObserver`. Call `restore()` (e.g. in `afterEach`) to undo it.
 * Throws if an install is still in effect: call `restore()` first.
 */
export function installChartDom(options: ChartDomOptions = {}): ChartDomHandle {
	if (active)
		throw new Error(
			'installChartDom: already installed. Call restore() on the earlier handle first (check for a per-test setup stacked on a shared one).'
		);
	const size = { width: options.width ?? 400, height: options.height ?? 240 };
	if (!(size.width > 0) || !(size.height > 0))
		throw new RangeError('installChartDom: width and height must be greater than 0');

	const proto = HTMLElement.prototype;
	const saved = new Map<string, PropertyDescriptor | undefined>();
	const savedObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
	// Undo whatever has been replaced so far (used on failure and by restore()).
	const revert = () => {
		for (const [prop, descriptor] of saved) {
			if (descriptor) Object.defineProperty(proto, prop, descriptor);
			else delete (proto as unknown as Record<string, unknown>)[prop];
		}
		saved.clear();
		if (savedObserver) Object.defineProperty(globalThis, 'ResizeObserver', savedObserver);
		else delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
	};
	try {
		for (const [prop, dim] of Object.entries(SIZE_PROPS)) {
			const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
			Object.defineProperty(proto, prop, { configurable: true, get: () => size[dim] });
			saved.set(prop, descriptor);
		}
		Object.defineProperty(globalThis, 'ResizeObserver', {
			configurable: true,
			writable: true,
			value: StubResizeObserver
		});
	} catch (error) {
		// Half-installed: put back what was replaced, leave `active` false so a retry works.
		try {
			revert();
		} catch {
			// nothing more can be done; surface the original failure
		}
		throw error;
	}
	active = true;

	let restored = false;
	return {
		restore() {
			if (restored) return;
			restored = true;
			active = false;
			revert();
		}
	};
}

/**
 * Waits until the chart has taken the measured size and rendered the plot:
 * a Svelte `tick()` plus one macrotask (the size binding settles after mount).
 */
export async function flushChart(): Promise<void> {
	await tick();
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	await tick();
}
