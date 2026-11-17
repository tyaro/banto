import { describe, expect, it } from 'vitest';
import {
	parseWorkspaceView,
	sameWorkspaceScope,
	workspaceHref,
	workspaceSearch,
	type WorkspaceLookup
} from './workspaceUrl';

const lookup: WorkspaceLookup = {
	hasTarget: (id) => id === 'a' || id === 'b',
	hasRow: (target, row) => target === 'a' && (row === 'r1' || row === 'r2')
};

describe('parseWorkspaceView', () => {
	it('空の URL は未選択・一覧', () => {
		expect(parseWorkspaceView('', lookup)).toEqual({ target: null, tab: 'list', row: null });
	});

	it('target・tab・row を読む（先頭の ? あり/なし/URLSearchParams）', () => {
		const expected = { target: 'a', tab: 'list', row: 'r2' };
		expect(parseWorkspaceView('?target=a&row=r2', lookup)).toEqual(expected);
		expect(parseWorkspaceView('target=a&tab=list&row=r2', lookup)).toEqual(expected);
		expect(parseWorkspaceView(new URLSearchParams('target=a&row=r2'), lookup)).toEqual(expected);
	});

	it('存在しない・空の target は未選択に落ち、tab・row も既定へ', () => {
		const none = { target: null, tab: 'list', row: null };
		expect(parseWorkspaceView('?target=zzz&tab=settings&row=r1', lookup)).toEqual(none);
		expect(parseWorkspaceView('?target=&tab=settings', lookup)).toEqual(none);
		expect(parseWorkspaceView('?tab=settings', lookup)).toEqual(none);
	});

	it('不正な tab は既定の一覧（大文字違い・空・未知）', () => {
		for (const tab of ['', 'LIST', 'Settings', 'detail', 'list,settings']) {
			expect(parseWorkspaceView(`?target=a&tab=${tab}`, lookup).tab).toBe('list');
		}
		expect(parseWorkspaceView('?target=a&tab=settings', lookup).tab).toBe('settings');
	});

	it('row は対象に属する行だけ。別の対象の行・存在しない行・設定タブでは捨てる', () => {
		expect(parseWorkspaceView('?target=b&row=r1', lookup).row).toBeNull();
		expect(parseWorkspaceView('?target=a&row=nope', lookup).row).toBeNull();
		expect(parseWorkspaceView('?target=a&tab=settings&row=r1', lookup)).toEqual({
			target: 'a',
			tab: 'settings',
			row: null
		});
	});

	it('同じキーが複数あれば最初の値を採る', () => {
		expect(parseWorkspaceView('?target=zzz&target=a', lookup).target).toBeNull();
		expect(parseWorkspaceView('?target=a&target=b', lookup).target).toBe('a');
	});

	it('エンコードされた値を復元する', () => {
		const odd: WorkspaceLookup = { hasTarget: (id) => id === 'a b&c', hasRow: () => false };
		expect(parseWorkspaceView('?target=a%20b%26c', odd).target).toBe('a b&c');
	});
});

describe('workspaceSearch / workspaceHref', () => {
	it('未選択は空。既定のタブ・行なしは出さない', () => {
		expect(workspaceSearch({ target: null, tab: 'list', row: null })).toBe('');
		expect(workspaceSearch({ target: 'a', tab: 'list', row: null })).toBe('?target=a');
		expect(workspaceSearch({ target: 'a', tab: 'settings', row: null })).toBe(
			'?target=a&tab=settings'
		);
		expect(workspaceSearch({ target: 'a', tab: 'list', row: 'r1' })).toBe('?target=a&row=r1');
	});

	it('未選択の tab・row と、設定タブの row は出さない', () => {
		expect(workspaceSearch({ target: null, tab: 'settings', row: 'r1' })).toBe('');
		expect(workspaceSearch({ target: 'a', tab: 'settings', row: 'r1' })).toBe(
			'?target=a&tab=settings'
		);
	});

	it('値をエンコードし、parse と往復できる', () => {
		const odd: WorkspaceLookup = { hasTarget: () => true, hasRow: () => true };
		const view = { target: 'a b&c', tab: 'list', row: 'x=1' } as const;
		expect(parseWorkspaceView(workspaceSearch(view), odd)).toEqual(view);
	});

	it('href は pathname + search', () => {
		expect(workspaceHref('/tree/workspace', { target: 'a', tab: 'settings', row: null })).toBe(
			'/tree/workspace?target=a&tab=settings'
		);
		expect(workspaceHref('/tree/workspace', { target: null, tab: 'list', row: null })).toBe(
			'/tree/workspace'
		);
	});
});

describe('sameWorkspaceScope', () => {
	it('行だけの違いは同じ範囲', () => {
		const base = { target: 'a', tab: 'list', row: null } as const;
		expect(sameWorkspaceScope(base, { ...base, row: 'r1' })).toBe(true);
		expect(sameWorkspaceScope(base, { ...base, tab: 'settings' })).toBe(false);
		expect(sameWorkspaceScope(base, { ...base, target: 'b' })).toBe(false);
	});
});
