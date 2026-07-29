-- M20: generic file/image attachments (spec docs/attachments-plan.md §3.2).
-- Owned by the app (like every other migration in this directory), while the
-- CRUD/storage/thumbnail logic itself lives in the resource-agnostic
-- `banto-attachments` crate - the crate documents this schema as the
-- contract it requires rather than owning the migration file itself.
--
-- Deliberately NOT added to `backup.rs`'s `REQUIRED_TABLES`: an older backup
-- taken before this migration existed must still be restorable (spec
-- §3.2 "attachments を持たない古いバックアップのリストアを塞がないため").
CREATE TABLE attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  resource      TEXT    NOT NULL,           -- e.g. 'items'
  resource_id   TEXT    NOT NULL,           -- TEXT for resource-agnosticism; items stringifies its i64 id
  file_name     TEXT    NOT NULL,           -- original display name; never used to build a filesystem path
  mime          TEXT    NOT NULL,           -- normalized from magic-byte detection, not client-supplied
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT    NOT NULL,           -- integrity check / future dedup use
  has_thumbnail INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL,           -- ISO 8601 UTC, e.g. "2026-07-15T12:34:56Z"
  created_by    TEXT                        -- username snapshot, display only (audit already owns the real trail)
);
CREATE INDEX idx_attachments_record ON attachments(resource, resource_id);
