-- Sign-in codes sent by email (worker/auth.ts, "Sign in with an email code"). One row per code asked for, whether or
-- not that address has access (so asking says nothing about who's on the team); only addresses with access are emailed.
-- The code itself isn't stored, only a hash with the row's id. The id is also kept in a cookie in the browser that
-- asked, so a code only works there. Rows past their day are deleted when new codes are asked for.
CREATE TABLE login_codes (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  ip         TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX login_codes_email ON login_codes (email, created_at);
CREATE INDEX login_codes_ip ON login_codes (ip, created_at);
