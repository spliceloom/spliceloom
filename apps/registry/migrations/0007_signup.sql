-- Self-service sign-up: a publisher proves control of a GitHub account by putting a one-time code
-- in the description of a public gist. The account then owns the namespace named after its login.

-- GitHub login (lowercase) of accounts created by sign-up; NULL for accounts created by an admin.
-- A sign-up can only ever act on the account that carries its own login.
ALTER TABLE users ADD COLUMN github_login TEXT;
CREATE UNIQUE INDEX users_github_login ON users(github_login) WHERE github_login IS NOT NULL;

-- Pending challenges. Short-lived; removed when used or expired.
CREATE TABLE signup_challenges (
  code TEXT PRIMARY KEY,
  github_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX signup_challenges_expires ON signup_challenges(expires_at);
