-- Connecting instances: show the tasks you have on other Taskivities instances in your own (worker/feed.ts).
--
-- On the instance whose tasks are shared: a person makes an access token (account menu → Other instances). Only a
-- SHA-256 of it is kept. It lets whoever holds it read and change that person's own tasks (the ones assigned to
-- them): mark done, move, priority, notes, checklist, comments. Revoking it ends that at once.
CREATE TABLE access_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id),
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX access_tokens_user ON access_tokens (user_id);

-- On the instance that shows them: the other instances someone added, with their token (encrypted, AES-GCM).
CREATE TABLE feeds (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id),
  url         TEXT NOT NULL,      -- the other instance's origin, e.g. https://work.example.com
  token       TEXT NOT NULL,      -- encrypted access token
  name        TEXT NOT NULL,      -- that instance's name, as it calls itself
  remote_user TEXT NOT NULL,      -- JSON: who the token belongs to there ({ id, name, email })
  color       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  last_ok_at  TEXT,
  last_error  TEXT
);
CREATE INDEX feeds_user ON feeds (user_id);

-- Request and approve (instead of copying a token): the instance that will show your tasks sends you to this one,
-- with where to come back to. You approve here; it comes back with a one-time code (good for 10 minutes) and swaps
-- it, server to server, for an access token like one you'd make yourself.
CREATE TABLE connect_codes (
  code_hash     TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id),
  name          TEXT NOT NULL,     -- what the other instance calls itself, for the token's name
  return_origin TEXT NOT NULL,     -- the only place the code can be swapped from
  created_at    TEXT NOT NULL
);
-- On the asking side: requests in flight, so an answer is only taken for a request you started.
CREATE TABLE connect_states (
  state      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id),
  url        TEXT NOT NULL,
  created_at TEXT NOT NULL
);
