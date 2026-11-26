/**
 * Pop-out panel windows (spec §5.3 v2 "ウィンドウ分離", Tauri only): this
 * app's binding of `@banto/admin-core`'s `createPanelPopOut` (ADR-0037).
 *
 * The behaviour is not here any more. The frontend half - open the window,
 * hear that it closed, put the panel back - is `@banto/admin-core`'s
 * `panelWindow.ts`; the Tauri half - one window per id, the
 * `banto://panel-closed` notice, the position / size memory, closing with
 * the main window - is the plugin `banto-tauri-panel`, registered in
 * `src-tauri/src/lib.rs` and allowed in `src-tauri/capabilities/default.json`
 * (`banto-tauri-panel:allow-open`).
 *
 * This file only hands over the three things admin-core does not import
 * itself: `isTauri`, `invoke` and `listen`. It keeps the `@tauri-apps/api`
 * imports in `lib/banto` (conventions §10), out of the route.
 */
import { invoke } from '@tauri-apps/api/core'; // safe to import outside Tauri (see setup.ts) - only ever CALLED when isTauri()
import {
	createPanelPopOut,
	type PanelPopOut,
	type PanelPopOutOptions,
	type PanelWindowContent
} from '@banto/admin-core';
import { isTauri } from './setup';

/**
 * `createPanelPopOut` with this app's Tauri functions filled in. In a plain
 * browser the result's `onPopOut` is `undefined` (the dock then draws no
 * pop-out button) and `connect()` registers nothing.
 */
export function createAppPanelPopOut<C extends PanelWindowContent>(
	options: Pick<PanelPopOutOptions<C>, 'detach' | 'restore' | 'onError'>
): PanelPopOut<C> {
	return createPanelPopOut<C>({
		isTauri,
		invoke,
		// Dynamic import: `listen` talks to a Tauri IPC channel that does not
		// exist in a browser tab (same reasoning as setup.ts's event provider).
		listen: async (event, cb) => (await import('@tauri-apps/api/event')).listen(event, cb),
		...options
	});
}
