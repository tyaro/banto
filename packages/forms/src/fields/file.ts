/**
 * Pieces of the `file` field that need no component (downstream-requests-2026-11-plan
 * §4.12, Issue #714): the value's shape, the texts (i18n layer 1, conventions
 * §13), the on-screen checks of one file, and the upload of the chosen files.
 *
 * forms holds no data contract and imports no other package (conventions §4 /
 * §5): every byte goes through the injected `FieldDef.file.client`, whose
 * rejection is shown as it is.
 */
import { isFieldVisible } from '../layout';
import type {
	FieldDef,
	FileFieldClient,
	FileFieldConfig,
	FileFieldMeta,
	FileFieldValue,
	FormSchema,
	PendingFile
} from '../types';

/** Texts of a `file` field. Functions, so a caller always calls `t.key(...)`. */
export interface FileFieldMessages {
	/** The button that opens the file picker. */
	choose: () => string;
	/** Shown under the chosen files while the record does not exist yet. */
	pendingNote: () => string;
	/** State of a chosen file that is not uploaded. */
	pending: () => string;
	/** State of a file being uploaded. */
	uploading: () => string;
	/** Button: upload a chosen file now (the record exists). */
	upload: () => string;
	/** Button: try a failed upload again. */
	retry: () => string;
	/** Button: take a chosen file off the list (nothing was sent). */
	cancel: () => string;
	/** Button: delete a file the record has. */
	remove: () => string;
	/** Accessible name of a row's button: `action` is one of the four texts above. */
	actionLabel: (action: string, fileName: string) => string;
	/** Asked before a file the record has is deleted. */
	removeConfirm: (fileName: string) => string;
	/** The list of the record's files is being fetched. */
	loading: () => string;
	/** `client.list` rejected; `error` is what it rejected with. */
	loadFailed: (error: unknown) => string;
	/** Button: fetch the list again. */
	reload: () => string;
	/** Nothing attached, nothing chosen. */
	empty: () => string;
	/** `client.upload` rejected. The default shows the rejection's own message. */
	uploadFailed: (error: unknown) => string;
	/** `client.remove` rejected. The default shows the rejection's own message. */
	removeFailed: (error: unknown) => string;
	/** One file the picker refused: its name and why (a validation message). */
	rejected: (fileName: string, reason: string) => string;
	/** Accessible name of the list of files. */
	listLabel: (def: FieldDef) => string;
}

/** The message a rejection carries (an `Error`'s, or the string itself), else `null`. */
export function fileErrorText(error: unknown): string | null {
	if (typeof error === 'string') return error.trim() === '' ? null : error;
	if (error && typeof error === 'object' && 'message' in error) {
		const message = (error as { message: unknown }).message;
		if (typeof message === 'string' && message.trim() !== '') return message;
	}
	return null;
}

export const defaultFileFieldMessages: FileFieldMessages = {
	choose: () => 'ファイルを選択',
	pendingNote: () => '選んだファイルは、保存のあとでアップロードされます',
	pending: () => '未アップロード',
	uploading: () => 'アップロード中…',
	upload: () => 'アップロード',
	retry: () => '再試行',
	cancel: () => '取り消す',
	remove: () => '削除',
	actionLabel: (action, fileName) => `${fileName}: ${action}`,
	removeConfirm: (fileName) => `「${fileName}」を削除しますか？`,
	loading: () => '読み込み中…',
	loadFailed: (error) => fileErrorText(error) ?? 'ファイルの一覧を取得できませんでした',
	reload: () => '再読み込み',
	empty: () => 'ファイルはありません',
	uploadFailed: (error) => fileErrorText(error) ?? 'アップロードできませんでした',
	removeFailed: (error) => fileErrorText(error) ?? '削除できませんでした',
	rejected: (fileName, reason) => `${fileName}: ${reason}`,
	listLabel: (def) => `${def.label}のファイル`
};

/** `1536` -> `1.5 KB`. Binary steps (1 KB = 1024 B), one decimal at most. */
export function formatFileSize(bytes: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let size = Math.max(bytes, 0);
	let unit = 0;
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit++;
	}
	const text = unit === 0 ? String(Math.round(size)) : size.toFixed(1).replace(/\.0$/, '');
	return `${text} ${units[unit]}`;
}

/** The value of a `file` field nothing was done to: the record's files not known, nothing chosen. */
export function emptyFileValue(): FileFieldValue {
	return { existing: null, pending: [] };
}

/** Read anything as a `FileFieldValue` (a value of another shape counts as empty). */
export function fileValueOf(value: unknown): FileFieldValue {
	if (!value || typeof value !== 'object') return emptyFileValue();
	const { existing, pending } = value as Partial<FileFieldValue>;
	return {
		existing: Array.isArray(existing) ? existing : null,
		pending: Array.isArray(pending) ? pending : []
	};
}

