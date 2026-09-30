/**
 * seed-data.mjs — the single source of truth for Gather's demo content.
 *
 * Both consumers read from here, so the API database and the standalone
 * front end can never drift apart:
 *   • server/seed.mjs  — inserts it into SQLite
 *   • build.mjs        — inlines it into public/index.html
 *
 * Dates are stored as day offsets rather than absolute timestamps, so the
 * seeded events are always in the near future no matter when this runs.
 */

/* ------------------------------------------------------- timezone helpers */

/** Offset (ms) that timezone `tz` was at the given UTC instant. */
function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) p[type] = value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - utcMs;
}

/**
 * "18:30 on day X in America/Chicago" -> real UTC instant.
 * Two passes so DST boundaries land correctly.
 */
export function zonedToUtc({ dayOffset, time, tz, from = Date.now() }) {
  const [hh, mm] = time.split(':').map(Number);
  const base = new Date(from + dayOffset * 864e5);
  const y = base.getFullYear(), mo = base.getMonth(), d = base.getDate();
  let utc = Date.UTC(y, mo, d, hh, mm);
  for (let i = 0; i < 2; i++) utc = Date.UTC(y, mo, d, hh, mm) - tzOffsetMs(utc, tz);
  return new Date(utc).toISOString();
}

const addHours = (iso, h) => new Date(new Date(iso).getTime() + h * 3600e3).toISOString();

/* ------------------------------------------------------------------ covers */

export const COVERS = {
  jazz: 'https://pub.hyperagent.com/api/published/pbf01M24QE6AW_TVRB4K6M3MKEATH7/jazz.jpg',
  devworkshop: 'https://pub.hyperagent.com/api/published/pbf01M24QE6MR_YQ9B9566AMK280ZC/devworkshop.jpg',
  trailrun: 'https://pub.hyperagent.com/api/published/pbf01M24QE6XW_TMJS83TXF0VFCY6Y/trailrun.jpg',
  ceramics: 'https://pub.hyperagent.com/api/published/pbf01M24QE76X_SFJNTF65WG2XAJC7/ceramics.jpg',
  dinner: 'https://pub.hyperagent.com/api/published/pbf01M24QE7JV_P567Q3QHCA210CJ6/dinner.jpg',
  meetup: 'https://pub.hyperagent.com/api/published/pbf01M24QE7WE_QFHG7J2HJ8G6RRX5/meetup.jpg',
  cooking: 'https://pub.hyperagent.com/api/published/pbf01M24QE84N_NS4JE4AB4GXJR6Z0/cooking.jpg',
  openmic: 'https://pub.hyperagent.com/api/published/pbf01M24QE8FD_T476ZW2CP239FMEA/openmic.jpg',
};

/* ------------------------------------------------------------------- users */

// Every seeded address uses a domain reserved by RFC 2606 (example.com/.org/
// .net, or the .example TLD), which is guaranteed never to deliver. That
// matters because the platform really does send email: a host cancelling a
// seeded event fans out to every seeded guest, and with a provider key
// configured, a realistic-looking gmail.com address would reach whoever
// actually owns it. `npm test` fails if a non-reserved domain creeps back in.

// The six hosts. These double as the demo sign-in accounts.
const HOSTS = [
  { key: 'maya', email: 'maya@rooftopsessions.example', name: 'Maya Okonkwo' },
  { key: 'devon', email: 'devon@rustbelt.example', name: 'Devon Reyes' },
  { key: 'sam', email: 'sam@trailhead.example', name: 'Sam Whitfield' },
  { key: 'lena', email: 'lena@kilnandco.example', name: 'Lena Brandt' },
  { key: 'tobias', email: 'tobias@seedtable.example', name: 'Tobias Grant' },
  { key: 'priya', email: 'priya@formfunction.example', name: 'Priya Raman' },
];

