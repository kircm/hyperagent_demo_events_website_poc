/**
 * templates.mjs — the message bodies.
 *
 * Every template returns { subject, html, text, attachments }. Both formats
 * are always produced: plenty of people read mail as plain text, and a
 * text/plain part materially helps deliverability.
 *
 * Deliberately no web fonts, no external CSS, no <style> block — inline
 * attributes on a table skeleton, because that is what survives Outlook,
 * Gmail's clipping and Apple Mail alike.
 */

import { formatMoney } from './stripe.mjs';
import { buildIcs, locationLine } from './ics.mjs';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ------------------------------------------------------------ formatting */

function inZone(iso, tz, opts) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, ...opts }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', opts).format(new Date(iso));
  }
}

function tzAbbr(event) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: event.timezone, timeZoneName: 'short' })
      .formatToParts(new Date(event.startsAt));
    return parts.find((p) => p.type === 'timeZoneName')?.value || '';
  } catch { return ''; }
}

/** "Tuesday, September 15 · 7:30 – 10:30 PM EDT" */
function whenLine(event) {
  const day = inZone(event.startsAt, event.timezone, { weekday: 'long', month: 'long', day: 'numeric' });
  const t = (iso) => inZone(iso, event.timezone, { hour: 'numeric', minute: '2-digit' });
  const range = event.endsAt ? `${t(event.startsAt)} – ${t(event.endsAt)}` : t(event.startsAt);
  const abbr = tzAbbr(event);
  return `${day} · ${range}${abbr ? ` ${abbr}` : ''}`;
}

/** "in 22 hours" — deadlines are the whole point of the offer email. */
function untilLine(iso, event) {
  if (!iso) return '';
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  const clock = inZone(iso, event.timezone, {
    weekday: 'short', hour: 'numeric', minute: '2-digit',
  });
  const abbr = tzAbbr(event);
  const rel = mins <= 0 ? 'now'
    : mins < 60 ? `in ${mins} minute${mins === 1 ? '' : 's'}`
      : mins < 2880 ? `in ${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? '' : 's'}`
        : `in ${Math.round(mins / 1440)} days`;
  return `${clock}${abbr ? ` ${abbr}` : ''} (${rel})`;
}

const party = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;

/* ---------------------------------------------------------------- layout */

