/**
 * Issue #936 (design §5.1): `createSseMessageParser` reports the `event:`
 * name next to the `data:` payload. `createSseParser`'s own tests
 * (sse-parser.test.ts) keep fixing the payload-only shape.
 */
import { describe, expect, it } from 'vitest';
import { createSseMessageParser, createSseParser } from '../src/sse-parser';

describe('createSseMessageParser', () => {
	it('reports an event without a name as data only', () => {
		const parser = createSseMessageParser();
		expect(parser.push('data: hello\n\n')).toEqual([{ data: 'hello' }]);
		expect('event' in parser.push('data: again\n\n')[0]).toBe(false);
	});

	it('reports the event name, whichever side of data: it is on', () => {
		const parser = createSseMessageParser();
		expect(parser.push('event: temperature\ndata: 21.5\n\n')).toEqual([
			{ data: '21.5', event: 'temperature' }
		]);
		expect(parser.push('data: 3\nevent:level\n\n')).toEqual([{ data: '3', event: 'level' }]);
	});

	it('does not carry a name over to the next event', () => {
		const parser = createSseMessageParser();
		expect(parser.push('event: a\ndata: 1\n\ndata: 2\n\n')).toEqual([
			{ data: '1', event: 'a' },
			{ data: '2' }
		]);
	});

	it('takes the last of several event: lines, and treats an empty name as none', () => {
		const parser = createSseMessageParser();
		expect(parser.push('event: first\nevent: last\ndata: x\n\n')).toEqual([
			{ data: 'x', event: 'last' }
		]);
		expect(parser.push('event:\ndata: y\n\n')).toEqual([{ data: 'y' }]);
		expect(parser.push('event: named\nevent:\ndata: z\n\n')).toEqual([{ data: 'z' }]);
	});

	it('handles CRLF line endings', () => {
		const parser = createSseMessageParser();
		expect(parser.push('event: temp\r\ndata: 1\r\n\r\ndata: 2\r\n\r\n')).toEqual([
			{ data: '1', event: 'temp' },
			{ data: '2' }
		]);
	});

	it('joins several data: lines and keeps the name', () => {
		const parser = createSseMessageParser();
		expect(parser.push('event: log\ndata: line 1\ndata: line 2\n\n')).toEqual([
			{ data: 'line 1\nline 2', event: 'log' }
		]);
	});

	it('assembles an event split across chunks (inside the name, the payload and the blank line)', () => {
		const parser = createSseMessageParser();
		expect(parser.push('event: tem')).toEqual([]);
		expect(parser.push('perature\nda')).toEqual([]);
		expect(parser.push('ta: 21')).toEqual([]);
		expect(parser.push('.5\n')).toEqual([]);
		expect(parser.push('\nevent: level\r')).toEqual([{ data: '21.5', event: 'temperature' }]);
		expect(parser.push('\ndata: 3\r\n\r')).toEqual([]);
		expect(parser.push('\n')).toEqual([{ data: '3', event: 'level' }]);
	});

	it('reports nothing for an event without data: (a name alone, a comment, id/retry)', () => {
		const parser = createSseMessageParser();
		expect(parser.push('event: lonely\n\n')).toEqual([]);
		expect(parser.push(': keep-alive\n\n')).toEqual([]);
		expect(parser.push('id: 7\nretry: 1000\n\n')).toEqual([]);
		// ...and the dropped name does not leak into the next event.
		expect(parser.push('id: 8\ndata: next\n\n')).toEqual([{ data: 'next' }]);
	});

	it('createSseParser returns the same payloads, without the names', () => {
		const chunks = ['event: a\ndata: 1\n\n: ping\n\nda', 'ta: 2\ndata: 3\n\nevent: b\n\n'];
		const messages = createSseMessageParser();
		const payloads = createSseParser();
		for (const chunk of chunks) {
			expect(payloads.push(chunk)).toEqual(messages.push(chunk).map((message) => message.data));
		}
	});
});
