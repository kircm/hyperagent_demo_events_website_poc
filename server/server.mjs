/**
 * server.mjs — Gather HTTP API.
 *
 * Zero dependencies: node:http for transport, node:sqlite for storage (see
 * db.mjs), plain fetch for Stripe (see stripe.mjs).
 *
 * Auth is intentionally lightweight — sign in with an email and a display
 * name, get an opaque session token back. The token is returned in the body
 * AND set as a cookie, so a same-origin browser app can rely on the cookie
 * while a cross-origin client (or curl) can use `Authorization: Bearer`.
 *
 *   node --no-warnings server.mjs
 *
 * Environment:
 *   PORT                  default 8787
 *   GATHER_DB             default ./gather.db
 *   GATHER_PUBLIC_URL     where browsers reach this app (for Stripe redirects)
 *   STRIPE_SECRET_KEY     enables paid events
 *   STRIPE_WEBHOOK_SECRET enables the webhook endpoint
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, AppError, CATEGORIES, CURRENCIES, HOLD_MINUTES, OFFER_HOURS } from './db.mjs';
import * as stripe from './stripe.mjs';
import * as email from './email.mjs';
import { buildIcs } from './ics.mjs';
import { createMailer } from './mailer.mjs';

const PORT = Number(process.env.PORT || 8787);
const DB_FILE = process.env.GATHER_DB || 'gather.db';
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const HOLD_GRACE_SECONDS = 120;

const db = openDb(DB_FILE);

// Emails carry links, so the worker needs a fixed base URL rather than the
// per-request one — there is no request when it runs.
const MAILER_BASE_URL = (process.env.GATHER_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const mailer = createMailer(db, { baseUrl: MAILER_BASE_URL });

/* ------------------------------------------------------------------- utils */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function fail(res, err) {
  if (err instanceof AppError || err instanceof stripe.StripeError) {
    return send(res, err.status || 500, { error: { code: err.code, message: err.message } });
  }
  console.error('[gather] unhandled:', err);
  return send(res, 500, { error: { code: 'internal', message: 'Something broke on our end.' } });
}

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 512 * 1024) throw new AppError(413, 'payload_too_large', 'That request is too big.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readRaw(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError(400, 'invalid_json', 'Body was not valid JSON.');
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function tokenFrom(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return parseCookies(req.headers.cookie || '').gather_session || null;
}

const currentUser = (req) => db.userForSession(tokenFrom(req));

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new AppError(401, 'unauthenticated', 'Sign in first.');
  return user;
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name });

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,stripe-signature',
    vary: 'origin',
  };
}

function sessionCookie(req, token) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https');
  return [
    `gather_session=${token}`, 'Path=/', 'HttpOnly', 'Max-Age=2592000',
    secure ? 'SameSite=None; Secure' : 'SameSite=Lax',
  ].join('; ');
}

