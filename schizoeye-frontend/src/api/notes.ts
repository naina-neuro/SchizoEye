import { apiFetch } from './client.ts';

export type SaveNotesResult = { ok: true } | { ok: false; message: string };

/** POST /sessions/<id>/notes { notes, author } → { success } . Messages match the original saveNotes(). */
export async function saveNotes(sessionId: string, notes: string, author: string): Promise<SaveNotesResult> {
  try {
    const resp = await apiFetch(`/sessions/${sessionId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes, author }),
    });
    const data = await resp.json();
    if (data.success) return { ok: true };
    return { ok: false, message: '⚠ Save failed: ' + (data.error || 'Unknown error') };
  } catch (e) {
    return { ok: false, message: '⚠ Network error: ' + (e instanceof Error ? e.message : String(e)) };
  }
}
