-- Config drafts: edit a draft, publish it, go back to an earlier version
-- (Issue #938, docs/design/config-draft-publish-design.md §4.5). Optional:
-- `pnpm scaffold --preset minimal|display` removes this file with the wiring.
--
-- The JSON values are TEXT (the `serde_json` string) in both backends, so
-- the database never reorders fields or rewrites numbers. The tests of
-- `banto-admin-services` (`config_drafts/tests.rs` `DDL`) and of
-- `banto-server` (`routes/config_drafts/tests.rs` `DDL`) re-state these
-- tables and MUST be kept in sync with this file.
--
-- One row per target: the JSON the app runs on. `ensure_targets` inserts it
-- at version 0 and nothing deletes it. `revision` is a random string made on
-- every write (not a counter: a restored backup must not make an old
-- revision match).
CREATE TABLE config_published (
    target       TEXT PRIMARY KEY,
    value        TEXT NOT NULL,
    version      INTEGER NOT NULL,
    revision     TEXT NOT NULL,
    published_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per version; `value` is the published value OF that version, so
-- "before / after" of version N is the rows N-1 and N. Append only.
-- `kind` is 'initial' | 'publish' | 'revert'; `reverted_to` is set for a
-- revert. `actor_id` is NOT a foreign key (the row outlives the account,
-- like audit_log). `origin` is 'rest' | 'tauri'; the 'initial' row has no
-- actor and no origin.
CREATE TABLE config_history (
    target         TEXT NOT NULL,
    version        INTEGER NOT NULL,
    value          TEXT NOT NULL,
    kind           TEXT NOT NULL,
    reverted_to    INTEGER,
    actor_username TEXT,
    actor_id       INTEGER,
    actor_kind     TEXT,
    origin         TEXT,
    comment        TEXT,
    published_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (target, version)
);

-- At most one draft per target; a publish or a discard removes it.
-- `updated_by` is a display name (a snapshot).
CREATE TABLE config_drafts (
    target       TEXT PRIMARY KEY,
    value        TEXT NOT NULL,
    base_version INTEGER NOT NULL,
    revision     TEXT NOT NULL,
    updated_by   TEXT NOT NULL,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
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
    acquired_at_ms INTEGER NOT NULL,
    expires_at_ms  INTEGER NOT NULL
);
