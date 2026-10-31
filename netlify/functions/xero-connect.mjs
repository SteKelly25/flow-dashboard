// One-time (per client) Xero connection. Tokens are saved in Netlify Blobs - nothing to copy/paste.
//
// Step 1  ?client=afb&key=ACCESSKEY   -> sends you to Xero to log in and tick the organisation
// Step 2  (Xero returns here)          -> saves the connection; if more than one organisation, asks you to pick
// Step 3  ?pick=TENANTID&client=afb&s=SIGNED (buttons on the pick page)
import {
  CLIENT_ID, REDIRECT_URI, SCOPES, cleanClient, keyOk, signState, readState,
  exchangeCode, getRecord, putRecord, xeroGet
} from '../lib/xero-store.mjs';

const page = (title, body, status = 200) => new Response(
  `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 20px;line-height:1.6}
a.b{display:block;margin:10px 0;padding:12px 16px;background:#4A34FF;color:#fff;border-radius:8px;text-decoration:none}
.ok{color:#1a6e3c}.err{color:#c0392b}code{background:#f4f4f4;padding:2px 6px;border-radius:3px}</style></head><body>${body}</body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function authEventId(idToken) {
  try { return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString()).authentication_event_id || null; }
  catch { return null; }
}

export default async (req) => {
  const url = new URL(req.url);
  const q = url.searchParams;
  try {
    if (!process.env.XERO_ACCESS_KEY || !process.env.XERO_CLIENT_SECRET) {
      return page('Not set up', '<h2 class=err>Setup incomplete</h2><p>XERO_ACCESS_KEY and XERO_CLIENT_SECRET must both be set in Netlify.</p>', 500);
    }

    // Step 3: choose organisation
    if (q.get('pick')) {
      const client = cleanClient(q.get('client'));
      if (!client || !(keyOk(q.get('key')) || readState(q.get('s')) === client)) return page('No access', '<h2 class=err>Access key missing or wrong</h2>', 403);
      const rec = await getRecord(client);
      const t = rec && (rec.pending || []).find((x) => x.tenantId === q.get('pick'));
      if (!t) return page('Not found', '<h2 class=err>That organisation is not on the list. Start again.</h2>', 400);
      await putRecord(client, { ...rec, tenantId: t.tenantId, tenantName: t.tenantName, pending: undefined });
      return page('Connected', `<h2 class=ok>✓ ${esc(client.toUpperCase())} connected to ${esc(t.tenantName)}</h2><p>Nothing more to do here. You can close this page.</p>`);
    }

    // Step 2: Xero has sent us back
    if (q.get('code')) {
      const client = readState(q.get('state'));
      if (!client) return page('Rejected', '<h2 class=err>This connection did not start from a valid link. Start again.</h2>', 403);
      const r = await exchangeCode(q.get('code'));
      if (!r.ok) return page('Error', `<h2 class=err>Xero would not issue a token</h2><pre>${esc(JSON.stringify(r.json))}</pre>`, 400);
      const ev = authEventId(r.json.id_token || '');
      let tenants = await xeroGet(`/connections${ev ? `?authEventId=${ev}` : ''}`, r.json.access_token);
      if (ev && (!Array.isArray(tenants) || !tenants.length)) tenants = await xeroGet('/connections', r.json.access_token);
      const list = (tenants || []).map((t) => ({ tenantId: t.tenantId, tenantName: t.tenantName }));
      if (!list.length) return page('No organisation', '<h2 class=err>No Xero organisation was authorised. Start again and tick one.</h2>', 400);
      const base = {
        refresh_token: r.json.refresh_token,
        access_token: r.json.access_token,
        access_expires: Date.now() + (r.json.expires_in || 1800) * 1000,
        connected: new Date().toISOString()
      };
      if (list.length === 1) {
        await putRecord(client, { ...base, tenantId: list[0].tenantId, tenantName: list[0].tenantName });
        return page('Connected', `<h2 class=ok>✓ ${esc(client.toUpperCase())} connected to ${esc(list[0].tenantName)}</h2><p>Nothing more to do here. You can close this page.</p>`);
      }
      await putRecord(client, { ...base, pending: list });
      return page('Pick organisation', `<h2>Which organisation is ${esc(client.toUpperCase())}?</h2><p>Tap the right one.</p>` +
        list.map((t) => `<a class=b href="?pick=${encodeURIComponent(t.tenantId)}&client=${encodeURIComponent(client)}&s=${encodeURIComponent(signState(client))}">${esc(t.tenantName)}</a>`).join('') );
    }

    // Step 1: start
    if (q.get('client')) {
      const client = cleanClient(q.get('client'));
      if (!keyOk(q.get('key')) || !client) return page('No access', '<h2 class=err>Access key missing or wrong</h2><p>Add <code>&amp;key=YOURKEY</code> to the link.</p>', 403);
      const auth = 'https://login.xero.com/identity/connect/authorize?' + new URLSearchParams({
        response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPES, state: signState(client)
      });
      return new Response(null, { status: 302, headers: { Location: auth.toString() } });
    }

    return page('Xero connect', '<h2>Xero connect</h2><p>Use: <code>…/xero-connect?client=afb&amp;key=YOURKEY</code></p>');
  } catch (e) {
    return page('Error', `<h2 class=err>Something went wrong</h2><pre>${esc(e.message)}</pre>`, 500);
  }
};
