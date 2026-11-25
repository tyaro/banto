/**
 * Issue #936 S3 (docs/design/sse-stream-design.md §5.2.2, §7):
 * `docs/recipes/app-sse-stream.md` shows the screen-side code of an app's own
 * stream. The code of the recipe's TypeScript block lives in
 * `fixtures/plantStream.ts` (it runs here; `scripts/permission-guards.test.mjs`
 * fails when the recipe's block and that file drift apart). The tests follow
 * the recipe's story: the value shown ->
 * the permission is taken away (403) -> the value is gone -> the permission
 * is back -> it is shown again; a re-sent old value does not clear "stale";
 * a new login does not show the previous session's value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPlantStream, type PlantView } from './fixtures/plantStream';

const encoder = new TextEncoder();

interface Call {
	url: string;
	open(): { send(text: string): void; end(): void };
	status(code: number): void;
}

/** `fetch` answered by hand, like the one in sseStream.test.ts. */
function manualFetch(): { fetchFn: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) =>
		new Promise<Response>((resolve) => {
			const signal = init!.signal!;
			calls.push({
				url: String(input),
				open() {
					let controller!: ReadableStreamDefaultController<Uint8Array>;
					const stream = new ReadableStream<Uint8Array>({
						start(c) {
							controller = c;
						}
					});
					signal.addEventListener('abort', () => {
						try {
							controller.error(new DOMException('aborted', 'AbortError'));
						} catch {
							// already closed
						}
					});
					resolve(new Response(stream));
					return {
						send: (text) => controller.enqueue(encoder.encode(text)),
						end: () => controller.close()
					};
				},
				status: (code) => resolve(new Response(null, { status: code }))
			});
		})) as typeof fetch;
	return { fetchFn, calls };
}

const realSetTimeout = globalThis.setTimeout;
async function micro(): Promise<void> {
	for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
}
async function tick(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await micro();
}

const values = (madeAt: number, value = 20.5) =>
	`event: values\ndata: ${JSON.stringify({ madeAt, value })}\n\n`;

function open() {
	const net = manualFetch();
	const state: { token: string | null } = { token: 'A' };
	const views: PlantView[] = [];
	const stop = openPlantStream(
		() => state.token,
		(view) => views.push(view),
		{ baseUrl: 'http://x', fetchFn: net.fetchFn }
	);
	return { ...net, state, views, stop, last: () => views[views.length - 1] };
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('the recipe screen', () => {
	it('shows a value, drops it on a 403, and shows it again when the permission is back', async () => {
		const s = open();
		expect(s.calls[0].url).toBe('http://x/api/plant/stream');
		const body = s.calls[0].open();
		await micro();
		body.send(values(1));
		await micro();
		expect(s.last()).toEqual({
			reading: { madeAt: 1, value: 20.5 },
			stale: false,
			forbidden: false
		});

		// The permission is taken away: the server closes the stream, the reconnect is refused.
		body.end();
		await micro();
		await tick(3000);
		s.calls[1].status(403);
		await micro();
		expect(s.last()).toEqual({ reading: null, stale: false, forbidden: true });

		// The refused retry waits 30 s (forbiddenRetryDelayMs), not 3 s.
		await tick(29_999);
		expect(s.calls).toHaveLength(2);
		await tick(1);
		expect(s.calls).toHaveLength(3);
		const again = s.calls[2].open();
		await micro();
		again.send(values(1));
		await micro();
		// The value is shown again (the stamp is the old one, so it is shown as stale: 33 s have passed) ...
		expect(s.last()).toEqual({
			reading: { madeAt: 1, value: 20.5 },
			stale: true,
			forbidden: false
		});
		// ... and a value the producer made after that is not stale.
		again.send(values(2));
		await micro();
		expect(s.last()).toEqual({
			reading: { madeAt: 2, value: 20.5 },
			stale: false,
			forbidden: false
		});
		s.stop();
	});

	it('a re-sent old value does not clear "stale"; a new stamp does', async () => {
		const s = open();
		const body = s.calls[0].open();
		await micro();
		body.send(values(1));
		await micro();
		await tick(15_000);
		expect(s.last().stale).toBe(true);

		// The producer is stopped: every reconnect re-sends the same value (same stamp).
		body.end();
		await micro();
		await tick(3000);
		const resent = s.calls[1].open();
		await micro();
		resent.send(values(1));
		await micro();
		expect(s.last()).toMatchObject({ reading: { madeAt: 1 }, stale: true });

		// The producer is back: a new stamp.
		resent.send(values(2));
		await micro();
		expect(s.last()).toMatchObject({ reading: { madeAt: 2 }, stale: false });
		s.stop();
	});

	it('a new login does not show the previous session value', async () => {
		const s = open();
		const body = s.calls[0].open();
		await micro();
		body.send(values(1));
		await micro();
		expect(s.last().reading).not.toBeNull();

		s.state.token = 'B';
		await tick(500);
		expect(s.last().reading).toBeNull();
		await tick(1);
		expect(s.calls).toHaveLength(2);
		s.stop();
	});
});
