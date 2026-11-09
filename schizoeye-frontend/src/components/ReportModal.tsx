import { REPORT_GROUPS, formatReportValue, panssStyle } from '../lib/reportGroups.ts';
import { downloadSessionPdf } from '../lib/download.ts';
import { ageSex, panssCell } from '../lib/sessionView.ts';
import type { Session } from '../types/session.ts';

/** Clinical report summary of the saved features (original: showReportModal()). Reads the session object directly instead of scraping the table. */
export function ReportModal(props: { session: Session; onClose: () => void }) {
  const s = props.session;
  const features = s.features || {};
  const panss = panssCell(s);
  const ps = panssStyle(panss);
  return (
    <div className="modal-backdrop report" id="report-modal" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="report-modal-content">
        <div className="report-modal-header">
          <h2>📋 Clinical Report Summary</h2>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="report-modal-btn" onClick={() => downloadSessionPdf(s.id)}>⬇ Download PDF</button>
            <button className="report-modal-close" onClick={props.onClose} aria-label="Close">✕</button>
          </div>
        </div>
        <div className="cr-root">
          <div className="cr-banner">
            <div>
              <div className="cr-clinic-name">NAINA</div>
              <div className="cr-clinic-sub">Oculomotor Assessment Report</div>
            </div>
            <div>
              <div className="cr-stamp-line">{s.date || '—'}</div>
              <div className="cr-stamp-label">Assessment Date</div>
            </div>
          </div>

          <div className="cr-patient-bar">
            <div className="cr-patient-field"><div className="cr-pf-label">Patient Name</div><div className="cr-pf-value">{s.name || 'Unknown'}</div></div>
            <div className="cr-patient-field"><div className="cr-pf-label">Age / Gender</div><div className="cr-pf-value">{ageSex(s)}</div></div>
            <div className="cr-patient-field">
              <div className="cr-pf-label">PANSS Score</div>
              <div className="cr-pf-value" style={{ color: ps.color, fontSize: 22 }}>
                {panss}
                {panss !== '—' && <span style={{ fontSize: 12, fontWeight: 500, marginLeft: 6, color: ps.color }}>{ps.label}</span>}
              </div>
            </div>
            <div className="cr-patient-field">
              <div className="cr-pf-label">Tasks Completed</div>
              <div className="cr-pf-value" style={{ color: '#166534' }}>{Object.keys(features).length > 0 ? '✓ 3 / 3' : '—'}</div>
            </div>
          </div>

          <div className="cr-section-title"><span className="cr-section-rule" /><span>Oculomotor Feature Summary</span><span className="cr-section-rule" /></div>

          <div className="cr-groups-grid">
            {REPORT_GROUPS.map((g) => (
              <div className="cr-group" key={g.label}>
                <div className="cr-group-header" style={{ background: g.color }}>
                  <span className="cr-group-icon">{g.icon}</span>
                  <span className="cr-group-label">{g.label}</span>
                </div>
                <div className="cr-group-body">
                  <table className="cr-feat-table">
                    <thead><tr><th>Metric</th><th>Patient Value</th><th>Reference Range</th></tr></thead>
                    <tbody>
                      {g.keys.map(([key, label, unit, ref]) => (
                        <tr key={key}>
                          <td className="cr-feat-name">{label}</td>
                          <td className="cr-feat-val">{formatReportValue(key, features[key], unit)}</td>
                          <td className="cr-feat-ref">{ref || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>

          <div className="cr-footer-note">
            ℹ Model outputs are research decision support, not a standalone clinical diagnosis.
            All 59 extracted oculomotor features are stored in the database for research analysis.
          </div>
        </div>
      </div>
    </div>
  );
}