// A crowd. Large events need enough distinct people to fill a capacity meter
// to a believable level — six attendees against a 120-seat room looks broken.
const CROWD = [
  ['Noah Feldman', 'noah.feldman@example.com'], ['Amara Diallo', 'amara@example.org'],
  ['Jesse Lin', 'jesse.lin@example.net'], ['Yuki Tanaka', 'yuki.tanaka@example.com'],
  ['Ines Kovac', 'ines.kovac@example.org'], ['Marcus Bell', 'marcus.bell@example.net'],
  ['Sofia Ruiz', 'sofia@ruizstudio.example'], ['Theo Lambert', 'theo.lambert@example.com'],
  ['Nadia Hassan', 'nadia.hassan@example.org'], ['Owen Pritchard', 'owen.p@example.net'],
  ['Clara Mensah', 'clara.mensah@example.com'], ['Dev Patel', 'dev.patel@example.org'],
  ['Ruth Ostrowski', 'ruth.o@example.net'], ['Kai Nakamura', 'kai@nakamura.example'],
  ['Bea Fontaine', 'bea.fontaine@example.com'], ['Ellis Warner', 'ellis.warner@example.org'],
  ['Priyanka Shah', 'priyanka.shah@example.net'], ['Tomas Rivera', 'tomas.rivera@example.com'],
  ['Greta Lindqvist', 'greta.l@example.org'], ['Isaac Mbeki', 'isaac.mbeki@example.net'],
  ['Fern Whitaker', 'fern@whitakerco.example'], ['Anton Dvorak', 'anton.dvorak@example.com'],
  ['Leila Farsi', 'leila.farsi@example.org'], ['Cormac Doyle', 'cormac.doyle@example.net'],
  ['Simone Okafor', 'simone.okafor@example.com'], ['Rafael Costa', 'rafael@costa.example'],
  ['Hana Brennan', 'hana.brennan@example.org'], ['Viktor Sokolov', 'viktor.s@example.net'],
  ['Junie Park', 'junie.park@example.com'], ['Emeka Nwosu', 'emeka.nwosu@example.org'],
  ['Astrid Vang', 'astrid.vang@example.net'], ['Malik Rahim', 'malik.rahim@example.com'],
  ['Rosa Delgado', 'rosa.delgado@example.org'], ['Bram de Vries', 'bram.devries@example.net'],
  ['Tessa Nolan', 'tessa.nolan@example.com'], ['Idris Bello', 'idris.bello@example.org'],
];

/** Exported so the test suite can assert no seeded address can deliver. */
export const SEED_USERS_FOR_AUDIT = () => [
  ...HOSTS.map((h) => h.email),
  ...CROWD.map(([, email]) => email),
];

const USERS = [
  ...HOSTS,
  ...CROWD.map(([name, email], i) => ({ key: `g${i + 1}`, email, name })),
];

/* ------------------------------------------------------------------ events */

