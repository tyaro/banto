-- PostgreSQL port of migrations-sqlite/0016_config_drafts.sql (see that file
-- for the why). Type mapping:
--   INTEGER -> BIGINT;
--   DEFAULT (datetime('now')) -> DEFAULT (now()::text) (see 0003).
-- `banto-admin-services`' `config_drafts/cases.rs` `PG_DDL` re-states these
-- tables and MUST be kept in sync with this file.
--
-- One row per target: the JSON the app runs on.
CREATE TABLE config_published (
    target       TEXT PRIMARY KEY,
    value        TEXT NOT NULL,
    version      BIGINT NOT NULL,
    revision     TEXT NOT NULL,
    published_at TEXT NOT NULL DEFAULT (now()::text)
);

-- One row per version; `value` is the published value OF that version, so
-- "before / after" of version N is the rows N-1 and N. Append only.
-- `kind` is 'initial' | 'publish' | 'revert'; `reverted_to` is set for a
-- revert. `actor_id` is NOT a foreign key (the row outlives the account,
-- like audit_log). `origin` is 'rest' | 'tauri'; the 'initial' row has no
-- actor and no origin.
CREATE TABLE config_history (
    target         TEXT NOT NULL,
    version        BIGINT NOT NULL,
    value          TEXT NOT NULL,
    kind           TEXT NOT NULL,
    reverted_to    BIGINT,
    actor_username TEXT,
    actor_id       BIGINT,
    actor_kind     TEXT,
    origin         TEXT,
    comment        TEXT,
    published_at   TEXT NOT NULL DEFAULT (now()::text),
    PRIMARY KEY (target, version)
);

-- At most one draft per target; a publish or a discard removes it.
-- `updated_by` is a display name (a snapshot).
CREATE TABLE config_drafts (
    target       TEXT PRIMARY KEY,
    value        TEXT NOT NULL,
    base_version BIGINT NOT NULL,
    revision     TEXT NOT NULL,
    updated_by   TEXT NOT NULL,
    updated_at   TEXT NOT NULL DEFAULT (now()::text)
);

-- At most one edit lock per target; a row past `expires_at_ms` (Unix
-- milliseconds, the service's clock) is the same as no row. `holder` is
-- 'acct:<users.id>' | 'grant:<kind>' | 'local'; `lease` is a random string
-- made on every acquire.
CREATE TABLE config_locks (
    target         TEXT PRIMARY KEY,
    holder         TEXT NOT NULL,
    holder_name    TEXT NOT NULL,
    lease          TEXT NOT NULL,
    acquired_at_ms BIGINT NOT NULL,
    expires_at_ms  BIGINT NOT NULL
);
