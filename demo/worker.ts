// The public demo's Worker. It wraps the app's own Worker (worker/index.ts) without changing it:
//   • /login is a demo sign-in page: pick a sample person (Jordan, an admin; Sara, a member). No Google.
//   • Uploads are kept as sample files under the visitor's file name (demo/files.ts).
//   • Logo, name, wordmark and app icon changes and Gmail and Outlook invites are turned off.
//   • Every page of the app gets a "Demo" banner.
//   • A Cron Trigger puts the sample data back (demo/reset.ts) and signs everyone out.
// Kept apart from the app: nothing in worker/, shared/ or src/ knows about it. Deployed with demo/deploy.mjs.
import app, { TaskivitiesMCP as AppMCP } from '../worker/index';
import { type Env, nowIso, randomToken, sha256hex } from '../worker/lib';
import { demoFiles, demoUpload } from './files';
import { ensureDemoData, resetDemo } from './reset';

const ACCOUNTS = [
  { key: 'jordan', email: 'jordan@example.com', name: 'Jordan Lee', role: 'Admin', about: 'Sees every project, and manages the team and settings.' },
  { key: 'sara', email: 'sara@example.com', name: 'Sara Lopez', role: 'Member', about: 'Sees only the projects she is on.' },
];
const RESET = 'every hour';
const OWN = 'https://www.taskivities.com/open-source';

/** The app's environment, with the stand-in bucket so attachments are on (and keep nothing). */
const demoEnv = (env: Env): Env => ({ ...env, FILES: demoFiles(env) });

/** AI assistants' sessions get the same stand-in bucket. */
export class TaskivitiesMCP extends AppMCP {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, demoEnv(env));
  }
}

const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/');
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Signs in as a sample person: the same session row and cookie the app's own sign-in makes (worker/auth.ts). */
async function demoLogin(req: Request, env: Env) {
  const url = new URL(req.url);
  const account = ACCOUNTS.find((a) => a.key === url.searchParams.get('as'));
  if (!account) return Response.redirect(new URL('/login', url).toString(), 302);
  await ensureDemoData(env);
  const user = await env.DB.prepare("SELECT id FROM users WHERE email = ? AND status = 'active'").bind(account.email).first<{ id: string }>();
  if (!user) return new Response('The demo is being reset. Try again in a moment.', { status: 503 });
  const token = randomToken(32);
  const days = 30;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256hex(token), user.id, nowIso(), new Date(Date.now() + days * 864e5).toISOString()),
    env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(nowIso(), user.id),
  ]);
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return new Response(null, {
    status: 302,
    headers: {
      location: safeNext(url.searchParams.get('next')),
      'set-cookie': `tv_session=${token}; Path=/; Max-Age=${days * 86400}; HttpOnly; SameSite=Lax${secure}`,
    },
  });
}