/** Where a browser reaches this app — Stripe needs absolute redirect URLs. */
function publicUrl(req) {
  if (process.env.GATHER_PUBLIC_URL) return process.env.GATHER_PUBLIC_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

/* --------------------------------------------------------------------- CSV */

function buildCsv(rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Name', 'Email', 'Party size', 'Status', 'Amount', 'Paid at', 'Registered at', 'Note'];
  const body = rows.map((r) => [
    r.user?.name, r.user?.email, r.guests,
    r.refundDue ? 'refund due' : r.status,
    r.amountCents ? stripe.formatMoney(r.amountCents, r.currency) : '',
    r.paidAt || '', r.createdAt, r.note,
  ].map(cell).join(','));
  return [header.join(','), ...body].join('\n');
}

/* ---------------------------------------------------------------- checkout */

/**
 * Turn a held registration into a Stripe Checkout session.
 *
 * The seat is already reserved by this point. If Stripe fails we hand the seat
 * straight back rather than leaving it locked up by a hold nobody can pay.
 */
async function startCheckout(req, { event, registration, user }) {
  const expiresAt = Math.floor(Date.now() / 1000) + HOLD_MINUTES * 60;
  const base = publicUrl(req);
  let session;
  try {
    session = await stripe.createCheckoutSession({
      registrationId: registration.id,
      event,
      guests: registration.guests,
      email: user.email,
      successUrl: `${base}/#/e/${event.slug}?checkout=success`,
      cancelUrl: `${base}/#/e/${event.slug}?checkout=cancelled`,
      expiresAt,
    });
  } catch (err) {
    db.releaseHold(registration.id, 'cancelled');
    throw err;
  }
  // Our hold outlives Stripe's session, so a payment can never land on a seat
  // we already released.
  const holdExpiresAt = new Date((expiresAt + HOLD_GRACE_SECONDS) * 1000).toISOString();
  const saved = db.attachCheckoutSession(registration.id, {
    sessionId: session.id, checkoutUrl: session.url, holdExpiresAt,
  });
  return { session, registration: saved };
}

/** Money back for a payment we couldn't seat. Never throws into the webhook. */
async function refundUnseatable(registration) {
  if (!registration?.id) return null;
  const row = db.raw.prepare('SELECT stripe_payment_intent, amount_cents FROM registrations WHERE id = ?')
    .get(registration.id);
  if (!row?.stripe_payment_intent) {
    console.warn(`[gather] refund due for ${registration.id} but no payment intent recorded`);
    return null;
  }
  try {
    await stripe.createRefund({
      paymentIntent: row.stripe_payment_intent,
      amountCents: row.amount_cents,
      metadata: { registration_id: registration.id, reason: 'seat_unavailable' },
    });
    db.markRefunded(registration.id);
    console.log(`[gather] refunded ${registration.id} — seat was gone by the time payment landed`);
    return true;
  } catch (err) {
    // Left flagged as refund_due so the host sees it and it can be retried.
    console.error(`[gather] refund FAILED for ${registration.id}: ${err.message}`);
    return false;
  }
}

/* ------------------------------------------------------------ static files */

async function serveStatic(req, res, pathname) {
  const rel = normalize(pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  if (rel.startsWith('..')) return send(res, 403, { error: { code: 'forbidden', message: 'No.' } });
  const file = join(PUBLIC_DIR, rel);
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    return send(res, 200, await readFile(file), {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': rel === 'index.html' ? 'no-store' : 'public, max-age=3600',
    });
  } catch {
    try {
      return send(res, 200, await readFile(join(PUBLIC_DIR, 'index.html')), { 'content-type': MIME['.html'] });
    } catch {
      return send(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
    }
  }
}

/* --------------------------------------------------------------- webhooks */

async function handleWebhook(req, res) {
  const raw = await readRaw(req);
  let event;
  try {
    event = stripe.verifyWebhook(raw, req.headers['stripe-signature']);
  } catch (err) {
    // 400 tells Stripe not to bother retrying a request we can't authenticate.
    return send(res, err.status || 400, { error: { code: err.code, message: err.message } });
  }

  if (!db.recordStripeEvent(event.id, event.type)) {
    return send(res, 200, { received: true, duplicate: true });
  }

  const obj = event.data?.object || {};
  let outcome = { handled: false, type: event.type };

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        // `completed` also fires for delayed payment methods that haven't
        // actually cleared — those arrive later as async_payment_succeeded.
        if (obj.payment_status !== 'paid' && obj.payment_status !== 'no_payment_required') {
          outcome = { handled: true, ignored: 'payment_not_yet_settled' };
          break;
        }
        const result = db.confirmPaidSession({
          sessionId: obj.id,
          paymentIntent: typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id ?? null,
          amountTotal: obj.amount_total ?? null,
        });
        outcome = { handled: true, ...result };
        if (result.result === 'refund_due') await refundUnseatable(result.registration);
        break;
      }
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed': {
        outcome = { handled: true, ...db.expireSession(obj.id) };
        break;
      }
      case 'charge.refunded': {
        const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id;
        const reg = pi && db.raw.prepare('SELECT id FROM registrations WHERE stripe_payment_intent = ?').get(pi);
        if (reg) db.markRefunded(reg.id);
        outcome = { handled: true, refunded: Boolean(reg) };
        break;
      }
      default:
        outcome = { handled: false, type: event.type };
    }
  } catch (err) {
    console.error(`[gather] webhook ${event.type} failed:`, err);
    // 500 asks Stripe to retry; the idempotency record is keyed on event id,
    // so a retry re-runs the handler exactly once more.
    db.raw.prepare('DELETE FROM stripe_events WHERE id = ?').run(event.id);
    return send(res, 500, { error: { code: 'webhook_handler_failed', message: err.message } });
  }

  return send(res, 200, { received: true, ...outcome });
}

/* -------------------------------------------------------------------- API */

