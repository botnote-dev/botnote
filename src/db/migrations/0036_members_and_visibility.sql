-- Several people in one workspace.
--
-- A project has an owner and is either private (owner only) or shared (every
-- member). Content outside a project belongs to its author. Invite links let
-- an admin add people without email.
--
-- Expand-only: 0.2.x code ignores the new columns. Rows written by an older
-- daemon after this migration have no owner or author; they stay readable in
-- single-user mode and are claimed for the owner the next time this backfill
-- logic runs at owner creation (src/service/users.ts).

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS author_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS entities_author_no_project_idx
  ON entities (author_user_id)
  WHERE project_id IS NULL;

CREATE TABLE IF NOT EXISTS workspace_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  email text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_invites_token_hash_idx
  ON workspace_invites (token_hash);

-- An instance that already has an owner: everything that exists is theirs.
-- Projects stay private until the owner shares them.
UPDATE projects p
SET owner_user_id = m.user_id,
    updated_at = p.updated_at + interval '1 microsecond'
FROM workspace_members m
WHERE m.workspace_id = p.workspace_id
  AND m.role = 'owner'
  AND p.owner_user_id IS NULL;

-- Shifting updated_at by a microsecond keeps the touch trigger (0032) from
-- stamping now() on every entity.
UPDATE entities e
SET author_user_id = m.user_id,
    updated_at = e.updated_at + interval '1 microsecond'
FROM workspace_members m
WHERE m.workspace_id = e.workspace_id
  AND m.role = 'owner'
  AND e.author_user_id IS NULL;
