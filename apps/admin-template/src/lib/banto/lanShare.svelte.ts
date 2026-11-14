/**
 * 「LAN 共有中・接続 n 台」（Issue #558、design-ux-review-2026-11 D-2）。
 *
 * The desktop header shows whether this PC is sharing the app on the LAN and
 * how many browser windows are connected to it. Both come from the admin-only
 * `server_status` IPC (the same read the settings screen uses,
 * `serverAdmin.ts`), so only the desktop window of an admin ever asks - a LAN
 * browser has no such command and shows nothing.
 *
 * - **Sharing** = a listener is serving, it has a LAN URL (not loopback, not
 *   the wildcard - the same `pickPrimaryLanUrl` the settings QR uses, so the
 *   two can never disagree) and the build embeds the web UI (otherwise other
 *   devices only get a placeholder page, Issue #478).
 * - **Connections** = `ServerStatus.sseConnections`: the event streams open
 *   on the live listener, i.e. one per browser tab or window (the same device
 *   counts once per tab). This desktop window gets its events over IPC and is
 *   never counted. `null` when the host does not report it (older hosts).
 *
 * The status is re-read every {@link LAN_SHARE_POLL_MS} while a header
 * watches it (there is no event for "a browser connected"), and at once when
 * the settings screen applied new server settings ({@link LanShareStatus.refresh}).
 * Every read gets a ticket: a newer read, or the last watcher leaving, makes
 * older answers stale, so a slow answer never puts an older state back, and
 * no timer outlives the last watcher.
 */
import { getServerStatus, type ServerStatus } from '#lib/banto/serverAdmin.js';
import { pickPrimaryLanUrl } from '#lib/banto/connectivityScope.js';

/** How often a watched status is re-read (ms). */
export const LAN_SHARE_POLL_MS = 10_000;

/** What the header shows while sharing. */
export interface LanShareSummary {
	/** Open event streams on the live listener, or `null` when the host does not say. */
	connections: number | null;
}

/** The sharing summary of `status`, or `null` when this PC is not sharing on the LAN. */
export function lanShareSummary(status: ServerStatus | null): LanShareSummary | null {
	if (status === null || !status.running || status.uiEmbedded === false) return null;
	if (pickPrimaryLanUrl(status.urls) === null) return null;
	const count = status.sseConnections;
	return {
		connections: typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null
	};
}

export class LanShareStatus {
	/** `null` while not sharing, unknown (not read yet, or the read failed) or not watched. */
	summary = $state<LanShareSummary | null>(null);

	readonly #get: () => Promise<ServerStatus>;
	readonly #intervalMs: number;
	#watchers = 0;
	#ticket = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(get: () => Promise<ServerStatus>, intervalMs = LAN_SHARE_POLL_MS) {
		this.#get = get;
		this.#intervalMs = intervalMs;
	}

	/**
	 * Starts reading (now, then every interval) and returns the function that
	 * stops it. Several watchers share one timer; the last one to stop clears
	 * it, drops any answer still in flight and forgets the summary.
	 */
	watch(): () => void {
		this.#watchers++;
		if (this.#watchers === 1) void this.#read();
		let stopped = false;
		return () => {
			if (stopped) return;
			stopped = true;
			this.#watchers--;
			if (this.#watchers > 0) return;
			this.#ticket++;
			clearTimeout(this.#timer);
			this.#timer = undefined;
			this.summary = null;
		};
	}

	/** Re-reads now (e.g. after new server settings were applied). No-op while nobody watches. */
	refresh(): void {
		if (this.#watchers > 0) void this.#read();
	}

	async #read(): Promise<void> {
		const ticket = ++this.#ticket;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		let next: LanShareSummary | null;
		try {
			next = lanShareSummary(await this.#get());
		} catch {
			// Not readable (not an admin, an older host, a failed read): show nothing.
			next = null;
		}
		if (ticket !== this.#ticket) return;
		this.summary = next;
		this.#timer = setTimeout(() => void this.#read(), this.#intervalMs);
	}
}

/** The one status the header watches and the settings screen refreshes. */
export const lanShareStatus = new LanShareStatus(getServerStatus);
