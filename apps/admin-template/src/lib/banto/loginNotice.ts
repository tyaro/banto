/** Public login notice. Only this dedicated setting is readable before login. */
import { invoke } from '@tauri-apps/api/core';
import { getAuthProvider, isProviderError, ProviderError, type ErrorBody } from '@banto/admin-core';
import { CSRF_HEADER, getBantoMode } from './setup';

const PATH = '/api/login-notice';
const ERROR_KINDS = new Set<ErrorBody['kind']>([
	'not_found',
	'validation',
	'bad_request',
	'unauthorized',
	'forbidden',
	'conflict',
	'storage',
	'other'
]);

function isErrorBody(value: unknown): value is ErrorBody {
	if (!value || typeof value !== 'object') return false;
	const kind = (value as { kind?: unknown }).kind;
	return typeof kind === 'string' && ERROR_KINDS.has(kind as ErrorBody['kind']);
}

function toProviderError(error: unknown): ProviderError {
	if (isProviderError(error)) return error;
	if (isErrorBody(error)) return new ProviderError(error);
	const message = error instanceof Error ? error.message : String(error);
	return new ProviderError({ kind: 'other', message });
}

async function invokeNotice(command: string, args?: Record<string, unknown>): Promise<string> {
	try {
		return await invoke<string>(command, args);
	} catch (error) {
		throw toProviderError(error);
	}
}

async function responseError(response: Response): Promise<ProviderError> {
	const body: unknown = await response.json().catch(() => null);
	if (isErrorBody(body)) return new ProviderError(body);
	return new ProviderError({ kind: 'other', message: `${response.status} ${response.statusText}` });
}

export async function getLoginNotice(): Promise<string> {
	switch (getBantoMode()) {
		case 'tauri':
			return invokeNotice('login_notice_get');
		case 'server': {
			const response = await fetch(PATH, { headers: CSRF_HEADER });
			if (!response.ok) throw await responseError(response);
			return ((await response.json()) as { notice: string }).notice;
		}
		case 'demo':
			return '';
	}
}

export function canEditLoginNotice(): boolean {
	return getBantoMode() !== 'demo';
}

export function loginConnection(): { kind: 'local' | 'lan' | 'demo'; address?: string } {
	switch (getBantoMode()) {
		case 'tauri':
			return { kind: 'local' };
		case 'server':
			return { kind: 'lan', address: window.location.host };
		case 'demo':
			return { kind: 'demo' };
	}
}

export async function setLoginNotice(notice: string): Promise<string> {
	switch (getBantoMode()) {
		case 'tauri':
			return invokeNotice('login_notice_set', { notice });
		case 'server': {
			const auth = getAuthProvider() as { getToken?: () => string | null };
			const token = auth.getToken?.();
			if (!token) throw new ProviderError({ kind: 'unauthorized' });
			const response = await fetch(PATH, {
				method: 'PUT',
				headers: {
					...CSRF_HEADER,
					'Content-Type': 'application/json',
					Authorization: `Bearer ${token}`
				},
				body: JSON.stringify({ notice })
			});
			if (!response.ok) throw await responseError(response);
			return ((await response.json()) as { notice: string }).notice;
		}
		case 'demo':
			throw new Error('Login notice is unavailable in demo mode');
	}
}
