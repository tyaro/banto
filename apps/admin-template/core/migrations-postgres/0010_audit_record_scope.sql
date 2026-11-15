-- Indexed record scope for direct audit rows and related rows such as attachments.
-- Keep older PostgreSQL versions usable: a small immutable parser catches
-- malformed historical detail and accepts only a complete parent pair.
CREATE FUNCTION banto_audit_parent_detail(raw_detail TEXT, field_name TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE parsed JSON;
BEGIN
  parsed := raw_detail::json;
  IF json_typeof(parsed -> 'parentResource') = 'string'
     AND json_typeof(parsed -> 'parentId') IN ('string', 'number') THEN
    RETURN parsed ->> field_name;
  END IF;
  RETURN NULL;
-- json keeps escapes in unrelated values (for example fileName with \u0000).
-- An invalid parent value or any parse failure leaves the row directly scoped.
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

ALTER TABLE audit_log ADD COLUMN record_resource TEXT GENERATED ALWAYS AS (
  COALESCE(banto_audit_parent_detail(detail, 'parentResource'), resource)
) STORED;

ALTER TABLE audit_log ADD COLUMN record_id TEXT GENERATED ALWAYS AS (
  COALESCE(banto_audit_parent_detail(detail, 'parentId'), entity_id)
) STORED;

CREATE INDEX idx_audit_log_record_scope ON audit_log(record_resource, record_id);
