-- PostgreSQL twin of migrations-sqlite/0013_user_permissions.sql (Issue #697,
-- docs/design/user-permissions-plan.md §4): per-user permissions, separate
-- from the role. `user_id` is BIGINT to match `users.id` (an identity
-- column). `granted_at` stays TEXT with `DEFAULT (now()::text)` like every
-- other time column here (see 0003_users.sql: the app decodes them into
-- `String`).
CREATE TABLE user_permissions (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT   NOT NULL,
    granted_by TEXT   NOT NULL,
    granted_at TEXT   NOT NULL DEFAULT (now()::text),
    PRIMARY KEY (user_id, permission)
);
CREATE INDEX idx_user_permissions_permission ON user_permissions (permission);
