/**
 * stripe.mjs — a minimal Stripe client, no dependencies.
 *
 * Only the four things Gather actually needs: create a Checkout session,
 * retrieve one, refund a payment, and verify a webhook signature. Stripe's
 * REST API is form-encoded and its webhook signing is documented HMAC, so
 * `fetch` and `node:crypto` are enough.
 *
 * Configuration is entirely environmental — keys never touch the codebase:
 *   STRIPE_SECRET_KEY       sk_test_... / sk_live_...
 *   STRIPE_WEBHOOK_SECRET   whsec_...
 *   STRIPE_API_BASE         override for tests (defaults to api.stripe.com)
 *
 * With no secret key set, `paymentsConfigured()` is false and the app keeps
 * working for free events.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const API_BASE = () => process.env.STRIPE_API_BASE || 'https://api.stripe.com';
const SECRET_KEY = () => process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = () => process.env.STRIPE_WEBHOOK_SECRET || '';

export const paymentsConfigured = () => Boolean(SECRET_KEY());
export const webhooksConfigured = () => Boolean(WEBHOOK_SECRET());

export class StripeError extends Error {
  constructor(message, { status = 502, code = 'stripe_error', type } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

/* ----------------------------------------------------------- form encoding */

/**
 * Stripe expects application/x-www-form-urlencoded with bracket notation for
 * nested structures: line_items[0][price_data][unit_amount]=5500
 */
export function encodeForm(value, prefix = '', pairs = []) {
  if (value === null || value === undefined) return pairs;
  if (Array.isArray(value)) {
    value.forEach((item, i) => encodeForm(item, `${prefix}[${i}]`, pairs));
  } else if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      encodeForm(val, prefix ? `${prefix}[${key}]` : key, pairs);
    }
  } else {
    pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  }
  return pairs;
}

async function request(method, path, body, { idempotencyKey } = {}) {
  if (!SECRET_KEY()) {
    throw new StripeError('Payments are not configured on this server.', {
      status: 503, code: 'payments_not_configured',
    });
  }
  const headers = {
    authorization: `Bearer ${SECRET_KEY()}`,
    'stripe-version': '2024-06-20',
  };
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
  // Retried calls must not double-charge or create a second session.
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  let res;
  try {
    res = await fetch(`${API_BASE()}${path}`, {
      method, headers,
      body: body ? encodeForm(body).join('&') : undefined,
    });
  } catch (err) {
    throw new StripeError(`Could not reach Stripe: ${err.message}`, { code: 'stripe_unreachable' });
  }

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const e = json?.error || {};
    throw new StripeError(e.message || `Stripe request failed (${res.status})`, {
      status: res.status, code: e.code || e.type || 'stripe_error', type: e.type,
    });
  }
  return json;
}

/* --------------------------------------------------------------- endpoints */

/**
 * One line item, quantity = party size, price defined inline so hosts never
 * have to pre-create Stripe Products.
 *
 * `expiresAt` (unix seconds) makes Stripe abandon the session on its own
 * schedule; Stripe requires it to be 30 minutes to 24 hours out. Our seat
 * hold is set to outlive it slightly so a payment can never be accepted for
 * a seat we already released.
 */
export function createCheckoutSession({
  registrationId, event, guests, email, successUrl, cancelUrl, expiresAt,
}) {
  const productData = { name: event.title };
  if (event.summary) productData.description = event.summary.slice(0, 500);

  return request('POST', '/v1/checkout/sessions', {
    mode: 'payment',
    client_reference_id: registrationId,
    customer_email: email || undefined,
    success_url: successUrl,
    cancel_url: cancelUrl,
    expires_at: expiresAt,
    line_items: [{
      quantity: guests,
      price_data: {
        currency: event.currency,
        unit_amount: event.priceCents,
        product_data: productData,
      },
    }],
    metadata: {
      registration_id: registrationId,
      event_slug: event.slug,
      guests: String(guests),
    },
    payment_intent_data: {
      metadata: { registration_id: registrationId, event_slug: event.slug },
    },
  }, { idempotencyKey: `gather_reg_${registrationId}_${expiresAt}` });
}

