/**
 * The `items` demo resource definition (spec §3): form schema + resource
 * registration object. **This is the file app authors replace** when
 * swapping the demo resource for their own (docs/recipes/add-resource.md
 * step 7) - copy it to `resources/<yours>.ts`, rewrite, register in
 * `resources/index.ts`, and delete this one when done.
 */
import { Package } from '@lucide/svelte';
import type { FormSchema } from '@banto/forms';
import * as m from '#lib/paraglide/messages.js';
import { defineResource, type ResourceImportRow, type ResourceRow } from '#lib/resource/types.js';
import {
	exportCsvToFolder,
	importItems,
	isItemsImportAvailable,
	type ItemImportRow
} from '#lib/banto/itemsAdmin.js';

// Rust's ItemInput.price/.stock (apps/admin-template/core/src/items.rs) are
// `i64`, so a fractional value must be rejected client-side too (not just
// bounds-checked) - otherwise it passes here and only fails after a round
// trip to the real backend. `validateField` (packages/forms/src/
// validate.ts) runs required, then min/max, then this `validate` in that
// order, so the built-in required/min/max checks still run first; this only
// adds an extra integer check on top.
//
// i18n (ADR-0005, PR-B2/B2b): the custom validator resolves its message lazily
// at call time (render/validation), so it is locale-correct. The resource
// `label` and field `label`s use the SAME lazy trick — a `get label()` getter
// (typed `string`, so the package contracts are untouched, conventions §4/§5)
// instead of an eager string literal. This module is evaluated at app startup
// (initBanto) BEFORE locale.ts registers the `custom-banto` client strategy, so
// a module-eval `m['…']()` would freeze to the English `baseLocale`; a getter
// defers the `m['…']()` call to when the label is actually read (grid/form
// render), by which point the locale is resolved. The registry stores the
// resource object by reference (packages/admin-core/src/registry.svelte.ts) and
// `columnsFromSchema`/`BantoForm` read `.label` at render, so the getter fires
// locale-ready and stays reactive to the active locale.
const integerValidate = (value: unknown): string | null =>
	Number.isInteger(Number(value)) ? null : m['validation.integer']();

export const itemsSchema: FormSchema = {
	fields: [
		{
			name: 'name',
			get label() {
				return m['items.fieldName']();
			},
			type: 'text',
			required: true,
			min: 1,
			max: 40
		},
		{
			name: 'price',
			get label() {
				return m['items.fieldPrice']();
			},
			type: 'number',
			required: true,
			min: 0,
			max: 99999,
			validate: integerValidate
		},
		{
			name: 'stock',
			get label() {
				return m['items.fieldStock']();
			},
			type: 'number',
			required: true,
			min: 0,
			validate: integerValidate
		},
		{
			name: 'updatedAt',
			get label() {
				return m['items.fieldUpdatedAt']();
			},
			type: 'date',
			readonly: true
		}
	]
};

/**
 * M5 Phase B (spec §4.3) grouping demo: the client grid's rows get a derived
 * `category` field (the item name's first whitespace token, e.g. "緑茶
 * 500ml" -> "緑茶"), so the group-by select has a column worth grouping by.
 * `Item` itself (and the server grid) stay untouched - this is purely a
 * client-mode presentation concern. ResourceListPage also runs the "did this
 * save fall outside the restored filters?" check through it (Issue #215/#255),
 * so a category filter never reports a false "excluded".
 */
function toItemRow(row: ResourceRow): ResourceRow {
	const name = String(row.name ?? '');
	return { ...row, category: name.split(/\s+/)[0] ?? name };
}

/**
 * The generic import row -> `ItemImportRow` (the Rust `ItemImportRow` shape).
 * The panel only sends rows without errors and with every required column
 * present, so the defaults never stand in for real input.
 */
export function toItemImportRow(row: ResourceImportRow): ItemImportRow {
	return {
		id: row.id === undefined ? undefined : Number(row.id),
		name: String(row.name ?? ''),
		price: Number(row.price ?? 0),
		stock: Number(row.stock ?? 0)
	};
}

export const itemsResource = defineResource({
	name: 'items',
	path: '/items',
	description: () => m['items.description'](),
	list: {
		// Both, as the demo of the "View" menu's switch (a new resource gets
		// `server` only by default, ADR-0030 decision 3).
		loadModes: ['client', 'server'],
		columns: {
			name: { width: 260 },
			price: { width: 120, format: (value) => `¥${(value as number).toLocaleString()}` },
			stock: { width: 100 },
			updatedAt: { width: 140 }
		},
		groupBy: [
			{ field: 'category', label: () => m['items.groupCategory']() },
			{ field: 'updatedAt', label: () => m['items.fieldUpdatedAt']() }
		],
		client: {
			toRow: toItemRow,
			// The client grid gets the derived 「カテゴリ」 column plus
			// per-column aggregates (spec §4.3).
			columns: (columns) => {
				const byId = (id: string) => columns.find((column) => column.id === id)!;
				return [
					byId('open'),
					{ ...byId('id'), aggregate: 'count' },
					byId('name'),
					{
						id: 'category',
						header: m['items.groupCategory'](),
						accessor: 'category',
						width: 140,
						filterable: true,
						filterType: 'text',
						groupable: true
					},
					{ ...byId('price'), aggregate: 'avg' },
					{ ...byId('stock'), aggregate: 'sum' },
					byId('updatedAt')
				];
			}
		}
	},
	csv: {
		// Desktop: write into the app's `exports/` folder (WebView2 has no save
		// dialog for `<a download>`). A wrapper, not the bare function: this
		// module and itemsAdmin.ts sit on an import cycle through setup.ts.
		export: { toFolder: (csv, filename) => exportCsvToFolder(csv, filename) },
		// Bulk import (spec M15). `DataProvider` has no import entry point, so
		// the definition passes the items endpoint itself (wrappers for the
		// same import-cycle reason as above). Required columns and the
		// preview table default to the schema's required fields
		// (name / price / stock); `id` is an integer.
		import: {
			available: () => isItemsImportAvailable(),
			rules: () => m['items.importRules'](),
			run: (rows) => importItems(rows.map(toItemImportRow))
		}
	},
	demoNotes: () => [
		m['items.annotationEdit'](),
		m['items.annotationMode'](),
		m['items.annotationGroup'](),
		m['items.annotationExport'](),
		m['items.importRules']()
	],
	nav: {
		icon: Package,
		label: () => m['nav.items'](),
		publicViewer: true,
		badge: true
	},
	get label() {
		return m['items.resourceLabel']();
	},
	icon: '📦',
	schema: itemsSchema,
	capabilities: { list: true, create: true, edit: true, delete: true }
});
