/**
 * i18n layer 1 (docs/i18n-plan.md §3.2): package-level overridable UI string
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
}

export const defaultDockMessages: Required<DockMessages> = {
	popOut: (title) => `${title}を別ウィンドウで開く`,
	close: (title) => `${title}を閉じる`,
	resizeHandle: () => 'パネルのサイズ変更'
};
