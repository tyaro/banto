/**
 * i18n layer 1 (docs/conventions.md §13): package-level overridable UI string
 * bundle for @banto/ui. Same convention as `defaultGridMessages` in
 * @banto/grid-svelte - every message is a function so callers always call
 * `t.key(...)` uniformly; `defaultUiMessages` holds the Japanese literal
 * verbatim, so passing nothing reproduces the stock output.
 *
 * Apps that localise (admin-template does, via Paraglide) pass their own
 * text explicitly instead - see `LoadingState`'s `label`.
 */

export interface UiMessages {
	/** LoadingState's screen-reader announcement when no `label` is given. */
	loading?: () => string;
}

export const defaultUiMessages: Required<UiMessages> = {
	loading: () => '読み込み中…'
};
