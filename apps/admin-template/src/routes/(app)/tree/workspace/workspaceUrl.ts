/**
 * `/tree/workspace`（3 ペインの画面の型、Issue #631 PR③）の URL ⇔ 画面の状態の変換。
 *
 * 画面の状態（選んだ対象・タブ・選んだ行）は URL の `?target=&tab=&row=` が一次情報で、
 * 再読み込み・戻る/進む・リンクの共有で同じ画面に戻れる。ここは純関数だけを持つ
 * （ルーターにも DOM にも触れない）ので、不正な値・存在しない対象などの端の値を
 * ユニットテストで押さえられる。
 *
 * 規則:
 * - `tab` は `list` / `settings` 以外（欠落・大文字違い・空）は既定の `list`。
 * - `target` は存在する対象だけ採る。存在しない・空は無視（`null`）。同じキーが複数あれば最初の値。
 * - 対象がなければタブは `list`・行は `null`（設定タブも行も対象を持って初めて意味がある）。
 * - `row` は選んだ対象の一覧に載っている行だけ採る。設定タブでは持たない。
 * - 既定値（タブ `list`・未選択・行なし）は URL に出さない（URL を短く保つ）。
 */

export const WORKSPACE_TABS = ['list', 'settings'] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
export const DEFAULT_WORKSPACE_TAB: WorkspaceTab = 'list';

export interface WorkspaceView {
	/** 選んだ対象の id。未選択は `null`。 */
	target: string | null;
	tab: WorkspaceTab;
	/** 一覧で選んだ行の id（一覧タブのときだけ）。 */
	row: string | null;
}

/** URL の値が実在するかを確かめる関数（データの持ち方は呼び出し側）。 */
export interface WorkspaceLookup {
	hasTarget(id: string): boolean;
	hasRow(target: string, row: string): boolean;
}

export function isWorkspaceTab(value: string | null | undefined): value is WorkspaceTab {
	return (WORKSPACE_TABS as readonly string[]).includes(value ?? '');
}

/** `search`（`?a=b` でも `a=b` でも URLSearchParams でもよい）を画面の状態へ。不正な値は既定へ落とす。 */
export function parseWorkspaceView(
	search: string | { get(name: string): string | null },
	lookup: WorkspaceLookup
): WorkspaceView {
	const params = typeof search === 'string' ? new URLSearchParams(search) : search;
	const asked = params.get('target');
	const target = asked && lookup.hasTarget(asked) ? asked : null;
	if (target === null) return { target: null, tab: DEFAULT_WORKSPACE_TAB, row: null };
	const askedTab = params.get('tab');
	const tab = isWorkspaceTab(askedTab) ? askedTab : DEFAULT_WORKSPACE_TAB;
	const askedRow = params.get('row');
	const row = tab === 'list' && askedRow && lookup.hasRow(target, askedRow) ? askedRow : null;
	return { target, tab, row };
}

/** 画面の状態を `?…` へ（既定だけなら空文字）。順序は target・tab・row で固定。 */
export function workspaceSearch(view: WorkspaceView): string {
	if (view.target === null) return '';
	const params = new URLSearchParams();
	params.set('target', view.target);
	if (view.tab !== DEFAULT_WORKSPACE_TAB) params.set('tab', view.tab);
	if (view.tab === 'list' && view.row !== null) params.set('row', view.row);
	return `?${params.toString()}`;
}

/** `pathname` に画面の状態の `?…` を付けた href。他のクエリ・ハッシュは持ち越さない（この画面は他に持たない）。 */
export function workspaceHref(pathname: string, view: WorkspaceView): string {
	return `${pathname}${workspaceSearch(view)}`;
}

/** 2 つの状態の対象・タブが同じか（行だけの違いは未保存の設定を捨てない移動）。 */
export function sameWorkspaceScope(a: WorkspaceView, b: WorkspaceView): boolean {
	return a.target === b.target && a.tab === b.tab;
}
