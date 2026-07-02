/**
 * DataProvider/AuthProvider/Notifier contracts (spec §3.2, §3.3, §3.4).
 * UI-agnostic: no Svelte imports here.
 */
import type { ListParams, ListResult } from './types';

/** Backend-agnostic CRUD abstraction. Implementations throw `ProviderError`. */
export interface DataProvider {
	getList<T>(resource: string, params: ListParams): Promise<ListResult<T>>;
	getOne<T>(resource: string, id: string | number): Promise<T>;
	create<T>(resource: string, values: Record<string, unknown>): Promise<T>;
	update<T>(resource: string, id: string | number, values: Record<string, unknown>): Promise<T>;
	deleteOne(resource: string, id: string | number): Promise<void>;
}

export interface Identity {
	id: string;
	name: string;
}

/** Authentication abstraction used by the route guard and login page. */
export interface AuthProvider {
	login(params: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
	logout(): Promise<void>;
	check(): Promise<boolean>;
	getIdentity(): Promise<Identity | null>;
}

export type NotificationKind = 'success' | 'error' | 'info';

/** Toast/notification sink, wired by the app (e.g. to a toast store). */
export interface Notifier {
	notify(kind: NotificationKind, message: string): void;
}
