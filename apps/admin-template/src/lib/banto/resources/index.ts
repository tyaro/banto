/**
 * The list of resources this app registers with `initBanto()` - the single
 * place a new resource gets added (docs/recipes/add-resource.md step 7).
 * setup.ts passes this array unchanged to all three provider environments,
 * so registering here is all it takes for Tauri, LAN-browser, and demo mode
 * alike.
 */
import type { ResourceDefinition } from '@banto/admin-core';
import { itemsResource } from './items';

export const resources: ResourceDefinition[] = [itemsResource];