async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, a, b, c, d, e] = seg;
  const method = req.method;
  const q = url.searchParams;

  /* --- stripe webhook (no auth, raw body) ------------------------------- */
  if (a === 'stripe' && b === 'webhook' && method === 'POST') {
    return handleWebhook(req, res);
  }

  /* --- meta ------------------------------------------------------------- */
  if (a === 'health' && method === 'GET') {
    return send(res, 200, {
      ok: true,
      ...db.stats(),
      payments: stripe.paymentsConfigured(),
      email: email.emailDelivers(),
      outbox: db.outboxStats(),
    });
  }
  if (a === 'meta' && method === 'GET') {
    return send(res, 200, {
      categories: CATEGORIES,
      currencies: CURRENCIES,
      payments: {
        enabled: stripe.paymentsConfigured(),
        webhooks: stripe.webhooksConfigured(),
        holdMinutes: HOLD_MINUTES,
        offerHours: OFFER_HOURS,
      },
      email: email.emailStatus(),
      stats: db.stats(),
    });
  }

  /* --- auth ------------------------------------------------------------- */
  if (a === 'auth' && b === 'session') {
    if (method === 'POST') {
      const { email, name } = await readJson(req);
      const user = db.upsertUser({ email, name });
      const token = db.createSession(user.id);
      return send(res, 200, { user: publicUser(user), token }, { 'set-cookie': sessionCookie(req, token) });
    }
    if (method === 'DELETE') {
      db.destroySession(tokenFrom(req));
      return send(res, 200, { ok: true }, { 'set-cookie': 'gather_session=; Path=/; Max-Age=0; HttpOnly' });
    }
  }

  /* --- me --------------------------------------------------------------- */
  if (a === 'me' && !b && method === 'GET') {
    const user = currentUser(req);
    return send(res, 200, { user: user ? publicUser(user) : null });
  }
  if (a === 'me' && b === 'registrations' && method === 'GET') {
    return send(res, 200, { registrations: db.listMyRegistrations(requireUser(req).id) });
  }
  if (a === 'me' && b === 'events' && method === 'GET') {
    return send(res, 200, { events: db.listEventsByHost(requireUser(req).id) });
  }

  /* --- events ----------------------------------------------------------- */
  if (a === 'events' && !b) {
    if (method === 'GET') {
      const user = currentUser(req);
      return send(res, 200, {
        events: db.listEvents({
          q: q.get('q') || undefined,
          category: q.get('category') || undefined,
          mode: q.get('mode') || undefined,
          when: q.get('when') || 'upcoming',
          hostId: user?.id,
        }),
      });
    }
    if (method === 'POST') {
      const user = requireUser(req);
      const body = await readJson(req);
      // Refuse to create a ticket nobody could ever buy.
      if (Number(body.priceCents) > 0 && !stripe.paymentsConfigured()) {
        throw new AppError(503, 'payments_not_configured',
          'This server has no Stripe key configured, so it cannot take payments. Set STRIPE_SECRET_KEY, or make the event free.');
      }
      return send(res, 201, { event: db.createEvent(user.id, body) });
    }
  }

  if (a === 'events' && b && !c) {
    if (method === 'GET') {
      const event = db.getEventBySlug(b);
      if (!event) throw new AppError(404, 'not_found', 'No event with that link.');
      const user = currentUser(req);
      return send(res, 200, {
        event,
        myRegistration: db.myRegistrationFor(event.id, user?.id),
        isHost: !!user && user.id === event.host.id,
      });
    }
    if (method === 'PATCH') {
      const user = requireUser(req);
      const body = await readJson(req);
      if (Number(body.priceCents) > 0 && !stripe.paymentsConfigured()) {
        throw new AppError(503, 'payments_not_configured',
          'This server has no Stripe key configured, so it cannot take payments.');
      }
      return send(res, 200, { event: db.updateEvent(b, user.id, body) });
    }
  }

  if (a === 'events' && b && c === 'cancel' && method === 'POST') {
    const user = requireUser(req);
    return send(res, 200, { event: db.cancelEvent(b, user.id) });
  }

  if (a === 'events' && b && c === 'ics' && method === 'GET') {
    const event = db.getEventBySlug(b);
    if (!event) throw new AppError(404, 'not_found', 'No event with that link.');
    return send(res, 200, buildIcs(event), {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="${event.slug}.ics"`,
    });
  }

  /* --- registrations ---------------------------------------------------- */
  if (a === 'events' && b && c === 'registrations') {
    // Claim a seat offered after a waitlist promotion.
    if (method === 'POST' && d === 'claim') {
      const user = requireUser(req);
      const out = db.beginClaim(b, user.id);
      const { session } = await startCheckout(req, {
        event: out.event, registration: out.registration, user,
      });
      return send(res, 200, {
        status: 'payment_required',
        checkoutUrl: session.url,
        holdExpiresAt: db.myRegistrationFor(out.event.id, user.id)?.holdExpiresAt,
        event: db.getEventBySlug(b),
      });
    }

    // Give up a hold without waiting for it to lapse.
    if (method === 'POST' && d === 'mine' && e === 'release') {
      const user = requireUser(req);
      const ev = db.getEventBySlug(b);
      if (!ev) throw new AppError(404, 'not_found', 'No event with that link.');
      const mine = db.myRegistrationFor(ev.id, user.id);
      if (!mine) throw new AppError(404, 'not_found', 'You have nothing held on this event.');
      const out = db.releaseHold(mine.id, 'cancelled');
      return send(res, 200, { released: out.released, promoted: out.promoted ?? 0, event: db.getEventBySlug(b) });
    }

    if (method === 'POST' && !d) {
      const user = requireUser(req);
      const { guests, note } = await readJson(req);
      const out = db.beginRegistration(b, user.id, { guests: guests ?? 1, note: note ?? null });

      if (out.outcome !== 'payment_required') {
        return send(res, 201, { status: out.outcome, event: out.event });
      }
      // Reuse a live Checkout session rather than minting a second one.
      if (out.resumed && out.registration.checkoutUrl) {
        return send(res, 200, {
          status: 'payment_required', resumed: true,
          checkoutUrl: out.registration.checkoutUrl,
          holdExpiresAt: out.registration.holdExpiresAt,
          event: out.event,
        });
      }
      const { session, registration } = await startCheckout(req, {
        event: out.event, registration: out.registration, user,
      });
      return send(res, 201, {
        status: 'payment_required',
        checkoutUrl: session.url,
        holdExpiresAt: registration.holdExpiresAt,
        event: db.getEventBySlug(b),
      });
    }

    if (method === 'GET' && !d) {
      const user = requireUser(req);
      return send(res, 200, { registrations: db.listRegistrations(b, user.id) });
    }

    if (method === 'DELETE' && d === 'mine') {
      const user = requireUser(req);
      return send(res, 200, db.cancelRegistration(b, user.id));
    }
  }

  if (a === 'events' && b && c === 'registrations.csv' && method === 'GET') {
    const user = requireUser(req);
    const rows = db.listRegistrations(b, user.id);
    return send(res, 200, buildCsv(rows), {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${b}-guests.csv"`,
    });
  }

  /* --- operational ------------------------------------------------------ */
  if (a === 'admin' && b === 'sweep' && method === 'POST') {
    // Idempotent and safe to expose: it only releases holds that already
    // lapsed. Handy for cron, and for tests that don't want to wait 30 min.
    return send(res, 200, { ...db.sweepHolds(), outbox: db.outboxStats() });
  }

  if (a === 'admin' && b === 'outbox' && method === 'GET') {
    return send(res, 200, {
      stats: db.outboxStats(),
      messages: db.listOutbox({ status: q.get('status') || undefined, type: q.get('type') || undefined }),
    });
  }

  if (a === 'admin' && b === 'outbox' && c === 'drain' && method === 'POST') {
    // The worker also runs on a timer. This exists for cron on platforms that
    // freeze between requests, and so tests don't have to wait for a tick.
    return send(res, 200, { ...(await mailer.drain()), outbox: db.outboxStats() });
  }

  throw new AppError(404, 'no_route', `No API route for ${method} ${url.pathname}`);
}

