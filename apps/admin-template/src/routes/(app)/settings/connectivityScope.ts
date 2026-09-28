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
 *
 * Owner review on PR #254 (P2, 3rd round): `isUnspecifiedHost` and
 * `pickPrimaryLanUrl`'s exclusion of it were added because `"[::]"` (a
 * bracketed IPv6 wildcard) is a value `banto-server::server::ServerConfig`
 * accepts and `start` can actually bind, and the unspecified address itself
 * (`0.0.0.0`/`::`) is never a connectable destination (RFC 4291 §2.5.2) -
 * `banto_server::lan_urls_for_bind` now normalizes it server-side too
 * (`parse_bind`, same PR), but this module defends independently rather than
 * trusting `ServerStatus.urls` to never contain one: `isLoopbackHost`/
 * `isUnspecifiedHost` are exported and used directly by their own test
 * tables, which would otherwise pass on wrong assumptions about what the
 * backend always sends. `isLoopbackHost` was also extended to recognize an
 * IPv4-mapped IPv6 address (`"::ffff:127.0.0.1"`) as loopback, mirroring
 * Rust's `Ipv6Addr::to_ipv4_mapped` normalization - without it, `::1`'s IPv4
 * counterpart written in IPv6 syntax would read as a non-loopback "specific
 * address" (`Ipv6Addr::is_loopback` in Rust, and a bare `::1` string
 * comparison here, only match the literal `::1`). A zone-qualified address
 * (`"fe80::1%eth0"`) is deliberately NOT specially handled, matching the
 * Rust side's decision (`parse_bind`'s doc comment) - `URL` throws on it, so
 * it falls through both `isLoopbackHost` and `isUnspecifiedHost` as "neither"
 * (conservative default), which is safe even though not specially
 * classified.
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
	const lower = normalizeHost(host);
	if (lower === 'localhost') return true;

	const ipv4 = matchIpv4(lower);
	if (ipv4) return ipv4.every((n) => n >= 0 && n <= 255) && ipv4[0] === 127;

	if (lower.includes(':')) {
		const normalized = normalizeIpv6(lower);
		if (normalized === null) return false;
		if (normalized === '[::1]') return true;
		const mapped = ipv4MappedAddress(normalized);
		return mapped !== null && isLoopbackHost(mapped);
	}

	return false;
}

/**
 * Whether `host` is the IPv4 (`0.0.0.0`) or IPv6 (`::`, in any textual form
 * `normalizeIpv6` recognizes, including an IPv4-mapped spelling of
 * `0.0.0.0`) unspecified/wildcard address - "listen on every interface",
 * never a destination a client connects to (RFC 4291 §2.5.2). See this
 * module's top-of-file doc for why `pickPrimaryLanUrl` excludes it in
 * addition to loopback.
 */
export function isUnspecifiedHost(host: string): boolean {
	const lower = normalizeHost(host);
	if (lower === '0.0.0.0') return true;

	if (lower.includes(':')) {
		const normalized = normalizeIpv6(lower);
		if (normalized === null) return false;
		if (normalized === '[::]') return true;
		const mapped = ipv4MappedAddress(normalized);
		return mapped !== null && isUnspecifiedHost(mapped);
	}

	return false;
}

/** Trims and strips a `[...]` bracket pair, lower-cased. */
function normalizeHost(host: string): string {
	const trimmed = host.trim();
	const bare = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
	return bare.toLowerCase();
}

function matchIpv4(lower: string): number[] | null {
	const m = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	return m ? m.slice(1).map(Number) : null;
}

/**
 * Normalizes an IPv6 host (already lower-cased/unbracketed) to its bracketed
 * canonical form (e.g. `"0:0:0:0:0:0:0:1"` -> `"[::1]"`) via the platform's
 * own `URL` parser, rather than re-implementing IPv6 parsing. `null` for a
 * malformed address (including a zone id like `"fe80::1%eth0"` - `URL`
 * throws on it; PR #254 review, 3rd round explicitly decided not to support
 * zone ids).
 */
function normalizeIpv6(lower: string): string | null {
	try {
		return new URL(`http://[${lower}]`).hostname;
	} catch {
		return null;
	}
}

/**
 * If `bracketedIpv6` (a `normalizeIpv6` result, e.g. `"[::ffff:7f00:1]"`) is
 * an IPv4-mapped IPv6 address, returns the plain dotted-decimal IPv4 address
 * it represents (e.g. `"127.0.0.1"`); `null` otherwise. Mirrors Rust's
 * `Ipv6Addr::to_ipv4_mapped` (`banto-server`'s `parse_bind`, same PR).
 */
function ipv4MappedAddress(bracketedIpv6: string): string | null {
	const m = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(bracketedIpv6);
	if (!m) return null;
	const hi = Number.parseInt(m[1], 16);
	const lo = Number.parseInt(m[2], 16);
	return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
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
 * Whether `url` points at the unspecified/wildcard address (see
 * `isUnspecifiedHost`'s doc) - i.e. not a real destination at all, even
 * though it is not loopback either. `pickPrimaryLanUrl` excludes both.
 */
export function isUnspecifiedUrl(url: string): boolean {
	try {
		return isUnspecifiedHost(new URL(url).hostname);
	} catch {
		return false;
	}
}

/**
 * Given `ServerStatus.urls` (already scoped to the applied `bind` by
 * `banto_server::lan_urls_for_bind`), picks the one URL to show a QR code
 * for: the first that is neither loopback nor the unspecified address
 * itself, or `null` if none qualify (a loopback-scoped bind's `urls` is
 * always exactly one loopback entry, so this always resolves to `null` for
 * it - no separate `scope === 'local'` check needed here, but
 * `ConnectivitySection.svelte` still gates the QR block on `scope === 'lan'`
 * too, so the two independent computations stay cross-checked against each
 * other rather than one silently relying on the other never being wrong).
 * The unspecified-address exclusion (PR #254 review, 3rd round) is a
 * defense-in-depth measure - `lan_urls_for_bind` should never actually put
 * one in `urls` - not something expected to trigger in practice.
 */
export function pickPrimaryLanUrl(urls: readonly string[]): string | null {
	return urls.find((url) => !isLoopbackUrl(url) && !isUnspecifiedUrl(url)) ?? null;
}
