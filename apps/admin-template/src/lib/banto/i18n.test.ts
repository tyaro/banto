import { afterEach, describe, expect, it } from 'vitest';
import { overwriteGetLocale, type Locale } from '#lib/paraglide/runtime.js';
import { formatCount, gridMessages } from './i18n.js';

const use = (l: Locale) => overwriteGetLocale(() => l);

describe('count digit grouping follows the display language (#1016)', () => {
	afterEach(() => use('en'));

	it('groups by the app locale, not the device locale', () => {
		use('en');
		expect(formatCount(1000)).toBe('1,000');
		expect(gridMessages().selectAllMatching?.(1000)).toContain('1,000');
		use('ja');
		expect(formatCount(1000)).toBe('1,000');
		expect(gridMessages().selectAllLoadedRows?.(1, 1000)).toContain('1,000');
		expect(gridMessages().selectionStatus?.(1000)).toContain('1,000');
	});
});
