# ADR-0030: Build resource screens from app-layer shared components `ResourceListPage` / `ResourceDetail`, and derive navigation and commands from the resource definition

> 日本語: [0030-resource-page.md](0030-resource-page.md)

- Status: Accepted (2026-11-13)
- Date: 2026-11-13
- Related: Issue #554 / [design-ux-review-2026-11](../reviews/design-ux-review-2026-11.md) E-1 /
  conventions §4, §5, §10, §13 / [template-scope](../template-scope.md) §3.1, §6 /
  [add-resource](../recipes/add-resource.en.md) steps 7 and 8 /
  [ADR-0009](0009-schema-ui-rest-renderer-boundary.en.md) /
  [ADR-0012](0012-lan-public-viewer-synthetic-session.en.md) / [ADR-0018](0018-shared-ui-package.en.md) /
  follow-ups: #555 (B-2 + C-4 search, filter chips, saved views), #556 (C-1 + B-4 primitives and removing `window.confirm`)

## Context

**Screens are multiplied by copying.** `ResourceDefinition` (`packages/admin-core/src/registry.svelte.ts`)
holds `name` / `label` / `icon` / `schema` / `capabilities`, but screens are made by copying the items
routes and rewriting them (add-resource step 8; on 2026-07-18 we decided "no dynamic `[resource]` route,
copy items" — template-scope §6). Line counts as of 2026-11-13 (tests and the report page excluded):

| File (`apps/admin-template/src/routes/(app)/items/`)            | Lines        |
| --------------------------------------------------------------- | ------------ |
| `+page.svelte` (list)                                           | 1,101        |
| `ItemsServerGrid.svelte` / `ItemsClientGrid.svelte`             | 229 / 127    |
| `[id]/+page.svelte` (detail/edit) / `new/+page.svelte` (create) | 271 / 75     |
| `rowSaveQueue.ts` / `importPreview.ts` / `itemRow.ts`           | 80 / 40 / 23 |
| Total                                                           | 1,946        |

Only a few parts are specific to items: the CSV import (`importItems` in `itemsAdmin.ts`; `DataProvider` has
no import entry point) and its rules text `items.importRules`, the "category" column derived from the name
and its grouping demo, the report button (optional `@banto/report`), the attachments panel (optional
`@banto/attachments`), and the text of the annotation drawer. The rest — the load-mode switch
(client / server), restoring filters and sort (#215), the row save queue, range paste, the notice for a row
that left the filter, CSV export (on Tauri, writing into a folder), the columns menu, read-only for viewers,
the unsaved-changes guard, delete — takes the same shape for any resource.

**Navigation is also added by hand**: the items entry in `navigation.ts` (marked `[scaffold:items]`), the
`NavIconKey` / `NavLabelKey` unions, and `Package` in `navIcons.ts`. Palette navigation commands are already
derived from `navItems` (`commands.ts`), so deriving navigation brings the palette along. Note that
`ResourceDefinition.icon` (`'📦'` for items) is read by nothing, and the nav text `nav.items` (Products)
and the definition's `label` (`items.resourceLabel` = Product) differ in number in English.

**Recent changes (#561–#565).** The list header gained a "View" menu (load-mode switch, #563), demo-build-only
annotations (`AnnotationButton` in the header actions, `AnnotationDrawer` at the page root — the header has a
`view-transition-name` and becomes the containing block of fixed descendants, so the drawer cannot be drawn
inside it; #565), and `items.importRules` used in three places: the import button title, the annotation and
the import preview panel.

**scaffold depends on this shape by text.** `removeItems` in `scripts/scaffold.mjs` deletes the route
directory, `resources/items.ts`, `itemsAdmin.ts` and `sampleData.ts`, and drops the marked region and one word
of each union in `navigation.ts`, `Package` in `navIcons.ts`, and the `items.*` / `nav.items` dictionary keys.
`removeReport` cuts the lucide import and the report button of the list `+page.svelte`; `removeAttachments`
cuts three imports and the `M20 demo wiring` region of `[id]/+page.svelte` — both by exact text match.
`template-acceptance.yml` applies `scaffold.mjs --strict` for the four presets and runs `verify:architecture`,
`check`, `build` and `cargo test` on the copy, plus `scaffold.test.mjs`.

**Constraints on placement.** Packages import no other package (conventions §4 "current guarantees") and hold
neither `#lib` nor Paraglide (§5, §13). The list uses `@banto/grid-svelte`, `@banto/forms`, `@banto/ui` and
`@banto/admin-core` together.

## Decision

### 1. Live in the app layer, not a package

Add `apps/admin-template/src/lib/resource/` holding `ResourceListPage.svelte`, `ResourceDetail.svelte` and
their helpers (server / client grids, save queue, import preview panel, permission check). Treat it as app-layer
core: no scaffold preset deletes it (display keeps zero resources and must still type-check).
**`lib/resource/` does not import optional assets** (`@banto/attachments`, `@banto/report`, `@banto/charts`,
`@banto/dock-svelte`, `@banto/tree-svelte`, the command palette). Optional wiring is injected as snippets from
each resource's route files (extending §4 "no core → optional dependency" into the app layer).

### 2. Do not make routes dynamic

Keep the 2026-07-18 decision against a dynamic `[resource]` route. Each resource keeps three routes under
`routes/(app)/<name>/` (list, `[id]`, `new`), but they become thin files calling the shared components. Only the
"copy the items routes and rewrite them" part is replaced. Because the routes exist, `RouteId` typing, the
viewer-public guard in `(app)/+layout.ts`, and scaffold's "delete the directory to remove it" keep working.

### 3. Two-layer definition; admin-core unchanged

- **`ResourceDefinition` in `@banto/admin-core` does not change in stages 1–5** (no breaking change; no effect on
  the external-consumer fixture).
- **Add an app-layer extension type `AppResourceDefinition<T>` (`#lib/resource/types.ts`)** that extends
  `ResourceDefinition` with what the screens need. Shape sketch (finalized in each stage's PR):

```ts
interface AppResourceDefinition<T extends { id: string | number }> extends ResourceDefinition {
	schema: FormSchema; // narrowed from optional to required
	path: AppPath; // '/items'
	description?: () => string;
	nav?:
		| false
		| {
				icon: Component; // the definition holds the lucide component (no emoji — A-5)
				label?: () => string; // defaults to label; separate for e.g. English plurals
				publicViewer?: boolean; // viewer-public screen allowlist (ADR-0012; not authorization)
				badge?: boolean; // unseen-change badge (navBadges)
				adminOnly?: boolean;
		  };
	list?: {
		loadModes?: readonly ('server' | 'client')[]; // two entries -> switch in the "View" menu
		columns?: SchemaColumnOverrides<T>; // columnsFromSchema overrides
		groupBy?: { field: string; label: () => string }[]; // client mode only
	};
	csv?: {
		export?:
			boolean | { toFolder?: (csv: string, filename: string) => Promise<FolderExportResult> };
		import?: {
			available?: () => boolean; // provider-layer check (conventions §10); default: always
			rules: () => string; // home of items.importRules
			run: (rows: ResourceImportRow[]) => Promise<ResourceImportResult>;
			required?: readonly string[]; // default: the schema's required, non-readonly fields (stage 5)
			preview?: readonly string[]; // preview table columns; default: required (stage 5)
			idType?: 'integer' | 'string'; // how the id column is read; default integer (stage 5)
		};
	};
	demoNotes?: () => string[]; // paragraphs of the demo-build annotation drawer
	canWrite?: (role: Role) => boolean; // defaults to canWriteResources
}
```

Text is deferred through functions, like `get label()` (see the note at the top of `resources/items.ts` —
evaluated at startup it would freeze to the base locale). `defineResource()` is an identity function for type
inference only; it has no runtime machinery.

### 4. Component boundaries and API

**`<ResourceListPage resource={itemsResource}>`** — pass **the definition itself**, not the string name the Issue
wrote. The row type `T` reaches the snippets, and neither a name lookup nor its "forgot to register" runtime
error is needed. Built-in by default:

- page heading (`PageHeader`; `label`, `description`) and the primary action "New"
- the "View" menu: load mode (when `loadModes` has two), grouping (when `groupBy` is set and in client mode).
  #555's saved views and filter chips go here and above the list (one place reaches every resource)
- columns menu, CSV export (`getList` + `toCsv`; Tauri folder export when `toFolder` is given),
  CSV import (only with `csv.import`, including the preview panel and `rules`)
- the server / client grids, restoring filter and sort (#215; keyed by resource name and load mode), cell
  editing with the save queue, range paste, the notice for a row that left the filter
- permission-based visibility (§5) and demo-build annotations (§7)

Start with few snippets: `actions` (actions before the primary one; the report button goes here), `viewMenu`
(extra "View" menu items), `beforeGrid` (KPIs etc. above the list, below the import confirmation panel), `empty` (empty state; B-6), `annotation`
(draw the annotation yourself instead of `demoNotes`). Column looks change through grid column `overrides`,
not snippets.

**`<ResourceDetail resource={…} id={…}>`** — `id` of `null` means create, a value means edit. Holds
`createFormResource` and `BantoForm`, the unsaved-changes guard, save/delete, and read-only for viewers.
Snippets: `after` (below the form; the attachments panel goes here) and `actions`. For B-3 (open details in a
right drawer) the component does not depend on the page frame so it can sit inside a list drawer, but switching
the default to the drawer is not in this ADR's stages (question 4).

### 5. Permission-based visibility

`resourcePermissions(definition, role)` (pure) returns `{ create, edit, delete, import, export }`. Write actions
require "the definition's `capabilities` has the action" and "`canWrite(role)` (default `canWriteResources`)";
export is a read and only checks `capabilities.list`. Import both inserts new rows and updates existing ones, so it
requires both `create` and `edit` in `capabilities` (decided in stage 2). Actions not allowed are **hidden** (not shown disabled — the
M10 policy). This is screen visibility; authorization stays with the server's `RoleGuard` and Tauri's
`require_role` (conventions §1, unchanged). A viewer-public session has role viewer and so is read-only
automatically; `nav.publicViewer` stays a screen allowlist (ADR-0012).

### 6. Where i18n keys live

- Resource-independent text (New, Export/Import CSV, "View", load modes, save notices, `Edit {resource}` …)
  moves to **a new prefix `resource.*`**. Resource-specific text stays under `<name>.*` and is referenced from
  the definition through functions.
- The components are in the app layer and use Paraglide directly (§13). `@banto/*` still holds no dictionary
  (unchanged).
- scaffold's `removeMessageKeys(['items', 'nav.items'])` keeps `resource.*`, so generic text survives display.

### 7. Demo-build annotations and `items.importRules`

`ResourceListPage` puts `AnnotationButton` in the header actions and `AnnotationDrawer` at the page root only
when the definition has `demoNotes` or an `annotation` snippet is passed (honouring the containing-block
constraint once, inside the component). The demo-build-only condition stays `isDemoBuild()` in
`AnnotationButton`. The import rules live in `csv.import.rules`; the component uses them for the import
button title and the preview panel. Whether they also appear in the annotation is decided by the definition's
`demoNotes` (items keeps showing them); the component never adds them to the annotation on its own.

### 8. Deriving navigation and the command palette

- `navigation.ts` builds entries from the `resources` with `nav !== false`, placed right after the dashboard in
  `resources` order (question 8). `pageTitles` for `/(app)/<name>/new` and `/(app)/<name>/[id]` come from
  `resource.createTitle` / `resource.editTitle`.
- The `NavIconKey` / `NavLabelKey` unions and `NAV_ICONS` go back to covering **only hand-written fixed pages**
  (dashboard, tree, users, …). Resource entries take their icon component and text function from the definition.
- Navigation commands keep coming from `navItems`. In addition `commands.ts` gets a "New <label>" command per
  creatable resource (`visible()` follows `resourcePermissions` and the session). The command palette remover
  deletes `commands.ts` whole, so no reverse dependency on an option appears. Record search (B-5) is out of scope.

### 9. Rebuilding scaffold.mjs and template-acceptance

- **The front-end part of `removeItems` becomes "delete only"**: the route directory, `resources/items.ts`,
  `itemsAdmin.ts` and `sampleData.ts` go, the `resources` array becomes empty, and the `items.*` / `nav.items`
  keys are dropped. Editing `navigation.ts` and `navIcons.ts` for items (marked region, a union word, `Package`)
  is no longer needed.
- **Anchors of the optional removers move into the thin route files and change from free text to
  `[scaffold:<tag>]` markers** (`cutMarked`). The report button sits in the list route's `actions` snippet and the
  attachments panel in the `[id]` route's `after` snippet, so the anchor targets are files of a few dozen lines.
- **Each stage's PR fixes scaffold.mjs and `scaffold.test.mjs` in the same PR.** Even for front-end-only changes,
  run `node scripts/scaffold.mjs --preset <p> --dry-run --strict` for all four presets locally before pushing
  (template-acceptance's `paths` include `src/routes/**` and `src/lib/**` so CI runs too, but check locally first).
- No new template-acceptance steps. That `lib/resource/` does not import optional assets is guarded by one new
  `verify:architecture` rule (stage 3; it also runs on every preset copy).
- That navigation derivation and `lib/resource/` survive display (zero resources) is checked by an "empty
  resources" case in `navigation.test.ts` and by display's acceptance run.

### 10. Staged PR plan

Each stage merges on its own with green CI (frontend, e2e, template-acceptance). Each stage aims not to change
the screen DOM; if it does, regenerate the visual baselines by dispatching `visual-baselines.yml`.

| Stage | Content                                                                                                                                                                                                                                                                                                                                                                 | Rough size            |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 0     | This ADR and the index                                                                                                                                                                                                                                                                                                                                                  | docs only             |
| 1     | Derive navigation from the resource definition. Add only `path` and `nav` of `AppResourceDefinition` and set them on items. Remove the items entry, two union words and `Package`; fix `removeItems`. Add derivation / empty / viewer-public / page-title cases to `navigation.test.ts`                                                                                 | small (±150 lines)    |
| 2     | `resourcePermissions` and the "New <label>" command. Tests for the pure function and `commands.test.ts`                                                                                                                                                                                                                                                                 | small (±120 lines)    |
| 3     | Extract `ResourceDetail`; replace items' `[id]` and `new`. Attachments via the `after` snippet and a `[scaffold:attachments]` marker; fix `removeAttachments`. Add the "`lib/resource/` imports no optional asset" rule to `verify:architecture` and amend conventions §4                                                                                               | medium (mostly moves) |
| 4     | `ResourceListPage` skeleton: heading, "View" menu, columns menu, New, annotation, permissions, the two grids (`ItemsServerGrid`/`ItemsClientGrid` generalized and moved), #215 restore, cell editing and save queue, CSV export. CSV import temporarily stays in a snippet of the items route. Report button via the `actions` snippet and a `[scaffold:report]` marker | large (mostly moves)  |
| 5     | Generalize CSV import through `csv.import` and move the preview panel into `lib/resource/`. Update add-resource steps 7–9 (ja/en), and the 2026-07-18 entry in template-scope §6                                                                                                                                                                                        | medium                |

Stage 1 starts once stage 0 (this ADR) is Accepted (ADR process). #556's `ConfirmDialog`, once inserted into
`ResourceDetail`'s delete after stage 3, reaches every resource. #555 goes into `ResourceListPage` after stage 4.

**Line-count expectations (conservative).** The template's own line count stays about the same (code moves into
shared components; generalizing may even add a little). What shrinks is **what the second and later resources
write**: today about 1,950 lines copied and rewritten, expected to become a definition file (100–150 lines) plus
three routes (10–40 lines each). About 300–400 lines of items-specific code are expected to remain in its
definition and routes. Both are measured in the stage 4 and 5 PRs and reported there.

**Stage 4 measurements (2026-11-13).** The list parts in `lib/resource/` are 1,324 lines (`ResourceListPage.svelte`
691, `ResourceServerGrid.svelte` 263, `ResourceClientGrid.svelte` 161, `rowSaveQueue.ts` 84, `listState.ts` 68,
`columns.ts` 57; tests excluded), and `types.ts` grew by 71 lines. The items list went from a 1,691-line route set
(`+page.svelte` 1,191, the two grids 391, `rowSaveQueue.ts` 84, `itemRow.ts` 25) to a 555-line route plus 69 more
lines in the definition (`items.ts` 95 → 164). About 510 of the route's 555 lines are the CSV import that stage 5
moves into the component; without it the route is under 50 lines. The template's own list code **grew** from about
1,790 to about 2,110 lines (doc comments and the generic types; more than the "about the same" expected). A second
resource without CSV import, server mode only, now writes a 60–100-line definition (items minus its ~55-line client
grouping demo), a list route of about 10 lines and `[id]` / `new` routes of 20–30 lines each: about 150 lines in
total. Items-specific code is 797 lines today (definition 164, the three routes 633); it is measured again after
stage 5 moves the import.

**Stage 5 measurements (2026-11-13).** The CSV import moved into the component and stage 4's temporary `csvImport`
slot is gone (`beforeGrid` stays, for KPIs and the like). The list parts are 2,015 lines (`ResourceListPage.svelte`
816, `ResourceImportPanel.svelte` 348, `csvImport.ts` 214, `ResourceServerGrid.svelte` 263,
`ResourceClientGrid.svelte` 161, `rowSaveQueue.ts` 84, `listState.ts` 68, `columns.ts` 61; tests excluded), and
`types.ts` grew by another 42 lines (111 → 153). The items list route went from 555 to 34 lines, the definition from
164 to 193 (`csv.import`, plus `toItemImportRow`, which maps a generic row to `ItemImportRow`), and `importPreview.ts`
(45 lines) was replaced by the generic `csvImport.ts`. Items-specific code went from 797 to **305 lines**
(definition 193, the three routes 112) — the low end of the 300–400 expected. The template's own list code grew from
about 2,110 to about 2,200 lines (the generic import — required columns, preview columns, string ids, showing a
partly applied batch — and doc comments). A second resource with a CSV import now adds only 5–10 lines of
`csv.import` in its definition and the import API client (items' `importItems` is about 10 lines).

## Alternatives considered

- **Option A (chosen): app-layer shared components + thin routes + an app-layer definition extension.** Does not
  touch the no-inter-package-import constraint, uses Paraglide directly, and lets derived apps read and rewrite the
  components themselves (fits the copy-type template). Downside: the list component is ~1,000 lines and the reading
  burden concentrates in one place; mitigated by splitting files and doc comments.
- **Option B (rejected): a dynamic route `routes/(app)/[resource]/`.** The reason of the 2026-07-18 decision
  (magic users cannot read) remains. Per-resource injection turns into branching in the route, and `RouteId`-typed
  page titles, the viewer-public guard and scaffold's "delete the directory" stop working.
- **Option C (rejected): a new package `resource-page`.** With zero inter-package imports (§4) it cannot use
  grid, forms or ui; injecting everything means dozens of props and `messages`. It cannot hold a dictionary (§13).
  Derived apps cannot rewrite code inside node_modules.
- **Option D (rejected): generate screens from a scaffold (the E-2 generator).** Generated code does not receive
  #555/#556 improvements afterwards. It complements E-2 (generating the Rust boilerplate): components for screens,
  generation for the Rust side.
- **Option E (rejected): put every screen field into admin-core's `ResourceDefinition`.** The core package would
  carry lucide components and grid column override types, contradicting zero inter-package imports. Put them in the
  app-layer extension type.
- **Option F (rejected): status quo (improve the recipe only).** The copy volume for the second resource and the
  cost of applying cross-cutting improvements N times remain.

## Consequences

- No invariant changes (§1 two-path authorization/audit, §10 demo rejection, §13 keys). §4 "no core → optional
  dependency" is applied to the app layer's `lib/resource/` and guarded by `verify:architecture` (conventions §4
  is amended in stage 3).
- The 2026-07-18 entry in template-scope §6 is rewritten in stage 5 to "no dynamic routes (kept); a screen is one
  definition plus three routes". The ADR index candidate "why resource routes are not dynamic but copy items" is
  removed (this ADR records it).
- Consistent with ADR-0009: the serializable declaration core (admin-core's `ResourceDefinition`, the schema,
  `capabilities`) is unchanged, and the extension holding functions and components lives in the web renderer
  (app layer) as a renderer-specific extension point. `ResourceListPage` is a Svelte component, not a
  renderer-independent UI DSL (ADR-0009 §3). It also does not conflict with template-scope §4.2 (no screen
  editor) — the definition is code, not GUI assembly.
- Generic text keys move from `items.*` to `resource.*`, which shows up as a diff in derived apps' dictionaries
  (noted in the CHANGELOG; question 6: minor).
- How to remove: the components are app-layer code, so writing their content back into the route files removes them.

## Resolved questions (2026-11-13, approved by the owner as recommended)

1. **Location:** the app layer `lib/resource/`, not a package (§1). admin-core does not change in stages 1–5.
   Implementation PRs do not use the Issue title's `feat(admin-core)`.
2. **Prop shape:** pass the definition object, not the string name, as `resource` (§4).
3. **Default load mode:** when a definition does not set `loadModes`, use server (paging) only — the side that
   stays light as row counts grow. items keeps both and continues the "View" menu switching demo.
4. **B-3 (details in a right drawer):** not in this ADR's stages. `ResourceDetail` stays independent of the page
   frame; whether to make the drawer the default is decided in a separate Issue after stage 4.
5. **`ResourceDefinition.icon`:** not removed (removing admin-core public API would be major). Deprecate it with a
   doc comment saying screens do not read it and navigation icons come from the app-layer `nav.icon` (stage 1).
   Revisit removal at the next major release.
6. **Version for the key move:** minor. The dictionary lives in the copied template (CHANGELOG section B), not in
   the `@banto/*` public API. The CHANGELOG "Notes for consumers" lists the moved keys and how to take them in
   (same treatment as the 2.x operational exception in publishing.md).
7. **users and audit log:** stay out of scope. They have no resource definition (`capabilities` and schema) and
   different screen requirements. Open a separate Issue if they should move later.
8. **Navigation position:** fixed as "right after the dashboard, in `resources` array order"; no `nav.order`.
   Reorder the array to change it. Add an order field only if someone needs to place a resource between fixed pages.
