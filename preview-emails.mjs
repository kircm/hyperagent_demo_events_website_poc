/**
 * preview-emails.mjs — render every template to a single browsable page.
 *
 *   node --no-warnings preview-emails.mjs
 *   → public/email-preview.html
 *
 * Designing email without a preview loop means sending yourself dozens of
 * test messages. This renders all seven against realistic data, in iframes so
 * each one gets its own document exactly as a mail client would give it.
 */

import { writeFile } from 'node:fs/promises';
import { renderEmail, EMAIL_TYPES } from './server/templates.mjs';
import { buildSeed } from './server/seed-data.mjs';

const { events } = buildSeed();
const src = events.find((e) => e.key === 'jazz');

// Shaped like the API's event payload, without needing a database.
const event = {
  ...src,
  id: 'evt_preview',
  slug: 'rooftop-sessions-jazz-small-plates',
  status: 'published',
  host: { id: 'u_host', name: 'Maya Okonkwo', email: 'maya@rooftopsessions.co' },
};
const user = { id: 'u_you', name: 'Sam Reader', email: 'you@example.com' };

const NOTES = {
  registration_confirmed: 'Sent on a confirmed registration. Carries the receipt when the event is paid, and always attaches the calendar invite.',
  registration_waitlisted: 'Sent when the event is full. States plainly that no money was taken.',
  waitlist_offer: 'The only message with a deadline attached — if it is slow, the seat lapses. Its retry backoff starts at 30 seconds for that reason.',
  hold_expired: 'Sent when a checkout hold or a claim offer runs out. Silence here is the worst outcome: people assume they have a seat.',
  payment_refunded: 'Sent when a payment landed after the last seat had gone. Money moved, so this one is never optional.',
  registration_cancelled: 'Acknowledges a cancellation the attendee made themselves.',
  event_cancelled: 'Fanned out to everyone still holding a place, including waitlisters, when a host cancels.',
};

const payloads = {
  registration_confirmed: { guests: 2, amountCents: 7000, currency: 'usd', paid: true },
  registration_waitlisted: { guests: 2 },
  waitlist_offer: {
    guests: 2, amountCents: 7000, currency: 'usd',
    claimBy: new Date(Date.now() + 21 * 3600e3).toISOString(),
  },
  hold_expired: { guests: 2, wasOffer: false, amountCents: 7000, currency: 'usd' },
  payment_refunded: { guests: 2, amountCents: 7000, currency: 'usd', reason: 'seat_gone' },
  registration_cancelled: { guests: 2, wasPaid: true, amountCents: 7000, currency: 'usd' },
  event_cancelled: { guests: 2, wasPaid: true, amountCents: 7000, currency: 'usd', hadStatus: 'confirmed' },
};

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const cards = EMAIL_TYPES.map((type) => {
  const out = renderEmail(type, {
    event, registration: null, user, payload: payloads[type], baseUrl: 'https://gather.example',
  });
  return `
  <section class="card">
    <header>
      <div class="meta">
        <code>${esc(type)}</code>
        ${out.attachments.length ? `<span class="att">📎 ${esc(out.attachments.map((a) => a.filename).join(', '))}</span>` : ''}
      </div>
      <h2>${esc(out.subject)}</h2>
      <p class="note">${esc(NOTES[type] || '')}</p>
    </header>
    <div class="frame">
      <iframe title="${esc(type)}" srcdoc="${esc(out.html)}" loading="lazy"></iframe>
    </div>
    <details>
      <summary>Plain text part</summary>
      <pre>${esc(out.text)}</pre>
    </details>
  </section>`;
}).join('\n');

const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gather — transactional email preview</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:#f4f5f7;color:#0e1013;
  font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  -webkit-font-smoothing:antialiased;font-size:15px;line-height:1.55}
.wrap{max-width:1200px;margin:0 auto;padding:0 clamp(18px,4vw,40px)}
header.top{padding:56px 0 32px}
.brand{display:flex;align-items:center;gap:9px;font-weight:800;letter-spacing:-.03em;font-size:19px}
.dot{width:11px;height:11px;border-radius:50%;background:#5b3df5;box-shadow:0 0 0 3.5px #efecfe}
h1{margin:22px 0 0;font-size:clamp(28px,4.4vw,40px);letter-spacing:-.035em;font-weight:800;max-width:20ch}
.lede{margin-top:14px;color:#6c7480;font-size:17px;max-width:62ch}
.legend{margin-top:22px;display:flex;gap:8px;flex-wrap:wrap}
.pill{background:#fff;border:1px solid #e6e8ec;border-radius:40px;padding:6px 13px;font-size:12.5px;font-weight:600;color:#3b414b}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:26px;padding:14px 0 80px}
.card{background:#fff;border:1px solid #e6e8ec;border-radius:18px;overflow:hidden;display:flex;flex-direction:column}
.card header{padding:20px 22px 16px;border-bottom:1px solid #f1f2f5}
.meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:11px}
.meta code{background:#efecfe;color:#4526e0;font-size:11.5px;font-weight:700;padding:4px 9px;border-radius:40px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.att{font-size:11.5px;color:#6c7480;font-weight:600}
.card h2{margin:0;font-size:17px;letter-spacing:-.024em;line-height:1.3}
.note{margin:10px 0 0;font-size:13px;color:#6c7480;line-height:1.5}
.frame{background:#f4f5f7;padding:0}
iframe{width:100%;height:560px;border:0;display:block;background:#f4f5f7}
details{border-top:1px solid #f1f2f5}
summary{padding:13px 22px;font-size:13px;font-weight:600;color:#3b414b;cursor:pointer}
summary:hover{background:#fafafb}
pre{margin:0;padding:0 22px 20px;font-size:12px;line-height:1.6;color:#3b414b;white-space:pre-wrap;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
footer{border-top:1px solid #e6e8ec;padding:26px 0 48px;color:#9aa2ad;font-size:12.5px;background:#fff}
@media(max-width:520px){.grid{grid-template-columns:1fr}iframe{height:600px}}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="brand"><span class="dot"></span><span>Gather</span></div>
    <h1>Every message the platform sends.</h1>
    <p class="lede">Rendered from the real templates against real seed data — no messages were sent to produce this page.
    Both parts of each message are here: the HTML a mail client shows, and the plain text part underneath it.</p>
    <div class="legend">
      <span class="pill">${EMAIL_TYPES.length} templates</span>
      <span class="pill">HTML + plain text</span>
      <span class="pill">Calendar invite attached on confirmations</span>
      <span class="pill">No web fonts, table skeleton — survives Outlook</span>
    </div>
  </header>
  <div class="grid">
${cards}
  </div>
</div>
<footer><div class="wrap">Generated by preview-emails.mjs. Regenerate after editing server/templates.mjs.</div></footer>
</body>
</html>`;

await writeFile(new URL('./public/email-preview.html', import.meta.url), page);
console.log(`[preview] public/email-preview.html  ${Math.round(Buffer.byteLength(page) / 1024)} KB · ${EMAIL_TYPES.length} templates`);
