# Gather

Publish events, let people register. A real HTTP API with a SQL database, plus a
front end that runs against it — or standalone, with no server at all.

**Zero dependencies.** No `npm install`, no build toolchain, no native modules.
Storage is Node's built-in `node:sqlite`; the server is `node:http`. If you have
Node 22 or newer, you can run this.

---

## Run it

```bash
node --no-warnings server/seed.mjs      # load the sample content
node --no-warnings server/server.mjs    # or: npm start
# → http://localhost:8787
```

```bash
npm test               # 311 assertions against a live server on a throwaway database
npm run build          # regenerate public/index.html
npm run reseed         # wipe and reload the sample content
npm run preview:email  # render every email template to public/email-preview.html
```

Environment:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | |
| `GATHER_DB` | `./gather.db` | |
| `GATHER_PUBLIC_URL` | inferred from request headers | Where browsers reach the app. Stripe needs absolute redirect URLs, so set this behind a proxy. |
| `STRIPE_SECRET_KEY` | — | Enables paid events. Without it the app runs free-events-only. |
| `STRIPE_WEBHOOK_SECRET` | — | Enables the webhook endpoint. Without it payments can start but never confirm. |
| `STRIPE_API_BASE` | `https://api.stripe.com` | Override for tests. |
| `EMAIL_PROVIDER` | `resend` if a key is set, else `console` | `resend`, `postmark`, `console`, or `capture`. |
| `EMAIL_API_KEY` | — | Provider credential. Without it nothing is delivered and messages are logged. |
| `EMAIL_FROM` | `Gather <no-reply@gather.example>` | Must be an address your provider has verified. |
| `EMAIL_REPLY_TO` | — | Optional. |
| `EMAIL_API_BASE` | provider default | Override for tests. |
| `GATHER_MAILER_INTERVAL_MS` | `15000` | How often the outbox worker runs. |

There are no passwords. Sign in with any email and a display name — the seeded
host accounts (`lena@kilnandco.studio`, `maya@rooftopsessions.co`, and four
others) already own events, so signing in as one drops you straight into the
host tools. Swapping in real auth means rewriting the two `/api/auth` handlers
and nothing else.

---

## Layout

```
server/
  db.mjs           storage driver — the only module that knows SQL exists
  server.mjs       HTTP routing, sessions, CORS, webhooks, ICS + CSV
  stripe.mjs       Stripe client: sessions, refunds, signature verification
  stripe-stub.mjs  a fake Stripe for tests and offline development
  email.mjs        transports: resend, postmark, console, capture
  templates.mjs    the seven message bodies, HTML + plain text
  mailer.mjs       the outbox worker: retries, backoff, dead lettering
  email-stub.mjs   a fake email provider that can be told to fail
  ics.mjs          calendar invites, shared by the API and the emails
  seed-data.mjs    the sample content, as data
  seed.mjs         loads seed-data into the database
  test.mjs         end-to-end suite: boots a real server, drives it over HTTP
public/
  index.template.html   markup + styles
  app.js                application logic
  index.html            generated — do not edit by hand
build.mjs         inlines app.js + seed into index.html
```

### The one thing worth understanding

`db.mjs` is the whole storage layer, deliberately isolated. Everything above it
takes and returns plain objects. To move onto Postgres — which you need for
serverless hosting, where the filesystem is ephemeral — you reimplement that
one file and touch nothing else.

The front end mirrors this. `app.js` picks a backend at startup:

```js
window.GATHER_API_BASE = 'https://your-api.example.com';  // real API
window.GATHER_API_BASE = null;                            // on-device storage
```

Both implement the same interface, so no view knows which one it has. That's
what lets `public/index.html` work as a standalone page today and against a
deployed server the moment one exists. The footer tells you which mode you're
in.

The one thing on-device mode cannot do is talk to Stripe — there's no server
there to hold a secret key. So paid events still create a real seat hold and
run the same state machine, but the card step is a clearly-labelled simulation
with a Pay button standing in for the webhook. Nothing about it pretends to be
a payment. Against a deployed API the identical UI redirects to Stripe.

---

## API

Session token comes back from sign-in and is accepted as either a cookie or
`Authorization: Bearer <token>`. Cookies suit a same-origin browser app; the
bearer header suits cross-origin clients and `curl`.

