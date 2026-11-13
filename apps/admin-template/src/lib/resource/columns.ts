/**
 * The list's base column set for a resource (ADR-0030 §4, stage 4): the
 * row-link "open" column, the DB-generated id, then every schema-backed column
 * derived from the SAME schema the create / edit forms use (spec §3.1, M23) -
 * header labels, editors and validation rules come from that one definition.
 * `definition.list.columns` carries only the presentation tuning derivation
 * cannot know (widths, a currency format).
 *
 * Exported (not inlined in `ResourceListPage`) so a route that adds its own
 * CSV import (items, until stage 5) maps headers against the very same columns.
 * Call it while the locale is resolved (component init), not at module load:
 * the headers are read once.
 */
import { columnsFromSchema, type GridColumn } from '@banto/grid-svelte';
import type { FormSchema } from '@banto/forms';
import * as m from '#lib/paraglide/messages.js';
import { columnValidationMessages } from '#lib/banto/i18n.js';
import { resolveAppPath, type AppPath } from '#lib/appPath.js';
import type { AppResourceDefinition, ResourceRow } from './types';

/** The detail page of one row (`<path>/<id>`). */
export function detailHref(definition: Pick<AppResourceDefinition, 'path'>, id: string | number) {
	return resolveAppPath(`${definition.path}/${id}` as AppPath);
}

export function resourceColumns(definition: AppResourceDefinition): GridColumn<ResourceRow>[] {
	return [
		{
			id: 'open',
			// axe-core wcag2a aria-command-name (visual-refresh-plan.md §7.1):
			// HeaderCell.svelte always renders its cell-body as role="button"
			// (even for non-sortable columns like this one), so an empty header
			// left it with no accessible name at all.
			header: m['resource.colActions'](),
			accessor: () => '',
			width: 70,
			resizable: false,
			sortable: false,
			cell: (row) => ({ text: m['resource.open'](), href: detailHref(definition, row.id) })
		},
		{
			id: 'id',
			header: 'ID',
			accessor: 'id',
			width: 80,
			align: 'right',
			filterable: true,
			filterType: 'number'
		},
		...columnsFromSchema<ResourceRow>(definition.schema as FormSchema, {
			overrides: definition.list?.columns,
			// i18n layer ② (ADR-0005): feed the inline-edit validator the same
			// Paraglide-backed messages the create/edit form uses.
			messages: columnValidationMessages()
		})
	];
}
