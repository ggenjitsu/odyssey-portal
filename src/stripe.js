import { nowIso } from './db.js';

const ts = (n) => (n ? new Date(n * 1000).toISOString() : null);

// Read-only. Use a restricted key with Read on Customers, Subscriptions and Invoices.
export function createStripe({ key, fetchImpl = fetch }) {
  async function get(path, params = {}) {
    const res = await fetchImpl(`https://api.stripe.com/v1${path}?${new URLSearchParams(params)}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Stripe ${path}: ${json.error?.message || res.status}`);
    return json;
  }

  return {
    customers: async () => (await get('/customers', { limit: 100 })).data.map((c) => ({ id: c.id, name: c.name, email: c.email })),

    async snapshot(customerId) {
      const [subs, invoices] = await Promise.all([
        get('/subscriptions', { customer: customerId, status: 'all', limit: 10 }),
        get('/invoices', { customer: customerId, limit: 5 }),
      ]);
      const sub = subs.data.find((s) => ['active', 'trialing', 'past_due', 'unpaid'].includes(s.status)) || subs.data[0] || null;
      const item = sub?.items?.data?.[0];
      const inv = invoices.data[0] || null;
      return {
        sub_status: sub?.status || null,
        // Newer Stripe API versions keep the period on the subscription item.
        period_start: ts(sub?.current_period_start ?? item?.current_period_start),
        period_end: ts(sub?.current_period_end ?? item?.current_period_end),
        amount: item?.price?.unit_amount != null ? item.price.unit_amount * (item.quantity || 1) : null,
        currency: item?.price?.currency || inv?.currency || null,
        interval: item?.price?.recurring?.interval || null,
        invoice_status: inv?.status || null,
        invoice_amount: inv?.amount_due ?? null,
        invoice_created: ts(inv?.created),
        invoice_due: ts(inv?.due_date),
        invoice_url: inv?.hosted_invoice_url || null,
      };
    },
  };
}

export async function refreshBilling(db, stripe) {
  const clients = db.prepare("SELECT id, stripe_customer_id FROM clients WHERE active = 1 AND stripe_customer_id IS NOT NULL AND stripe_customer_id != ''").all();
  for (const c of clients) {
    try {
      const data = await stripe.snapshot(c.stripe_customer_id);
      db.prepare(
        `INSERT INTO billing (client_id, data, checked_at, error) VALUES (?, ?, ?, NULL)
         ON CONFLICT(client_id) DO UPDATE SET data = excluded.data, checked_at = excluded.checked_at, error = NULL`,
      ).run(c.id, JSON.stringify(data), nowIso());
    } catch (err) {
      db.prepare(
        `INSERT INTO billing (client_id, data, checked_at, error) VALUES (?, '{}', ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET checked_at = excluded.checked_at, error = excluded.error`,
      ).run(c.id, nowIso(), err.message);
    }
  }
  return clients.length;
}
