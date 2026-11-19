/**
 * i18n layer 1 (docs/conventions.md §13): package-level overridable UI string
 * bundle for @banto/dock-svelte's Svelte components (DockHost, DockedTree,
 * DockWindow). Mirrors @banto/grid-svelte's `messages.ts` convention - every
 * message is a function (parameterized ones take the relevant arguments,
 * static ones take none) so callers always call `t.key(...)` uniformly;
 * `defaultDockMessages` holds the current Japanese literals verbatim, so
 * passing nothing reproduces today's output exactly.
 */

export interface DockMessages {
	/** Pop-out button aria-label (DockedTree panel/tab titlebar, DockWindow titlebar), given the panel/window's title. */
	popOut?: (title: string) => string;
	/** Close button aria-label (DockedTree panel/tab titlebar, DockWindow titlebar), given the panel/window's title. */
	close?: (title: string) => string;
	/** Split divider's aria-label (DockedTree). */
	resizeHandle?: () => string;
	/** Keyboard move-mode button aria-label (DockWindow titlebar), given the window's title. Says how the mode is driven (#433-b, D5). */
	moveWindow?: (title: string) => string;
	/** Keyboard resize-mode button aria-label (DockWindow titlebar), given the window's title. */
	resizeWindow?: (title: string) => string;
	/** Lock button aria-label while the window is NOT locked (DockWindow titlebar); `aria-pressed` carries the state (#663 ②, #694 PR-3). */
	lockWindow?: (title: string) => string;
	/** Lock button aria-label while the window IS locked: pressing it unlocks. */
	unlockWindow?: (title: string) => string;
	/** @deprecated Use `lockWindow` (#694 PR-3: the pin now means auto-hide). Still honoured when `lockWindow` is not given. Removed in the next major. */
	pinWindow?: (title: string) => string;
	/** @deprecated Use `unlockWindow` (#694 PR-3). Still honoured when `unlockWindow` is not given. Removed in the next major. */
	unpinWindow?: (title: string) => string;
	/** Collapse button aria-label while the window is expanded (DockWindow titlebar); `aria-expanded` carries the state (#663 ③-A). */
	collapseWindow?: (title: string) => string;
	/** Collapse button aria-label while the window IS collapsed: pressing it expands. */
	expandWindow?: (title: string) => string;
	/** Collapse button aria-label of a docked region (DockedTree header / tab strip, #663 ③-B): `title` is the pane's (the front tab's) title. */
	collapsePane?: (title: string) => string;
	/** Collapse button aria-label while the docked region IS collapsed to a band: pressing it expands. */
	expandPane?: (title: string) => string;
	/** Pin button aria-label of a docked region (DockedTree header, #694 PR-3): pressing it unpins = auto-hides the region to an edge band. `title` is the pane's (the front tab's) title. */
	autoHidePane?: (title: string) => string;
	/** Pin button aria-label of a slid-out auto-hidden pane: pressing it pins the region back in its docked place. */
	pinPane?: (title: string) => string;
	/** aria-label of an edge band holding auto-hidden panes (#694 PR-3). */
	autoHideBand?: (edge: 'left' | 'right' | 'top' | 'bottom') => string;
	/** "Panel actions" menu button aria-label and the menu's name (#663 ④: DockedTree pane titlebar / active tab, DockWindow titlebar), given the panel's title. */
	panelMenu?: (title: string) => string;
	/** Menu item: dock the panel at an outer edge of the host. */
	moveToEdge?: (edge: 'left' | 'right' | 'top' | 'bottom') => string;
	/** Menu item: join the docked panel `target` as a tab. */
	moveToTabs?: (target: string) => string;
	/** Menu item opening the side choice for docking next to the panel `target` (a submenu). */
	moveToSplit?: (target: string) => string;
	/** Item of that submenu: the side next to the target. */
	splitSide?: (side: 'left' | 'right' | 'top' | 'bottom') => string;
	/** Item of that submenu going back to the first list. */
	menuBack?: () => string;
	/** Menu item: float the docked panel as a window. */
	floatPanel?: () => string;
	/** Menu item: dock the floating panel back where it was floated from. */
	dockBack?: () => string;
	/** Announced (`aria-live="polite"`) after the panel `title` was docked at an outer edge. */
	movedToEdge?: (title: string, edge: 'left' | 'right' | 'top' | 'bottom') => string;
	/** Announced after the panel `title` joined `target` as a tab. */
	movedToTabs?: (title: string, target: string) => string;
	/** Announced after the panel `title` was docked next to `target` on `side`. */
	movedToSplit?: (
		title: string,
		target: string,
		side: 'left' | 'right' | 'top' | 'bottom'
	) => string;
	/** Announced after the panel `title` was floated. */
	floated?: (title: string) => string;
	/** Announced after the panel `title` went back to its docked place. */
	dockedBack?: (title: string) => string;
	/** Announced when `beforePanelChange` refused the move: nothing changed. */
	moveCancelled?: (title: string) => string;
	/** Announced when the layout changed while the move was being confirmed (`stale`): nothing changed. */
	moveStale?: (title: string) => string;
	/** Announced when the move is not offered (capabilities, a locked window, the target is gone): nothing changed. */
	moveUnavailable?: (title: string) => string;
}

