/** Copy this file to rebrand the login panel: name, mark, background, copy. */
import * as m from '#lib/paraglide/messages.js';

export const loginBrand = {
	name: 'Banto',
	/** Optional image URL. When unset the built-in lantern mark is drawn. */
	markUrl: '',
	tagline: () => m['auth.tagline'](),
	/** Shown before sign-in, including over LAN. False hides it from the screen, not the JS bundle. */
	showVersion: true,
	/** Decorative brand surface: the only app-level literal colours here (conventions §9). */
	background:
		'radial-gradient(60% 80% at 20% 20%, color-mix(in srgb, var(--banto-primary) 28%, transparent), transparent), radial-gradient(50% 60% at 80% 90%, rgb(237 106 52 / 0.18), transparent), conic-gradient(from 210deg at 60% 40%, #171c26, #10131a)',
	/** Choose with background so the brand text keeps enough contrast. */
	foreground: '#fff'
};
