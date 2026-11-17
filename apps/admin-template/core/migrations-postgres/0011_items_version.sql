-- PostgreSQL twin of migrations-sqlite/0011_items_version.sql (Issue #638):
-- the items row version for optimistic locking. BIGINT like the other
-- integer columns of items (0001_items.sql), so sqlx decodes it into `i64`.
ALTER TABLE items ADD COLUMN version BIGINT NOT NULL DEFAULT 1;