const EVENTS = [
  {
    key: 'jazz',
    hostKey: 'maya',
    title: 'Rooftop Sessions: Jazz & Small Plates',
    summary: 'A live trio, skyline views, and a rotating small-plates menu from the kitchen downstairs.',
    description: `Every few weeks we clear the roof, string the lights, and bring up a piano.

This round it's the Ellis Park Trio — upright bass, tenor sax, and a drummer who plays brushes like he's apologising for the noise. Two sets with a break in between, so there's time to actually talk to the people around you.

The kitchen sends up small plates all evening: charred shishitos, whipped ricotta with honey, and something involving short rib that changes depending on the mood. Drinks are cash or card at the bar.

Doors at 7:30, first set at 8. It gets cool up there after dark — bring a layer.`,
    category: 'Music',
    cover: 'jazz',
    dayOffset: 5,
    time: '19:30',
    hours: 3,
    tz: 'America/New_York',
    mode: 'in_person',
    venueName: 'The Wythe Roof',
    address: '80 Wythe Ave',
    city: 'Brooklyn, NY',
    capacity: 60,
    priceCents: 3500,
    fill: 0.72,
    // Somebody is mid-checkout right now: two seats held, not yet paid.
    pendingHolds: [{ guests: 2, minutesLeft: 22 }],
  },
  {
    key: 'rust',
    hostKey: 'devon',
    title: 'Rust for JavaScript Developers',
    summary: 'A three-hour, hands-on workshop for people who already ship JS and keep hearing about Rust.',
    description: `You know JavaScript. You've read the Rust book twice and bounced off the borrow checker both times. This is for you.

We skip the history lesson and go straight at the parts that actually feel different: ownership, borrowing, \`Result\` instead of \`try/catch\`, and why the compiler is being difficult on purpose. Then we build a small CLI tool together and compile it to WebAssembly so you can call it from the JS you already have.

Bring a laptop with Rust installed — run \`rustup\` beforehand, we won't spend the session on setup. Recording goes out to everyone registered within 48 hours.

No cost. The only ask is that you show up, because someone else wanted the seat.`,
    category: 'Tech',
    cover: 'devworkshop',
    dayOffset: 9,
    time: '13:00',
    hours: 3,
    tz: 'America/Los_Angeles',
    mode: 'online',
    onlineUrl: 'https://meet.gather.example/rust-for-js',
    capacity: 200,
    priceCents: 0,
    fill: 0.34,
  },
  {
    key: 'trail',
    hostKey: 'sam',
    title: 'Sunrise Trail Run + Coffee',
    summary: 'Five miles on the greenbelt before work, then coffee. All paces, nobody gets dropped.',
    description: `We meet at the trailhead at 6:30 while it's still grey, run about five miles, and are back at the cars by 8.

Two groups: one around 8:30/mile, one closer to 11:00/mile with walk breaks. Both loop back to the same spot, so nobody finishes alone and nobody waits long. The route has one real climb at mile three and then it's downhill and smug the rest of the way.

Afterwards we walk over to Bento's for coffee, which is genuinely the point for about half the group.

Bring water. Headlamp if you're nervous about the first mile — the light comes up fast but it's dim at the start.`,
    category: 'Fitness',
    cover: 'trailrun',
    dayOffset: 2,
    time: '06:30',
    hours: 1.5,
    tz: 'America/Chicago',
    mode: 'in_person',
    venueName: 'Barton Creek Trailhead',
    address: '2201 Barton Springs Rd',
    city: 'Austin, TX',
    capacity: 40,
    priceCents: 0,
    fill: 0.55,
  },
  {
    key: 'ceramics',
    hostKey: 'lena',
    title: 'Hand-Building Ceramics: Beginner Night',
    summary: 'Three hours, no wheel, no experience. You leave with two pieces and clay under your nails.',
    description: `Everyone thinks pottery means the wheel. The wheel is hard. Hand-building is not, and you can make genuinely good things with your hands and a few cheap tools on your first night.

We cover pinch pots, coil building, and slab work. You'll make a small bowl and a cup — or one ambitious thing, if you'd rather. I'll come round and stop you before you make the mistake that cracks it in the kiln.

Pieces get bisque-fired and glazed over the following two weeks. You come back and pick them up, or I'll post them anywhere in the lower 48 for the cost of shipping.

Everything is included: clay, tools, apron, firing. Wear something you don't mind ruining, and take your rings off before you start.`,
    category: 'Arts',
    cover: 'ceramics',
    dayOffset: 6,
    time: '18:00',
    hours: 2.5,
    tz: 'America/Los_Angeles',
    mode: 'in_person',
    venueName: 'Kiln & Co. Studio',
    address: '1420 SE Stark St',
    city: 'Portland, OR',
    capacity: 12,
    priceCents: 5500,
    fill: 1,        // deliberately sold out — this is the waitlist demo
    waitlist: 3,
  },
  {
    key: 'dinner',
    hostKey: 'tobias',
    title: 'Seed-Stage Founders Dinner',
    summary: 'Twenty founders, one long table, no pitch decks. Dinner is on us.',
    description: `A dinner, not an event. No stage, no panel, no sponsor thanking you for your time.

Twenty people who are all somewhere between "just incorporated" and "just raised a seed round", at one table, for three hours. Past tables have ended up mostly talking about hiring the first non-founder engineer, what to do when a co-founder wants out, and pricing — which nobody ever feels good about.

Family style, wine included, dietary restrictions handled if you tell us in the note field when you register.

One rule: no fundraising conversations. There are twelve other dinners in this city for that. If you're an investor, this isn't the one — genuinely, please come to the next one instead.`,
    category: 'Business',
    cover: 'dinner',
    dayOffset: 12,
    time: '19:00',
    hours: 3,
    tz: 'America/Los_Angeles',
    mode: 'in_person',
    venueName: 'Verjus',
    address: '528 Washington St',
    city: 'San Francisco, CA',
    capacity: 20,
    priceCents: 0,
    fill: 0.85,
  },
  {
    key: 'design',
    hostKey: 'priya',
    title: 'AI Product Design Meetup',
    summary: 'Three short talks on designing for models that are wrong sometimes, then drinks.',
    description: `The interesting design problem right now isn't making AI features look good. It's what the interface does when the model is confidently wrong.

Three speakers, fifteen minutes each, no slides longer than they need to be:

Designing for uncertainty — how to show confidence without lying about it. Undo as a first-class feature, from someone who rebuilt their product around it. And a genuinely unflattering teardown of three shipped AI onboarding flows, including her own.

Then an hour of drinks, because the hallway conversation is why people actually come.

Space is real but generous. If you register and can't make it, please cancel so the seat frees up.`,
    category: 'Tech',
    cover: 'meetup',
    dayOffset: 16,
    time: '18:30',
    hours: 2.5,
    tz: 'America/New_York',
    mode: 'in_person',
    venueName: 'Prime Produce Loft',
    address: '424 W 54th St',
    city: 'New York, NY',
    capacity: 120,
    priceCents: 0,
    fill: 0.44,
  },
  {
    key: 'cooking',
    hostKey: 'lena',
    title: 'Market-to-Table Cooking Class',
    summary: 'We shop the morning market together, then cook whatever looked best. Menu decided on site.',
    description: `There's no set menu, because we don't know what's good yet.

We meet at the market entrance at 11, walk it together, and I'll talk through how to actually pick things — which greens are tired, why the ugly tomatoes are the right ones, when to trust a fish counter. We buy for eight people. Then we walk two blocks to the kitchen and cook it.

You'll leave knowing three techniques that work on almost anything: a fast pan sauce, a vinaigrette that doesn't break, and how to roast vegetables so they're actually browned instead of steamed and sad.

We eat what we make, together, around 2. Wine included. Knife skills not required — sharp knives provided, and I'd rather teach you than watch you fight a dull one.`,
    category: 'Food & Drink',
    cover: 'cooking',
    dayOffset: 20,
    time: '11:00',
    hours: 3,
    tz: 'America/Chicago',
    mode: 'in_person',
    venueName: 'Green City Market',
    address: '1817 N Clark St',
    city: 'Chicago, IL',
    capacity: 16,
    priceCents: 7500,
    fill: 0.62,
    pendingHolds: [{ guests: 2, minutesLeft: 11 }],
  },
  {
    key: 'openmic',
    hostKey: 'maya',
    title: 'Tuesday Open Mic',
    summary: 'Sign-up at the door from 7:30. Eight minutes or two songs, whichever comes first.',
    description: `Longest-running open mic in the neighbourhood and still the least precious one.

Sign-up sheet goes on the bar at 7:30, first performer at 8. Eight minutes or two songs. House provides a decent PA, two mics, a DI for anything with a jack, and a piano that is in tune more often than not.

All of it welcome: songwriters, comics working out new material, poets, one guy who does a monologue from a play nobody has heard of. It's a warm room — people actually listen, which is rarer than it should be.

No capacity limit, no ticket. Just show up. Tip the bar staff.`,
    category: 'Music',
    cover: 'openmic',
    dayOffset: 8,
    time: '20:00',
    hours: 3,
    tz: 'America/Chicago',
    mode: 'in_person',
    venueName: 'The Basement East',
    address: '917 Woodland St',
    city: 'Nashville, TN',
    capacity: null,          // no cap — exercises the unlimited-capacity path
    priceCents: 0,
    seatTarget: 14,
  },
  {
    key: 'studiosale',
    hostKey: 'lena',
    title: 'Spring Studio Sale & Seconds',
    summary: 'Everything that came out of the kiln slightly wrong, priced accordingly.',
    description: `Once a season I clear the shelves. Wobbly rims, glaze that crawled, colours that came out nothing like the test tile — all of it perfectly usable and heavily discounted.

Firsts are there too at normal prices, but the seconds table is the reason to come early.

Cash and card both fine. Bring a tote.`,
    category: 'Arts',
    cover: 'ceramics',
    dayOffset: -13,          // past event — exercises the archive view
    time: '10:00',
    hours: 6,
    tz: 'America/Los_Angeles',
    mode: 'in_person',
    venueName: 'Kiln & Co. Studio',
    address: '1420 SE Stark St',
    city: 'Portland, OR',
    capacity: 80,
    priceCents: 0,
    fill: 0.65,
  },
];

