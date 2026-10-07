/**
 * Public entry point for @banto/ui (docs/adr/0018-shared-ui-package.md).
 *
 * Phase 1: the seven general-purpose components that used to live in
 * apps/admin-template/src/lib/components/ui/. Phase 2a: the dropdown menu
 * parts (Menu, MenuGroup, MenuItem, MenuSeparator) from components/menu/.
 * Phase 2b: CommandPalette (display + interaction; the app keeps the command
 * list, Ctrl+K, session scoping, recent items and notifications).
 * Phase 2c: ToastHost + `createToastStore()` (the package's only `.svelte.ts`,
 * so consumers must list `@banto/ui` in `optimizeDeps.exclude`, ADR-0007; the
 * app keeps only the Notifier -> store wiring).
 * Components take text, icons, state and actions through props / snippets /
 * callbacks and import nothing but `svelte` (verify:architecture rule
 * `package-bare-imports`). Consumers
 * load `@banto/theme/css` themselves - the styles reference only `--banto-*`
 * tokens.
 */
export { default as CommandPalette } from './CommandPalette.svelte';
export {
	defaultCommandPaletteSearch,
	type CommandPaletteCloseReason,
	type CommandPaletteItem
} from './commandPalette';
export { default as EmptyState } from './EmptyState.svelte';
export { default as ErrorState } from './ErrorState.svelte';
export { default as IconButton } from './IconButton.svelte';
export { default as LoadingState } from './LoadingState.svelte';
export { default as Menu } from './Menu.svelte';
export { default as MenuGroup } from './MenuGroup.svelte';
export { default as MenuItem } from './MenuItem.svelte';
export { default as MenuSeparator } from './MenuSeparator.svelte';
export { default as PageHeader } from './PageHeader.svelte';
export { default as StatusBadge } from './StatusBadge.svelte';
export { default as SurfaceCard } from './SurfaceCard.svelte';
export { default as ToastHost } from './ToastHost.svelte';
export {
	createToastStore,
	DEFAULT_TOAST_DURATION_MS,
	type Toast,
	type ToastAction,
	type ToastKind,
	type ToastPushOptions,
	type ToastStore,
	type ToastStoreOptions
} from './toast.svelte';
export { defaultUiMessages, type UiMessages } from './messages';
export type { StatusBadgeVariant, UiIconComponent } from './types';
