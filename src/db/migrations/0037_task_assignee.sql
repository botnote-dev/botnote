-- Whose task it is. Unassigned is allowed. A task belongs to its creator
-- until someone assigns it to another member who can see it.
--
-- Expand-only: older code ignores the column.

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS entities_assignee_idx
  ON entities (assignee_user_id)
  WHERE kind = 'task' AND deleted_at IS NULL;

-- Existing tasks belong to whoever wrote them. The microsecond shift keeps
-- the touch trigger (0032) from stamping now() on every task.
UPDATE entities
SET assignee_user_id = author_user_id,
    updated_at = updated_at + interval '1 microsecond'
WHERE kind = 'task'
  AND assignee_user_id IS NULL
  AND author_user_id IS NOT NULL;
