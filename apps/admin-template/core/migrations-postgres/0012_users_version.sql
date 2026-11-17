-- PostgreSQL twin of migrations-sqlite/0012_users_version.sql (Issue #651):
-- the users row version for optimistic locking. BIGINT like `auth_epoch`
-- (0007_user_auth_epoch.sql), so sqlx decodes it into `i64`.
ALTER TABLE users ADD COLUMN version BIGINT NOT NULL DEFAULT 1;
