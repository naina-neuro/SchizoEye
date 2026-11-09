import type { Session } from '../types/session.ts';

/** PANSS cell text. The original printed the literal "null" for sessions saved without a score; that now shows "—". */
export function panssCell(s: Pick<Session, 'panss'>): string {
  return s.panss !== undefined && s.panss !== null && s.panss !== 'N/A' ? String(s.panss) : '—';
}
export const ageSex = (s: Pick<Session, 'age' | 'gender'>): string => `${s.age} / ${s.gender}`;

/** Text the search box matches against: the visible cell values of a row. */
export function sessionSearchText(s: Session): string {
  return [s.patient_id, s.name, ageSex(s), s.date, panssCell(s)].join(' ').toLowerCase();
}
export function filterSessions(sessions: Session[], query: string): Session[] {
  const q = query.trim().toLowerCase();
  return q ? sessions.filter((s) => sessionSearchText(s).includes(q)) : sessions;
}
