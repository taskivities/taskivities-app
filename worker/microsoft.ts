// Microsoft 365 / Entra ID settings shared by sign-in (worker/auth.ts) and Outlook invite emails (worker/outlook.ts).
// Both are locked to one organization's tenant: see worker/auth.ts for why a multi-tenant authority is refused.
import type { Env } from './lib';

/** Microsoft's own tenant for personal accounts: as open as "consumers". */
const MS_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The configured tenant, or null unless it names exactly one organization ("common" and friends have no dot, so they fail DOMAIN). */
export function msTenant(env: Env): string | null {
  const t = (env.MS_TENANT_ID ?? '').trim().toLowerCase();
  return (GUID.test(t) && t !== MS_CONSUMER_TENANT) || DOMAIN.test(t) ? t : null;
}
export const msOn = (env: Env) => !!(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET && msTenant(env));
/** The tenant's OAuth endpoints: `${msBase(env)}/authorize` and `/token`. Only call when msOn(env). */
export const msBase = (env: Env) => `https://login.microsoftonline.com/${msTenant(env)}/oauth2/v2.0`;

export interface GraphMe { displayName?: string; mail?: string | null; userPrincipalName?: string }
export const GRAPH_ME = 'https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName';
/** The person's email from Graph /me. A #EXT# principal is a guest from outside the tenant; only their invited outside address (`mail`) counts. */
export const emailOf = (me: GraphMe) => me.mail || (me.userPrincipalName && !me.userPrincipalName.includes('#EXT#') ? me.userPrincipalName : null);