function layout({ headline, lead, facts = [], cta, ctaUrl, after = [], accent = '#5b3df5' }) {
  const factRows = facts.filter(Boolean).map(([label, value]) => `
    <tr>
      <td style="padding:7px 0;color:#6c7480;font-size:13px;width:120px;vertical-align:top">${esc(label)}</td>
      <td style="padding:7px 0;color:#0e1013;font-size:14px;font-weight:600;vertical-align:top">${esc(value)}</td>
    </tr>`).join('');

  const afterHtml = after.filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px;color:#3b414b;font-size:15px;line-height:1.6">${p}</p>`)
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(headline)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;-webkit-font-smoothing:antialiased">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:28px 14px">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;border:1px solid #e6e8ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
      <tr><td style="padding:26px 30px 0">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${accent};vertical-align:middle"></span>
        <span style="font-size:17px;font-weight:800;letter-spacing:-0.03em;color:#0e1013;vertical-align:middle;margin-left:7px">Gather</span>
      </td></tr>
      <tr><td style="padding:22px 30px 0">
        <h1 style="margin:0;font-size:23px;line-height:1.25;letter-spacing:-0.028em;color:#0e1013;font-weight:700">${esc(headline)}</h1>
        <p style="margin:13px 0 0;color:#3b414b;font-size:15px;line-height:1.6">${lead}</p>
      </td></tr>
      ${factRows ? `<tr><td style="padding:22px 30px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafb;border:1px solid #f1f2f5;border-radius:12px;padding:6px 16px">
          ${factRows}
        </table>
      </td></tr>` : ''}
      ${cta && ctaUrl ? `<tr><td style="padding:24px 30px 0">
        <a href="${esc(ctaUrl)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:13px 22px;border-radius:10px">${esc(cta)}</a>
      </td></tr>` : ''}
      ${afterHtml ? `<tr><td style="padding:24px 30px 0">${afterHtml}</td></tr>` : ''}
      <tr><td style="padding:26px 30px 28px">
        <div style="border-top:1px solid #f1f2f5;padding-top:16px;color:#9aa2ad;font-size:12px;line-height:1.55">
          You're receiving this because you registered through Gather.
          This is a transactional message about a specific event, not a newsletter.
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function plain({ headline, lead, facts = [], cta, ctaUrl, after = [] }) {
  const strip = (s) => String(s).replace(/<[^>]+>/g, '');
  return [
    headline,
    '='.repeat(Math.min(headline.length, 60)),
    '',
    strip(lead),
    '',
    ...facts.filter(Boolean).map(([label, value]) => `${label}: ${value}`),
    ...(cta && ctaUrl ? ['', `${cta}: ${ctaUrl}`] : []),
    ...(after.length ? ['', ...after.map(strip)] : []),
    '',
    '--',
    "You're receiving this because you registered through Gather.",
  ].join('\n');
}

const icsAttachment = (event) => [{
  filename: `${event.slug}.ics`,
  content: Buffer.from(buildIcs(event), 'utf8').toString('base64'),
  contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
}];

/* ------------------------------------------------------------- templates */

/**
 * type: the outbox row type
 * event / registration / user: current records
 * payload: the snapshot taken when the intent was queued
 */
export function renderEmail(type, { event, registration, user, payload = {}, baseUrl = '' }) {
  const eventUrl = `${baseUrl}/#/e/${event.slug}`;
  const ticketsUrl = `${baseUrl}/#/tickets`;
  const guests = payload.guests ?? registration?.guests ?? 1;
  const amount = payload.amountCents
    ? formatMoney(payload.amountCents, payload.currency || event.currency) : null;
  const firstName = String(user.name || '').trim().split(/\s+/)[0] || 'there';

  const baseFacts = [
    ['Event', event.title],
    ['When', whenLine(event)],
    [event.mode === 'online' ? 'Joining' : 'Where', locationLine(event) || 'To be announced'],
    guests > 1 ? ['Party', party(guests)] : null,
  ];

  const build = (spec) => ({
    subject: spec.subject,
    html: layout(spec),
    text: plain(spec),
    attachments: spec.attachments || [],
  });

  switch (type) {
    case 'registration_confirmed':
      return build({
        subject: `You're going: ${event.title}`,
        headline: payload.promoted ? "A spot opened up — you're in" : "You're going",
        lead: payload.promoted
          ? `Good news, ${esc(firstName)}. A place freed up on <strong>${esc(event.title)}</strong> and it's yours — you're confirmed, no action needed.`
          : `You're confirmed for <strong>${esc(event.title)}</strong>, ${esc(firstName)}. The calendar invite is attached.`,
        facts: [...baseFacts, amount ? ['Paid', amount] : ['Cost', 'Free']],
        cta: 'View event details',
        ctaUrl: eventUrl,
        after: [
          event.mode === 'online' && event.onlineUrl
            ? `The join link is <a href="${esc(event.onlineUrl)}" style="color:#4526e0">${esc(event.onlineUrl)}</a> — it's in the attached invite too.`
            : null,
          `Can't make it after all? Cancel from <a href="${esc(ticketsUrl)}" style="color:#4526e0">your tickets</a> and the seat goes to whoever is next on the waitlist.`,
        ],
        attachments: icsAttachment(event),
      });

    case 'registration_waitlisted':
      return build({
        subject: `You're on the waitlist for ${event.title}`,
        headline: "You're on the waitlist",
        lead: `<strong>${esc(event.title)}</strong> is full, ${esc(firstName)}, so you're in the queue. You have not been charged${event.priceCents > 0 ? ' — a waitlist place is always free' : ''}.`,
        facts: baseFacts,
        cta: 'View event',
        ctaUrl: eventUrl,
        after: [
          `If someone cancels we'll email you${event.priceCents > 0
            ? ` with a link to claim the seat. You'll have a limited window to pay before it passes to the next person.`
            : ` and you'll be confirmed automatically.`}`,
          'Places do come free — cancellations are common in the last week.',
        ],
        accent: '#b3480a',
      });

    case 'waitlist_offer':
      return build({
        subject: `A spot opened up for ${event.title} — claim it by ${untilLine(payload.claimBy, event)}`,
        headline: 'A spot opened up',
        lead: `Someone cancelled, ${esc(firstName)}, and you're next in line for <strong>${esc(event.title)}</strong>. The seat is held for you — claim it before the deadline and it's yours.`,
        facts: [
          ...baseFacts,
          amount ? ['To pay', amount] : null,
          ['Claim by', untilLine(payload.claimBy, event)],
        ],
        cta: amount ? `Claim my seat — ${amount}` : 'Claim my seat',
        ctaUrl: eventUrl,
        after: [
          `Nobody is charged to sit on a waitlist. Payment happens now, only if you want the place.`,
          `If the deadline passes we'll offer it to the next person, so don't sit on this one.`,
        ],
      });

    case 'hold_expired':
      return build({
        subject: payload.wasOffer
          ? `Your seat offer for ${event.title} has expired`
          : `Your held seats for ${event.title} were released`,
        headline: payload.wasOffer ? 'That offer has expired' : 'Your hold was released',
        lead: payload.wasOffer
          ? `The seat we were holding for <strong>${esc(event.title)}</strong> wasn't claimed in time, so it has gone to the next person on the waitlist. You were not charged.`
          : `We held ${esc(party(guests))} for <strong>${esc(event.title)}</strong> while you paid, but the payment wasn't completed in time, so the seats were released. You were not charged.`,
        facts: baseFacts,
        cta: 'Check availability',
        ctaUrl: eventUrl,
        after: ['If it still has room you can register again. If it is full, you can rejoin the waitlist.'],
        accent: '#6c7480',
      });

    case 'payment_refunded':
      return build({
        subject: `Refunded: ${event.title}`,
        headline: 'Your payment has been refunded',
        lead: payload.reason === 'event_closed'
          ? `Your payment for <strong>${esc(event.title)}</strong> arrived after the event closed, so we've refunded it in full.`
          : `Your payment for <strong>${esc(event.title)}</strong> arrived just after the last seat went. We would rather refund you than oversell the room, so the full amount is on its way back.`,
        facts: [...baseFacts, amount ? ['Refunded', amount] : null],
        cta: 'See other events',
        ctaUrl: `${baseUrl}/#/`,
        after: [
          'Refunds usually land back on your card within 5–10 business days, depending on your bank.',
          'Sorry — this one is on us, not you.',
        ],
        accent: '#a52222',
      });

    case 'registration_cancelled':
      return build({
        subject: `Registration cancelled: ${event.title}`,
        headline: 'Your registration is cancelled',
        lead: `You're no longer registered for <strong>${esc(event.title)}</strong>. Your place has been offered to whoever was next on the waitlist.`,
        facts: baseFacts,
        cta: 'Browse other events',
        ctaUrl: `${baseUrl}/#/`,
        after: [
          payload.wasPaid
            ? 'You paid for this place. Refunds for a change of heart are at the host\'s discretion — reply to this email and we\'ll pass it on.'
            : null,
          'Changed your mind again? You can register once more if there is still room.',
        ],
        accent: '#6c7480',
      });

    case 'event_cancelled':
      return build({
        subject: `Cancelled: ${event.title}`,
        headline: 'This event has been cancelled',
        lead: `${esc(event.host.name)} has cancelled <strong>${esc(event.title)}</strong>. Sorry — we know that's annoying, especially at short notice.`,
        facts: [
          ['Event', event.title],
          ['Was due', whenLine(event)],
          payload.hadStatus === 'waitlisted' ? ['Your place', 'On the waitlist'] : null,
        ],
        cta: 'Find something else',
        ctaUrl: `${baseUrl}/#/`,
        after: [
          payload.wasPaid && amount
            ? `You paid ${esc(amount)}. The host has been asked to refund it — if you don't see it within a few days, reply to this email.`
            : null,
          payload.hadStatus === 'pending' || payload.hadStatus === 'offered'
            ? 'You had a seat held but had not completed payment, so nothing was charged.'
            : null,
        ],
        accent: '#a52222',
      });

    default:
      throw new Error(`No email template for type "${type}"`);
  }
}

export const EMAIL_TYPES = [
  'registration_confirmed', 'registration_waitlisted', 'waitlist_offer',
  'hold_expired', 'payment_refunded', 'registration_cancelled', 'event_cancelled',
];
