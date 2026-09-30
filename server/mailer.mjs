/**
 * mailer.mjs — the outbox worker.
 *
 * Reads intent rows the state machine queued, renders them against the CURRENT
 * event and recipient, hands them to a transport, and records what happened.
 *
 * Nothing here is on a request path. A provider outage shows up as queued rows
 * and retries, not as failed registrations.
 */

import { renderEmail } from './templates.mjs';
import * as email from './email.mjs';

export function createMailer(db, { baseUrl = '', batchSize = 25, log = console } = {}) {
  /** Send one batch of due messages. */
  async function drainOnce() {
    const batch = db.claimDueEmails(batchSize);
    const result = { claimed: batch.length, sent: 0, retrying: 0, dead: 0 };

    for (const row of batch) {
      try {
        const event = row.event_id ? db.getEventById(row.event_id) : null;
        const user = db.getUserById(row.user_id);
        if (!event || !user) {
          // Nothing to say, or nobody to say it to. Retrying won't help.
          db.markEmailFailed(row.id, new Error('event or recipient no longer exists'), { permanent: true });
          result.dead++;
          continue;
        }
        const registration = row.registration_id ? db.getRegistrationById(row.registration_id) : null;

        const message = renderEmail(row.type, {
          event, registration, user, payload: row.payload || {}, baseUrl,
        });
        const out = await email.send({ to: user.email, ...message });
        db.markEmailSent(row.id, { providerId: out.providerId, subject: message.subject });
        result.sent++;
      } catch (err) {
        // A rejected address or an unknown template will fail identically
        // forever, so those go straight to the dead letter state.
        const permanent = err?.retryable === false || /No email template/.test(err?.message || '');
        const outcome = db.markEmailFailed(row.id, err, { permanent });
        if (outcome.status === 'dead') {
          result.dead++;
          log.error?.(`[mailer] giving up on ${row.type} → ${row.to_email}: ${err.message}`);
        } else {
          result.retrying++;
          log.warn?.(`[mailer] ${row.type} → ${row.to_email} failed (attempt ${row.attempts}), retrying in ${outcome.retryInSeconds}s: ${err.message}`);
        }
      }
    }
    return result;
  }

  /** Keep draining until the queue is empty, or the batch budget runs out. */
  async function drain({ maxBatches = 20 } = {}) {
    const total = { claimed: 0, sent: 0, retrying: 0, dead: 0, batches: 0 };
    for (let i = 0; i < maxBatches; i++) {
      const out = await drainOnce();
      total.claimed += out.claimed;
      total.sent += out.sent;
      total.retrying += out.retrying;
      total.dead += out.dead;
      total.batches++;
      if (out.claimed < batchSize) break;
    }
    return total;
  }

  let timer = null;
  let running = false;

  function start(intervalMs = 15_000) {
    if (timer) return;
    timer = setInterval(async () => {
      // Never let two drains overlap — claimDueEmails would hand the same
      // rows out twice if the first pass is still awaiting the provider.
      if (running) return;
      running = true;
      try {
        const out = await drain({ maxBatches: 4 });
        if (out.sent || out.dead) {
          log.log?.(`[mailer] sent ${out.sent}, retrying ${out.retrying}, dead ${out.dead}`);
        }
      } catch (err) {
        log.error?.('[mailer] drain failed:', err.message);
      } finally {
        running = false;
      }
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { drainOnce, drain, start, stop };
}