/**
 * Whether `accept` (as `<input accept>`: comma-separated `.ext`, `type/*`,
 * `type/subtype`) lets the file through. The type is the one the browser
 * reports - a help for the input, never a guarantee (the server judges the
 * bytes, conventions §6).
 */
export function acceptsFile(
	accept: string | undefined,
	file: { name: string; type: string }
): boolean {
	const tokens = (accept ?? '')
		.split(',')
		.map((token) => token.trim().toLowerCase())
		.filter(Boolean);
	if (tokens.length === 0) return true;
	const name = file.name.toLowerCase();
	const type = file.type.toLowerCase();
	return tokens.some((token) => {
		if (token.startsWith('.')) return name.endsWith(token);
		if (token.endsWith('/*')) return type.startsWith(token.slice(0, -1));
		return type === token;
	});
}

/** What the field's own limits have against one file: too large, the wrong kind, or nothing. */
export function fileProblem(
	config: Pick<FileFieldConfig, 'accept' | 'maxFileSize'> | undefined,
	file: { name: string; type: string; size: number }
): 'size' | 'type' | null {
	if (!config) return null;
	if (!acceptsFile(config.accept, file)) return 'type';
	if (config.maxFileSize !== undefined && file.size > config.maxFileSize) return 'size';
	return null;
}

let nextKey = 0;

/** Wrap a chosen file as a list entry with a key of its own. */
export function newPendingFile(file: File): PendingFile {
	nextKey += 1;
	return { key: `file-${nextKey}`, file };
}

/** The schema's `file` field (a form has one at most), if any. */
export function fileFieldOf(schema: FormSchema): FieldDef | undefined {
	return schema.fields.find((def) => def.type === 'file');
}

/** `values` without the `file` fields: they are never submitted and never part of a dirty snapshot. */
export function withoutFileFields(
	schema: FormSchema,
	values: Record<string, unknown>
): Record<string, unknown> {
	const names = new Set(schema.fields.filter((def) => def.type === 'file').map((def) => def.name));
	if (names.size === 0) return values;
	return Object.fromEntries(Object.entries(values).filter(([name]) => !names.has(name)));
}

/** A visible `file` field has chosen files that are not uploaded: unsaved input. */
export function hasPendingFiles(schema: FormSchema, values: Record<string, unknown>): boolean {
	return schema.fields.some(
		(def) =>
			def.type === 'file' &&
			fileValueOf(values[def.name]).pending.length > 0 &&
			isFieldVisible(def, values)
	);
}

function mergeById(list: FileFieldMeta[], added: FileFieldMeta[]): FileFieldMeta[] {
	const ids = new Set(added.map((meta) => meta.id));
	return [...list.filter((meta) => !ids.has(meta.id)), ...added];
}

/**
 * A list that was ASKED when the value listed `before` and ANSWERED when it
 * lists `now`: the answer may be older than what happened in between, so what
 * arrived meanwhile (an upload that ended, also one of `uploadPendingFiles`)
 * is kept and what was deleted meanwhile stays away. `now === null`: the value
 * was reset, nothing happened to it - the list as it is.
 */
export function listAfterChanges(
	list: FileFieldMeta[],
	before: FileFieldMeta[] | null,
	now: FileFieldMeta[] | null
): FileFieldMeta[] {
	if (now === null) return list;
	const had = new Set((before ?? []).map((meta) => meta.id));
	const has = new Set(now.map((meta) => meta.id));
	const listed = new Set(list.map((meta) => meta.id));
	return [
		...list.filter((meta) => !had.has(meta.id) || has.has(meta.id)),
		...now.filter((meta) => !had.has(meta.id) && !listed.has(meta.id))
	];
}

/** What an upload run did: the files that arrived, and the ones the client refused (each with its `error`). */
export interface FileUploadOutcome {
	uploaded: FileFieldMeta[];
	failed: PendingFile[];
}

// One upload per chosen file at a time, whoever asks (the field's retry button
// and the app's `uploadPendingFiles` may meet).
const inFlight = new WeakSet<File>();

export interface UploadPendingOptions {
	config: FileFieldConfig;
	/** The record the files go to. */
	parentId: string | number;
	/** The field's current value (read again after every await: it may have changed). */
	read: () => unknown;
	write: (value: FileFieldValue) => void;
	/** The entries to send; default: every pending one, in list order. */
	keys?: readonly string[];
	/**
	 * Whether the value behind `read` / `write` is still the one of `parentId`
	 * (the caller's owner check, conventions §8). Once it says no, the run stops:
	 * nothing more is sent, and the answer that just came is written nowhere -
	 * it is a file of ANOTHER record than the one the value now shows.
	 */
	isCurrent?: () => boolean;
	/**
	 * Asked before EACH file is sent: `false` ends the run there (the field got
	 * hidden meanwhile). The files not yet sent stay chosen; an answer already
	 * on its way is still written.
	 */
	canSend?: () => boolean;
	/**
	 * A file arrived, but its entry is no longer among the chosen ones (the
	 * value was replaced meanwhile - a reset). Nothing is written; the caller
	 * that shows the record's files reads them again.
	 */
	onDetached?: (meta: FileFieldMeta) => void;
	messages?: Partial<FileFieldMessages>;
	onStart?: (key: string) => void;
	onEnd?: (key: string) => void;
}

