// Puts the demo back to the sample in seed/dev.sql. Runs on the demo's Cron Trigger and before the first sign-in
// on an empty database. Everyone is signed out (sessions are emptied too), since what they were looking at is gone.
import seedSql from '../seed/dev.sql?raw';
import type { Env } from '../worker/lib';

// Children before parents, so foreign keys never block a delete.
const TABLES = [
  'task_events', 'task_followers', 'checklist_items', 'attachments', 'upload_links',
  'webhook_keys', 'webhook_requests', 'webhooks',
  'tasks', 'series', 'project_members',
  'google_tokens', 'push_subscriptions', 'sessions', 'settings', 'audit_log',
  'access_tokens', 'feeds', 'connect_codes', 'connect_states',
  'projects', 'users',
];

// task_events is append-only: these triggers (migration 0001) refuse deletes, so the reset lifts them and puts them back.
const TRIGGERS = [
  "CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END",
  "CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END",
];

/** The seed file as separate statements (each statement ends with ";" at the end of a line). */
function seedStatements(): string[] {
  const body = seedSql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  return body.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
}

/** One D1 batch, so it all happens or none of it does. */
export async function resetDemo(env: Env) {
  const db = env.DB;
  await db.batch([
    db.prepare('DROP TRIGGER IF EXISTS task_events_no_update'),
    db.prepare('DROP TRIGGER IF EXISTS task_events_no_delete'),
    ...TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)),
    ...TRIGGERS.map((sql) => db.prepare(sql)),
    ...seedStatements().map((sql) => db.prepare(sql)),
    db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'directory_version'"),
  ]);
}

/** A new demo starts with an empty database: load the sample before the first sign-in. */
export async function ensureDemoData(env: Env) {
  if (!(await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first())) await resetDemo(env);
}
