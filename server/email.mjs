/**
 * email.mjs — transactional email transports, no dependencies.
 *
 * Four transports behind one `send()`:
 *   resend    — api.resend.com
 *   postmark  — api.postmarkapp.com
 *   console   — prints the message (the default, and what you want in dev)
 *   capture   — collects messages in memory (what the test suite asserts on)
 *
 * Adding a provider is one function and one line in the switch.
 *
 * Configuration:
 *   EMAIL_PROVIDER   resend | postmark | console | capture
 *                    (defaults to resend when EMAIL_API_KEY is set, else console)
 *   EMAIL_API_KEY    provider credential
 *   EMAIL_FROM       "Gather <hello@yourdomain.com>"
 *   EMAIL_REPLY_TO   optional
 *   EMAIL_API_BASE   override the provider host (tests)
 *
 * Errors carry `retryable`. A 5xx or a rate limit is worth trying again; a
 * rejected address or a bad key never will be, and the outbox dead-letters
 * those immediately instead of burning six attempts on them.
 */

export class EmailError extends Error {
  constructor(message, { status = 502, code = 'email_error', retryable = true } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export const transportName = () => String(
  process.env.EMAIL_PROVIDER || (process.env.EMAIL_API_KEY ? 'resend' : 'console'),
).toLowerCase();

/** True when messages actually leave the building. */
export const emailDelivers = () => {
  const t = transportName();
  if (t === 'resend' || t === 'postmark') return Boolean(process.env.EMAIL_API_KEY);
  return t === 'capture';
};

export const emailFrom = () => process.env.EMAIL_FROM || 'Gather <no-reply@gather.example>';

export function emailStatus() {
  return {
    provider: transportName(),
    delivers: emailDelivers(),
    from: emailFrom(),
  };
}

/* ------------------------------------------------------------------ capture */

const captured = [];
export const capturedEmails = () => captured;
export const clearCapturedEmails = () => { captured.length = 0; };

/* ------------------------------------------------------------------ helpers */

/** "Gather <a@b.com>" -> "a@b.com" */
function bareAddress(value) {
  const m = /<([^>]+)>/.exec(String(value || ''));
  return (m ? m[1] : String(value || '')).trim();
}

function classify(status) {
  // 408/409/429 and every 5xx are worth another go. Other 4xx are our fault
  // (bad address, bad payload, bad key) and will fail identically forever.
  const retryable = status >= 500 || [408, 409, 429].includes(status);
  return { retryable, code: retryable ? 'email_transient' : 'email_rejected' };
}

async function postJson(url, headers, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new EmailError(`Could not reach the email provider: ${err.message}`, {
      code: 'email_unreachable', retryable: true,
    });
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* provider returned prose */ }
  if (!res.ok) {
    const { retryable, code } = classify(res.status);
    const message = json?.message || json?.Message || json?.error?.message || text.slice(0, 300)
      || `Provider returned ${res.status}`;
    throw new EmailError(message, { status: res.status, code, retryable });
  }
  return json ?? {};
}

/* ---------------------------------------------------------------- providers */

async function sendViaResend(message) {
  const base = process.env.EMAIL_API_BASE || 'https://api.resend.com';
  const body = {
    from: emailFrom(),
    to: [message.to],
    subject: message.subject,
    html: message.html,
    text: message.text,
  };
  if (process.env.EMAIL_REPLY_TO) body.reply_to = process.env.EMAIL_REPLY_TO;
  if (message.attachments?.length) {
    body.attachments = message.attachments.map((a) => ({
      filename: a.filename,
      content: a.content, // base64
      content_type: a.contentType,
    }));
  }
  const out = await postJson(`${base}/emails`, {
    authorization: `Bearer ${process.env.EMAIL_API_KEY}`,
  }, body);
  return { providerId: out.id || null };
}

async function sendViaPostmark(message) {
  const base = process.env.EMAIL_API_BASE || 'https://api.postmarkapp.com';
  const body = {
    From: emailFrom(),
    To: bareAddress(message.to),
    Subject: message.subject,
    HtmlBody: message.html,
    TextBody: message.text,
    MessageStream: process.env.EMAIL_STREAM || 'outbound',
  };
  if (process.env.EMAIL_REPLY_TO) body.ReplyTo = process.env.EMAIL_REPLY_TO;
  if (message.attachments?.length) {
    body.Attachments = message.attachments.map((a) => ({
      Name: a.filename,
      Content: a.content,
      ContentType: a.contentType,
    }));
  }
  const out = await postJson(`${base}/email`, {
    'x-postmark-server-token': process.env.EMAIL_API_KEY,
    accept: 'application/json',
  }, body);
  // Postmark can report failure inside a 200.
  if (out.ErrorCode && out.ErrorCode !== 0) {
    const retryable = out.ErrorCode === 429;
    throw new EmailError(out.Message || `Postmark error ${out.ErrorCode}`, {
      code: `postmark_${out.ErrorCode}`, retryable,
    });
  }
  return { providerId: out.MessageID || null };
}

/* --------------------------------------------------------------------- send */

/**
 * message: { to, subject, html, text, attachments? }
 * Returns { providerId, transport }.
 */
export async function send(message) {
  if (!message?.to) throw new EmailError('No recipient.', { code: 'email_no_recipient', retryable: false });

  const transport = transportName();
  switch (transport) {
    case 'resend': {
      if (!process.env.EMAIL_API_KEY) {
        throw new EmailError('EMAIL_API_KEY is not set.', { code: 'email_not_configured', retryable: false });
      }
      return { ...(await sendViaResend(message)), transport };
    }
    case 'postmark': {
      if (!process.env.EMAIL_API_KEY) {
        throw new EmailError('EMAIL_API_KEY is not set.', { code: 'email_not_configured', retryable: false });
      }
      return { ...(await sendViaPostmark(message)), transport };
    }
    case 'capture': {
      captured.push({ ...message, sentAt: new Date().toISOString() });
      return { providerId: `captured_${captured.length}`, transport };
    }
    case 'console':
    default: {
      const lines = [
        '', '─'.repeat(64),
        `To:      ${message.to}`,
        `From:    ${emailFrom()}`,
        `Subject: ${message.subject}`,
        message.attachments?.length ? `Attached: ${message.attachments.map((a) => a.filename).join(', ')}` : null,
        '─'.repeat(64),
        message.text,
        '─'.repeat(64), '',
      ].filter((l) => l !== null);
      console.log(lines.join('\n'));
      return { providerId: null, transport: 'console' };
    }
  }
}
