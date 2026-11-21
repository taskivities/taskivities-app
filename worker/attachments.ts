// Task attachments. Files are stored in R2 (binding FILES); the list is in the `attachments` table.
//
// Everything goes through the Worker, so every upload and download checks that the person can see the task.
// Files are served so they can't run code in the app: only images, PDFs and plain text open in the browser
// (with a sandboxing Content-Security-Policy); anything else downloads.
import { Hono } from 'hono';
import { ATTACH_MAX_BYTES, ATTACH_PER_TASK_MAX, type Task } from '../shared/types';
import { type AppEnv, type Env, type Viewer, HttpError, CURRENT_VERSION, bad, bumpVersion, eventStmt, forbidden, loadViewer, mapTask, notFound, nowIso, randomToken, sha256hex, uid } from './lib';
import { STORAGE_FULL, storageFull } from './platform';
import { loadEditableTask, loadTask, loadVisibleTask } from './tasks';

interface AttachmentRow {
  id: string; task_id: string; key: string; name: string; size: number; type: string; uploaded_by: string; uploaded_at: string;
  /** Linked files (worker/cloud-files.ts): no bytes here, key is ''. */
  url: string | null; provider: string | null;
}

/** Shown in the browser (with a sandboxing CSP); everything else is a download. SVG and HTML are deliberately not here. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf', 'text/plain']);

const bucket = (env: Env) => {
  if (!env.FILES) throw new HttpError(409, "Attachments aren't set up on this instance.");
  return env.FILES;
};

/** A safe file name: no paths or control characters, and not too long. */
export function cleanName(raw: string | undefined) {
  let name = '';
  try { name = decodeURIComponent(raw ?? ''); } catch { name = raw ?? ''; }
  name = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length > 180) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name || 'file';
}

