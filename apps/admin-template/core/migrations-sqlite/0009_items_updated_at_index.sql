-- SQLite twin of migrations-postgres/0009_items_updated_at_index.sql: an
-- index for the period filter (`between`) on items.updated_at. SQLite's
-- default BINARY collation already compares text in code-unit order, so the
-- plain column index serves `updated_at >= ? AND updated_at < ?`.
CREATE INDEX idx_items_updated_at ON items(updated_at);
