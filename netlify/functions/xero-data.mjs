// Reconciled HMRC payments for a connected client: VAT (account 820) and Corporation Tax (account 830).
// GET /.netlify/functions/xero-data?client=afb&key=ACCESSKEY[&since=2025-12-01]
import { cleanClient, keyOk, getAccessToken, xeroGet } from '../lib/xero-store.mjs';

const json = (obj, status = 200) => new Response(JSON.stringify(obj, null, 2), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

// Xero returns dates as /Date(ms+0000)/ on some endpoints and ISO strings on others
function ymd(d) {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(String(d))) return String(d).slice(0, 10);
  const m = String(d).match(/\/Date\((\d+)/);
  return (m ? new Date(parseInt(m[1], 10)) : new Date(d)).toISOString().slice(0, 10);
}

export default async (req) => {
  const q = new URL(req.url).searchParams;
  if (!keyOk(q.get('key'))) return json({ error: 'Access key missing or wrong' }, 403);
  const client = cleanClient(q.get('client'));
  if (!client) return json({ error: 'client parameter required' }, 400);

  const since = /^\d{4}-\d{2}-\d{2}$/.test(q.get('since') || '')
    ? q.get('since')
    : new Date(Date.now() - 548 * 864e5).toISOString().slice(0, 10);
  const [y, m, d] = since.split('-').map(Number);

  try {
    const { token, tenantId, tenantName } = await getAccessToken(client);

    const acc = await xeroGet(`/api.xro/2.0/Accounts?where=${encodeURIComponent('Code=="820" OR Code=="830"')}`, token, tenantId);
    const accounts = {};
    for (const a of acc.Accounts || []) accounts[a.Code] = { name: a.Name, type: a.Type };

    const where = encodeURIComponent(`IsReconciled==true AND Date>=DateTime(${y},${m},${d})`);
    const vat = [], ct = [], other = [];
    let pages = 0, scanned = 0;
    for (let page = 1; page <= 20; page++) {
      const data = await xeroGet(`/api.xro/2.0/BankTransactions?where=${where}&order=Date&page=${page}`, token, tenantId);
      const txs = data.BankTransactions || [];
      pages = page; scanned += txs.length;
      for (const tx of txs) {
        if (tx.Status === 'DELETED' || tx.Status === 'VOIDED') continue;
        for (const line of tx.LineItems || []) {
          const code = String(line.AccountCode || '');
          if (code !== '820' && code !== '830') continue;
          const lineTotal = (line.LineAmount || 0) + (line.TaxAmount || 0);
          const sign = tx.Type && tx.Type.startsWith('RECEIVE') ? -1 : 1; // money in = refund, shown negative
          const row = {
            date: ymd(tx.Date),
            amount: Math.round(sign * lineTotal * 100) / 100,
            direction: sign === 1 ? 'paid' : 'refund',
            contact: tx.Contact && tx.Contact.Name || '',
            reference: tx.Reference || '',
            description: line.Description || '',
            bankAccount: tx.BankAccount && tx.BankAccount.Name || '',
            transactionId: tx.BankTransactionID,
            reconciled: tx.IsReconciled === true
          };
          (code === '820' ? vat : ct).push(row);
        }
      }
      if (txs.length < 100) break;
    }
    const byDate = (a, b) => (a.date || '').localeCompare(b.date || '');
    vat.sort(byDate); ct.sort(byDate);
    return json({
      client: client.toUpperCase(), organisation: tenantName, since,
      basis: 'Reconciled bank transactions only, lines coded to account 820 (VAT) or 830 (Corporation Tax)',
      accounts, vatPayments: vat, ctPayments: ct,
      checked: { transactionsScanned: scanned, pages },
      note: 'Payments made via bills/manual journals rather than bank spend money will not appear here.',
      asOf: new Date().toISOString()
    });
  } catch (e) {
    return json({ error: e.message }, e.status || 500);
  }
};