/* ------------------------------------------------------------------ server */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const cors = corsHeaders(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = (status, headers = {}) => origWriteHead(status, { ...cors, ...headers });

  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    fail(res, err);
  }
});

// Release lapsed holds and let the waitlist behind them move up. Capacity
// reads don't depend on this — they filter expired holds directly — but the
// promotion side-effect does.
const sweeper = setInterval(() => {
  try {
    const out = db.sweepHolds();
    if (out.expired) console.log(`[gather] swept ${out.expired} lapsed hold(s), promoted ${out.promoted}`);
  } catch (err) {
    console.error('[gather] sweep failed:', err.message);
  }
}, 60_000);
sweeper.unref?.();

server.listen(PORT, () => {
  const s = db.stats();
  // Anything left mid-send belongs to a process that is no longer running.
  const { requeued } = db.requeueStalledEmails();
  if (requeued) console.log(`[gather] requeued ${requeued} email(s) left in flight by a previous run`);

  mailer.start(Number(process.env.GATHER_MAILER_INTERVAL_MS || 15_000));

  console.log(`[gather] listening on http://localhost:${PORT}`);
  console.log(`[gather] db=${DB_FILE} users=${s.users} events=${s.events} registrations=${s.registrations}`);
  console.log(`[gather] payments=${stripe.paymentsConfigured() ? 'enabled' : 'disabled (no STRIPE_SECRET_KEY)'}`
    + ` webhooks=${stripe.webhooksConfigured() ? 'enabled' : 'disabled (no STRIPE_WEBHOOK_SECRET)'}`);
  const mail = email.emailStatus();
  console.log(`[gather] email=${mail.provider}${mail.delivers ? '' : ' (not delivering — logging only)'}`
    + ` from="${mail.from}"`);
});
