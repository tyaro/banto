import { afterEach, describe, expect, it } from 'vitest';
import * as m from '#lib/paraglide/messages.js';
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
	it('bulk delete confirm and done messages carry the grouped count', () => {
		for (const l of ['en', 'ja'] as const) {
			use(l);
			expect(m['resource.bulkDeleteConfirm']({ count: formatCount(1000) })).toContain('1,000');
			expect(m['resource.bulkDeleteConfirmMatching']({ count: formatCount(1000) })).toContain(
				'1,000'
			);
			expect(m['resource.bulkDeleteDone']({ count: formatCount(1000) })).toContain('1,000');
			expect(m['resource.bulkDeleteTooMany']({ max: formatCount(1000) })).toContain('1,000');
		}
	});
});