| Method | Route | Notes |
|---|---|---|
| `POST` | `/api/auth/session` | `{email, name}` → user + token. Creates the account on first sight |
| `DELETE` | `/api/auth/session` | Sign out |
| `GET` | `/api/me` | Current user, or `null` |
| `GET` | `/api/me/registrations` | Your tickets, each with its event |
| `GET` | `/api/me/events` | Events you host, including drafts |
| `GET` | `/api/events` | `?q=` `&category=` `&mode=` `&when=upcoming\|week\|past` |
| `POST` | `/api/events` | Publish or draft an event |
| `GET` | `/api/events/:slug` | Event + your registration + whether you're the host |
| `PATCH` | `/api/events/:slug` | Host only |
| `POST` | `/api/events/:slug/cancel` | Host only |
| `GET` | `/api/events/:slug/ics` | Calendar file |
| `POST` | `/api/events/:slug/registrations` | `{guests, note}` → `confirmed`, `waitlisted`, or `payment_required` + `checkoutUrl` |
| `POST` | `/api/events/:slug/registrations/claim` | Pay for a seat offered off the waitlist |
| `POST` | `/api/events/:slug/registrations/mine/release` | Give up a held seat without waiting for it to lapse |
| `DELETE` | `/api/events/:slug/registrations/mine` | Cancel your spot |
| `GET` | `/api/events/:slug/registrations` | Guest list — host only. Includes holds and refunds due |
| `GET` | `/api/events/:slug/registrations.csv` | Guest list as CSV — host only |
| `POST` | `/api/stripe/webhook` | Stripe events. Signature-verified, idempotent |
| `POST` | `/api/admin/sweep` | Release lapsed holds now. Idempotent — for cron |
| `POST` | `/api/admin/outbox/drain` | Send queued email now. Idempotent — for cron |
| `GET` | `/api/admin/outbox` | Inspect the queue. `?status=dead` to find what never sent |
| `GET` | `/api/meta` | Categories, currencies, whether payments are configured |
| `GET` | `/api/health` | Liveness + row counts |

Errors are `{ error: { code, message } }` with a real status code. `message` is
written to be shown to a user as-is.

---

## The rules that actually matter

Capacity is the part that goes wrong in event apps, so it's decided inside a
SQL transaction rather than in application code:

- **No overselling.** Confirmed seats are summed and compared against capacity
  inside `BEGIN IMMEDIATE`. Two simultaneous requests for the last seat cannot
  both win — the second is waitlisted.
- **Overflow waitlists, in order.** Registering for a full event puts you in a
  queue ordered by registration time.
- **Cancelling promotes automatically.** Releasing confirmed seats walks the
  waitlist oldest-first and promotes everyone who fits. A party of three is
  skipped if only two seats opened, rather than being split or jumped ahead of
  someone who fits.
- **Raising capacity promotes too**, through the same path.
- **Capacity can't drop below confirmed seats.** Rejected with `409`, because
  there's no fair way to decide who loses their spot.
- **One registration per person per event**, enforced by a unique index. A
  cancelled row is reused on re-registration rather than duplicated, so the
  constraint always holds.
- **Hosts can't register for their own events**; only hosts can edit, cancel, or
  see the guest list.
- **Closed means closed.** Past, cancelled, and draft events all refuse
  registration with distinct error codes.

`npm test` covers each of these against a running server.

Guest names and emails are visible to the host only. The public event payload
carries counts, never identities.

---

## Payments

Paid events use Stripe Checkout. The whole design exists to close one gap: the
minutes between someone clicking register and their money arriving.

Confirming the seat immediately oversells to people who never pay. Confirming
only when the webhook lands lets two people both pay for the last seat, and
then you owe someone a refund. So neither:

**Registering for a paid event creates a `pending` seat hold.** The hold counts
against capacity for 30 minutes — Stripe's own minimum session lifetime — and
the Checkout session is created only after the seat is reserved. Our hold
outlives Stripe's session by two minutes, so a payment can never land on a seat
we already gave away.

```
register ──▶ pending (seat held, 30 min) ──▶ checkout.session.completed ──▶ confirmed
                   │                      └─▶ checkout.session.expired  ──▶ expired
                   └─▶ released by hand / swept ────────────────────────▶ expired
```

