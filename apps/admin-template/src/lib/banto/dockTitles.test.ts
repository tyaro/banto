import { afterEach, describe, expect, it } from 'vitest';
import { createDockState, type DockLayout } from '@banto/dock-svelte';
import { findDashboardWidget } from '#lib/banto/dashboardWidgets.js';
import { refreshPanelTitles } from '#lib/banto/dockTitles.js';
import { dockMessages } from '#lib/banto/dockMessages.js';
import { overwriteGetLocale, type Locale } from '#lib/paraglide/runtime.js';

const use = (l: Locale) => overwriteGetLocale(() => l);
const JA = /[\u3040-\u30ff\u4e00-\u9fff]/;
const lookup = (id: string) => findDashboardWidget(id)?.title;

const win = (id: string, title: string, extra: object = {}) => ({
	id,
	title,
	x: 10,
	y: 20,
	width: 300,
	height: 200,
	open: true,
	...extra
});

/** A layout saved in ja: every place a title is stored. */
function savedInJa(): DockLayout {
	return {
		version: 4,
		floating: [
			win('memo', '\u30e1\u30e2', { x: 77 }),
			win('spc', '\u5de5\u7a0b\u7ba1\u7406', {
				open: false,
				dockShare: 1
			}),
			win('custom', '\u81ea\u4f5c')
		],
		docked: {
			type: 'split',
			id: 'root',
			direction: 'row',
			sizes: [0.3, 0.7],
			children: [
				{ type: 'panel', id: 'monthly', title: '\u6708\u5225' },
				{
					type: 'tabs',
					id: 't1',
					activeIndex: 1,
					children: [
						{ type: 'panel', id: 'priceBuckets', title: '\u4fa1\u683c\u5e2f' },
						{ type: 'panel', id: 'extra', title: '追加' }
					]
				}
			]
		},
		autoHidden: [
			{
				node: { type: 'panel', id: 'paretoLike', title: '\u30d1\u30ec\u30fc\u30c8' },
				edge: 'left'
			},
			{
				node: {
					type: 'tabs',
					id: 't2',
					activeIndex: 0,
					children: [{ type: 'panel', id: 'trend', title: 'トレンド' }]
				},
				edge: 'right'
			}
		]
	} as unknown as DockLayout;
}

describe('refreshPanelTitles (#729 review)', () => {
	afterEach(() => use('ja'));

	it('opens a layout saved in ja with English titles and dock action names, keeping geometry', () => {
		use('en');
		const out = refreshPanelTitles(JSON.stringify(savedInJa()), lookup);
		const dock = createDockState();
		expect(dock.hydrate(out)).toBe(true);
		const layout = dock.layout;

		const memo = layout.floating.find((w) => w.id === 'memo')!;
		expect(memo.title).toBe(findDashboardWidget('memo')!.title);
		expect(memo.title).not.toMatch(JA);
		expect(memo.x).toBe(77); // geometry kept
		const closed = layout.floating.find((w) => w.id === 'spc')!;
		expect(closed.open).toBe(false);
		expect(closed.dockShare).toBe(1);
		expect(closed.title).not.toMatch(JA);

		const root = layout.docked as {
			sizes: number[];
			children: { id: string; title?: string; children?: { title: string }[] }[];
		};
		expect(root.sizes).toEqual([0.3, 0.7]);
		expect(root.children[0].title).not.toMatch(JA);
		const tabs = root.children[1].children!;
		expect(tabs[0].title).not.toMatch(JA);
		expect(tabs[1].title).toBe('追加'); // unknown id kept
		const hiddenTabs = layout.autoHidden![1].node as { children: { title: string }[] };
		expect(hiddenTabs.children[0].title).not.toMatch(JA);

		// Unknown ids keep what was stored.
		expect(layout.floating.find((w) => w.id === 'custom')!.title).toBe('\u81ea\u4f5c');
		const hidden = layout.autoHidden?.[0];
		expect(hidden?.node.type === 'panel' && hidden.node.title).toBe('\u30d1\u30ec\u30fc\u30c8');

		// The dock's own action names built from the refreshed title are English.
		const t = dockMessages();
		expect(t.panelMenu?.(memo.title)).not.toMatch(JA);
	});

	it('resolves auto-hidden known panels too', () => {
		use('en');
		const layout = savedInJa();
		layout.autoHidden![0].node = { type: 'panel', id: 'spc', title: '\u5de5\u7a0b' };
		const out = JSON.parse(refreshPanelTitles(JSON.stringify(layout), lookup)) as DockLayout;
		expect((out.autoHidden![0].node as { title: string }).title).not.toMatch(JA);
	});

	// #782 PR8b: the places of the regions in the edge bands are saved as a tree of their own.
	it('resolves the titles in the tree of the edge bands` places, and the layout still reads with it', () => {
		const dock = createDockState();
		use('ja');
		expect(
			dock.hydrate(
				JSON.stringify({
					version: 4,
					floating: [],
					docked: {
						type: 'split',
						id: 'root',
						direction: 'row',
						sizes: [0.3, 0.7],
						children: [
							{ type: 'panel', id: 'monthly', title: '\u6708\u5225' },
							{ type: 'panel', id: 'spc', title: '\u5de5\u7a0b\u7ba1\u7406' }
						]
					}
				})
			)
		).toBe(true);
		expect(dock.autoHideRegion('spc')).toBe(true);
		const saved = dock.serialize();
		expect(saved).toMatch(JA);

		use('en');
		const out = refreshPanelTitles(saved, lookup);
		expect(out).not.toMatch(JA);
		const restored = createDockState(out);
		expect(restored.layout.dockedWithAutoHidden).toBeDefined();
		expect(restored.restoreAutoHidden('spc')).toBe(true);
		const root = restored.layout.docked as { sizes: number[]; children: { id: string }[] };
		expect(root.children.map((c) => c.id)).toEqual(['monthly', 'spc']);
		expect(root.sizes).toEqual([0.3, 0.7]);
	});

	it('leaves non-JSON for hydrate to reject', () => {
		expect(refreshPanelTitles('not json', lookup)).toBe('not json');
		expect(refreshPanelTitles('[1]', lookup)).toBe('[1]');
	});
});
