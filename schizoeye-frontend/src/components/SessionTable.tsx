import { sessionCsvUrl } from '../api/sessions.ts';
import { downloadSessionPdf } from '../lib/download.ts';
import { ageSex, panssCell } from '../lib/sessionView.ts';
import type { CsvType, Session } from '../types/session.ts';

export type SessionVariant = 'doctor' | 'admin';

interface Props {
  variant: SessionVariant;
  sessions: Session[];        // already filtered by the search box
  totalCount: number;         // before filtering (to tell "empty" from "no match")
  loading: boolean;
  error: string | null;
  onFeatures: (s: Session) => void;
  onNotes: (s: Session) => void;
  onReport: (s: Session) => void;
}

const CSV_TYPES: { type: CsvType; label: string }[] = [
  { type: 'fv', label: 'FV' },
  { type: 'spem', label: 'SPEM' },
  { type: 'sz', label: 'SZ' },
];

/** Doctor and admin tables. Same columns as the original; the doctor gets Notes, the admin gets raw-CSV links. */
export function SessionTable(props: Props) {
  const { variant, sessions } = props;
  const emptyText = props.error || (variant === 'doctor' ? 'No sessions found in database.' : 'No sessions found.');
  let body;
  if (props.loading) {
    body = <tr><td colSpan={9} className="dash-empty">Loading sessions…</td></tr>;
  } else if (props.totalCount === 0) {
    body = <tr><td colSpan={9} className="dash-empty">{emptyText}</td></tr>;
  } else if (sessions.length === 0) {
    body = <tr><td colSpan={9} className="dash-empty">No matching sessions.</td></tr>;
  } else {
    body = sessions.map((s) => (
      <tr key={s.id}>
        <td><code className="dash-pid">{s.patient_id}</code></td>
        <td><strong>{s.name}</strong></td>
        <td>{ageSex(s)}</td>
        <td>{s.date}</td>
        <td>{panssCell(s)}</td>
        <td><button className="dash-btn" onClick={() => props.onFeatures(s)}>59 Features</button></td>
        {variant === 'doctor' ? (
          <td><button className="dash-btn" onClick={() => props.onNotes(s)}>📝 Notes</button></td>
        ) : (
          <td>
            {CSV_TYPES.map((c) => (
              <button key={c.type} className="dash-btn" onClick={() => window.open(sessionCsvUrl(s.id, c.type))}>{c.label}</button>
            ))}
          </td>
        )}
        <td>{s.has_report ? <button className="dash-btn" onClick={() => props.onReport(s)}>👁 View</button> : '—'}</td>
        <td>{s.has_report ? <button className="dash-btn primary" onClick={() => downloadSessionPdf(s.id)}>⬇ PDF</button> : '—'}</td>
      </tr>
    ));
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="dash-table">
        <thead>
          <tr>
            <th>Patient ID</th><th>Patient</th><th>Age/Sex</th><th>Date</th><th>PANSS</th><th>Features</th>
            <th>{variant === 'doctor' ? 'Notes' : 'Raw CSVs'}</th><th>View Report</th><th>Download PDF</th>
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>
    </div>
  );
}
