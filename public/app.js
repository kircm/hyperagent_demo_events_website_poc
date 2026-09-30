/* =========================================================================
   Gather — front end.

   One interface, two backends. `Store` is either RemoteStore (talks to the
   Node API over HTTP) or LocalStore (does the same work against on-device
   storage). Every view calls the same methods and cannot tell the difference,
   which is what lets this file run as a standalone page today and against a
   real server the moment one is deployed.
   ========================================================================= */
(() => {
'use strict';

const SEED = window.GATHER_SEED || { users: [], events: [] };
const API_BASE = window.GATHER_API_BASE;

const CATEGORIES = ['Tech', 'Music', 'Food & Drink', 'Fitness', 'Arts', 'Business', 'Community'];
const CATEGORY_ICON = {
  'Tech': '⌘', 'Music': '♪', 'Food & Drink': '◍', 'Fitness': '△',
  'Arts': '✳', 'Business': '▤', 'Community': '◎',
};

const CURRENCIES = ['usd', 'eur', 'gbp', 'cad', 'aud', 'jpy'];
const ZERO_DECIMAL = new Set(['jpy']);
/** Mirrors HOLD_MINUTES / OFFER_HOURS in db.mjs. */
const HOLD_MINUTES = 30;
const OFFER_HOURS = 24;

/** Cents (or the currency's minor unit) -> "$55". */
function money(cents, currency = 'usd') {
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
const priceLabel = (ev) => (ev.priceCents > 0 ? money(ev.priceCents, ev.currency) : 'Free');

const minorUnit = (currency) => (ZERO_DECIMAL.has(String(currency || 'usd').toLowerCase()) ? 1 : 100);
/** "55.00" -> 5500 (or -> 55 for zero-decimal currencies like JPY). */
const toMinor = (amount, currency) => Math.round((Number(amount) || 0) * minorUnit(currency));
const toMajor = (cents, currency) => {
  const unit = minorUnit(currency);
  return (cents / unit).toFixed(unit === 1 ? 0 : 2);
};

/** "in 24 minutes" / "in 3 hours" — used for hold and offer deadlines. */
function untilLabel(iso) {
  if (!iso) return '';
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (mins <= 0) return 'any moment now';
  if (mins < 60) return `in ${mins} minute${mins === 1 ? '' : 's'}`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `in ${hrs} hour${hrs === 1 ? '' : 's'}`;
  return `in ${Math.round(hrs / 24)} days`;
}
function clockLabel(iso, tz) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined, hour: 'numeric', minute: '2-digit',
    }).format(new Date(iso));
  } catch { return ''; }
}

/* ===================================================== small utilities === */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function uuid() {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** localStorage is unavailable in some embedded contexts — degrade to memory. */
const storage = (() => {
  try {
    const k = '__gather_probe';
    localStorage.setItem(k, '1'); localStorage.removeItem(k);
    return localStorage;
  } catch {
    const mem = new Map();
    return {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
  }
})();

function slugify(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60) || 'event';
}

const AV_COLORS = ['#5b3df5', '#0d7a45', '#b3480a', '#1d4ed8', '#a52222', '#7c3aed', '#0f766e', '#9a3412', '#4338ca', '#065f46'];
function avatarColor(seed) {
  let h = 0;
  for (let i = 0; i < String(seed).length; i++) h = (h * 31 + String(seed).charCodeAt(i)) % 9973;
  return AV_COLORS[h % AV_COLORS.length];
}
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}
function avatar(user, size = 'md') {
  const name = user?.name || user?.email || '?';
  return `<div class="av av-${size}" style="background:${avatarColor(user?.email || name)}" title="${esc(name)}">${esc(initials(name))}</div>`;
}

/* ------------------------------------------------------------ date format */

function parts(iso, tz, opts) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, ...opts }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', opts).format(new Date(iso));
  }
}
function tzAbbr(ev) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: ev.timezone, timeZoneName: 'short' })
      .formatToParts(new Date(ev.startsAt));
    return p.find((x) => x.type === 'timeZoneName')?.value || '';
  } catch { return ''; }
}
const monthShort = (ev) => parts(ev.startsAt, ev.timezone, { month: 'short' }).toUpperCase();
const dayNum = (ev) => parts(ev.startsAt, ev.timezone, { day: 'numeric' });

function longDate(ev) {
  return parts(ev.startsAt, ev.timezone, { weekday: 'long', month: 'long', day: 'numeric' });
}
function shortDate(ev) {
  return parts(ev.startsAt, ev.timezone, { weekday: 'short', month: 'short', day: 'numeric' });
}
function timeRange(ev) {
  const t = (iso) => parts(iso, ev.timezone, { hour: 'numeric', minute: '2-digit' });
  const range = ev.endsAt ? `${t(ev.startsAt)} – ${t(ev.endsAt)}` : t(ev.startsAt);
  const abbr = tzAbbr(ev);
  return abbr ? `${range} ${abbr}` : range;
}
/** "Today", "Tomorrow", "In 5 days", "3 weeks ago" */
function relativeDay(ev) {
  const startOf = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const days = Math.round((startOf(ev.startsAt) - startOf(Date.now())) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1 && days < 14) return `In ${days} days`;
  if (days >= 14) return `In ${Math.round(days / 7)} weeks`;
  if (days < -1 && days > -14) return `${Math.abs(days)} days ago`;
  return `${Math.round(Math.abs(days) / 7)} weeks ago`;
}
const placeLabel = (ev) => (ev.mode === 'online' ? 'Online' : (ev.city || ev.venueName || 'Location TBA'));

/* ================================================ shared domain helpers === */
/* Kept identical to the server's rules so both modes behave the same way.   */

const HOLDING = ['pending', 'offered'];
const ACTIVE = ['confirmed', 'pending', 'offered', 'waitlisted'];

const isLiveHold = (r) => HOLDING.includes(r.status)
  && (!r.holdExpiresAt || new Date(r.holdExpiresAt).getTime() > Date.now());

const confirmedSeatsFor = (state, eventId) => state.registrations
  .filter((r) => r.eventId === eventId && r.status === 'confirmed')
  .reduce((n, r) => n + r.guests, 0);

/**
 * Seats locked up by an in-progress payment. These count against capacity —
 * that is what stops the checkout window overselling the room.
 */
const heldSeatsFor = (state, eventId) => state.registrations
  .filter((r) => r.eventId === eventId && isLiveHold(r))
  .reduce((n, r) => n + r.guests, 0);

const waitlistCountFor = (state, eventId) => state.registrations
  .filter((r) => r.eventId === eventId && r.status === 'waitlisted').length;

const takenSeatsFor = (state, eventId) => confirmedSeatsFor(state, eventId) + heldSeatsFor(state, eventId);

class StoreError extends Error {
  constructor(message, code = 'error') { super(message); this.code = code; }
}

function validateEventInput(input, { partial = false } = {}) {
  const out = {};
  if (!partial) {
    if (!String(input.title ?? '').trim()) throw new StoreError('Give the event a title.', 'missing_field');
    if (!String(input.startsAt ?? '').trim()) throw new StoreError('Pick a date and time.', 'missing_field');
  }
  if (input.title !== undefined) {
    const t = String(input.title).trim();
    if (t.length < 3) throw new StoreError('Give the event a longer title.', 'invalid_title');
    if (t.length > 140) throw new StoreError('Titles cap out at 140 characters.', 'invalid_title');
    out.title = t;
  }
  if (input.startsAt !== undefined) {
    const d = new Date(input.startsAt);
    if (Number.isNaN(d.getTime())) throw new StoreError('That start date is not a real date.', 'invalid_date');
    out.startsAt = d.toISOString();
  }
  if (input.endsAt !== undefined) {
    if (!input.endsAt) out.endsAt = null;
    else {
      const d = new Date(input.endsAt);
      if (Number.isNaN(d.getTime())) throw new StoreError('That end date is not a real date.', 'invalid_date');
      out.endsAt = d.toISOString();
    }
  }
  if (out.startsAt && out.endsAt && out.endsAt < out.startsAt) {
    throw new StoreError('The event cannot end before it starts.', 'invalid_range');
  }
  if (input.category !== undefined) {
    if (!CATEGORIES.includes(input.category)) throw new StoreError('Pick a category.', 'invalid_category');
    out.category = input.category;
  }
  if (input.mode !== undefined) {
    if (!['in_person', 'online'].includes(input.mode)) throw new StoreError('Unknown mode.', 'invalid_mode');
    out.mode = input.mode;
  }
  if (input.capacity !== undefined) {
    if (input.capacity === null || input.capacity === '') out.capacity = null;
    else {
      const c = Number(input.capacity);
      if (!Number.isInteger(c) || c < 1 || c > 100000) {
        throw new StoreError('Capacity must be a whole number of at least 1.', 'invalid_capacity');
      }
      out.capacity = c;
    }
  }
  if (input.status !== undefined) {
    if (!['draft', 'published', 'cancelled'].includes(input.status)) throw new StoreError('Unknown status.', 'invalid_status');
    out.status = input.status;
  }
  if (input.priceCents !== undefined) {
    const p = Number(input.priceCents);
    if (!Number.isInteger(p) || p < 0) throw new StoreError('Price must be a whole amount, or zero for free.', 'invalid_price');
    if (p > 0 && p < 50) throw new StoreError('Paid tickets must be at least 50 cents. Use zero for a free event.', 'invalid_price');
    if (p > 100_000_00) throw new StoreError('That price is implausibly high.', 'invalid_price');
    out.priceCents = p;
  }
  if (input.currency !== undefined) {
    const c = String(input.currency || 'usd').toLowerCase();
    if (!CURRENCIES.includes(c)) throw new StoreError('Unsupported currency.', 'invalid_currency');
    out.currency = c;
  }
  for (const k of ['summary', 'description', 'coverUrl', 'timezone', 'venueName', 'address', 'city', 'onlineUrl']) {
    if (input[k] !== undefined) out[k] = input[k] === null ? null : String(input[k]).trim();
  }
  const mode = out.mode ?? input.mode;
  if (!partial) {
    if (mode === 'online' && !out.onlineUrl) throw new StoreError('Online events need a join link.', 'missing_field');
    if (mode !== 'online' && !out.city) throw new StoreError('In-person events need a city.', 'missing_field');
  }
  return out;
}

/* ==================================================== LocalStore (device) */

