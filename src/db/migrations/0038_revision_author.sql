-- Who made each edit. A revision already records the token it came through;
-- this records the person, so history reads "Ada" instead of a token name.
--
-- Expand-only: older code ignores the column.

ALTER TABLE entity_revisions
  ADD COLUMN IF NOT EXISTS author_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

-- Edits made through a token belong to the token's owner.
UPDATE entity_revisions r
SET author_user_id = t.user_id
FROM tokens t
WHERE t.id = r.actor_token_id
  AND r.author_user_id IS NULL
  AND t.user_id IS NOT NULL;

-- The rest are only attributed where there is no doubt: an instance with one
-- person.
UPDATE entity_revisions r
SET author_user_id = m.user_id
FROM entities e
JOIN workspace_members m ON m.workspace_id = e.workspace_id
WHERE e.id = r.entity_id
  AND r.author_user_id IS NULL
  AND (SELECT count(*) FROM workspace_members x WHERE x.workspace_id = e.workspace_id) = 1;
