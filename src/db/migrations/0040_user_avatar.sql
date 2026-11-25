-- An optional profile picture per person: a small image the browser has
-- already cropped and resized, stored base64 next to the account.
--
-- Expand-only: older code ignores the columns.

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_type text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;
