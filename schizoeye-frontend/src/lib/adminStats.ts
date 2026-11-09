import type { Session } from '../types/session.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "25 Oct 2026" — the date format Flask puts in Session.date (strftime('%d %b %Y, %H:%M')), computed in UTC. */
export function formatServerDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Admin stat cards. The original computed these by scraping table cells and was wrong
 * ("Today" tested the Age/Sex cell for the year, "Clinicians Active" counted distinct PANSS values).
 * Now: total sessions; sessions dated today (server clock assumed UTC — Render's default); distinct note authors
 * other than "unknown" (note: until battery.html sets the author, notes_author is always "unknown").
 */
export function adminStats(sessions: Session[], now: Date = new Date()) {
  const today = formatServerDate(now);
  const todayCount = sessions.filter((s) => typeof s.date === 'string' && s.date.split(',')[0].trim() === today).length;
  const authors = new Set(sessions.map((s) => s.notes_author).filter((a) => a && a !== 'unknown'));
  return { total: sessions.length, today: todayCount, authors: authors.size };
}
