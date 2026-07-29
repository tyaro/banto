/**
 * The `items` demo resource definition (spec §3): form schema + resource
 * registration object. **This is the file app authors replace** when
 * swapping the demo resource for their own (docs/recipes/add-resource.md
 * step 7) - copy it to `resources/<yours>.ts`, rewrite, register in
 * `resources/index.ts`, and delete this one when done.
 */
import type { ResourceDefinition } from '@banto/admin-core';
import type { FormSchema } from '@banto/forms';
import * as m from '$lib/paraglide/messages';

// Rust's ItemInput.price/.stock (apps/admin-template/core/src/items.rs) are
// `i64`, so a fractional value must be rejected client-side too (not just
// bounds-checked) - otherwise it passes here and only fails after a round
// trip to the real backend. `validateField` (packages/forms/src/
// validate.ts) runs required, then min/max, then this `validate` in that
// order, so the built-in required/min/max checks still run first; this only
// adds an extra integer check on top.
//
// i18n (ADR-0005, PR-B2): the custom validator resolves its message lazily at
// call time (render/validation), so it is locale-correct. The resource `label`
// and field `label`s below are deliberately LEFT as Japanese literals: this
// resource-definition module is evaluated at app startup (initBanto), which
// runs BEFORE locale.ts registers the `custom-banto` client strategy, so a
// module-eval `m['…']()` here would freeze to the English `baseLocale`.
// Wiring these three needs a locale-ready-safe mechanism (e.g. the packages
// accepting label keys, or lazy resolution) — tracked as a PR-B2b residual.
const integerValidate = (value: unknown): string | null =>
	Number.isInteger(Number(value)) ? null : m['validation.integer']();

export const itemsSchema: FormSchema = {
	fields: [
		{ name: 'name', label: '商品名', type: 'text', required: true, min: 1, max: 40 },
		{
			name: 'price',
			label: '価格',
			type: 'number',
			required: true,
			min: 0,
			max: 99999,
			validate: integerValidate
		},
		{
			name: 'stock',
			label: '在庫',
			type: 'number',
			required: true,
			min: 0,
			validate: integerValidate
		},
		{ name: 'updatedAt', label: '更新日', type: 'date', readonly: true }
	]
};

export const itemsResource: ResourceDefinition = {
	name: 'items',
	label: '商品',
	icon: '📦',
	schema: itemsSchema,
	capabilities: { list: true, create: true, edit: true, delete: true }
};
