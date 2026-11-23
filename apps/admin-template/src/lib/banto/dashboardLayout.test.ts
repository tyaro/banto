/**
 * The dashboard dock's default arrangement and the check of a saved value (dashboardLayout.ts,
 * downstream-requests-2026-11-plan §4.13.3, #716 W2).
 *
 * scaffold: removed with the dock (`removeDock`). A copy without the charts keeps it, so nothing
 * here needs a chart widget to be registered: the expected order is narrowed to what is.
 */
import { describe, expect, it } from 'vitest';
import { createDockState, type DockLayout, type DockNode } from '@banto/dock-svelte';
import {
	DASHBOARD_LAYOUT_SETTING_KEY,
	DASHBOARD_LAYOUT_STORAGE_KEY,
	DASHBOARD_ROW_HEIGHT,
	dashboardDockHeight,
	defaultDashboardLayout,
	validateDashboardLayout
} from './dashboardLayout';
import { DASHBOARD_WIDGETS, findDashboardWidget } from './dashboardWidgets';

function panelIds(node: DockNode | null): string[] {
	if (node === null) return [];
	if (node.type === 'panel') return [node.id];
	return node.children.flatMap(panelIds);
}

describe('the keys (#716 W2)', () => {
	it('are new: the dock of before W2 is not read', () => {
		expect(DASHBOARD_LAYOUT_SETTING_KEY).toBe('dashboard.widgets');
		expect(DASHBOARD_LAYOUT_STORAGE_KEY).toBe('banto.dashboard.widgets');
		// The provider's key rule (`[A-Za-z0-9._-]{1,64}`).
		expect(DASHBOARD_LAYOUT_SETTING_KEY).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
	});
});

describe('defaultDashboardLayout', () => {
	const layout = defaultDashboardLayout();
	const ids = panelIds(layout.docked);

	it('docks registered widgets only, each once, and floats nothing', () => {
		expect(layout.floating).toEqual([]);
		expect(ids.length).toBeGreaterThan(0);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(findDashboardWidget(id), id).toBeDefined();
	});

	it('gives every pane the title and icon of its registration', () => {
		const visit = (node: DockNode | null): void => {
			if (node === null) return;
			if (node.type === 'panel') {
				const def = findDashboardWidget(node.id)!;
				expect(node.title).toBe(def.title);
				expect(node.icon).toBe(def.icon);
			} else node.children.forEach(visit);
		};
		visit(layout.docked);
	});

	it('gives every split shares that add up to 1 and ids of its own', () => {
		const splitIds: string[] = [];
		const visit = (node: DockNode | null): void => {
			if (node === null || node.type !== 'split') return;
			splitIds.push(node.id);
			expect(node.sizes).toHaveLength(node.children.length);
			expect(node.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1, 10);
			node.children.forEach(visit);
		};
		visit(layout.docked);
		expect(new Set(splitIds).size).toBe(splitIds.length);
		for (const id of splitIds) expect(ids).not.toContain(id);
	});

	it('is a layout the dock takes as it is, and one its own check accepts', () => {
		const dock = createDockState();
		expect(dock.hydrate(JSON.stringify(layout))).toBe(true);
		expect(panelIds(dock.layout.docked)).toEqual(ids);
		expect(validateDashboardLayout(JSON.stringify(layout))).not.toBeNull();
	});

	it('sizes the dock by its rows', () => {
		const rows =
			layout.docked?.type === 'split' && layout.docked.id === 'root'
				? layout.docked.children.length
				: 1;
		expect(dashboardDockHeight()).toBe(rows * DASHBOARD_ROW_HEIGHT);
	});

	it('docks the list in every preset', () => {
		expect(ids).toContain('lowStock');
	});

	it('puts the chart cards of before W2 first, and leaves spc / trend to the View menu', () => {
		// Without the charts (scaffold) only the list and the memo are registered: one row.
		const registered = (id: string) => findDashboardWidget(id) !== undefined;
		expect(ids).toEqual(
			[
				'monthly',
				'categoryStock',
				'stackedBar',
				'priceBuckets',
				'scatter',
				'lowStock',
				'memo'
			].filter(registered)
		);
		expect(ids).not.toContain('spc');
		expect(ids).not.toContain('trend');
		expect(dashboardDockHeight()).toBe((registered('monthly') ? 3 : 1) * DASHBOARD_ROW_HEIGHT);
	});
});

describe('validateDashboardLayout', () => {
	const known = DASHBOARD_WIDGETS[0]!;
	const win = (id: string, title: string) => ({
		id,
		title,
		x: 10,
		y: 20,
		width: 300,
		height: 200,
		open: true
	});
	const withDocked = (docked: DockNode | null, floating: object[] = []): string =>
		JSON.stringify({ version: 4, floating, docked });

	it('keeps a layout of registered widgets, with the titles of today', () => {
		const stored = withDocked({ type: 'panel', id: known.id, title: 'stale title' });
		const result = validateDashboardLayout(stored);
		expect(result).not.toBeNull();
		const layout = JSON.parse(result!) as DockLayout;
		expect(layout.docked).toMatchObject({ type: 'panel', id: known.id, title: known.title });
	});

	it('rejects a layout with a docked panel the registry does not have', () => {
		expect(
			validateDashboardLayout(
				withDocked({
					type: 'split',
					id: 'root',
					direction: 'row',
					sizes: [0.5, 0.5],
					children: [
						{ type: 'panel', id: known.id, title: known.title },
						{ type: 'panel', id: 'gone', title: 'Gone' }
					]
				})
			)
		).toBeNull();
	});

	it('rejects an unknown id in a tab group, a floating window (a closed one too) and an edge band', () => {
		expect(
			validateDashboardLayout(
				withDocked({
					type: 'tabs',
					id: 'tabs-1',
					activeIndex: 0,
					children: [
						{ type: 'panel', id: known.id, title: known.title },
						{ type: 'panel', id: 'gone', title: 'Gone' }
					]
				})
			)
		).toBeNull();
		expect(validateDashboardLayout(withDocked(null, [win('gone', 'Gone')]))).toBeNull();
		expect(
			validateDashboardLayout(withDocked(null, [{ ...win('gone', 'Gone'), open: false }]))
		).toBeNull();
		expect(
			validateDashboardLayout(
				JSON.stringify({
					version: 4,
					floating: [],
					docked: { type: 'panel', id: known.id, title: known.title },
					autoHidden: [{ edge: 'right', node: { type: 'panel', id: 'gone', title: 'Gone' } }]
				})
			)
		).toBeNull();
	});

	it('leaves a value that is not JSON to the dock (which refuses it)', () => {
		expect(validateDashboardLayout('not json')).toBe('not json');
		expect(createDockState().hydrate('not json')).toBe(false);
	});
});
