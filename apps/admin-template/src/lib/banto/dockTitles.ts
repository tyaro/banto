/**
 * Re-resolve the panel titles of a saved dock layout in today's locale (#729 review).
 *
 * A saved `DockLayout` carries each panel's `title` as it was when the layout was written, so a
 * layout saved in `ja` and opened in `en` would show Japanese in the title bars and in the dock's
 * own action names (`panelMenu(title)` and so on). This is the `validate` hook of
 * `createDockLayoutStore`: positions, sizes and open / docked state are kept as stored; only the
 * `title` of a panel the app knows (by id) is replaced. An unknown id (an adopter's panel, a
 * stale entry) keeps what was stored. A value that is not JSON is returned unchanged for the
 * dock's own `hydrate` validation to reject.
 *
 * Titles live in: `floating[]` (also a closed window hidden from the dock, `dockShare`), the docked tree's
 * panel nodes and tab-group children, `autoHidden[].node` (a panel or a tab group), and the tree
 * of the places of the regions in the edge bands (`dockedWithAutoHidden`: the docked tree again,
 * with those regions' panes in it).
 *
 * App layer only. Removed together with the dock by `scripts/scaffold.mjs` (`removeDock`).
 */
type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

export function refreshPanelTitles(
	json: string,
	titleOf: (id: string) => string | undefined
): string {
	let layout: unknown;
	try {
		layout = JSON.parse(json);
	} catch {
		return json;
	}
	if (!isObject(layout)) return json;

	const fix = (node: unknown): void => {
		if (!isObject(node)) return;
		if (typeof node.id === 'string' && (node.type === 'panel' || node.type === undefined)) {
			const title = titleOf(node.id);
			if (title !== undefined) node.title = title;
		}
		if (Array.isArray(node.children)) node.children.forEach(fix);
	};

	if (Array.isArray(layout.floating)) layout.floating.forEach(fix);
	fix(layout.docked);
	if (Array.isArray(layout.autoHidden)) {
		for (const entry of layout.autoHidden) if (isObject(entry)) fix(entry.node);
	}
	fix(layout.dockedWithAutoHidden);
	return JSON.stringify(layout);
}
