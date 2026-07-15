/**
 * Client for the generic file/image attachment API (spec
 * `docs/attachments-plan.md` §3.5-§3.6, M20 unit B). Same Tauri/REST split
 * as `backupsAdmin.ts`: the Tauri webview calls `invoke()` directly (the
 * `attachments_*` commands, `apps/admin-template/src-tauri/src/lib.rs`), a
 * LAN browser client served by the embedded server calls `fetch()` against
 * `/api/attachments/*` (`apps/admin-template/core/src/rest.rs`), and plain
 * `vite dev`/`vite preview` demo mode rejects every export with a
 * `ProviderError` carrying `DEMO_MODE_MESSAGE` (spec §2.2: "ブラウザデモ
 * モードでの動作...InMemory実装は作らない").
 *
 * This is the "アプリ側（コピーして書き換える対象）" layer (spec §3.1
 * table): `@banto/attachments`'s `AttachmentsPanel` (unit C) receives an
 * `AttachmentsClient` built from the exports below via props - the package
 * itself never imports this file (spec §3.7: "アプリ固有 import なし").
 *
 * ## Binary transfer
 *
 * Upload sends the file's raw bytes, not a JSON/base64 encoding (spec §3.5,
 * §7: 25MB/file cap, enforced server-side either way):
 * - REST mode: `POST /api/attachments?resource=&resourceId=&fileName=`,
 *   raw bytes body - same shape as `backupsAdmin.ts`'s
 *   `uploadAndStageRestore`.
 * - Tauri mode: `invoke('attachments_upload', uint8ArrayBody, { headers })`
 *   - Tauri v2's raw-body IPC path (`tauri::ipc::Request`, see
 *   `src-tauri/src/lib.rs`'s `attachments_upload` doc comment for why the
 *   metadata rides headers, percent-encoded, instead of ordinary args).
 *
 * ## Thumbnail/download display
 *
 * Every `/api/*` route requires a bearer token (spec: no cookie fallback -
 * see `rest.rs`'s module doc comment), so a bare `<img src="/api/
 * attachments/{id}/thumbnail">` cannot authenticate itself, and the Tauri
 * webview has no HTTP route to point at in the first place (spec §3.6).
 * Both modes therefore fetch the bytes themselves (`fetch` + `Authorization`
 * header, or `invoke` + `Vec<u8>`) and hand back a `Blob` object URL -
 * `getThumbnailUrl`/`getDownloadUrl` below are `async` for this reason,
 * unlike a plain static URL string. Callers own the returned URL's
 * lifetime: call `URL.revokeObjectURL(url)` once it is no longer displayed.
 */
import { invoke } from '@tauri-apps/api/core';
import { getAuthProvider, isProviderError, ProviderError, type ErrorBody } from '@banto/admin-core';
import { CSRF_HEADER, getBantoMode } from './setup';

/** Mirrors `banto_attachments::AttachmentMeta` (camelCase on the wire, spec §3.2). */
export interface AttachmentMeta {
	id: number;
	resource: string;
	resourceId: string;
	fileName: string;
	mime: string;
	sizeBytes: number;
	sha256: string;
	hasThumbnail: boolean;
	createdAt: string;
	createdBy: string | null;
}

/** Mirrors the Tauri `attachments_open_folder` command's `OpenFolderResult` (`src-tauri/src/lib.rs`). */
export interface OpenFolderResult {
	opened: boolean;
	path: string;
}

export const DEMO_MODE_MESSAGE = 'デモモードでは利用できません';

function demoModeError(): ProviderError {
	return new ProviderError({ kind: 'other', message: DEMO_MODE_MESSAGE });
}

/** Is this environment backed by a real attachments service (Tauri or the embedded server)? False in plain-browser demo mode (spec §2.2). */
export function isAttachmentsAvailable(): boolean {
	return getBantoMode() !== 'demo';
}

const ERROR_KINDS = new Set([
	'not_found',
	'validation',
	'unauthorized',
	'forbidden',
	'storage',
	'other'
]);

