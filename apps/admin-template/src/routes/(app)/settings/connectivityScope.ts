/**
 * Pure classification of a `ServerStatus.bind` address into how far the
 * embedded server can be reached (Issue #216). `ConnectivitySection.svelte`
 * uses this to pick the "running, this PC only" vs. "running, reachable from
 * the LAN" status wording and to decide whether the firewall-reachability
 * caveat applies - kept as a small pure function (rather than inline in the
 * component) so it is table-testable without a running Tauri backend, and so
 * a regression back to "always show LAN wording regardless of bind" is
 * caught by a plain vitest run.
 *
 * Mirrors (at the classification level, not the URL-building level) the
 * bind-based split `banto-server::server::lan_urls` does in Rust: a loopback
 * bind is `'local'`, anything else (`0.0.0.0`, `::`, or a specific
 * non-loopback address) is `'lan'`. The settings screen's bind `<select>`
 * currently only offers `127.0.0.1`/`0.0.0.0` (see `ConnectivitySection`'s
 * `bindLocalOnly`/`bindLanPublic` options), but this also classifies the
 * other bind forms `ServerConfig.bind` accepts (IPv6 loopback, a specific
 * address) so it stays correct if that select gains more options later.
 */
export type ConnectivityScope = 'local' | 'lan';

/** Bind literals that only accept connections from this machine. */
const LOOPBACK_BINDS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Classifies `bind` (the raw `ServerStatus.bind`/`ServerSettings.bind`
 * string) into `'local'` (only this PC can connect) or `'lan'` (other
 * devices on the network are configured to be able to connect - actual
 * reachability still depends on firewalls/routers, which this does not and
 * cannot know about).
 */
export function connectivityScope(bind: string): ConnectivityScope {
	return LOOPBACK_BINDS.has(bind) ? 'local' : 'lan';
}