export function retrieveSession(sessionId) {
  return request('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

/**
 * Used when a payment lands for a seat that no longer exists — the only
 * honest response is to give the money back.
 */
export function createRefund({ paymentIntent, amountCents, reason = 'requested_by_customer', metadata = {} }) {
  return request('POST', '/v1/refunds', {
    payment_intent: paymentIntent,
    amount: amountCents || undefined,
    reason,
    metadata,
  }, { idempotencyKey: `gather_refund_${paymentIntent}` });
}

/* ------------------------------------------------------ webhook signatures */

/**
 * Build a Stripe-Signature header for a payload. Stripe does this on their
 * side; we need it to replay events locally and to test verification.
 */
export function buildSignatureHeader(rawBody, secret, timestampSec = Math.floor(Date.now() / 1000)) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const signed = Buffer.concat([Buffer.from(`${timestampSec}.`, 'utf8'), body]);
  const v1 = createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${timestampSec},v1=${v1}`;
}

/**
 * Verify and parse a webhook. Throws StripeError on anything suspicious.
 *
 * Must be given the RAW request body — re-serialising the JSON changes the
 * bytes and the signature will never match.
 */
export function verifyWebhook(rawBody, signatureHeader, {
  secret = WEBHOOK_SECRET(), toleranceSec = 300, now = Date.now(),
} = {}) {
  if (!secret) {
    throw new StripeError('Webhook secret is not configured on this server.', {
      status: 503, code: 'webhook_not_configured',
    });
  }
  if (!signatureHeader) {
    throw new StripeError('Missing Stripe-Signature header.', { status: 400, code: 'signature_missing' });
  }

  let timestamp = null;
  const candidates = [];
  for (const chunk of String(signatureHeader).split(',')) {
    const idx = chunk.indexOf('=');
    if (idx < 1) continue;
    const key = chunk.slice(0, idx).trim();
    const val = chunk.slice(idx + 1).trim();
    if (key === 't') timestamp = Number(val);
    else if (key === 'v1') candidates.push(val);
  }
  if (!timestamp || !Number.isFinite(timestamp) || !candidates.length) {
    throw new StripeError('Malformed Stripe-Signature header.', { status: 400, code: 'signature_malformed' });
  }

  // Replay protection: a captured request stops being usable after the window.
  if (Math.abs(Math.floor(now / 1000) - timestamp) > toleranceSec) {
    throw new StripeError('Webhook timestamp is outside the tolerance window.', {
      status: 400, code: 'signature_stale',
    });
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]))
    .digest();

  const matches = candidates.some((candidate) => {
    const buf = Buffer.from(candidate, 'hex');
    return buf.length === expected.length && timingSafeEqual(buf, expected);
  });
  if (!matches) {
    throw new StripeError('Webhook signature does not match.', { status: 400, code: 'signature_invalid' });
  }

  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new StripeError('Webhook body was not valid JSON.', { status: 400, code: 'invalid_json' });
  }
}

/* -------------------------------------------------------------- formatting */

const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

export const SUPPORTED_CURRENCIES = ['usd', 'eur', 'gbp', 'cad', 'aud', 'jpy'];

/** Cents (or the currency's minor unit) -> "$55.00". */
export function formatMoney(cents, currency = 'usd') {
  const code = String(currency || 'usd').toLowerCase();
  const minor = ZERO_DECIMAL.has(code) ? 1 : 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: code.toUpperCase(),
      minimumFractionDigits: minor === 1 ? 0 : (cents % 100 === 0 ? 0 : 2),
    }).format(cents / minor);
  } catch {
    return `${(cents / minor).toFixed(minor === 1 ? 0 : 2)} ${code.toUpperCase()}`;
  }
}

export const priceLabel = (cents, currency) => (cents > 0 ? formatMoney(cents, currency) : 'Free');