/** Same type guard as providers/tauri.ts / providers/http.ts / backupsAdmin.ts (spec §10/§11.1). */
function isErrorBody(value: unknown): value is ErrorBody {
	if (typeof value !== 'object' || value === null) return false;
	const kind = (value as { kind?: unknown }).kind;
	return typeof kind === 'string' && ERROR_KINDS.has(kind);
}

function toProviderError(err: unknown): ProviderError {
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

const NETWORK_ERROR_MESSAGE = 'サーバーに接続できません';

/** Same token lookup as backupsAdmin.ts/usersAdmin.ts - see those files' doc comments. */
function currentToken(): string | null {
	const auth = getAuthProvider() as { getToken?: () => string | null };
	return auth.getToken ? auth.getToken() : null;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
	const headers: Record<string, string> = { ...CSRF_HEADER, ...extra };
	const token = currentToken();
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

/** Parse a non-2xx REST response body into a `ProviderError`, same shape-guessing as backupsAdmin.ts/usersAdmin.ts. */
async function errorFromResponse(response: Response): Promise<ProviderError> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return new ProviderError({
			kind: 'other',
			message: `${response.status} ${response.statusText}`
		});
	}
	if (isErrorBody(body)) return new ProviderError(body);
	return new ProviderError({ kind: 'other', message: `${response.status} ${response.statusText}` });
}

interface HttpJsonInit {
	method: string;
	body?: unknown;
	expectNoContent?: boolean;
}

async function httpJson<T>(path: string, init: HttpJsonInit): Promise<T> {
	const hasBody = init.body !== undefined;
	const headers = authHeaders(hasBody ? { 'Content-Type': 'application/json' } : undefined);

	let response: Response;
	try {
		response = await fetch(path, {
			method: init.method,
			headers,
			body: hasBody ? JSON.stringify(init.body) : undefined
		});
	} catch {
		throw new ProviderError({ kind: 'other', message: NETWORK_ERROR_MESSAGE });
	}

	if (!response.ok) throw await errorFromResponse(response);
	if (init.expectNoContent) return undefined as T;
	return (await response.json()) as T;
}

/** `viewer`+: every attachment for one record, newest first (spec §3.5). */
export async function listAttachments(resource: string, resourceId: string): Promise<AttachmentMeta[]> {
	if (!isAttachmentsAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') {
		return invokeCommand<AttachmentMeta[]>('attachments_list', { resource, resourceId });
	}
	return httpJson<AttachmentMeta[]>('/api/attachments/list', {
		method: 'POST',
		body: { resource, resourceId }
	});
}

/**
 * `editor`+: upload a new attachment (spec §3.5). Metadata
 * (`resource`/`resourceId`/`fileName`) always rides alongside the raw
 * bytes, never inside them - see this module's doc comment for why each
 * mode carries it differently (query string vs. percent-encoded headers).
 */
export async function uploadAttachment(
	resource: string,
	resourceId: string,
	file: File
): Promise<AttachmentMeta> {
	if (!isAttachmentsAvailable()) throw demoModeError();
	const bytes = await file.arrayBuffer();

	if (getBantoMode() === 'tauri') {
		try {
			// Raw invoke body (spec §3.5's Tauri "第一候補") - see
			// src-tauri/src/lib.rs's `attachments_upload` doc comment for why
			// the metadata rides headers, `encodeURIComponent`d since HTTP
			// header values cannot carry arbitrary Unicode.
			return await invoke<AttachmentMeta>('attachments_upload', new Uint8Array(bytes), {
				headers: {
					'x-banto-resource': encodeURIComponent(resource),
					'x-banto-resource-id': encodeURIComponent(resourceId),
					'x-banto-file-name': encodeURIComponent(file.name)
				}
			});
		} catch (err) {
			throw toProviderError(err);
		}
	}

	const query = new URLSearchParams({ resource, resourceId, fileName: file.name });
	let response: Response;
	try {
		response = await fetch(`/api/attachments?${query.toString()}`, {
			method: 'POST',
			headers: authHeaders({ 'Content-Type': 'application/octet-stream' }),
			body: bytes
		});
	} catch {
		throw new ProviderError({ kind: 'other', message: NETWORK_ERROR_MESSAGE });
	}
	if (!response.ok) throw await errorFromResponse(response);
	return (await response.json()) as AttachmentMeta;
}

