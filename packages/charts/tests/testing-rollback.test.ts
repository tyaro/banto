// @vitest-environment jsdom
/**
 * `@banto/charts/testing` (#852): when the install fails halfway (here, a
 * `ResizeObserver` that cannot be redefined), the size stand-ins are put back
 * and the next call is not stuck on "already installed".
 *
 * A non-configurable global cannot be undone, so this lives in its own file
 * (each test file gets its own environment).
 */
import { expect, it } from 'vitest';
import { installChartDom } from '../src/testing';

const SIZE_PROPS = ['clientWidth', 'offsetWidth', 'clientHeight', 'offsetHeight'] as const;
const sizeDescriptors = () =>
	SIZE_PROPS.map((p) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, p));

it('rolls back a half-done install and is not left marked as installed', () => {
	Object.defineProperty(globalThis, 'ResizeObserver', {
		configurable: false,
		writable: false,
		value: class {}
	});
	const before = sizeDescriptors();

	expect(() => installChartDom()).toThrow(TypeError);
	expect(sizeDescriptors()).toEqual(before);
	expect(document.createElement('div').clientWidth).toBe(0);

	// Not "already installed": it fails again for the same real reason.
	expect(() => installChartDom()).toThrow(TypeError);
	expect(() => installChartDom()).not.toThrow(/already installed/);
});
