// Shared helpers: Xero token storage (Netlify Blobs), token refresh/rotation, access control.
import { getStore } from '@netlify/blobs';
import { createHash, timingSafeEqual } from 'node:crypto';

export const CLIENT_ID = process.env.XERO_CLIENT_ID || '47EAF98AD7FE4F429209E35AF977E253';
export const BASE_URL = 'https://effulgent-dasik-65faf7.netlify.app';
export const REDIRECT_URI = `${BASE_URL}/.netlify/functions/xero-connect`;
export const SCOPES = [
  'openid', 'profile', 'email', 'offline_access',
  'accounting.banktransactions.read',
  'accounting.reports.taxreports.read',
  'accounting.settings.read'
].join(' ');

const store = () => getStore({ name: 'xero-tokens', consistency: 'strong' });

export const cleanClient = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);

export function keyOk(supplied) {
  const real = process.env.XERO_ACCESS_KEY;
  if (!real || !supplied) return false;
  const a = createHash('sha256').update(String(supplied)).digest();
  const b = createHash('sha256').update(real).digest();
  return timingSafeEqual(a, b);
}

// Signed "state" so only a connect flow started with the access key can finish.
export function signState(client) {
  const sig = createHash('sha256').update(`${process.env.XERO_ACCESS_KEY}|${client}|${CLIENT_ID}`).digest('hex').slice(0, 24);
  return `${client}.${sig}`;
}
export function readState(state) {
  const [client, sig] = String(state || '').split('.');
  if (!client || !sig || signState(client) !== state) return null;
  return client;
}

export const getRecord = (client) => store().get(`client-${client}`, { type: 'json' });
export const putRecord = (client, rec) => store().setJSON(`client-${client}`, rec);

async function tokenCall(params) {
  const auth = Buffer.from(`${CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok && !!json.access_token, json };
}

export const exchangeCode = (code) =>
  tokenCall({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });

// Returns a valid access token, refreshing (and saving the NEW refresh token) only when needed.
export async function getAccessToken(client) {
  const rec = await getRecord(client);
  if (!rec || !rec.refresh_token || !rec.tenantId) {
    const e = new Error(`Client "${client}" is not connected yet. Run the connect link first.`); e.status = 404; throw e;
  }
  if (rec.access_token && rec.access_expires && Date.now() < rec.access_expires - 60000) {
    return { token: rec.access_token, tenantId: rec.tenantId, tenantName: rec.tenantName };
  }
  const r = await tokenCall({ grant_type: 'refresh_token', refresh_token: rec.refresh_token });
  if (!r.ok) {
    const e = new Error('Xero refused the refresh. Re-run the connect link for this client. ' + JSON.stringify(r.json)); e.status = 502; throw e;
  }
  const updated = {
    ...rec,
    refresh_token: r.json.refresh_token || rec.refresh_token,
    access_token: r.json.access_token,
    access_expires: Date.now() + (r.json.expires_in || 1800) * 1000,
    refreshed: new Date().toISOString()
  };
  await putRecord(client, updated);
  return { token: updated.access_token, tenantId: rec.tenantId, tenantName: rec.tenantName };
}

export async function xeroGet(path, token, tenantId) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (tenantId) headers['Xero-tenant-id'] = tenantId;
  const res = await fetch(`https://api.xero.com${path}`, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Xero ${res.status} on ${path}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
