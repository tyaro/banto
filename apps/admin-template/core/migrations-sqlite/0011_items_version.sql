-- Optimistic locking for items (Issue #638): a row version the update and
-- delete paths compare against the one the client last read. Every existing
-- row starts at 1; each update (form, grid, CSV import) bumps it by one. A
-- request without a version keeps the old last-write-wins behavior.
ALTER TABLE items ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