/** The MIME type to store: what the browser said, if it's a sane one. */
const cleanType = (t: string | undefined) => {
  const v = (t ?? '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(v) ? v : 'application/octet-stream';
};

export const touch = (db: D1Database, taskId: string, now: string) => [
  bumpVersion(db),
  db.prepare(`UPDATE tasks SET updated_at = ?, version = ${CURRENT_VERSION} WHERE id = ?`).bind(now, taskId),
];

/** The task, if it has room for one more file (copies and links count alike). */
export async function taskWithRoom(db: D1Database, v: Viewer, taskId: string) {
  const t = await loadEditableTask(db, v, taskId);
  const { n } = (await db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE task_id = ? AND removed_at IS NULL').bind(t.id).first<{ n: number }>())!;
  if (n >= ATTACH_PER_TASK_MAX) throw bad(`A task can have at most ${ATTACH_PER_TASK_MAX} attachments.`);
  return t;
}

export async function addAttachment(env: Env, v: Viewer, taskId: string, body: ReadableStream | null, size: number, rawName: string | undefined, rawType: string | undefined, via: string | null = null, provider: string | null = null): Promise<Task> {
  const files = bucket(env);
  const db = env.DB;
  if (!body || !Number.isFinite(size) || size <= 0) throw bad('That file is empty.');
  if (size > ATTACH_MAX_BYTES) throw new HttpError(400, `Files can be at most ${ATTACH_MAX_BYTES / 1024 / 1024} MB.`);
  // On the SleekSite platform: over the plan's storage allowance, new files wait until there's room again.
  if (await storageFull(env)) throw new HttpError(409, STORAGE_FULL);
  const t = await taskWithRoom(db, v, taskId);

  const id = uid();
  const name = cleanName(rawName);
  const type = cleanType(rawType);
  const key = `tasks/${t.id}/${id}`;
  // R2 needs the length up front; FixedLengthStream also stops a body that's longer than it claimed.
  const fixed = new FixedLengthStream(size);
  const piping = body.pipeTo(fixed.writable);
  await Promise.all([files.put(key, fixed.readable, { httpMetadata: { contentType: type }, customMetadata: { taskId: t.id, name } }), piping]);
  const now = nowIso();
  await db.batch([
    ...touch(db, t.id, now),
    db.prepare('INSERT INTO attachments (id, task_id, key, name, size, type, uploaded_by, uploaded_at, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, t.id, key, name, size, type, v.id, now, provider),
    eventStmt(db, { taskId: t.id, actorId: v.id, via, type: 'attached', to: name, at: now }),
  ]);
  return mapTask((await loadTask(db, t.id))!);
}

async function loadAttachment(env: Env, v: Viewer, taskId: string, id: string) {
  const t = await loadVisibleTask(env.DB, v, taskId);
  const a = await env.DB.prepare('SELECT * FROM attachments WHERE id = ? AND task_id = ? AND removed_at IS NULL').bind(id, t.id).first<AttachmentRow>();
  if (!a) throw notFound('That file is gone.');
  return { t, a };
}

/** Removing is for whoever uploaded it, or an admin. The file is deleted; the history keeps its name. */
export async function removeAttachment(env: Env, v: Viewer, taskId: string, id: string, via: string | null = null): Promise<Task> {
  const { t, a } = await loadAttachment(env, v, taskId, id);
  if (t.archived_at) throw bad('This task is archived. Restore it from its project first.');
  if (a.uploaded_by !== v.id && v.role !== 'admin') throw forbidden('Only the person who attached it, or an admin, can remove it.');
  const now = nowIso();
  await env.DB.batch([
    ...touch(env.DB, t.id, now),
    env.DB.prepare('UPDATE attachments SET removed_at = ?, removed_by = ? WHERE id = ?').bind(now, v.id, a.id),
    eventStmt(env.DB, { taskId: t.id, actorId: v.id, via, type: 'detached', to: a.name, at: now }),
  ]);
  if (a.key) await bucket(env).delete(a.key).catch(() => undefined);
  return mapTask((await loadTask(env.DB, t.id))!);
}

/** The file's bytes, for the API route and for AI assistants (small text files). */
export async function readAttachment(env: Env, v: Viewer, taskId: string, id: string) {
  const { a } = await loadAttachment(env, v, taskId, id);
  if (a.url) throw new HttpError(409, `This is a link to a file, not a copy: ${a.url}`);
  const obj = await bucket(env).get(a.key);
  if (!obj) throw notFound('That file is missing from storage.');
  return { a, obj };
}

// ---------- for AI assistants (MCP attach_file) ----------
const BY_EXT: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  yaml: 'application/yaml', yml: 'application/yaml', xml: 'application/xml', html: 'text/html', htm: 'text/html', log: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  pdf: 'application/pdf', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export const typeFromName = (name: string) => BY_EXT[name.toLowerCase().split('.').pop() ?? ''] ?? 'application/octet-stream';

/** Attaches bytes held in memory (text or decoded data from an assistant). */
export function addAttachmentBytes(env: Env, v: Viewer, taskId: string, bytes: Uint8Array, name: string, type: string | undefined, via: string | null, provider: string | null = null) {
  return addAttachment(env, v, taskId, new Blob([bytes]).stream(), bytes.byteLength, encodeURIComponent(name), type || typeFromName(name), via, provider);
}

/**
 * Reads a download with a running total, so a server that doesn't say (or lies about) the size can't push past
 * ATTACH_MAX_BYTES. `what` names it in errors ("That file", "That link").
 */
export async function readCapped(res: Response, what = 'That file') {
  const tooBig = () => bad(`${what} is over ${ATTACH_MAX_BYTES / 1024 / 1024} MB.`);
  if (Number(res.headers.get('content-length') || 0) > ATTACH_MAX_BYTES) { await res.body?.cancel(); throw tooBig(); }
  if (!res.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ATTACH_MAX_BYTES) { await reader.cancel(); throw tooBig(); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return bytes;
}

/**
 * Downloads a public https file and attaches it. Only http(s) on standard ports, no local addresses,
 * at most ATTACH_MAX_BYTES, 20 seconds. The name comes from the caller, the server's filename, or the link.
 */
export async function addAttachmentFromUrl(env: Env, v: Viewer, taskId: string, rawUrl: string, name: string | undefined, type: string | undefined, via: string | null) {
  await loadVisibleTask(env.DB, v, taskId); // check access before fetching anything
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw bad("That isn't a valid link."); }
  if (url.protocol !== 'https:') throw bad('Only https links can be attached.');
  if (url.port && url.port !== '443') throw bad('Only links on the standard https port can be attached.');
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[::1\]|\[f[cd])/i.test(url.hostname) || !url.hostname.includes('.')) {
    throw bad('Only public links can be attached.');
  }
  let res: Response;
  try {
    res = await fetch(url.toString(), { redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'Taskivities attachment fetcher' } });
  } catch {
    throw bad("Couldn't download that link.");
  }
  if (!res.ok || !res.body) throw bad(`Couldn't download that link (it answered ${res.status}).`);
  const bytes = await readCapped(res);
  const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get('content-disposition') ?? '')?.[1];
  const fromPath = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
  const finalName = name || (fromHeader ? decodeURIComponent(fromHeader) : '') || fromPath || url.hostname;
  const finalType = type || (res.headers.get('content-type') ?? '').split(';')[0].trim() || typeFromName(finalName);
  return addAttachmentBytes(env, v, taskId, bytes, finalName, finalType === 'application/octet-stream' ? typeFromName(finalName) : finalType, via);
}

// ---------- routes: /api/tasks/:id/attachments ----------
export const attachmentRoutes = new Hono<AppEnv>();

/** Upload: the file is the raw request body; its name goes in x-file-name (URI-encoded). */
attachmentRoutes.post('/:id/attachments', async (c) => {
  const size = Number(c.req.header('content-length'));
  if (!c.req.header('content-length')) throw bad('Missing file size.');
  const task = await addAttachment(c.env, c.get('viewer'), c.req.param('id'), c.req.raw.body, size, c.req.header('x-file-name'), c.req.header('content-type'));
  return c.json({ task });
});

attachmentRoutes.delete('/:id/attachments/:aid', async (c) =>
  c.json({ task: await removeAttachment(c.env, c.get('viewer'), c.req.param('id'), c.req.param('aid')) }));

