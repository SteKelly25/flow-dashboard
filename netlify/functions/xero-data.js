/**
 * xero-data.js
 *
 * Fetches live VAT return and payment data from Xero for a given client.
 * Uses a stored refresh token from Netlify environment variables — no user
 * login required when viewing the report.
 *
 * GET /.netlify/functions/xero-data?client=afb
 *
 * Required environment variables (set after running xero-connect):
 *   XERO_REFRESH_AFB   — the refresh token for A Friendly Bunch
 *   XERO_TENANT_AFB    — the Xero tenant ID for A Friendly Bunch
 *
 * Returns JSON:
 * {
 *   vatReturns: [ { period, netVat, filed, status, periodKey } ],
 *   vatPayments: [ { date, amount, reference } ],
 *   ctPayments:  [ { date, amount, reference } ],
 *   asOf: "ISO timestamp"
 * }
 */

const https = require('https');

const CLIENT_ID     = process.env.XERO_CLIENT_ID     || '47EAF98AD7FE4F429209E35AF977E253';
const CLIENT_SECRET = process.env.XERO_CLIENT_SECRET || 'ao94y1-HKdtQDqciqm7W4Pe-hnPmt38o18_Iyrkqxz4AYCE-';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
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

async function refreshAccessToken(refreshToken) {
  const postData = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken
  }).toString();

  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const res = await httpsPost({
    hostname: 'identity.xero.com',
    path:     '/connect/token',
    method:   'POST',
    headers:  {
      'Authorization':  'Basic ' + auth,
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);

  const tokens = JSON.parse(res.body);
  if (!tokens.access_token) {
    throw new Error('Token refresh failed: ' + res.body);
  }
  return tokens.access_token;
}

async function xeroGet(path, accessToken, tenantId) {
  const res = await httpsGet({
    hostname: 'api.xero.com',
    path,
    method:  'GET',
    headers: {
      'Authorization':  'Bearer ' + accessToken,
      'Xero-tenant-id': tenantId,
      'Accept':         'application/json'
    }
  });
  if (res.status !== 200) {
    throw new Error(`Xero API error ${res.status} on ${path}: ${res.body}`);
  }
  return JSON.parse(res.body);
}

// Format a Xero date string /Date(1234567890000+0000)/ → YYYY-MM-DD
function parseXeroDate(xeroDate) {
  if (!xeroDate) return null;
  const match = xeroDate.match(/\/Date\((\d+)/);
  if (!match) return xeroDate; // already a string
  return new Date(parseInt(match[1])).toISOString().slice(0, 10);
}

// Quarter key e.g. "2026-Q3" from a VAT return period
function quarterKey(startDate, endDate) {
  if (!endDate) return null;
  const d = new Date(endDate);
  const y = d.getFullYear();
  const m = d.getMonth(); // 0-based
  // Flow clients are on Nov quarter-end: Nov=Q4, Aug=Q3, May=Q2, Feb=Q1
  // Map by end month
  const qMap = { 1: 'Q1', 4: 'Q2', 7: 'Q3', 10: 'Q4' }; // Feb, May, Aug, Nov
  const q = qMap[m] || `M${m + 1}`;
  return `${y}-${q}`;
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }

  const params   = event.queryStringParameters || {};
  const clientKey = (params.client || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (!clientKey) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'client parameter required' }) };
  }

  const refreshToken = process.env[`XERO_REFRESH_${clientKey}`];
  const tenantId     = process.env[`XERO_TENANT_${clientKey}`];

  if (!refreshToken || !tenantId) {
    return {
      statusCode: 404,
      headers: cors(),
      body: JSON.stringify({ error: `No Xero credentials configured for client "${clientKey}". Run the xero-connect setup first.` })
    };
  }

  try {
    const accessToken = await refreshAccessToken(refreshToken);

    // Fetch VAT returns (last 12 months)
    const sinceDate = new Date();
    sinceDate.setMonth(sinceDate.getMonth() - 15);
    const since = sinceDate.toISOString().slice(0, 10);

    const [vatData, accountsData] = await Promise.all([
      xeroGet(`/api.xro/2.0/TaxRates`, accessToken, tenantId).catch(() => null),
      // Accounts — we need to find the VAT control and CT payable account codes
      xeroGet(`/api.xro/2.0/Accounts?where=Type%3D%3D%22CURRLIAB%22`, accessToken, tenantId).catch(() => null),
    ]);

    // Get VAT returns
    let vatReturns = [];
    try {
      const vrData = await xeroGet(
        `/api.xro/2.0/Reports/VAT?fromDate=${since}&toDate=${new Date().toISOString().slice(0, 10)}`,
        accessToken, tenantId
      );
      // VAT returns API returns a report — parse rows
      // Alternatively use the Returns endpoint if available
      vatReturns = vrData.Reports ? [] : []; // fallback — try payments approach instead
    } catch(e) {
      // VAT returns report may not be available on all plans
    }

    // Get payments — search accounts for VAT liability (820 in NZ/AU, differs per UK setup)
    // UK Xero: VAT control account is typically "820" or named "VAT"
    // We'll find it from the accounts list
    let vatAccountCode = null;
    let ctAccountCode  = null;

    if (accountsData && accountsData.Accounts) {
      for (const acc of accountsData.Accounts) {
        const name = (acc.Name || '').toLowerCase();
        const code = (acc.Code || '').toLowerCase();
        if (name.includes('vat') && !vatAccountCode) vatAccountCode = acc.Code;
        if ((name.includes('corporation tax') || name.includes('corp tax') || code === '775') && !ctAccountCode) ctAccountCode = acc.Code;
      }
    }

    // Fetch recent payments (last 18 months) — filter by account in JS
    const paymentsData = await xeroGet(
      `/api.xro/2.0/Payments?where=Status%3D%3D%22AUTHORISED%22&ModifiedAfter=${since}`,
      accessToken, tenantId
    ).catch(() => ({ Payments: [] }));

    const allPayments = paymentsData.Payments || [];

    // Also get manual journals and bank transactions for VAT/CT payments
    // (HMRC payments often come through as bank spend transactions)
    const bankTxData = await xeroGet(
      `/api.xro/2.0/BankTransactions?where=Type%3D%3D%22SPEND%22&ModifiedAfter=${since}`,
      accessToken, tenantId
    ).catch(() => ({ BankTransactions: [] }));

    const bankTx = bankTxData.BankTransactions || [];

    // Filter for VAT and CT payments from bank transactions
    const vatPayments = [];
    const ctPayments  = [];

    for (const tx of bankTx) {
      if (!tx.LineItems) continue;
      for (const line of tx.LineItems) {
        const desc = (line.Description || '').toLowerCase();
        const acct = line.AccountCode || '';
        const isVat = acct === vatAccountCode || desc.includes('vat') || desc.includes('hmrc vat');
        const isCt  = acct === ctAccountCode  || desc.includes('corporation tax') || desc.includes('corp tax') || desc.includes('ct payment');
        if (isVat) {
          vatPayments.push({
            date:      parseXeroDate(tx.Date),
            amount:    line.UnitAmount || tx.Total,
            reference: tx.Reference || line.Description || ''
          });
        }
        if (isCt) {
          ctPayments.push({
            date:      parseXeroDate(tx.Date),
            amount:    line.UnitAmount || tx.Total,
            reference: tx.Reference || line.Description || ''
          });
        }
      }
    }

    // Get VAT return filings via the VAT Returns API (UK MTD)
    let mtdReturns = [];
    try {
      const mtd = await xeroGet(`/api.xro/2.0/returns`, accessToken, tenantId);
      mtdReturns = (mtd.Returns || []).map(r => ({
        period:    r.PeriodKey,
        start:     r.PeriodStartDate ? parseXeroDate(r.PeriodStartDate) : null,
        end:       r.PeriodEndDate   ? parseXeroDate(r.PeriodEndDate)   : null,
        netVat:    r.VATDue !== undefined ? r.VATDue : (r.NetVATDue || 0),
        filed:     r.DateSubmitted    ? parseXeroDate(r.DateSubmitted) : null,
        due:       r.DueDate          ? parseXeroDate(r.DueDate)       : null,
        status:    r.Status || 'FILED'
      }));
    } catch(e) {
      // MTD returns endpoint may need additional scope — noted
    }

    // Sort payments newest first
    vatPayments.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    ctPayments.sort( (a, b) => (b.date || '').localeCompare(a.date || ''));
    mtdReturns.sort( (a, b) => (b.end  || '').localeCompare(a.end  || ''));

    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({
        vatReturns:  mtdReturns,
        vatPayments: vatPayments.slice(0, 12),
        ctPayments:  ctPayments.slice(0, 12),
        vatAccountCode,
        ctAccountCode,
        asOf: new Date().toISOString()
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: cors(),
      body: JSON.stringify({ error: err.message })
    };
  }
};
