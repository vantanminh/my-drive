ALTER TABLE users
    ADD COLUMN managed_by UUID NULL REFERENCES users(id) ON DELETE RESTRICT,
    ADD COLUMN quota_bytes BIGINT NULL CHECK (quota_bytes IS NULL OR quota_bytes >= 0),
    ADD COLUMN disabled_at TIMESTAMPTZ NULL,
    ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users
    ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'admin', 'member')),
    ADD CONSTRAINT users_account_manager_check
        CHECK ((role = 'member') = (managed_by IS NOT NULL)),
    ADD CONSTRAINT users_member_quota_check
        CHECK (role <> 'member' OR quota_bytes IS NOT NULL),
    ADD CONSTRAINT users_manager_not_self_check
        CHECK (managed_by IS NULL OR managed_by <> id);

CREATE INDEX users_managed_accounts_idx
    ON users (managed_by, created_at DESC, id)
    WHERE role = 'member';

CREATE FUNCTION validate_member_manager() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    manager_role TEXT;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.role = 'owner' AND NEW.role <> 'owner'
       AND EXISTS (SELECT 1 FROM users WHERE managed_by = OLD.id AND role = 'member') THEN
        RAISE EXCEPTION 'an owner with managed member accounts cannot be demoted'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.role = 'member' THEN
        SELECT role INTO manager_role FROM users WHERE id = NEW.managed_by FOR SHARE;
        IF manager_role IS DISTINCT FROM 'owner' THEN
            RAISE EXCEPTION 'member accounts must be managed by an owner'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_member_manager_guard
    BEFORE INSERT OR UPDATE OF role, managed_by ON users
    FOR EACH ROW EXECUTE FUNCTION validate_member_manager();
