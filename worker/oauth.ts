// The /authorize page for MCP clients (Claude, etc.). @cloudflare/workers-oauth-provider handles client
// registration, tokens and the consent cookie; this page only signs the person in (with the app's own
// Google sign-in and session cookie) and asks whether the assistant may act as them.
import { type AuthRequest, AuthorizationError, CimdFetchError, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import { currentUser } from './auth';
import type { AppEnv, Ctx, UserRow } from './lib';

/** What the MCP agent receives as `this.props` with every call. */
export interface McpProps extends Record<string, unknown> {
  userId: string;
  /** Shown in task history as "via …". From the client's registration (e.g. "Claude"). */
  clientName: string;
  /** The app's address when the assistant connected (e.g. https://tasks.acme.com), for links like upload URLs. */
  origin?: string;
}

export const oauthRoutes = new Hono<AppEnv>();

export const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
/** Client names are self-asserted and end up in history; keep them short and printable. */
export const cleanClientName = (s: string | undefined | null) =>
  (s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'AI assistant';

export function page(title: string, body: string, status = 200, headers = new Headers()) {
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Taskivities</title>
<style>
  body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#F7F7F8;color:#1D1D23;display:grid;place-items:center;min-height:100vh}
  .card{background:#fff;border:1px solid #E7E7EB;border-radius:14px;padding:28px;max-width:420px;width:calc(100% - 40px);box-shadow:0 4px 18px rgba(0,0,0,.05)}
  h1{font-size:18px;margin:0 0 12px} p{margin:0 0 12px;color:#4A4A55} b{color:#1D1D23}
  ul{margin:0 0 16px;padding-left:18px;color:#4A4A55} .warn{background:#FFFAEB;border:1px solid #FEDF89;border-radius:8px;padding:8px 10px;color:#93370D}
  .row{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}
  button{font:inherit;font-weight:600;border-radius:8px;padding:8px 16px;cursor:pointer;border:1px solid #D0D0D7;background:#fff}
  button.primary{background:#4F46E5;border-color:#4F46E5;color:#fff}
  .muted{font-size:12.5px;color:#7A7A85}
  @media (prefers-color-scheme: dark){
    :root{color-scheme:dark}
    body{background:#0E0E13;color:#ECECF1} b{color:#ECECF1}
    .card{background:#17171D;border-color:#2B2B35;box-shadow:none}
    p,ul{color:#C8C8D2} .muted{color:#9A9AA8}
    .warn{background:rgba(247,144,9,.12);border-color:rgba(247,144,9,.38);color:#FEC84B}
    button{background:#17171D;border-color:#3B3B47;color:#ECECF1}
    button.primary{background:#6366F1;border-color:#6366F1;color:#fff}
  }
</style>
<div class="card">${body}</div></html>`,
    { status, headers },
  );
}

function consentPage(d: ConsentDescription, handle: string, user: UserRow, headers: Headers) {
  const name = esc(d.clientName);
  const origin = d.clientDomain ? `Published by <b>${esc(d.clientDomain)}</b>.` : 'The app named itself; the name is not verified.';
  return page(
    `Allow ${d.clientName}?`,
    `<h1>Allow <b>${name}</b> to use Taskivities as you?</h1>
<p>Signed in as <b>${esc(user.name || user.email)}</b> (${esc(user.email)}).</p>
<p>It will be able to:</p>
<ul>
  <li>see the projects and tasks you can see</li>
  <li>create, edit, finish and transfer tasks as you</li>
</ul>
<p>Every change it makes is recorded in the task's history as yours, marked <b>via ${name}</b>.</p>
<p class="muted">${origin} Access goes to <b>${esc(d.redirectHost)}</b>.</p>
${d.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ''}
<form method="post">
  <input type="hidden" name="handle" value="${esc(handle)}">
  <div class="row"><button name="decision" value="deny">Cancel</button><button class="primary" name="decision" value="approve">Allow</button></div>
</form>`,
    200,
    headers,
  );
}

function errorResponse(e: unknown) {
  if (e instanceof AuthorizationError) {
    if (e.redirectTo) return Response.redirect(e.redirectTo, 302);
    return page('Can’t connect', `<h1>Can’t connect this app</h1><p>${esc(e.description)}</p><p class="muted">Start connecting again from your assistant.</p>`, 400);
  }
  if (e instanceof CimdFetchError) return page('Can’t connect', '<h1>Can’t connect this app</h1><p>This app could not be verified.</p>', 400);
  throw e;
}

const toLogin = (c: Ctx) => {
  const u = new URL(c.req.url);
  return c.redirect(`/login?next=${encodeURIComponent(u.pathname + u.search)}`);
};

oauthRoutes.get('/', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  let req: AuthRequest;
  try {
    req = await oauth.parseAuthRequest(c.req.raw);
  } catch (e) {
    return errorResponse(e);
  }
  const user = await currentUser(c);
  if (!user) return toLogin(c);
  try {
    const details = await oauth.describeConsent(req); // first: a failed lookup leaves nothing in KV
    const consent = await oauth.beginConsent(req);
    return consentPage(details, consent.handle, user, consent.headers);
  } catch (e) {
    return errorResponse(e);
  }
});

oauthRoutes.post('/', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  const user = await currentUser(c);
  if (!user) return page('Signed out', '<h1>You were signed out</h1><p>Start connecting again from your assistant.</p>', 401);
  const form = await c.req.formData();
  const handle = String(form.get('handle') ?? '');
  try {
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(c.req.raw, handle);
    const client = await oauth.lookupClient(approved.request.clientId);
    const clientName = cleanClientName(client?.clientName);
    const props: McpProps = { userId: user.id, clientName, origin: new URL(c.req.url).origin };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request, // from storage, not from the form
      userId: user.id,
      metadata: { clientName, email: user.email },
      scope: approved.request.scope,
      props,
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    return errorResponse(e);
  }
});
