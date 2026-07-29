/**
 * Shared dashboard-panel id/title/icon defs (spec §5.3 v2 pop-out).
 *
 * A single source of truth used from TWO places:
 *  - the dashboard page (`routes/(app)/dashboard/+page.svelte`), which feeds
 *    this straight into `@banto/dock-svelte`'s `FloatingWindowDef[]` shape
 *    (`DockState.ensureWindow`/`reset`/its own `defaultLayout()`);
 *  - the standalone `routes/panel/[id]/+page.svelte` route, which is what a
 *    panel renders as once popped out into a REAL Tauri `WebviewWindow` (spec
 *    §5.3) - it has no access to the dashboard page's own locals, so it looks
 *    the title/icon up here instead.
 *
 * Kept as a plain array (not a `Record`) so it stays directly assignable to
 * `FloatingWindowDef[]`; `findPanelDef` below is the map-like lookup the
 * route needs.
 */
import type { FloatingWindowDef } from '@banto/dock-svelte';

// i18n (ADR-0005, PR-B2): panel titles are deliberately LEFT as Japanese
// literals. This module is evaluated at app startup and its titles are also
// serialized into the persisted dock layout, so resolving them via a
// module-eval `m['…']()` would (a) freeze to the English `baseLocale` before
// locale.ts registers the `custom-banto` strategy, and (b) bake a locale into
// saved layouts. Keying panel titles is a PR-B2b residual (needs a
// locale-ready-safe + layout-migration-safe approach).
export const PANEL_DEFS: FloatingWindowDef[] = [
	{ id: 'monthly', title: '月別更新件数', icon: '📈', width: 420, height: 320 },
	{ id: 'priceBuckets', title: '価格帯分布', icon: '🥧', width: 360, height: 320 },
	// M13 (roadmap.md): SPC panel (histogram + Pareto + box plot, one SVG
	// export button) and a streaming trend panel (zoom/pan, bands, markers,
	// second y-axis). Not in `defaultLayout()`'s docked split - they only
	// appear once toggled from the toolbar, so an existing saved layout
	// (seeded before M13) is never disturbed (spec: 既存パネルのレイアウトを壊さない).
	{ id: 'spc', title: 'SPC', icon: '📊', width: 460, height: 640 },
	{ id: 'trend', title: 'トレンド', icon: '📉', width: 640, height: 360 },
	{ id: 'memo', title: 'メモ', icon: '📝', width: 320, height: 220 }
];

/** Look up a panel def by id; `undefined` for an unknown id (e.g. a stale/typo'd panel window). */
export function findPanelDef(id: string): FloatingWindowDef | undefined {
	return PANEL_DEFS.find((def) => def.id === id);
}
