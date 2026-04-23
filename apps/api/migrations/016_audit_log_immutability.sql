REVOKE UPDATE, DELETE ON audit_logs FROM app_runtime;

GRANT SELECT, INSERT ON audit_logs TO app_runtime;