/** Download / view. ?download forces a download even for images. */
attachmentRoutes.get('/:id/attachments/:aid', async (c) => {
  // A linked file: send the browser to it (its own sharing decides who can open it).
  const linked = await loadAttachment(c.env, c.get('viewer'), c.req.param('id'), c.req.param('aid'));
  if (linked.a.url) return c.redirect(linked.a.url, 302);
  const { a, obj } = await readAttachment(c.env, c.get('viewer'), c.req.param('id'), c.req.param('aid'));
  const inline = INLINE.has(a.type) && c.req.query('download') === undefined;
  const ascii = a.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return new Response(obj.body, {
    headers: {
      'content-type': inline ? (a.type === 'text/plain' ? 'text/plain; charset=utf-8' : a.type) : 'application/octet-stream',
      'content-length': String(a.size),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      // Even opened directly, a file can't run scripts or load anything. (Not for PDFs: browsers' PDF viewers
      // refuse to run inside a sandbox, and they keep a PDF's own scripts away from the page anyway.)
      ...(a.type === 'application/pdf' ? {} : { 'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" }),
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=3600',
    },
  });
});

// ---------- one-time upload links (MCP get_upload_url) ----------
export const UPLOAD_LINK_MINUTES = 15;

/** Makes a link that accepts one POSTed file for this task, as this person, for 15 minutes. Returns the secret path. */
export async function createUploadLink(env: Env, v: Viewer, taskId: string, name: string | undefined, via: string | null) {
  bucket(env);
  const t = await loadEditableTask(env.DB, v, taskId);
  const secret = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + UPLOAD_LINK_MINUTES * 60_000).toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO upload_links (id, task_id, user_id, via, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(await sha256hex(secret), t.id, v.id, via, name ? cleanName(encodeURIComponent(name)) : null, now.toISOString(), expires),
    // Tidy up links that expired more than a day ago.
    env.DB.prepare('DELETE FROM upload_links WHERE expires_at < ?').bind(new Date(now.getTime() - 86_400_000).toISOString()),
  ]);
  return { path: `/upload/${secret}`, expiresAt: expires, task: t };
}

interface LinkRow { id: string; task_id: string; user_id: string; via: string | null; name: string | null; expires_at: string; used_at: string | null }

/** POST /upload/<secret>: the raw file is the body; name from ?name=, x-file-name, or the name given when the link was made. */
export const uploadRoutes = new Hono<AppEnv>();
uploadRoutes.post('/:secret', async (c) => {
  const env = c.env;
  const id = await sha256hex(c.req.param('secret'));
  const link = await env.DB.prepare('SELECT * FROM upload_links WHERE id = ?').bind(id).first<LinkRow>();
  if (!link) return c.json({ ok: false, error: 'Unknown upload link.' }, 404);
  const now = nowIso();
  if (link.used_at) return c.json({ ok: false, error: 'This upload link was already used. Ask for a new one.' }, 410);
  if (link.expires_at < now) return c.json({ ok: false, error: 'This upload link has expired. Ask for a new one.' }, 410);
  // Claim it first, so two uploads racing on one link can't both get in.
  const claim = await env.DB.prepare('UPDATE upload_links SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at >= ?').bind(now, id, now).run();
  if (!claim.meta.changes) return c.json({ ok: false, error: 'This upload link was already used. Ask for a new one.' }, 410);
  try {
    // Still on the team, and still able to see the task?
    const v = await loadViewer(env, link.user_id);
    if (!v) throw forbidden("The person who made this link can't sign in any more.");
    const size = Number(c.req.header('content-length'));
    if (!c.req.header('content-length')) throw bad('Send the file as the request body, with a Content-Length.');
    const name = c.req.query('name') ? encodeURIComponent(c.req.query('name')!) : c.req.header('x-file-name') ?? (link.name ? encodeURIComponent(link.name) : undefined);
    const type = c.req.header('content-type');
    const task = await addAttachment(env, v, link.task_id, c.req.raw.body, size, name,
      !type || type === 'application/x-www-form-urlencoded' ? typeFromName(cleanName(name)) : type, link.via);
    const added = task.attachments[task.attachments.length - 1];
    await env.DB.prepare('UPDATE upload_links SET attachment_id = ? WHERE id = ?').bind(added.id, id).run();
    return c.json({ ok: true, attachment: { id: added.id, name: added.name, type: added.type, size: added.size }, task: { id: task.id, title: task.title } }, 201);
  } catch (e) {
    // Didn't work: let the link be used again (until it expires).
    await env.DB.prepare('UPDATE upload_links SET used_at = NULL WHERE id = ?').bind(id).run();
    if (e instanceof HttpError) return c.json({ ok: false, error: e.message }, e.status);
    console.error(e);
    return c.json({ ok: false, error: "Couldn't store the file." }, 500);
  }
});
uploadRoutes.all('/:secret', (c) => c.json({ ok: false, error: 'POST the file to this address.' }, 405, { allow: 'POST' }));