/** `editor`+: delete one attachment (spec §3.5). */
export async function deleteAttachment(id: number): Promise<void> {
	if (!isAttachmentsAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') {
		await invokeCommand<void>('attachments_delete', { id });
		return;
	}
	await httpJson<void>(`/api/attachments/${id}`, { method: 'DELETE', expectNoContent: true });
}

async function fetchThumbnailBlob(id: number): Promise<Blob> {
	if (getBantoMode() === 'tauri') {
		// The command returns tauri::ipc::Response (raw bytes) - invoke
		// resolves an ArrayBuffer, not JSON (see the Rust doc comment).
		const bytes = await invokeCommand<ArrayBuffer>('attachments_read_thumbnail', { id });
		return new Blob([bytes], { type: 'image/jpeg' });
	}
	let response: Response;
	try {
		response = await fetch(`/api/attachments/${id}/thumbnail`, { headers: authHeaders() });
	} catch {
		throw new ProviderError({ kind: 'other', message: NETWORK_ERROR_MESSAGE });
	}
	if (!response.ok) throw await errorFromResponse(response);
	return response.blob();
}

async function fetchAttachmentBlob(meta: AttachmentMeta): Promise<{ blob: Blob; mime: string }> {
	if (getBantoMode() === 'tauri') {
		// Raw-bytes command (tauri::ipc::Response -> ArrayBuffer): a 25MB
		// body as a JSON number array would balloon to ~100MB of JSON. The
		// MIME comes from the meta the caller already holds.
		const bytes = await invokeCommand<ArrayBuffer>('attachments_read_body', { id: meta.id });
		return { blob: new Blob([bytes]), mime: meta.mime };
	}
	let response: Response;
	try {
		response = await fetch(`/api/attachments/${meta.id}/download`, { headers: authHeaders() });
	} catch {
		throw new ProviderError({ kind: 'other', message: NETWORK_ERROR_MESSAGE });
	}
	if (!response.ok) throw await errorFromResponse(response);
	return { blob: await response.blob(), mime: response.headers.get('content-type') ?? meta.mime };
}

/**
 * `viewer`+: an object URL for `meta`'s thumbnail (spec §3.5/§3.6 - see
 * this module's doc comment for why this is `async` rather than a plain
 * URL string). Rejects with `kind: "not_found"` if `meta.hasThumbnail` is
 * false, without a round trip to the server. The caller must
 * `URL.revokeObjectURL()` the result once done with it.
 */
export async function getThumbnailUrl(meta: AttachmentMeta): Promise<string> {
	if (!isAttachmentsAvailable()) throw demoModeError();
	if (!meta.hasThumbnail) {
		throw new ProviderError({ kind: 'not_found', resource: 'attachments', id: String(meta.id) });
	}
	const blob = await fetchThumbnailBlob(meta.id);
	return URL.createObjectURL(blob);
}

/**
 * `viewer`+: an object URL for `meta`'s full body (spec §3.5/§3.6) - for
 * in-panel image display or wiring up an `<a download>`. Same object-URL
 * lifetime contract as `getThumbnailUrl`.
 */
export async function getDownloadUrl(meta: AttachmentMeta): Promise<string> {
	if (!isAttachmentsAvailable()) throw demoModeError();
	const { blob, mime } = await fetchAttachmentBlob(meta);
	const typed = mime && blob.type !== mime ? blob.slice(0, blob.size, mime) : blob;
	return URL.createObjectURL(typed);
}

/** `editor`+, Tauri only: open the `attachments/` directory in the OS file explorer (spec §3.6). */
export async function openAttachmentsFolder(): Promise<OpenFolderResult> {
	if (!isAttachmentsAvailable()) throw demoModeError();
	if (getBantoMode() !== 'tauri') {
		throw new ProviderError({
			kind: 'other',
			message: 'この操作はデスクトップアプリでのみ利用できます'
		});
	}
	return invokeCommand<OpenFolderResult>('attachments_open_folder');
}
