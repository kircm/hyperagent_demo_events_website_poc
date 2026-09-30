/**
 * ics.mjs — iCalendar generation.
 *
 * Shared: the API serves this at /api/events/:slug/ics, and confirmation
 * emails attach it so the event lands in the recipient's calendar directly.
 */

const escape = (s = '') => String(s)
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Where the event is, as a single human-readable line. */
export function locationLine(event) {
  return event.mode === 'online'
    ? (event.onlineUrl || 'Online')
    : [event.venueName, event.address, event.city].filter(Boolean).join(', ');
}

export function buildIcs(event) {
  const end = event.endsAt || new Date(new Date(event.startsAt).getTime() + 2 * 3600e3).toISOString();
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gather//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.id}@gather`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(event.startsAt)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${escape(event.title)}`,
    `DESCRIPTION:${escape(event.summary || event.description)}`,
    `LOCATION:${escape(locationLine(event))}`,
    `ORGANIZER;CN=${escape(event.host.name)}:mailto:${event.host.email || 'host@gather.example'}`,
    event.status === 'cancelled' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}
