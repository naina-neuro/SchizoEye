import { useCallback, useEffect, useState } from 'react';
import { AnalyticsServerError, fetchAnalytics } from '../api/analytics.ts';
import { FEAT_LABELS, summaryStats } from '../lib/analytics.ts';
import type { AnalyticsData } from '../types/session.ts';
import { AnalyticsCharts } from './AnalyticsCharts.tsx';

const centered = { textAlign: 'center', padding: 40 } as const;

export function AnalyticsPanel() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchAnalytics());
    } catch (e) {
      setData(null);
      const msg = e instanceof Error ? e.message : String(e);
      setError(e instanceof AnalyticsServerError ? `Error: ${msg}` : `Failed to load analytics: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  let content;
  if (loading) content = <p style={{ ...centered, color: 'var(--dim)' }}>Loading analytics…</p>;
  else if (error || !data) content = <p style={{ ...centered, color: '#c0392b' }}>{error}</p>;
  else {
    const st = summaryStats(data);
    const fa = data.feature_averages || {};
    content = (
      <div id="analytics-content">
        <div className="stat-grid cols-4">
          <div className="admin-stat-card"><div className="stat-num">{st.totalSessions}</div><div className="stat-lbl">Total Sessions</div></div>
          <div className="admin-stat-card"><div className="stat-num">{st.avgPanss}</div><div className="stat-lbl">Avg PANSS Score</div></div>
          <div className="admin-stat-card"><div className="stat-num">{st.avgAge}</div><div className="stat-lbl">Avg Age</div></div>
          <div className="admin-stat-card"><div className="stat-num">{st.withPanss}</div><div className="stat-lbl">With PANSS Data</div></div>
        </div>
        <AnalyticsCharts data={data} />
        <div className="chart-card" style={{ marginBottom: 24 }}>
          <div className="chart-title">🧠 Key Feature Averages (Across All Sessions)</div>
          {Object.keys(fa).length ? (
            <div className="feat-avg-grid">
              {Object.entries(fa).map(([k, v]) => (
                <div className="feat-avg-card" key={k}>
                  <div className="feat-avg-label">{FEAT_LABELS[k] || k}</div>
                  <div className="feat-avg-val">
                    <span className="feat-avg-mean">{v.mean}</span>
                    <span className="feat-avg-range">n={v.n}<br />{v.min}–{v.max}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ color: 'var(--dim)' }}>No feature data available yet.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="dash-row">
        <h2 className="dash-h2">Analytics Overview</h2>
        <button className="dash-btn" onClick={() => void load()}>↺ Refresh</button>
      </div>
      {content}
    </>
  );
}
