/**
 * seed.mjs — load the demo content into a fresh database.
 *
 *   node --no-warnings server/seed.mjs            # seeds ./gather.db
 *   GATHER_DB=/tmp/x.db node --no-warnings server/seed.mjs --reset
 *
 * --reset drops existing rows first. Without it, seeding an already-seeded
 * database is a no-op rather than a pile of duplicates.
 */

import { openDb } from './db.mjs';
import { buildSeed } from './seed-data.mjs';

const DB_FILE = process.env.GATHER_DB || 'gather.db';
const reset = process.argv.includes('--reset');

const db = openDb(DB_FILE);

if (reset) {
  db.raw.exec('DELETE FROM registrations; DELETE FROM sessions; DELETE FROM events; DELETE FROM users;');
  console.log('[seed] cleared existing rows');
}

if (db.stats().events > 0 && !reset) {
  console.log('[seed] database already has events — pass --reset to reseed');
  process.exit(0);
}

const { users, events } = buildSeed();
const userIds = new Map();

for (const u of users) {
  userIds.set(u.key, db.upsertUser({ email: u.email, name: u.name }).id);
}

let regCount = 0;
for (const ev of events) {
  const hostId = userIds.get(ev.hostKey);
  const created = db.createEvent(hostId, ev);

  // Registrations are inserted directly rather than through register(), because
  // the seed deliberately includes a sold-out event with a waitlist and past
  // events — states the public API would (correctly) refuse to create.
  for (const r of ev.registrations) {
    db.raw.prepare(`
      INSERT INTO registrations (
        id, event_id, user_id, guests, status, note, amount_cents, currency,
        hold_expires_at, stripe_session_id, stripe_payment_intent, paid_at, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      crypto.randomUUID(), created.id, userIds.get(r.userKey),
      r.guests, r.status, null, r.amountCents ?? 0, r.currency ?? null,
      r.holdExpiresAt ?? null, r.stripeSessionId ?? null,
      r.stripePaymentIntent ?? null, r.paidAt ?? null, r.createdAt,
    );
    regCount++;
  }
}

const s = db.stats();
console.log(`[seed] ${users.length} users, ${events.length} events, ${regCount} registrations`);
console.log(`[seed] db=${DB_FILE} -> users=${s.users} published=${s.events} live registrations=${s.registrations}`);
