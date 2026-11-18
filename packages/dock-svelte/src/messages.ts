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
}

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
	autoHideBand: (edge) =>
		`${{ left: '左', right: '右', top: '上', bottom: '下' }[edge]}に自動で隠したパネル`
};