const SIDE = { left: '左', right: '右', top: '上', bottom: '下' } as const;

export const defaultDockMessages: Required<DockMessages> = {
	popOut: (title) => `${title}を別ウィンドウで開く`,
	close: (title) => `${title}を閉じる`,
	resizeHandle: () => 'パネルのサイズ変更',
	moveWindow: (title) =>
		`${title}をキーボードで移動（矢印で動かす・Shift で大きく・Enter で確定・Esc で取消）`,
	resizeWindow: (title) =>
		`${title}をキーボードでサイズ変更（矢印で変える・Shift で大きく・Enter で確定・Esc で取消）`,
	lockWindow: (title) => `${title}の位置と大きさを固定`,
	unlockWindow: (title) => `${title}の位置と大きさの固定を外す`,
	pinWindow: (title) => `${title}の位置と大きさを固定`,
	unpinWindow: (title) => `${title}の位置と大きさの固定を外す`,
	collapseWindow: (title) => `${title}を折りたたむ`,
	expandWindow: (title) => `${title}を展開`,
	collapsePane: (title) => `${title}を帯に折りたたむ`,
	expandPane: (title) => `${title}を帯から展開`,
	autoHidePane: (title) => `${title}を自動で隠す（ピンを外す）`,
	pinPane: (title) => `${title}を元の場所に固定（ピンを留める）`,
	autoHideBand: (edge) => `${SIDE[edge]}に自動で隠したパネル`,
	panelMenu: (title) => `${title}のパネルの操作`,
	moveToEdge: (edge) => `${SIDE[edge]}端にドッキング`,
	moveToTabs: (target) => `${target}とタブにまとめる`,
	moveToSplit: (target) => `${target}の隣にドッキング`,
	splitSide: (side) => `${SIDE[side]}に`,
	menuBack: () => '戻る',
	floatPanel: () => '浮かせる',
	dockBack: () => '元の場所に戻す',
	movedToEdge: (title, edge) => `${title}を${SIDE[edge]}端にドッキングしました`,
	movedToTabs: (title, target) => `${title}を${target}とタブにまとめました`,
	movedToSplit: (title, target, side) => `${title}を${target}の${SIDE[side]}にドッキングしました`,
	floated: (title) => `${title}を浮かせました`,
	dockedBack: (title) => `${title}を元の場所に戻しました`,
	moveCancelled: (title) => `${title}の移動は取り消されました`,
	moveStale: (title) => `移動できません: 確かめている間にレイアウトが変わりました（${title}）`,
	moveUnavailable: (title) => `移動できません: ${title}はその場所へ移せません`
};
