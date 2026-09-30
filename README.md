# Gather

**Publish events. Let people register, pay, and get emailed.**
A working proof of concept, built end to end with [Hyperagent](https://hyperagent.com).

**[Try the live demo →](https://hyperagent.com/s/ArlGbonOo2rZqj2u9r4W_Q)** &nbsp;·&nbsp; [See every email it sends](https://hyperagent.com/s/RtAR0vqJSqxk56FYuKH5Mw)

> [!IMPORTANT]
> **This is a proof of concept, not a product.** It exists to show how far an AI agent can take a one-paragraph request: to a working, tested application with a real back end. Payments and email are verified against faithful stubs, not live accounts. Sign-in is deliberately minimal, and there are known security gaps to close before this faces the internet. [STATUS.md](STATUS.md) lists all of them plainly.

---

## What it does

Gather is a small events platform, roughly a stripped-down Luma or Eventbrite.

**Hosts** publish events, in person or online. They set capacity and a ticket price, watch registrations arrive, export the guest list as CSV, and cancel if they have to.

**Attendees** browse, search and filter. They register for themselves and up to nine guests, join a waitlist when an event is full, add it to their calendar, and cancel.

**Paid tickets** go through Stripe Checkout. Seats are held while people pay, so a room is never oversold, and nobody is ever charged for a waitlist place.

**Email** confirms registrations with a calendar invite attached. It offers freed-up seats with a deadline, explains refunds, and tells everyone when an event is cancelled.

## Try it

| | What you get | How |
|---|---|---|
| **Live demo** | The full UI, in your browser | [Open it](https://hyperagent.com/s/ArlGbonOo2rZqj2u9r4W_Q). Nothing to install |
| **Standalone file** | The same, offline | Open [`public/index.html`](public/index.html) in a browser |
| **Full stack** | Real API and SQLite database, with optional Stripe and email | Below |

The demo and the standalone file keep everything in your browser. Paid checkout there is a clearly labelled simulation, because there's no server to hold a Stripe key. The footer always tells you which mode you're in.

### Run the full stack locally

You need **Node.js 22.13 or newer**. There is **nothing to install**: the project has zero dependencies.

```bash
git clone https://github.com/kircm/hyperagent_demo_events_website_poc.git
cd hyperagent_demo_events_website_poc
cp .env.example .env   # optional: every setting has a safe default
npm run seed           # sample events, hosts and guests
npm start              # → http://localhost:8787
```

```bash
npm test               # 366 assertions against a live server, in about 2 seconds
```

There are no passwords: sign in with any email. To land straight in the host tools, use a seeded host such as **`lena@kilnandco.example`**. Every seeded address uses a reserved domain that can never receive mail, so nothing you do in the demo can email a real person.

To take real test-mode payments or send real email, see [AGENTS.md → Running locally](AGENTS.md#2-running-locally).

---

## How it was built

This repository was produced by Hyperagent's **Developer agent** in a single conversation: code, tests, sample data, cover images and these docs. It started from this request:

> *Can you create a website where users can publish events and other users can register to those events? Make all the assumptions required to have a functional website. Apply judgement in terms of functionality and look-and-feel. It should just look modern and work. We probably need a back-end. Is that possible?*

It went in phases. Each one was planned, built, tested, and then checked by driving a real browser.

| Phase | What landed | Assertions |
|---|---|---|
| **1 · Core platform** | API, SQLite storage, events, registration, capacity and waitlists, host tools | 86 |
| **2 · Payments** | Stripe Checkout with seat holds, claim offers, signed webhooks and automatic refunds | 204 |
| **3 · Email** | A transactional outbox, seven templates, retries with backoff, Resend and Postmark | 311 |
| **4 · Handover** | This repo, three bugs found and fixed while preparing it, docs for humans and agents | 366 |

A few of the agent's choices are worth knowing about up front:

- **Zero dependencies.** npm packages couldn't be installed where it was built, so it used Node's standard library. That turned out to be a feature: clone it and it runs.
- **One file owns all SQL.** Moving from SQLite to Postgres is a one-file job.
- **Payments are designed around a gap:** the minutes between *clicked register* and *money arrived*. That gap is where event platforms oversell.

[AGENTS.md](AGENTS.md) walks through every design decision and the reasoning behind it.

---

## For AI agents

Read **[AGENTS.md](AGENTS.md)** first. It covers the architecture, the ground rules that must not break, how to run and test the project, and recipes for common changes. Then read **[STATUS.md](STATUS.md)** to see what's in flight and what's known to be broken, and update it when you finish something.

## Documentation

| File | For | What's in it |
|---|---|---|
| [README.md](README.md) | Everyone | This overview |
| [AGENTS.md](AGENTS.md) | Agents and engineers | Architecture, design decisions, API, testing, running locally, conventions |
| [STATUS.md](STATUS.md) | Whoever works on it next | Current state, task board, known issues, verification log |
| [ROADMAP.md](ROADMAP.md) | Whoever decides what's next | Enhancements and ideas, prioritised, with the reasoning |

## Tech at a glance

| | |
|---|---|
| **Server** | Node.js `node:http`, no framework |
| **Database** | SQLite through the built-in `node:sqlite`. One module, `server/db.mjs`, owns every query |
| **Front end** | Vanilla JavaScript in one self-contained HTML file, with hash routing |
| **Payments** | Stripe Checkout over plain `fetch`, with webhook signatures verified by `node:crypto` |
| **Email** | Resend or Postmark over plain `fetch`, behind a transactional outbox |
| **Tests** | End-to-end against a real server with stubbed Stripe and email. No test framework |
| **Dependencies** | None |

## License

No license has been chosen yet, which means the author reserves all rights by default. See [STATUS.md → Decisions needed](STATUS.md#decisions-needed).
