/**
 * Public entry point for @banto/admin-core (spec §3).
 * M2 Phase A scope: resource registry, DataProvider/AuthProvider contracts,
 * list/form composables, invalidate bus, InMemoryDataProvider.
 * M2 Phase B adds createTauriDataProvider/createTauriAuthProvider, backed
 * by the Rust service layer (spec §10).
 */
export type {
	SortDirection,
	SortState,
	FilterOp,
	FilterState,
	Pagination,
	ListParams,
	ListResult
} from './types';

export type { DataProvider, AuthProvider, Identity, NotificationKind, Notifier } from './provider';

export type { FieldError, ErrorBody } from './errors';
export { ProviderError, isProviderError, notFound, validation } from './errors';

export type { ResourceDefinition, InitBantoConfig } from './registry.svelte';
export {
	initBanto,
	getDataProvider,
	getAuthProvider,
	getResource,
	listResources,
	notify
} from './registry.svelte';

export { onInvalidate, invalidate } from './invalidate';

export { ListResource, createListResource, type CreateListResourceOptions } from './list.svelte';
export {
	WindowedListResource,
	createWindowedListResource,
	type CreateWindowedListResourceOptions,
	type WindowedParams
} from './windowed.svelte';
export { FormResource, createFormResource, type SubmitResult } from './form.svelte';

export {
	createInMemoryDataProvider,
	type InMemorySeed,
	type InMemoryDataProviderOptions
} from './providers/inMemory';

export { createTauriDataProvider, createTauriAuthProvider, type TauriInvokeOptions } from './providers/tauri';

export {
	createHttpDataProvider,
	createHttpAuthProvider,
	type HttpDataProviderOptions,
	type HttpAuthProviderOptions
} from './providers/http';

export {
	createLocalUiSettings,
	createTauriUiSettings,
	createHttpUiSettings,
	type UiSettingsProvider,
	type LocalUiSettingsOptions,
	type TauriUiSettingsOptions,
	type HttpUiSettingsOptions
} from './providers/uiSettings';

export type { AppEvent, EventProvider, TauriEventListenOptions, SseEventProviderOptions } from './events';
export { createTauriEventProvider, createSseEventProvider, connectEvents } from './events';

export type { SseParser } from './sse-parser';
export { createSseParser } from './sse-parser';

export type { PaletteCommand } from './commands';
export { searchCommands } from './commands';
