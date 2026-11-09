import { useState } from 'react';
import { AnalyticsPanel } from '../components/AnalyticsPanel.tsx';
import { DashboardHeader } from '../components/DashboardHeader.tsx';
import { SessionsPanel } from '../components/SessionsPanel.tsx';
import { useSessions } from '../hooks/useSessions.ts';
import { launchTest } from '../lib/launch.ts';
import type { AuthUser } from '../types/session.ts';

export function DoctorDashboard({ user, onSignOut }: { user: AuthUser; onSignOut: () => void }) {
  const [tab, setTab] = useState<'sessions' | 'analytics'>('sessions');
  const { sessions, loading, error, reload } = useSessions();
  return (
    <div className="dash-root" id="doctor-dashboard">
      <DashboardHeader title="Doctor Portal" user={user.username} role={user.role}>
        <button className={`dash-nav-btn${tab === 'sessions' ? ' active' : ''}`} onClick={() => { setTab('sessions'); void reload(); }}>📋 Sessions</button>
        <button className={`dash-nav-btn${tab === 'analytics' ? ' active' : ''}`} onClick={() => setTab('analytics')}>📊 Analytics</button>
        <button className="dash-nav-btn" onClick={launchTest}>▶ Take Test</button>
        <button className="dash-nav-btn dash-signout" onClick={onSignOut}>Sign Out</button>
      </DashboardHeader>
      <div className="dash-panel">
        {tab === 'sessions'
          ? <SessionsPanel variant="doctor" sessions={sessions} loading={loading} error={error} onReload={reload} author={user.username} />
          : <AnalyticsPanel />}
      </div>
    </div>
  );
}
