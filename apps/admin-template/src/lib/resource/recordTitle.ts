/**
 * The one-line name of a record where a list is not at hand (the palette's
 * record search and recent records, #711). The definition's `recordTitle`
 * wins; otherwise the first non-empty text among `name` / `title` / `label`,
 * then `#<id>`.
 */
import type { AppResourceDefinition, ResourceRow } from './types';

const TITLE_FIELDS = ['name', 'title', 'label'] as const;

export function recordTitle(
	definition: Pick<AppResourceDefinition, 'recordTitle'>,
	row: ResourceRow
): string {
	const custom = definition.recordTitle?.(row)?.trim();
	if (custom) return custom;
	for (const field of TITLE_FIELDS) {
		const value = row[field];
		if (typeof value === 'string' && value.trim() !== '') return value.trim();
	}
	return `#${row.id}`;
}
