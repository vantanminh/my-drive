ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_workspace_service BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_manager_check;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_member_quota_check;

ALTER TABLE users
    ADD CONSTRAINT users_account_manager_check
        CHECK (
            (role = 'owner' AND managed_by IS NULL AND is_workspace_service = FALSE)
            OR (role IN ('admin', 'member') AND (managed_by IS NOT NULL OR role = 'admin'))
        ),
    ADD CONSTRAINT users_member_quota_check
        CHECK (managed_by IS NULL OR quota_bytes IS NOT NULL);

DROP INDEX IF EXISTS users_managed_accounts_idx;
CREATE INDEX users_managed_accounts_idx
    ON users (managed_by, created_at DESC, id)
    WHERE managed_by IS NOT NULL AND is_workspace_service = FALSE;

CREATE OR REPLACE FUNCTION validate_member_manager() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    manager_role TEXT;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.role = 'owner' AND NEW.role <> 'owner'
       AND EXISTS (
           SELECT 1 FROM users WHERE managed_by = OLD.id AND is_workspace_service = FALSE
       ) THEN
        RAISE EXCEPTION 'an owner with managed accounts cannot be demoted'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.managed_by IS NOT NULL THEN
        SELECT role INTO manager_role FROM users WHERE id = NEW.managed_by FOR SHARE;
        IF manager_role IS DISTINCT FROM 'owner' THEN
            RAISE EXCEPTION 'managed accounts must be managed by an owner'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TABLE teams (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    slug TEXT NOT NULL UNIQUE CHECK (char_length(btrim(slug)) BETWEEN 1 AND 96),
    description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
    quota_bytes BIGINT NOT NULL CHECK (quota_bytes >= 0),
    workspace_user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    added_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, user_id)
);

CREATE INDEX team_members_user_idx ON team_members (user_id, created_at DESC);
