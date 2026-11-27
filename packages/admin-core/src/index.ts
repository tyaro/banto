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
	DeleteManyItem,
	DeleteManyOptions,
	DeleteManyResult,
	DeleteManyTarget,
	DeleteOneOptions,
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

export type { FieldError, ErrorBody, NetworkFailure } from './errors';
export {
	ProviderError,
	isProviderError,
	notFound,
	validation,
	StaleAnswerError,
	isStaleAnswerError,
	isNetworkError
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

export { onInvalidate, invalidate, invalidateAll } from './invalidate';
export type { InvalidateReason } from './invalidate';

export {
	createSessionController,
	getSessionController,
	resolveSettled,
	grantFallback,
	DEFAULT_GRANT_RETRIES,
	SessionTimeoutError,
	SessionProviderMissingError,
	SessionChangedError,
	type GrantFallbackOptions,
	type GrantStatus,
	type SessionController,
	type SessionControllerDeps,
	type SessionResolveOptions,
	type SessionSnapshot,
	type SessionTicket,
	type ResolveResult
} from './sessionController.svelte';
export { onSessionEnded } from './sessionEnded';

export { ListResource, createListResource, type CreateListResourceOptions } from './list.svelte';
export {
	WindowedListResource,
	createWindowedListResource,
	DEFAULT_WINDOWED_REQUEST_TIMEOUT_MS,
	type CreateWindowedListResourceOptions,
	type WindowedParams
} from './windowed.svelte';
export {
	ListBlockError,
	isListBlockError,
	defaultListBlockMessages,
	type ListBlockErrorFailure,
	type ListBlockFailureCode,
	type ListBlockMessages,
	type ListBlockNotify
} from './blockFetch';
export {
	SnapshotListResource,
	createSnapshotListResource,
	defaultSnapshotListMessages,
	type CreateSnapshotListResourceOptions,
	type SnapshotListFailure,
	type SnapshotListExpiredFailure,
	type SnapshotListMessages,
	type SnapshotListFetcher,
	type SnapshotListRequest,
	type SnapshotListResult
} from './snapshot.svelte';
export {
	FormResource,
	conflictOf,
	createFormResource,
	type FormConflict,
	type FormResourceOptions,
	type SubmitResult
} from './form.svelte';
// Stale async results and temporary resources (spec §3; shared-primitives-upstream-plan
// §3.1・D1, conventions §8). The contract table is tests/contracts/request-owner.json.
export {
	createRequestOwner,
	DEFAULT_REQUEST_KEY,
	type RequestOwner,
	type RequestHandle
} from './request.svelte';

// UI setting current vs saved snapshot on top of UiSettingsProvider (spec §12.1;
// shared-primitives-upstream-plan §3.4, Issue #437).
export {
	createSavedSetting,
	type SavedSetting,
	type SavedSettingOptions,
	type SavedSettingMode,
	type SavedSettingLoad,
	type SavedSettingRetry,
	type SavedSettingSettled,
	MAX_CONFLICT_ATTEMPTS
} from './savedSetting.svelte';

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
	DEFAULT_REQUEST_TIMEOUT_MS,
	type HttpDataProviderOptions,
	type HttpAuthProviderOptions,
	type HttpRequestResult
} from './providers/http';

export {
	createConnectionMonitor,
	nextConnectionState,
	connectionStatusOf,
	initialConnectionState,
	DEFAULT_FAILURE_THRESHOLD,
	type ConnectionMonitor,
	type ConnectionMonitorOptions,
	type ConnectionStatus,
	type ConnectionState,
	type ConnectionEvent,
	type ConnectionEventTarget
} from './connectionMonitor.svelte';

export {
	createHttpConfigDrafts,
	createTauriConfigDrafts,
	configDraftConflict,
	CONFIG_DRAFT_ABSENT_REVISION,
	type ConfigChange,
	type ConfigDiff,
	type ConfigDiffOptions,
	type ConfigDraft,
	type ConfigDraftConflict,
	type ConfigDraftDiscarded,
	type ConfigDraftPutInput,
	type ConfigDraftRebaseInput,
	type ConfigDraftSaved,
	type ConfigDraftsProvider,
	type ConfigHistoryDetail,
	type ConfigHistoryEntry,
	type ConfigHistoryKind,
	type ConfigHistoryListOptions,
	type ConfigLock,
	type ConfigLockInfo,
	type ConfigPublishInput,
	type ConfigPublished,
	type ConfigPublishedStamp,
	type ConfigPublishOutcome,
	type ConfigRevertInput,
	type ConfigState,
	type ConfigTargetSummary,
	type HttpConfigDraftsOptions,
	type TauriConfigDraftsOptions
} from './providers/configDrafts';

export {
	createLocalUiSettings,
	createTauriUiSettings,
	createHttpUiSettings,
	updateUiSetting,
	uiSettingConflict,
	UI_SETTING_ABSENT_REVISION,
	type UiSettingsProvider,
	type UiSettingSnapshot,
	type UiSettingWriteOptions,
	type UiSettingWriteResult,
	type UiSettingRemoveResult,
	type UpdateUiSettingOptions,
	type UpdatedUiSetting,
	type LocalUiSettingsOptions,
	type UiSettingsLocks,
	type TauriUiSettingsOptions,
	type HttpUiSettingsOptions
} from './providers/uiSettings';

export type {
	AppEvent,
	EventProvider,
	EventSubscriptionHooks,
	TauriEventListenOptions,
	SseEventProviderOptions,
	StreamConnectionListener
} from './events';
export {
	createTauriEventProvider,
	createSseEventProvider,
	connectEvents,
	sessionStreamHooks
} from './events';

// Pop-out panel windows (ADR-0037): the frontend half of `banto-tauri-panel`.
export type {
	PanelWindowContent,
	PanelWindowEnvironment,
	OpenPanelWindowOptions,
	ListenPanelClosedOptions,
	PanelPopOutOptions,
	PanelPopOutStorage,
	PanelRestoreSaved,
	PanelPopOut,
	PanelWindowsClosed,
	PanelWindowsCloseOptions
} from './panelWindow';
export {
	PANEL_CLOSED_EVENT,
	PANEL_OPEN_COMMAND,
	PANEL_LIST_COMMAND,
	PANEL_CLOSE_COMMAND,
	openPanelWindow,
	listPanelWindows,
	closePanelWindow,
	listenPanelClosed,
	createPanelPopOut
} from './panelWindow';

export type { SseParser, SseMessage, SseMessageParser } from './sse-parser';
export { createSseParser, createSseMessageParser } from './sse-parser';

export type { SseStreamOptions } from './sse-stream';
export { createSseStream } from './sse-stream';

export type { PaletteCommand, PaletteSource } from './commands';
export { searchCommands } from './commands';
export {
	createPaletteSourceSearch,
	type PaletteSourceSearch,
	type PaletteSourceSearchOptions,
	type PaletteSourceState,
	type PaletteSourceStatus
} from './paletteSources.svelte';

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
	takeLastEditedRecord,
	isListViewSnapshot
} from './listViewState';

export type { SessionScope } from './sessionScope.svelte';
export {
	currentSessionScope,
	isCurrentSessionScope,
	isSessionEstablished,
	sessionGeneration,
	sessionOwnerKey
} from './sessionScope.svelte';
