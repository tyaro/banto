/**
 * Command palette (Ctrl+K / Cmd+K) command definitions (spec M16).
 *
 * `buildCommands()` derives one navigation command per `navItems` entry
 * (navigation.ts) - a page just needs an entry there to show up in the
 * palette too, no separate registration step - plus hand-written theme
 * (M12 settings API) and session (logout) commands. RBAC gating for nav
 * entries mirrors Sidebar.svelte's `visibleItems` condition exactly.
 *
 * Recency (spec M16: "最近使ったコマンドの並び上げ"; per signed-in user,
 * Issue #258) lives in `./recentCommands.ts`.
 */
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import * as m from '#lib/paraglide/messages.js';
import type { PaletteCommand } from '@banto/admin-core';
import { logoutAndLeave } from './banto/logout.svelte';
import { notifyLogoutOutcome } from './banto/logoutNotice';
import { navItems, resolveAppPath } from './navigation';
import { settings } from './settings.svelte';
import { sessionStore } from './session.svelte';
import { isAdmin } from './permissions';

function navigationCommands(): PaletteCommand[] {
	return navItems.map((item) => ({
		id: `nav.${item.path}`,
		title: m[item.labelKey](),
		group: m['commandPalette.groupNavigation'](),
		keywords: [item.path],
		// Spec M10 RBAC: same condition as Sidebar.svelte's `visibleItems`
		// (adminOnly entries hidden from non-admin roles).
		visible: item.adminOnly ? () => isAdmin(sessionStore.role) : undefined,
		run: () => {
			void goto(resolveAppPath(item.path));
		}
	}));
}

function themeCommands(): PaletteCommand[] {
	const themeGroup = m['commandPalette.groupTheme']();
	return [
		{
			id: 'theme.mode.light',
			title: m['commandPalette.themeLight'](),
			group: themeGroup,
			keywords: ['light', 'theme', '明るい'],
			run: () => settings.setThemeMode('light')
		},
		{
			id: 'theme.mode.dark',
			title: m['commandPalette.themeDark'](),
			group: themeGroup,
			keywords: ['dark', 'theme', '暗い'],
			run: () => settings.setThemeMode('dark')
		},
		{
			id: 'theme.mode.system',
			title: m['commandPalette.themeSystem'](),
			group: themeGroup,
			keywords: ['system', 'theme'],
			run: () => settings.setThemeMode('system')
		},
		{
			id: 'theme.preset.standard',
			title: m['commandPalette.presetStandard'](),
			group: themeGroup,
			keywords: ['standard', 'preset'],
			run: () => settings.setThemePreset('standard')
		},
		{
			id: 'theme.preset.glass',
			title: m['commandPalette.presetGlass'](),
			group: themeGroup,
			keywords: ['glass', 'preset'],
			run: () => settings.setThemePreset('glass')
		}
	];
}

function sessionCommands(): PaletteCommand[] {
	return [
		{
			id: 'session.logout',
			title: m['shell.logout'](),
			group: m['commandPalette.groupSession'](),
			keywords: ['logout', 'sign out'],
			// Same condition as Header.svelte's logout button: hidden in
			// login-not-required mode (spec M11 - there's no session to end).
			visible: () => !sessionStore.authDisabled,
			run: async () => {
				// Issue #215/#255, #260: same as Header.svelte's logout.
				await logoutAndLeave(() => goto(resolve(`login`)), { notify: notifyLogoutOutcome });
			}
		}
	];
}

/** All palette commands, in a fixed order (navigation, then theme, then session) - `searchCommands` re-sorts/filters this for display. */
export function buildCommands(): PaletteCommand[] {
	return [...navigationCommands(), ...themeCommands(), ...sessionCommands()];
}