/* ---------------------------------------------------------- registrations */

// Deterministic so the demo looks identical on every rebuild. Hosts are in the
// rotation too — people who run events also attend other people's.
const ROTATION = USERS.map((u) => u.key);
const PARTY_SIZES = [1, 2, 1, 1, 2, 1, 3, 1, 2, 1, 1, 2, 1, 4, 1, 2, 1, 1, 3, 2];

function registrationsFor(ev, idx) {
  const out = [];
  const cap = ev.capacity;
  const target = cap === null
    ? (ev.seatTarget ?? 0)
    : Math.round(cap * (ev.fill ?? 0));

  // Hosts never appear on their own guest list.
  const pool = ROTATION.filter((k) => k !== ev.hostKey);
  const shift = idx % pool.length;
  const ordered = pool.slice(shift).concat(pool.slice(0, shift));

  let seats = 0;
  let cursor = 0;
  for (; cursor < ordered.length && seats < target; cursor++) {
    let guests = PARTY_SIZES[(cursor + idx) % PARTY_SIZES.length];
    if (cap !== null) guests = Math.min(guests, cap - seats);
    if (guests < 1) break;
    out.push({
      userKey: ordered[cursor],
      guests,
      status: 'confirmed',
      daysAgo: Math.max(1, 14 - cursor * 2),
    });
    seats += guests;
  }
  for (let w = 0; w < (ev.waitlist ?? 0) && cursor < ordered.length; w++, cursor++) {
    out.push({
      userKey: ordered[cursor],
      guests: 1,
      status: 'waitlisted',
      daysAgo: Math.max(1, 4 - w),
    });
  }
  // Seats held by an in-progress payment. These occupy capacity but are not
  // confirmed, which is exactly the state the checkout window creates.
  for (const hold of ev.pendingHolds ?? []) {
    if (cursor >= ordered.length) break;
    out.push({
      userKey: ordered[cursor++],
      guests: hold.guests,
      status: 'pending',
      daysAgo: 0,
      minutesAgo: Math.max(1, HOLD_MINUTES_SEED - (hold.minutesLeft ?? 20)),
      holdMinutesLeft: hold.minutesLeft ?? 20,
    });
  }
  return out;
}

