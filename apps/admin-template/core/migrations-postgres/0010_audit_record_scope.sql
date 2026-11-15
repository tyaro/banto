-- Indexed record scope for direct audit rows and related rows such as attachments.
-- Keep older PostgreSQL versions usable: a small immutable parser catches
-- malformed historical detail and accepts only a complete parent pair.
CREATE FUNCTION banto_audit_parent_detail(raw_detail TEXT, field_name TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE parsed JSONB;
BEGIN
  parsed := raw_detail::jsonb;
  IF jsonb_typeof(parsed -> 'parentResource') = 'string'
     AND jsonb_typeof(parsed -> 'parentId') IN ('string', 'number') THEN
    RETURN parsed ->> field_name;
  END IF;
  RETURN NULL;
EXCEPTION WHEN invalid_text_representation THEN
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
