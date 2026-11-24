/**
 * Minimal, pure Server-Sent-Events line parser (spec §3.5, §11.3).
 *
 * `EventSource` cannot be used for `/api/events` because it has no way to
 * attach `Authorization`/`X-Banto-Client` headers (spec §11.2's bearer-token
 * + CSRF-header requirements), so `createSseEventProvider` (events.ts) reads
 * the response body as a raw byte/text stream via `fetch` +
 * `ReadableStream` instead. This module only knows how to turn that raw text
 * (delivered in arbitrarily-sized chunks - a `data:` line or the blank line
 * ending an event can land split across two chunks) into complete event
 * payload strings; it has no knowledge of fetch, tokens, or reconnection.
 *
 * `createSseParser` extracts only the `data:` field (multiple `data:` lines
 * within one event are joined with `\n`, per the SSE spec) - that is all
 * `AppEvent` (events.ts) needs. `createSseMessageParser` (Issue #936) also
 * reports the `event:` name, for app streams that mix several kinds of value
 * on one connection (`createSseStream`, sse-stream.ts). `id:`/`retry:` fields
 * are ignored by both. Lines starting with `:` are comments, used by the
 * server as keep-alive pings (`banto-server`'s `KeepAlive` layer) and produce
 * no event.
 */

/** Stateful (buffers a partial trailing line across calls), otherwise side-effect-free. */
export interface SseParser {
	/** Feed a chunk of raw response text; returns any complete event `data:` payloads it completes. */
	push(chunk: string): string[];
}

/**
 * One complete SSE event as `createSseMessageParser` reports it (Issue #936,
 * docs/design/sse-stream-design.md §5.1).
 */
export interface SseMessage {
	/** The `data:` payload (several `data:` lines are joined with `\n`, same as `createSseParser`). */
	data: string;
	/**
	 * The `event:` name (`banto_server::sse::SseFrame::event`). `undefined`
	 * when the event had no `event:` line or an empty one. If an event
	 * carries several `event:` lines, the last one wins (the SSE rule).
	 */
	event?: string;
}

/** Stateful like `SseParser`; reports each event's `event:` name next to its payload. */
export interface SseMessageParser {
	/** Feed a chunk of raw response text; returns every event it completes that had a `data:` line. */
	push(chunk: string): SseMessage[];
}

/** A field's value: the text after `name:`, minus one leading space (the SSE rule). */
function fieldValue(line: string, prefixLength: number): string {
	const value = line.slice(prefixLength);
	return value.startsWith(' ') ? value.slice(1) : value;
}

/** Extract one event's message from its raw text, or `null` if it had no `data:` line (e.g. a bare comment, or `event:` alone). */
function extractMessage(rawEvent: string): SseMessage | null {
	const dataLines: string[] = [];
	let event: string | undefined;
	for (const rawLine of rawEvent.split('\n')) {
		// A trailing '\r' can still be present on the last line of a "\r\n"
		// terminated line whose own line-ending was already stripped by the
		// caller's boundary search (which only looks for "\n\n").
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		if (line === '' || line.startsWith(':')) continue;
		if (line.startsWith('data:')) {
			dataLines.push(fieldValue(line, 5));
		} else if (line.startsWith('event:')) {
			const name = fieldValue(line, 6);
			event = name === '' ? undefined : name;
		}
		// Other fields (id:/retry:) are intentionally ignored (see module doc).
	}
	if (dataLines.length === 0) return null;
	const data = dataLines.join('\n');
	return event === undefined ? { data } : { data, event };
}

/**
 * Create a new parser with its own internal buffer (Issue #936). Feed it
 * every chunk read from the response body's `ReadableStream`, in order;
 * `push` returns every event completed by that chunk (zero, one, or several)
 * as `{ data, event? }`. Events without a `data:` line (a comment, `event:`
 * alone) are not reported, same as `createSseParser`.
 */
export function createSseMessageParser(): SseMessageParser {
	let buffer = '';

	return {
		push(chunk: string): SseMessage[] {
			// Normalize "\r\n" to "\n" up front so the rest of this module only
			// ever has to look for a single blank-line spelling ("\n\n"). Safe to
			// redo on the full buffer (including any carry-over) on every call: a
			// lone trailing "\r" left over from a chunk boundary has no "\n" to
			// pair with yet, so it simply stays put until the next chunk supplies
			// one.
			buffer = (buffer + chunk).replace(/\r\n/g, '\n');

			const messages: SseMessage[] = [];
			let boundary = buffer.indexOf('\n\n');
			while (boundary !== -1) {
				const rawEvent = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const message = extractMessage(rawEvent);
				if (message !== null) messages.push(message);
				boundary = buffer.indexOf('\n\n');
			}
			return messages;
		}
	};
}

/**
 * Create a new parser with its own internal buffer. Feed it every chunk read
 * from the response body's `ReadableStream`, in order; `push` returns the
 * `data:` payload of every event completed by that chunk (zero, one, or
 * several - a single chunk can contain multiple whole events). The same
 * parser as `createSseMessageParser`, reporting the payloads only.
 */
export function createSseParser(): SseParser {
	const parser = createSseMessageParser();
	return {
		push: (chunk: string): string[] => parser.push(chunk).map((message) => message.data)
	};
}
