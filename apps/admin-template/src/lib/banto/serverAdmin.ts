/**
 * Thin wrapper around the src-tauri embedded-server lifecycle commands
 * (spec §11.4). Every export here only makes sense inside the Tauri
 * webview - callers must guard with `isTauri()` (setup.ts) first, same as
 * any other capability-gated UI (spec §11.3: functionality a LAN browser
 * client cannot use is hidden by capability judgement, not disabled/greyed
 * out).
 */
import { invoke } from '@tauri-apps/api/core';
import { isProviderError, ProviderError, type ErrorBody } from '@banto/admin-core';

/** One LAN access URL and its QR code (as an inline SVG string), for the settings screen (spec §11.4). */
export interface QrSvg {
	url: string;
	svg: string;
}

/**
 * Mirrors src-tauri's `server_status`/`server_apply` command response shape.
 *
 * Issue #459: `enabled`/`bind`/`port`/`viewerPublic` are the SAVED settings
 * (what the next launch uses - the settings form starts from them); `running`,
 * `live`, `urls` and `qrSvgs` describe the listener that is actually serving.
 * Both halves come from one snapshot, identified by `generation`.
 */
export interface ServerStatus {
	enabled: boolean;
	running: boolean;
	bind: string;
	port: number;
	/**
	 * 閲覧公開 (Issue #189): whether LAN clients may obtain a synthetic
	 * `viewer` session without logging in (`POST /api/auth/grant/publicViewer`).
	 * Persisted with the other server settings; it has no effect inside this
	 * window, only on the LAN surface.
	 */
	viewerPublic: boolean;
	/**
	 * The listener that is actually serving, from its bound address (`null`
	 * when nothing is). Optional so older mocks and hosts read as "unknown"
	 * (see {@link liveBind}).
	 */
	live?: ServerListener | null;
	/** URLs (and QR codes) of the live listener - empty when nothing is serving. */
	urls: string[];
	qrSvgs: QrSvg[];
	/**
	 * Changes whenever the live listener is replaced (each `server_apply`).
	 * Anything shown or copied from the live values should be re-read when
	 * it changes.
	 */
	generation?: number;
	/**
	 * The last `server_apply` that failed after stopping the old listener,
	 * and what became of that listener (`null` when none since the last
	 * successful apply). Codes only - any text is built from the messages.
	 */
	applyFailure?: ServerApplyFailure | null;
	/**
	 * What the launch-time auto-start did because the saved port was in use
	 * (`null` when nothing happened, or after a successful `server_apply`).
	 * Codes and port numbers only - the text is built from the messages
	 * (`serverPortNotice.ts`, conventions §13). Optional so older mocks and
	 * hosts that never send it read as "nothing happened".
	 */
	portNotice?: ServerPortNotice | null;
}

/**
 * Mirrors src-tauri's `ServerPortNotice`: at launch the saved port was in
 * use, so the server either started on `port` (right behind it; `saved`:
 * whether `server.port` now holds it) or, with every port up to `lastPort`
 * in use too, did not start.
 */
export type ServerPortNotice =
	| { kind: 'fallback'; requestedPort: number; port: number; saved: boolean }
	| { kind: 'exhausted'; requestedPort: number; lastPort: number; allInUse: boolean };

/** Mirrors src-tauri's `ServerListener`: the serving listener's actual address and port. */
export interface ServerListener {
	bind: string;
	port: number;
}

/**
 * Mirrors src-tauri's `ServerApplyFailure`: what a failed `server_apply`
 * asked for (nothing was saved), why it failed, and whether the listener
 * that was running before is back (`restored`), was never there (`none`),
 * or could not be brought back (`restoreFailed` - nothing serves).
 */
export interface ServerApplyFailure {
	enabled: boolean;
	bind: string;
	port: number;
	reason: 'portInUse' | 'bindFailed' | 'saveFailed';
	previous: 'none' | 'restored' | 'restoreFailed';
}

/**
 * The bind address the status line should describe: the live listener's
 * when the host reports one, else the saved `bind` (older hosts, or nothing
 * serving).
 */
export function liveBind(status: ServerStatus): string {
	return status.live?.bind ?? status.bind;
}

const ERROR_KINDS = new Set([
	'not_found',
	'validation',
	'bad_request',
	'unauthorized',
	'forbidden',
	'storage',
	'other'
]);

/** Same type guard as systemAdmin.ts / providers/tauri.ts (spec §10/§11.1). */
function isErrorBody(value: unknown): value is ErrorBody {
	if (typeof value !== 'object' || value === null) return false;
	const kind = (value as { kind?: unknown }).kind;
	return typeof kind === 'string' && ERROR_KINDS.has(kind);
}

/** Tauri rejects with a `{ kind, message }` object, not an `Error` (Issue #287). */
export function toProviderError(err: unknown): ProviderError {
	if (isProviderError(err)) return err;
	if (isErrorBody(err)) return new ProviderError(err);
	const message = err instanceof Error ? err.message : String(err);
	return new ProviderError({ kind: 'other', message });
}

async function invokeCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
	try {
		return (await invoke(cmd, args)) as T;
	} catch (err) {
		throw toProviderError(err);
	}
}

/** Current saved settings + the live listener, as one snapshot (spec §11.4, Issue #459). */
export function getServerStatus(): Promise<ServerStatus> {
	return invokeCommand('server_status');
}

/** Persist new settings, stop/restart the server to match, and return the resulting status. */
export function applyServerSettings(
	enabled: boolean,
	bind: string,
	port: number,
	viewerPublic: boolean
): Promise<ServerStatus> {
	return invokeCommand('server_apply', { enabled, bind, port, viewerPublic });
}
