import { DashboardHeader } from '../components/DashboardHeader.tsx';
import { launchTest } from '../lib/launch.ts';
import type { AuthUser } from '../types/session.ts';

export function ClinicianDashboard({ user, onSignOut }: { user: AuthUser; onSignOut: () => void }) {
  return (
    <div className="dash-root" id="clinician-dashboard">
      <DashboardHeader title="Clinician Portal" user={user.username} role={user.role}>
        <button className="dash-nav-btn dash-signout" onClick={onSignOut}>Sign Out</button>
      </DashboardHeader>
      <div className="dash-launch">
        <div className="dash-launch-inner">
          <div className="dash-launch-icon">🔬</div>
          <h2 className="dash-launch-title">Begin Patient Assessment</h2>
          <p className="dash-launch-text">
            Launch the full oculomotor battery for a new patient.<br />
            Ensure the patient is seated comfortably and the camera is correctly positioned before proceeding.
          </p>
          <button className="dash-btn primary large" onClick={launchTest} style={{ fontSize: 18, padding: '18px 48px', letterSpacing: '0.1em' }}>
            ▶ Launch Battery Protocol
          </button>
        </div>
      </div>
    </div>
  );
}
