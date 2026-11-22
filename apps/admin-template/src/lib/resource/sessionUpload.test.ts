import type { FileFieldClient, FormSchema } from '@banto/forms';
import { describe, expect, it, vi } from 'vitest';
import { sendingWhile, type UploadGuard } from './sessionUpload';

const meta = { id: 1, fileName: 'a.txt' };

function schemaWith(upload: (...args: unknown[]) => Promise<unknown>): FormSchema {
	const client = {
		list: async () => [],
		upload,
		remove: async () => {}
	} as unknown as FileFieldClient;
	return {
		fields: [
			{ name: 'name', label: 'Name', type: 'text' },
			{ name: 'files', label: 'Files', type: 'file', file: { client, resource: 'items' } }
		]
	};
}

const clientOf = (schema: FormSchema): FileFieldClient => {
	const client = schema.fields.find((field) => field.type === 'file')?.file?.client;
	if (!client) throw new Error('no file client');
	return client;
};

describe('sendingWhile (#714 F2)', () => {
	it('hands the client the same check, for every upload the form starts', async () => {
		const upload = vi.fn(async (..._args: unknown[]) => meta);
		const canSend = (): boolean => true;
		const file = new File(['x'], 'a.txt');
		await expect(
			clientOf(sendingWhile(schemaWith(upload), canSend, () => 'refused')).upload(
				'items',
				'7',
				file
			)
		).resolves.toEqual(meta);
		expect(upload).toHaveBeenCalledTimes(1);
		const [resource, resourceId, sentFile, guard] = upload.mock.calls[0];
		expect([resource, resourceId, sentFile]).toEqual(['items', '7', file]);
		expect((guard as UploadGuard).canSend).toBe(canSend);
	});

	it('does not call the client once the session has ended', async () => {
		const upload = vi.fn(async () => meta);
		const wrapped = sendingWhile(
			schemaWith(upload),
			() => false,
			() => 'refused'
		);
		await expect(clientOf(wrapped).upload('items', '7', new File(['x'], 'a.txt'))).rejects.toThrow(
			'refused'
		);
		expect(upload).not.toHaveBeenCalled();
	});

	it("shows the app's message when the client refused because the session ended meanwhile", async () => {
		let live = true;
		const upload = vi.fn(async (...args: unknown[]) => {
			// The session ends while the client reads the bytes; its own check refuses.
			live = false;
			if (!(args[3] as UploadGuard).canSend()) throw new Error("client's refusal");
			return meta;
		});
		const wrapped = sendingWhile(
			schemaWith(upload),
			() => live,
			() => 'refused'
		);
		await expect(clientOf(wrapped).upload('items', '7', new File(['x'], 'a.txt'))).rejects.toThrow(
			'refused'
		);
	});

	it("keeps the client's own rejection while the session is live", async () => {
		const upload = vi.fn(async () => {
			throw new Error('too large');
		});
		const wrapped = sendingWhile(
			schemaWith(upload),
			() => true,
			() => 'refused'
		);
		await expect(clientOf(wrapped).upload('items', '7', new File(['x'], 'a.txt'))).rejects.toThrow(
			'too large'
		);
	});

	it('leaves a schema without a file field as it is', () => {
		const schema: FormSchema = { fields: [{ name: 'name', label: 'Name', type: 'text' }] };
		expect(
			sendingWhile(
				schema,
				() => true,
				() => 'refused'
			)
		).toBe(schema);
	});
});
