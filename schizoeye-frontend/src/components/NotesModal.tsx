import { useEffect, useRef, useState } from 'react';
import { saveNotes } from '../api/notes.ts';
import type { Session } from '../types/session.ts';

export function NotesModal(props: { session: Session; author: string; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(props.session.notes || '');
  const [status, setStatus] = useState<{ text: string; color: string }>({ text: '', color: 'var(--dim)' });
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function save() {
    setStatus({ text: 'Saving…', color: 'var(--dim)' });
    const r = await saveNotes(props.session.id, text, props.author || 'doctor');
    if (r.ok) {
      setStatus({ text: '✓ Notes saved successfully', color: '#1A7A4A' });
      // Original behaviour: brief confirmation, then refresh the list and close.
      timer.current = window.setTimeout(() => { props.onSaved(); props.onClose(); }, 800);
    } else {
      setStatus({ text: r.message, color: '#c0392b' });
    }
  }

  return (
    <div className="modal-backdrop notes" id="notes-modal" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal-card notes">
        <div className="modal-head" style={{ marginBottom: 20, paddingBottom: 14 }}>
          <h2>{`Notes — ${props.session.name}`}</h2>
          <button className="modal-x" onClick={props.onClose} aria-label="Close">✕</button>
        </div>
        <p className="notes-help">
          Write your clinical observations, diagnoses, or follow-up instructions below. Notes are saved to the database and visible in the session report.
        </p>
        <textarea id="notes-textarea" className="notes-area" rows={10} value={text} placeholder="Enter clinical notes here…"
          onChange={(e) => setText(e.target.value)} />
        <div className="notes-foot">
          <span id="notes-save-status" style={{ fontSize: 13, color: status.color }}>{status.text}</span>
          <div className="btns">
            <button className="dash-btn" onClick={props.onClose}>Cancel</button>
            <button className="dash-btn primary" onClick={() => void save()}>💾 Save Notes</button>
          </div>
        </div>
      </div>
    </div>
  );
}