function LocalStore() {
  // v2: seeds are now rebased onto the viewer's clock. Bumping the key discards
  // v1 state, whose dates were frozen at build time and have gone stale.
  const KEY = 'gather.state.v2';
  let state = load();

  function load() {
    try {
      const raw = storage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.events) && parsed.events.length) return parsed;
      }
    } catch { /* corrupt or blocked — reseed */ }
    return seed();
  }
  function save() {
    try { storage.setItem(KEY, JSON.stringify(state)); } catch { /* quota/blocked: session-only */ }
  }

  function seed() {
    // The seed's dates were fixed when this page was built. Move them onto
    // today's clock so a page built weeks ago still has upcoming events.
    const base = typeof window.GATHER_REBASE === 'function'
      ? window.GATHER_REBASE(SEED, Date.now())
      : SEED;
    const users = base.users.map((u) => ({ id: uuid(), key: u.key, email: u.email, name: u.name }));
    const byKey = new Map(users.map((u) => [u.key, u.id]));
    const events = [];
    const registrations = [];
    const taken = new Set();
    for (const ev of base.events) {
      let slug = slugify(ev.title); let n = 2;
      while (taken.has(slug)) slug = `${slugify(ev.title)}-${n++}`;
      taken.add(slug);
      const id = uuid();
      events.push({
        id, slug, hostId: byKey.get(ev.hostKey),
        title: ev.title, summary: ev.summary, description: ev.description,
        category: ev.category, coverUrl: ev.coverUrl,
        startsAt: ev.startsAt, endsAt: ev.endsAt, timezone: ev.timezone,
        mode: ev.mode, venueName: ev.venueName, address: ev.address, city: ev.city,
        onlineUrl: ev.onlineUrl, capacity: ev.capacity,
        priceCents: ev.priceCents ?? 0, currency: ev.currency ?? 'usd',
        status: ev.status, createdAt: new Date(Date.now() - 30 * 864e5).toISOString(),
      });
      for (const r of ev.registrations || []) {
        registrations.push({
          id: uuid(), eventId: id, userId: byKey.get(r.userKey),
          guests: r.guests, status: r.status, note: null, createdAt: r.createdAt,
          amountCents: r.amountCents ?? 0, currency: r.currency ?? null,
          holdExpiresAt: r.holdExpiresAt ?? null, paidAt: r.paidAt ?? null,
          refundDue: false, refundedAt: null,
        });
      }
    }
    return { users, events, registrations, sessionUserId: null };
  }

  const userById = (id) => state.users.find((u) => u.id === id) || null;
  const eventBySlug = (slug) => state.events.find((e) => e.slug === slug) || null;
  const me = () => (state.sessionUserId ? userById(state.sessionUserId) : null);

  function shape(ev) {
    if (!ev) return null;
    const host = userById(ev.hostId) || { id: ev.hostId, name: 'Unknown host', email: '' };
    const confirmedSeats = confirmedSeatsFor(state, ev.id);
    const heldSeats = heldSeatsFor(state, ev.id);
    const takenSeats = confirmedSeats + heldSeats;
    const capacity = ev.capacity ?? null;
    const seatsLeft = capacity === null ? null : Math.max(0, capacity - takenSeats);
    return {
      ...ev,
      capacity,
      priceCents: ev.priceCents ?? 0,
      currency: ev.currency || 'usd',
      isPaid: (ev.priceCents ?? 0) > 0,
      host: { id: host.id, name: host.name, email: host.email },
      confirmedSeats,
      heldSeats,
      takenSeats,
      waitlistCount: waitlistCountFor(state, ev.id),
      seatsLeft,
      isFull: capacity !== null && seatsLeft === 0,
      isPast: new Date(ev.endsAt || ev.startsAt).getTime() < Date.now(),
    };
  }

  /**
   * On a free event, promotion means straight to confirmed. On a paid one the
   * person hasn't paid, so it becomes an `offered` hold with a deadline —
   * nobody is ever charged for a waitlist place.
   */
  function promoteWaitlist(eventId) {
    const ev = state.events.find((e) => e.id === eventId);
    if (!ev) return 0;
    const paid = (ev.priceCents ?? 0) > 0;
    const queue = state.registrations
      .filter((r) => r.eventId === eventId && r.status === 'waitlisted')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const promote = (r) => {
      if (paid) {
        r.status = 'offered';
        r.amountCents = ev.priceCents * r.guests;
        r.currency = ev.currency || 'usd';
        r.holdExpiresAt = new Date(Date.now() + OFFER_HOURS * 3600e3).toISOString();
      } else {
        r.status = 'confirmed';
        r.holdExpiresAt = null;
      }
    };

    if (ev.capacity === null) {
      queue.forEach(promote);
      return queue.length;
    }
    let seats = takenSeatsFor(state, eventId);
    let promoted = 0;
    for (const r of queue) {
      if (seats + r.guests > ev.capacity) continue;
      promote(r);
      seats += r.guests;
      promoted++;
    }
    return promoted;
  }

  /**
   * Release holds whose window ran out, then let the queue behind them move
   * up. The server does this on a timer; here it runs before any read or
   * write that cares.
   */
  function sweep() {
    const lapsed = state.registrations.filter((r) => HOLDING.includes(r.status)
      && r.holdExpiresAt && new Date(r.holdExpiresAt).getTime() <= Date.now());
    if (!lapsed.length) return { expired: 0, promoted: 0 };
    for (const r of lapsed) { r.status = 'expired'; r.holdExpiresAt = null; }
    let promoted = 0;
    for (const eventId of new Set(lapsed.map((r) => r.eventId))) promoted += promoteWaitlist(eventId);
    save();
    return { expired: lapsed.length, promoted };
  }

  function requireUser() {
    const u = me();
    if (!u) throw new StoreError('Sign in first.', 'unauthenticated');
    return u;
  }

  return {
    mode: 'local',
    categories: CATEGORIES,
    // Paid events work here, but the card step is a labelled simulation —
    // there is no server on this device to talk to Stripe with.
    payments: 'simulated',

    async meta() {
      return {
        payments: { enabled: false, simulated: true, holdMinutes: HOLD_MINUTES, offerHours: OFFER_HOURS },
        // No server here, so nothing can be posted.
        email: { provider: 'none', delivers: false },
      };
    },
    async me() { const u = me(); return u ? { id: u.id, email: u.email, name: u.name } : null; },

    async signIn({ email, name }) {
      const clean = String(email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new StoreError('That email does not look right.', 'invalid_email');
      let user = state.users.find((u) => u.email === clean);
      if (!user) {
        user = { id: uuid(), email: clean, name: (name || '').trim() || clean.split('@')[0] };
        state.users.push(user);
      } else if (name && name.trim()) {
        user.name = name.trim();
      }
      state.sessionUserId = user.id;
      save();
      return { id: user.id, email: user.email, name: user.name };
    },

    async signOut() { state.sessionUserId = null; save(); },

    async listEvents({ q, category, mode, when = 'upcoming' } = {}) {
      sweep();
      const user = me();
      const nowMs = Date.now();
      let list = state.events.filter((e) => {
        if (e.status === 'draft') return user && e.hostId === user.id;
        return e.status === 'published';
      });
      if (q) {
        const needle = q.toLowerCase();
        list = list.filter((e) => [e.title, e.summary, e.city, e.category]
          .some((f) => String(f || '').toLowerCase().includes(needle)));
      }
      if (category) list = list.filter((e) => e.category === category);
      if (mode) list = list.filter((e) => e.mode === mode);
      const endMs = (e) => new Date(e.endsAt || e.startsAt).getTime();
      if (when === 'upcoming') list = list.filter((e) => endMs(e) >= nowMs);
      else if (when === 'past') list = list.filter((e) => endMs(e) < nowMs);
      else if (when === 'week') list = list.filter((e) => endMs(e) >= nowMs && new Date(e.startsAt).getTime() <= nowMs + 7 * 864e5);
      list.sort((a, b) => (when === 'past'
        ? b.startsAt.localeCompare(a.startsAt)
        : a.startsAt.localeCompare(b.startsAt)));
      return list.map(shape);
    },

    async getEvent(slug) {
      sweep();
      const ev = eventBySlug(slug);
      if (!ev) throw new StoreError('No event with that link.', 'not_found');
      const user = me();
      const reg = user ? state.registrations.find((r) => r.eventId === ev.id && r.userId === user.id) : null;
      return {
        event: shape(ev),
        myRegistration: reg && (ACTIVE.includes(reg.status) || reg.refundDue) ? { ...reg } : null,
        isHost: !!user && user.id === ev.hostId,
      };
    },

    async createEvent(input) {
      const user = requireUser();
      const f = validateEventInput(input);
      let slug = slugify(f.title); let n = 2;
      while (eventBySlug(slug)) slug = `${slugify(f.title)}-${n++}`;
      const ev = {
        id: uuid(), slug, hostId: user.id,
        title: f.title, summary: f.summary ?? '', description: f.description ?? '',
        category: f.category ?? 'Community', coverUrl: f.coverUrl ?? null,
        startsAt: f.startsAt, endsAt: f.endsAt ?? null,
        timezone: f.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        mode: f.mode ?? 'in_person', venueName: f.venueName ?? null, address: f.address ?? null,
        city: f.city ?? null, onlineUrl: f.onlineUrl ?? null,
        capacity: f.capacity ?? null, priceLabel: f.priceLabel || 'Free',
        status: f.status ?? 'published', createdAt: new Date().toISOString(),
      };
      state.events.push(ev);
      save();
      return shape(ev);
    },

    async updateEvent(slug, patch) {
      const user = requireUser();
      const ev = eventBySlug(slug);
      if (!ev) throw new StoreError('No event with that link.', 'not_found');
      if (ev.hostId !== user.id) throw new StoreError('Only the host can edit this event.', 'forbidden');
      const f = validateEventInput(patch, { partial: true });
      if (f.capacity !== undefined && f.capacity !== null) {
        const seats = takenSeatsFor(state, ev.id);
        if (f.capacity < seats) {
          throw new StoreError(`${seats} seats are already taken (including seats held for in-progress payments). Cancel registrations before lowering capacity below that.`, 'capacity_below_confirmed');
        }
      }
      if (f.priceCents !== undefined && (f.priceCents > 0) !== ((ev.priceCents ?? 0) > 0)) {
        const active = state.registrations.filter((r) => r.eventId === ev.id && ACTIVE.includes(r.status)).length;
        if (active > 0) {
          throw new StoreError('You cannot switch an event between free and paid while people are registered. Cancel the registrations first, or create a new event.', 'price_change_blocked');
        }
      }
      Object.assign(ev, f);
      if (f.capacity !== undefined) promoteWaitlist(ev.id);
      save();
      return shape(ev);
    },

    async cancelEvent(slug) {
      const user = requireUser();
      const ev = eventBySlug(slug);
      if (!ev) throw new StoreError('No event with that link.', 'not_found');
      if (ev.hostId !== user.id) throw new StoreError('Only the host can cancel this event.', 'forbidden');
      ev.status = 'cancelled';
      save();
      return shape(ev);
    },

    async register(slug, { guests = 1, note = null } = {}) {
      const user = requireUser();
      const seats = Number(guests);
      if (!Number.isInteger(seats) || seats < 1 || seats > 10) {
        throw new StoreError('You can bring between 1 and 10 people.', 'invalid_guests');
      }
      sweep();
      const ev = eventBySlug(slug);
      if (!ev) throw new StoreError('No event with that link.', 'not_found');
      if (ev.status === 'cancelled') throw new StoreError('This event was cancelled.', 'event_cancelled');
      if (ev.status !== 'published') throw new StoreError('This event is not open for registration yet.', 'event_not_open');
      if (new Date(ev.endsAt || ev.startsAt).getTime() < Date.now()) {
        throw new StoreError('This event has already happened.', 'event_past');
      }
      if (ev.hostId === user.id) throw new StoreError('You are hosting this one.', 'host_cannot_register');

      const existing = state.registrations.find((r) => r.eventId === ev.id && r.userId === user.id);
      const paid = (ev.priceCents ?? 0) > 0;

      if (existing && ['confirmed', 'waitlisted'].includes(existing.status)) {
        throw new StoreError('You are already on the list for this event.', 'already_registered');
      }
      // Mid-checkout already: resume rather than dead-ending them.
      if (existing && isLiveHold(existing)) {
        if (existing.status === 'pending') {
          existing.guests = seats;
          existing.amountCents = ev.priceCents * seats;
          existing.holdExpiresAt = new Date(Date.now() + HOLD_MINUTES * 60000).toISOString();
          save();
        }
        return { status: 'payment_required', simulated: true, resumed: true, event: shape(ev) };
      }

      const taken = takenSeatsFor(state, ev.id);
      const room = ev.capacity === null || taken + seats <= ev.capacity;

      const write = (fields) => {
        if (existing) Object.assign(existing, { guests: seats, note, createdAt: new Date().toISOString(), refundDue: false, refundedAt: null, paidAt: null, ...fields });
        else {
          state.registrations.push({
            id: uuid(), eventId: ev.id, userId: user.id, guests: seats, note,
            createdAt: new Date().toISOString(), refundDue: false, refundedAt: null, paidAt: null,
            amountCents: 0, currency: null, holdExpiresAt: null, ...fields,
          });
        }
        save();
      };

      // Full: a waitlist place, at no charge.
      if (!room) {
        write({ status: 'waitlisted', amountCents: 0, currency: null, holdExpiresAt: null });
        return { status: 'waitlisted', event: shape(ev) };
      }
      if (!paid) {
        write({ status: 'confirmed', amountCents: 0, currency: null, holdExpiresAt: null });
        return { status: 'confirmed', event: shape(ev) };
      }
      // Paid: hold the seat first, so the checkout window can't oversell.
      write({
        status: 'pending',
        amountCents: ev.priceCents * seats,
        currency: ev.currency || 'usd',
        holdExpiresAt: new Date(Date.now() + HOLD_MINUTES * 60000).toISOString(),
      });
      return { status: 'payment_required', simulated: true, event: shape(ev) };
    },

    /** Claim a seat offered after a waitlist promotion. */
    async claim(slug) {
      const user = requireUser();
      sweep();
      const ev = eventBySlug(slug);
      if (!ev) throw new StoreError('No event with that link.', 'not_found');
      const reg = state.registrations.find((r) => r.eventId === ev.id && r.userId === user.id);
      if (!reg || reg.status !== 'offered') {
        throw new StoreError('You do not have a seat offer to claim on this event.', 'no_offer');
      }
      reg.holdExpiresAt = new Date(Date.now() + HOLD_MINUTES * 60000).toISOString();
      save();
      return { status: 'payment_required', simulated: true, event: shape(ev) };
    },

    /**
     * Stand-in for the Stripe webhook. The real server only ever reaches this
     * state from a verified `checkout.session.completed`; here the user clicks
     * "Pay" in a clearly-labelled simulation.
     */
    async completeSimulatedPayment(slug) {
      const user = requireUser();
      const ev = eventBySlug(slug);
      if (!ev) throw new StoreError('No event with that link.', 'not_found');
      const reg = state.registrations.find((r) => r.eventId === ev.id && r.userId === user.id);
      if (!reg || !HOLDING.includes(reg.status)) {
        throw new StoreError('There is no payment in progress for this event.', 'nothing_to_pay');
      }
      // Mirrors the server: if the hold lapsed and the seat is gone, the money
      // goes back rather than overselling the room.
      const lapsed = !isLiveHold(reg);
      if (lapsed) {
        const room = ev.capacity === null || takenSeatsFor(state, ev.id) + reg.guests <= ev.capacity;
        if (!room) {
          reg.status = 'expired';
          reg.paidAt = new Date().toISOString();
          reg.refundDue = true;
          reg.refundedAt = new Date().toISOString();
          save();
          return { status: 'refunded', event: shape(ev) };
        }
      }
      reg.status = 'confirmed';
      reg.holdExpiresAt = null;
      reg.paidAt = new Date().toISOString();
      save();
      return { status: 'confirmed', event: shape(ev) };
    },

    /** Give up a held seat without waiting for the hold to lapse. */
    async releaseHold(slug) {
      const user = requireUser();
      const ev = eventBySlug(slug);
      if (!ev) throw new StoreError('No event with that link.', 'not_found');
      const reg = state.registrations.find((r) => r.eventId === ev.id && r.userId === user.id);
      if (!reg || !HOLDING.includes(reg.status)) throw new StoreError('You have nothing held on this event.', 'not_found');
      reg.status = 'cancelled';
      reg.holdExpiresAt = null;
      const promoted = promoteWaitlist(ev.id);
      save();
      return { released: true, promoted, event: shape(ev) };
    },

    /** Demo control: pretend every outstanding hold ran out of time. */
    async expireAllHolds() {
      for (const r of state.registrations) {
        if (HOLDING.includes(r.status)) r.holdExpiresAt = new Date(Date.now() - 1000).toISOString();
      }
      return sweep();
    },

    async cancelRegistration(slug) {
      const user = requireUser();
      const ev = eventBySlug(slug);
      if (!ev) throw new StoreError('No event with that link.', 'not_found');
      const reg = state.registrations.find((r) => r.eventId === ev.id && r.userId === user.id);
      if (!reg || !ACTIVE.includes(reg.status)) throw new StoreError('You are not registered for this event.', 'not_found');
      const heldASeat = ['confirmed', 'pending', 'offered'].includes(reg.status);
      reg.status = 'cancelled';
      reg.holdExpiresAt = null;
      const promoted = heldASeat ? promoteWaitlist(ev.id) : 0;
      save();
      return { promoted, event: shape(ev) };
    },

    async listRegistrations(slug) {
      const user = requireUser();
      const ev = eventBySlug(slug);
      if (!ev) throw new StoreError('No event with that link.', 'not_found');
      if (ev.hostId !== user.id) throw new StoreError('Only the host can see the guest list.', 'forbidden');
      const rank = { confirmed: 0, offered: 1, pending: 2, waitlisted: 3 };
      return state.registrations
        .filter((r) => r.eventId === ev.id && (ACTIVE.includes(r.status) || r.refundDue))
        .sort((a, b) => ((rank[a.status] ?? 4) - (rank[b.status] ?? 4))
          || a.createdAt.localeCompare(b.createdAt))
        .map((r) => {
          const u = userById(r.userId);
          return { ...r, user: u ? { id: u.id, name: u.name, email: u.email } : undefined };
        });
    },

    async myRegistrations() {
      const user = requireUser();
      sweep();
      return state.registrations
        .filter((r) => r.userId === user.id && (ACTIVE.includes(r.status) || r.refundDue))
        .map((r) => ({ ...r, event: shape(state.events.find((e) => e.id === r.eventId)) }))
        .filter((r) => r.event)
        .sort((a, b) => a.event.startsAt.localeCompare(b.event.startsAt));
    },

    async myEvents() {
      const user = requireUser();
      return state.events
        .filter((e) => e.hostId === user.id)
        .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
        .map(shape);
    },

    async reset() { state = seed(); save(); },
  };
}

