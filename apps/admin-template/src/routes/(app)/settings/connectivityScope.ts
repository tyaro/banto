/**
 * Pure classification of the embedded server's reachability (Issue #216),
 * plus the one loopback test both halves of that classification share.
 * `ConnectivitySection.svelte` uses `connectivityScope` for the "running,
 * this PC only" vs. "running, reachable from the LAN" status wording, and
 * `pickPrimaryLanUrl` to choose which returned URL (if any) gets a QR code.
 *
 * Owner review on PR #254 (P2, 2nd round): these two decisions used to be
 * made two different ways - `connectivityScope` checked `bind` against a
 * fixed `{'127.0.0.1','::1','localhost'}` Set, while
 * `ConnectivitySection.svelte`'s QR picker checked each URL with
 * `!url.includes('127.0.0.1')`. Neither is a real loopback test: a bind of
 * `127.0.0.2` (anywhere in the loopback range other than the canonical
 * address) is loopback per `banto-server::server::lan_urls_for_bind`'s
 * `Ipv4Addr::is_loopback` check, but was not in the Set (status showed
 * `'lan'`) and did not contain the substring `127.0.0.1` (the QR picker
 * still chose it as "the LAN URL", the opposite of what the status line
 * claimed). `localhost`/`::1` had the same bug in the other direction: the
 * Set correctly called them `'local'`, but the substring check still picked
 * their URL for the QR. Both entry points now call `isLoopbackHost`, so
 * they can no longer disagree with each other.
 *
 * This intentionally stays on the frontend rather than adding a
 * backend-computed field to `ServerStatus`: the input (a bind literal, or a
 * URL's hostname) is already fully available here, the set of loopback forms
 * is small and closed (IPv4 127.0.0.0/8, the IPv6 loopback address, and the
 * `localhost` name), and the platform's own `URL` parser already normalizes
 * IPv6 textual variants for us (see `isLoopbackHost`), so there is no
 * hand-rolled IP parsing to keep in sync with Rust's. If `ServerStatus.bind`
 * ever stops being a literal the frontend can parse on its own, revisit this
 * in favor of an additive backend-computed field (e.g. `scope`/
 * `primaryLanUrl`) instead.
 */
export type ConnectivityScope = 'local' | 'lan';

/**
 * Whether `host` (a bind literal like `ServerStatus.bind`, or a URL's
 * `hostname`, bracketed or not) only accepts connections from this machine:
 * the whole IPv4 loopback range (`127.0.0.0/8`, not just `127.0.0.1`), the
 * IPv6 loopback address (any textual form of it - `::1`,
 * `0:0:0:0:0:0:0:1`, ... - compared via the platform's own `URL` host
 * normalization rather than a hand-rolled IPv6 parser), or the `localhost`
 * name (case-insensitive - DNS names are not case-sensitive).
 *
 * Deliberately conservative on anything it cannot parse as one of the above
 * (returns `false`, i.e. "not proven loopback") - this feeds a "should we
 * show a LAN URL/QR" decision, and wrongly saying "loopback" would hide a
 * real LAN URL, which is a more confusing failure to debug than wrongly
 * saying "not loopback" (shows a QR for something that turns out
 * unreachable - the LAN-reachability note next to it already hedges that).
 */
export function isLoopbackHost(host: string): boolean {
	const bare = stripBrackets(host.trim());
	const lower = bare.toLowerCase();
	if (lower === 'localhost') return true;

	const ipv4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (ipv4) {
		const octets = ipv4.slice(1).map(Number);
		return octets.every((n) => n >= 0 && n <= 255) && octets[0] === 127;
	}

	if (lower.includes(':')) {
		// Let `URL` normalize whatever textual form of an IPv6 address this
		// is, rather than re-implementing IPv6 parsing here - a malformed
		// address throws, which the catch below treats as "not loopback".
		try {
			return new URL(`http://[${lower}]`).hostname === '[::1]';
		} catch {
			return false;
		}
	}

	return false;
}

function stripBrackets(host: string): string {
	return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Classifies `bind` (the raw `ServerStatus.bind`/`ServerSettings.bind`
 * string) into `'local'` (only this PC can connect) or `'lan'` (other
 * devices on the network are configured to be able to connect - actual
 * reachability still depends on firewalls/routers, which this does not and
 * cannot know about).
 */
export function connectivityScope(bind: string): ConnectivityScope {
	return isLoopbackHost(bind) ? 'local' : 'lan';
}

/**
 * Whether `url` (one of `ServerStatus.urls`, e.g. `http://127.0.0.2:8721` or
 * `http://[::1]:8721`) points at a loopback address, by parsing out its
 * hostname (the `URL` API strips/keeps `[...]` IPv6 brackets consistently
 * for us) and running it through the same `isLoopbackHost` check
 * `connectivityScope` uses. Unparseable input is treated as NOT loopback
 * (see `isLoopbackHost`'s doc) so a malformed entry does not silently
 * disappear from the "pick a URL for the QR" search.
 */
export function isLoopbackUrl(url: string): boolean {
	try {
		return isLoopbackHost(new URL(url).hostname);
	} catch {
		return false;
	}
}

/**
 * Given `ServerStatus.urls` (already scoped to the applied `bind` by
 * `banto_server::lan_urls_for_bind`), picks the one URL to show a QR code
 * for: the first that is not loopback, or `null` if every entry is (a
 * loopback-scoped bind's `urls` is always exactly one loopback entry, so
 * this always resolves to `null` for it - no separate `scope === 'local'`
 * check needed here, but `ConnectivitySection.svelte` still gates the QR
 * block on `scope === 'lan'` too, so the two independent computations stay
 * cross-checked against each other rather than one silently relying on the
 * other never being wrong).
 */
export function pickPrimaryLanUrl(urls: readonly string[]): string | null {
	return urls.find((url) => !isLoopbackUrl(url)) ?? null;
}
