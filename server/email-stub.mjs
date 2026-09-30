/**
 * email-stub.mjs — a fake email provider, for tests and offline development.
 *
 * Speaks both Resend (`POST /emails`) and Postmark (`POST /email`), records
 * every request, and can be told to fail on demand so the retry, backoff and
 * dead-letter paths are exercised for real rather than assumed.
 *
 *   EMAIL_PROVIDER=resend EMAIL_API_BASE=http://127.0.0.1:PORT
 */

import { createServer } from 'node:http';

export async function startEmailStub() {
  const requests = [];
  const messages = [];
  let counter = 0;
  /** { count, status } — the next `count` requests fail with `status`. */
  let failure = null;

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = JSON.parse(raw); } catch { /* malformed */ }

    const url = new URL(req.url, 'http://stub');
    const record = {
      method: req.method,
      path: url.pathname,
      authorization: req.headers.authorization || null,
      postmarkToken: req.headers['x-postmark-server-token'] || null,
      contentType: req.headers['content-type'] || null,
      body,
    };
    requests.push(record);

    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (failure && failure.count > 0) {
      failure.count -= 1;
      return json(failure.status, {
        message: `Simulated provider failure (${failure.status}).`,
        name: 'stub_forced_failure',
      });
    }

    // Resend
    if (req.method === 'POST' && url.pathname === '/emails') {
      if (!/^Bearer\s+\S+/.test(record.authorization || '')) {
        return json(401, { message: 'Missing API key.', name: 'validation_error' });
      }
      const id = `re_stub_${++counter}`;
      messages.push({
        provider: 'resend', id,
        to: Array.isArray(body?.to) ? body.to[0] : body?.to,
        from: body?.from,
        subject: body?.subject,
        html: body?.html || '',
        text: body?.text || '',
        attachments: body?.attachments || [],
      });
      return json(200, { id });
    }

    // Postmark
    if (req.method === 'POST' && url.pathname === '/email') {
      if (!record.postmarkToken) {
        return json(401, { ErrorCode: 10, Message: 'Missing server token.' });
      }
      const id = `pm_stub_${++counter}`;
      messages.push({
        provider: 'postmark', id,
        to: body?.To, from: body?.From, subject: body?.Subject,
        html: body?.HtmlBody || '', text: body?.TextBody || '',
        attachments: body?.Attachments || [],
      });
      return json(200, { MessageID: id, ErrorCode: 0, Message: 'OK' });
    }

    return json(404, { message: `Stub has no route for ${req.method} ${url.pathname}` });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        messages,
        /** Messages sent to one address, oldest first. */
        to: (address) => messages.filter((m) => String(m.to || '').includes(address)),
        /** The most recent message whose subject matches. */
        bySubject: (pattern) => messages.filter((m) => new RegExp(pattern, 'i').test(m.subject || '')),
        failNext: (count, status = 503) => { failure = { count, status }; },
        clearFailures: () => { failure = null; },
        reset: () => { requests.length = 0; messages.length = 0; failure = null; },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
