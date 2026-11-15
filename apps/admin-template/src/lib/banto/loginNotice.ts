/** Public login notice. Only this dedicated setting is readable before login. */
import { invoke } from '@tauri-apps/api/core';
import { getAuthProvider } from '@banto/admin-core';
import { CSRF_HEADER, getBantoMode } from './setup';

const PATH = '/api/login-notice';

export async function getLoginNotice(): Promise<string> {
	switch (getBantoMode()) {
		case 'tauri':
			return invoke<string>('login_notice_get');
		case 'server': {
			const response = await fetch(PATH, { headers: CSRF_HEADER });
			if (!response.ok) throw new Error(`Login notice: ${response.status}`);
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
			return invoke<string>('login_notice_set', { notice });
		case 'server': {
			const getToken = (getAuthProvider() as { getToken?: () => string | null }).getToken;
			const token = getToken?.();
			if (!token) throw new Error('No active session');
			const response = await fetch(PATH, {
				method: 'PUT',
				headers: {
					...CSRF_HEADER,
					'Content-Type': 'application/json',
					Authorization: `Bearer ${token}`
				},
				body: JSON.stringify({ notice })
			});
			if (!response.ok) throw new Error(`Login notice: ${response.status}`);
			return ((await response.json()) as { notice: string }).notice;
		}
		case 'demo':
			throw new Error('Login notice is unavailable in demo mode');
	}
}
