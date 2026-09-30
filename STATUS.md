# Status

**Last updated:** 2026-09-29 · **Phase:** 4, handover · **By:** Hyperagent Developer agent
**In one line:** a working, tested proof of concept, imported to GitHub and awaiting review in [PR #1](https://github.com/kircm/hyperagent_demo_events_website_poc/pull/1). It is **not safe to deploy publicly** until the P0 items below are done.

> **Agents:** read [AGENTS.md](AGENTS.md) first. When you finish something, update this file following the protocol at the bottom. Item IDs such as `SEC-1` refer to [ROADMAP.md](ROADMAP.md).

---

## At a glance

| Area | State | How we know |
|---|---|---|
| Events, registration, capacity, waitlists | ✅ Working | 366-assertion suite, plus manual browser checks |
| Host tools (guest list, CSV, edit, cancel) | ✅ Working | Suite, plus browser |
| Stripe Checkout, holds, offers, refunds | 🟡 Working against the stub | Suite with signed webhooks. **Never run against real Stripe** (PAY-1) |
| Transactional email (7 types) | 🟡 Working against the stub | Suite, plus a rendered preview. **Never sent for real** (MAIL-1) |
| UI against the API (`npm start`) | ✅ Working | `RemoteStore` driven end to end in the suite. Not yet eyeballed in a real browser against a local server |
| Standalone demo | ✅ Working, and live | [Live demo](https://hyperagent.com/s/ArlGbonOo2rZqj2u9r4W_Q), 8 of 8 events upcoming, checked in a browser on 2026-09-29 |
| Security | 🔴 Demo-grade | See K-1 to K-5 below |
| Deployment | ⚪ Not deployed | Only the standalone demo is hosted |
| CI | ⚪ None | DEP-2 |

---

## Board

### Awaiting the owner

- [ ] **Review and merge [PR #1](https://github.com/kircm/hyperagent_demo_events_website_poc/pull/1).** Six commits: the imported code, three fixes, local setup, and these docs.
- [ ] **Answer the [decisions below](#decisions-needed).** Several next steps depend on them.

### Up next, in recommended order

1. [ ] **SEC-1 · SEC-2 · SEC-3.** Small, and together they unblock any deployment. Fixes K-1 and K-2.
2. [ ] **DEP-2.** CI on every push; the suite runs in about 2 seconds.
3. [ ] **PAY-1 · MAIL-1.** Verify against real Stripe test mode and real email. *Needs the owner's accounts.*
4. [ ] **AUTH-1.** Magic-link sign-in through the existing outbox. Fixes K-3.
5. [ ] **SEC-4 · SEC-5 · SEC-6.** Sessions, URL validation, rate limits. Fixes K-4, K-5 and K-11.
6. [ ] **DEP-1.** Deploy as-is to a host with a persistent disk.
7. [ ] **PAY-2 · MAIL-2.** Make the cancellation and reply copy true. Fixes K-6 and K-7.
8. [ ] **FE-1.** One rules module for both stores. Fixes K-8.

### Later

Everything else is in [ROADMAP.md](ROADMAP.md), with priorities, sizes and reasoning.

### Done

| Date | What | Where |
|---|---|---|
| 2026-09-29 | Handover docs: README, AGENTS, ROADMAP, STATUS, CLAUDE.md | PR #1, commit F |
| 2026-09-29 | Fix: the page `npm start` serves now uses the API. `RemoteStore` gets its first coverage (27 assertions), and a key-less server explains paid events up front | PR #1, `c889336` |
| 2026-09-29 | `.env.example`, Node floor corrected to ≥22.13, and `.env` loading with no dependency | PR #1, `2a5c281` |
| 2026-09-29 | Fix: seed emails moved to reserved domains that can never deliver. A test enforces it | PR #1, `32a3905` |
| 2026-09-29 | Fix: the standalone demo rebases its dates onto the viewer's clock. The live demo had decayed to 1 of 9 upcoming | PR #1, `70382e6` |
| 2026-09-29 | Imported the Sept 10 code, verified byte-identical | PR #1, `a850443` |
| 2026-09-10 | Phase 3: transactional email through an outbox, 7 templates, Resend and Postmark | `a850443` |
| 2026-09-10 | Phase 2: Stripe Checkout with seat holds, offers, signed webhooks and refunds | `a850443` |
| 2026-09-10 | Phase 1: API, SQLite, events, registration, waitlists, host tools, UI | `a850443` |

---

## Known issues

Severity reflects impact **if deployed publicly**. As a local demo, none of these bite.

| ID | Sev | Issue | Where | Fix |
|---|---|---|---|---|
| K-1 | 🔴 High | `/api/admin/*` is unauthenticated, and `GET /api/admin/outbox` returns recipient addresses and message payloads | `server.mjs` | SEC-1 |
| K-2 | 🔴 High | CORS reflects any `Origin` with credentials. Over HTTPS, any website can make authenticated requests as a signed-in visitor and read the responses | `server.mjs` → `corsHeaders` | SEC-2, SEC-3 |
| K-3 | 🔴 High | Anyone can sign in as any email, with no verification. Deliberate for the demo | `/api/auth/session` | AUTH-1 |
| K-4 | 🟠 Med | Sessions never expire server-side, tokens are stored in plaintext, and the bearer token is kept in `localStorage` in API mode | `db.mjs`, `app.js` | SEC-4 |
| K-5 | 🟠 Med | Host-supplied `onlineUrl` and `coverUrl` aren't scheme-checked, and `onlineUrl` becomes a link in confirmation emails | `db.mjs` → `validateEventInput` | SEC-5 |
| K-6 | 🟠 Med | The `event_cancelled` email tells paid attendees "the host has been asked to refund it", but nothing asks the host | `templates.mjs` | PAY-2 |
| K-7 | 🟡 Low | Two emails say "reply to this email", but replies go nowhere unless `EMAIL_REPLY_TO` is a monitored inbox | `templates.mjs` | MAIL-2 |
| K-8 | 🟠 Med | Every business rule is implemented twice, in `db.mjs` and in `LocalStore`, and parity isn't tested | `app.js` | FE-1 |
| K-9 | 🟠 Med | Stripe and email have only ever run against stubs | — | PAY-1, MAIL-1 |
| K-10 | 🟡 Low | The seed cover images are hosted on `pub.hyperagent.com`, an external dependency | `seed-data.mjs` → `COVERS` | PROD-1 |
| K-11 | 🟡 Low | No rate limiting anywhere | `server.mjs` | SEC-6 |
| K-12 | 🟡 Low | Single-instance assumptions: outbox claiming and in-process timers. Fine on one server, wrong on several | `db.mjs`, `server.mjs` | DEP-3 |
| K-13 | 🟡 Low | Browse is capped at 100 events, with no pagination | `db.mjs` → `listEvents` | PROD-5 |
| K-14 | 🟡 Low | New events take the host's browser timezone, and there's no picker | `app.js` → `readEventForm` | PROD-2 |
| K-15 | ⚪ Info | UI tests stub the DOM, and visual and interaction checks were manual | `test.mjs` → `bootUi` | FE-3 |

---

## Decisions needed

Questions only the owner can answer. Each one unblocks roadmap items.

1. **License.** None is set, so all rights are reserved by default. MIT? Proprietary?
2. **Deployment.** Deploy the full stack (DEP-1, and where?), host only the standalone demo (DEP-5), or neither?
3. **Stripe.** A test-mode account and keys for PAY-1. Is live mode ever in scope?
4. **Email.** Which provider (Resend or Postmark), and which sending domain, for MAIL-1?
5. **Zero-dependency rule.** Is it absolute? It blocks Playwright (FE-3), and a Postgres driver (DEP-3) needs either a dependency or an HTTP-based Postgres.
6. **Visibility.** The repo is public. The demo contains only fictional data, and all seeded emails are undeliverable. Keep it public?

---

## Verification log

Newest first. Record *what* was verified and *how*, so the next agent knows what to trust.

**2026-09-29 · Phase 4 · 366 assertions**

- Found the live demo showing **1 of 9** events upcoming, because its dates were baked in at build time. After the fix, a real browser showed 8 of 8. A seed aged 60 days, run through the embedded `rebaseSeed` in the browser's own engine, went from 0 to 8 upcoming.
- Rebase proven across the US daylight-saving change: built Oct 1, viewed Dec 1, and the jazz night is still 19:30 in New York.
- Every Phase 4 test was seen to **fail on the pre-fix code** first. The stale page gave 3 clean failures ending in "run `npm run build`"; the old seed flagged all 42 deliverable addresses.
- Ran the documented local flow on a fresh copy: `cp .env.example .env`, `npm run seed`, `npm start`. `.env` was picked up and 8 upcoming events were served.
- `RemoteStore` ran against the real API for the first time: 27 assertions, and it passed first time.
- Everything pushed to GitHub was verified byte-identical to the local tree by git blob SHA-1.
- The public share links were checked in a real browser and serve the current artifact version.

**2026-09-10 · Phase 3 · 311 assertions**

- All seven email templates rendered to a preview page and reviewed visually.
- Inbox copy checked in both modes: it promises email only when the server really delivers.

**2026-09-10 · Phase 2 · 204 assertions**

- In a browser: a paid registration held the seat *before* payment, the simulated checkout confirmed it, and the payment persisted.
- In a browser: a confirmed guest cancelled on a sold-out event, and the first waitlister got an **offer** rather than a confirmation. The meter read 11 confirmed plus 1 held, 12 taken; then claim, pay, confirmed.
- The "expire all holds" demo control released holds as expected.

**2026-09-10 · Phase 1 · 86 assertions**

- In a browser: joined the waitlist on a sold-out event, saw the ticket in My tickets, viewed the host guest list and exported CSV, published an online event, and confirmed that an empty title is rejected.

---

## Phase history

| Phase | Dates | Summary | Assertions |
|---|---|---|---|
| 1 · Core platform | 2026-09-09 → 10 | API, SQLite, events, registration, capacity and waitlists, host tools, standalone UI | 86 |
| 2 · Payments | 2026-09-10 | Stripe Checkout, seat holds, claim offers, signed idempotent webhooks, late-payment refunds | 204 |
| 3 · Email | 2026-09-10 | Transactional outbox, 7 templates, backoff and dead letters, Resend and Postmark | 311 |
| 4 · Handover | 2026-09-29 | GitHub import, 3 bugs fixed while preparing it, local setup, docs for humans and agents | 366 |

---

## Keeping this file useful

**When you finish a task:**

1. Tick it on the board and add a row to **Done**, with the date, a one-line summary, and the PR or commit.
2. If it fixes a known issue, **delete that row** from Known issues. Don't strike it through; git has the history.
3. Add an entry to the **Verification log** saying what you verified and how. An honest "suite only, not browser-checked" is fine.
4. If you found a new problem, add it to Known issues with the next free `K-` number, and a roadmap item if it needs one.
5. Update **Last updated** and the one-line summary at the top.

**Rules:** keep entries short, prefer links over prose, and never mark something verified that wasn't.

---

## Provenance

Built by Hyperagent's Developer agent (Claude Opus 5.5) in a single conversation, 2026-09-09 → 2026-09-29.
Origin thread (visible only to the owner's Hyperagent account): https://hyperagent.com/thread/cmtuzlk1w05dq07adejxi4p4k
