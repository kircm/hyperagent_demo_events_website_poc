/**
 * stripe-stub.mjs — a fake Stripe, for tests and offline development.
 *
 * Implements only the endpoints Gather calls, and records every request so
 * tests can assert on the exact wire format we send. Point the app at it with:
 *
 *   STRIPE_API_BASE=http://127.0.0.1:PORT
 *
 * This proves OUR code: the form encoding, the hold/confirm/refund
 * choreography, the webhook handling. It does not prove Stripe's behaviour —
 * for that you need real test keys and `stripe listen`. See the README.
 */

import { createServer } from 'node:http';

/** Decode Stripe's bracket-notation form bodies back into nested objects. */
export function parseForm(body) {
  const out = {};
  for (const pair of String(body).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
    const key = decodeURIComponent(rawKey);
    const val = decodeURIComponent(rawVal.replace(/\+/g, ' '));

    const head = key.match(/^[^[]+/);
    if (!head) continue;
    const path = [head[0], ...[...key.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1])];

    let node = out;
    for (let i = 0; i < path.length; i++) {
      const seg = path[i];
      if (i === path.length - 1) { node[seg] = val; break; }
      if (node[seg] === undefined) node[seg] = /^\d+$/.test(path[i + 1]) ? [] : {};
      node = node[seg];
    }
  }
  return out;
}

/** unit_amount that makes the stub fail, so tests can exercise error paths. */
export const MAGIC_FAIL_AMOUNT = 66666;

export function startStripeStub() {
  const sessions = [];
  const refunds = [];
  const requests = [];
  let counter = 0;

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://stub');
    const form = body ? parseForm(body) : null;

    requests.push({
      method: req.method,
      path: url.pathname,
      auth: req.headers.authorization || null,
      idempotencyKey: req.headers['idempotency-key'] || null,
      stripeVersion: req.headers['stripe-version'] || null,
      contentType: req.headers['content-type'] || null,
      form,
      rawBody: body,
    });

    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    // Every real Stripe call is authenticated.
    if (!/^Bearer\s+\S+/.test(req.headers.authorization || '')) {
      return json(401, { error: { message: 'No API key provided.', type: 'invalid_request_error' } });
    }

    if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      const amount = Number(form?.line_items?.[0]?.price_data?.unit_amount);
      if (amount === MAGIC_FAIL_AMOUNT) {
        return json(400, {
          error: {
            message: 'Simulated Stripe failure (magic test amount).',
            code: 'stub_forced_failure', type: 'invalid_request_error',
          },
        });
      }
      const id = `cs_test_${++counter}_${Math.random().toString(36).slice(2, 8)}`;
      const quantity = Number(form?.line_items?.[0]?.quantity || 1);
      const session = {
        id,
        object: 'checkout.session',
        url: `https://checkout.stripe.test/c/pay/${id}`,
        mode: form.mode,
        payment_status: 'unpaid',
        status: 'open',
        amount_total: amount * quantity,
        currency: form?.line_items?.[0]?.price_data?.currency,
        client_reference_id: form.client_reference_id,
        customer_email: form.customer_email,
        expires_at: Number(form.expires_at),
        success_url: form.success_url,
        cancel_url: form.cancel_url,
        metadata: form.metadata || {},
        payment_intent: `pi_test_${counter}`,
      };
      sessions.push(session);
      return json(200, session);
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v1/checkout/sessions/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const found = sessions.find((s) => s.id === id);
      if (!found) {
        return json(404, { error: { message: `No such checkout session: ${id}`, code: 'resource_missing' } });
      }
      return json(200, found);
    }

    if (req.method === 'POST' && url.pathname === '/v1/refunds') {
      const refund = {
        id: `re_test_${++counter}`,
        object: 'refund',
        payment_intent: form.payment_intent,
        amount: Number(form.amount || 0),
        reason: form.reason,
        status: 'succeeded',
        metadata: form.metadata || {},
      };
      refunds.push(refund);
      return json(200, refund);
    }

    return json(404, { error: { message: `Stub has no route for ${req.method} ${url.pathname}` } });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        sessions,
        refunds,
        requests,
        lastSession: () => sessions[sessions.length - 1],
        sessionFor: (registrationId) => sessions.find((s) => s.client_reference_id === registrationId),
        requestsTo: (path) => requests.filter((r) => r.path === path),
        reset: () => { sessions.length = 0; refunds.length = 0; requests.length = 0; },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
