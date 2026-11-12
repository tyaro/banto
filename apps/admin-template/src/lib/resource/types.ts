/**
 * The app layer's resource definition (ADR-0030 §3).
 *
 * `AppResourceDefinition` extends admin-core's `ResourceDefinition` (which stays
 * unchanged, so no breaking change for consumers) with what the screens need.
 * Stage 1 adds only `path` and `nav`; list / csv / demoNotes / canWrite arrive
 * in later stages.
 *
 * Text is a function (`label?: () => string`) for the same reason
 * `resources/items.ts` uses `get label()`: evaluating at module load would
 * freeze the default locale.
 */
import type { Component } from 'svelte';
import type { ResourceDefinition } from '@banto/admin-core';
import type { AppPath } from '#lib/appPath.js';

export interface ResourceNav {
	/** lucide component held directly by the definition file. */
	icon: Component;
	/** Sidebar / palette label. Defaults to the resource `label`. */
	label?: () => string;
	/** Allowlist for the LAN viewer-public session (ADR-0012; not an authorization check). */
	publicViewer?: boolean;
	/** Show the unseen-change badge (navBadges) for this resource. */
	badge?: boolean;
	/** Only shown to the `admin` role. */
	adminOnly?: boolean;
}

export interface AppResourceDefinition extends ResourceDefinition {
	/** Route of the resource's list page, e.g. `'/items'`. */
	path: AppPath;
	/** `false` or omitted = not listed in the navigation. */
	nav?: false | ResourceNav;
}

/** Type inference helper only - an identity function with no runtime machinery. */
export function defineResource<T extends AppResourceDefinition>(definition: T): T {
	return definition;
}
