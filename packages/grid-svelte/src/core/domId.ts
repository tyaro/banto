/**
 * DOM ids for the cells of a grid (#1016), so the grid element can name the
 * active cell with `aria-activedescendant`.
 *
 * A row key (`getRowId`) or a column id is arbitrary text, but an id that
 * `aria-activedescendant` refers to must hold no whitespace, and two cells
 * must never share one. So every character outside `[A-Za-z0-9]` is written
 * as `_<utf-16 code unit in hex>_`: the result uses only `[A-Za-z0-9_]`, and
 * the mapping is one-to-one (a literal `_` is escaped too, so an escape can
 * not be forged). The `n` / `s` prefix keeps the number `1` and the string
 * `'1'` apart.
 */
export function domIdPart(value: string | number): string {
	const prefix = typeof value === 'number' ? 'n' : 's';
	return (
		prefix +
		String(value).replace(/[^A-Za-z0-9]/g, (char) => `_${char.charCodeAt(0).toString(16)}_`)
	);
}

/**
 * Id of a data cell: `<grid>-cell-<row>-<column>`. `gridPrefix` is unique per
 * grid instance (`$props.id()`); `-` never appears inside a part, so the row
 * and the column can not run into each other.
 */
export function cellDomId(gridPrefix: string, rowKey: string | number, columnId: string): string {
	return `${gridPrefix}-cell-${domIdPart(rowKey)}-${domIdPart(columnId)}`;
}

/** Id of a group header row (the active "cell" while the cursor is on it). */
export function groupRowDomId(gridPrefix: string, groupKey: string): string {
	return `${gridPrefix}-group-${domIdPart(groupKey)}`;
}
