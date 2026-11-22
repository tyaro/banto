-- PostgreSQL port of migrations-sqlite/0015_auth_mode_defaults.sql. The
-- statements are the same in either backend (see that file for the why).
INSERT INTO settings (key, value)
SELECT 'auth.disabled',
       CASE WHEN EXISTS (SELECT 1 FROM users WHERE kind = 'account') THEN 'false' ELSE 'true' END
WHERE true
ON CONFLICT(key) DO NOTHING;

INSERT INTO settings (key, value) VALUES ('auth.disabled_role', 'admin')
ON CONFLICT(key) DO NOTHING;
