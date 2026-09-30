/**
 * test.mjs — end-to-end tests against a real running server.
 *
 * Seeds a throwaway database, boots server.mjs as a child process, and drives
 * it over HTTP exactly like a browser would. No mocks of our own code.
 *
 * Payments run against stripe-stub.mjs — a fake Stripe that records every
 * request — with genuinely HMAC-signed webhooks. That proves OUR side: the
 * wire format, the hold/confirm/refund choreography, signature verification,
 * and capacity reconciliation. It does not prove Stripe's behaviour; see the
 * README for verifying against real test keys.
 *
 *   node --no-warnings server/test.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.mjs';
import { buildSignatureHeader } from './stripe.mjs';
import { startStripeStub, MAGIC_FAIL_AMOUNT } from './stripe-stub.mjs';
import { startEmailStub } from './email-stub.mjs';
import { renderEmail, EMAIL_TYPES } from './templates.mjs';
import * as mail from './email.mjs';
import { buildSeed, rebaseSeed, SEED_USERS_FOR_AUDIT } from './seed-data.mjs';
import { renderIndex, withoutSeedLine } from '../build.mjs';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
const SEEDER = fileURLToPath(new URL('./seed.mjs', import.meta.url));
const DB = join(tmpdir(), `gather-test-${process.pid}.db`);
const DB_NOPAY = join(tmpdir(), `gather-nopay-${process.pid}.db`);
const PORT = 8791 + (process.pid % 80);
const PORT_NOPAY = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const WEBHOOK_SECRET = 'whsec_test_gather_suite';
const SECRET_KEY = 'sk_test_gather_suite';

/* ----------------------------------------------------------- tiny harness */

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const eq = (label, actual, expected) =>
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

async function req(method, path, { token, body, base = BASE } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ics/csv */ }
  return { status: res.status, json, text, ct: res.headers.get('content-type') || '' };
}

async function signIn(email, name, base = BASE) {
  const r = await req('POST', '/api/auth/session', { body: { email, name }, base });
  if (r.status !== 200) throw new Error(`sign-in failed for ${email}: ${r.text}`);
  return r.json.token;
}

const iso = (days, hour = 18) => {
  const d = new Date(Date.now() + days * 864e5);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

/* ------------------------------------------------------------- webhook kit */

async function sendWebhook(payload, { secret = WEBHOOK_SECRET, timestamp, signature, omitSignature } = {}) {
  const raw = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json' };
  if (!omitSignature) {
    headers['stripe-signature'] = signature
      ?? buildSignatureHeader(raw, secret, timestamp ?? Math.floor(Date.now() / 1000));
  }
  const res = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers, body: raw });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text };
}

let evtSeq = 0;
const evtId = () => `evt_test_${++evtSeq}_${Math.random().toString(36).slice(2, 7)}`;

const completedEvent = (session, id = evtId()) => ({
  id, object: 'event', type: 'checkout.session.completed',
  data: { object: { ...session, payment_status: 'paid', status: 'complete' } },
});
const expiredEvent = (session, id = evtId()) => ({
  id, object: 'event', type: 'checkout.session.expired',
  data: { object: { ...session, payment_status: 'unpaid', status: 'expired' } },
});

/* --------------------------------------------------------------- lifecycle */

rmSync(DB, { force: true });
rmSync(DB_NOPAY, { force: true });

const stub = await startStripeStub();
const mailStub = await startEmailStub();

const seeded = spawnSync(process.execPath, ['--no-warnings', SEEDER], {
  env: { ...process.env, GATHER_DB: DB }, encoding: 'utf8',
});
if (seeded.status !== 0) {
  console.error('seeding failed:\n', seeded.stdout, seeded.stderr);
  process.exit(1);
}
console.log(seeded.stdout.trim());

