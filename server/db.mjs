/**
 * db.mjs — Gather storage driver.
 *
 * This is deliberately the ONLY module that knows SQL exists. Everything the
 * rest of the app needs is exposed as a plain function that takes and returns
 * ordinary objects. That boundary is the whole point: to move Gather onto
 * Postgres (which you need for serverless hosting, where the filesystem is
 * ephemeral) you reimplement this one file and touch nothing else.
 *
 * Uses node:sqlite, built into Node 22+. No npm install, no native compile.
 *
 * ---------------------------------------------------------------------------
 * REGISTRATION STATE MACHINE
 *
 *   free event:      → confirmed
 *                    → waitlisted            (event already full)
 *
 *   paid event:      → pending               (seat HELD, awaiting payment)
 *                      ├─ payment succeeds → confirmed
 *                      ├─ hold lapses      → expired      (seat released)
 *                      └─ user abandons    → cancelled     (seat released)
 *                    → waitlisted            (event full — never charged)
 *
 *   promotion off the waitlist:
 *     free event     → confirmed
 *     paid event     → offered               (seat HELD, must pay to claim)
 *                      ├─ payment succeeds → confirmed
 *                      └─ offer lapses     → expired      (seat released,
 *                                                          next person offered)
 *
 * `pending` and `offered` occupy capacity while their hold is unexpired. That
 * is what stops the platform overselling during the checkout window, and what
 * stops two people paying for the same last seat.
 * ---------------------------------------------------------------------------
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

/* ------------------------------------------------------------------ errors */

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bad = (code, msg) => new AppError(400, code, msg);
const notFound = (msg = 'Not found') => new AppError(404, 'not_found', msg);
const conflict = (code, msg) => new AppError(409, code, msg);
const forbidden = (msg = 'Not your event') => new AppError(403, 'forbidden', msg);

/* --------------------------------------------------------------- constants */

/** Stripe requires a Checkout session to expire 30 min–24 h out, so 30 is the floor. */
export const HOLD_MINUTES = 30;
/** How long a promoted waitlister has to pay before the seat moves on. */
export const OFFER_HOURS = 24;
/** Our hold outlives Stripe's session so a payment can't land on a freed seat. */
const HOLD_GRACE_SECONDS = 120;

export const CATEGORIES = [
  'Tech', 'Music', 'Food & Drink', 'Fitness', 'Arts', 'Business', 'Community',
];
export const CURRENCIES = ['usd', 'eur', 'gbp', 'cad', 'aud', 'jpy'];

/** Statuses that mean "this person is still in play". */
const ACTIVE = ['confirmed', 'pending', 'offered', 'waitlisted'];
/** Statuses that occupy a seat while their hold is unexpired. */
const HOLDING = ['pending', 'offered'];

/**
 * SQLite's "now" rendered in exactly the format Date#toISOString produces, so
 * timestamp comparisons are plain lexicographic string compares.
 */
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/* ------------------------------------------------------------------ schema */

const SCHEMA = `
PRAGMA foreign_keys = ON;
-- WAL lets readers and a writer coexist, including across processes.
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  host_id      TEXT NOT NULL REFERENCES users(id),
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT 'Community',
  cover_url    TEXT,
  starts_at    TEXT NOT NULL,
  ends_at      TEXT,
  timezone     TEXT NOT NULL DEFAULT 'America/New_York',
  mode         TEXT NOT NULL DEFAULT 'in_person',
  venue_name   TEXT,
  address      TEXT,
  city         TEXT,
  online_url   TEXT,
  capacity     INTEGER,
  price_cents  INTEGER NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'usd',
  status       TEXT NOT NULL DEFAULT 'published',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_at);
CREATE INDEX IF NOT EXISTS idx_events_host   ON events(host_id);

CREATE TABLE IF NOT EXISTS registrations (
  id                  TEXT PRIMARY KEY,
  event_id            TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES users(id),
  guests              INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL,
  note                TEXT,
  amount_cents        INTEGER NOT NULL DEFAULT 0,
  currency            TEXT,
  hold_expires_at     TEXT,
  stripe_session_id   TEXT,
  stripe_checkout_url TEXT,
  stripe_payment_intent TEXT,
  paid_at             TEXT,
  refund_due          INTEGER NOT NULL DEFAULT 0,
  refunded_at         TEXT,
  created_at          TEXT NOT NULL
);
-- One registration row per person per event. Inactive rows are reused on
-- re-registration rather than duplicated, so this constraint always holds.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reg_event_user ON registrations(event_id, user_id);
CREATE INDEX IF NOT EXISTS idx_reg_event  ON registrations(event_id, status);
CREATE INDEX IF NOT EXISTS idx_reg_holds  ON registrations(status, hold_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reg_session ON registrations(stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL
);

-- Webhook idempotency. Stripe delivers at least once, so the same event id
-- can arrive twice; the primary key makes reprocessing a no-op.
CREATE TABLE IF NOT EXISTS stripe_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  received_at  TEXT NOT NULL
);

-- Permanent session -> registration map.
--
-- registrations.stripe_session_id only tracks the CURRENT checkout attempt and
-- is cleared when a row is reused. Without this table, a payment that lands
-- late on a superseded session would resolve to nothing — meaning we'd quietly
-- keep money for a seat we never gave anyone. Rows here are never deleted.
CREATE TABLE IF NOT EXISTS stripe_checkout_sessions (
  session_id      TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL DEFAULT 0,
  currency        TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_reg
  ON stripe_checkout_sessions(registration_id);

-- Transactional outbox for email.
--
-- The intent row is written in the SAME transaction as the state change it
-- describes, so "registered but never emailed" cannot happen. A worker drains
-- it afterwards, which keeps a slow provider out of the request path and stops
-- an email failure from turning a Stripe webhook into a 500 (and therefore a
-- retry, and therefore a duplicate message).
--
-- The payload column snapshots what to say, because state can move on before
-- the worker runs — a lapsed hold has already been cleared by the time we'd
-- want to describe it.
--
-- dedupe_key makes a redelivered webhook or a repeated fan-out send once. It
-- embeds a discriminator (usually the registration's created_at, which is reset
-- when a row is reused) so a genuinely new notification still gets through.
CREATE TABLE IF NOT EXISTS email_outbox (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,
  dedupe_key       TEXT NOT NULL UNIQUE,
  registration_id  TEXT,
  event_id         TEXT,
  user_id          TEXT NOT NULL,
  to_email         TEXT NOT NULL,
  payload          TEXT,
  status           TEXT NOT NULL DEFAULT 'queued',
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TEXT NOT NULL,
  last_error       TEXT,
  provider_id      TEXT,
  subject          TEXT,
  created_at       TEXT NOT NULL,
  sent_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON email_outbox(status, next_attempt_at);
`;

