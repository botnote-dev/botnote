-- The language agents write tasks, notes and worklog in. NULL leaves the
-- choice to the agent, as before.
--
-- Expand-only: older code ignores the column.

ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS content_language text;
