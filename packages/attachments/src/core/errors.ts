/**
 * Extracts a display message from whatever `AttachmentsClient` rejected
 * with. The panel is transport-agnostic (spec §3.7) so it never imports
 * `@banto/admin-core`'s `ProviderError` - it only duck-types the
 * `{ message: string }` shape every error the app-side client can throw
 * already has (`ProviderError`, a plain `Error`, or anything else).
 */
export function errorMessage(err: unknown): string {
	if (
		err &&
		typeof err === 'object' &&
		'message' in err &&
		typeof (err as { message: unknown }).message === 'string'
	) {
		return (err as { message: string }).message;
	}
	if (typeof err === 'string') return err;
	return '不明なエラーが発生しました';
}
