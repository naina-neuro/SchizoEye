import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { filterSessions } from '../lib/sessionView.ts';
import type { Session } from '../types/session.ts';
import { FeatureModal } from './FeatureModal.tsx';
import { NotesModal } from './NotesModal.tsx';
import { ReportModal } from './ReportModal.tsx';
import { SessionTable } from './SessionTable.tsx';
import type { SessionVariant } from './SessionTable.tsx';

interface Props {
  variant: SessionVariant;
  sessions: Session[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  /** Used as notes author (original: the logged-in username). */
  author: string;
  toolbarExtra?: ReactNode;
}

/** "All Sessions" heading + search + table + the three modals; shared by the doctor and admin dashboards. */
export function SessionsPanel(props: Props) {
  const [query, setQuery] = useState('');
  const [featureOf, setFeatureOf] = useState<Session | null>(null);
  const [notesOf, setNotesOf] = useState<Session | null>(null);
  const [reportOf, setReportOf] = useState<Session | null>(null);
  const filtered = useMemo(() => filterSessions(props.sessions, query), [props.sessions, query]);

  return (
    <>
      <div className="dash-row">
        <h2 className="dash-h2">All Sessions</h2>
        <div className="dash-actions">
          <input id={`${props.variant}-search-input`} className="dash-search" type="text" placeholder="Search by name or patient ID..."
            value={query} onChange={(e) => setQuery(e.target.value)} />
          {props.toolbarExtra}
          <button className="dash-btn" onClick={props.onReload}>↺ Refresh</button>
        </div>
      </div>
      <SessionTable variant={props.variant} sessions={filtered} totalCount={props.sessions.length}
        loading={props.loading} error={props.error}
        onFeatures={setFeatureOf} onNotes={setNotesOf} onReport={setReportOf} />
      {featureOf && <FeatureModal session={featureOf} onClose={() => setFeatureOf(null)} />}
      {notesOf && <NotesModal session={notesOf} author={props.author} onClose={() => setNotesOf(null)} onSaved={props.onReload} />}
      {reportOf && <ReportModal session={reportOf} onClose={() => setReportOf(null)} />}
    </>
  );
}
