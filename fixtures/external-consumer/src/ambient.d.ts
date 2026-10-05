// TypeScript 6 checks side-effect imports (`noUncheckedSideEffectImports` is
// on by default) and a stylesheet has no type declarations. Vite resolves
// `@banto/theme/css` (the subpath export this fixture exercises) at dev/build
// time; this only tells the type checker the import is intentional.
declare module '@banto/theme/css';