// Mirrors HOLD_MINUTES in db.mjs; only used to date the seeded holds.
const HOLD_MINUTES_SEED = 30;

/* ------------------------------------------------------------------ build */

/**
 * Materialise the seed. Returns plain objects with real ISO timestamps,
 * computed relative to `from` (defaults to now).
 */
export function buildSeed({ from = Date.now() } = {}) {
  const events = EVENTS.map((ev, idx) => {
    const startsAt = zonedToUtc({ dayOffset: ev.dayOffset, time: ev.time, tz: ev.tz, from });
    return {
      key: ev.key,
      hostKey: ev.hostKey,
      title: ev.title,
      summary: ev.summary,
      description: ev.description,
      category: ev.category,
      coverUrl: COVERS[ev.cover],
      startsAt,
      endsAt: addHours(startsAt, ev.hours),
      timezone: ev.tz,
      mode: ev.mode,
      venueName: ev.venueName ?? null,
      address: ev.address ?? null,
      city: ev.city ?? null,
      onlineUrl: ev.onlineUrl ?? null,
      capacity: ev.capacity ?? null,
      priceCents: ev.priceCents ?? 0,
      currency: ev.currency ?? 'usd',
      status: 'published',
      registrations: registrationsFor(ev, idx).map((r, n) => {
        const paidEvent = (ev.priceCents ?? 0) > 0;
        const createdAt = new Date(
          from - (r.daysAgo ?? 0) * 864e5 - (r.minutesAgo ?? 0) * 60_000,
        ).toISOString();
        // Only seats that are held or taken carry money. A waitlist place is
        // never charged, so it has no amount and no session.
        const owesMoney = paidEvent && ['confirmed', 'pending', 'offered'].includes(r.status);
        return {
          ...r,
          createdAt,
          amountCents: owesMoney ? (ev.priceCents ?? 0) * r.guests : 0,
          currency: owesMoney ? (ev.currency ?? 'usd') : null,
          paidAt: paidEvent && r.status === 'confirmed' ? createdAt : null,
          holdExpiresAt: r.status === 'pending' || r.status === 'offered'
            ? new Date(from + (r.holdMinutesLeft ?? 20) * 60_000).toISOString()
            : null,
          // Plausible-looking test-mode ids so the host view has something to
          // show. Nothing ever calls Stripe with these.
          stripeSessionId: owesMoney ? `cs_test_seed_${ev.key}_${n}` : null,
          stripePaymentIntent: paidEvent && r.status === 'confirmed' ? `pi_test_seed_${ev.key}_${n}` : null,
        };
      }),
    };
  });
  return { users: USERS, events };
}

