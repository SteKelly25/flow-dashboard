const https = require('https');

function cors() { return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }; }

function request(options) {
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', error => resolve({ status: 500, data: JSON.stringify({ error: error.message }) }));
    req.end();
  });
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const { path, token, tenantId } = JSON.parse(event.body);
    const headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
    if (tenantId) headers['Xero-tenant-id'] = tenantId;
    const result = await request({ hostname: 'api.xero.com', path, method: 'GET', headers });
    return { statusCode: result.status, headers: { 'Content-Type': 'application/json', ...cors() }, body: result.data };
  } catch(e) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};