/* ================================================== RemoteStore (the API) */

function RemoteStore(base) {
  const TOKEN_KEY = 'gather.token.v1';
  let token = storage.getItem(TOKEN_KEY) || null;

  async function call(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(base.replace(/\/$/, '') + path, {
        method, headers, credentials: 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new StoreError('Could not reach the server.', 'network');
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ics/csv */ }
    if (!res.ok) {
      const e = json?.error;
      throw new StoreError(e?.message || `Request failed (${res.status})`, e?.code || 'http_error');
    }
    return json ?? text;
  }

  return {
    mode: 'remote',
    categories: CATEGORIES,
    // Real Stripe Checkout, if the server has keys. Confirmed via meta().
    payments: 'live',

    async meta() { return call('GET', '/api/meta'); },
    async me() { return (await call('GET', '/api/me')).user; },

    async signIn({ email, name }) {
      const out = await call('POST', '/api/auth/session', { email, name });
      token = out.token;
      storage.setItem(TOKEN_KEY, token);
      return out.user;
    },

    async signOut() {
      try { await call('DELETE', '/api/auth/session'); } finally {
        token = null; storage.removeItem(TOKEN_KEY);
      }
    },

    async listEvents({ q, category, mode, when = 'upcoming' } = {}) {
      const p = new URLSearchParams();
      if (q) p.set('q', q);
      if (category) p.set('category', category);
      if (mode) p.set('mode', mode);
      if (when) p.set('when', when);
      return (await call('GET', `/api/events?${p}`)).events;
    },

    getEvent(slug) { return call('GET', `/api/events/${encodeURIComponent(slug)}`); },
    async createEvent(input) { return (await call('POST', '/api/events', input)).event; },
    async updateEvent(slug, patch) { return (await call('PATCH', `/api/events/${encodeURIComponent(slug)}`, patch)).event; },
    async cancelEvent(slug) { return (await call('POST', `/api/events/${encodeURIComponent(slug)}/cancel`, {})).event; },
    register(slug, body) { return call('POST', `/api/events/${encodeURIComponent(slug)}/registrations`, body); },
    claim(slug) { return call('POST', `/api/events/${encodeURIComponent(slug)}/registrations/claim`, {}); },
    releaseHold(slug) { return call('POST', `/api/events/${encodeURIComponent(slug)}/registrations/mine/release`, {}); },
    cancelRegistration(slug) { return call('DELETE', `/api/events/${encodeURIComponent(slug)}/registrations/mine`); },
    async listRegistrations(slug) { return (await call('GET', `/api/events/${encodeURIComponent(slug)}/registrations`)).registrations; },
    async myRegistrations() { return (await call('GET', '/api/me/registrations')).registrations; },
    async myEvents() { return (await call('GET', '/api/me/events')).events; },
  };
}

const Store = API_BASE ? RemoteStore(API_BASE) : LocalStore();

/* ============================================================ app state === */

const app = {
  user: null,
  route: { name: 'browse' },
  filters: { q: '', category: '', mode: '', when: 'upcoming' },
  cache: {},
  modal: null,
  busy: false,
  // 'live' (real Stripe), 'simulated' (on-device), or 'off' (server has no keys)
  payments: Store.payments,
  // { provider, delivers } — reported by the server. On-device, nothing sends.
  email: { provider: 'none', delivers: false },
};

/** True only when a configured server is actually posting mail. */
const emailsReal = () => Boolean(app.email?.delivers);

/** What to promise about the inbox, without overstating it. */
function inboxNote(kind) {
  const to = app.user?.email;
  if (!emailsReal()) {
    return 'The server sends a confirmation email with a calendar invite. Nothing sends from this on-device demo, so it is shown here instead.';
  }
  if (kind === 'waitlist') {
    return `If a spot opens up we'll email ${esc(to || 'you')} straight away.`;
  }
  return `A confirmation and calendar invite are on the way to ${esc(to || 'your inbox')}.`;
}

/* ---------------------------------------------------------------- toasts */

function toast(message, kind = '') {
  const host = el('toasts');
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.innerHTML = `<span>${kind === 'bad' ? '⚠' : kind === 'good' ? '✓' : 'ℹ'}</span><span>${esc(message)}</span>`;
  host.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0'; node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 260);
  }, 3600);
}

/* -------------------------------------------------------- files & clipboard */

