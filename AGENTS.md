# AGENTS.md

The operating manual for AI coding agents working on Gather, and for any engineer who wants the depth behind the [README](README.md).

**Before you change anything:** read §1 Ground rules, then [STATUS.md](STATUS.md) for what's in flight and what's known to be broken.
**Before you finish:** work through §12 Definition of done.

## Contents

1. [Ground rules](#1-ground-rules)
2. [Running locally](#2-running-locally)
3. [Repository map](#3-repository-map)
4. [Architecture](#4-architecture)
5. [The registration state machine](#5-the-registration-state-machine)
6. [Data model](#6-data-model)
7. [Design decisions](#7-design-decisions)
8. [API reference](#8-api-reference)
9. [Testing](#9-testing)
10. [Conventions and gotchas](#10-conventions-and-gotchas)
11. [Recipes](#11-recipes)
12. [Definition of done](#12-definition-of-done)

---

## 1. Ground rules

These are load-bearing. Only break one with the owner's explicit agreement, recorded in STATUS.md.

1. **Zero dependencies, runtime or dev.** Everything is built on Node's standard library: `node:http`, `node:sqlite`, `node:crypto`, `node:vm` and global `fetch`. Don't add npm packages. If you think one is justified, raise it under *Decisions needed* in STATUS.md.
2. **All SQL lives in `server/db.mjs`.** Nothing else knows the database exists. Everything above it passes plain objects. This boundary is what makes a Postgres move a one-file job.
3. **Capacity is only decided inside a `BEGIN IMMEDIATE` transaction.** Never read seat counts in one statement and write in another outside a transaction. Use `tx()`.
4. **Business rules exist twice.** They live in `server/db.mjs` (the API) and in `LocalStore` inside `public/app.js` (the on-device demo). Change one, change the other. Removing this duplication is [ROADMAP FE-1](ROADMAP.md#fe-1).
5. **Email is enqueued, never sent inline.** Call `enqueueEmail()` inside the same transaction as the state change it describes, with a dedupe key. The worker sends it.
6. **`public/index.html` is generated and committed.** After touching `public/app.js`, `public/index.template.html` or `server/seed-data.mjs`, run `npm run build`. `npm test` fails if you forget.
7. **Seed data must never be able to reach a real inbox.** Use reserved domains only: `example.com`, `example.org`, `example.net`, or `*.example`. A test enforces this.
8. **No secrets in the repo.** Configuration is environment variables only. `.env` is gitignored, and `.env.example` documents everything.
9. **`npm test` passes before you push.** It takes about 2 seconds, so there's no excuse.
10. **STATUS.md stays current.** It's how the next agent learns what you did.

---

## 2. Running locally

**Requirements:** Node.js **22.13 or newer**, because `node:sqlite` needed `--experimental-sqlite` before 22.13. The project is developed and tested on Node 24. There is no install step.

### Modes

| Mode | How | Needs |
|---|---|---|
| **Standalone demo** | Open `public/index.html` in a browser | Nothing |
| **Full stack** | `npm run seed && npm start` | Nothing. Free events only, and emails print to the console |
| **Plus Stripe test mode** | Set `STRIPE_*` and run `stripe listen` | A Stripe account and the Stripe CLI |
| **Plus real email** | Set `EMAIL_API_KEY` and `EMAIL_FROM` | A Resend or Postmark account with a verified sender |

### Full stack

```bash
cp .env.example .env   # optional; every value is optional
npm run seed           # creates ./gather.db (a no-op if it's already seeded)
npm start              # http://localhost:8787
```

`npm start` and `npm run seed` load `.env` through Node's `--env-file-if-exists`, so there's no dotenv dependency. Real environment variables win over the file. To start over, run `npm run reseed`, or delete `gather.db*`.

Sign in with any email and display name. The seeded hosts already own events, so signing in as one lands you in the host tools:

| Host | Events |
|---|---|
| `maya@rooftopsessions.example` | Rooftop Sessions: Jazz ($35, one checkout in progress) and Tuesday Open Mic (no capacity limit) |
| `lena@kilnandco.example` | Ceramics Beginner Night ($55, **sold out, 3 on the waitlist**), Market-to-Table Cooking Class ($75) and a past studio sale |
| `devon@rustbelt.example` | Rust for JavaScript Developers (free, online) |
| `sam@trailhead.example` | Sunrise Trail Run (free) |
| `tobias@seedtable.example` | Seed-Stage Founders Dinner (free, nearly full) |
| `priya@formfunction.example` | AI Product Design Meetup (free) |

With no Stripe key, seeded paid events show a banner saying the server can't take payments. Free events work normally.

### Stripe test mode

```bash
# in .env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...   # printed by the next command

stripe listen --forward-to localhost:8787/api/stripe/webhook
npm start
```

Pay with `4242 4242 4242 4242`. These are the cases most worth exercising:

- `4000 0000 0000 0341`: the card attaches, then the payment fails.
- Closing the Checkout tab and letting the 30-minute hold lapse.
- `stripe trigger checkout.session.expired`.
- Cancelling a confirmed paid seat on a sold-out event: the first waitlister should get an *offer*, not a confirmation.

Card details never touch this server, because Stripe hosts the payment page.

### Real email

```bash
# in .env
EMAIL_API_KEY=re_...                          # Resend, the default when a key is set
EMAIL_FROM="Gather <hello@yourdomain.com>"    # must be a sender your provider verified
# EMAIL_PROVIDER=postmark                     # to use Postmark instead
```

With no key, every email prints to the server console. The intent is still recorded in the outbox either way.

### Scripts

| Command | Does |
|---|---|
| `npm start` | Serves the API and the UI on `PORT`, with the UI wired to the API (§4) |
| `npm run seed` / `npm run reseed` | Load the sample data; `reseed` wipes it first |
| `npm test` | The full end-to-end suite (§9) |
| `npm run build` | Regenerate `public/index.html` from its sources |
| `npm run preview:email` | Render all seven email templates to `public/email-preview.html` (gitignored) |

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | |
| `GATHER_DB` | `gather.db` | SQLite file path |
| `GATHER_PUBLIC_URL` | Inferred from request headers | Where browsers reach the app. Stripe redirect URLs and the links inside emails use it, so set it behind a proxy or tunnel |
| `GATHER_MAILER_INTERVAL_MS` | `15000` | How often the outbox worker runs |
| `STRIPE_SECRET_KEY` | — | Enables paid events. Without it, creating one returns `503` |
| `STRIPE_WEBHOOK_SECRET` | — | Enables the webhook. Without it, payments start but never confirm |
| `STRIPE_API_BASE` | `https://api.stripe.com` | Tests point this at the stub |
| `EMAIL_PROVIDER` | `resend` if a key is set, otherwise `console` | `resend`, `postmark`, `console` or `capture` |
| `EMAIL_API_KEY` | — | Provider credential |
| `EMAIL_FROM` | `Gather <no-reply@gather.example>` | Sender address |
| `EMAIL_REPLY_TO` | — | Optional |
| `EMAIL_STREAM` | `outbound` | Postmark message stream |
| `EMAIL_API_BASE` | Provider default | Tests point this at the stub |

In the front end, `window.GATHER_API_BASE` selects the store (§4). You rarely set it by hand, because the server sets it when it serves the page.

---

## 3. Repository map

```
.
├── README.md                  overview for everyone
├── AGENTS.md                  this file
├── STATUS.md                  task board, known issues, verification log
├── ROADMAP.md                 prioritised enhancements and ideas
├── CLAUDE.md                  points agents that only read CLAUDE.md here
├── .env.example               every setting, documented
├── package.json               scripts only; no dependencies
├── build.mjs                  template + app.js + seed + rebaseSeed → public/index.html
├── preview-emails.mjs         renders every template to public/email-preview.html
├── public/
│   ├── index.template.html    markup and all CSS
│   ├── app.js                 the whole front end (~2,300 lines, see below)
│   └── index.html             GENERATED and committed; never edit by hand
└── server/
    ├── server.mjs             HTTP routing, auth, CORS, webhooks, admin, static files
    ├── db.mjs                 storage driver and state machine: the only SQL
    ├── stripe.mjs             Stripe client: sessions, refunds, signature checks
    ├── email.mjs              transports: resend, postmark, console, capture
    ├── templates.mjs          the seven emails, HTML and plain text
    ├── mailer.mjs             outbox worker: retries, backoff, dead letters
    ├── ics.mjs                calendar invites, shared by the API and the emails
    ├── seed-data.mjs          sample content (single source of truth) + rebaseSeed
    ├── seed.mjs               loads the seed into SQLite
    ├── stripe-stub.mjs        a fake Stripe that records every request
    ├── email-stub.mjs         a fake email provider that can be told to fail
    └── test.mjs               the end-to-end suite
```

`public/app.js` is one IIFE, in this order: small utilities → shared domain helpers → `LocalStore` → `RemoteStore` → app state → components → views → modals → router → actions → plumbing → `boot()`. Section banners mark each part.

---

## 4. Architecture

```
                         ┌──────────────────────── browser ─────────────────────────┐
                         │  public/index.html  (one file: CSS + seed + app.js)      │
                         │                                                          │
                         │   views ──► Store interface ──┬──► LocalStore            │
                         │                               │    (localStorage, or     │
                         │                               │     memory in a sandbox) │
                         │                               └──► RemoteStore ──┐       │
                         └──────────────────────────────────────────────────┼───────┘
                                                                            │ fetch /api/*
┌───────────────────────────────────────── server (Node) ───────────────────┼───────────┐
│  server.mjs ── routes, auth, CORS, static, webhook ◄──────────────────────┘           │
│      │                                     ▲                                          │
│      ▼                                     │ checkout.session.* (signed)              │
│  db.mjs ── SQLite ── registrations, holds ─┼── email_outbox ──► mailer.mjs ──► email.mjs ──► Resend / Postmark
│      ▲                                     │                                          │
│      └──── stripe.mjs ─────────────────────┴──► Stripe API (sessions, refunds)        │
│                                                                                       │
│  timers: hold sweeper (60 s) · outbox worker (15 s) · both also exposed for cron      │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### One interface, two stores

Every view calls the same `Store` methods (`listEvents`, `getEvent`, `register`, `claim`, `releaseHold`, `cancelRegistration`, `createEvent`, `updateEvent`, `myRegistrations`, `listRegistrations` and so on). Two implementations back them:

- **`RemoteStore`** talks to the API. It's chosen when `window.GATHER_API_BASE` is truthy.
- **`LocalStore`** performs the same logic against browser storage. It falls back to in-memory storage when `localStorage` is blocked, as in sandboxed iframes. It can't reach Stripe, so paid checkout becomes a clearly labelled simulation over the same seat-hold state machine.

**Which one runs?** The committed `index.html` sets `GATHER_API_BASE` to `null`, so on its own it's the standalone demo. When `server.mjs` serves the page, it rewrites that one line to `location.origin`, so `npm start` runs the UI against the API. `/api/meta` reports whether payments and email are really configured, and the footer shows all three facts: the store, payments and email. The UI never promises what the server can't do.

### The storage boundary

`db.mjs` exports plain functions and knows nothing about HTTP. `server.mjs` knows nothing about SQL. To move to Postgres, reimplement the `openDb()` interface; nothing else changes. On multiple instances, also claim outbox rows with `FOR UPDATE SKIP LOCKED` (see ROADMAP DEP-3).

### The build

`build.mjs` inlines three things into `public/index.template.html`:

1. `app.js`.
2. The **seed**, materialised by `buildSeed()` with absolute timestamps plus its `builtAt`.
3. The source text of **`rebaseSeed()`**, which moves those timestamps onto the viewer's clock on first load, so an old build never goes stale.

The output is one file that works from disk, from the server, or published anywhere. The build rebuilds `rebaseSeed` from source in an empty scope, and refuses to ship if it isn't self-contained.

### Background work

Two jobs run on timers in a long-lived process, and both are also exposed as idempotent endpoints for cron:

- **Hold sweeper** (every 60 s, `POST /api/admin/sweep`). Expires lapsed holds and promotes the waitlist behind them. Capacity reads never depend on it, because queries filter expired holds directly. Promotions and `hold_expired` emails do.
- **Outbox worker** (every 15 s, `POST /api/admin/outbox/drain`). Sends queued email.

On serverless platforms the timers never fire, so cron is mandatory there.

---

## 5. The registration state machine

```
free event      ──► confirmed
                ──► waitlisted                    (event already full)

paid event      ──► pending    seat HELD 30 min, before Stripe is called
                      ├─ checkout.session.completed ──► confirmed
                      ├─ hold lapses / session expired ──► expired      (seat released)
                      └─ released by the attendee ──► cancelled          (seat released)
                ──► waitlisted                    (event full: never charged)

promotion off the waitlist
  free event    ──► confirmed
  paid event    ──► offered    seat HELD 24 h, attendee must pay to claim
                      ├─ paid ──► confirmed
                      └─ offer lapses ──► expired   (next person is offered)

late payment for a seat already gone ──► refund_due flag → automatic refund → refunded_at
```

- **Capacity** counts `confirmed` seats plus unexpired `pending` and `offered` holds. Seats, not rows: a party of 3 is 3 seats.
- **Promotion** walks the waitlist oldest-first and skips any party too big for the gap, rather than splitting it or letting it jump the queue.
- **Our hold outlives Stripe's session** by 2 minutes (`HOLD_GRACE_SECONDS`), so a payment can't land on a seat we already released.
- **Constants** (`db.mjs`): `HOLD_MINUTES = 30` (Stripe's minimum session life), `OFFER_HOURS = 24`, `MAX_EMAIL_ATTEMPTS = 6`.

Event status is one of `draft`, `published` or `cancelled`. Browse shows `published` events, plus the signed-in host's own drafts. A cancelled event drops out of browse but stays reachable by link, so people holding a ticket can see what happened.

---

## 6. Data model

SQLite in WAL mode. The schema lives in `SCHEMA` in `db.mjs`, and `migrate()` upgrades older databases in place.

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id`, `email` (unique), `name` | Created on first sign-in |
| `sessions` | `token`, `user_id` | Opaque random token. No expiry yet: see STATUS K-4 |
| `events` | `slug` (unique), `host_id`, `starts_at`, `ends_at`, `timezone`, `mode`, `capacity` (null means unlimited), `price_cents`, `currency`, `status` | Money is always in minor units |
| `registrations` | `event_id`, `user_id` (**unique pair**), `guests`, `status`, `amount_cents`, `hold_expires_at`, `stripe_session_id`, `stripe_payment_intent`, `paid_at`, `refund_due`, `refunded_at` | Inactive rows are reused on re-registration, so the unique pair always holds |
| `stripe_events` | `id` | Webhook idempotency receipts |
| `stripe_checkout_sessions` | `session_id` → `registration_id` | **Permanent** map. Never deleted (§7.5) |
| `email_outbox` | `type`, `dedupe_key` (unique), `to_email`, `payload`, `status`, `attempts`, `next_attempt_at`, `last_error` | Status is `queued`, `sending`, `sent` or `dead` |

Timestamps are ISO 8601 strings. `NOW_SQL` in `db.mjs` renders SQLite's "now" in exactly `Date#toISOString()` format, so comparisons are plain string comparisons.

---

## 7. Design decisions

Each one records the decision, the reason, and what it costs.

### 7.1 Zero dependencies

npm packages couldn't be installed in the environment where this was built, so everything uses Node's standard library. It's kept that way deliberately: clone-and-run, no supply chain, nothing to update. **Cost:** some things are hand-rolled, namely the HTTP routing, form encoding for Stripe, the webhook HMAC check and the test harness. Each is small and tested.

### 7.2 SQLite through `node:sqlite`, and one module owns SQL

Real SQL, real transactions and unique indexes, from a single file with no server. **Cost:** a single-writer database that doesn't suit serverless hosts, where the filesystem is ephemeral. The boundary in rule 2 keeps a Postgres move contained.

### 7.3 Capacity decided inside the database transaction

Two simultaneous requests for the last seat can't both win: the second is waitlisted. Application-level check-then-write can't guarantee that.

### 7.4 Seat holds for paid events

Confirming on click oversells to people who never pay. Confirming on the webhook lets two people pay for the last seat, and then you owe someone a refund. So registering for a paid event **holds** the seat first, then creates the Checkout session. If Stripe fails, the hold is released immediately.

### 7.5 A permanent session-to-registration map

`registrations.stripe_session_id` only tracks the *current* checkout attempt, and it's cleared when a row is reused. Without `stripe_checkout_sessions`, a payment landing on a superseded session would resolve to nothing: we'd quietly keep money for a seat nobody got. This was caught while building phase 2.

### 7.6 Waitlist offers on paid events

A promoted person hasn't paid, so they can't be auto-confirmed. They get a 24-hour `offered` hold and an email with the deadline. **Nobody is ever charged to wait.**

### 7.7 Late payments are refunded, not seated

If a hold lapsed and the seat has gone, confirming the payment would oversell the room. The webhook flags `refund_due`, the server refunds through Stripe, and the attendee is emailed. A failed refund stays flagged and visible in the host's guest list.

### 7.8 Webhooks: verified, and idempotent twice over

The webhook is HMAC-SHA256 over `${timestamp}.${raw body}`. The comparison is timing-safe, and there's a 5-minute replay window. It uses the raw bytes, because re-serialised JSON would break the signature.

Event ids are recorded, so a redelivery is a no-op. Separately, confirming an already-confirmed registration is also a no-op, so even a *different* event id for the same session changes nothing. A handler that throws deletes its receipt and returns 500, so Stripe's retry runs it again.

### 7.9 A transactional outbox for email

The email intent is written in the **same transaction** as the state change, and a worker sends it later. This buys three things:

- "Registered but never emailed" can't happen.
- A slow provider can't slow down or fail a registration.
- An email error can't turn a webhook into a 500, which would make Stripe retry and the attendee get the message twice.

Each row carries a dedupe key and a **payload snapshot**. The snapshot matters because state moves on before the worker runs: a lapsed hold has already been cleared by the time its email is sent.

Backoff runs 30 s → 2 m → 10 m → 30 m → 2 h → 6 h, then dead-letters. The first steps are short because `waitlist_offer` has a deadline. Permanent failures (4xx, apart from 408, 409 and 429) dead-letter on the first attempt.

### 7.10 An honest UI

The footer reports the store, payments and email. On-device checkout says *Simulated checkout*, and inbox copy only promises an email when the server really delivers. A server without Stripe explains itself up front on paid events, instead of erroring on click.

### 7.11 One seed, relative dates, rebased on the device

`seed-data.mjs` is the single source for both the database seed and the standalone page. Dates are stored as day offsets, so every `npm run seed` is current.

The standalone page gets absolute dates at build time, so `rebaseSeed()` shifts them on first load. Events move by whole calendar days and keep their wall-clock time in their own timezone, across daylight-saving changes. Registration timestamps move by the exact elapsed time. Without this, the published demo decayed from 8 upcoming events to 1 in three weeks.

### 7.12 Lightweight sign-in

It's an email and a display name, with no password and no verification. That's fine for a demo and unacceptable for production (STATUS K-3, ROADMAP AUTH-1). Swapping it out touches only the two `/api/auth` handlers.

### 7.13 Privacy

The public event payload carries **counts, never identities**. Only the host sees guest names and emails. Note that `/api/admin/outbox` currently breaks this (STATUS K-1).

---

## 8. API reference

Auth is a session token from sign-in, sent as either the `gather_session` cookie or `Authorization: Bearer <token>`. Errors are always `{ "error": { "code", "message" } }` with a real status code, and `message` is written to be shown to a user as-is.

| Method | Route | Auth | Notes |
|---|---|---|---|
| `POST` | `/api/auth/session` | — | `{ email, name }` → `{ user, token }`. Creates the account on first sight |
| `DELETE` | `/api/auth/session` | user | Sign out |
| `GET` | `/api/me` | — | Current user, or `null` |
| `GET` | `/api/me/registrations` | user | Your tickets, each with its event |
| `GET` | `/api/me/events` | user | Events you host, including drafts |
| `GET` | `/api/events` | — | `?q=&category=&mode=in_person\|online&when=upcoming\|week\|past`. Capped at 100 |
| `POST` | `/api/events` | user | Create. `priceCents > 0` returns `503` without a Stripe key |
| `GET` | `/api/events/:slug` | — | `{ event, myRegistration, isHost }` |
| `PATCH` | `/api/events/:slug` | host | Partial update. Guards capacity and free↔paid switches |
| `POST` | `/api/events/:slug/cancel` | host | Expires holds and emails everyone still holding a place |
| `GET` | `/api/events/:slug/ics` | — | Calendar file |
| `POST` | `/api/events/:slug/registrations` | user | `{ guests, note }` → `confirmed`, `waitlisted`, or `payment_required` with `checkoutUrl` |
| `POST` | `/api/events/:slug/registrations/claim` | user | Pay for an offered seat |
| `POST` | `/api/events/:slug/registrations/mine/release` | user | Give up a hold now |
| `DELETE` | `/api/events/:slug/registrations/mine` | user | Cancel; promotes the queue |
| `GET` | `/api/events/:slug/registrations` | host | Guest list, including holds and refunds due |
| `GET` | `/api/events/:slug/registrations.csv` | host | The same list, as CSV |
| `POST` | `/api/stripe/webhook` | signature | Handles `checkout.session.completed`, `.expired`, `.async_payment_succeeded`, `.async_payment_failed` and `charge.refunded` |
| `POST` | `/api/admin/sweep` | **none (K-1)** | Release lapsed holds now |
| `GET` | `/api/admin/outbox` | **none (K-1)** | Inspect the queue. `?status=dead` shows what never sent |
| `POST` | `/api/admin/outbox/drain` | **none (K-1)** | Send queued email now |
| `GET` | `/api/meta` | — | Categories, currencies, and whether payments and email are configured |
| `GET` | `/api/health` | — | Liveness, row counts, outbox counts |

Error codes worth knowing: `already_registered`, `host_cannot_register`, `event_past`, `event_cancelled`, `event_not_open`, `capacity_below_confirmed`, `price_change_blocked`, `no_offer`, `payments_not_configured`, `signature_missing`, `signature_invalid`, `signature_stale`.

---

## 9. Testing

```bash
npm test     # 366 assertions, ~2 s, no framework
```

`server/test.mjs` seeds throwaway databases, starts **two real servers** as child processes, and drives them over HTTP:

- **Main server:** Stripe → `stripe-stub.mjs`, email → `email-stub.mjs` (the real Resend code path, pointed at the stub).
- **Key-less server:** seeded with no Stripe or email configuration, to prove graceful degradation. It matches what most people run first.

It has 43 sections. In brief:

- **Browse, auth, validation.** Capacity and waitlists, guest-list access, editing guards, calendar export, closed states.
- **Payments.** The exact request sent to Stripe, holds that can't be oversold, webhook confirmation, idempotency, four kinds of bad signature, abandoned checkouts, offers and claims, the sweeper, late-payment refunds, and Stripe failure recovery.
- **Email.** All seven messages, deduplication, fan-out on cancellation, retry with backoff, permanent rejections, giving up, and provider wire formats.
- **Front end.** The page the server serves is proven wired to the API, and `RemoteStore` is driven end to end. The standalone page never goes stale. Seed data can never email a real person. `public/index.html` matches its sources.

**How the front-end tests work.** `bootUi()` fetches the HTML the server really serves. It runs those scripts in a `node:vm` context with a stub DOM, then calls the app's store through `window.__GATHER__`. That tests the real data layer, not pixels. It exists because a remote browser can't reach a local server.

**What this proves, and what it doesn't.** It proves *our* code: the wire formats, the state machine, signature verification, retries, and API client contracts. It does **not** prove Stripe's or the email provider's behaviour. Those need real test-mode accounts (ROADMAP PAY-1 and MAIL-1). Visual and interaction checks were done by hand in a real browser; see the STATUS verification log.

**The house style:** every new check should be seen to fail before it's trusted. The pre-fix code for each Phase 4 fix was run against its new test first.

### Adding a test

Add a section inside the `try` block in `test.mjs`:

```js
console.log('\n— what you are proving');
{
  const token = await signIn('someone@example.com', 'Someone');   // always example.com
  const r = await req('POST', '/api/events/some-slug/registrations', { token, body: { guests: 1 } });
  eq('it does the thing', r.json.status, 'confirmed');
}
```

These helpers are available: `req`, `signIn`, `eq`, `check`, `iso(days, hour)`, `makePaidEvent`, `sendWebhook` / `completedEvent` / `expiredEvent`, `drainEmail`, `outboxRows`, `backdateHold` (simulates time passing), `bootUi`, plus `stub` (Stripe) and `mailStub` (email, with `failNext(n, status)`).

Sections share one database and run in order, so create your own fixtures rather than mutating seeded events other sections rely on.

---

## 10. Conventions and gotchas

- **Commits** use conventional prefixes: `feat:`, `fix(scope):`, `chore:`, `docs:`. Explain the *why* in the body. Work goes on a branch with a pull request; `main` isn't committed to directly.
- **Money** is always an integer in minor units: `priceCents`, `amountCents`. JPY is zero-decimal, so `formatMoney` and `toMinor` handle it.
- **Escaping.** Every interpolation into HTML goes through `esc()`, both in `app.js` and in `templates.mjs`.
- **No backticks inside SQL comments.** The SQL lives in JavaScript template literals, so a backtick in a `--` comment ends the string. This happened once already.
- **The `ExperimentalWarning`** from `node:sqlite` is why every script runs with `--no-warnings`.
- **WAL side files.** `gather.db-wal` and `gather.db-shm` appear next to the database, and they're gitignored.
- **Stripe's return URL puts its query inside the hash**, as in `#/e/slug?checkout=success`. `parseRoute()` splits it off before routing.
- **The published demo runs in a sandboxed iframe.** `localStorage` throws there (the app falls back to memory), and checkout redirects use `window.top`.
- **Event times are timezone-aware.** Each event stores its IANA zone, and the UI formats in the *event's* zone, not the viewer's. New events currently take the host's browser zone (K-14).
- **`rebaseSeed` must stay self-contained.** It's inlined by source text, and the build enforces this.
- **Browser checks against the published demo.** Use `window.__GATHER__.Store` to set up state directly instead of scripting clicks.

---

## 11. Recipes

**Add an API endpoint.** Add the route in `handleApi()` in `server.mjs`, and put any SQL behind a new function in `db.mjs`. Use `requireUser(req)` for auth, and throw `AppError(status, code, message)` for errors. Then add the method to **both** stores in `app.js`, and add a test.

**Change the schema.** Add the column to `SCHEMA`, *and* add an `ALTER TABLE` to `migrate()` so existing databases upgrade. Update `shapeEvent` / `shapeRegistration` if the column should reach the API.

**Add an email type.**

1. Add a `case` to `renderEmail()` in `templates.mjs` and add the name to `EMAIL_TYPES`.
2. Call `enqueueEmail({ type, dedupeKey, registrationId, eventId, userId, payload })` inside the transaction that causes it. The dedupe key must be stable across retries and redeliveries, but distinct for a genuinely new notification.
3. Run `npm run preview:email` to eyeball it, and add a test in the email sections.

**Add or change sample data.** Edit `server/seed-data.mjs` using reserved-domain emails only, then run `npm run build`, then `npm run reseed`.

**Swap the storage driver.** Reimplement everything `openDb()` returns, against the same contract. Run the whole suite. Nothing outside `db.mjs` should need to change.

**Republish the Hyperagent demo.** Run `npm run build`, then publish `public/index.html` over the existing artifact. The public share link in the README tracks the latest version, so it doesn't need updating.

---

## 12. Definition of done

- [ ] `npm test` passes, and any new behaviour has a test that was seen to fail first.
- [ ] If `app.js`, the template or the seed changed, `npm run build` was run and `index.html` is committed.
- [ ] If a business rule changed, both `db.mjs` and `LocalStore` changed.
- [ ] No new dependencies, no secrets, and no deliverable email addresses in fixtures.
- [ ] Docs match reality: this file, the README if user-facing, and `.env.example` if configuration changed.
- [ ] STATUS.md updated: the board, the known issues, and a verification log entry.
- [ ] Work is on a branch with a pull request that explains the *why*.
