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

export type {
	DataProvider,
	AuthProvider,
	AuthOperationResult,
	CredentialRevision,
	Identity,
	LegacyAuthProvider,
	NotificationKind,
	Notifier,
	ResolvedAuth,
	SessionKind,
	StandardAuthProvider
} from './provider';
export { PUBLIC_VIEWER_ID } from './provider';

export type { FieldError, ErrorBody } from './errors';
export {
	ProviderError,
	isProviderError,
	notFound,
	validation,
	StaleAnswerError,
	isStaleAnswerError
} from './errors';

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

export {
	createSessionController,
	getSessionController,
	resolveSettled,
	publicViewerFallback,
	DEFAULT_PUBLIC_VIEWER_RETRIES,
	SessionTimeoutError,
	SessionProviderMissingError,
	type SessionController,
	type SessionControllerDeps,
	type SessionResolveOptions,
	type SessionSnapshot,
	type SessionTicket,
	type ResolveResult
} from './sessionController.svelte';
export { resolveProtectedSession, type ProtectedSessionOutcome } from './sessionGate';
export {
	onSessionEnded,
	confirmSessionEnded,
	createSessionEndConfirmation,
	type SessionEndOutcome,
	type SessionEndConfirmation
} from './sessionEnded';

export { ListResource, createListResource, type CreateListResourceOptions } from './list.svelte';
export {
	WindowedListResource,
	createWindowedListResource,
	DEFAULT_WINDOWED_REQUEST_TIMEOUT_MS,
	type CreateWindowedListResourceOptions,
	type WindowedParams
} from './windowed.svelte';
export {
	SnapshotListResource,
	createSnapshotListResource,
	SNAPSHOT_BOUNDARY_MISMATCH_MESSAGE,
	type CreateSnapshotListResourceOptions,
	type SnapshotListFetcher,
	type SnapshotListRequest,
	type SnapshotListResult
} from './snapshot.svelte';
export { FormResource, createFormResource, type SubmitResult } from './form.svelte';

export {
	createInMemoryDataProvider,
	type InMemorySeed,
	type InMemoryDataProviderOptions
} from './providers/inMemory';

export {
	createTauriDataProvider,
	createTauriAuthProvider,
	type TauriInvokeOptions,
	type TauriAuthProviderOptions
} from './providers/tauri';

export { adaptLegacyAuthProvider, ADAPTER_REVISION } from './providers/legacyAdapter';

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

export type {
	AppEvent,
	EventProvider,
	EventSubscriptionHooks,
	TauriEventListenOptions,
	SseEventProviderOptions
} from './events';
export { createTauriEventProvider, createSseEventProvider, connectEvents } from './events';

export type { SseParser } from './sse-parser';
export { createSseParser } from './sse-parser';

export type { PaletteCommand } from './commands';
export { searchCommands } from './commands';

export type { ListViewSnapshot, LastEditedRecord } from './listViewState';
export {
	saveListViewState,
	loadListViewState,
	clearListViewState,
	clearAllListViewState,
	saveActiveListMode,
	loadActiveListMode,
	saveLastOpenedId,
	loadLastOpenedId,
	noteLastEditedRecord,
	takeLastEditedRecord
} from './listViewState';

export type { SessionScope } from './sessionScope.svelte';
export {
	currentSessionScope,
	isCurrentSessionScope,
	isSessionEstablished,
	sessionGeneration,
	sessionOwnerKey
} from './sessionScope.svelte';
export {
	beginSession,
	endSession,
	establishSession,
	MAX_STALE_RETRIES,
	SessionChangedError
} from './sessionLifecycle';
