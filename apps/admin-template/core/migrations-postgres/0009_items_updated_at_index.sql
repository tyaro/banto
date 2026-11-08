-- An index for the period filter (`between`) on items.updated_at.
--
-- banto-storage's PostgreSQL `between` compares
-- `CAST(col AS TEXT) COLLATE "C" >= $1 AND CAST(col AS TEXT) COLLATE "C" < $2`
-- (date-time-pickers §5.9) so the order matches the grid's JS string
-- comparison whatever the database collation is. A plain index on the column
-- cannot serve that expression, so this one is built on exactly the same
-- expression. A derived app with its own date column filtered by period
-- adds the same kind of index (docs/upgrading.md "期間の絞り込み").
CREATE INDEX idx_items_updated_at ON items ((CAST(updated_at AS TEXT) COLLATE "C"));
