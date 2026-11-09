import { useMemo } from 'react';
import { exportAllFeaturesUrl } from '../api/sessions.ts';
import { DashboardHeader } from '../components/DashboardHeader.tsx';
import { SessionsPanel } from '../components/SessionsPanel.tsx';
import { useSessions } from '../hooks/useSessions.ts';
import { adminStats } from '../lib/adminStats.ts';
import { launchTest } from '../lib/launch.ts';
import type { AuthUser } from '../types/session.ts';

export function AdminDashboard({ user, onSignOut }: { user: AuthUser; onSignOut: () => void }) {
  const { sessions, loading, error, reload } = useSessions();
  const stats = useMemo(() => adminStats(sessions), [sessions]);
  const exportAll = () => window.open(exportAllFeaturesUrl());
  return (
    <div className="dash-root" id="admin-dashboard">
      <DashboardHeader title="Admin Console" user={user.username} role={user.role}>
        <button className="dash-btn" onClick={exportAll}>⬇ Export All Features</button>
        <button className="dash-btn" onClick={() => void reload()}>↺ Refresh</button>
        <button className="dash-btn" onClick={launchTest} title="Take test as admin" style={{ fontSize: 11, padding: '7px 12px', opacity: 0.8 }}>▶ Take Test</button>
        <button className="dash-btn" onClick={onSignOut}>Sign Out</button>
      </DashboardHeader>
      <div className="dash-panel">
        <div className="stat-grid cols-3" id="admin-stats-row">
          <div className="admin-stat-card"><div className="stat-num" id="stat-total">{loading ? '—' : stats.total}</div><div className="stat-lbl">Total Sessions</div></div>
          <div className="admin-stat-card"><div className="stat-num" id="stat-today">{loading ? '—' : stats.today}</div><div className="stat-lbl">Today</div></div>
          <div className="admin-stat-card"><div className="stat-num" id="stat-authors">{loading ? '—' : stats.authors}</div><div className="stat-lbl">Clinicians Active</div></div>
        </div>
        <SessionsPanel variant="admin" sessions={sessions} loading={loading} error={error} onReload={reload} author={user.username}
          toolbarExtra={<button className="dash-btn" onClick={exportAll}>⬇ Export All Features</button>} />
      </div>
    </div>
  );
}