**The waitlist changes shape on a paid event.** You cannot auto-confirm a
promoted person — they haven't paid. So promotion produces an `offered` hold
that reserves the seat for 24 hours and asks them to pay. Nobody is ever
charged for a waitlist place; a waitlist registration carries no amount and no
session. If the offer lapses, the seat moves to the next person.

**A payment that arrives too late gets refunded.** If a hold lapsed and the
seat has since gone, the webhook marks the registration `refund_due` and the
server issues the refund through the Stripe API. It is flagged in the host's
guest list either way, so a failed refund is visible rather than silent.

Other details that matter:

- **Webhooks are verified properly** — HMAC-SHA256 over `${timestamp}.${raw body}`,
  timing-safe compared, with a 5-minute replay window. The raw bytes are used;
  re-serialising the JSON would break the signature.
- **Idempotent twice over.** Event ids are recorded, so a redelivery is a no-op.
  Independently, confirming an already-confirmed registration is a no-op — so
  even a *different* event id for the same session changes nothing. A handler
  that throws deletes its receipt and returns 500, so Stripe's retry re-runs it
  exactly once more.
- **Sessions are mapped permanently.** `registrations.stripe_session_id` only
  tracks the current attempt and is cleared when a row is reused, so
  `stripe_checkout_sessions` keeps the session → registration mapping forever.
  Without it, a payment landing on a superseded session would resolve to
  nothing — meaning quietly keeping money for a seat nobody got.
- **Free and paid can't be swapped underneath people.** Flipping the price with
  active registrations is a `409`; it would leave people confirmed without
  paying, or holds priced at zero.
- **Capacity can't drop below committed seats**, where committed includes
  in-progress payments.
- **No keys, no problem.** With `STRIPE_SECRET_KEY` unset, `/api/meta` reports
  payments as disabled, creating a paid event is a `503`, and free events work
  exactly as before.

### What the test suite proves — and what it doesn't

