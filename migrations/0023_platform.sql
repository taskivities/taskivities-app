-- On the SleekSite platform (worker/platform.ts): each controller token is used once; remembered until it expires.
CREATE TABLE IF NOT EXISTS platform_jti (jti TEXT PRIMARY KEY, exp INTEGER NOT NULL);
