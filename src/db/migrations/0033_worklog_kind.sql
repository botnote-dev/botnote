-- Rename the 'comment' entity kind to 'worklog', matching what the UI, MCP
-- tools and CLI call these append-only progress entries.
--
-- The touch trigger is paused for the rename so entries keep their original
-- updated_at instead of all jumping to the top of "recent". The sequence
-- trigger skips both names so a rolled-back daemon that still writes
-- kind='comment' never hands its log lines a KEY-SEQ number.
-- Idempotent; runs inside the migration transaction.

ALTER TABLE entities DISABLE TRIGGER entities_touch_updated_at;
UPDATE entities SET kind = 'worklog' WHERE kind = 'comment';
ALTER TABLE entities ENABLE TRIGGER entities_touch_updated_at;

CREATE OR REPLACE FUNCTION botnote_set_sequence_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.project_id IS NULL OR NEW.kind IN ('worklog', 'comment') THEN
    RETURN NEW;
  END IF;

  IF NEW.sequence_id IS NULL THEN
    UPDATE projects
    SET next_seq = next_seq + 1
    WHERE id = NEW.project_id
    RETURNING next_seq - 1 INTO NEW.sequence_id;
  ELSE
    -- An explicit sequence id (imports, repairs) must never leave the
    -- counter behind it, or the next auto-assigned id would collide.
    UPDATE projects
    SET next_seq = GREATEST(next_seq, NEW.sequence_id + 1)
    WHERE id = NEW.project_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP INDEX IF EXISTS entities_comment_parent_created_idx;

-- Fast "latest worklog entry per task" lookups for the opening brief.
CREATE INDEX IF NOT EXISTS entities_worklog_parent_created_idx
  ON entities(parent_id, created_at DESC) WHERE kind = 'worklog';
