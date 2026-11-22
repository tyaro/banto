import type { FileFieldClient, FileFieldMeta, FormSchema } from '@banto/forms';
import { describe, expect, it, vi } from 'vitest';
import {
	sendingWhile,
	UNGUARDED_CLIENT_MESSAGE,
	type SessionGuardedUpload,
	type UploadGuard
} from './sessionUpload';

const meta = { id: 1, fileName: 'a.txt' } as unknown as FileFieldMeta;
const aFile = (): File => new File(['x'], 'a.txt');

function schemaWith(client: FileFieldClient): FormSchema {
	return {
		fields: [
			{ name: 'name', label: 'Name', type: 'text' },
			{ name: 'files', label: 'Files', type: 'file', file: { client, resource: 'items' } }
		]
	};
}

type UploadWhile = SessionGuardedUpload['uploadWhile'];

/** A guard-aware client: `upload` (unguarded) must never be the one called. */
function guardedClient(uploadWhile: UploadWhile): {
	client: FileFieldClient & SessionGuardedUpload;
	upload: ReturnType<typeof vi.fn>;
} {
	const upload = vi.fn(async () => meta);
	return {
		client: { list: async () => [], upload, remove: async () => {}, uploadWhile },
		upload
	};
}

const clientOf = (schema: FormSchema): FileFieldClient => {
	const client = schema.fields.find((field) => field.type === 'file')?.file?.client;
	if (!client) throw new Error('no file client');
	return client;
};

describe('sendingWhile (#714 F2)', () => {
	it('sends through `uploadWhile`, handing the client the same check', async () => {
		const uploadWhile = vi.fn<UploadWhile>(async () => meta);
		const { client, upload } = guardedClient(uploadWhile);
		const canSend = (): boolean => true;
		const file = aFile();
		await expect(
			clientOf(sendingWhile(schemaWith(client), canSend, () => 'refused')).upload(
				'items',
				'7',
				file
			)
		).resolves.toEqual(meta);
		expect(uploadWhile).toHaveBeenCalledTimes(1);
		const [resource, resourceId, sentFile, guard] = uploadWhile.mock.calls[0];
		expect([resource, resourceId, sentFile]).toEqual(['items', '7', file]);
		expect(guard.canSend).toBe(canSend);
		// The unguarded entry is never used.
		expect(upload).not.toHaveBeenCalled();
	});

	it('refuses a client without `uploadWhile`: its 3-argument upload is not run as protected', async () => {
		const upload = vi.fn(async () => meta);
		const plain: FileFieldClient = { list: async () => [], upload, remove: async () => {} };
		const wrapped = sendingWhile(
			schemaWith(plain),
			() => true,
			() => 'refused'
		);
		await expect(clientOf(wrapped).upload('items', '7', aFile())).rejects.toThrow(
			UNGUARDED_CLIENT_MESSAGE
		);
		expect(upload).not.toHaveBeenCalled();
	});

	it('still lists and deletes through a client without `uploadWhile`', async () => {
		const list = vi.fn(async () => [meta]);
		const remove = vi.fn(async () => {});
		const plain: FileFieldClient = { list, upload: async () => meta, remove };
		const wrapped = clientOf(
			sendingWhile(
				schemaWith(plain),
				() => true,
				() => 'refused'
			)
		);
		await expect(wrapped.list('items', '7')).resolves.toEqual([meta]);
		await wrapped.remove(1);
		expect(list).toHaveBeenCalledWith('items', '7');
		expect(remove).toHaveBeenCalledWith(1);
	});

	it('keeps `this` for a client written with methods', async () => {
		class MethodClient implements FileFieldClient, SessionGuardedUpload {
			readonly calls: string[] = [];
			private readonly base = '/api';
			async list(resource: string, resourceId: string): Promise<FileFieldMeta[]> {
				this.calls.push(`list ${this.base}/${resource}/${resourceId}`);
				return [];
			}
			async upload(): Promise<FileFieldMeta> {
				throw new Error('the unguarded upload must not be called');
			}
			async remove(id: number): Promise<void> {
				this.calls.push(`remove ${this.base}/${id}`);
			}
			async uploadWhile(
				resource: string,
				resourceId: string,
				file: File,
				guard: UploadGuard
			): Promise<FileFieldMeta> {
				if (!guard.canSend()) throw new Error("client's refusal");
				this.calls.push(`upload ${this.base}/${resource}/${resourceId}/${file.name}`);
				return meta;
			}
		}
		const client = new MethodClient();
		const wrapped = clientOf(
			sendingWhile(
				schemaWith(client),
				() => true,
				() => 'refused'
			)
		);
		await expect(wrapped.upload('items', '7', aFile())).resolves.toEqual(meta);
		await wrapped.list('items', '7');
		await wrapped.remove(3);
		expect(client.calls).toEqual([
			'upload /api/items/7/a.txt',
			'list /api/items/7',
			'remove /api/3'
		]);
	});

	it('does not call the client once the session has ended', async () => {
		const uploadWhile = vi.fn<UploadWhile>(async () => meta);
		const wrapped = sendingWhile(
			schemaWith(guardedClient(uploadWhile).client),
			() => false,
			() => 'refused'
		);
		await expect(clientOf(wrapped).upload('items', '7', aFile())).rejects.toThrow('refused');
		expect(uploadWhile).not.toHaveBeenCalled();
	});

	it("shows the app's message when the client refused because the session ended meanwhile", async () => {
		let live = true;
		const uploadWhile: UploadWhile = async (_resource, _id, _file, guard) => {
			// The session ends while the client reads the bytes; its own check refuses.
			live = false;
			if (!guard.canSend()) throw new Error("client's refusal");
			return meta;
		};
		const wrapped = sendingWhile(
			schemaWith(guardedClient(uploadWhile).client),
			() => live,
			() => 'refused'
		);
		await expect(clientOf(wrapped).upload('items', '7', aFile())).rejects.toThrow('refused');
	});

	it("keeps the client's own rejection while the session is live", async () => {
		const uploadWhile: UploadWhile = async () => {
			throw new Error('too large');
		};
		const wrapped = sendingWhile(
			schemaWith(guardedClient(uploadWhile).client),
			() => true,
			() => 'refused'
		);
		await expect(clientOf(wrapped).upload('items', '7', aFile())).rejects.toThrow('too large');
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
