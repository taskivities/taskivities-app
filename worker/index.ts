import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import { admin } from './admin';
import { api } from './api';
import { authRoutes, requireSession, sameOrigin } from './auth';
import { type AppEnv, type Env, HttpError } from './lib';
import { TaskivitiesMCP } from './mcp';
import { oauthRoutes } from './oauth';
import { serveIcon, serveLogo, serveManifest, serveWordmark } from './settings';
import { hookRoutes } from './webhooks';
import { attachmentRoutes, uploadRoutes } from './attachments';
import { morningSummaries, pushRoutes } from './push';
import { inboxRoutes } from './inbox';
import { followRoutes } from './followers';
import { connectRoutes, feedApi, feedRoutes, tokenRoutes } from './feed';

// The MCP session Durable Object (bound as MCP_OBJECT in wrangler.jsonc).
export { TaskivitiesMCP };

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Something went wrong. Please try again.' }, 500);
});

// The logo (header, sign-in page, browser tab icon). Public, so the sign-in page can show it.
app.get('/logo.svg', serveLogo);
// The team's wordmark, when one is uploaded (public too: the sign-in page shows it).
app.get('/wordmark.svg', serveWordmark);
// Installing to a phone's home screen: the manifest and the icons (public; phones fetch them without a session).
app.get('/manifest.webmanifest', serveManifest);
app.get('/icons/:file', serveIcon);

// Incoming webhooks from other services (public; the secret is in the URL). See worker/webhooks.ts.
app.route('/hooks', hookRoutes);
// One-time upload links for AI assistants (secret in the URL). See worker/attachments.ts.
app.route('/upload', uploadRoutes);

// Other instances showing a person's tasks here, with their access token (worker/feed.ts). Server-to-server.
app.route('/feed/v1', feedApi);
// Request and approve: approving another instance here, and coming back here after approving one (worker/feed.ts).
app.route('/connect', connectRoutes);

app.route('/auth', authRoutes);
// Sign-in + consent page for AI assistants connecting over MCP.
app.route('/authorize', oauthRoutes);

app.use('/api/*', sameOrigin, requireSession);
app.route('/api/admin', admin);
app.route('/api/tasks', attachmentRoutes);
app.route('/api/tasks', followRoutes);
app.route('/api/push', pushRoutes);
app.route('/api/inbox', inboxRoutes);
app.route('/api/tokens', tokenRoutes);
app.route('/api/feeds', feedRoutes);
app.route('/api', api);
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

// Anything else is the React app.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

// The OAuth provider sits in front of everything: it serves /token, /register and the
// /.well-known metadata, checks the bearer token on /mcp, and passes all other requests to the app.
// The MCP resource is this Worker's own origin + /mcp, so one provider is built per origin
// (localhost in development, the workers.dev and custom domains in production).
const mcp = TaskivitiesMCP.serve('/mcp', { binding: 'MCP_OBJECT' });
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string) {
  let p = providers.get(origin);
  if (!p) {
    if (providers.size > 20) providers.clear();
    p = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcp,
      defaultHandler: { fetch: (req, env, ctx) => app.fetch(req, env, ctx) },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'Taskivities' },
      accessTokenTTL: 60 * 60,
      refreshTokenTTL: 365 * 86400, // an assistant connection lasts a year from approval
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  fetch: (req, env, ctx) => providerFor(new URL(req.url).origin).fetch(req, env, ctx),
  // The Cron Trigger (wrangler.jsonc): morning summaries, at 8:00 in each person's time zone.
  scheduled: (_event, env, ctx) => ctx.waitUntil(morningSummaries(env)),
} satisfies ExportedHandler<Env>;
