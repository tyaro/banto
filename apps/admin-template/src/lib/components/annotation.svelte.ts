/**
 * Open state shared by `AnnotationButton` (in a PageHeader's actions) and
 * `AnnotationDrawer` (at the page root). They are apart on purpose: PageHeader
 * has a `view-transition-name`, which makes it the containing block of fixed
 * descendants, and Drawer does not portal - drawn inside the header it would
 * be squeezed into the header's height (Issue #553, PR #565 review).
 */
export const annotation = $state({ open: false });