function loginPage(req: Request) {
  const next = new URL(req.url).searchParams.get('next');
  const q = next ? `&next=${encodeURIComponent(safeNext(next))}` : '';
  const people = ACCOUNTS.map((a) => `
    <a class="acct" href="/auth/demo-login?as=${a.key}${esc(q)}"><b>${esc(a.name)}</b><span class="role">${a.role}</span><span class="about">${esc(a.about)}</span></a>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Try Taskivities</title><link rel="icon" href="/logo.svg" type="image/svg+xml"><meta name="color-scheme" content="light dark">
<style>
:root{--bg:#F7F7F9;--panel:#fff;--line:#E6E6EB;--text:#16161D;--muted:#6B6B78;--accent:#28407D;--accent-soft:#EEF2FA;--accent-line:#B9C8E6}
@media (prefers-color-scheme:dark){:root{--bg:#0E0E13;--panel:#17171D;--line:#2B2B35;--text:#ECECF1;--muted:#9A9AA8;--accent:#9DB2DE;--accent-soft:rgba(95,125,186,.16);--accent-line:rgba(143,166,211,.55)}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}
.card{width:100%;max-width:400px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:32px 28px;box-shadow:0 1px 2px rgba(16,16,29,.04),0 8px 24px rgba(16,16,29,.08);text-align:center}
.card img{width:52px;height:52px;display:block;margin:0 auto 16px}
h1{margin:0;font-size:22px;letter-spacing:-.01em}p{margin:6px 0 22px;color:var(--muted)}
.lbl{text-align:left;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
.acct{display:grid;grid-template-columns:1fr auto;gap:2px 8px;text-align:left;padding:12px 14px;margin-bottom:8px;border:1px solid var(--line);border-radius:10px;color:var(--text);text-decoration:none}
.acct:hover,.acct:focus-visible{border-color:var(--accent-line);background:var(--accent-soft);outline:none}
.role{font-size:11.5px;font-weight:600;color:var(--accent)}.about{grid-column:1/-1;font-size:12.5px;color:var(--muted)}
.foot{margin-top:14px;font-size:12.5px;color:var(--muted)}.foot a{color:var(--accent)}
</style></head><body><main class="card">
<img src="/logo.svg" alt=""><h1>Try Taskivities</h1><p>A team's week, at a glance. No sign-up needed.</p>
<div class="lbl">Sign in as</div>${people}
<div class="foot">A shared demo: everyone who tries it sees the same sample team, and it resets ${RESET}. Uploads are kept as sample files.<br><a href="${OWN}">Run your own →</a></div>
</main></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

// The banner sits above the app, which is a full-height column, so the app is made that much shorter.
const BANNER_CSS = `<style>
.tv-demo{position:fixed;top:0;left:0;right:0;z-index:60;height:32px;display:flex;align-items:center;justify-content:center;gap:8px;padding:0 12px;
  font:12.5px/1 Inter,ui-sans-serif,system-ui,sans-serif;background:var(--accent-soft);color:var(--accent-ink);border-bottom:1px solid var(--accent-line);white-space:nowrap;overflow:hidden}
.tv-demo b{font-weight:700}.tv-demo a{color:inherit;font-weight:600;text-underline-offset:2px}
body{padding-top:32px}.app{height:calc(100vh - 32px)!important;height:calc(100dvh - 32px)!important}
@media (max-width:640px){.tv-demo .long{display:none}}
</style>`;
const BANNER = `<div class="tv-demo" role="note"><b>Demo</b><span class="long">Everyone trying it shares this sample team, and it resets ${RESET}.</span><span class="short">Resets ${RESET}.</span><a href="${OWN}" target="_blank" rel="noopener">Run your own →</a></div>`;
const SHORT_CSS = '<style>.tv-demo .short{display:none}@media (max-width:640px){.tv-demo .short{display:inline}}</style>';

function withBanner(res: Response) {
  return new HTMLRewriter()
    .on('head', { element: (e) => { e.append(BANNER_CSS + SHORT_CSS, { html: true }); } })
    .on('body', { element: (e) => { e.prepend(BANNER, { html: true }); } })
    .transform(res);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Always HTTPS (browsers mark plain http:// "Not secure"). Not for local development.
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

    if (path === '/login' && method === 'GET') return loginPage(req);
    if (path === '/auth/demo-login' && method === 'GET') return demoLogin(req, env);
    // No Google, Microsoft or WorkOS sign-in in the demo.
    if (path === '/auth/login' || path.startsWith('/auth/microsoft') || path.startsWith('/auth/workos')) return Response.redirect(new URL(`/login${url.search}`, url).toString(), 302);
    if (path === '/auth/gmail') return Response.redirect(new URL('/settings?gmail=unavailable', url).toString(), 302);
    if (path === '/auth/outlook') return Response.redirect(new URL('/settings?outlook=unavailable', url).toString(), 302);
    if (method === 'PUT' && /^\/api\/admin\/settings\/(logo|icon|wordmark|name)$/.test(path))
      return json({ error: 'Changing the logo, name or app icon is turned off in the demo. On your own instance, admins change them here.' }, 403);

    let request = req;
    if (method === 'POST' && (/^\/api\/tasks\/[^/]+\/attachments$/.test(path) || /^\/upload\/[^/]+$/.test(path))) request = await demoUpload(req);

    const res = await app.fetch(request as Parameters<typeof app.fetch>[0], demoEnv(env), ctx);

    // Files attached by AI assistants are recorded with their own size; the sample served for them has another.
    if (method === 'GET' && /^\/api\/tasks\/[^/]+\/attachments\/[^/]+$/.test(path) && res.ok) {
      const headers = new Headers(res.headers);
      headers.delete('content-length');
      return new Response(res.body, { status: res.status, headers });
    }
    if (method === 'GET' && !path.startsWith('/authorize') && res.headers.get('content-type')?.startsWith('text/html')) return withBanner(res);
    return res;
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(resetDemo(env));
  },
} satisfies ExportedHandler<Env>;
