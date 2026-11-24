-- People who sign in (BOT-206, first step of multi-user BOT-185).
--
-- Expand only. Until the first user is created the daemon keeps working as
-- before: BOTNOTE_PASSWORD logs in and sessions carry no user. The first
-- account created through /v1/auth/setup becomes the workspace owner; from
-- then on login is by email and password.
-- Emails are stored lowercased by the service, so the unique index is plain.

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  password_hash text,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email);

DROP TRIGGER IF EXISTS users_touch_updated_at ON users;
CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION botnote_touch_updated_at();

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_one_owner_idx
  ON workspace_members (workspace_id)
  WHERE role = 'owner';
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members (user_id);

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE tokens
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
