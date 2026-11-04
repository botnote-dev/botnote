-- A KEY-SEQ number belongs to the project that issued it. The sequence
-- trigger used to fire on INSERT only, so moving an entity to another project
-- carried its old number along: SRC-5 became DST-5 (failing outright when
-- DST-5 already existed), DST's counter stayed behind so a later insert could
-- be handed the same number, an entity moved in from workspace scope never got
-- a number, and one moved out kept a stale number.
--
-- The trigger now also fires on UPDATE OF project_id and gives a moved entity
-- a fresh number from the destination's counter, or clears it when the entity
-- leaves its project. The INSERT path is unchanged, so imports that carry
-- explicit sequence ids behave exactly as before.
--
-- The repair never renumbers a key that is visible today: people quote keys
-- like BOT-157 in commits and notes. It only clears numbers on project-less
-- rows (which display a uuid-prefix label anyway), pushes every counter past
-- the highest number in its project, and numbers project rows that have none.
-- Idempotent; runs inside the migration transaction.

CREATE OR REPLACE FUNCTION botnote_set_sequence_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.kind IN ('worklog', 'comment') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- UPDATE OF project_id fires even when the value is unchanged.
    IF NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN
      RETURN NEW;
    END IF;
    IF NEW.project_id IS NULL THEN
      NEW.sequence_id := NULL;
      RETURN NEW;
    END IF;
    -- A number carried over from the old project is stale. One the statement
    -- set explicitly (a repair) is honored below.
    IF NEW.sequence_id IS NOT DISTINCT FROM OLD.sequence_id THEN
      NEW.sequence_id := NULL;
    END IF;
  ELSIF NEW.project_id IS NULL THEN
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

DROP TRIGGER IF EXISTS entities_set_sequence_id ON entities;
CREATE TRIGGER entities_set_sequence_id
  BEFORE INSERT OR UPDATE OF project_id ON entities
  FOR EACH ROW EXECUTE FUNCTION botnote_set_sequence_id();

-- The repair is bookkeeping, not an edit: keep updated_at so repaired rows
-- and projects do not jump to the top of "recent".
ALTER TABLE entities DISABLE TRIGGER entities_touch_updated_at;
ALTER TABLE projects DISABLE TRIGGER projects_touch_updated_at;

UPDATE entities
SET sequence_id = NULL
WHERE project_id IS NULL AND sequence_id IS NOT NULL;

UPDATE projects p
SET next_seq = m.max_seq + 1
FROM (
  SELECT project_id, MAX(sequence_id) AS max_seq
  FROM entities
  WHERE project_id IS NOT NULL AND sequence_id IS NOT NULL
  GROUP BY project_id
) m
WHERE p.id = m.project_id AND p.next_seq <= m.max_seq;

WITH unnumbered AS (
  SELECT
    e.id,
    p.next_seq - 1 + ROW_NUMBER() OVER (PARTITION BY e.project_id ORDER BY e.created_at, e.id) AS seq
  FROM entities e
  JOIN projects p ON p.id = e.project_id
  WHERE e.sequence_id IS NULL AND e.kind NOT IN ('worklog', 'comment')
)
UPDATE entities e
SET sequence_id = u.seq
FROM unnumbered u
WHERE e.id = u.id;

UPDATE projects p
SET next_seq = m.max_seq + 1
FROM (
  SELECT project_id, MAX(sequence_id) AS max_seq
  FROM entities
  WHERE project_id IS NOT NULL AND sequence_id IS NOT NULL
  GROUP BY project_id
) m
WHERE p.id = m.project_id AND p.next_seq <= m.max_seq;

ALTER TABLE projects ENABLE TRIGGER projects_touch_updated_at;
ALTER TABLE entities ENABLE TRIGGER entities_touch_updated_at;
