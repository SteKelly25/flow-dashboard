/**
 * xero-connect.js
 *
 * One-time OAuth setup per client. Two modes:
 *
 * GET  /.netlify/functions/xero-connect?client=afb
 *   → Redirects to Xero's OAuth authorisation page.
 *
 * GET  /.netlify/functions/xero-connect?code=...&state=afb
 *   → Exchanges the code for tokens, lists available tenants,
 *     and returns the refresh token + tenant ID to paste into
 *     Netlify environment variables.
 *
 * Usage (run once per client):
 *   1. Visit: https://effulgent-dasik-65faf7.netlify.app/.netlify/functions/xero-connect?client=afb
 *   2. Log in to Xero and authorise.
 *   3. Copy the refresh_token and tenant_id from the response.
 *   4. In Netlify dashboard → Site configuration → Environment variables, add:
 *        XERO_REFRESH_AFB   = <refresh_token>
 *        XERO_TENANT_AFB    = <tenant_id>
 *   5. Done — xero-data.js will silently refresh from here on.
 */

const https = require('https');

const CLIENT_ID     = process.env.XERO_CLIENT_ID     || '47EAF98AD7FE4F429209E35AF977E253';
const CLIENT_SECRET = process.env.XERO_CLIENT_SECRET || 'ao94y1-HKdtQDqciqm7W4Pe-hnPmt38o18_Iyrkqxz4AYCE-';
const BASE_URL      = 'https://effulgent-dasik-65faf7.netlify.app';
const REDIRECT_URI  = `${BASE_URL}/.netlify/functions/xero-connect`;

const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'accounting.banktransactions.read',
  'accounting.reports.taxreports.read',
  'accounting.settings.read'
].join(' ');

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'text/html; charset=utf-8'
  };
}

function httpsPost(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function httpsGet(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function html(title, body) {
  return `<!doctype html><html><head><meta charset=utf-8><title>${title}</title>
  <style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.6}
  code{background:#f4f4f4;padding:2px 6px;border-radius:3px;font-size:13px}
  pre{background:#f4f4f4;padding:16px;border-radius:6px;overflow-x:auto;font-size:13px}
  .ok{color:#1a6e3c}.err{color:#c0392b}.label{font-weight:600}</style>
  </head><body>${body}</body></html>`;
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }

  const params = event.queryStringParameters || {};
  const code   = params.code;
  const state  = params.state;   // client key returned by Xero after auth
  const client = params.client;  // client key on initial request

  // ── Step 2: Xero redirects back here with ?code=...&state=afb ──
  if (code && state) {
    try {
      const postData = new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      }).toString();

      const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

      const tokenRes = await httpsPost({
        hostname: 'identity.xero.com',
        path:     '/connect/token',
        method:   'POST',
        headers:  {
          'Authorization':  'Basic ' + auth,
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, postData);

      const tokens = JSON.parse(tokenRes.body);
      if (!tokens.access_token) {
        return {
          statusCode: 400,
          headers: cors(),
          body: html('Error', `<h2 class=err>Token exchange failed</h2><pre>${JSON.stringify(tokens, null, 2)}</pre>`)
        };
      }

      // Get list of connected tenants
      const tenantsRes = await httpsGet({
        hostname: 'api.xero.com',
        path:     '/connections',
        method:   'GET',
        headers:  {
          'Authorization': 'Bearer ' + tokens.access_token,
          'Accept':        'application/json'
        }
      });

      const tenants = JSON.parse(tenantsRes.body);
      const clientKey = state.toUpperCase();

      const tenantRows = Array.isArray(tenants)
        ? tenants.map((t, i) => `<tr><td>${i + 1}</td><td>${t.tenantName}</td><td><code>${t.tenantId}</code></td></tr>`).join('')
        : '<tr><td colspan=3>Could not list tenants</td></tr>';

      return {
        statusCode: 200,
        headers: cors(),
        body: html('Xero Connected ✓', `
          <h2 class=ok>✓ Connected to Xero</h2>
          <p>Copy the values below into <strong>Netlify → Site configuration → Environment variables</strong>.</p>

          <h3>Environment variables to add</h3>
          <table border=1 cellpadding=8 style="border-collapse:collapse;width:100%">
            <tr><th>Variable name</th><th>Value</th></tr>
            <tr><td><span class=label>XERO_REFRESH_${clientKey}</span></td><td><code>${tokens.refresh_token}</code></td></tr>
          </table>

          <h3 style="margin-top:24px">Available Xero organisations (pick one for XERO_TENANT_${clientKey})</h3>
          <table border=1 cellpadding=8 style="border-collapse:collapse;width:100%">
            <tr><th>#</th><th>Organisation</th><th>Tenant ID</th></tr>
            ${tenantRows}
          </table>

          <p style="margin-top:24px">Once you have added both environment variables, <strong>redeploy the Netlify site</strong> (just trigger a new deploy — no code change needed) so the functions pick them up.</p>
        `)
      };

    } catch (err) {
      return {
        statusCode: 500,
        headers: cors(),
        body: html('Error', `<h2 class=err>Error</h2><pre>${err.message}</pre>`)
      };
    }
  }

  // ── Step 1: Initial request — redirect to Xero OAuth ──
  if (client) {
    const authUrl = 'https://login.xero.com/identity/connect/authorize?' + new URLSearchParams({
      response_type: 'code',
      client_id:     CLIENT_ID,
      redirect_uri:  REDIRECT_URI,
      scope:         SCOPES,
      state:         client
    }).toString();

    return {
      statusCode: 302,
      headers: { Location: authUrl },
      body: ''
    };
  }

  // No params — show usage instructions
  return {
    statusCode: 200,
    headers: cors(),
    body: html('Xero Connect', `
      <h2>Xero Connect — one-time setup</h2>
      <p>To connect a client's Xero organisation, visit:</p>
      <pre>https://effulgent-dasik-65faf7.netlify.app/.netlify/functions/xero-connect?client=<strong>CLIENTKEY</strong></pre>
      <p>Replace <code>CLIENTKEY</code> with a short identifier for the client, e.g. <code>afb</code> for A Friendly Bunch.</p>
      <p>You will be redirected to Xero to log in and authorise. After authorising, you will be shown the environment variables to add to Netlify.</p>
    `)
  };
};