const serverEnv = {
  ...process.env,
  GATHER_DB: DB,
  PORT: String(PORT),
  GATHER_PUBLIC_URL: `http://127.0.0.1:${PORT}`,
  STRIPE_API_BASE: stub.url,
  STRIPE_SECRET_KEY: SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  // Real Resend code path, pointed at a stub we can inspect and break.
  EMAIL_PROVIDER: 'resend',
  EMAIL_API_BASE: mailStub.url,
  EMAIL_API_KEY: 'rs_test_gather_suite',
  EMAIL_FROM: 'Gather <hello@gather.test>',
  // Don't let the background worker race the explicit drains below.
  GATHER_MAILER_INTERVAL_MS: '3600000',
};
const child = spawn(process.execPath, ['--no-warnings', SERVER], {
  env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

// A second server with no Stripe configuration at all, to prove the app
// degrades gracefully instead of offering tickets nobody could buy.
// Seeded, so it matches the most common local setup: `npm run seed && npm
// start` with no keys, where seeded paid events exist but can't be sold.
const seededNoPay = spawnSync(process.execPath, ['--no-warnings', SEEDER], {
  env: { ...process.env, GATHER_DB: DB_NOPAY }, encoding: 'utf8',
});
if (seededNoPay.status !== 0) {
  console.error('seeding the no-pay database failed:\n', seededNoPay.stdout, seededNoPay.stderr);
  process.exit(1);
}
const noPayEnv = { ...process.env, GATHER_DB: DB_NOPAY, PORT: String(PORT_NOPAY) };
for (const key of [
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_API_BASE',
  'EMAIL_PROVIDER', 'EMAIL_API_BASE', 'EMAIL_API_KEY', 'EMAIL_FROM',
]) delete noPayEnv[key];
const childNoPay = spawn(process.execPath, ['--no-warnings', SERVER], {
  env: noPayEnv, stdio: ['ignore', 'ignore', 'pipe'],
});

/** Second connection to the same database — used to simulate elapsed time. */
const direct = openDb(DB);
const backdateHold = (registrationId, secondsAgo = 90) =>
  direct.raw.prepare('UPDATE registrations SET hold_expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - secondsAgo * 1000).toISOString(), registrationId);
const regRow = (id) => direct.raw.prepare('SELECT * FROM registrations WHERE id = ?').get(id);

/* --------------------------------------------------------------- outbox kit */

const drainEmail = () => req('POST', '/api/admin/outbox/drain');
const outboxRows = (type, toEmail) => direct.raw.prepare(`
  SELECT * FROM email_outbox WHERE type = ? AND to_email = ? ORDER BY created_at DESC
`).all(type, toEmail);
const outboxRow = (id) => direct.raw.prepare('SELECT * FROM email_outbox WHERE id = ?').get(id);
const makeEmailDue = (id) => direct.raw.prepare('UPDATE email_outbox SET next_attempt_at = ? WHERE id = ?')
  .run(new Date(Date.now() - 5000).toISOString(), id);
const setEmailAttempts = (id, n) => direct.raw.prepare('UPDATE email_outbox SET attempts = ? WHERE id = ?')
  .run(n, id);
/** Decode an .ics attachment back to text. */
const icsText = (attachment) => Buffer.from(attachment.content, 'base64').toString('utf8');

/* ------------------------------------------------------------- UI client kit */

/**
 * Boot the real front end in a VM against a running server, using the HTML
 * that server actually serves. The DOM is a stub: this exercises the app's
 * data layer (RemoteStore) through exactly the code a browser runs, not its
 * pixels. It exists because a remote browser can't reach a local server, and
 * RemoteStore otherwise has no automated coverage at all.
 */
async function bootUi(base) {
  const served = await (await fetch(`${base}/`)).text();
  const scripts = [...served.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const stubEl = () => ({
    innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, hidden: false, disabled: false,
    appendChild() {}, remove() {}, click() {}, select() {}, focus() {}, setSelectionRange() {},
    setAttribute() {}, scrollIntoView() {}, querySelector: () => null, querySelectorAll: () => [],
  });
  const nodes = { root: stubEl(), toasts: stubEl() };
  const location = { hash: '#/', origin: base, pathname: '/', href: `${base}/#/`, assign() {} };
  const window = { location, scrollY: 0, addEventListener() {}, scrollTo() {} };
  window.top = window;
  const document = {
    getElementById: (id) => nodes[id] || null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: stubEl, body: stubEl(), activeElement: null,
    execCommand: () => false,
  };
  // No localStorage in the context: the app's storage probe falls back to
  // memory, exactly as it does inside a sandboxed iframe.
  runInNewContext(scripts.join('\n;\n'), {
    window, document, location, navigator: {}, console,
    fetch, URL, URLSearchParams, Blob, crypto: globalThis.crypto, setTimeout, clearTimeout,
  });
  // boot() is async; it has finished once the first render lands.
  for (let i = 0; i < 100 && !nodes.root.innerHTML; i++) await new Promise((r) => setTimeout(r, 30));
  return { window, root: nodes.root };
}

async function waitFor(base) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server at ${base} never came up`);
}

async function teardown(code) {
  child.kill('SIGKILL');
  childNoPay.kill('SIGKILL');
  await stub.close();
  await mailStub.close();
  for (const f of [DB, DB_NOPAY]) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${f}${suffix}`, { force: true });
  }
  process.exit(code);
}

/** Create a paid event owned by `token`, returning its slug. */
async function makePaidEvent(token, { title, priceCents = 2500, capacity = 2, days = 5 }) {
  const r = await req('POST', '/api/events', {
    token,
    body: {
      title, summary: 'A paid test event.', category: 'Music',
      startsAt: iso(days, 19), endsAt: iso(days, 22),
      mode: 'in_person', city: 'Brooklyn, NY', venueName: 'Somewhere',
      capacity, priceCents, currency: 'usd',
    },
  });
  if (r.status !== 201) throw new Error(`could not create paid event: ${r.text}`);
  return r.json.event.slug;
}

/* ------------------------------------------------------------------ suite */

try {
  await waitFor(BASE);
  await waitFor(`http://127.0.0.1:${PORT_NOPAY}`);

  console.log('\n— health & meta');
  {
    const r = await req('GET', '/api/health');
    eq('health returns 200', r.status, 200);
    eq('health reports seeded events', r.json.events, 9);
    eq('health reports payments enabled', r.json.payments, true);

    const m = await req('GET', '/api/meta');
    check('meta lists categories', m.json.categories.includes('Music'));
    check('meta lists currencies', m.json.currencies.includes('usd'));
    eq('meta advertises payments', m.json.payments.enabled, true);
    eq('meta advertises webhooks', m.json.payments.webhooks, true);
    eq('meta publishes the hold window', m.json.payments.holdMinutes, 30);
    eq('meta publishes the offer window', m.json.payments.offerHours, 24);
  }

  console.log('\n— browse, search & filters');
  {
    const all = await req('GET', '/api/events');
    eq('browse returns 200', all.status, 200);
    const slugs = all.json.events.map((e) => e.slug);
    eq('browse hides the past event', slugs.includes('spring-studio-sale-seconds'), false);
    eq('browse returns 8 upcoming', all.json.events.length, 8);
    check('browse is sorted soonest-first',
      all.json.events.every((e, i, a) => i === 0 || a[i - 1].startsAt <= e.startsAt));

    const past = await req('GET', '/api/events?when=past');
    check('past filter finds the archived event',
      past.json.events.some((e) => e.slug === 'spring-studio-sale-seconds'));
    const q = await req('GET', '/api/events?q=ceramics');
    check('search matches title text', q.json.events.some((e) => e.category === 'Arts'));
    const music = await req('GET', '/api/events?category=Music');
    eq('category filter returns both music events', music.json.events.length, 2);
    const online = await req('GET', '/api/events?mode=online');
    eq('mode filter returns the online workshop', online.json.events.length, 1);
    const nope = await req('GET', '/api/events/does-not-exist');
    eq('unknown slug is a 404', nope.status, 404);
  }

  console.log('\n— seeded state: prices, capacity, holds');
  {
    const jazz = (await req('GET', '/api/events/rooftop-sessions-jazz-small-plates')).json.event;
    eq('paid event exposes a real price', jazz.priceCents, 3500);
    eq('paid event exposes a currency', jazz.currency, 'usd');
    eq('paid event is flagged as paid', jazz.isPaid, true);
    eq('seeded in-progress checkout holds seats', jazz.heldSeats, 2);
    eq('held seats count toward capacity', jazz.takenSeats, jazz.confirmedSeats + jazz.heldSeats);
    eq('seats left accounts for holds', jazz.seatsLeft, jazz.capacity - jazz.takenSeats);

    const free = (await req('GET', '/api/events/rust-for-javascript-developers')).json.event;
    eq('free event has no price', free.priceCents, 0);
    eq('free event is not flagged paid', free.isPaid, false);

    const full = (await req('GET', '/api/events/hand-building-ceramics-beginner-night')).json.event;
    eq('sold-out event reports isFull', full.isFull, true);
    eq('sold-out event has a waitlist', full.waitlistCount, 3);

    const uncapped = (await req('GET', '/api/events/tuesday-open-mic')).json.event;
    eq('uncapped event reports null capacity', uncapped.capacity, null);
    eq('uncapped event is never full', uncapped.isFull, false);
  }

  console.log('\n— auth');
  {
    const anon = await req('GET', '/api/me');
    eq('anonymous /me returns null user', anon.json.user, null);
    const denied = await req('POST', '/api/events', { body: { title: 'Nope', startsAt: iso(3) } });
    eq('creating an event unauthenticated is 401', denied.status, 401);
    const bad = await req('POST', '/api/auth/session', { body: { email: 'not-an-email' } });
    eq('malformed email is rejected', bad.status, 400);
    const token = await signIn('host@example.com', 'Test Host');
    const me = await req('GET', '/api/me', { token });
    eq('bearer token identifies the user', me.json.user.email, 'host@example.com');
    await req('DELETE', '/api/auth/session', { token });
    eq('signing out invalidates the token', (await req('GET', '/api/me', { token })).json.user, null);
  }

  console.log('\n— validation');
  {
    const token = await signIn('validator@example.com', 'Val');
    const cases = [
      ['title is required', { startsAt: iso(3), city: 'X' }],
      ['start date is required', { title: 'A good title', city: 'X' }],
      ['start date must be real', { title: 'A good title', startsAt: 'tomorrow-ish', city: 'X' }],
      ['end cannot precede start', { title: 'A good title', startsAt: iso(5), endsAt: iso(4), city: 'X' }],
      ['category must be known', { title: 'A good title', startsAt: iso(3), city: 'X', category: 'Sportsball' }],
      ['capacity must be sane', { title: 'A good title', startsAt: iso(3), city: 'X', capacity: -4 }],
      ['in-person needs a city', { title: 'A good title', startsAt: iso(3), mode: 'in_person' }],
      ['online needs a join link', { title: 'A good title', startsAt: iso(3), mode: 'online' }],
      ['price must be whole cents', { title: 'A good title', startsAt: iso(3), city: 'X', priceCents: 12.5 }],
      ['price cannot be negative', { title: 'A good title', startsAt: iso(3), city: 'X', priceCents: -100 }],
      ['price below Stripe minimum rejected', { title: 'A good title', startsAt: iso(3), city: 'X', priceCents: 20 }],
      ['currency must be supported', { title: 'A good title', startsAt: iso(3), city: 'X', priceCents: 500, currency: 'zzz' }],
    ];
    for (const [label, body] of cases) {
      eq(label, (await req('POST', '/api/events', { token, body })).status, 400);
    }
  }

  console.log('\n— publishing a free event');
  let slug;
  const hostToken = await signIn('maya@rooftopsessions.example', 'Maya Okonkwo');
  {
    const r = await req('POST', '/api/events', {
      token: hostToken,
      body: {
        title: 'Tiny Test Supper', summary: 'Two seats, on purpose.',
        description: 'A capacity edge case you can eat at.', category: 'Food & Drink',
        startsAt: iso(4, 19), endsAt: iso(4, 22), mode: 'in_person',
        venueName: 'A Kitchen', city: 'Brooklyn, NY', capacity: 2, priceCents: 0,
      },
    });
    eq('event created', r.status, 201);
    slug = r.json.event.slug;
    eq('slug derived from title', slug, 'tiny-test-supper');
    eq('starts with zero seats taken', r.json.event.confirmedSeats, 0);
    eq('host is attributed', r.json.event.host.email, 'maya@rooftopsessions.example');
    const dupe = await req('POST', '/api/events', {
      token: hostToken,
      body: { title: 'Tiny Test Supper', startsAt: iso(6, 19), city: 'Brooklyn, NY' },
    });
    eq('duplicate titles get distinct slugs', dupe.json.event.slug, 'tiny-test-supper-2');
  }

  console.log('\n— free registration & capacity');
  const aliceToken = await signIn('alice@example.com', 'Alice');
  const bobToken = await signIn('bob@example.com', 'Bob');
  {
    const before = stub.sessions.length;
    const own = await req('POST', `/api/events/${slug}/registrations`, { token: hostToken, body: { guests: 1 } });
    eq('host cannot register for own event', own.status, 409);
    eq('  ...with a clear code', own.json.error.code, 'host_cannot_register');

    const a = await req('POST', `/api/events/${slug}/registrations`, { token: aliceToken, body: { guests: 2 } });
    eq('free registration confirms immediately', a.json.status, 'confirmed');
    eq('  ...consuming both seats', a.json.event.seatsLeft, 0);
    eq('free events never touch Stripe', stub.sessions.length, before);

    const again = await req('POST', `/api/events/${slug}/registrations`, { token: aliceToken, body: { guests: 1 } });
    eq('double registration blocked', again.status, 409);
    eq('  ...with a clear code', again.json.error.code, 'already_registered');

    const b = await req('POST', `/api/events/${slug}/registrations`, { token: bobToken, body: { guests: 1 } });
    eq('overflow goes to the waitlist', b.json.status, 'waitlisted');
    eq('  ...and does not oversell', b.json.event.confirmedSeats, 2);

    const tooMany = await req('POST', `/api/events/${slug}/registrations`, {
      token: await signIn('greedy@example.com', 'Greedy'), body: { guests: 99 },
    });
    eq('absurd party size rejected', tooMany.status, 400);
  }

  console.log('\n— guest list access');
  {
    const asHost = await req('GET', `/api/events/${slug}/registrations`, { token: hostToken });
    eq('host sees the guest list', asHost.status, 200);
    eq('  ...with both registrations', asHost.json.registrations.length, 2);
    check('  ...confirmed listed first', asHost.json.registrations[0].status === 'confirmed');
    check('  ...including guest identities', asHost.json.registrations[0].user.email === 'alice@example.com');
    eq('non-host is refused the guest list',
      (await req('GET', `/api/events/${slug}/registrations`, { token: aliceToken })).status, 403);
    eq('anonymous is refused the guest list',
      (await req('GET', `/api/events/${slug}/registrations`)).status, 401);

    const csv = await req('GET', `/api/events/${slug}/registrations.csv`, { token: hostToken });
    check('CSV export has a csv content type', csv.ct.includes('text/csv'), csv.ct);
    check('CSV header includes payment columns', csv.text.startsWith('Name,Email,Party size,Status,Amount,Paid at'));
    check('CSV includes a guest', csv.text.includes('alice@example.com'));
  }

  console.log('\n— editing, capacity guards & promotion');
  {
    const shrink = await req('PATCH', `/api/events/${slug}`, { token: hostToken, body: { capacity: 1 } });
    eq('cannot shrink capacity below committed seats', shrink.status, 409);
    eq('  ...with a clear code', shrink.json.error.code, 'capacity_below_confirmed');
    eq('non-host cannot edit',
      (await req('PATCH', `/api/events/${slug}`, { token: aliceToken, body: { title: 'Hijacked' } })).status, 403);
    const edit = await req('PATCH', `/api/events/${slug}`, { token: hostToken, body: { summary: 'Edited summary.' } });
    eq('host can edit', edit.json.event.summary, 'Edited summary.');
    const grow = await req('PATCH', `/api/events/${slug}`, { token: hostToken, body: { capacity: 4 } });
    eq('raising capacity promotes the waitlist', grow.json.event.confirmedSeats, 3);
    eq('  ...leaving nobody waiting', grow.json.event.waitlistCount, 0);
  }

  console.log('\n— cancelling a registration promotes the queue');
  {
    await req('PATCH', `/api/events/${slug}`, { token: hostToken, body: { capacity: 3 } });
    const carol = await signIn('carol@example.com', 'Carol');
    eq('carol is waitlisted at capacity',
      (await req('POST', `/api/events/${slug}/registrations`, { token: carol, body: { guests: 1 } })).json.status,
      'waitlisted');
    const cancel = await req('DELETE', `/api/events/${slug}/registrations/mine`, { token: aliceToken });
    eq('alice cancels successfully', cancel.status, 200);
    eq('  ...which promotes one person', cancel.json.promoted, 1);
    eq('  ...keeping seats consistent', cancel.json.event.confirmedSeats, 2);
    eq('cancelling twice is a 404',
      (await req('DELETE', `/api/events/${slug}/registrations/mine`, { token: aliceToken })).status, 404);
    eq('a cancelled guest can re-register',
      (await req('POST', `/api/events/${slug}/registrations`, { token: aliceToken, body: { guests: 1 } })).json.status,
      'confirmed');
    const tickets = await req('GET', '/api/me/registrations', { token: aliceToken });
    check('my tickets includes the event', tickets.json.registrations.some((r) => r.event.slug === slug));
  }

  console.log('\n— calendar export');
  {
    const ics = await req('GET', `/api/events/${slug}/ics`);
    check('ics has a calendar content type', ics.ct.includes('text/calendar'), ics.ct);
    check('ics is a well-formed VEVENT',
      ics.text.startsWith('BEGIN:VCALENDAR') && ics.text.includes('BEGIN:VEVENT') && ics.text.trim().endsWith('END:VCALENDAR'));
    check('ics carries the title', ics.text.includes('SUMMARY:Tiny Test Supper'));
    check('ics escapes the location comma', /LOCATION:.*Brooklyn\\,/.test(ics.text));
  }

  console.log('\n— closed states');
  {
    const past = await req('POST', '/api/events/spring-studio-sale-seconds/registrations', {
      token: bobToken, body: { guests: 1 },
    });
    eq('cannot register for a past event', past.status, 409);
    eq('  ...with a clear code', past.json.error.code, 'event_past');
    eq('host cancels the event',
      (await req('POST', `/api/events/${slug}/cancel`, { token: hostToken })).json.event.status, 'cancelled');
    const dave = await signIn('dave@example.com', 'Dave');
    const tooLate = await req('POST', `/api/events/${slug}/registrations`, { token: dave, body: { guests: 1 } });
    eq('cannot register for a cancelled event', tooLate.status, 409);
    eq('  ...with a clear code', tooLate.json.error.code, 'event_cancelled');
    check('cancelled event drops out of browse',
      !(await req('GET', '/api/events')).json.events.some((e) => e.slug === slug));
    eq('cancelled event still reachable by link', (await req('GET', `/api/events/${slug}`)).status, 200);
  }

  console.log('\n— waitlist on the seeded sold-out event');
  {
    const eager = await signIn('eager@example.com', 'Eager Potter');
    const before = stub.sessions.length;
    const r = await req('POST', '/api/events/hand-building-ceramics-beginner-night/registrations', {
      token: eager, body: { guests: 1 },
    });
    eq('joining a sold-out paid event waitlists you', r.json.status, 'waitlisted');
    eq('  ...and the queue grows', r.json.event.waitlistCount, 4);
    eq('  ...and nobody is charged to wait', stub.sessions.length, before);
  }

  /* =================================================== PAYMENTS ========== */

  console.log('\n— paid checkout: the request we send Stripe');
  const buyerA = await signIn('buyer.a@example.com', 'Buyer A');
  let paidSlug;
  {
    paidSlug = await makePaidEvent(hostToken, { title: 'Paid Wire Format Test', priceCents: 3500, capacity: 4 });
    const r = await req('POST', `/api/events/${paidSlug}/registrations`, { token: buyerA, body: { guests: 2 } });
    eq('paid registration returns payment_required', r.json.status, 'payment_required');
    check('  ...with a checkout url', /^https:\/\/checkout\.stripe\.test\//.test(r.json.checkoutUrl || ''), r.json.checkoutUrl);
    check('  ...and a hold expiry', Boolean(r.json.holdExpiresAt));

    const call = stub.requestsTo('/v1/checkout/sessions').at(-1);
    check('authenticated with the secret key', call.auth === `Bearer ${SECRET_KEY}`, call.auth);
    check('sent an idempotency key', Boolean(call.idempotencyKey));
    check('pinned an API version', Boolean(call.stripeVersion));
    check('form-encoded body', call.contentType === 'application/x-www-form-urlencoded', call.contentType);
    eq('mode is payment', call.form.mode, 'payment');
    eq('quantity is the party size', call.form.line_items[0].quantity, '2');
    eq('unit amount is the ticket price', call.form.line_items[0].price_data.unit_amount, '3500');
    eq('currency passed through', call.form.line_items[0].price_data.currency, 'usd');
    check('product named after the event', call.form.line_items[0].price_data.product_data.name === 'Paid Wire Format Test');
    check('registration referenced', Boolean(call.form.client_reference_id));
    eq('registration id in metadata', call.form.metadata.registration_id, call.form.client_reference_id);
    eq('event slug in metadata', call.form.metadata.event_slug, paidSlug);
    check('buyer email prefilled', call.form.customer_email === 'buyer.a@example.com', call.form.customer_email);
    check('success url points back at the event',
      call.form.success_url === `http://127.0.0.1:${PORT}/#/e/${paidSlug}?checkout=success`, call.form.success_url);

    // Stripe requires the session to expire 30 min – 24 h out.
    const secondsOut = Number(call.form.expires_at) - Math.floor(Date.now() / 1000);
    check('session expiry inside Stripe limits', secondsOut >= 29 * 60 && secondsOut <= 24 * 3600,
      `${secondsOut}s`);

    const ev = (await req('GET', `/api/events/${paidSlug}`, { token: buyerA })).json;
    eq('the seat is held, not confirmed', ev.event.heldSeats, 2);
    eq('  ...nothing confirmed yet', ev.event.confirmedSeats, 0);
    eq('  ...and it counts against capacity', ev.event.seatsLeft, 2);
    eq('my registration is pending', ev.myRegistration.status, 'pending');
    eq('  ...priced for the whole party', ev.myRegistration.amountCents, 7000);
  }

  console.log('\n— a hold cannot be oversold');
  let tightSlug;
  const buyerB = await signIn('buyer.b@example.com', 'Buyer B');
  {
    tightSlug = await makePaidEvent(hostToken, { title: 'Only Two Seats', priceCents: 2500, capacity: 2 });
    const a = await req('POST', `/api/events/${tightSlug}/registrations`, { token: buyerA, body: { guests: 2 } });
    eq('buyer A holds both seats', a.json.status, 'payment_required');

    const before = stub.sessions.length;
    const b = await req('POST', `/api/events/${tightSlug}/registrations`, { token: buyerB, body: { guests: 1 } });
    eq('buyer B is waitlisted, not sent to checkout', b.json.status, 'waitlisted');
    eq('  ...so no second session is created', stub.sessions.length, before);

    const mine = (await req('GET', `/api/events/${tightSlug}`, { token: buyerB })).json.myRegistration;
    eq('  ...and a waitlist place is free', mine.amountCents, 0);
    check('  ...with no checkout url', !mine.checkoutUrl);
  }

  console.log('\n— webhook confirms the payment');
  {
    const session = stub.sessions.find((s) => s.metadata.event_slug === tightSlug);
    const w = await sendWebhook(completedEvent(session));
    eq('webhook accepted', w.status, 200);
    eq('  ...and confirmed the registration', w.json.result, 'confirmed');

    const ev = (await req('GET', `/api/events/${tightSlug}`, { token: buyerA })).json;
    eq('seats are now confirmed', ev.event.confirmedSeats, 2);
    eq('  ...and no longer merely held', ev.event.heldSeats, 0);
    eq('my registration is confirmed', ev.myRegistration.status, 'confirmed');
    check('  ...and stamped as paid', Boolean(ev.myRegistration.paidAt));
    eq('  ...recording the amount Stripe reported', ev.myRegistration.amountCents, 5000);

    // A different event id for a session already paid must still be a no-op:
    // idempotency can't rely on the event id alone.
    const replay = await sendWebhook(completedEvent(session, 'evt_distinct_id_same_session'));
    eq('a new event id for an already-paid session changes nothing', replay.json.result, 'already_confirmed');
  }

  console.log('\n— webhook idempotency');
  {
    const session = stub.sessions.find((s) => s.metadata.event_slug === tightSlug);
    const payload = completedEvent(session, 'evt_fixed_duplicate');
    const first = await sendWebhook(payload);
    const second = await sendWebhook(payload);
    eq('first delivery handled', first.status, 200);
    eq('redelivery is recognised', second.json.duplicate, true);
    eq('  ...and changes nothing',
      (await req('GET', `/api/events/${tightSlug}`)).json.event.confirmedSeats, 2);
  }

  console.log('\n— webhook signature verification');
  {
    const session = stub.sessions.find((s) => s.metadata.event_slug === tightSlug);
    const payload = completedEvent(session, 'evt_should_never_apply');

    const noSig = await sendWebhook(payload, { omitSignature: true });
    eq('missing signature rejected', noSig.status, 400);
    eq('  ...with a clear code', noSig.json.error.code, 'signature_missing');

    const wrongSecret = await sendWebhook(payload, { secret: 'whsec_wrong' });
    eq('signature from the wrong secret rejected', wrongSecret.status, 400);
    eq('  ...with a clear code', wrongSecret.json.error.code, 'signature_invalid');

    const stale = await sendWebhook(payload, { timestamp: Math.floor(Date.now() / 1000) - 900 });
    eq('replayed old signature rejected', stale.status, 400);
    eq('  ...with a clear code', stale.json.error.code, 'signature_stale');

    const garbage = await sendWebhook(payload, { signature: 't=abc,v1=zzz' });
    eq('malformed signature header rejected', garbage.status, 400);

    // A signature computed over a different body must not validate this one.
    const otherSig = buildSignatureHeader(JSON.stringify({ id: 'evt_other' }), WEBHOOK_SECRET);
    const tampered = await sendWebhook(payload, { signature: otherSig });
    eq('signature for a different body rejected', tampered.status, 400);

    const unseen = direct.raw.prepare('SELECT 1 FROM stripe_events WHERE id = ?').get('evt_should_never_apply');
    check('no rejected delivery was ever recorded', !unseen);
  }

  console.log('\n— an abandoned checkout releases the seat and offers it on');
  let offerSlug;
  const buyerC = await signIn('buyer.c@example.com', 'Buyer C');
  const buyerD = await signIn('buyer.d@example.com', 'Buyer D');
  {
    offerSlug = await makePaidEvent(hostToken, { title: 'Abandoned Checkout Test', priceCents: 4000, capacity: 2 });
    await req('POST', `/api/events/${offerSlug}/registrations`, { token: buyerC, body: { guests: 2 } });
    eq('buyer D waits behind the hold',
      (await req('POST', `/api/events/${offerSlug}/registrations`, { token: buyerD, body: { guests: 1 } })).json.status,
      'waitlisted');

    const session = stub.sessions.find((s) => s.metadata.event_slug === offerSlug);
    const w = await sendWebhook(expiredEvent(session));
    eq('expiry webhook accepted', w.status, 200);
    eq('  ...released the hold', w.json.result, 'released');
    eq('  ...and promoted the queue', w.json.promoted, 1);

    const cView = (await req('GET', `/api/events/${offerSlug}`, { token: buyerC })).json;
    eq('the abandoner is marked expired, not charged', cView.myRegistration, null);

    const dView = (await req('GET', `/api/events/${offerSlug}`, { token: buyerD })).json;
    eq('promotion on a paid event is an OFFER, not a confirmation', dView.myRegistration.status, 'offered');
    check('  ...with a deadline to claim it', Boolean(dView.myRegistration.holdExpiresAt));
    eq('  ...holding the seat meanwhile', dView.event.heldSeats, 1);
    eq('  ...nothing confirmed', dView.event.confirmedSeats, 0);
    eq('  ...and the waitlist is clear', dView.event.waitlistCount, 0);
  }

  console.log('\n— claiming an offered seat');
  {
    const before = stub.sessions.length;
    const claim = await req('POST', `/api/events/${offerSlug}/registrations/claim`, { token: buyerD });
    eq('claim starts a checkout', claim.json.status, 'payment_required');
    check('  ...with a checkout url', Boolean(claim.json.checkoutUrl));
    eq('  ...creating exactly one session', stub.sessions.length, before + 1);
    eq('  ...priced for the offer', Number(stub.lastSession().amount_total), 4000);

    const w = await sendWebhook(completedEvent(stub.lastSession()));
    eq('paying for the offer confirms it', w.json.result, 'confirmed');
    const dView = (await req('GET', `/api/events/${offerSlug}`, { token: buyerD })).json;
    eq('buyer D now holds a confirmed seat', dView.myRegistration.status, 'confirmed');
    eq('  ...counted as confirmed', dView.event.confirmedSeats, 1);

    const noOffer = await req('POST', `/api/events/${offerSlug}/registrations/claim`, { token: buyerB });
    eq('claiming without an offer is refused', noOffer.status, 409);
    eq('  ...with a clear code', noOffer.json.error.code, 'no_offer');
  }

  console.log('\n— the sweeper releases lapsed holds');
  const buyerE = await signIn('buyer.e@example.com', 'Buyer E');
  const buyerF = await signIn('buyer.f@example.com', 'Buyer F');
  let sweepSlug;
  {
    sweepSlug = await makePaidEvent(hostToken, { title: 'Lapsed Hold Test', priceCents: 1500, capacity: 1 });
    await req('POST', `/api/events/${sweepSlug}/registrations`, { token: buyerE, body: { guests: 1 } });
    await req('POST', `/api/events/${sweepSlug}/registrations`, { token: buyerF, body: { guests: 1 } });

    const eSession = stub.sessions.find((s) => s.metadata.event_slug === sweepSlug);
    const eRegId = eSession.client_reference_id;

    // Simulate the hold window elapsing, then run the sweep the server also
    // runs on a timer.
    backdateHold(eRegId);
    const swept = await req('POST', '/api/admin/sweep');
    eq('sweep releases the lapsed hold', swept.json.expired, 1);
    eq('  ...and promotes the person behind it', swept.json.promoted, 1);
    eq('  ...marking the lapsed one expired', regRow(eRegId).status, 'expired');

    const fView = (await req('GET', `/api/events/${sweepSlug}`, { token: buyerF })).json;
    eq('buyer F is offered the freed seat', fView.myRegistration.status, 'offered');
    eq('  ...which is held for them', fView.event.heldSeats, 1);
  }

  console.log('\n— a payment that lands after the seat is gone gets refunded');
  const buyerG = await signIn('buyer.g@example.com', 'Buyer G');
  const buyerH = await signIn('buyer.h@example.com', 'Buyer H');
  {
    const raceSlug = await makePaidEvent(hostToken, { title: 'Late Payment Test', priceCents: 6000, capacity: 1 });

    // G starts checkout, then lets the hold lapse.
    await req('POST', `/api/events/${raceSlug}/registrations`, { token: buyerG, body: { guests: 1 } });
    const gSession = stub.sessions.find((s) => s.metadata.event_slug === raceSlug);
    backdateHold(gSession.client_reference_id);
    await req('POST', '/api/admin/sweep');
    eq('G’s hold lapsed', regRow(gSession.client_reference_id).status, 'expired');

    // H takes the freed seat and pays for it.
    await req('POST', `/api/events/${raceSlug}/registrations`, { token: buyerH, body: { guests: 1 } });
    const hSession = stub.sessions.filter((s) => s.metadata.event_slug === raceSlug).at(-1);
    await sendWebhook(completedEvent(hSession));
    eq('H holds the only seat', (await req('GET', `/api/events/${raceSlug}`)).json.event.confirmedSeats, 1);

    // Now G's payment finally arrives. There is no seat to give them.
    const refundsBefore = stub.refunds.length;
    const late = await sendWebhook(completedEvent(gSession));
    eq('the late payment is accepted by the endpoint', late.status, 200);
    eq('  ...and flagged as unseatable', late.json.result, 'refund_due');
    eq('  ...for the right reason', late.json.reason, 'seat_gone');
    eq('  ...triggering exactly one refund', stub.refunds.length, refundsBefore + 1);

    const refund = stub.refunds.at(-1);
    eq('  ...for the full amount', refund.amount, 6000);
    eq('  ...against the right payment', refund.payment_intent, gSession.payment_intent);

    const gRow = regRow(gSession.client_reference_id);
    check('  ...and the refund is recorded', Boolean(gRow.refunded_at));
    eq('  ...clearing the outstanding flag', gRow.refund_due, 0);
    eq('the event was never oversold',
      (await req('GET', `/api/events/${raceSlug}`)).json.event.confirmedSeats, 1);
  }

  console.log('\n— releasing a hold by hand');
  {
    const relSlug = await makePaidEvent(hostToken, { title: 'Manual Release Test', priceCents: 2000, capacity: 1 });
    const buyerI = await signIn('buyer.i@example.com', 'Buyer I');
    const buyerJ = await signIn('buyer.j@example.com', 'Buyer J');
    await req('POST', `/api/events/${relSlug}/registrations`, { token: buyerI, body: { guests: 1 } });
    await req('POST', `/api/events/${relSlug}/registrations`, { token: buyerJ, body: { guests: 1 } });

    const rel = await req('POST', `/api/events/${relSlug}/registrations/mine/release`, { token: buyerI });
    eq('the hold is released on request', rel.json.released, true);
    eq('  ...promoting the next person', rel.json.promoted, 1);
    eq('buyer J is offered the seat',
      (await req('GET', `/api/events/${relSlug}`, { token: buyerJ })).json.myRegistration.status, 'offered');
  }

  console.log('\n— a Stripe failure hands the seat straight back');
  {
    const failSlug = await makePaidEvent(hostToken, {
      title: 'Stripe Failure Test', priceCents: MAGIC_FAIL_AMOUNT, capacity: 3,
    });
    const buyerK = await signIn('buyer.k@example.com', 'Buyer K');
    const r = await req('POST', `/api/events/${failSlug}/registrations`, { token: buyerK, body: { guests: 1 } });
    check('the error surfaces to the caller', r.status >= 400, `status ${r.status}`);
    eq('  ...naming the Stripe failure', r.json.error.code, 'stub_forced_failure');

    const ev = (await req('GET', `/api/events/${failSlug}`, { token: buyerK })).json;
    eq('no seat is left stranded in a hold', ev.event.heldSeats, 0);
    eq('  ...and the buyer has no registration', ev.myRegistration, null);
    eq('  ...so the event is fully available', ev.event.seatsLeft, 3);
  }

  console.log('\n— switching an event between free and paid');
  {
    const flipSlug = await makePaidEvent(hostToken, { title: 'Price Flip Test', priceCents: 2500, capacity: 5 });
    const ok = await req('PATCH', `/api/events/${flipSlug}`, { token: hostToken, body: { priceCents: 4000 } });
    eq('a price change with nobody registered is fine', ok.json.event.priceCents, 4000);

    const buyerL = await signIn('buyer.l@example.com', 'Buyer L');
    await req('POST', `/api/events/${flipSlug}/registrations`, { token: buyerL, body: { guests: 1 } });
    const blocked = await req('PATCH', `/api/events/${flipSlug}`, { token: hostToken, body: { priceCents: 0 } });
    eq('flipping paid to free with people registered is refused', blocked.status, 409);
    eq('  ...with a clear code', blocked.json.error.code, 'price_change_blocked');
  }

  console.log('\n— host visibility of holds');
  {
    const rows = (await req('GET', `/api/events/${paidSlug}/registrations`, { token: hostToken })).json.registrations;
    const pending = rows.find((r) => r.status === 'pending');
    check('the host sees in-progress payments', Boolean(pending));
    eq('  ...with the amount owed', pending.amountCents, 7000);
    check('  ...and who it is', pending.user.email === 'buyer.a@example.com');
    const csv = await req('GET', `/api/events/${paidSlug}/registrations.csv`, { token: hostToken });
    check('CSV reflects the pending state', csv.text.includes('pending'));
    check('CSV formats the amount', /\$70/.test(csv.text), csv.text.split('\n')[1]);
  }

  /* ===================================================== EMAIL =========== */

  console.log('\n— email configuration');
  {
    const m = await req('GET', '/api/meta');
    eq('meta names the provider', m.json.email.provider, 'resend');
    eq('meta says it delivers', m.json.email.delivers, true);
    eq('meta exposes the from address', m.json.email.from, 'Gather <hello@gather.test>');
    const h = await req('GET', '/api/health');
    eq('health reports email', h.json.email, true);
    check('health reports outbox counts', typeof h.json.outbox?.queued === 'number');
  }

  console.log('\n— confirmation email for a free registration');
  {
    // Flush everything the earlier sections queued so later counts are clean.
    await drainEmail();

    const freeSlug = (await req('POST', '/api/events', {
      token: hostToken,
      body: {
        title: 'Email Confirmation Test', summary: 'Checking the post.',
        startsAt: iso(9, 18), endsAt: iso(9, 20), category: 'Community',
        mode: 'in_person', city: 'Brooklyn, NY', venueName: 'The Hall',
        capacity: 5, priceCents: 0,
      },
    })).json.event.slug;

    const addr = 'mailtest.free@example.com';
    const token = await signIn(addr, 'Mail Tester');
    await req('POST', `/api/events/${freeSlug}/registrations`, { token, body: { guests: 2 } });

    const queued = outboxRows('registration_confirmed', addr);
    eq('registering queues exactly one confirmation', queued.length, 1);
    eq('  ...queued, not sent inline', queued[0].status, 'queued');
    eq('  ...with nothing sent yet', mailStub.to(addr).length, 0);

    const drained = await drainEmail();
    eq('draining sends it', drained.json.sent >= 1, true);
    eq('  ...and marks the row sent', outboxRow(queued[0].id).status, 'sent');
    check('  ...recording the provider id', Boolean(outboxRow(queued[0].id).provider_id));

    const sent = mailStub.to(addr);
    eq('one message arrived', sent.length, 1);
    const msg = sent[0];
    eq('  ...from the configured address', msg.from, 'Gather <hello@gather.test>');
    eq('  ...with the right subject', msg.subject, "You're going: Email Confirmation Test");
    check('  ...carrying an HTML part', msg.html.includes('Email Confirmation Test'));
    check('  ...and a plain text part', msg.text.includes('Email Confirmation Test'));
    check('  ...naming the recipient', msg.html.includes('Mail'), 'greeting');
    check('  ...stating the party size', msg.text.includes('2 people'));
    check('  ...and the venue', msg.text.includes('The Hall'));
    check('  ...with no unrendered placeholders', !/undefined|\[object|\$\{/.test(msg.html));

    eq('a calendar invite is attached', msg.attachments.length, 1);
    eq('  ...named after the event', msg.attachments[0].filename, `${freeSlug}.ics`);
    const ics = icsText(msg.attachments[0]);
    check('  ...containing a real VEVENT',
      ics.startsWith('BEGIN:VCALENDAR') && ics.includes('SUMMARY:Email Confirmation Test'));

    const again = await drainEmail();
    eq('draining again sends nothing', again.json.sent, 0);
    eq('  ...and does not duplicate the message', mailStub.to(addr).length, 1);
  }

  console.log('\n— waitlist email says you were not charged');
  {
    const addr = 'mailtest.wait@example.com';
    const token = await signIn(addr, 'Wait Tester');
    await req('POST', '/api/events/hand-building-ceramics-beginner-night/registrations', {
      token, body: { guests: 1 },
    });
    await drainEmail();
    const msg = mailStub.to(addr).at(-1);
    check('the waitlist email arrives', Boolean(msg));
    eq('  ...with the right subject', msg.subject, "You're on the waitlist for Hand-Building Ceramics: Beginner Night");
    check('  ...promising no charge', /have not been charged|always free/i.test(msg.text));
    eq('  ...and no calendar invite', msg.attachments.length, 0);
  }

  console.log('\n— the waitlist offer email, which carries a deadline');
  {
    const offerAddr = 'mailtest.offer@example.com';
    const holderAddr = 'mailtest.holder@example.com';
    const offerSlug2 = await makePaidEvent(hostToken, {
      title: 'Offer Email Test', priceCents: 3000, capacity: 1,
    });
    const holder = await signIn(holderAddr, 'Holder');
    const waiter = await signIn(offerAddr, 'Wanda Waiter');
    await req('POST', `/api/events/${offerSlug2}/registrations`, { token: holder, body: { guests: 1 } });
    await req('POST', `/api/events/${offerSlug2}/registrations`, { token: waiter, body: { guests: 1 } });

    // Holder walks away; the seat should be offered onward.
    await req('POST', `/api/events/${offerSlug2}/registrations/mine/release`, { token: holder });
    const queued = outboxRows('waitlist_offer', offerAddr);
    eq('an offer email is queued', queued.length, 1);
    await drainEmail();

    const msg = mailStub.to(offerAddr).at(-1);
    check('the offer email arrives', Boolean(msg));
    check('  ...with an urgent subject', /A spot opened up for Offer Email Test — claim it by/.test(msg.subject), msg.subject);
    check('  ...stating the amount due', msg.text.includes('$30'));
    check('  ...and the claim deadline', /Claim by:/.test(msg.text));
    check('  ...linking to the event', msg.html.includes(`/#/e/${offerSlug2}`));
    check('  ...reiterating that waiting is free', /Nobody is charged to sit on a waitlist/i.test(msg.text));
  }

  console.log('\n— paid confirmation doubles as a receipt');
  {
    const addr = 'mailtest.paid@example.com';
    const buyer = await signIn(addr, 'Paying Person');
    const paidSlug2 = await makePaidEvent(hostToken, {
      title: 'Receipt Email Test', priceCents: 4500, capacity: 3,
    });
    await req('POST', `/api/events/${paidSlug2}/registrations`, { token: buyer, body: { guests: 2 } });
    eq('no confirmation while the payment is only pending', outboxRows('registration_confirmed', addr).length, 0);

    const session = stub.sessions.find((s) => s.metadata.event_slug === paidSlug2);
    await sendWebhook(completedEvent(session));
    await drainEmail();

    const msg = mailStub.to(addr).at(-1);
    check('the confirmation arrives after payment', Boolean(msg));
    eq('  ...with the right subject', msg.subject, "You're going: Receipt Email Test");
    check('  ...showing what was paid', msg.text.includes('Paid: $90'));
    eq('  ...with the calendar invite', msg.attachments.length, 1);

    // Webhook redelivery under a fresh event id must not re-send.
    const before = mailStub.to(addr).length;
    await sendWebhook(completedEvent(session, 'evt_email_dedupe_check'));
    await drainEmail();
    eq('a redelivered payment does not email twice', mailStub.to(addr).length, before);
  }

  console.log('\n— lapsed holds and refunds are explained, not left silent');
  {
    const addr = 'mailtest.lapsed@example.com';
    const token = await signIn(addr, 'Lapsed Larry');
    const lapseSlug = await makePaidEvent(hostToken, {
      title: 'Lapsed Email Test', priceCents: 2000, capacity: 1,
    });
    await req('POST', `/api/events/${lapseSlug}/registrations`, { token, body: { guests: 1 } });
    const session = stub.sessions.find((s) => s.metadata.event_slug === lapseSlug);
    backdateHold(session.client_reference_id);
    await req('POST', '/api/admin/sweep');
    await drainEmail();

    const msg = mailStub.to(addr).at(-1);
    eq('the lapsed hold is explained', msg.subject, 'Your held seats for Lapsed Email Test were released');
    check('  ...confirming no charge', /were not charged/i.test(msg.text));

    // Their payment then turns up late, with the seat already gone.
    const other = await signIn('mailtest.tookit@example.com', 'Took It');
    await req('POST', `/api/events/${lapseSlug}/registrations`, { token: other, body: { guests: 1 } });
    const otherSession = stub.sessions.filter((s) => s.metadata.event_slug === lapseSlug).at(-1);
    await sendWebhook(completedEvent(otherSession));
    await sendWebhook(completedEvent(session));
    await drainEmail();

    const refundMsg = mailStub.to(addr).at(-1);
    eq('the refund is explained', refundMsg.subject, 'Refunded: Lapsed Email Test');
    check('  ...with the amount', refundMsg.text.includes('Refunded: $20'));
    check('  ...and why', /rather refund you than oversell/i.test(refundMsg.text));
  }

  console.log('\n— cancelling a registration confirms itself');
  {
    const addr = 'mailtest.cancel@example.com';
    const token = await signIn(addr, 'Cancel Carl');
    const slug2 = (await req('POST', '/api/events', {
      token: hostToken,
      body: {
        title: 'Cancel Email Test', startsAt: iso(11, 18), city: 'Brooklyn, NY',
        mode: 'in_person', capacity: 4, priceCents: 0,
      },
    })).json.event.slug;
    await req('POST', `/api/events/${slug2}/registrations`, { token, body: { guests: 1 } });
    await req('DELETE', `/api/events/${slug2}/registrations/mine`, { token });
    await drainEmail();
    const msg = mailStub.to(addr).at(-1);
    eq('the cancellation is acknowledged', msg.subject, 'Registration cancelled: Cancel Email Test');
  }

  console.log('\n— cancelling an event notifies everyone still holding a place');
  {
    const fanSlug = (await req('POST', '/api/events', {
      token: hostToken,
      body: {
        title: 'Fan Out Test', startsAt: iso(13, 18), city: 'Brooklyn, NY',
        mode: 'in_person', capacity: 2, priceCents: 0,
      },
    })).json.event.slug;

    const a = await signIn('fan.a@example.com', 'Fan A');
    const b = await signIn('fan.b@example.com', 'Fan B');
    const c = await signIn('fan.c@example.com', 'Fan C');
    const d = await signIn('fan.d@example.com', 'Fan D');
    await req('POST', `/api/events/${fanSlug}/registrations`, { token: a, body: { guests: 1 } });
    await req('POST', `/api/events/${fanSlug}/registrations`, { token: b, body: { guests: 1 } });
    await req('POST', `/api/events/${fanSlug}/registrations`, { token: c, body: { guests: 1 } }); // waitlisted
    await req('POST', `/api/events/${fanSlug}/registrations`, { token: d, body: { guests: 1 } }); // waitlisted
    // D leaves of their own accord and should hear nothing more about it.
    await req('DELETE', `/api/events/${fanSlug}/registrations/mine`, { token: d });
    await drainEmail();

    const beforeD = mailStub.to('fan.d@example.com').length;
    await req('POST', `/api/events/${fanSlug}/cancel`, { token: hostToken });

    const queued = direct.raw.prepare(
      "SELECT to_email FROM email_outbox WHERE type = 'event_cancelled' AND status = 'queued'",
    ).all().map((r) => r.to_email);
    eq('everyone still holding a place is queued', queued.length, 3);
    check('  ...confirmed attendees included', queued.includes('fan.a@example.com'));
    check('  ...waitlisted people included too', queued.includes('fan.c@example.com'));
    eq('  ...but not someone who already left', queued.includes('fan.d@example.com'), false);

    await drainEmail();
    eq('all three are sent', mailStub.to('fan.a@example.com').at(-1).subject, 'Cancelled: Fan Out Test');
    check('  ...telling the waitlisted person their place was on the waitlist',
      /On the waitlist/i.test(mailStub.to('fan.c@example.com').at(-1).text));
    eq('  ...and the departed guest hears nothing new', mailStub.to('fan.d@example.com').length, beforeD);

    // Cancelling twice must not re-notify. (fan.a legitimately holds two
    // messages by now: their confirmation, then this cancellation.)
    const countRows = () => direct.raw.prepare(
      "SELECT COUNT(*) AS n FROM email_outbox WHERE type = 'event_cancelled'",
    ).get().n;
    const rowsBefore = countRows();
    const sentBefore = mailStub.to('fan.a@example.com').length;
    eq('fan A has a confirmation and a cancellation', sentBefore, 2);

    await req('POST', `/api/events/${fanSlug}/cancel`, { token: hostToken });
    await drainEmail();
    eq('cancelling twice queues nothing new', countRows(), rowsBefore);
    eq('  ...and sends nothing new', mailStub.to('fan.a@example.com').length, sentBefore);
  }

  console.log('\n— transient provider failures retry with backoff');
  {
    const addr = 'mailtest.retry@example.com';
    const token = await signIn(addr, 'Retry Rita');
    const slug2 = (await req('POST', '/api/events', {
      token: hostToken,
      body: {
        title: 'Retry Email Test', startsAt: iso(15, 18), city: 'Brooklyn, NY',
        mode: 'in_person', capacity: 4, priceCents: 0,
      },
    })).json.event.slug;

    mailStub.failNext(1, 503);
    await req('POST', `/api/events/${slug2}/registrations`, { token, body: { guests: 1 } });
    const rowId = outboxRows('registration_confirmed', addr)[0].id;
    const drained = await drainEmail();
    eq('the failure is counted, not lost', drained.json.retrying, 1);

    const failed = outboxRow(rowId);
    eq('  ...the row goes back to queued', failed.status, 'queued');
    eq('  ...with one attempt spent', failed.attempts, 1);
    check('  ...the error recorded', /503|Simulated/.test(failed.last_error || ''), failed.last_error);
    check('  ...and a future retry time', new Date(failed.next_attempt_at).getTime() > Date.now());
    eq('  ...and nothing delivered yet', mailStub.to(addr).length, 0);

    // Let the backoff elapse; the retry should go through.
    makeEmailDue(rowId);
    const second = await drainEmail();
    eq('the retry succeeds', second.json.sent, 1);
    eq('  ...marking it sent', outboxRow(rowId).status, 'sent');
    eq('  ...and delivering exactly once', mailStub.to(addr).length, 1);
  }

  console.log('\n— permanent rejections are not retried six times');
  {
    const addr = 'mailtest.rejected@example.com';
    const token = await signIn(addr, 'Rejected Ray');
    const slug2 = (await req('POST', '/api/events', {
      token: hostToken,
      body: {
        title: 'Rejected Email Test', startsAt: iso(17, 18), city: 'Brooklyn, NY',
        mode: 'in_person', capacity: 4, priceCents: 0,
      },
    })).json.event.slug;

    mailStub.failNext(1, 422); // e.g. a rejected recipient — retrying is pointless
    await req('POST', `/api/events/${slug2}/registrations`, { token, body: { guests: 1 } });
    const rowId = outboxRows('registration_confirmed', addr)[0].id;
    const drained = await drainEmail();
    eq('it is dead-lettered', drained.json.dead, 1);
    const row = outboxRow(rowId);
    eq('  ...immediately', row.status, 'dead');
    eq('  ...after a single attempt', row.attempts, 1);
    check('  ...with the reason kept', Boolean(row.last_error));
  }

  console.log('\n— retries eventually give up');
  {
    const addr = 'mailtest.giveup@example.com';
    const token = await signIn(addr, 'Give Up Gary');
    const slug2 = (await req('POST', '/api/events', {
      token: hostToken,
      body: {
        title: 'Give Up Email Test', startsAt: iso(19, 18), city: 'Brooklyn, NY',
        mode: 'in_person', capacity: 4, priceCents: 0,
      },
    })).json.event.slug;
    await req('POST', `/api/events/${slug2}/registrations`, { token, body: { guests: 1 } });
    const rowId = outboxRows('registration_confirmed', addr)[0].id;

    setEmailAttempts(rowId, 5); // one short of the limit
    mailStub.failNext(1, 503);
    await drainEmail();
    eq('the last attempt dead-letters it', outboxRow(rowId).status, 'dead');
    const stats = (await req('GET', '/api/admin/outbox')).json.stats;
    check('the dead letters are visible for a human', stats.dead >= 2, JSON.stringify(stats));
  }

  console.log('\n— provider adapters speak the right protocol');
  {
    const saved = { ...process.env };
    const message = {
      to: 'shape@example.com', subject: 'Shape check',
      html: '<p>hi</p>', text: 'hi',
      attachments: [{ filename: 'x.ics', content: 'QUJD', contentType: 'text/calendar' }],
    };

    process.env.EMAIL_PROVIDER = 'resend';
    process.env.EMAIL_API_BASE = mailStub.url;
    process.env.EMAIL_API_KEY = 'rs_adapter_key';
    process.env.EMAIL_FROM = 'Adapter <a@b.test>';
    const rOut = await mail.send(message);
    const rReq = mailStub.requests.at(-1);
    eq('resend posts to /emails', rReq.path, '/emails');
    eq('  ...with bearer auth', rReq.authorization, 'Bearer rs_adapter_key');
    check('  ...recipients as an array', Array.isArray(rReq.body.to) && rReq.body.to[0] === 'shape@example.com');
    eq('  ...html and text both present', Boolean(rReq.body.html && rReq.body.text), true);
    eq('  ...attachment uses content_type', rReq.body.attachments[0].content_type, 'text/calendar');
    check('  ...returning the provider id', /^re_stub_/.test(rOut.providerId), rOut.providerId);

    process.env.EMAIL_PROVIDER = 'postmark';
    process.env.EMAIL_API_KEY = 'pm_adapter_key';
    const pOut = await mail.send(message);
    const pReq = mailStub.requests.at(-1);
    eq('postmark posts to /email', pReq.path, '/email');
    eq('  ...with the server token header', pReq.postmarkToken, 'pm_adapter_key');
    eq('  ...using capitalised fields', pReq.body.Subject, 'Shape check');
    eq('  ...with a message stream', pReq.body.MessageStream, 'outbound');
    eq('  ...and a bare To address', pReq.body.To, 'shape@example.com');
    eq('  ...attachment uses Name/Content/ContentType', pReq.body.Attachments[0].Name, 'x.ics');
    check('  ...returning the provider id', /^pm_stub_/.test(pOut.providerId), pOut.providerId);

    // Error classification decides retry vs dead-letter, so check it directly.
    mailStub.failNext(1, 503);
    let transient = null;
    try { await mail.send(message); } catch (err) { transient = err; }
    eq('a 503 is retryable', transient?.retryable, true);
    mailStub.failNext(1, 422);
    let permanent = null;
    try { await mail.send(message); } catch (err) { permanent = err; }
    eq('a 422 is not retryable', permanent?.retryable, false);

    process.env.EMAIL_PROVIDER = 'console';
    delete process.env.EMAIL_API_KEY;
    eq('console transport does not claim to deliver', mail.emailDelivers(), false);

    for (const k of ['EMAIL_PROVIDER', 'EMAIL_API_BASE', 'EMAIL_API_KEY', 'EMAIL_FROM']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }

  console.log('\n— every template renders');
  {
    const event = direct.getEventBySlug('rooftop-sessions-jazz-small-plates');
    const user = direct.getUserByEmail('maya@rooftopsessions.example');
    const payload = {
      guests: 2, amountCents: 7000, currency: 'usd',
      claimBy: new Date(Date.now() + 20 * 3600e3).toISOString(),
      reason: 'seat_gone', wasOffer: true, wasPaid: true, hadStatus: 'confirmed',
    };
    for (const type of EMAIL_TYPES) {
      const out = renderEmail(type, { event, registration: null, user, payload, baseUrl: 'https://x.test' });
      check(`${type} renders`,
        Boolean(out.subject) && out.html.length > 400 && out.text.length > 60);
      check(`  ...${type} has no leaked placeholders`,
        !/undefined|\[object Object\]|\$\{/.test(out.subject + out.html + out.text));
    }
    let threw = null;
    try { renderEmail('not_a_real_type', { event, user, payload }); } catch (err) { threw = err; }
    check('an unknown type throws rather than sending blank mail', Boolean(threw));
  }

  console.log('\n— the page the server serves talks to the API');
  {
    const served = await (await fetch(`${BASE}/`)).text();
    check('the server wires the page it serves to its own API',
      served.includes('window.GATHER_API_BASE = window.GATHER_API_BASE || location.origin;'));
    const deep = await (await fetch(`${BASE}/e/anything-at-all`)).text();
    check('  ...on deep links served as the app shell too', deep.includes('|| location.origin;'));
    const committed = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    check('  ...while the committed standalone file stays on-device',
      committed.includes('window.GATHER_API_BASE = window.GATHER_API_BASE || null;'));

    const ui = await bootUi(BASE);
    const S = ui.window.__GATHER__?.Store;
    eq('the front end boots and picks the API store', S?.mode, 'remote');
    check('  ...and its footer says it is connected to the API', ui.root.innerHTML.includes('Connected to the API'));
    check('  ...with live Stripe Checkout', ui.root.innerHTML.includes('Stripe Checkout live'));
    check('  ...and delivering email', ui.root.innerHTML.includes('Email via resend'));

    const me = await S.signIn({ email: 'ui.client@example.com', name: 'UI Client' });
    eq('signing in through the UI client works', me.email, 'ui.client@example.com');
    eq('  ...and the session sticks', (await S.me())?.email, 'ui.client@example.com');

    const listed = await S.listEvents({ when: 'upcoming' });
    check('browse through the UI client returns seeded events',
      listed.some((e) => e.slug === 'rust-for-javascript-developers'));
    const music = await S.listEvents({ category: 'Music' });
    check('  ...and passes filters through', music.length > 0 && music.every((e) => e.category === 'Music'));

    const free = await S.register('rust-for-javascript-developers', { guests: 2, note: 'via the UI client' });
    eq('a free registration through the UI client confirms', free.status, 'confirmed');
    const detail = await S.getEvent('rust-for-javascript-developers');
    eq('  ...the detail view sees it', detail.myRegistration?.status, 'confirmed');
    eq('  ...with the party size', detail.myRegistration?.guests, 2);
    check('  ...and it appears in my tickets',
      (await S.myRegistrations()).some((r) => r.event.slug === 'rust-for-javascript-developers'));
    eq('cancelling through the UI client works',
      typeof (await S.cancelRegistration('rust-for-javascript-developers')).promoted, 'number');

    const paid = await S.register('rooftop-sessions-jazz-small-plates', { guests: 1 });
    eq('a paid registration through the UI client asks for payment', paid.status, 'payment_required');
    check('  ...with a Stripe checkout url to redirect to',
      /^https:\/\/checkout\.stripe\.test\//.test(paid.checkoutUrl || ''), paid.checkoutUrl);
    eq('  ...and the client sees the pending hold',
      (await S.getEvent('rooftop-sessions-jazz-small-plates')).myRegistration?.status, 'pending');
    eq('releasing the hold through the UI client works',
      (await S.releaseHold('rooftop-sessions-jazz-small-plates')).released, true);

    await S.signOut();
    eq('signing out through the UI client works', await S.me(), null);

    await S.signIn({ email: 'lena@kilnandco.example', name: 'Lena Brandt' });
    check('a seeded host sees their events through the UI client',
      (await S.myEvents()).some((e) => e.slug === 'hand-building-ceramics-beginner-night'));
    check('  ...and their guest list',
      (await S.listRegistrations('hand-building-ceramics-beginner-night')).length >= 12);

    const created = await S.createEvent({
      title: 'Made Through The UI Client', summary: 'Proves the create form reaches the API.',
      startsAt: iso(23, 18), endsAt: iso(23, 20), mode: 'in_person', city: 'Portland, OR',
      category: 'Arts', capacity: 5, priceCents: 0, currency: 'usd', status: 'published',
    });
    eq('creating an event through the UI client works', created.slug, 'made-through-the-ui-client');
    eq('  ...and editing it', (await S.updateEvent(created.slug, { summary: 'Edited.' })).summary, 'Edited.');

    let refused = null;
    try { await S.register(created.slug, { guests: 1 }); } catch (err) { refused = err; }
    eq('server errors reach the UI with their code', refused?.code, 'host_cannot_register');
    check('  ...and their human-readable message', /hosting this one/i.test(refused?.message || ''));
  }

  console.log('\n— the standalone demo never goes stale');
  {
    const DAY = 86400000;
    // Built on Oct 1, viewed on Dec 1: two months later, across the US end
    // of daylight saving (Nov 1, 2026) — the case that breaks naive shifting.
    const builtAt = Date.UTC(2026, 9, 1, 16, 0);
    const viewedAt = Date.UTC(2026, 11, 1, 16, 0);
    const seed = { ...buildSeed({ from: builtAt }), builtAt };
    const upcomingAt = (s, at) => s.events
      .filter((e) => new Date(e.endsAt || e.startsAt).getTime() >= at).length;

    eq('a fresh build has 8 upcoming events', upcomingAt(seed, builtAt), 8);
    eq('  ...all of which go stale if nothing rebases them', upcomingAt(seed, viewedAt), 0);

    const same = rebaseSeed(seed, builtAt + 5000);
    eq('rebasing a freshly built seed changes nothing',
      JSON.stringify(same.events), JSON.stringify(seed.events));

    const moved = rebaseSeed(seed, viewedAt);
    eq('rebased two months on, all 8 are upcoming again', upcomingAt(moved, viewedAt), 8);
    eq('  ...and the past event stays in the past', moved.events.length - upcomingAt(moved, viewedAt), 1);

    const wall = (iso, tz) => new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(iso));
    check('every event keeps its local start time across the DST change',
      seed.events.every((e, i) => wall(e.startsAt, e.timezone) === wall(moved.events[i].startsAt, e.timezone)));
    const jazzBefore = seed.events.find((e) => e.key === 'jazz');
    const jazzAfter = moved.events.find((e) => e.key === 'jazz');
    eq('  ...so the jazz night is still 19:30 in New York', wall(jazzAfter.startsAt, 'America/New_York'), '19:30');
    check('  ...even though its UTC offset moved by an hour',
      (new Date(jazzAfter.startsAt) - new Date(jazzBefore.startsAt)) % DAY === 3600000);
    check('durations are preserved exactly', seed.events.every((e, i) => {
      const m = moved.events[i];
      return (new Date(e.endsAt) - new Date(e.startsAt)) === (new Date(m.endsAt) - new Date(m.startsAt));
    }));

    const holdBefore = jazzBefore.registrations.find((r) => r.status === 'pending');
    const holdAfter = jazzAfter.registrations.find((r) => r.status === 'pending');
    eq('a seeded payment hold keeps its remaining time',
      new Date(holdAfter.holdExpiresAt).getTime() - viewedAt,
      new Date(holdBefore.holdExpiresAt).getTime() - builtAt);
    check('registration timestamps move by exactly the elapsed time',
      seed.events.every((e, i) => e.registrations.every((r, j) =>
        new Date(moved.events[i].registrations[j].createdAt) - new Date(r.createdAt) === viewedAt - builtAt)));

    // It is inlined into the page by its source text, so it must stand alone.
    const rebuilt = new Function(`return (${rebaseSeed.toString()});`)();
    eq('rebaseSeed behaves identically when rebuilt from its own source',
      JSON.stringify(rebuilt(seed, viewedAt)), JSON.stringify(moved));

    // And the copy actually embedded in the committed page works on its own.
    const committed = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const block = committed.match(/<script>\s*\/\* Injected by build\.mjs[\s\S]*?<\/script>/);
    check('the committed page carries the injected seed block', Boolean(block));
    const page = { window: {} };
    runInNewContext(block[0].replace(/^<script>/, '').replace(/<\/script>$/, ''), page);
    const embedded = page.window.GATHER_REBASE;
    eq('  ...including the rebase function', typeof embedded, 'function');
    if (typeof embedded === 'function' && typeof page.window.GATHER_SEED?.builtAt === 'number') {
      const ninetyDaysOn = page.window.GATHER_SEED.builtAt + 90 * DAY;
      eq('  ...which revives the committed seed 90 days after it was built',
        upcomingAt(embedded(page.window.GATHER_SEED, ninetyDaysOn), ninetyDaysOn), 8);
    } else {
      // Report rather than throw, so the freshness check below still runs.
      check('  ...which revives the committed seed 90 days after it was built', false,
        'the committed page has no rebase function or build timestamp');
    }

    // index.html is committed, so it must match its sources. Only the seed
    // line legitimately differs between two builds.
    const fresh = await renderIndex();
    check('public/index.html matches app.js and the template (run `npm run build` if this fails)',
      withoutSeedLine(committed) === withoutSeedLine(fresh.html));
  }

  console.log('\n— seed data can never email a real person');
  {
    // RFC 2606 / 6761 reserved names: guaranteed never to deliver.
    const reserved = /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/i;
    const addresses = SEED_USERS_FOR_AUDIT();
    eq('every seeded address uses a reserved, undeliverable domain',
      addresses.filter((a) => !reserved.test(a)).join(', '), '');
    eq('  ...all 42 of them', addresses.length, 42);
    check('  ...and the audit regex really rejects deliverable domains',
      !reserved.test('someone@gmail.com') && !reserved.test('x@notexample.com') && !reserved.test('x@example.com.evil.io'));

    const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const seedLine = page.split('\n').find((l) => l.startsWith('window.GATHER_SEED = '));
    const shipped = JSON.parse(seedLine.slice('window.GATHER_SEED = '.length).replace(/;\s*$/, ''))
      .users.map((u) => u.email);
    eq('  ...including every address shipped inside the standalone page',
      shipped.filter((a) => !reserved.test(a)).join(', '), '');
  }

  console.log('\n— a server with no Stripe keys degrades gracefully');
  {
    const nopay = `http://127.0.0.1:${PORT_NOPAY}`;
    const meta = await req('GET', '/api/meta', { base: nopay });
    eq('payments report as disabled', meta.json.payments.enabled, false);
    eq('webhooks report as disabled', meta.json.payments.webhooks, false);
    eq('email falls back to the console transport', meta.json.email.provider, 'console');
    eq('  ...and does not claim to deliver', meta.json.email.delivers, false);

    const token = await signIn('nopay.host@example.com', 'No Pay Host', nopay);
    const paid = await req('POST', '/api/events', {
      base: nopay, token,
      body: { title: 'Cannot Sell This', startsAt: iso(5), city: 'Nowhere', priceCents: 1000 },
    });
    eq('creating a paid event is refused', paid.status, 503);
    eq('  ...with a clear code', paid.json.error.code, 'payments_not_configured');

    const free = await req('POST', '/api/events', {
      base: nopay, token,
      body: { title: 'Free Still Works', startsAt: iso(5), city: 'Nowhere', priceCents: 0 },
    });
    eq('free events still publish', free.status, 201);
    const buyer = await signIn('nopay.buyer@example.com', 'Buyer', nopay);
    eq('  ...and still take registrations',
      (await req('POST', `/api/events/${free.json.event.slug}/registrations`, {
        base: nopay, token: buyer, body: { guests: 1 },
      })).json.status, 'confirmed');

    // The UI a newcomer actually sees after `npm run seed && npm start`.
    const ui = await bootUi(nopay);
    check('the UI footer says payments are not configured', ui.root.innerHTML.includes('Payments not configured'));
    check('  ...and that email is not sending', ui.root.innerHTML.includes('Email not sending'));
    ui.window.location.hash = '#/e/rooftop-sessions-jazz-small-plates';
    await ui.window.__GATHER__.render();
    check('a seeded paid event explains it cannot be sold here, before anyone tries',
      ui.root.innerHTML.includes('isn’t set up to take payments'));
    check('  ...instead of offering a register button', !ui.root.innerHTML.includes('data-act="register"'));

    const S = ui.window.__GATHER__.Store;
    await S.signIn({ email: 'nopay.attendee@example.com', name: 'No Pay Attendee' });
    const heldBefore = (await S.getEvent('rooftop-sessions-jazz-small-plates')).event.heldSeats;
    let refused = null;
    try { await S.register('rooftop-sessions-jazz-small-plates', { guests: 1 }); } catch (err) { refused = err; }
    eq('a paid registration attempted anyway is refused cleanly', refused?.code, 'payments_not_configured');
    eq('  ...without stranding a seat in a hold',
      (await S.getEvent('rooftop-sessions-jazz-small-plates')).event.heldSeats, heldBefore);
    eq('  ...or leaving the attendee half-registered',
      (await S.getEvent('rooftop-sessions-jazz-small-plates')).myRegistration, null);
    eq('free events still register through the UI',
      (await S.register('rust-for-javascript-developers', { guests: 1 })).status, 'confirmed');

    // Even with nowhere to send, the intent is recorded — so configuring a
    // provider later doesn't mean the notification was silently lost.
    const ob = await req('GET', '/api/admin/outbox', { base: nopay });
    check('the email intent is still recorded with no provider configured',
      (ob.json.stats.queued + ob.json.stats.sent) >= 1, JSON.stringify(ob.json.stats));

    const hook = await fetch(`${nopay}/api/stripe/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
      body: '{}',
    });
    eq('the webhook endpoint refuses without a secret', hook.status, 503);
  }

  /* ---------------------------------------------------------------- report */

  console.log(`\n${'─'.repeat(60)}`);
  if (failures.length) {
    console.log(`${passed} passed, ${failures.length} FAILED\n`);
    failures.forEach((f) => console.log(`  • ${f}`));
    await teardown(1);
  }
  console.log(`All ${passed} assertions passed.`);
  await teardown(0);
} catch (err) {
  console.error('\nharness error:', err);
  await teardown(1);
}
