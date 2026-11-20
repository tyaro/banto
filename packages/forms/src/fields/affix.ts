import type { FieldDef } from '../types';

/**
 * The `aria-describedby` of a number input that has a `prefix` / `suffix`:
 * the affixes first (so "kg" is read right after the value), then whatever
 * the form passed (help, error). The affix elements are `aria-hidden` in
 * `AffixBox` - hidden from the label's name, still usable as a description.
 */
export function describedByWithAffix(
	def: Pick<FieldDef, 'prefix' | 'suffix'>,
	id: string,
	describedBy: string | undefined
): string | undefined {
	const ids = [
		def.prefix ? `${id}-prefix` : '',
		def.suffix ? `${id}-suffix` : '',
		describedBy ?? ''
	]
		.filter(Boolean)
		.join(' ');
	return ids || undefined;
}