/**
 * Upload chosen files ONE AFTER ANOTHER through the client. An arrived file
 * moves from `pending` to `existing`; a refused one stays pending with the
 * rejection as its `error` (never dropped silently), and the run goes on with
 * the next. Never rejects.
 *
 * An answer is written only into the value it was asked for: not after
 * `isCurrent` said no (the record changed), and not when the entry is gone
 * from `pending` (the value was reset). The file is still in `uploaded` - it
 * did arrive.
 */
export async function uploadPending(options: UploadPendingOptions): Promise<FileUploadOutcome> {
	const { config, parentId, read, write } = options;
	const isCurrent = options.isCurrent ?? (() => true);
	const t = { ...defaultFileFieldMessages, ...options.messages };
	const outcome: FileUploadOutcome = { uploaded: [], failed: [] };
	const keys = options.keys ?? fileValueOf(read()).pending.map((entry) => entry.key);
	for (const key of keys) {
		if (!isCurrent() || options.canSend?.() === false) break;
		const entry = fileValueOf(read()).pending.find((item) => item.key === key);
		if (!entry || inFlight.has(entry.file)) continue;
		const file = entry.file;
		inFlight.add(file);
		options.onStart?.(key);
		try {
			const meta = await config.client.upload(config.resource, String(parentId), file);
			outcome.uploaded.push(meta);
			if (isCurrent()) {
				const now = fileValueOf(read());
				if (now.pending.some((item) => item.key === key)) {
					write({
						existing: mergeById(now.existing ?? [], [meta]),
						pending: now.pending.filter((item) => item.key !== key)
					});
				} else {
					options.onDetached?.(meta);
				}
			}
		} catch (error) {
			const message = t.uploadFailed(error);
			outcome.failed.push({ key, file, error: message });
			if (isCurrent()) {
				const now = fileValueOf(read());
				if (now.pending.some((item) => item.key === key)) {
					write({
						existing: now.existing,
						pending: now.pending.map((item) =>
							item.key === key ? { ...item, error: message } : item
						)
					});
				}
			}
		} finally {
			inFlight.delete(file);
			options.onEnd?.(key);
		}
	}
	return outcome;
}

type RecordFilesListener = (client: FileFieldClient, resource: string, parentId: string) => void;

const recordFilesListeners = new Set<RecordFilesListener>();

/**
 * Package-internal: be told when a record's files changed on the server without
 * the value saying so (an upload of `uploadPendingFiles` that arrived after the
 * store was reset). A mounted `FileField` showing that record reads its list
 * again; nothing is written into any value from here. Returns the unsubscribe.
 */
export function onRecordFilesChanged(listener: RecordFilesListener): () => void {
	recordFilesListeners.add(listener);
	return () => {
		recordFilesListeners.delete(listener);
	};
}

function announceRecordFiles(client: FileFieldClient, resource: string, parentId: string): void {
	for (const listener of [...recordFilesListeners]) listener(client, resource, parentId);
}

/** The part of a `FormStore` the upload needs. */
export interface FileUploadStore {
	readonly values: Record<string, unknown>;
	setValue(name: string, value: unknown): void;
}

/**
 * For a NEW record: after the create succeeded, send the files chosen in the
 * form to the record it returned (`parentId`), one after another (§4.12 - the
 * files are never uploaded before the record exists). The record stays
 * whatever happens here; `failed` lists what the client refused, and those
 * files stay in the field with their error, to be tried again once the form
 * is in the edit state (`BantoForm`'s `fileParentId`).
 *
 * A field hidden by `visibleWhen` sends nothing - also one that gets hidden
 * while the run waits for an earlier file: the files not yet sent stay chosen
 * (what was sent stays sent). Never rejects.
 *
 * If the store is reset while a file is on its way, that file's answer is not
 * written into the reset form (its entry is gone); the files not yet sent are
 * gone with the reset and are not sent. A `FileField` that shows `parentId`'s
 * files at that moment reads its list again, so the file is not missing there.
 */
export async function uploadPendingFiles(
	schema: FormSchema,
	store: FileUploadStore,
	parentId: string | number,
	messages?: Partial<FileFieldMessages>
): Promise<FileUploadOutcome> {
	const def = fileFieldOf(schema);
	if (!def?.file || !isFieldVisible(def, store.values)) return { uploaded: [], failed: [] };
	const config = def.file;
	return uploadPending({
		config,
		parentId,
		read: () => store.values[def.name],
		write: (value) => store.setValue(def.name, value),
		canSend: () => isFieldVisible(def, store.values),
		onDetached: () => announceRecordFiles(config.client, config.resource, String(parentId)),
		messages
	});
}