`npm test` runs payments against `server/stripe-stub.mjs`, a fake Stripe that
records every request. It asserts the exact wire format we send (form encoding,
bracket notation, idempotency key, session expiry inside Stripe's limits), and
drives the full choreography with genuinely HMAC-signed webhooks: holds
reserving capacity, confirmation, redelivery, four flavours of bad signature,
expiry, promotion to an offer, claiming, the sweeper, and the refund path.

**That proves our code, not Stripe's.** Before taking real money, verify
against Stripe's test mode:

```bash
export STRIPE_SECRET_KEY=sk_test_...
stripe listen --forward-to localhost:8787/api/stripe/webhook   # prints whsec_...
export STRIPE_WEBHOOK_SECRET=whsec_...
npm start
```

Then publish a paid event and pay with `4242 4242 4242 4242`. Worth exercising
specifically: `4000 0000 0000 0341` (card attaches, payment fails), closing the
Checkout tab and waiting for the hold to lapse, and
`stripe trigger checkout.session.expired`. Card details never touch this
server — Stripe hosts the payment page.

---

## Email

Seven transactional messages, all of which exist because the alternative is
leaving someone guessing:

| Type | Sent when |
|---|---|
| `registration_confirmed` | A seat is confirmed. Carries the receipt if paid, always attaches the calendar invite |
| `registration_waitlisted` | The event was full. Says plainly that no money was taken |
| `waitlist_offer` | A seat opened up. **Carries a deadline** |
| `hold_expired` | A checkout hold or claim offer ran out |
| `payment_refunded` | A payment landed after the last seat had gone |
| `registration_cancelled` | The attendee cancelled themselves |
| `event_cancelled` | The host cancelled — fanned out to everyone still holding a place, waitlisters included |

`npm run preview:email` renders all seven to a browsable page, so you can
iterate on wording and layout without sending yourself test messages.

### Nothing sends from a request handler

Email goes through a **transactional outbox**. The intent row is written in the
same transaction as the state change it describes, and a worker drains it
afterwards. That buys three things:

1. **"Registered but never emailed" cannot happen.** The seat and the intent
   commit together or not at all.
2. **A slow provider can't slow down registering**, and can't fail it either.
3. **An email failure can't turn a Stripe webhook into a 500** — which would
   make Stripe retry, and the person would get the message twice.

Failures retry on a backoff of 30s → 2m → 10m → 30m → 2h → 6h, then
dead-letter. The first steps are deliberately short because `waitlist_offer`
has a deadline attached: a message parked behind an hour of backoff can outlive
the seat it is about.

A **permanent** failure skips the retries entirely. A rejected recipient or a
bad key will fail identically on every attempt, so those dead-letter on the
first try rather than burning six. `GET /api/admin/outbox?status=dead` is where
you go to find out what never made it.

Each row carries a **dedupe key**, so a redelivered webhook or a host who
clicks Cancel twice still results in one message. The key embeds a
discriminator — usually the registration's `created_at`, which is reset when a
row is reused — so a genuinely new notification about the same registration
still gets through.

The row also **snapshots what to say**, because state moves on. By the time the
worker runs, a lapsed hold has already been cleared; without the snapshot the
message couldn't describe what happened.

### Providers

`resend` and `postmark` are implemented over plain `fetch`. Adding another is
one function and one line in the switch in `email.mjs`.

```bash
export EMAIL_PROVIDER=resend
export EMAIL_API_KEY=re_...
export EMAIL_FROM='Gather <hello@yourdomain.com>'
```

With no key set the transport falls back to `console`, which prints each
message instead of sending it — the intent is still recorded, so configuring a
provider later doesn't mean earlier notifications were silently lost. `/api/meta`
reports `email.delivers` so the UI never promises an inbox that isn't wired up.

The test suite runs the real Resend code path against a stub that records
every request and can be told to fail, so the retry, dead-letter and
classification behaviour is exercised rather than assumed. As with Stripe:
**that proves our code, not the provider's.** Send yourself a real one before
launch, and check SPF/DKIM on the sending domain — deliverability is a DNS
problem, not a code problem.

---

## Deploying

The front end is a static file and will go anywhere.

For the API, the storage driver decides your options:

- **A host with a real filesystem** (Fly, Render, Railway, a VM) — deploy as-is.
  SQLite persists on a mounted volume. This is the shortest path.
- **Serverless** (Vercel, Cloudflare, Lambda) — the filesystem is ephemeral, so
  reimplement `db.mjs` against Postgres, D1, or similar. The interface it
  exports is the contract; nothing else changes.

Then point the front end at it by setting `window.GATHER_API_BASE` before
`app.js` runs, and rebuild. CORS already echoes the request origin and allows
credentials, and the session cookie switches to `SameSite=None; Secure` when it
sees `X-Forwarded-Proto: https`.

If you're taking payments, three more things:

1. Set `GATHER_PUBLIC_URL` so Stripe's redirects point at the right host.
2. Register `POST /api/stripe/webhook` in the Stripe dashboard, subscribed to
   `checkout.session.completed`, `checkout.session.expired`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, and `charge.refunded`.
3. Call `POST /api/admin/sweep` and `POST /api/admin/outbox/drain` from cron
   every few minutes. Both run on their own timers in a long-lived process, but
   serverless platforms freeze between requests — so on those the timers never
   fire, lapsed holds sit there blocking seats, and queued email never leaves.

---

## Not built

Deliberate omissions, not oversights:

- **Host-facing email.** Attendees are emailed; hosts aren't. A message per
  registration would be spam — this wants a daily digest, which is a scheduled
  job rather than an outbox row.
- **Reminders.** No "your event is tomorrow" message. That needs a scheduler
  reading forward from `starts_at`, not a reaction to a state change.
- **Host payouts.** Money lands in whichever Stripe account the key belongs to.
  Paying hosts out means Stripe Connect and a platform fee — a different shape
  of integration, not an extension of this one.
- **Voluntary-cancellation refunds.** Cancelling a paid seat releases it but
  does not refund automatically; the guest list flags who paid so the host can
  decide. Automatic refunds only happen for payments we couldn't seat.
- **Password / OAuth auth.** Anyone can sign in as any email. Fine for a demo,
  not for production — see `/api/auth` above.
- **Image uploads.** Covers are picked from a fixed set or pasted as a URL.
- **Recurring events, multi-session events, ticket tiers, discount codes, taxes.**