/**
 * Bring a database created by an earlier version up to date. Fresh databases
 * get everything from SCHEMA and skip all of this.
 */
function migrate(db) {
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  const ev = columns('events');
  if (ev.length && !ev.includes('price_cents')) {
    db.exec('ALTER TABLE events ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0');
    db.exec("ALTER TABLE events ADD COLUMN currency TEXT NOT NULL DEFAULT 'usd'");
    // Older rows carried a display-only label like "$55". Recover a real
    // amount from it so previously-paid events don't silently become free.
    if (ev.includes('price_label')) {
      for (const row of db.prepare('SELECT id, price_label FROM events').all()) {
        const m = /(\d+(?:\.\d{1,2})?)/.exec(row.price_label || '');
        db.prepare('UPDATE events SET price_cents = ? WHERE id = ?')
          .run(m ? Math.round(parseFloat(m[1]) * 100) : 0, row.id);
      }
    }
  }

  const reg = columns('registrations');
  if (reg.length) {
    const adds = {
      amount_cents: 'INTEGER NOT NULL DEFAULT 0',
      currency: 'TEXT',
      hold_expires_at: 'TEXT',
      stripe_session_id: 'TEXT',
      stripe_checkout_url: 'TEXT',
      stripe_payment_intent: 'TEXT',
      paid_at: 'TEXT',
      refund_due: 'INTEGER NOT NULL DEFAULT 0',
      refunded_at: 'TEXT',
    };
    for (const [col, decl] of Object.entries(adds)) {
      if (!reg.includes(col)) db.exec(`ALTER TABLE registrations ADD COLUMN ${col} ${decl}`);
    }
  }
}

/* ------------------------------------------------------------------ shapes */

const now = () => new Date().toISOString();
const plusMinutes = (mins) => new Date(Date.now() + mins * 60_000).toISOString();
const plusHours = (hrs) => new Date(Date.now() + hrs * 3_600_000).toISOString();

function slugify(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60) || 'event';
}

function shapeEvent(row) {
  if (!row) return null;
  const capacity = row.capacity ?? null;
  const confirmedSeats = row.confirmed_seats ?? 0;
  const heldSeats = row.held_seats ?? 0;
  const takenSeats = confirmedSeats + heldSeats;
  const seatsLeft = capacity === null ? null : Math.max(0, capacity - takenSeats);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    description: row.description,
    category: row.category,
    coverUrl: row.cover_url,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    mode: row.mode,
    venueName: row.venue_name,
    address: row.address,
    city: row.city,
    onlineUrl: row.online_url,
    capacity,
    priceCents: row.price_cents ?? 0,
    currency: row.currency || 'usd',
    isPaid: (row.price_cents ?? 0) > 0,
    status: row.status,
    createdAt: row.created_at,
    host: { id: row.host_id, name: row.host_name, email: row.host_email },
    confirmedSeats,
    heldSeats,
    takenSeats,
    waitlistCount: row.waitlist_count ?? 0,
    seatsLeft,
    isFull: capacity !== null && seatsLeft === 0,
    isPast: new Date(row.ends_at || row.starts_at).getTime() < Date.now(),
  };
}

function shapeRegistration(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    guests: row.guests,
    status: row.status,
    note: row.note,
    amountCents: row.amount_cents ?? 0,
    currency: row.currency,
    holdExpiresAt: row.hold_expires_at,
    checkoutUrl: row.stripe_checkout_url,
    paidAt: row.paid_at,
    refundDue: Boolean(row.refund_due),
    refundedAt: row.refunded_at,
    createdAt: row.created_at,
    user: row.user_name
      ? { id: row.user_id, name: row.user_name, email: row.user_email }
      : undefined,
  };
}

const EVENT_SELECT = `
  SELECT e.*, u.name AS host_name, u.email AS host_email,
    (SELECT COALESCE(SUM(r.guests), 0) FROM registrations r
      WHERE r.event_id = e.id AND r.status = 'confirmed') AS confirmed_seats,
    (SELECT COALESCE(SUM(r.guests), 0) FROM registrations r
      WHERE r.event_id = e.id AND r.status IN ('pending','offered')
        AND (r.hold_expires_at IS NULL OR r.hold_expires_at > ${NOW_SQL})) AS held_seats,
    (SELECT COUNT(*) FROM registrations r
      WHERE r.event_id = e.id AND r.status = 'waitlisted') AS waitlist_count
  FROM events e
  JOIN users u ON u.id = e.host_id
`;

/* ------------------------------------------------------------------- driver */

