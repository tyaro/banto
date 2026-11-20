/**
 * The list of resources this app registers with `initBanto()` - the single
 * place a new resource gets added (docs/recipes/add-resource.md step 7).
 * setup.ts passes this array unchanged to all three provider environments,
 * so registering here is all it takes for Tauri, LAN-browser, and demo mode
 * alike.
 */
import type { AppResourceDefinition } from '#lib/resource/types.js';
// [scaffold:items] begin
import { itemsResource } from './items';
// [scaffold:items] end
// [banto:add-resource:resource-imports]

// D1-d note (display-preset-plan.md, Issue #190 prep): the future `items`
// remover needs a `swapText` here, not a `cutRegion` delete - `resources`
// must still be a valid (possibly empty) array afterwards:
//   `[itemsResource]` -> `[]`
export const resources: AppResourceDefinition[] = [itemsResource];

// `pnpm banto add resource` registers each new resource above this line
// (docs/recipes/add-resource.md). The sidebar follows the order here.
// [banto:add-resource:resource-list]