function download(filename, text, mime) {
  try {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch { return false; }
}

function icsFor(ev) {
  const escIcs = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const end = ev.endsAt || new Date(new Date(ev.startsAt).getTime() + 2 * 3600e3).toISOString();
  const where = ev.mode === 'online' ? (ev.onlineUrl || 'Online')
    : [ev.venueName, ev.address, ev.city].filter(Boolean).join(', ');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Gather//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${ev.id}@gather`, `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(ev.startsAt)}`, `DTEND:${stamp(end)}`,
    `SUMMARY:${escIcs(ev.title)}`, `DESCRIPTION:${escIcs(ev.summary || ev.description)}`,
    `LOCATION:${escIcs(where)}`,
    `ORGANIZER;CN=${escIcs(ev.host.name)}:mailto:${ev.host.email || 'host@gather.example'}`,
    ev.status === 'cancelled' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

function csvFor(rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    ['Name', 'Email', 'Party size', 'Status', 'Registered at', 'Note'].join(','),
    ...rows.map((r) => [r.user?.name, r.user?.email, r.guests, r.status, r.createdAt, r.note].map(cell).join(',')),
  ].join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

/* ============================================================== components */

function coverImg(ev, cls = '') {
  if (!ev.coverUrl) return `<div class="${cls}" style="width:100%;height:100%"></div>`;
  return `<img src="${esc(ev.coverUrl)}" alt="" loading="lazy" decoding="async"
    onerror="this.style.display='none'">`;
}

function capacityBlock(ev, { compact = false } = {}) {
  const held = ev.heldSeats || 0;
  if (ev.capacity === null) {
    return `<div class="meter-row"><b>${ev.confirmedSeats} going</b><span>No limit</span></div>`;
  }
  const pctConfirmed = Math.min(100, Math.round((ev.confirmedSeats / ev.capacity) * 100));
  const pctHeld = Math.min(100 - pctConfirmed, Math.round((held / ev.capacity) * 100));
  const cls = ev.isFull ? 'full' : (ev.takenSeats / ev.capacity) >= 0.8 ? 'warn' : '';
  const right = ev.isFull
    ? (ev.waitlistCount ? `${ev.waitlistCount} waiting` : 'Sold out')
    : `${ev.seatsLeft} ${ev.seatsLeft === 1 ? 'spot' : 'spots'} left`;
  return `
    <div>
      <div class="meter-row"><b>${ev.confirmedSeats} of ${ev.capacity} going</b><span>${right}</span></div>
      <div class="meter ${cls}">
        <i style="width:${pctConfirmed}%"></i>
        ${pctHeld > 0 ? `<i class="held" style="width:${pctHeld}%"></i>` : ''}
      </div>
      ${held && !compact
    ? `<p style="margin-top:7px; font-size:12px; color:var(--ink-3)">${held} more ${held === 1 ? 'seat is' : 'seats are'} held for payments in progress.</p>`
    : ''}
    </div>`;
}

function statusChip(ev) {
  if (ev.status === 'cancelled') return '<span class="chip chip-stop">Cancelled</span>';
  if (ev.status === 'draft') return '<span class="chip chip-out">Draft</span>';
  if (ev.isPast) return '<span class="chip">Finished</span>';
  if (ev.isFull) return '<span class="chip chip-warn">Waitlist</span>';
  return '';
}

function eventCard(ev) {
  return `
  <a class="card" href="#/e/${esc(ev.slug)}">
    <div class="cover">
      ${coverImg(ev)}
      <div class="cover-fade"></div>
      <div class="datechip"><b>${monthShort(ev)}</b><span>${dayNum(ev)}</span></div>
      <div class="cover-tags">
        <span class="tag tag-price">${esc(priceLabel(ev))}</span>
        ${ev.mode === 'online' ? '<span class="tag">Online</span>' : ''}
      </div>
      <div class="cover-when">${esc(relativeDay(ev))} · ${esc(timeRange(ev))}</div>
    </div>
    <div class="card-body">
      <div class="card-meta">
        <span>${CATEGORY_ICON[ev.category] || '◎'} ${esc(ev.category)}</span>
        <span>·</span>
        <span>${esc(placeLabel(ev))}</span>
        ${statusChip(ev) ? `<span style="margin-left:auto">${statusChip(ev)}</span>` : ''}
      </div>
      <h3>${esc(ev.title)}</h3>
      ${ev.summary ? `<p class="card-sum">${esc(ev.summary)}</p>` : ''}
      <div class="card-foot">
        <div class="card-host">${avatar(ev.host, 'sm')}<span>by <b>${esc(ev.host.name)}</b></span></div>
        <div style="flex:1; min-width:60px">${capacityBlock(ev, { compact: true })}</div>
      </div>
    </div>
  </a>`;
}

function emptyState(icon, title, body, action = '') {
  return `<div class="empty"><div class="empty-ico">${icon}</div><h3>${esc(title)}</h3><p>${esc(body)}</p>${action}</div>`;
}

/* --------------------------------------------------------------- chrome */

function header() {
  const acct = app.user
    ? `<button class="av-btn" data-act="account">${avatar(app.user, 'sm')}<span>${esc(app.user.name)}</span></button>`
    : `<button class="btn btn-out btn-sm" data-act="signin">Sign in</button>`;
  const nav = [
    ['#/', 'Browse', app.route.name === 'browse'],
    ['#/tickets', 'My tickets', app.route.name === 'tickets'],
    ['#/hosting', 'Hosting', app.route.name === 'hosting'],
  ].map(([href, label, active]) =>
    `<a href="${href}"${active ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `
  <header class="hdr">
    <div class="wrap hdr-in">
      <a class="brand" href="#/"><span class="brand-dot"></span><span>Gather</span></a>
      <nav class="nav">${nav}</nav>
      <div class="hdr-sp"></div>
      <div class="acct">
        <a class="btn btn-ink btn-sm" href="#/new">Create event</a>
        ${acct}
      </div>
    </div>
  </header>`;
}

function footer() {
  const live = Store.mode === 'remote';
  const pay = app.payments;
  const payLabel = pay === 'live' ? 'Stripe Checkout live'
    : pay === 'off' ? 'Payments not configured'
      : 'Card step simulated';
  const mail = emailsReal();
  return `
  <footer class="ftr"><div class="wrap ftr-in">
    <span>Gather — a demo events platform.</span>
    <span style="display:flex; gap:8px; flex-wrap:wrap">
      <span class="mode-pill">
        <span class="mode-dot ${live ? 'live' : ''}"></span>
        ${live ? 'Connected to the API' : 'Running on this device'}
      </span>
      <span class="mode-pill">
        <span class="mode-dot ${pay === 'live' ? 'live' : ''}"></span>
        ${payLabel}
      </span>
      <span class="mode-pill">
        <span class="mode-dot ${mail ? 'live' : ''}"></span>
        ${mail ? `Email via ${esc(app.email.provider)}` : 'Email not sending'}
      </span>
    </span>
  </div></footer>`;
}

/* ================================================================= views */

async function viewBrowse() {
  const f = app.filters;
  const events = await Store.listEvents(f);
  const cats = ['', ...CATEGORIES].map((c) => `
    <button class="fchip" data-act="cat" data-cat="${esc(c)}" aria-pressed="${f.category === c}">
      ${c ? `${CATEGORY_ICON[c]} ${esc(c)}` : 'All categories'}
    </button>`).join('');

  const totalGoing = events.reduce((n, e) => n + e.confirmedSeats, 0);
  const hero = f.q || f.category || f.mode || f.when !== 'upcoming' ? '' : `
    <section class="hero"><div class="wrap">
      <h1>Find something worth leaving the house for.</h1>
      <p>Browse what people near you are running this month — or publish your own in about a minute and let Gather handle the guest list.</p>
      <div class="hero-stats">
        <div class="hero-stat"><b>${events.length}</b><span>Upcoming events</span></div>
        <div class="hero-stat"><b>${totalGoing}</b><span>People going</span></div>
        <div class="hero-stat"><b>${new Set(events.map((e) => e.host.id)).size}</b><span>Active hosts</span></div>
      </div>
    </div></section>`;

  return `
  ${hero}
  <div class="filters"><div class="wrap">
    <div class="search">
      <span aria-hidden="true" style="color:var(--ink-4)">⌕</span>
      <input id="q" type="search" placeholder="Search events, cities, categories…"
        value="${esc(f.q)}" autocomplete="off" aria-label="Search events">
      ${f.q ? '<button class="btn btn-ghost btn-sm" data-act="clear-q">Clear</button>' : ''}
    </div>
    <div class="filter-row">${cats}</div>
    <div class="filter-bar2">
      <div class="seg">
        ${[['upcoming', 'Upcoming'], ['week', 'This week'], ['past', 'Past']].map(([v, l]) =>
    `<button data-act="when" data-when="${v}" aria-pressed="${f.when === v}">${l}</button>`).join('')}
      </div>
      <div class="seg">
        ${[['', 'Anywhere'], ['in_person', 'In person'], ['online', 'Online']].map(([v, l]) =>
    `<button data-act="mode" data-mode="${v}" aria-pressed="${f.mode === v}">${l}</button>`).join('')}
      </div>
    </div>
  </div></div>
  <main id="main" class="wrap">
    <p class="result-line">${events.length} ${events.length === 1 ? 'event' : 'events'}${f.category ? ` in ${esc(f.category)}` : ''}${f.q ? ` matching “${esc(f.q)}”` : ''}</p>
    <div class="grid">
      ${events.length ? events.map(eventCard).join('')
    : emptyState('◎', 'Nothing here yet',
      f.q || f.category ? 'Try a different search or clear the filters.' : 'No events match this view.',
      `<button class="btn btn-out" data-act="reset-filters">Clear filters</button>`)}
    </div>
  </main>`;
}

async function viewDetail(slug) {
  let data;
  try {
    data = await Store.getEvent(slug);
  } catch {
    return `<main id="main" class="wrap page">${emptyState('⌕', 'Event not found',
      'That link does not point at anything. It may have been removed.',
      '<a class="btn btn-out" href="#/">Back to browse</a>')}</main>`;
  }
  const { event: ev, myRegistration: reg, isHost } = data;
  app.cache.event = ev;

  const banner = ev.status === 'cancelled'
    ? '<div class="banner banner-stop"><span>⚠</span><span>The host cancelled this event.</span></div>'
    : ev.isPast
      ? '<div class="banner banner-info"><span>◔</span><span>This event has already happened.</span></div>'
      : ev.status === 'draft'
        ? '<div class="banner banner-warn"><span>◌</span><span>This is a draft — only you can see it. Publish it to let people register.</span></div>'
        : '';

  const where = ev.mode === 'online'
    ? { icon: '⌘', title: 'Online event', sub: reg || isHost ? (ev.onlineUrl || 'Link shared before start') : 'Join link is shared with attendees' }
    : {
      icon: '⌖',
      title: ev.venueName || ev.city || 'Location TBA',
      sub: [ev.address, ev.city].filter(Boolean).join(', ') || 'Address shared with attendees',
    };

  const paragraphs = String(ev.description || '').split(/\n\s*\n/).filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>').replace(/`([^`]+)`/g, '<code>$1</code>')}</p>`).join('');

  return `
  <main id="main" class="wrap detail">
    <a class="back" href="#/">← Back to events</a>
    ${ev.coverUrl ? `<div class="detail-cover">${coverImg(ev)}</div>` : ''}
    <div class="detail-grid">
      <div>
        ${banner ? `<div style="margin-bottom:18px">${banner}</div>` : ''}
        <div class="detail-kicker">
          <span class="chip chip-accent">${CATEGORY_ICON[ev.category] || '◎'} ${esc(ev.category)}</span>
          <span class="chip">${esc(relativeDay(ev))}</span>
          ${statusChip(ev)}
        </div>
        <h1>${esc(ev.title)}</h1>
        ${ev.summary ? `<p class="detail-sum">${esc(ev.summary)}</p>` : ''}

        <div class="sect">
          <h4>Hosted by</h4>
          <div class="hostbox">
            ${avatar(ev.host, 'lg')}
            <div><b>${esc(ev.host.name)}</b><span>${isHost ? 'That’s you' : esc(ev.host.email || 'Host')}</span></div>
          </div>
        </div>

        ${paragraphs ? `<div class="sect"><h4>About</h4><div class="prose">${paragraphs}</div></div>` : ''}

        <div class="sect">
          <h4>When &amp; where</h4>
          <div class="facts">
            <div class="fact">
              <div class="fact-ico">◔</div>
              <div><b>${esc(longDate(ev))}</b><span>${esc(timeRange(ev))}</span></div>
            </div>
            <div class="fact">
              <div class="fact-ico">${where.icon}</div>
              <div><b>${esc(where.title)}</b><span>${esc(where.sub)}</span></div>
            </div>
            <div class="fact">
              <div class="fact-ico">◍</div>
              <div><b>${esc(priceLabel(ev))}${ev.isPaid ? ' per person' : ''}</b><span>${ev.capacity === null ? 'No capacity limit' : `Capacity ${ev.capacity}`}</span></div>
            </div>
          </div>
        </div>

        <div class="sect">
          <h4>Turnout</h4>
          ${capacityBlock(ev)}
          <p style="margin-top:11px; font-size:13.5px; color:var(--ink-3)">
            ${ev.confirmedSeats} confirmed${ev.waitlistCount ? ` · ${ev.waitlistCount} on the waitlist` : ''}.
            ${isHost ? 'You can see the full guest list in the panel.' : 'Guest names are visible to the host only.'}
          </p>
        </div>
      </div>

      <div class="panel-wrap">
        ${isHost ? hostPanel(ev) : attendeePanel(ev, reg)}
        <div class="share">
          <button class="btn btn-out btn-sm" data-act="copy-link" data-slug="${esc(ev.slug)}">Copy link</button>
          <button class="btn btn-out btn-sm" data-act="ics" data-slug="${esc(ev.slug)}">Add to calendar</button>
        </div>
      </div>
    </div>
    ${isHost ? '<div id="guests" style="margin-top:38px"></div>' : ''}
  </main>`;
}

function attendeePanel(ev, reg) {
  const closed = ev.status === 'cancelled' || ev.isPast || ev.status === 'draft';

  const owed = (r) => money(r.amountCents, r.currency || ev.currency);

  let body;
  if (reg && reg.status === 'pending') {
    // Seat is held. Nothing is confirmed until the payment lands.
    body = `
      <div class="banner banner-warn">
        <span>◔</span>
        <span>Payment unfinished. ${reg.guests} ${reg.guests === 1 ? 'seat is' : 'seats are'} held for you${reg.holdExpiresAt
    ? ` until ${esc(clockLabel(reg.holdExpiresAt, ev.timezone))}, ${esc(untilLabel(reg.holdExpiresAt))}` : ''}.</span>
      </div>
      <button class="btn btn-pri btn-lg" data-act="pay" data-slug="${esc(ev.slug)}">
        Complete payment — ${esc(owed(reg))}
      </button>
      <button class="btn btn-ghost btn-block" data-act="release" data-slug="${esc(ev.slug)}">Give up my hold</button>
      <p class="panel-note">If the hold runs out before you pay, the seat passes to whoever is next in line.</p>`;
  } else if (reg && reg.status === 'offered') {
    body = `
      <div class="banner banner-info">
        <span>★</span>
        <span>A spot opened up and it's yours if you want it — held for you${reg.holdExpiresAt
    ? ` ${esc(untilLabel(reg.holdExpiresAt))}` : ''}.</span>
      </div>
      <button class="btn btn-pri btn-lg" data-act="claim" data-slug="${esc(ev.slug)}">
        Claim my seat — ${esc(owed(reg))}
      </button>
      <button class="btn btn-ghost btn-block" data-act="unregister" data-slug="${esc(ev.slug)}">
        No thanks, pass it on
      </button>
      <p class="panel-note">You were on the waitlist. Waiting is never charged — payment only happens now, if you claim it.</p>`;
  } else if (reg && reg.refundDue) {
    body = `
      <div class="banner banner-stop">
        <span>↩</span>
        <span>Your payment arrived after the last seat had gone, so it was refunded${reg.refundedAt ? '' : ' — that is in progress'}.</span>
      </div>
      <p class="panel-note">Refunding is the honest outcome here. The alternative is overselling the room.</p>`;
  } else if (reg) {
    const confirmed = reg.status === 'confirmed';
    body = `
      <div class="banner ${confirmed ? 'banner-ok' : 'banner-warn'}">
        <span>${confirmed ? '✓' : '◔'}</span>
        <span>${confirmed
    ? `You’re going${reg.guests > 1 ? ` — party of ${reg.guests}` : ''}.`
    : `You’re on the waitlist${reg.guests > 1 ? ` for ${reg.guests}` : ''}. ${emailsReal()
      ? 'We’ll email you the moment a spot frees.'
      : 'We’ll move you up if a spot frees.'}`}</span>
      </div>
      ${reg.paidAt ? `<div class="banner banner-ok" style="font-weight:500">
        <span>◍</span><span>Paid ${esc(owed(reg))}. Refunds are at the host's discretion.</span>
      </div>` : ''}
      <button class="btn btn-out btn-block" data-act="ics" data-slug="${esc(ev.slug)}">Add to calendar</button>
      ${closed ? '' : `<button class="btn btn-danger btn-block" data-act="unregister" data-slug="${esc(ev.slug)}">Cancel my registration</button>`}
      <p class="panel-note">${inboxNote(reg.status === 'waitlisted' ? 'waitlist' : 'confirmed')}</p>`;
  } else if (closed) {
    body = `
      <div class="banner banner-info"><span>ℹ</span><span>${ev.status === 'cancelled'
    ? 'Registration is closed — this event was cancelled.'
    : 'Registration is closed for this event.'}</span></div>`;
  } else if (!app.user) {
    body = `
      ${ev.isFull ? '<div class="banner banner-warn"><span>◔</span><span>Sold out — you can still join the waitlist.</span></div>' : ''}
      <button class="btn btn-pri btn-lg" data-act="signin">Sign in to register</button>
      <p class="panel-note">Email and a display name. No password, no verification.</p>`;
  } else {
    const opts = Array.from({ length: 10 }, (_, i) => i + 1)
      .map((n) => `<option value="${n}">${n === 1 ? 'Just me' : `${n} people`}</option>`).join('');
    body = `
      ${ev.isFull ? '<div class="banner banner-warn"><span>◔</span><span>Sold out. Register anyway and you’ll be added to the waitlist in order.</span></div>' : ''}
      <div class="field">
        <label for="guests">How many are coming?</label>
        <select class="inp" id="guests">${opts}</select>
      </div>
      <div class="field">
        <label for="note">Anything the host should know? <span class="hint">Optional</span></label>
        <textarea class="inp" id="note" placeholder="Dietary needs, arriving late, bringing a friend…"></textarea>
      </div>
      ${ev.isPaid && !ev.isFull ? `<p id="total-line" class="panel-note" style="text-align:left; font-weight:600; color:var(--ink-2)"
        data-price="${ev.priceCents}" data-currency="${esc(ev.currency)}">
        Total ${esc(money(ev.priceCents, ev.currency))} · ${esc(money(ev.priceCents, ev.currency))} per person
      </p>` : ''}
      <button class="btn ${ev.isFull ? 'btn-ink' : 'btn-pri'} btn-lg" data-act="register" data-slug="${esc(ev.slug)}">
        ${ev.isFull ? 'Join the waitlist'
    : ev.isPaid ? `Register — ${esc(money(ev.priceCents, ev.currency))}` : 'Register'}
      </button>
      <p class="panel-note">${ev.isFull
    ? 'A waitlist place is free. You are only asked to pay if a seat opens up for you.'
    : ev.isPaid
      ? `Your seat is held for ${HOLD_MINUTES} minutes while you pay. Free to cancel any time.`
      : 'Free to cancel any time. Cancelling frees your spot for whoever is next.'}</p>`;
  }

  return `
  <div class="panel">
    <div class="panel-head">
      <div class="panel-price">${esc(priceLabel(ev))} ${ev.isPaid ? '<small>per person</small>' : ''}</div>
      <div style="margin-top:6px; font-size:13.5px; color:var(--ink-3); font-weight:500">
        ${esc(shortDate(ev))} · ${esc(timeRange(ev))}
      </div>
    </div>
    <div class="panel-body">${body}</div>
  </div>`;
}

function hostPanel(ev) {
  const live = ev.status === 'published';
  return `
  <div class="hostpanel">
    <div class="panel-head">
      <div style="display:flex; align-items:center; gap:9px">
        <span class="chip chip-accent">You’re hosting</span>
        ${statusChip(ev)}
      </div>
      <div style="margin-top:9px; font-size:13.5px; color:var(--ink-2); font-weight:500">
        ${ev.confirmedSeats} confirmed${ev.heldSeats ? ` · ${ev.heldSeats} held mid-payment` : ''}${ev.waitlistCount ? ` · ${ev.waitlistCount} waiting` : ''}${ev.capacity !== null ? ` · ${ev.seatsLeft} left` : ''}
      </div>
    </div>
    <div class="panel-body">
      ${capacityBlock(ev)}
      <a class="btn btn-ink btn-block" href="#/edit/${esc(ev.slug)}">Edit event</a>
      <button class="btn btn-out btn-block" data-act="load-guests" data-slug="${esc(ev.slug)}">View guest list</button>
      ${ev.status === 'draft'
    ? `<button class="btn btn-pri btn-block" data-act="publish" data-slug="${esc(ev.slug)}">Publish event</button>` : ''}
      ${live && !ev.isPast
    ? `<button class="btn btn-danger btn-block" data-act="cancel-event" data-slug="${esc(ev.slug)}">Cancel this event</button>` : ''}
    </div>
  </div>`;
}

function guestList(rows, ev) {
  const confirmed = rows.filter((r) => r.status === 'confirmed');
  const waiting = rows.filter((r) => r.status === 'waitlisted');
  const holding = rows.filter((r) => r.status === 'pending' || r.status === 'offered');
  const refunds = rows.filter((r) => r.refundDue);
  const seats = confirmed.reduce((n, r) => n + r.guests, 0);
  const heldSeats = holding.reduce((n, r) => n + r.guests, 0);
  const takings = confirmed.reduce((n, r) => n + (r.amountCents || 0), 0);

  const STATUS_CHIP = {
    confirmed: ['chip-ok', 'Confirmed'],
    pending: ['chip-warn', 'Paying…'],
    offered: ['chip-accent', 'Offered'],
    waitlisted: ['chip-out', 'Waitlist'],
  };

  const row = (r) => {
    const [cls, label] = r.refundDue
      ? ['chip-stop', r.refundedAt ? 'Refunded' : 'Refund due']
      : (STATUS_CHIP[r.status] || ['chip', r.status]);
    return `
    <div class="grow">
      ${avatar(r.user, 'md')}
      <div class="grow-id">
        <b>${esc(r.user?.name || 'Guest')}</b>
        <span>${esc(r.user?.email || '')}${r.note ? ` — “${esc(r.note)}”` : ''}</span>
      </div>
      ${r.amountCents ? `<span class="chip">${esc(money(r.amountCents, r.currency))}</span>` : ''}
      ${r.guests > 1 ? `<span class="chip">Party of ${r.guests}</span>` : ''}
      <span class="chip ${cls}">${esc(label)}</span>
    </div>`;
  };

  return `
  <div class="glist">
    <div class="glist-head">
      <div>
        <h4 style="font-size:15px; text-transform:none; letter-spacing:-.02em; color:var(--ink)">Guest list</h4>
        <span style="font-size:13px; color:var(--ink-3)">
          ${confirmed.length} confirmed · ${seats} seats${heldSeats ? ` · ${heldSeats} held mid-payment` : ''}${waiting.length ? ` · ${waiting.length} waiting` : ''}${takings ? ` · ${esc(money(takings, confirmed[0]?.currency))} taken` : ''}${refunds.length ? ` · ${refunds.length} refunded` : ''}
        </span>
      </div>
      <button class="btn btn-out btn-sm" data-act="csv" data-slug="${esc(ev.slug)}">Export CSV</button>
    </div>
    <div class="table-scroll">
      ${rows.length ? rows.map(row).join('')
    : '<div class="grow"><span style="color:var(--ink-3); font-size:14px">Nobody has registered yet. Share the link.</span></div>'}
    </div>
  </div>`;
}

async function viewTickets() {
  if (!app.user) {
    return `<main id="main" class="wrap page">${emptyState('◔', 'Sign in to see your tickets',
      'Your registrations live under your email address.',
      '<button class="btn btn-pri" data-act="signin">Sign in</button>')}</main>`;
  }
  const regs = await Store.myRegistrations();
  const upcoming = regs.filter((r) => !r.event.isPast);
  const past = regs.filter((r) => r.event.isPast);

  const row = (r) => {
    const ev = r.event;
    const cancelled = ev.status === 'cancelled';
    return `
    <div class="drow">
      <a class="drow-cover" href="#/e/${esc(ev.slug)}">${coverImg(ev)}</a>
      <div class="drow-main">
        <a href="#/e/${esc(ev.slug)}"><b>${esc(ev.title)}</b></a>
        <div class="drow-meta">
          <span>${esc(shortDate(ev))} · ${esc(timeRange(ev))}</span>
          <span>·</span><span>${esc(placeLabel(ev))}</span>
          ${(() => {
    if (cancelled) return '<span class="chip chip-stop">Event cancelled</span>';
    if (r.refundDue) return `<span class="chip chip-stop">${r.refundedAt ? 'Refunded' : 'Refund due'}</span>`;
    const map = {
      confirmed: ['chip-ok', 'Confirmed'],
      pending: ['chip-warn', 'Payment unfinished'],
      offered: ['chip-accent', 'Seat offered'],
      waitlisted: ['chip-out', 'Waitlisted'],
    };
    const [cls, label] = map[r.status] || ['chip', r.status];
    return `<span class="chip ${cls}">${esc(label)}</span>`;
  })()}
          ${r.guests > 1 ? `<span class="chip">Party of ${r.guests}</span>` : ''}
          ${r.amountCents && r.status === 'confirmed' ? `<span class="chip">${esc(money(r.amountCents, r.currency))} paid</span>` : ''}
        </div>
      </div>
      <div class="drow-acts">
        ${!cancelled && r.status === 'pending'
    ? `<button class="btn btn-pri btn-sm" data-act="pay" data-slug="${esc(ev.slug)}">Finish paying</button>` : ''}
        ${!cancelled && r.status === 'offered'
    ? `<button class="btn btn-pri btn-sm" data-act="claim" data-slug="${esc(ev.slug)}">Claim seat</button>` : ''}
        <button class="btn btn-out btn-sm" data-act="ics" data-slug="${esc(ev.slug)}">Calendar</button>
        ${ev.isPast || cancelled ? '' : `<button class="btn btn-danger btn-sm" data-act="unregister" data-slug="${esc(ev.slug)}">Cancel</button>`}
      </div>
    </div>`;
  };

  return `
  <main id="main" class="wrap page" style="max-width:900px">
    <div class="page-head">
      <h1>My tickets</h1>
      <p>Everything you’ve registered for, as ${esc(app.user.email)}.</p>
    </div>
    ${upcoming.length ? `<div class="stack">${upcoming.map(row).join('')}</div>`
    : emptyState('◎', 'No upcoming tickets', 'When you register for something it shows up here.',
      '<a class="btn btn-pri" href="#/">Browse events</a>')}
    ${past.length ? `
      <h4 style="margin:34px 0 13px; font-size:11.5px; text-transform:uppercase; letter-spacing:.1em; color:var(--ink-4)">Past</h4>
      <div class="stack" style="opacity:.72">${past.map(row).join('')}</div>` : ''}
  </main>`;
}

async function viewHosting() {
  if (!app.user) {
    return `<main id="main" class="wrap page">${emptyState('▤', 'Sign in to host',
      'Publish an event and manage who’s coming.',
      '<button class="btn btn-pri" data-act="signin">Sign in</button>')}</main>`;
  }
  const events = await Store.myEvents();
  const totalGuests = events.reduce((n, e) => n + e.confirmedSeats, 0);

  const row = (ev) => `
    <div class="drow">
      <a class="drow-cover" href="#/e/${esc(ev.slug)}">${coverImg(ev)}</a>
      <div class="drow-main">
        <a href="#/e/${esc(ev.slug)}"><b>${esc(ev.title)}</b></a>
        <div class="drow-meta">
          <span>${esc(shortDate(ev))}</span><span>·</span>
          <span>${esc(placeLabel(ev))}</span>
          ${statusChip(ev) || '<span class="chip chip-ok">Live</span>'}
          <span class="chip">${ev.confirmedSeats}${ev.capacity !== null ? `/${ev.capacity}` : ''} going</span>
          ${ev.heldSeats ? `<span class="chip chip-accent">${ev.heldSeats} paying</span>` : ''}
          ${ev.waitlistCount ? `<span class="chip chip-warn">${ev.waitlistCount} waiting</span>` : ''}
          ${ev.isPaid ? `<span class="chip">${esc(priceLabel(ev))}</span>` : ''}
        </div>
      </div>
      <div class="drow-acts">
        <button class="btn btn-out btn-sm" data-act="load-guests" data-slug="${esc(ev.slug)}">Guests</button>
        <a class="btn btn-out btn-sm" href="#/edit/${esc(ev.slug)}">Edit</a>
      </div>
    </div>`;

  return `
  <main id="main" class="wrap page" style="max-width:900px">
    <div class="page-head" style="display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap">
      <div>
        <h1>Hosting</h1>
        <p>${events.length ? `${events.length} ${events.length === 1 ? 'event' : 'events'} · ${totalGuests} people registered across them.` : 'You haven’t published anything yet.'}</p>
      </div>
      <a class="btn btn-pri" href="#/new">Create event</a>
    </div>
    ${events.length ? `<div class="stack">${events.map(row).join('')}</div>`
    : emptyState('◎', 'No events yet',
      'Publishing takes about a minute. You can save a draft first and publish when you’re ready.',
      '<a class="btn btn-pri" href="#/new">Create your first event</a>')}
    <div id="guests" style="margin-top:30px"></div>
  </main>`;
}

/* ------------------------------------------------------------- event form */

function toLocalInputs(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

async function viewEventForm(slug) {
  if (!app.user) {
    return `<main id="main" class="wrap page">${emptyState('◎', 'Sign in to publish',
      'Events are attached to your email address so you can manage them later.',
      '<button class="btn btn-pri" data-act="signin">Sign in</button>')}</main>`;
  }

  let ev = null;
  if (slug) {
    try {
      const d = await Store.getEvent(slug);
      if (!d.isHost) {
        return `<main id="main" class="wrap page">${emptyState('⚠', 'Not your event',
          'Only the host can edit this one.', '<a class="btn btn-out" href="#/">Back to browse</a>')}</main>`;
      }
      ev = d.event;
    } catch {
      return `<main id="main" class="wrap page">${emptyState('⌕', 'Event not found', 'That link does not point at anything.',
        '<a class="btn btn-out" href="#/">Back to browse</a>')}</main>`;
    }
  }

  const start = toLocalInputs(ev ? ev.startsAt : new Date(Date.now() + 7 * 864e5).setHours(19, 0, 0, 0));
  const hours = ev && ev.endsAt
    ? Math.max(0.5, Math.round(((new Date(ev.endsAt) - new Date(ev.startsAt)) / 3600e3) * 2) / 2)
    : 2;
  const mode = ev?.mode || 'in_person';
  const covers = [...new Set(SEED.events.map((e) => e.coverUrl).filter(Boolean))];
  app.cache.form = { mode, coverUrl: ev?.coverUrl || covers[0] || '', slug: slug || null };

  const durations = [[1, '1 hour'], [1.5, '90 minutes'], [2, '2 hours'], [3, '3 hours'], [4, '4 hours'], [6, '6 hours'], [8, 'All day']];

  return `
  <main id="main" class="wrap page">
    <div class="page-head">
      <h1>${ev ? 'Edit event' : 'Create an event'}</h1>
      <p>${ev ? 'Changes go live immediately for anyone holding the link.' : 'Only a title, a date and a place are required. Everything else is optional.'}</p>
    </div>
    <form class="formcard" id="event-form" novalidate>
      <div id="form-err" hidden class="err"></div>

      <div class="field">
        <label for="f-title">Event title</label>
        <input class="inp" id="f-title" maxlength="140" placeholder="Rooftop Sessions: Jazz &amp; Small Plates"
          value="${esc(ev?.title || '')}" required>
      </div>

      <div class="field">
        <label for="f-summary">One-line summary <span class="hint">Shown on the browse cards</span></label>
        <input class="inp" id="f-summary" maxlength="200" placeholder="A live trio, skyline views, and small plates."
          value="${esc(ev?.summary || '')}">
      </div>

      <div class="field">
        <label for="f-desc">Description</label>
        <textarea class="inp" id="f-desc" rows="7" placeholder="What actually happens? Who is it for? What should people bring?">${esc(ev?.description || '')}</textarea>
      </div>

      <div class="fgrid">
        <div class="field">
          <label for="f-cat">Category</label>
          <select class="inp" id="f-cat">
            ${CATEGORIES.map((c) => `<option value="${esc(c)}"${(ev?.category || 'Community') === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="f-price">Ticket price <span class="hint">Zero makes it a free event</span></label>
          <div style="display:flex; gap:8px">
            <select class="inp" id="f-currency" style="max-width:92px">
              ${CURRENCIES.map((c) => `<option value="${c}"${(ev?.currency || 'usd') === c ? ' selected' : ''}>${c.toUpperCase()}</option>`).join('')}
            </select>
            <input class="inp" id="f-price" type="number" min="0" step="0.01" placeholder="0.00"
              value="${ev ? toMajor(ev.priceCents || 0, ev.currency) : '0.00'}">
          </div>
        </div>
      </div>

      <div class="fgrid-3">
        <div class="field">
          <label for="f-date">Date</label>
          <input class="inp" id="f-date" type="date" value="${start.date}" required>
        </div>
        <div class="field">
          <label for="f-time">Start time</label>
          <input class="inp" id="f-time" type="time" value="${start.time}" required>
        </div>
        <div class="field">
          <label for="f-dur">Runs for</label>
          <select class="inp" id="f-dur">
            ${durations.map(([v, l]) => `<option value="${v}"${v === hours ? ' selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="field">
        <label>Where</label>
        <div class="toggle" role="group">
          <button type="button" data-act="form-mode" data-mode="in_person" aria-pressed="${mode === 'in_person'}">In person</button>
          <button type="button" data-act="form-mode" data-mode="online" aria-pressed="${mode === 'online'}">Online</button>
        </div>
      </div>

      <div id="place-inperson" ${mode === 'online' ? 'hidden' : ''}>
        <div class="fgrid">
          <div class="field">
            <label for="f-venue">Venue name</label>
            <input class="inp" id="f-venue" placeholder="The Wythe Roof" value="${esc(ev?.venueName || '')}">
          </div>
          <div class="field">
            <label for="f-city">City</label>
            <input class="inp" id="f-city" placeholder="Brooklyn, NY" value="${esc(ev?.city || '')}">
          </div>
        </div>
        <div class="field" style="margin-top:15px">
          <label for="f-addr">Street address <span class="hint">Optional</span></label>
          <input class="inp" id="f-addr" placeholder="80 Wythe Ave" value="${esc(ev?.address || '')}">
        </div>
      </div>

      <div id="place-online" ${mode === 'online' ? '' : 'hidden'}>
        <div class="field">
          <label for="f-url">Join link</label>
          <input class="inp" id="f-url" type="url" placeholder="https://meet.example.com/my-event" value="${esc(ev?.onlineUrl || '')}">
        </div>
      </div>

      <div class="field">
        <label for="f-cap">Capacity <span class="hint">Leave blank for no limit. Extra registrations become a waitlist.</span></label>
        <input class="inp" id="f-cap" type="number" min="1" step="1" placeholder="No limit"
          value="${ev?.capacity ?? ''}">
      </div>

      <div class="field">
        <label>Cover image</label>
        <div class="covers">
          ${covers.map((c) => `
            <button type="button" data-act="pick-cover" data-cover="${esc(c)}"
              aria-pressed="${(app.cache.form.coverUrl) === c}">
              <img src="${esc(c)}" alt="" loading="lazy">
            </button>`).join('')}
        </div>
      </div>

      <div class="form-foot">
        ${ev ? `<a class="btn btn-ghost" href="#/e/${esc(ev.slug)}">Cancel</a>`
    : '<a class="btn btn-ghost" href="#/">Cancel</a>'}
        ${!ev || ev.status === 'draft'
    ? `<button type="button" class="btn btn-out" data-act="save-event" data-status="draft">Save as draft</button>` : ''}
        <button type="button" class="btn btn-pri" data-act="save-event" data-status="published">
          ${ev ? 'Save changes' : 'Publish event'}
        </button>
      </div>
    </form>
  </main>`;
}

/* =============================================================== modals === */

function signInModal() {
  const demos = (SEED.users || []).slice(0, 6);
  return `
  <div class="scrim" data-act="close-modal">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="si-t" data-stop>
      <div class="modal-head">
        <h3 id="si-t">Sign in to Gather</h3>
        <p>An email and a display name is all it takes. No password — this is a demo, so anything you type works.</p>
      </div>
      <div class="modal-body">
        <div id="si-err" hidden class="err"></div>
        <div class="field">
          <label for="si-email">Email</label>
          <input class="inp" id="si-email" type="email" placeholder="you@example.com" autocomplete="email">
        </div>
        <div class="field">
          <label for="si-name">Display name</label>
          <input class="inp" id="si-name" placeholder="Your name" autocomplete="name">
        </div>
        <button class="btn btn-pri btn-lg" data-act="do-signin">Continue</button>
        ${demos.length ? `
          <div class="divider">or sign in as a host</div>
          <div class="demo-list">
            ${demos.map((u) => `
              <button class="demo" data-act="do-signin" data-email="${esc(u.email)}" data-name="${esc(u.name)}">
                ${avatar(u, 'sm')}
                <div class="demo-id"><b>${esc(u.name)}</b><span>${esc(u.email)}</span></div>
              </button>`).join('')}
          </div>
          <p class="panel-note">These accounts already host events, so you can try the host tools straight away.</p>` : ''}
      </div>
    </div>
  </div>`;
}

function accountModal() {
  return `
  <div class="scrim" data-act="close-modal">
    <div class="modal" role="dialog" aria-modal="true" style="max-width:376px" data-stop>
      <div class="modal-head">
        <div style="display:flex; align-items:center; gap:12px">
          ${avatar(app.user, 'lg')}
          <div>
            <h3 style="font-size:17px">${esc(app.user.name)}</h3>
            <p style="margin-top:2px; font-size:13px">${esc(app.user.email)}</p>
          </div>
        </div>
      </div>
      <div class="modal-body">
        <a class="btn btn-out btn-block" href="#/tickets" data-act="close-modal">My tickets</a>
        <a class="btn btn-out btn-block" href="#/hosting" data-act="close-modal">Events I’m hosting</a>
        <button class="btn btn-ghost btn-block" data-act="signout">Sign out</button>
        ${Store.mode === 'local' ? `
          <div class="divider">demo controls</div>
          <button class="btn btn-out btn-block" data-act="expire-holds">Expire all held seats now</button>
          <p class="panel-note">Skips the 30-minute wait so you can watch lapsed holds release and the waitlist move up.</p>
          <button class="btn btn-danger btn-block" data-act="reset-demo">Reset all demo data</button>
          <p class="panel-note">Wipes local events and registrations and restores the original sample set.</p>` : ''}
      </div>
    </div>
  </div>`;
}

function confirmModal({ title, body, confirmLabel, act, slug, danger = true }) {
  return `
  <div class="scrim" data-act="close-modal">
    <div class="modal" role="dialog" aria-modal="true" style="max-width:400px" data-stop>
      <div class="modal-head"><h3>${esc(title)}</h3><p>${esc(body)}</p></div>
      <div class="modal-body">
        <button class="btn ${danger ? 'btn-danger' : 'btn-pri'} btn-lg" data-act="${act}" data-slug="${esc(slug)}" data-confirmed="1">
          ${esc(confirmLabel)}
        </button>
        <button class="btn btn-ghost btn-block" data-act="close-modal">Never mind</button>
      </div>
    </div>
  </div>`;
}

/* ================================================================ router */

function parseRoute() {
  const raw = (location.hash || '#/').replace(/^#/, '');
  // Stripe's return URLs put their query inside the fragment
  // (#/e/slug?checkout=success), so split it off before routing.
  const qIdx = raw.indexOf('?');
  const path = qIdx === -1 ? raw : raw.slice(0, qIdx);
  const params = new URLSearchParams(qIdx === -1 ? '' : raw.slice(qIdx + 1));
  const seg = path.split('/').filter(Boolean);

  if (!seg.length) return { name: 'browse', params };
  if (seg[0] === 'e' && seg[1]) return { name: 'detail', slug: decodeURIComponent(seg[1]), params };
  if (seg[0] === 'tickets') return { name: 'tickets', params };
  if (seg[0] === 'hosting') return { name: 'hosting', params };
  if (seg[0] === 'new') return { name: 'form', slug: null, params };
  if (seg[0] === 'edit' && seg[1]) return { name: 'form', slug: decodeURIComponent(seg[1]), params };
  return { name: 'browse', params };
}

async function render({ keepScroll = false } = {}) {
  app.route = parseRoute();
  const y = window.scrollY;
  // Only restore search focus if the user was actually typing — otherwise
  // every filter click would yank focus (and pop the keyboard on mobile).
  const wasTyping = document.activeElement?.id === 'q';
  const root = el('root');
  let view = '';
  try {
    if (app.route.name === 'detail') view = await viewDetail(app.route.slug);
    else if (app.route.name === 'tickets') view = await viewTickets();
    else if (app.route.name === 'hosting') view = await viewHosting();
    else if (app.route.name === 'form') view = await viewEventForm(app.route.slug);
    else view = await viewBrowse();
  } catch (err) {
    view = `<main id="main" class="wrap page">${emptyState('⚠', 'Something went wrong',
      err.message || 'Unexpected error.', '<a class="btn btn-out" href="#/">Back to browse</a>')}</main>`;
  }
  root.innerHTML = header() + view + footer() + (app.modal || '');
  if (keepScroll) window.scrollTo(0, y);
  const q = el('q');
  if (q && wasTyping) {
    // Preserve caret position across re-renders triggered by typing.
    q.focus({ preventScroll: true });
    q.setSelectionRange(q.value.length, q.value.length);
  }
  const focusTarget = el('si-email');
  if (focusTarget) focusTarget.focus();
  maybeHandleCheckoutReturn();
}

function openModal(html) { app.modal = html; render({ keepScroll: true }); }
function closeModal() { app.modal = null; render({ keepScroll: true }); }

/* =============================================================== actions */

function readEventForm(status) {
  const val = (id) => (el(id)?.value ?? '').trim();
  const mode = app.cache.form.mode;
  const date = val('f-date');
  const time = val('f-time');
  const startsAt = date && time ? new Date(`${date}T${time}`) : null;
  if (!startsAt || Number.isNaN(startsAt.getTime())) throw new StoreError('Pick a valid date and time.', 'invalid_date');
  const hours = Number(el('f-dur')?.value || 2);
  const capRaw = val('f-cap');

  return {
    title: val('f-title'),
    summary: val('f-summary'),
    description: val('f-desc'),
    category: el('f-cat')?.value,
    currency: el('f-currency')?.value || 'usd',
    priceCents: toMinor(val('f-price'), el('f-currency')?.value || 'usd'),
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + hours * 3600e3).toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    mode,
    venueName: mode === 'in_person' ? val('f-venue') : null,
    address: mode === 'in_person' ? val('f-addr') : null,
    city: mode === 'in_person' ? val('f-city') : null,
    onlineUrl: mode === 'online' ? val('f-url') : null,
    capacity: capRaw === '' ? null : Number(capRaw),
    coverUrl: app.cache.form.coverUrl || null,
    status,
  };
}

function showFormError(msg) {
  const box = el('form-err');
  if (!box) return toast(msg, 'bad');
  box.hidden = false;
  box.textContent = msg;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function loadGuests(slug) {
  const host = el('guests');
  if (!host) return;
  host.innerHTML = '<div class="glist"><div class="grow"><span style="color:var(--ink-3);font-size:14px">Loading guest list…</span></div></div>';
  try {
    const rows = await Store.listRegistrations(slug);
    const ev = app.cache.event?.slug === slug ? app.cache.event : (await Store.getEvent(slug)).event;
    app.cache.guests = { slug, rows };
    host.innerHTML = guestList(rows, ev);
    host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    host.innerHTML = '';
    toast(err.message, 'bad');
  }
}

/* ------------------------------------------------------ checkout plumbing */

/** Hand off to Stripe's hosted Checkout page. */
function goToCheckout(url) {
  toast('Taking you to Stripe…');
  try {
    // Published artifacts render inside an iframe; Stripe must not be framed.
    (window.top || window).location.assign(url);
  } catch {
    window.location.assign(url);
  }
}

/**
 * One place to interpret the outcome of asking for a seat, because the three
 * answers are genuinely different: confirmed, waitlisted, or "pay now".
 */
async function afterRegistration(out, slug) {
  if (out.status === 'payment_required') {
    if (out.checkoutUrl) return goToCheckout(out.checkoutUrl);
    // No server on this device to reach Stripe with — run the labelled
    // simulation instead, over the same held-seat state machine.
    const { event, myRegistration } = await Store.getEvent(slug);
    await render({ keepScroll: true });
    if (myRegistration) openModal(simulatedCheckoutModal({ event, registration: myRegistration }));
    return;
  }
  await render({ keepScroll: true });
  toast(out.status === 'confirmed'
    ? (emailsReal() ? 'You’re registered — check your inbox for the calendar invite.' : 'You’re registered.')
    : `Added to the waitlist. Waiting is free${emailsReal() ? ' — we’ll email you if a seat opens up.' : '.'}`, 'good');
}

function simulatedCheckoutModal({ event, registration }) {
  const amount = money(registration.amountCents, registration.currency || event.currency);
  return `
  <div class="scrim" data-act="close-modal">
    <div class="modal" role="dialog" aria-modal="true" style="max-width:424px" data-stop>
      <div class="modal-head">
        <span class="chip chip-warn">Simulated checkout</span>
        <h3 style="margin-top:13px; font-size:27px">${esc(amount)}</h3>
        <p>${esc(event.title)} · ${registration.guests} ${registration.guests === 1 ? 'ticket' : 'tickets'}</p>
      </div>
      <div class="modal-body">
        <div class="banner banner-info">
          <span>ℹ</span>
          <span>This page runs entirely in your browser, so there's no server here to talk to Stripe.
          No card is collected and no money moves. The bundled server code does real Stripe Checkout —
          same held seat, confirmed by a signed webhook instead of this button.</span>
        </div>
        <button class="btn btn-pri btn-lg" data-act="simulate-pay" data-slug="${esc(event.slug)}">
          Pay ${esc(amount)}
        </button>
        <button class="btn btn-ghost btn-block" data-act="close-modal">Abandon checkout</button>
        <p class="panel-note">Walk away and your seats stay held for ${HOLD_MINUTES} minutes, then go to the next person in line.</p>
      </div>
    </div>
  </div>`;
}

/**
 * Coming back from Stripe. The redirect beats the webhook often enough that
 * showing "confirmed" straight away would sometimes be a lie, so poll briefly.
 */
let checkoutHandled = null;
async function maybeHandleCheckoutReturn() {
  const params = app.route.params;
  if (!params || app.route.name !== 'detail') return;
  const outcome = params.get('checkout');
  if (!outcome || checkoutHandled === location.hash) return;
  checkoutHandled = location.hash;

  if (outcome === 'cancelled') {
    return toast(`Checkout cancelled. Your seats stay held for a few more minutes if you change your mind.`);
  }
  toast('Payment received — confirming your seat…');
  for (let i = 0; i < 8; i++) {
    try {
      const { myRegistration } = await Store.getEvent(app.route.slug);
      if (myRegistration?.status === 'confirmed') {
        await render({ keepScroll: true });
        return toast('You’re confirmed. See you there.', 'good');
      }
      if (myRegistration?.refundDue) {
        await render({ keepScroll: true });
        return toast('The last seat went before your payment landed, so you’ve been refunded.', 'bad');
      }
    } catch { /* keep waiting */ }
    await new Promise((r) => setTimeout(r, 1200));
  }
  await render({ keepScroll: true });
  toast('Payment received. Still waiting on confirmation from Stripe — give it a moment and refresh.');
}

/** Keep the running total honest as the party size changes. */
function updateTotalLine() {
  const line = el('total-line');
  const sel = el('guests');
  if (!line || !sel) return;
  const price = Number(line.dataset.price || 0);
  const currency = line.dataset.currency || 'usd';
  const n = Number(sel.value || 1);
  line.textContent = `Total ${money(price * n, currency)} · ${money(price, currency)} per person`;
  const btn = document.querySelector('[data-act="register"]');
  if (btn && price > 0) btn.textContent = `Register — ${money(price * n, currency)}`;
}

const ACTIONS = {
  /* --- auth ---------------------------------------------------------- */
  signin: () => openModal(signInModal()),
  account: () => openModal(accountModal()),
  'close-modal': () => closeModal(),

  async 'do-signin'(t) {
    const email = t.dataset.email || el('si-email')?.value || '';
    const name = t.dataset.name || el('si-name')?.value || '';
    try {
      app.user = await Store.signIn({ email, name });
      app.modal = null;
      await render();
      toast(`Signed in as ${app.user.name}`, 'good');
    } catch (err) {
      const box = el('si-err');
      if (box) { box.hidden = false; box.textContent = err.message; } else toast(err.message, 'bad');
    }
  },

  async signout() {
    await Store.signOut();
    app.user = null;
    app.modal = null;
    location.hash = '#/';
    await render();
    toast('Signed out');
  },

  async 'expire-holds'() {
    if (!Store.expireAllHolds) return;
    const out = await Store.expireAllHolds();
    app.modal = null;
    await render();
    toast(out.expired
      ? `${out.expired} hold${out.expired === 1 ? '' : 's'} released, ${out.promoted} promoted off waitlists.`
      : 'There were no held seats to expire.', out.expired ? 'good' : '');
  },

  async 'reset-demo'() {
    if (Store.reset) await Store.reset();
    app.user = null;
    app.modal = null;
    location.hash = '#/';
    await render();
    toast('Demo data restored', 'good');
  },

  /* --- browse filters ------------------------------------------------ */
  cat(t) { app.filters.category = t.dataset.cat || ''; render(); },
  when(t) { app.filters.when = t.dataset.when; render(); },
  mode(t) { app.filters.mode = t.dataset.mode || ''; render(); },
  'clear-q'() { app.filters.q = ''; render(); },
  'reset-filters'() { app.filters = { q: '', category: '', mode: '', when: 'upcoming' }; render(); },

  /* --- registration -------------------------------------------------- */
  async register(t) {
    if (app.busy) return;
    app.busy = true;
    t.disabled = true;
    const original = t.textContent;
    t.textContent = 'Registering…';
    try {
      const guests = Number(el('guests')?.value || 1);
      const note = (el('note')?.value || '').trim() || null;
      const out = await Store.register(t.dataset.slug, { guests, note });
      await afterRegistration(out, t.dataset.slug);
    } catch (err) {
      t.disabled = false;
      t.textContent = original;
      toast(err.message, 'bad');
    } finally {
      app.busy = false;
    }
  },

  /** Resume an unfinished payment on a seat that's still held. */
  async pay(t) {
    const slug = t.dataset.slug;
    try {
      const { event, myRegistration } = await Store.getEvent(slug);
      if (!myRegistration || !HOLDING.includes(myRegistration.status)) {
        await render({ keepScroll: true });
        return toast('That hold is no longer active.', 'bad');
      }
      // A live Stripe session can be resumed rather than duplicated.
      if (myRegistration.checkoutUrl) return goToCheckout(myRegistration.checkoutUrl);
      if (Store.payments === 'simulated') {
        return openModal(simulatedCheckoutModal({ event, registration: myRegistration }));
      }
      const out = await Store.register(slug, { guests: myRegistration.guests });
      await afterRegistration(out, slug);
    } catch (err) {
      toast(err.message, 'bad');
    }
  },

  /** Pay for a seat offered after a waitlist promotion. */
  async claim(t) {
    if (app.busy) return;
    app.busy = true;
    t.disabled = true;
    t.textContent = 'Claiming…';
    try {
      const out = await Store.claim(t.dataset.slug);
      await afterRegistration(out, t.dataset.slug);
    } catch (err) {
      toast(err.message, 'bad');
      await render({ keepScroll: true });
    } finally {
      app.busy = false;
    }
  },

  /** The stand-in for a verified Stripe webhook, on-device only. */
  async 'simulate-pay'(t) {
    if (app.busy) return;
    app.busy = true;
    t.disabled = true;
    t.textContent = 'Processing…';
    try {
      const out = await Store.completeSimulatedPayment(t.dataset.slug);
      app.modal = null;
      await render({ keepScroll: true });
      toast(out.status === 'refunded'
        ? 'The last seat went while you were paying, so you were refunded.'
        : 'Paid. Your seat is confirmed.', out.status === 'refunded' ? 'bad' : 'good');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      app.busy = false;
    }
  },

  release(t) {
    if (t.dataset.confirmed) return ACTIONS['do-release'](t);
    openModal(confirmModal({
      title: 'Give up your held seats?',
      body: 'They are released immediately and offered to whoever is first on the waitlist. You can register again if they are still free.',
      confirmLabel: 'Yes, release them',
      act: 'release',
      slug: t.dataset.slug,
    }));
  },

  async 'do-release'(t) {
    try {
      const out = await Store.releaseHold(t.dataset.slug);
      app.modal = null;
      await render({ keepScroll: true });
      toast(out.promoted
        ? `Hold released — ${out.promoted} ${out.promoted === 1 ? 'person was' : 'people were'} offered the seats.`
        : 'Hold released.', 'good');
    } catch (err) {
      toast(err.message, 'bad');
    }
  },

  unregister(t) {
    if (t.dataset.confirmed) return ACTIONS['do-unregister'](t);
    openModal(confirmModal({
      title: 'Cancel your registration?',
      body: 'Your spot is released immediately and offered to whoever is first on the waitlist.',
      confirmLabel: 'Yes, cancel my spot',
      act: 'unregister',
      slug: t.dataset.slug,
    }));
  },

  async 'do-unregister'(t) {
    try {
      const out = await Store.cancelRegistration(t.dataset.slug);
      app.modal = null;
      await render({ keepScroll: true });
      toast(out.promoted
        ? `Registration cancelled — ${out.promoted} ${out.promoted === 1 ? 'person' : 'people'} moved off the waitlist.`
        : 'Registration cancelled.', 'good');
    } catch (err) {
      toast(err.message, 'bad');
    }
  },

  /* --- host ---------------------------------------------------------- */
  'load-guests'(t) { loadGuests(t.dataset.slug); },

  async publish(t) {
    try {
      await Store.updateEvent(t.dataset.slug, { status: 'published' });
      await render({ keepScroll: true });
      toast('Event published — the link is live.', 'good');
    } catch (err) { toast(err.message, 'bad'); }
  },

  'cancel-event'(t) {
    if (t.dataset.confirmed) return ACTIONS['do-cancel-event'](t);
    openModal(confirmModal({
      title: 'Cancel this event?',
      body: `It disappears from browse and nobody can register. People holding tickets keep seeing it, marked cancelled${emailsReal() ? ', and everyone registered gets an email' : ''}. This cannot be undone.`,
      confirmLabel: 'Yes, cancel the event',
      act: 'cancel-event',
      slug: t.dataset.slug,
    }));
  },

  async 'do-cancel-event'(t) {
    try {
      await Store.cancelEvent(t.dataset.slug);
      app.modal = null;
      await render({ keepScroll: true });
      toast('Event cancelled.');
    } catch (err) { toast(err.message, 'bad'); }
  },

  csv(t) {
    const rows = app.cache.guests?.slug === t.dataset.slug ? app.cache.guests.rows : null;
    if (!rows) return toast('Open the guest list first.', 'bad');
    const ok = download(`${t.dataset.slug}-guests.csv`, csvFor(rows), 'text/csv;charset=utf-8');
    toast(ok ? 'Guest list exported.' : 'Your browser blocked the download.', ok ? 'good' : 'bad');
  },

  /* --- form ---------------------------------------------------------- */
  'form-mode'(t) {
    app.cache.form.mode = t.dataset.mode;
    document.querySelectorAll('[data-act="form-mode"]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.mode === t.dataset.mode));
    });
    el('place-inperson').hidden = t.dataset.mode === 'online';
    el('place-online').hidden = t.dataset.mode !== 'online';
  },

  'pick-cover'(t) {
    app.cache.form.coverUrl = t.dataset.cover;
    document.querySelectorAll('[data-act="pick-cover"]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.cover === t.dataset.cover));
    });
  },

  async 'save-event'(t) {
    if (app.busy) return;
    app.busy = true;
    t.disabled = true;
    const label = t.textContent;
    t.textContent = 'Saving…';
    try {
      const data = readEventForm(t.dataset.status);
      const slug = app.cache.form.slug;
      const saved = slug ? await Store.updateEvent(slug, data) : await Store.createEvent(data);
      location.hash = `#/e/${saved.slug}`;
      await render();
      toast(slug ? 'Changes saved.'
        : data.status === 'draft' ? 'Draft saved — publish it when you’re ready.' : 'Event published.', 'good');
    } catch (err) {
      t.disabled = false;
      t.textContent = label;
      showFormError(err.message);
    } finally {
      app.busy = false;
    }
  },

  /* --- sharing ------------------------------------------------------- */
  async 'copy-link'(t) {
    const url = `${location.origin}${location.pathname}#/e/${t.dataset.slug}`;
    const ok = await copyText(url);
    toast(ok ? 'Link copied to your clipboard.' : url, ok ? 'good' : '');
  },

  async ics(t) {
    let ev = app.cache.event;
    if (!ev || ev.slug !== t.dataset.slug) ev = (await Store.getEvent(t.dataset.slug)).event;
    const ok = download(`${ev.slug}.ics`, icsFor(ev), 'text/calendar;charset=utf-8');
    toast(ok ? 'Calendar file downloaded.' : 'Your browser blocked the download.', ok ? 'good' : 'bad');
  },
};

/* ============================================================== plumbing */

document.addEventListener('click', (e) => {
  const scrim = e.target.closest('.scrim');
  const stop = e.target.closest('[data-stop]');
  const trigger = e.target.closest('[data-act]');

  // Clicking the backdrop (but not the dialog) closes the modal.
  if (scrim && !stop && (!trigger || trigger === scrim)) {
    e.preventDefault();
    return closeModal();
  }
  if (!trigger) return;
  const act = trigger.dataset.act;
  const fn = ACTIONS[act];
  if (!fn) return;
  if (trigger.tagName === 'BUTTON' || trigger.hasAttribute('data-confirmed')) e.preventDefault();
  fn(trigger);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && app.modal) closeModal();
  if (e.key === 'Enter' && app.modal && el('si-email') && document.activeElement?.closest('.modal')) {
    const btn = document.querySelector('[data-act="do-signin"]');
    if (btn) { e.preventDefault(); ACTIONS['do-signin'](btn); }
  }
});

// Debounced search so every keystroke doesn't re-render the grid.
let searchTimer;
document.addEventListener('input', (e) => {
  if (e.target.id === 'guests') return updateTotalLine();
  if (e.target.id !== 'q') return;
  clearTimeout(searchTimer);
  const value = e.target.value;
  searchTimer = setTimeout(() => {
    app.filters.q = value;
    render({ keepScroll: true });
  }, 220);
});

window.addEventListener('hashchange', () => {
  app.modal = null;
  window.scrollTo(0, 0);
  render();
});

(async function boot() {
  try { app.user = await Store.me(); } catch { app.user = null; }
  // Ask the server whether it can actually take money, so the UI never
  // advertises paid tickets it couldn't collect.
  try {
    const meta = await Store.meta();
    if (meta?.payments) {
      app.payments = meta.payments.simulated ? 'simulated' : meta.payments.enabled ? 'live' : 'off';
    }
    if (meta?.email) app.email = meta.email;
  } catch { /* keep the store's default */ }
  await render();
})();

})();
