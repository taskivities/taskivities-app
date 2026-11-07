-- Admins who connect Outlook (Settings → Invite emails) so invites are emailed from their own Microsoft 365 mailbox.
-- Same shape as google_tokens (0005). Only Mail.Send is asked for: the app can send mail as them, never read it.
-- refresh_token is encrypted (AES-GCM, see worker/token-crypto.ts). Microsoft has no revoke endpoint for one token, so
-- disconnecting deletes the row; the person can also remove the app at myapplications.microsoft.com.
-- An admin has at most one invite-mail connection: connecting Outlook removes their Gmail one, and the other way round.
CREATE TABLE IF NOT EXISTS microsoft_tokens (
  user_id       TEXT PRIMARY KEY REFERENCES users (id),
  email         TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  scope         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
