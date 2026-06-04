const https = require('https');

const CLIENT_ID     = 'DDA1B6E801104C488FDB24EC34268C26';
const CLIENT_SECRET = 'VlZShBgNbrJFfU4eDnH-H0mCv0OmgqiVXTTj4cSeFs_UCBHn';
const REDIRECT_URI  = 'https://effulgent-dasik-65faf7.netlify.app/';

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  try {
    const body = JSON.parse(event.body);
    let params;
    if (body.grant_type === 'authorization_code') {
      params = { grant_type: 'authorization_code', code: body.code, redirect_uri: REDIRECT_URI };
    } else if (body.grant_type === 'refresh_token') {
      params = { grant_type: 'refresh_token', refresh_token: body.refresh_token };
    } else {
      return { statusCode: 400, body: 'Invalid grant_type' };
    }
    const postData = new URLSearchParams(params).toString();
    const auth = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
    return new Promise((resolve) => {
      const options = {
        hostname: 'identity.xero.com',
        path: '/connect/token',
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + auth,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: data
          });
        });
      });
      req.on('error', (error) => {
        resolve({ statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: error.message }) });
      });
      req.write(postData);
      req.end();
    });
  } catch (error) {
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: error.message }) };
  }
};
