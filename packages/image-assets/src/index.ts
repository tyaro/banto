/**
 * Public entry point for @banto/image-assets (ADR-0020, shared-primitives-upstream-plan §3.7).
 * Browser-side image originals, import checks and object URL lifetimes, with no dependencies
 * and no display text (errors are codes, conventions §13).
 *
 * PR-12 (this skeleton) ships the shared ground: the formats, the consumer-supplied limits
 * and their validation, and the error codes. The import checks and the hash (PR-13) and the
 * store of originals with object URL lifetimes (PR-14) build on these.
 */
export {
	IMAGE_FORMATS,
	validateImageImportLimits,
	type ImageFormat,
	type ImageImportLimits
} from './limits';
export {
	IMAGE_ASSET_ERROR_CODES,
	ImageAssetError,
	isImageAssetError,
	type ImageAssetErrorCode,
	type ImageAssetErrorDetail
} from './errors';
