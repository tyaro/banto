// @vitest-environment jsdom
//
// The tab strip shrinks its tabs and ellipsizes the titles when it is too narrow (#986).
// jsdom has no layout, so this checks the structure (the full title in `title` / `aria-label`)
// and the CSS the component ships; the real overflow is measured by
// `e2e/demo/dock-tab-strip-overflow.spec.ts`.
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import DockHostHarness from './DockHostHarness.svelte';
// @ts-expect-error -- Vite ?raw import; this package has no vite/client or node types
import source from '../src/DockedTree.svelte?raw';
import { createDockState } from '../src/state.svelte';
import type { DockLayout } from '../src/types';

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

const layout = (): DockLayout => ({
	version: 4,
	floating: [],
	docked: {
		type: 'tabs',
		id: 't',
		activeIndex: 0,
		children: [
			{ type: 'panel', id: 'a', title: 'プロジェクト' },
			{ type: 'panel', id: 'b', title: 'レイヤー' },
			{ type: 'panel', id: 'c', title: '部品' }
		]
	}
});

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
	const start = css.search(new RegExp(`\\n\\t${selector.replace('.', '\\.')} \\{`));
	if (start < 0) return '';
	return css.slice(start, css.indexOf('}', start));
}

describe('tab strip shrinking (#986)', () => {
	it('keeps the full title in the title attribute and aria-label of every tab', () => {
		render(DockHostHarness, { dock: createDockState(layout()) });
		for (const name of ['プロジェクト', 'レイヤー', '部品']) {
			const tab = screen.getByRole('tab', { name });
			const title = tab.querySelector<HTMLElement>('.title');
			expect(tab.getAttribute('aria-label')).toBe(name);
			expect(title?.getAttribute('title')).toBe(name);
			expect(title?.textContent).toBe(name);
		}
	});

	it('lets the tab shrink and ellipsizes the title in the shipped CSS', () => {
		const css = source.slice(source.indexOf('<style>'));
		expect(rule(css, '.tab')).toMatch(/flex:\s*0 1 auto/);
		// The minimum is built from the rendered controls at their real size (touch: 40px).
		expect(rule(css, '.tab')).toMatch(/min-width:\s*calc\(/);
		expect(rule(css, '.tab')).toMatch(/var\(--_controls, 0\)/);
		expect(rule(css, '.tab')).toMatch(/var\(--banto-dock-button-size/);
		expect(rule(css, '.title')).toMatch(/overflow:\s*hidden/);
		expect(rule(css, '.title')).toMatch(/text-overflow:\s*ellipsis/);
		expect(rule(css, '.title')).toMatch(/white-space:\s*nowrap/);
		expect(rule(css, '.title')).toMatch(/min-width:\s*0/);
	});
});