export function openDb(file = 'gather.db') {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already unwound */ }
      throw err;
    }
  }

  /* ---------------------------------------------------------------- users */

  const getUserByEmail = (email) =>
    db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase()) ?? null;
  const getUserById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;

  function upsertUser({ email, name }) {
    const clean = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw bad('invalid_email', 'That email does not look right.');
    const existing = getUserByEmail(clean);
    if (existing) {
      if (name && name.trim() && name.trim() !== existing.name) {
        db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), existing.id);
        return getUserById(existing.id);
      }
      return existing;
    }
    const user = {
      id: randomUUID(), email: clean,
      name: (name || '').trim() || clean.split('@')[0], created_at: now(),
    };
    db.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)')
      .run(user.id, user.email, user.name, user.created_at);
    return user;
  }

  /* ------------------------------------------------------------- sessions */

  function createSession(userId) {
    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
      .run(token, userId, now());
    return token;
  }
  const userForSession = (token) => (token
    ? db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token) ?? null
    : null);
  const destroySession = (token) => {
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  };

  /* --------------------------------------------------------------- events */

  function uniqueSlug(title) {
    const base = slugify(title);
    let slug = base;
    let n = 2;
    while (db.prepare('SELECT 1 FROM events WHERE slug = ?').get(slug)) slug = `${base}-${n++}`;
    return slug;
  }

  function validateEventInput(input, { partial = false } = {}) {
    const out = {};
    if (!partial) {
      if (!String(input.title ?? '').trim()) throw bad('missing_field', 'Title is required.');
      if (!String(input.startsAt ?? '').trim()) throw bad('missing_field', 'Start date and time is required.');
    }
    if (input.title !== undefined) {
      const t = String(input.title).trim();
      if (t.length < 3) throw bad('invalid_title', 'Give the event a longer title.');
      if (t.length > 140) throw bad('invalid_title', 'Titles cap out at 140 characters.');
      out.title = t;
    }
    if (input.startsAt !== undefined) {
      const d = new Date(input.startsAt);
      if (Number.isNaN(d.getTime())) throw bad('invalid_date', 'That start date is not a real date.');
      out.starts_at = d.toISOString();
    }
    if (input.endsAt !== undefined) {
      if (!input.endsAt) out.ends_at = null;
      else {
        const d = new Date(input.endsAt);
        if (Number.isNaN(d.getTime())) throw bad('invalid_date', 'That end date is not a real date.');
        out.ends_at = d.toISOString();
      }
    }
    if (out.starts_at && out.ends_at && out.ends_at < out.starts_at) {
      throw bad('invalid_range', 'The event cannot end before it starts.');
    }
    if (input.category !== undefined) {
      if (!CATEGORIES.includes(input.category)) throw bad('invalid_category', 'Unknown category.');
      out.category = input.category;
    }
    if (input.mode !== undefined) {
      if (!['in_person', 'online'].includes(input.mode)) throw bad('invalid_mode', 'Mode must be in_person or online.');
      out.mode = input.mode;
    }
    if (input.capacity !== undefined) {
      if (input.capacity === null || input.capacity === '') out.capacity = null;
      else {
        const c = Number(input.capacity);
        if (!Number.isInteger(c) || c < 1 || c > 100000) {
          throw bad('invalid_capacity', 'Capacity must be a whole number of at least 1.');
        }
        out.capacity = c;
      }
    }
    if (input.priceCents !== undefined) {
      const p = Number(input.priceCents);
      if (!Number.isInteger(p) || p < 0) throw bad('invalid_price', 'Price must be a whole number of cents, or zero for free.');
      // Stripe's own minimum charge is about 50 cents in most currencies.
      if (p > 0 && p < 50) throw bad('invalid_price', 'Paid tickets must be at least 50 cents. Use zero for a free event.');
      if (p > 100_000_00) throw bad('invalid_price', 'That price is implausibly high.');
      out.price_cents = p;
    }
    if (input.currency !== undefined) {
      const c = String(input.currency || 'usd').toLowerCase();
      if (!CURRENCIES.includes(c)) throw bad('invalid_currency', `Currency must be one of: ${CURRENCIES.join(', ')}.`);
      out.currency = c;
    }
    if (input.status !== undefined) {
      if (!['draft', 'published', 'cancelled'].includes(input.status)) throw bad('invalid_status', 'Unknown status.');
      out.status = input.status;
    }
    for (const [key, col] of [
      ['summary', 'summary'], ['description', 'description'], ['coverUrl', 'cover_url'],
      ['timezone', 'timezone'], ['venueName', 'venue_name'], ['address', 'address'],
      ['city', 'city'], ['onlineUrl', 'online_url'],
    ]) {
      if (input[key] !== undefined) out[col] = input[key] === null ? null : String(input[key]).trim();
    }
    const mode = out.mode ?? input.mode;
    if (!partial) {
      if (mode === 'online' && !out.online_url) throw bad('missing_field', 'Online events need a join link.');
      if (mode !== 'online' && !out.city) throw bad('missing_field', 'In-person events need a city.');
    }
    return out;
  }

  const getEventRow = (slug) => db.prepare('SELECT * FROM events WHERE slug = ?').get(slug) ?? null;
  const getEventBySlug = (slug) => shapeEvent(db.prepare(`${EVENT_SELECT} WHERE e.slug = ?`).get(slug));
  const getEventById = (id) => shapeEvent(db.prepare(`${EVENT_SELECT} WHERE e.id = ?`).get(id));

  function createEvent(hostId, input) {
    const f = validateEventInput(input);
    const slug = uniqueSlug(f.title);
    db.prepare(`INSERT INTO events (
      id, slug, host_id, title, summary, description, category, cover_url,
      starts_at, ends_at, timezone, mode, venue_name, address, city, online_url,
      capacity, price_cents, currency, status, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), slug, hostId, f.title, f.summary ?? '', f.description ?? '',
      f.category ?? 'Community', f.cover_url ?? null, f.starts_at, f.ends_at ?? null,
      f.timezone || 'America/New_York', f.mode ?? 'in_person', f.venue_name ?? null,
      f.address ?? null, f.city ?? null, f.online_url ?? null, f.capacity ?? null,
      f.price_cents ?? 0, f.currency ?? 'usd', f.status ?? 'published', now(),
    );
    return getEventBySlug(slug);
  }

  function confirmedSeats(eventId) {
    return db.prepare(
      "SELECT COALESCE(SUM(guests), 0) AS n FROM registrations WHERE event_id = ? AND status = 'confirmed'",
    ).get(eventId).n;
  }

  /** Seats locked up by unexpired pending/offered holds. */
  function heldSeats(eventId) {
    return db.prepare(`
      SELECT COALESCE(SUM(guests), 0) AS n FROM registrations
      WHERE event_id = ? AND status IN ('pending','offered')
        AND (hold_expires_at IS NULL OR hold_expires_at > ${NOW_SQL})
    `).get(eventId).n;
  }

  /** What capacity is actually measured against. */
  const takenSeats = (eventId) => confirmedSeats(eventId) + heldSeats(eventId);

  function updateEvent(slug, actorId, patch) {
    const row = getEventRow(slug);
    if (!row) throw notFound('No event with that link.');
    if (row.host_id !== actorId) throw forbidden('Only the host can edit this event.');

    const f = validateEventInput(patch, { partial: true });

    // Never let a host shrink capacity below seats already committed — that
    // would silently oversell and there is no fair way to pick who loses out.
    if (f.capacity !== undefined && f.capacity !== null) {
      const taken = takenSeats(row.id);
      if (f.capacity < taken) {
        throw conflict('capacity_below_confirmed',
          `${taken} seats are already taken (including seats held for in-progress payments). Cancel registrations before lowering capacity below that.`);
      }
    }
    // Flipping a free event to paid, or vice versa, would leave existing
    // registrations in an incoherent state (people confirmed without paying,
    // or holds priced at zero).
    if (f.price_cents !== undefined && (f.price_cents > 0) !== (row.price_cents > 0)) {
      const active = db.prepare(
        `SELECT COUNT(*) AS n FROM registrations WHERE event_id = ? AND status IN (${ACTIVE.map(() => '?').join(',')})`,
      ).get(row.id, ...ACTIVE).n;
      if (active > 0) {
        throw conflict('price_change_blocked',
          'You cannot switch an event between free and paid while people are registered. Cancel the registrations first, or create a new event.');
      }
    }

    const keys = Object.keys(f);
    if (!keys.length) return getEventBySlug(slug);
    db.prepare(`UPDATE events SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => f[k]), row.id);

    // Freeing seats (raising capacity) may let waitlisted people in.
    if (f.capacity !== undefined) tx(() => promoteWaitlist(row.id));
    return getEventBySlug(slug);
  }

  function cancelEvent(slug, actorId) {
    const row = getEventRow(slug);
    if (!row) throw notFound('No event with that link.');
    if (row.host_id !== actorId) throw forbidden('Only the host can cancel this event.');
    return tx(() => {
      // Capture who still had a place BEFORE tearing their statuses down,
      // otherwise there is nobody left to notify.
      const affected = db.prepare(`
        SELECT id, user_id, guests, status, paid_at, amount_cents, currency
        FROM registrations
        WHERE event_id = ? AND status IN ('confirmed','pending','offered','waitlisted')
      `).all(row.id);

      db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(row.id);
      // Anyone mid-checkout should stop: release their holds so they aren't
      // charged for an event that no longer exists.
      db.prepare(`
        UPDATE registrations SET status = 'expired', hold_expires_at = NULL
        WHERE event_id = ? AND status IN ('pending','offered')
      `).run(row.id);

      for (const r of affected) {
        enqueueEmail({
          type: 'event_cancelled',
          dedupeKey: `event_cancelled:${r.id}`,
          registrationId: r.id, eventId: row.id, userId: r.user_id,
          payload: {
            guests: r.guests,
            hadStatus: r.status,
            wasPaid: Boolean(r.paid_at),
            amountCents: r.amount_cents,
            currency: r.currency,
          },
        });
      }
      return getEventBySlug(slug);
    });
  }

  function listEvents({ q, category, mode, when = 'upcoming', hostId, limit = 100 } = {}) {
    const where = [];
    const args = [];
    if (hostId) {
      where.push("(e.status = 'published' OR (e.host_id = ? AND e.status = 'draft'))");
      args.push(hostId);
    } else {
      where.push("e.status = 'published'");
    }
    if (q) {
      where.push('(LOWER(e.title) LIKE ? OR LOWER(e.summary) LIKE ? OR LOWER(e.city) LIKE ? OR LOWER(e.category) LIKE ?)');
      const like = `%${String(q).toLowerCase()}%`;
      args.push(like, like, like, like);
    }
    if (category) { where.push('e.category = ?'); args.push(category); }
    if (mode) { where.push('e.mode = ?'); args.push(mode); }

    const nowIso = now();
    if (when === 'upcoming') { where.push('COALESCE(e.ends_at, e.starts_at) >= ?'); args.push(nowIso); }
    else if (when === 'past') { where.push('COALESCE(e.ends_at, e.starts_at) < ?'); args.push(nowIso); }
    else if (when === 'week') {
      where.push('COALESCE(e.ends_at, e.starts_at) >= ? AND e.starts_at <= ?');
      args.push(nowIso, new Date(Date.now() + 7 * 864e5).toISOString());
    }
    const order = when === 'past' ? 'e.starts_at DESC' : 'e.starts_at ASC';
    return db.prepare(`${EVENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`)
      .all(...args, Number(limit)).map(shapeEvent);
  }

  const listEventsByHost = (hostId) =>
    db.prepare(`${EVENT_SELECT} WHERE e.host_id = ? ORDER BY e.starts_at DESC`).all(hostId).map(shapeEvent);

  /* -------------------------------------------------------- registrations */

  /**
   * Move waitlisted people into a seat, oldest first, while seats allow.
   *
   * On a free event that means straight to confirmed. On a paid event it means
   * an `offered` hold — they have not paid, so we reserve the seat and give
   * them a window to claim it. Nobody is ever charged for a waitlist place.
   *
   * A party too large for the remaining gap is skipped rather than split or
   * jumped ahead of someone who fits.
   *
   * Caller must already hold a transaction.
   */
  function promoteWaitlist(eventId) {
    const ev = db.prepare('SELECT capacity, price_cents, currency FROM events WHERE id = ?').get(eventId);
    if (!ev) return [];
    const paid = ev.price_cents > 0;
    const queue = db.prepare(
      "SELECT * FROM registrations WHERE event_id = ? AND status = 'waitlisted' ORDER BY created_at ASC",
    ).all(eventId);
    if (!queue.length) return [];

    const promote = (r) => {
      if (paid) {
        // They haven't paid, so the seat is reserved and they're invited to
        // claim it. The email carries the deadline — it is the only way they
        // find out, so a late send costs them the seat.
        const claimBy = plusHours(OFFER_HOURS);
        const amountCents = ev.price_cents * r.guests;
        db.prepare(`
          UPDATE registrations
          SET status = 'offered', hold_expires_at = ?, amount_cents = ?, currency = ?
          WHERE id = ?
        `).run(claimBy, amountCents, ev.currency, r.id);
        enqueueEmail({
          type: 'waitlist_offer',
          dedupeKey: `waitlist_offer:${r.id}:${claimBy}`,
          registrationId: r.id, eventId, userId: r.user_id,
          payload: { guests: r.guests, amountCents, currency: ev.currency, claimBy },
        });
      } else {
        db.prepare("UPDATE registrations SET status = 'confirmed', hold_expires_at = NULL WHERE id = ?").run(r.id);
        enqueueEmail({
          type: 'registration_confirmed',
          dedupeKey: `registration_confirmed:${r.id}:${r.created_at}`,
          registrationId: r.id, eventId, userId: r.user_id,
          payload: { guests: r.guests, amountCents: 0, paid: false, promoted: true },
        });
      }
    };

    const promoted = [];
    if (ev.capacity === null) {
      for (const r of queue) { promote(r); promoted.push(r.id); }
      return promoted;
    }
    let seats = takenSeats(eventId);
    for (const r of queue) {
      if (seats + r.guests > ev.capacity) continue;
      promote(r);
      seats += r.guests;
      promoted.push(r.id);
    }
    return promoted;
  }

  /** Used by the mailer to render a message against the current record. */
  const getRegistrationById = (id) => {
    const row = db.prepare(`
      SELECT r.*, u.name AS user_name, u.email AS user_email
      FROM registrations r JOIN users u ON u.id = r.user_id WHERE r.id = ?
    `).get(id);
    return row ? shapeRegistration(row) : null;
  };

  const myRegistrationRow = (eventId, userId) =>
    db.prepare('SELECT * FROM registrations WHERE event_id = ? AND user_id = ?').get(eventId, userId) ?? null;

  /**
   * Release holds that ran out of time, then let the queue behind them move up.
   *
   * Reads never depend on this having run — capacity queries filter on
   * hold_expires_at directly — but the promotion side-effect does, so this is
   * called on write paths and on a timer.
   */
  function sweepHolds() {
    return tx(() => {
      const stale = db.prepare(`
        SELECT id, event_id, user_id, guests, status, hold_expires_at, amount_cents, currency
        FROM registrations
        WHERE status IN ('pending','offered')
          AND hold_expires_at IS NOT NULL AND hold_expires_at <= ${NOW_SQL}
      `).all();
      if (!stale.length) return { expired: 0, promoted: 0 };

      for (const r of stale) {
        db.prepare("UPDATE registrations SET status = 'expired', hold_expires_at = NULL WHERE id = ?").run(r.id);
        // Silence here is the worst outcome: they think they have a seat.
        enqueueEmail({
          type: 'hold_expired',
          dedupeKey: `hold_expired:${r.id}:${r.hold_expires_at}`,
          registrationId: r.id, eventId: r.event_id, userId: r.user_id,
          payload: {
            guests: r.guests,
            wasOffer: r.status === 'offered',
            amountCents: r.amount_cents,
            currency: r.currency,
          },
        });
      }
      let promoted = 0;
      for (const eventId of new Set(stale.map((r) => r.event_id))) {
        promoted += promoteWaitlist(eventId).length;
      }
      return { expired: stale.length, promoted };
    });
  }

  /**
   * Decide what happens when someone asks for a seat.
   *
   * Returns one of:
   *   { outcome: 'confirmed'  }  free event, seat available
   *   { outcome: 'waitlisted' }  event full — no payment taken
   *   { outcome: 'payment_required', registration }  paid event, seat now HELD
   *
   * In the payment case the seat is reserved before we ever talk to Stripe,
   * so the checkout window cannot oversell. The caller creates the Checkout
   * session and calls attachCheckoutSession, or releaseHold if Stripe fails.
   */
  function beginRegistration(slug, userId, { guests = 1, note = null } = {}) {
    const seats = Number(guests);
    if (!Number.isInteger(seats) || seats < 1 || seats > 10) {
      throw bad('invalid_guests', 'You can bring between 1 and 10 people.');
    }
    sweepHolds();

    return tx(() => {
      const ev = db.prepare('SELECT * FROM events WHERE slug = ?').get(slug);
      if (!ev) throw notFound('No event with that link.');
      if (ev.status === 'cancelled') throw conflict('event_cancelled', 'This event was cancelled.');
      if (ev.status !== 'published') throw conflict('event_not_open', 'This event is not open for registration yet.');
      if (new Date(ev.ends_at || ev.starts_at).getTime() < Date.now()) {
        throw conflict('event_past', 'This event has already happened.');
      }
      if (ev.host_id === userId) throw conflict('host_cannot_register', 'You are hosting this one.');

      const existing = myRegistrationRow(ev.id, userId);
      const paid = ev.price_cents > 0;

      if (existing && ['confirmed', 'waitlisted'].includes(existing.status)) {
        throw conflict('already_registered', 'You are already on the list for this event.');
      }
      // Mid-checkout or holding an offer: resume rather than dead-ending them.
      if (existing && HOLDING.includes(existing.status)) {
        const live = !existing.hold_expires_at || existing.hold_expires_at > now();
        if (live) {
          const refreshed = existing.status === 'pending'
            ? holdFor(existing.id, seats, ev, note)
            : existing;
          return {
            outcome: 'payment_required',
            resumed: true,
            registration: shapeRegistration(db.prepare('SELECT * FROM registrations WHERE id = ?').get(refreshed.id ?? existing.id)),
            event: getEventBySlug(slug),
          };
        }
      }

      const taken = takenSeats(ev.id);
      const room = ev.capacity === null || taken + seats <= ev.capacity;

      if (!room) {
        const id = upsertRegistration(existing, {
          eventId: ev.id, userId, guests: seats, note,
          status: 'waitlisted', amountCents: 0, currency: null, holdExpiresAt: null,
        });
        const row = db.prepare('SELECT created_at FROM registrations WHERE id = ?').get(id);
        enqueueEmail({
          type: 'registration_waitlisted',
          dedupeKey: `registration_waitlisted:${id}:${row.created_at}`,
          registrationId: id, eventId: ev.id, userId,
          payload: { guests: seats },
        });
        return { outcome: 'waitlisted', event: getEventBySlug(slug) };
      }

      if (!paid) {
        const id = upsertRegistration(existing, {
          eventId: ev.id, userId, guests: seats, note,
          status: 'confirmed', amountCents: 0, currency: null, holdExpiresAt: null,
        });
        const row = db.prepare('SELECT created_at FROM registrations WHERE id = ?').get(id);
        enqueueEmail({
          type: 'registration_confirmed',
          dedupeKey: `registration_confirmed:${id}:${row.created_at}`,
          registrationId: id, eventId: ev.id, userId,
          payload: { guests: seats, amountCents: 0, paid: false },
        });
        return { outcome: 'confirmed', event: getEventBySlug(slug) };
      }

      const id = upsertRegistration(existing, {
        eventId: ev.id, userId, guests: seats, note,
        status: 'pending',
        amountCents: ev.price_cents * seats,
        currency: ev.currency,
        holdExpiresAt: plusMinutes(HOLD_MINUTES) ,
      });
      return {
        outcome: 'payment_required',
        registration: shapeRegistration(db.prepare('SELECT * FROM registrations WHERE id = ?').get(id)),
        event: getEventBySlug(slug),
      };
    });
  }

  /** Insert, or reuse an inactive row so the unique index always holds. */
  function upsertRegistration(existing, f) {
    if (existing) {
      db.prepare(`
        UPDATE registrations SET guests = ?, status = ?, note = ?, amount_cents = ?, currency = ?,
          hold_expires_at = ?, created_at = ?, stripe_session_id = NULL, stripe_checkout_url = NULL,
          stripe_payment_intent = NULL, paid_at = NULL, refund_due = 0, refunded_at = NULL
        WHERE id = ?
      `).run(f.guests, f.status, f.note, f.amountCents, f.currency, f.holdExpiresAt, now(), existing.id);
      return existing.id;
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO registrations
        (id, event_id, user_id, guests, status, note, amount_cents, currency, hold_expires_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(id, f.eventId, f.userId, f.guests, f.status, f.note, f.amountCents, f.currency, f.holdExpiresAt, now());
    return id;
  }

  /** Refresh an existing pending hold (party size may have changed). */
  function holdFor(registrationId, seats, ev, note) {
    db.prepare(`
      UPDATE registrations SET guests = ?, amount_cents = ?, currency = ?, hold_expires_at = ?, note = COALESCE(?, note)
      WHERE id = ?
    `).run(seats, ev.price_cents * seats, ev.currency, plusMinutes(HOLD_MINUTES), note, registrationId);
    return { id: registrationId };
  }

  /**
   * Claim a seat offered after a waitlist promotion. Refreshes the hold so the
   * checkout window is generous even if the offer was nearly up.
   */
  function beginClaim(slug, userId) {
    sweepHolds();
    return tx(() => {
      const ev = db.prepare('SELECT * FROM events WHERE slug = ?').get(slug);
      if (!ev) throw notFound('No event with that link.');
      if (ev.status !== 'published') throw conflict('event_not_open', 'This event is not open.');
      const reg = myRegistrationRow(ev.id, userId);
      if (!reg || reg.status !== 'offered') {
        throw conflict('no_offer', 'You do not have a seat offer to claim on this event.');
      }
      db.prepare('UPDATE registrations SET hold_expires_at = ? WHERE id = ?')
        .run(plusMinutes(HOLD_MINUTES), reg.id);
      return {
        outcome: 'payment_required',
        registration: shapeRegistration(db.prepare('SELECT * FROM registrations WHERE id = ?').get(reg.id)),
        event: getEventBySlug(slug),
      };
    });
  }

  /** Record the Stripe session against the held registration. */
  function attachCheckoutSession(registrationId, { sessionId, checkoutUrl, holdExpiresAt }) {
    return tx(() => {
      db.prepare(`
        UPDATE registrations SET stripe_session_id = ?, stripe_checkout_url = ?,
          hold_expires_at = COALESCE(?, hold_expires_at)
        WHERE id = ?
      `).run(sessionId, checkoutUrl ?? null, holdExpiresAt ?? null, registrationId);
      const reg = db.prepare('SELECT * FROM registrations WHERE id = ?').get(registrationId);
      // Permanent record, so a late payment on a superseded session can still
      // be traced back to a person and refunded.
      db.prepare(`
        INSERT INTO stripe_checkout_sessions
          (session_id, registration_id, event_id, user_id, amount_cents, currency, created_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET registration_id = excluded.registration_id
      `).run(sessionId, registrationId, reg.event_id, reg.user_id, reg.amount_cents, reg.currency, now());
      return shapeRegistration(reg);
    });
  }

  /**
   * Find the registration a Checkout session belongs to.
   *
   * Goes through the permanent map first, because a registration row that was
   * reused has had its stripe_session_id overwritten.
   */
  function registrationForSession(sessionId) {
    const mapped = db.prepare(`
      SELECT r.* FROM stripe_checkout_sessions s
      JOIN registrations r ON r.id = s.registration_id
      WHERE s.session_id = ?
    `).get(sessionId);
    if (mapped) return mapped;
    return db.prepare('SELECT * FROM registrations WHERE stripe_session_id = ?').get(sessionId) ?? null;
  }

  /** Give the seat back — used when Stripe errors, or the user abandons. */
  function releaseHold(registrationId, status = 'cancelled') {
    return tx(() => {
      const reg = db.prepare('SELECT * FROM registrations WHERE id = ?').get(registrationId);
      if (!reg) return { released: false };
      if (!HOLDING.includes(reg.status)) return { released: false };
      db.prepare('UPDATE registrations SET status = ?, hold_expires_at = NULL WHERE id = ?')
        .run(status, registrationId);
      const promoted = promoteWaitlist(reg.event_id).length;
      return { released: true, promoted, event: getEventById(reg.event_id) };
    });
  }

  /**
   * A payment succeeded. Turn the hold into a confirmed seat.
   *
   * The awkward case is a payment that lands after we released the seat (hold
   * lapsed, event cancelled, whatever). Then the only honest outcome is to
   * flag it for refund rather than oversell — the caller issues the refund.
   */
  function confirmPaidSession({ sessionId, paymentIntent = null, amountTotal = null }) {
    return tx(() => {
      const reg = registrationForSession(sessionId);
      if (!reg) return { result: 'unknown_session' };

      // Idempotent: Stripe delivers at least once.
      if (reg.status === 'confirmed') {
        return { result: 'already_confirmed', registration: shapeRegistration(reg), event: getEventById(reg.event_id) };
      }

      const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(reg.event_id);
      const seatStillOurs = HOLDING.includes(reg.status);

      if (!seatStillOurs) {
        // Hold was already released. Only reinstate if the seat is genuinely
        // free right now; otherwise the money has to go back.
        const room = ev.capacity === null || takenSeats(ev.id) + reg.guests <= ev.capacity;
        const eventOpen = ev.status === 'published'
          && new Date(ev.ends_at || ev.starts_at).getTime() >= Date.now();
        if (!room || !eventOpen) {
          db.prepare(`
            UPDATE registrations SET refund_due = 1, paid_at = ?, stripe_payment_intent = ?,
              amount_cents = COALESCE(?, amount_cents)
            WHERE id = ?
          `).run(now(), paymentIntent, amountTotal, reg.id);
          // Money left their account for a seat they didn't get. They must be
          // told, whether or not the refund API call succeeds.
          enqueueEmail({
            type: 'payment_refunded',
            dedupeKey: `payment_refunded:${reg.id}`,
            registrationId: reg.id, eventId: reg.event_id, userId: reg.user_id,
            payload: {
              guests: reg.guests,
              amountCents: amountTotal ?? reg.amount_cents,
              currency: reg.currency || ev.currency,
              reason: !eventOpen ? 'event_closed' : 'seat_gone',
            },
          });
          return {
            result: 'refund_due',
            reason: !eventOpen ? 'event_closed' : 'seat_gone',
            registration: shapeRegistration(db.prepare('SELECT * FROM registrations WHERE id = ?').get(reg.id)),
            event: getEventById(reg.event_id),
          };
        }
      }

      db.prepare(`
        UPDATE registrations SET status = 'confirmed', hold_expires_at = NULL, paid_at = ?,
          stripe_payment_intent = ?, amount_cents = COALESCE(?, amount_cents), refund_due = 0
        WHERE id = ?
      `).run(now(), paymentIntent, amountTotal, reg.id);

      enqueueEmail({
        type: 'registration_confirmed',
        dedupeKey: `registration_confirmed:${reg.id}:${reg.created_at}`,
        registrationId: reg.id, eventId: reg.event_id, userId: reg.user_id,
        payload: {
          guests: reg.guests,
          amountCents: amountTotal ?? reg.amount_cents,
          currency: reg.currency || ev.currency,
          paid: true,
        },
      });

      return {
        result: seatStillOurs ? 'confirmed' : 'reinstated',
        registration: shapeRegistration(db.prepare('SELECT * FROM registrations WHERE id = ?').get(reg.id)),
        event: getEventById(reg.event_id),
      };
    });
  }

  /** Stripe told us the session lapsed unpaid. */
  function expireSession(sessionId) {
    const reg = registrationForSession(sessionId);
    if (!reg) return { result: 'unknown_session' };
    if (!HOLDING.includes(reg.status)) return { result: 'not_holding' };
    const out = releaseHold(reg.id, 'expired');
    return { result: 'released', ...out };
  }

  function markRefunded(registrationId) {
    db.prepare('UPDATE registrations SET refunded_at = ?, refund_due = 0 WHERE id = ?')
      .run(now(), registrationId);
    return shapeRegistration(db.prepare('SELECT * FROM registrations WHERE id = ?').get(registrationId));
  }

  /** Registrations that were paid but couldn't be seated — host needs to know. */
  const listRefundsDue = () => db.prepare(`
    SELECT r.*, u.name AS user_name, u.email AS user_email
    FROM registrations r JOIN users u ON u.id = r.user_id
    WHERE r.refund_due = 1 AND r.refunded_at IS NULL
  `).all().map(shapeRegistration);

  /** Cancel your own seat, promoting the queue if you were holding one. */
  function cancelRegistration(slug, userId) {
    return tx(() => {
      const ev = db.prepare('SELECT * FROM events WHERE slug = ?').get(slug);
      if (!ev) throw notFound('No event with that link.');
      const reg = myRegistrationRow(ev.id, userId);
      if (!reg || !ACTIVE.includes(reg.status)) throw notFound('You are not registered for this event.');

      const heldASeat = ['confirmed', 'pending', 'offered'].includes(reg.status);
      const wasPaid = Boolean(reg.paid_at) && !reg.refunded_at;

      db.prepare("UPDATE registrations SET status = 'cancelled', hold_expires_at = NULL WHERE id = ?").run(reg.id);
      enqueueEmail({
        type: 'registration_cancelled',
        dedupeKey: `registration_cancelled:${reg.id}:${reg.created_at}`,
        registrationId: reg.id, eventId: ev.id, userId,
        payload: { guests: reg.guests, wasPaid, amountCents: reg.amount_cents, currency: reg.currency },
      });
      const promoted = heldASeat ? promoteWaitlist(ev.id).length : 0;

      return {
        promoted,
        // Surfaced so the caller can decide about refunding; Gather does not
        // auto-refund a voluntary cancellation, that's the host's call.
        wasPaid,
        registration: shapeRegistration(db.prepare('SELECT * FROM registrations WHERE id = ?').get(reg.id)),
        event: getEventBySlug(slug),
      };
    });
  }

  /** Guest list — host only. Includes holds and anything awaiting a refund. */
  function listRegistrations(slug, actorId) {
    const ev = db.prepare('SELECT * FROM events WHERE slug = ?').get(slug);
    if (!ev) throw notFound('No event with that link.');
    if (ev.host_id !== actorId) throw forbidden('Only the host can see the guest list.');
    return db.prepare(`
      SELECT r.*, u.name AS user_name, u.email AS user_email
      FROM registrations r JOIN users u ON u.id = r.user_id
      WHERE r.event_id = ?
        AND (r.status IN ('confirmed','pending','offered','waitlisted') OR r.refund_due = 1)
      ORDER BY CASE r.status
          WHEN 'confirmed' THEN 0 WHEN 'offered' THEN 1
          WHEN 'pending' THEN 2 WHEN 'waitlisted' THEN 3 ELSE 4 END,
        r.created_at ASC
    `).all(ev.id).map(shapeRegistration);
  }

  function listMyRegistrations(userId) {
    return db.prepare(`
      SELECT r.*, e.slug AS event_slug FROM registrations r JOIN events e ON e.id = r.event_id
      WHERE r.user_id = ? AND (r.status IN ('confirmed','pending','offered','waitlisted') OR r.refund_due = 1)
      ORDER BY e.starts_at ASC
    `).all(userId).map((r) => ({ ...shapeRegistration(r), event: getEventBySlug(r.event_slug) }));
  }

  function myRegistrationFor(eventId, userId) {
    if (!userId) return null;
    const row = myRegistrationRow(eventId, userId);
    if (!row) return null;
    if (!ACTIVE.includes(row.status) && !row.refund_due) return null;
    return shapeRegistration(row);
  }

  /* ------------------------------------------------------ webhook receipts */

  /** True the first time an event id is seen, false on every redelivery. */
  function recordStripeEvent(id, type) {
    if (!id) return true;
    const existing = db.prepare('SELECT 1 FROM stripe_events WHERE id = ?').get(id);
    if (existing) return false;
    db.prepare('INSERT INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)').run(id, type, now());
    return true;
  }

  /* -------------------------------------------------------- email outbox */

  const MAX_EMAIL_ATTEMPTS = 6;
  /**
   * Backoff schedule in seconds. The first steps are deliberately short: a
   * waitlist offer carries a deadline, so a message parked behind an hour of
   * backoff can outlive the seat it is about.
   */
  const EMAIL_BACKOFF = [30, 120, 600, 1800, 7200, 21600];

  /**
   * Queue one message. Call this INSIDE the transaction that performs the
   * state change, so the two commit or fail together.
   */
  function enqueueEmail({ type, dedupeKey, registrationId = null, eventId = null, userId, payload = null }) {
    const user = getUserById(userId);
    if (!user) return { queued: false, reason: 'unknown_user' };
    const existing = db.prepare('SELECT id FROM email_outbox WHERE dedupe_key = ?').get(dedupeKey);
    if (existing) return { queued: false, reason: 'duplicate', id: existing.id };
    const id = randomUUID();
    db.prepare(`
      INSERT INTO email_outbox
        (id, type, dedupe_key, registration_id, event_id, user_id, to_email, payload, next_attempt_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(id, type, dedupeKey, registrationId, eventId, userId, user.email,
      payload ? JSON.stringify(payload) : null, now(), now());
    return { queued: true, id };
  }

  /**
   * Take the next batch of due messages, marking them in-flight and counting
   * the attempt up front — a crash mid-send then costs one attempt rather than
   * looping on a poison message forever.
   */
  function claimDueEmails(limit = 25) {
    return tx(() => {
      const due = db.prepare(`
        SELECT * FROM email_outbox
        WHERE status = 'queued' AND next_attempt_at <= ${NOW_SQL}
        ORDER BY created_at ASC LIMIT ?
      `).all(Number(limit));
      for (const row of due) {
        db.prepare("UPDATE email_outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ?")
          .run(row.id);
      }
      return due.map((r) => ({
        ...r,
        attempts: r.attempts + 1,
        payload: r.payload ? JSON.parse(r.payload) : null,
      }));
    });
  }

  function markEmailSent(id, { providerId = null, subject = null } = {}) {
    db.prepare(`
      UPDATE email_outbox SET status = 'sent', sent_at = ?, provider_id = ?, subject = COALESCE(?, subject),
        last_error = NULL
      WHERE id = ?
    `).run(now(), providerId, subject, id);
  }

  /**
   * Requeue with backoff, or give up and dead-letter it for a human.
   * `permanent` skips the retries entirely — a rejected address or an unknown
   * template will fail the same way on every attempt.
   */
  function markEmailFailed(id, error, { permanent = false } = {}) {
    const row = db.prepare('SELECT attempts FROM email_outbox WHERE id = ?').get(id);
    if (!row) return { status: 'missing' };
    const message = String(error?.message || error || 'unknown error').slice(0, 500);
    if (permanent || row.attempts >= MAX_EMAIL_ATTEMPTS) {
      db.prepare("UPDATE email_outbox SET status = 'dead', last_error = ? WHERE id = ?").run(message, id);
      return { status: 'dead', attempts: row.attempts };
    }
    const delay = EMAIL_BACKOFF[Math.min(row.attempts - 1, EMAIL_BACKOFF.length - 1)];
    db.prepare("UPDATE email_outbox SET status = 'queued', last_error = ?, next_attempt_at = ? WHERE id = ?")
      .run(message, new Date(Date.now() + delay * 1000).toISOString(), id);
    return { status: 'queued', attempts: row.attempts, retryInSeconds: delay };
  }

  /** After a crash, anything left in-flight is owed another try. */
  function requeueStalledEmails() {
    const out = db.prepare(`
      UPDATE email_outbox SET status = 'queued', next_attempt_at = ?
      WHERE status = 'sending'
    `).run(now());
    return { requeued: out.changes ?? 0 };
  }

  function listOutbox({ status, type, limit = 100 } = {}) {
    const where = [];
    const args = [];
    if (status) { where.push('status = ?'); args.push(status); }
    if (type) { where.push('type = ?'); args.push(type); }
    return db.prepare(`
      SELECT * FROM email_outbox
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at ASC LIMIT ?
    `).all(...args, Number(limit)).map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null }));
  }

  function outboxStats() {
    const rows = db.prepare('SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status').all();
    const out = { queued: 0, sending: 0, sent: 0, dead: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  function stats() {
    const one = (sql, ...a) => db.prepare(sql).get(...a).n;
    return {
      users: one('SELECT COUNT(*) AS n FROM users'),
      events: one("SELECT COUNT(*) AS n FROM events WHERE status = 'published'"),
      registrations: one("SELECT COUNT(*) AS n FROM registrations WHERE status IN ('confirmed','pending','offered','waitlisted')"),
      holds: one("SELECT COUNT(*) AS n FROM registrations WHERE status IN ('pending','offered')"),
      refundsDue: one('SELECT COUNT(*) AS n FROM registrations WHERE refund_due = 1 AND refunded_at IS NULL'),
    };
  }

  return {
    raw: db,
    tx,
    CATEGORIES,
    CURRENCIES,
    HOLD_MINUTES,
    OFFER_HOURS,
    HOLD_GRACE_SECONDS,
    upsertUser, getUserById, getUserByEmail,
    createSession, userForSession, destroySession,
    createEvent, updateEvent, cancelEvent, getEventBySlug, getEventById, listEvents, listEventsByHost,
    beginRegistration, beginClaim, attachCheckoutSession, releaseHold,
    confirmPaidSession, expireSession, markRefunded, listRefundsDue,
    cancelRegistration, listRegistrations, listMyRegistrations, myRegistrationFor,
    getRegistrationById,
    promoteWaitlist, sweepHolds, takenSeats, confirmedSeats, heldSeats,
    recordStripeEvent,
    enqueueEmail, claimDueEmails, markEmailSent, markEmailFailed,
    requeueStalledEmails, listOutbox, outboxStats, MAX_EMAIL_ATTEMPTS,
    stats,
  };
}
