// "Other instances" (account menu): show your tasks from other Taskivities instances here, and make access tokens so
// another instance can show your tasks from this one. See src/feeds.ts and worker/feed.ts.
import { useEffect, useState } from 'react';
import type { AccessTokenInfo, FeedInfo } from '../../shared/types';
import { toast } from '../actions';
import { addFeed, createToken, listFeeds, listTokens, removeFeed, requestAccess, revokeToken } from '../feeds';
import { focusLater } from '../focus';
import { set } from '../store';
import { stamp } from '../util';
import { I } from './ui';

export const closeInstances = () => { set({ instancesOpen: false }); focusLater('[data-act="account"]'); };
const host = (url: string) => url.replace(/^https?:\/\//, '');
const copy = async (text: string, what: string) => {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch { toast('Copy failed. Select it and copy it manually.', undefined, true); }
};

export function InstancesSheet({ today }: { today: string }) {
  const [feeds, setFeeds] = useState<FeedInfo[] | null>(null);
  const [tokens, setTokens] = useState<AccessTokenInfo[] | null>(null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [tokName, setTokName] = useState('');
  const [made, setMade] = useState<string | null>(null);
  const [withToken, setWithToken] = useState(false);

  useEffect(() => {
    void listFeeds().then(setFeeds).catch(() => setFeeds([]));
    void listTokens().then(setTokens).catch(() => setTokens([]));
  }, []);

  const request = async () => {
    if (!url.trim()) { setErr('Give the address of the other instance.'); return; }
    setBusy(true); setErr('');
    try { await requestAccess(url); } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't ask."); setBusy(false); }
  };
  const connect = async () => {
    if (!url.trim() || !token.trim()) { setErr('Give the address of the other instance and the token you made there.'); return; }
    setBusy(true); setErr('');
    try {
      const f = await addFeed(url, token);
      setFeeds((x) => [...(x ?? []), f]);
      setUrl(''); setToken('');
      toast(`Connected ${f.name}. Your tasks there now show with yours.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't connect.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (f: FeedInfo) => {
    try { await removeFeed(f.id); setFeeds((x) => (x ?? []).filter((y) => y.id !== f.id)); toast(`Removed ${f.name}`); } catch (e) { toast(e instanceof Error ? e.message : 'Could not remove it.', undefined, true); }
  };
  const make = async () => {
    try {
      const r = await createToken(tokName.trim() || 'Another instance');
      setMade(r.token); setTokName('');
      setTokens((x) => [r.info, ...(x ?? [])]);
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not make a token.', undefined, true); }
  };
  const revoke = async (t: AccessTokenInfo) => {
    try { await revokeToken(t.id); setTokens((x) => (x ?? []).filter((y) => y.id !== t.id)); toast(`Revoked “${t.name}”. It stops working at once.`); } catch (e) { toast(e instanceof Error ? e.message : 'Could not revoke it.', undefined, true); }
  };

  return (
    <>
      <div className="backdrop" onClick={closeInstances} />
      <div className="sheet instances" role="dialog" aria-modal="true" aria-labelledby="in-title"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeInstances(); } }}>
        <div className="help-h">
          <b id="in-title">Other instances</b><span className="muted" />
          <button className="icon-btn" aria-label="Close" onClick={closeInstances}>{I.x()}</button>
        </div>
        <div className="sheet-b">
          <p className="cn-lead">
            Have tasks on other Taskivities instances too, like your team's at work? Connect them here and the tasks assigned to you there show up
            in your own day, week and board. You can mark them done, move them, change their priority and effort, edit notes and checklists, and
            comment. Anything else, you do on that instance.
          </p>

          <div className="lbl">Showing tasks from</div>
          {feeds === null ? <div className="muted-s">Loading…</div> : feeds.length === 0 ? <div className="muted-s in-empty">No other instances yet.</div> : (
            <div className="card in-list">
              {feeds.map((f) => (
                <div key={f.id} className="in-row">
                  <i className="in-dot" style={{ background: f.color }} />
                  <div className="in-main">
                    <b>{f.name}</b>
                    <span>{host(f.url)} · as {f.user.name || f.user.email}</span>
                    {f.lastError ? <span className="in-err">{f.lastError}</span> : f.lastOkAt && <span>Checked {stamp(f.lastOkAt, today)}</span>}
                  </div>
                  <a className="btn-ghost sm" href={f.url} target="_blank" rel="noopener">Open</a>
                  <button className="btn-ghost sm" data-act="feed-remove" onClick={() => void remove(f)}>Remove</button>
                </div>
              ))}
            </div>
          )}

          <div className="in-add">
            <label className="lbl" htmlFor="in-url">Connect another instance</label>
            <input id="in-url" className="inv-in" placeholder="work.example.com" autoComplete="off" value={url} onChange={(e) => { setUrl(e.target.value); setErr(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !withToken) void request(); }} />
            {withToken && (
              <input id="in-token" className="inv-in" type="password" placeholder="Access token you made there (tvk_…)" autoComplete="off" value={token}
                onChange={(e) => { setToken(e.target.value); setErr(''); }} onKeyDown={(e) => { if (e.key === 'Enter') void connect(); }} />
            )}
            {err && <div className="inv-err" role="alert">{err}</div>}
            <div className="in-foot">
              {withToken ? (
                <span className="muted-s">On that instance: account menu → <b>Other instances</b> → <b>Make a token</b>. <button className="linkish" onClick={() => setWithToken(false)}>Request access instead</button></span>
              ) : (
                <span className="muted-s">You'll approve it there, then come back here. <button className="linkish" data-act="feed-with-token" onClick={() => setWithToken(true)}>Have a token?</button></span>
              )}
              {withToken
                ? <button className="btn-primary sm" data-act="feed-add" disabled={busy} onClick={() => void connect()}>{busy ? 'Connecting…' : 'Connect'}</button>
                : <button className="btn-primary sm" data-act="feed-request" disabled={busy} onClick={() => void request()}>{busy ? 'Opening…' : 'Request access'}</button>}
            </div>
          </div>

          <div className="lbl" style={{ marginTop: 22 }}>Let another instance show your tasks from here</div>
          <p className="cn-small">
            Usually you just approve a request from the other instance. Or make a token here and paste it there, with this address.
            Either way, the other instance can see and change only <b>your</b> tasks here, the way
            described above, and its changes show in each task's history as yours. Revoke it to stop that at once.
          </p>
          <div className="cn-url"><code>{location.origin}</code><button className="btn-ghost sm" onClick={() => void copy(location.origin, 'Address')}>Copy</button></div>
          {made && (
            <div className="in-made" role="status">
              <div><b>Your new token.</b> Copy it now: it isn't shown again.</div>
              <div className="cn-url"><code data-made-token>{made}</code><button className="btn-primary sm" onClick={() => void copy(made, 'Token')}>Copy</button></div>
            </div>
          )}
          <div className="in-mk">
            <input className="inv-in" placeholder="Name it, e.g. My personal Taskivities" value={tokName} maxLength={60} autoComplete="off"
              onChange={(e) => setTokName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void make(); }} />
            <button className="btn-ghost sm" data-act="token-make" onClick={() => void make()}>{I.plus(13)} Make a token</button>
          </div>
          {tokens && tokens.length > 0 && (
            <div className="card in-list">
              {tokens.map((t) => (
                <div key={t.id} className="in-row">
                  <span className="in-key">{I.link(14)}</span>
                  <div className="in-main">
                    <b>{t.name}</b>
                    <span>Made {stamp(t.createdAt, today)} · {t.lastUsedAt ? `last used ${stamp(t.lastUsedAt, today)}` : 'not used yet'}</span>
                  </div>
                  <button className="btn-ghost sm" data-act="token-revoke" onClick={() => void revoke(t)}>Revoke</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
