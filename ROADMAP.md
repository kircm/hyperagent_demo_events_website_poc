# Roadmap

Where Gather could go next, prioritised, with the reasoning behind each item. The *why* is the point: it's what lets you judge whether an item still makes sense by the time you get to it.

This file is the **backlog**. Whether something is in progress, done, or blocked lives in [STATUS.md](STATUS.md), which references these IDs.

**Priority:** **P0** blocks any public deployment · **P1** makes it real · **P2** adds product depth · **P3** improves engineering quality
**Size:** **S** hours · **M** a day or two · **L** a week or more. These are agent-assisted estimates, so treat them loosely.

## The critical path to a public URL

```
SEC-1 → SEC-2 → SEC-3 → DEP-2 → PAY-1 + MAIL-1 → AUTH-1 → SEC-4/5/6 → DEP-1
```

Everything before DEP-1 is small except AUTH-1, SEC-4 and SEC-6. DEP-2 (CI) is the cheapest high-value item on this page: the suite already runs in about 2 seconds.

## At a glance

| ID | Item | Pri | Size |
|---|---|---|---|
| [SEC-1](#sec-1) | Lock down `/api/admin/*` | P0 | S |
| [SEC-2](#sec-2) | CORS allowlist instead of echoing any origin | P0 | S |
| [SEC-3](#sec-3) | CSRF protection, or bearer-only auth | P0 | S |
| [SEC-4](#sec-4) | Session expiry, rotation, hashed tokens | P0 | M |
| [SEC-5](#sec-5) | Validate host-supplied URLs | P0 | S |
| [SEC-6](#sec-6) | Rate limiting | P0 | M |
| [AUTH-1](#auth-1) | Magic-link sign-in through the existing outbox | P0 | M |
| [DEP-1](#dep-1) | Deploy as-is to a host with a persistent disk | P1 | S |
| [DEP-2](#dep-2) | CI: run `npm test` on every push | P1 | S |
| [PAY-1](#pay-1) | Verify against real Stripe test mode | P1 | S |
| [MAIL-1](#mail-1) | Real email end to end, plus deliverability | P1 | S |
| [PAY-2](#pay-2) | Refund paid attendees when a host cancels, and fix the email copy | P1 | M |
| [MAIL-2](#mail-2) | Make "reply to this email" true | P1 | S |
| [FE-1](#fe-1) | One rules module shared by both stores | P1 | M |
| [DEP-3](#dep-3) | Postgres storage driver | P1 | L |
| [DEP-4](#dep-4) | Versioned migrations | P1 | M |
| [MAIL-3](#mail-3) | Reminders 24 h and 1 h before | P2 | M |
| [MAIL-4](#mail-4) | Daily digest for hosts | P2 | M |
| [MAIL-5](#mail-5) | "Event details changed" email | P2 | S |
| [MAIL-6](#mail-6) | Bounce and complaint suppression | P2 | M |
| [PAY-3](#pay-3) | Host-initiated refunds | P2 | M |
| [PAY-4](#pay-4) | Stripe Connect payouts and a platform fee | P2 | L |
| [PAY-5](#pay-5) | Ticket tiers and early-bird pricing | P2 | M |
| [PAY-6](#pay-6) | Discount codes | P2 | S |
| [PAY-7](#pay-7) | Tax | P2 | M |
| [PROD-1](#prod-1) | Image uploads and self-hosted covers | P2 | M |
| [PROD-2](#prod-2) | Per-event timezone picker | P2 | S |
| [PROD-3](#prod-3) | QR tickets and door check-in | P2 | M |
| [PROD-4](#prod-4) | Private and unlisted events | P2 | S |
| [PROD-5](#prod-5) | Browse pagination | P2 | S |
| [PROD-6](#prod-6) | Location search and a map view | P2 | M |
| [PROD-7](#prod-7) | Recurring events | P2 | L |
| [PROD-8](#prod-8) | Host profiles and follows | P2 | M |
| [FE-2](#fe-2) | Split `app.js` into modules | P3 | M |
| [FE-3](#fe-3) | Real-browser end-to-end tests | P3 | M |
| [FE-4](#fe-4) | Accessibility pass | P3 | S–M |
| [DEP-5](#dep-5) | GitHub Pages for the standalone demo | P3 | S |
| [OPS-1](#ops-1) | Data retention | P3 | S |
| [OPS-2](#ops-2) | Structured logs and readiness checks | P3 | S |

---

## P0 · Before anything faces the internet

### <a id="sec-1"></a>SEC-1 · Lock down `/api/admin/*`

**Why:** `GET /api/admin/outbox` returns every queued and sent email, with the recipient's address and the message payload, to anyone who asks. `sweep` and `drain` are callable by anyone too. They're harmless and idempotent, but they're still unauthenticated. *(STATUS K-1)*

**What:** Require `Authorization: Bearer $GATHER_ADMIN_TOKEN`, and return 404 when the variable is unset, so a misconfigured deploy fails closed. Keep the endpoints, because cron needs them.

**Done when:** tests prove each admin route refuses a missing or wrong token, and the cron instructions in AGENTS.md include the header.

### <a id="sec-2"></a>SEC-2 · CORS allowlist instead of echoing any origin

**Why:** The server reflects any `Origin` with `Access-Control-Allow-Credentials: true`. Once it's deployed over HTTPS, where the cookie becomes `SameSite=None`, any website a signed-in user visits can make authenticated requests as that user **and read the responses**. *(K-2)*

**What:** Add `GATHER_ALLOWED_ORIGINS`, a comma-separated list, and send no CORS headers for anything else. Same-origin use, like `npm start`, needs none at all.

**Done when:** a disallowed origin gets no `Access-Control-Allow-Origin` header, and there's a test for it.

### <a id="sec-3"></a>SEC-3 · CSRF protection, or bearer-only auth

**Why:** Cookie auth plus cross-site requests is the classic CSRF shape, even with SEC-2 in place.

**What:** The simplest fix is to **drop the cookie** and go bearer-only. The UI already sends `Authorization: Bearer` on every call. The alternative is to require a custom header, or check `Origin`, on every mutating request.

**Done when:** a cross-site form POST can't change state.

### <a id="sec-4"></a>SEC-4 · Session expiry, rotation, hashed tokens

**Why:** Sessions never expire server-side, tokens are stored in plaintext, and in API mode the UI keeps its bearer token in `localStorage`, where any XSS can read it. *(K-4)*

**What:** Add an absolute plus sliding expiry and store a SHA-256 of the token rather than the token itself. Add "sign out everywhere". Then reconsider `localStorage` against an httpOnly cookie, in combination with SEC-3.

### <a id="sec-5"></a>SEC-5 · Validate host-supplied URLs

**Why:** `coverUrl` and `onlineUrl` accept any string, and `onlineUrl` becomes a clickable link inside confirmation emails. That leaves room for `javascript:` URLs and phishing. *(K-5)*

**What:** Allow `http:` and `https:` only, cap the length, and show the link's domain next to it in the UI and the email.

### <a id="sec-6"></a>SEC-6 · Rate limiting

**Why:** Sign-in creates accounts, registration can be hammered, and event creation is open to anyone signed in. *(K-11)*

**What:** A per-IP and per-account token bucket, held in memory while there's a single instance and in a shared store later.

### <a id="auth-1"></a>AUTH-1 · Magic-link sign-in through the existing outbox

**Why:** Anyone can currently sign in as anyone, deliberately, for the demo. That's the single biggest gap between this and a product. *(K-3)*

**What:** `POST /api/auth/link` enqueues a `sign_in_link` email carrying a single-use, 15-minute token, and `GET /api/auth/verify` exchanges it for a session. The outbox, dedupe keys and templates all already exist, so this is mostly wiring. It also proves email ownership, which makes every other email trustworthy.

**Done when:** a session can only be obtained by clicking a link sent to that address. Tests cover expiry, reuse, and a link opened in a different browser.

---

## P1 · Make it real

### <a id="dep-1"></a>DEP-1 · Deploy as-is to a host with a persistent disk

**Why:** It's the shortest path to a real URL. Render, Fly or Railway can run the server unchanged, with SQLite on a mounted volume.

**What:** Set `GATHER_PUBLIC_URL`, the Stripe and email variables, and `GATHER_ADMIN_TOKEN` (from SEC-1). Schedule cron for `sweep` and `drain` every few minutes as a belt-and-braces measure. Do it **after the P0 items**.

### <a id="dep-2"></a>DEP-2 · CI: run `npm test` on every push

**Why:** The suite takes about 2 seconds and needs no install. There's no reason for a red test to reach `main`.

**What:** A GitHub Actions workflow that runs `npm test` on Node 22.13 and 24, for pushes and pull requests.

### <a id="pay-1"></a>PAY-1 · Verify against real Stripe test mode

**Why:** The suite proves *our* side against a stub. Stripe's real behaviour has never been exercised. *(K-9)*

**What:** Work through the checklist in [AGENTS.md → Stripe test mode](AGENTS.md#stripe-test-mode): a successful card, a declined card, a lapsed hold, an expired session, and an offer then a claim. Record the results in the STATUS verification log.

### <a id="mail-1"></a>MAIL-1 · Real email end to end, plus deliverability

**Why:** Same as PAY-1, for email. Deliverability is also a DNS problem as much as a code problem.

**What:** Set up a verified sending domain with SPF, DKIM and DMARC. Send yourself each of the seven messages; `npm run preview:email` shows what to expect. Check rendering in Gmail, Outlook and Apple Mail.

### <a id="pay-2"></a>PAY-2 · Refund paid attendees when a host cancels, and fix the email copy

**Why:** When a host cancels a paid event, the `event_cancelled` email tells attendees "the host has been asked to refund it". Nothing asks anyone. It's a promise the system doesn't keep. *(K-6)*

**What:** On cancellation, refund every paid confirmed registration through Stripe, with an idempotency key per payment intent. Mark each one refunded, and make the email state what actually happened. Surface any failures to the host.

**Done when:** cancelling a paid event results in refunds on the Stripe stub, and the email copy matches the outcome.

### <a id="mail-2"></a>MAIL-2 · Make "reply to this email" true

**Why:** Two templates tell people to reply, but replies only reach a person if `EMAIL_REPLY_TO` points at a monitored inbox. *(K-7)*

**What:** Default the reply-to address to the **event host's** email, so replies reach the right person. Otherwise, remove those lines.

### <a id="fe-1"></a>FE-1 · One rules module shared by both stores

**Why:** Every business rule is implemented twice: in `db.mjs`, and in `LocalStore` in `app.js`. That covers capacity math, promotion order, validation and state transitions. Nothing tests that the two agree. This is the biggest maintenance risk in the codebase. *(K-8)*

**What:** Extract the pure rule functions into `shared/rules.mjs`. Import them in `db.mjs`, and inline them into the page with `build.mjs`, using the same self-contained technique as `rebaseSeed`. Then add a **parity test** that runs identical scenarios against both stores and compares the outcomes.

### <a id="dep-3"></a>DEP-3 · Postgres storage driver

**Why:** Serverless hosts have ephemeral filesystems, and SQLite is single-writer.

**What:** Reimplement the `openDb()` contract against Postgres. Claim outbox rows with `SELECT … FOR UPDATE SKIP LOCKED`, and guard the sweeper with an advisory lock so several instances can run safely. The full suite must pass unchanged against it; that's the contract. *(K-12)*

**Decision first:** Node has no built-in Postgres client. That means either a dependency such as `pg`, which breaks ground rule 1 and needs the owner's sign-off, or a Postgres provider with an HTTP query API reachable over plain `fetch`. Decide before starting. It's listed under *Decisions needed* in STATUS.md.

### <a id="dep-4"></a>DEP-4 · Versioned migrations

**Why:** `migrate()` inspects columns and adds whatever is missing. That's fine for three changes and fragile at thirty.

**What:** Numbered migration files and a `schema_version` table, with one runner shared by the SQLite and Postgres drivers.

---

## P2 · Product depth

### <a id="mail-3"></a>MAIL-3 · Reminders 24 h and 1 h before

A scheduler reads forward from `starts_at` and enqueues `reminder` emails with the dedupe key `reminder:<registration>:<window>`, skipping anything cancelled. It needs a scheduler rather than the outbox alone, because nothing *changes* to trigger it.

### <a id="mail-4"></a>MAIL-4 · Daily digest for hosts

New registrations, cancellations, waitlist movement and takings, sent once a day. A message per registration would be spam.

### <a id="mail-5"></a>MAIL-5 · "Event details changed" email

When the time, venue or join link changes, notify everyone holding a place. Batch edits made within a few minutes of each other, so a host fixing a typo doesn't send three emails.

### <a id="mail-6"></a>MAIL-6 · Bounce and complaint suppression

Consume the provider's bounce and complaint webhooks into a suppression list, and stop sending to dead or hostile addresses. This protects the sending reputation.

### <a id="pay-3"></a>PAY-3 · Host-initiated refunds

Full and partial refunds from the guest list. Today a voluntary cancellation releases the seat without refunding it, and the host has no tool to fix that.

### <a id="pay-4"></a>PAY-4 · Stripe Connect payouts and a platform fee

At the moment all money lands in whichever account owns the key. Paying hosts out is a different shape of integration, with onboarding, KYC and payouts, rather than an extension of this one.

### <a id="pay-5"></a>PAY-5 · Ticket tiers and early-bird pricing

Multiple prices per event, each with its own capacity. The state machine already counts seats rather than rows, which helps.

### <a id="pay-6"></a>PAY-6 · Discount codes

Stripe promotion codes on Checkout. This is mostly configuration.

### <a id="pay-7"></a>PAY-7 · Tax

Stripe Tax on Checkout. Needs registered addresses, and a decision about tax-inclusive display.

### <a id="prod-1"></a>PROD-1 · Image uploads and self-hosted covers

Hosts can only pick from a fixed set of covers today. The seed covers are also hosted on `pub.hyperagent.com`, which is an external dependency. *(K-10)* Add object storage, uploads, and resizing.

### <a id="prod-2"></a>PROD-2 · Per-event timezone picker

New events take the host's browser timezone. A host in New York creating a London event gets the wrong times. *(K-14)*

### <a id="prod-3"></a>PROD-3 · QR tickets and door check-in

A signed ticket code in the confirmation email, and a scanner view for the host. That also unlocks no-show data.

### <a id="prod-4"></a>PROD-4 · Private and unlisted events

Events kept out of browse and reachable by link only, with optional invite codes.

### <a id="prod-5"></a>PROD-5 · Browse pagination

Browse is capped at 100 events, with no pagination. *(K-13)*

### <a id="prod-6"></a>PROD-6 · Location search and a map view

Geocode venues, filter by distance, and add a map toggle on browse.

### <a id="prod-7"></a>PROD-7 · Recurring events

Series with per-occurrence capacity and registrations. It touches almost everything, which is why it's L.

### <a id="prod-8"></a>PROD-8 · Host profiles and follows

A public host page, plus "follow" to get an email when a host you follow publishes something. That can reuse the outbox.

---

## P3 · Engineering quality

### <a id="fe-2"></a>FE-2 · Split `app.js` into modules

It's about 2,300 lines in one IIFE. Split it into native ES modules, and keep the single-file build output.

### <a id="fe-3"></a>FE-3 · Real-browser end-to-end tests

Today's UI tests drive the real data layer against a stub DOM, and the visual checks were manual. Playwright would close the gap, **but it's a dependency**, so it conflicts with ground rule 1 and needs the owner's decision. *(K-15)*

### <a id="fe-4"></a>FE-4 · Accessibility pass

Focus trapping in modals, full keyboard support on cards and filters, and a contrast audit. Toasts are already `aria-live`.

### <a id="dep-5"></a>DEP-5 · GitHub Pages for the standalone demo

A small Actions workflow that publishes `public/index.html`. Pages can't serve `/public` directly. This gives a demo URL that lives with the repo.

### <a id="ops-1"></a>OPS-1 · Data retention

Prune sent outbox rows, expired sessions and old `stripe_events` receipts on a schedule.

### <a id="ops-2"></a>OPS-2 · Structured logs and readiness checks

JSON logs with request IDs, and a readiness check that verifies the database and configuration, separate from `/api/health`.

---

## Ideas worth a conversation

These aren't prioritised. Each needs a product decision before it needs code.

- **SMS for waitlist offers.** An offer carries a 24-hour deadline, and email is the weakest link for anything time-sensitive.
- **Calendar sync** with Google and Outlook, instead of downloading `.ics` files.
- **Named guests.** Registration takes a party size, and hosts often want names.
- **AI help in the create form:** drafting descriptions, suggesting categories, generating covers.
- **Host analytics:** registration curves, conversion from view to registration, and no-show rate once PROD-3 exists.
- **Event templates** for hosts who run the same thing every month, a lighter alternative to PROD-7.
