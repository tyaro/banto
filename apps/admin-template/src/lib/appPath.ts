/**
 * Base-path-aware app path helpers, kept free of the paraglide messages so
 * logic-layer stores (`navBadges`) and their tests can import them alone.
 * Re-exported from `navigation.ts`.
 */
import { resolve } from '$app/paths';
import type { Path, ResolvedPathname } from '$app/types';

/**
 * An app route's pathname as written in the nav/category tables: a leading
 * `/` and no base path (e.g. `/items`, `/settings/appearance`). Typed from
 * SvelteKit 3's generated `Path` union, so a table entry pointing at a route
 * that does not exist is a type error. The tables keep the leading `/` because
 * it is also what they compare against (`pageTitle`, `navBadges`, the
 * public-viewer guard in `routes/(app)/+layout.ts`).
 */
export type AppPath = `/${Path}`;

/**
 * `resolve` narrowed to its pathname form. Called with the whole `Path`
 * union, its conditional argument type becomes one tuple per route, and
 * TypeScript only matches a union argument against a limited number of
 * those (25). The template has 23 routes, so one more resource (three
 * routes) made the call a type error.
 */
const resolvePathname = resolve as (pathname: Path) => ResolvedPathname;

/**
 * `AppPath` -> the href / `goto()` target with the base path prefixed
 * (SvelteKit 3 `resolve()`, which takes the pathname without its leading
 * `/`). Use this, not string concatenation, wherever an `AppPath` leaves the
 * app as a URL.
 */
export function resolveAppPath(path: AppPath): ResolvedPathname {
	return resolvePathname(path.slice(1) as Path);
}

/**
 * Does `pathname` (a `page.url.pathname` / `navigation.to.url.pathname`, which
 * always carries the base path) lie on `path` or under it (`/items` owns
 * `/items` and `/items/3`)? The one place that compares a table path with a
 * real pathname: it resolves `path` first, so it also holds under a non-empty
 * `BASE_PATH` (the Pages demo, #332). With an empty base it is the plain
 * `pathname === path || pathname.startsWith(path + '/')`.
 */
export function isPathActive(path: AppPath, pathname: string): boolean {
	const full = resolveAppPath(path);
	return pathname === full || pathname.startsWith(full + '/');
}