export const SEED_META = {
  demoAccounts: HOSTS.map((u) => ({ email: u.email, name: u.name })),
};

/* --------------------------------------------------------------- rebasing */

/**
 * Shift a materialised seed so its dates are relative to `now` rather than to
 * the moment it was built.
 *
 * Why this exists: build.mjs bakes the seed into the standalone page as
 * absolute timestamps. Without rebasing, a page built on the 10th shows "in 5
 * days" events that already happened by the 29th — the live demo decayed to
 * one upcoming event in three weeks. The server never needs this, because
 * `npm run seed` materialises fresh dates every time it runs.
 *
 *   • Events move by whole calendar days and keep their local wall-clock time
 *     in their own timezone, so a 7:30 PM show stays 7:30 PM across a
 *     daylight-saving change instead of drifting to 6:30.
 *   • Registration timestamps (created, paid, hold expiry) move by the exact
 *     elapsed time, so "held for 22 more minutes" still means 22 minutes.
 *
 * MUST STAY SELF-CONTAINED. build.mjs inlines this function into the page by
 * its source text (Function.prototype.toString), so it cannot reference
 * anything outside its own body. The build verifies this and fails loudly if
 * it ever stops being true.
 */
export function rebaseSeed(seed, now) {
  if (!seed || typeof seed.builtAt !== 'number' || !Array.isArray(seed.events)) return seed;
  const at = typeof now === 'number' ? now : Date.now();
  const DAY = 86400000;
  const shiftMs = at - seed.builtAt;
  if (Math.abs(shiftMs) < 60000) return seed; // freshly built: nothing to move

  // Calendar days between build and now in the viewer's local time, so the
  // "In 5 days" labels read the same as on the day the page was built.
  const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dayShift = Math.round((startOfDay(at) - startOfDay(seed.builtAt)) / DAY);

  const wallClock = (utcMs, tz) => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = {};
    for (const { type, value } of fmt.formatToParts(new Date(utcMs))) p[type] = value;
    return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, ss: +p.second };
  };
  const offsetMs = (utcMs, tz) => {
    const whole = Math.floor(utcMs / 1000) * 1000;
    const w = wallClock(whole, tz);
    return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss) - whole;
  };
  // Wall-clock time in `tz` -> UTC instant. Two passes settle DST edges.
  const zonedToUtc = (y, m, d, hh, mm, tz) => {
    let utc = Date.UTC(y, m - 1, d, hh, mm);
    for (let i = 0; i < 2; i++) utc = Date.UTC(y, m - 1, d, hh, mm) - offsetMs(utc, tz);
    return utc;
  };

  const moveEventTime = (iso, tz) => {
    if (!iso) return iso;
    const t = new Date(iso).getTime();
    try {
      const w = wallClock(t, tz);
      // Day arithmetic in UTC space handles month and year rollover for free.
      const day = new Date(Date.UTC(w.y, w.m - 1, w.d + dayShift));
      return new Date(zonedToUtc(
        day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), w.hh, w.mm, tz,
      )).toISOString();
    } catch {
      return new Date(t + dayShift * DAY).toISOString(); // unknown timezone: plain shift
    }
  };
  const moveInstant = (iso) => (iso ? new Date(new Date(iso).getTime() + shiftMs).toISOString() : iso);

  return {
    ...seed,
    builtAt: at,
    events: seed.events.map((ev) => {
      const startsAt = moveEventTime(ev.startsAt, ev.timezone);
      // Keep the duration exact rather than re-deriving the end's wall time.
      const endsAt = ev.endsAt
        ? new Date(new Date(startsAt).getTime() + (new Date(ev.endsAt) - new Date(ev.startsAt))).toISOString()
        : ev.endsAt;
      return {
        ...ev,
        startsAt,
        endsAt,
        registrations: (ev.registrations || []).map((r) => ({
          ...r,
          createdAt: moveInstant(r.createdAt),
          paidAt: moveInstant(r.paidAt),
          holdExpiresAt: moveInstant(r.holdExpiresAt),
        })),
      };
    }),
  };
}
