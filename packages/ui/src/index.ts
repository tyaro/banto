/**
 * Public entry point for @banto/ui (docs/adr/0018-shared-ui-package.md).
 *
 * Phase 1: the seven general-purpose components that used to live in
 * apps/admin-template/src/lib/components/ui/. Components take text, icons,
 * state and actions through props / snippets / callbacks and import nothing
 * but `svelte` (verify:architecture rule `package-bare-imports`). Consumers
 * load `@banto/theme/css` themselves - the styles reference only `--banto-*`
 * tokens.
 */
export { default as EmptyState } from './EmptyState.svelte';
export { default as ErrorState } from './ErrorState.svelte';
export { default as IconButton } from './IconButton.svelte';
export { default as LoadingState } from './LoadingState.svelte';
export { default as PageHeader } from './PageHeader.svelte';
export { default as StatusBadge } from './StatusBadge.svelte';
export { default as SurfaceCard } from './SurfaceCard.svelte';
export { defaultUiMessages, type UiMessages } from './messages';
export type { StatusBadgeVariant, UiIconComponent } from './types';
