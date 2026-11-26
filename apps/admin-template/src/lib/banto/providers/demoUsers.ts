/**
 * Read-only sample users for the plain-browser demo (Issue #712, conventions
 * §10). Only `usersAdmin.ts` imports this, and only in `demo` mode: there is
 * no account database there, so the users screen shows these fixed rows
 * instead of an "unavailable" dead end. Writes stay refused (`DEMO_MODE_MESSAGE`).
 *
 * Fixed values, no randomness: the screen and its visual baselines stay stable.
 */
import type { UserSummary } from '../usersAdmin';

export const DEMO_USERS: readonly UserSummary[] = [
	{
		id: 1,
		username: 'admin',
		displayName: '管理者',
		role: 'admin',
		kind: 'builtin',
		createdAt: '2026-01-05T09:00:00Z',
		version: 1,
		permissions: []
	},
	{
		id: 2,
		username: 'sato',
		displayName: '佐藤 花子',
		role: 'admin',
		kind: 'account',
		createdAt: '2026-01-06T09:30:00Z',
		version: 1,
		permissions: []
	},
	{
		id: 3,
		username: 'suzuki',
		displayName: '鈴木 一郎',
		role: 'editor',
		kind: 'account',
		createdAt: '2026-02-12T10:15:00Z',
		version: 2,
		permissions: []
	},
	{
		id: 4,
		username: 'tanaka',
		displayName: '田中 美咲',
		role: 'editor',
		kind: 'account',
		createdAt: '2026-03-03T13:40:00Z',
		version: 1,
		permissions: []
	},
	{
		id: 5,
		username: 'ito',
		displayName: '伊藤 健',
		role: 'viewer',
		kind: 'account',
		createdAt: '2026-04-20T08:05:00Z',
		version: 1,
		permissions: []
	}
];
