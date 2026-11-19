import { afterEach, describe, expect, it } from 'vitest';
import { defaultDockMessages, type DockMessages } from '@banto/dock-svelte';
import { overwriteGetLocale, type Locale } from '#lib/paraglide/runtime.js';
import { dockMessages } from './dockMessages.js';

const use = (l: Locale) => overwriteGetLocale(() => l);
const EDGES = ['left', 'right', 'top', 'bottom'] as const;

/** Calls every message with sample arguments; returns key -> string. */
function render(t: DockMessages): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, fn] of Object.entries(t) as [string, (...a: unknown[]) => string][]) {
		if (key === 'autoHideBand' || key === 'moveToEdge' || key === 'splitSide') {
			for (const e of EDGES) out[`${key}:${e}`] = fn(e);
		} else if (key === 'movedToEdge') {
			for (const e of EDGES) out[`${key}:${e}`] = fn('T', e);
		} else if (key === 'movedToSplit') {
			for (const e of EDGES) out[`${key}:${e}`] = fn('T', 'U', e);
		} else if (key === 'movedToTabs') out[key] = fn('T', 'U');
		else if (key === 'moveToTabs' || key === 'moveToSplit') out[key] = fn('U');
		else out[key] = fn('T');
	}
	return out;
}

describe('dockMessages (#729)', () => {
	afterEach(() => use('ja'));

	it('ja reproduces defaultDockMessages verbatim (no visual change)', () => {
		use('ja');
		expect(render(dockMessages())).toEqual(render(defaultDockMessages));
	});

	it('en has no Japanese left and fills every key', () => {
		use('en');
		const en = render(dockMessages());
		expect(Object.keys(en).length).toBe(Object.keys(render(defaultDockMessages)).length);
		for (const [key, text] of Object.entries(en)) {
			expect(text, key).not.toMatch(/[　-ヿ一-鿿＀-￯]/);
			expect(text, key).not.toBe('');
		}
		expect(dockMessages().close?.('Chart')).toBe('Close Chart');
	});

	it('extra keys override / add (page-specific pane names)', () => {
		const t = dockMessages({ threePaneLeft: () => 'L' });
		expect(t.threePaneLeft()).toBe('L');
		expect(t.close?.('x')).toBeTruthy();
	});
});
